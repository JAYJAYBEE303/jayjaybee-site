# Schedule Irregularities — Design

**Status:** approved for planning, 2026-08-26
**Implements:** the standing UI requirement in FEATURE_ENGINE §9 ("The UI must label DGW teams")
and the invariant in ARCHITECTURE §9 ("Do not assume one-fixture-per-GW anywhere")
**Plan:** _not yet written_

---

## 1. Problem

FPL's calendar is not one-fixture-per-team-per-gameweek. Four irregularities occur every
season, and Gaffer IQ currently handles none of them in the interface. Two of the four are
also modelled incorrectly underneath.

**D1 — the fixture strip flattens doubles.** `scoreOverHorizon`
(`engine/composite.js:785`) builds `perGw` as one entry per *fixture*, not per gameweek —
a double gameweek pushes two entries carrying the same `gw`. Both renderers then emit one
flat cell per entry with no grouping: `buildFixtureStrip` (`js/modules/ranker.js`) and
`buildPerGwStrip` (`js/modules/matchup.js:647`). A 6-GW horizon containing one double
renders **seven cells** and nothing on screen ties two of them to the same week. The
gameweek number survives only in the `title` tooltip.

**D2 — the Dashboard silently discards the second fixture of a double.**
`buildFixtureContextLabel` (`js/modules/dashboard.js:193`) reads `score?.perGw?.[0]`. The
comment directly above it states the case and then takes the first entry anyway. On a
double, the fixture-context line a user reads to sanity-check the captaincy pick names one
of the two fixtures and gives no indication the other exists.

**D3 — a bad double scores worse than a single bad fixture.** `aggregateMean` divides by
the summed weights, so two entries at the same `gwOffset` double that gameweek's *weight*
rather than adding a fixture's worth of return. With `HORIZON_DECAY = 0.9` over three
gameweeks, fixtures valued 30, then 50, 50:

```
double:  (30 + 30 + 45 + 40.5) / (1 + 1 + 0.9 + 0.81) = 39.2
single:  (30      + 45 + 40.5) / (1     + 0.9 + 0.81) = 42.6
```

Two chances at points scores 3.4 lower than one. Good doubles do lift the aggregate
(70 → 57.4 vs 60.8), so FEATURE_ENGINE §9's claim that doubles "naturally boost" the
horizon score is half true and inverts for poor fixtures. `aggregateMin` compounds it: a
double containing one brutal fixture drags the min term, which carries `W_MIN = 0.25` of
the blend.

**D4 — `expectedPoints` has no fixture-count term.** `calcExpectedPoints` (FEATURE_ENGINE
§10.2) is `avgPointsPerGw × fixtureSwing × playingLikelihood`. Nothing multiplies by games
played that week, so a double-gameweek captain projects identically to a single-gameweek
captain, and a blank-gameweek player projects a full score rather than zero. Double-gameweek
captaincy is the highest-leverage use of schedule knowledge in FPL and the model is blind
to it.

**D5 — postponed fixtures vanish.** `fixturesForTeamInWindow` (`engine/composite.js`) opens
with `if (f.gw === null) continue;`. A postponed fixture awaiting a rearranged date is
dropped from the model entirely, so a team with a pending rearrangement is indistinguishable
from a team that simply plays fewer games.

**D6 — kickoff-TBC fixtures are unmarked.** `normaliseFixture` (`engine/normalise.js`) does
not capture FPL's `provisional_start_time`, so a fixture whose kickoff is unconfirmed —
often the precursor to a postponement — renders identically to a confirmed one.

## 2. Available data

All of it is on payloads the app already fetches. **No new API calls.**

**`fixtures[]` — already loaded.** Each raw fixture carries `event` (null when
unscheduled) and `provisional_start_time` (boolean). `normaliseFixture` currently keeps
`event` as `gw` and discards `provisional_start_time`.

**`bootstrap-static.events[]` — already loaded and normalised** into `season.events` with
`id`, `finished`, `isCurrent`, `isNext`. Sufficient to compute which gameweeks in a horizon
window are irregular, without touching the fixture list twice.

**`perGw` — already carries doubles and blanks.** The information needed for D1 is present
in the engine's existing output. Only the renderers discard it.

## 3. Approach

Two orthogonal channels, chosen because the alternatives are already spent:

- **Colour is fully committed to fixture quality.** CONVENTIONS §5.2 — the five band
  colours are "used everywhere a score is shown so colour is consistent across all four
  modules". Signalling schedule structure in colour would collide with a global meaning.
- **Dashed borders are fully committed to model confidence.** `--estimated-border-style`,
  applied by `pgw-cell--estimated` and `score-chip--estimated`, means `provisional`
  (`confidence < CONFIDENCE_FLOOR`, `engine/composite.js:607`).

Therefore: **schedule structure is expressed through geometry and layout; fixture quality
keeps colour.** The two never overlap, so a double against brutal opposition reads as
red-and-grouped rather than needing a third colour that means neither.

Engine changes are split into two independent edits to `composite.js` with separate blast
radii — the aggregation rework (§5, moves numbers) and a derived grouping helper (§7, moves
nothing) — so that the untestable change is isolated from the testable one.

## 4. Data retention (`engine/normalise.js`)

Add to `normaliseFixture`:

```
provisionalKickoff: Boolean(raw.provisional_start_time)
```

Add to `normaliseSeason`: fixtures with `event === null` are collected into
`season.pendingFixtures` (an array, plus a `pendingFixturesByTeam` index built the same way
`fixtureIdsByTeam` already is). They are **not** appended to `season.fixtures`.

**Invariant:** `fixturesForTeamInWindow` keeps its `if (f.gw === null) continue;` guard.
Pending fixtures are a display-only channel. Nothing that aggregates over a gameweek window
may read them, because they have no gameweek to be aggregated into.

## 5. Aggregation rework (`scoreOverHorizon`) — fixes D3

Collapse per gameweek, then aggregate gameweeks:

```
for each gw in window:
    n       = fixture count for this team in gw
    gwValue = n == 0 ? BLANK_GW_VALUE
                     : mean(scoreFixture(team, f).value for f in gw)
    gwValue = gwValue + (100 − gwValue) × DGW_UPLIFT × (n − 1)

aggregate the per-GW values with HORIZON_DECAY, mean/min/blend, exactly as now
aggregateMin takes the minimum of the ADJUSTED per-GW values, not the worst raw fixture
```

The uplift is asymptotic toward 100, so no double can exceed the scale. At the proposed
`DGW_UPLIFT = 0.35` (new, `config.js`):

| Fixtures | Raw | Adjusted |
|---|---|---|
| single | 30 | 30.0 |
| double | 30, 30 | 54.5 |
| single | 70 | 70.0 |
| double | 70, 70 | 80.5 |

A poor double now beats a single poor fixture, which is the correct FPL reading and the
inverse of current behaviour.

`aggregateMin` moving to adjusted per-GW values is load-bearing, not incidental: leaving it
on raw fixtures would let the min term keep punishing a double that contains one hard game,
re-introducing D3 through the 25% blend weight.

**There is no setting of `DGW_UPLIFT` that reproduces current behaviour.** Collapsing to a
per-GW mean is itself a change for doubles — at `DGW_UPLIFT = 0` a double scores the mean of
its two fixtures, where today it scores the same week twice. This is a deliberate,
irreversible recalibration of every double-gameweek team's `value`, and therefore of bands,
rank tiers (FEATURE_ENGINE §13), Ranker ordering and Planner transfer suggestions.

## 6. `expectedPoints` fixture-count term — fixes D4

```
expectedPoints ×= 1 + DGW_EXPECTED_PTS_FACTOR × (fixtureCount(nextGw) − 1)
```

`DGW_EXPECTED_PTS_FACTOR = 0.9` (new, `config.js`) rather than `1.0`: the second fixture of
a double carries rotation risk that a straight doubling would ignore.

`fixtureCount(nextGw) == 0` on a blank yields `0`, which is correct and is not what happens
today.

**Scope:** Dashboard captaincy and Planner Triple Captain only, per FEATURE_ENGINE §10.2's
existing statement that `value` and `expectedPoints` are separate axes. This term must not
be applied to `value`; §5 is `value`'s handling of the same fact.

## 7. Grouping helper (`engine/fixtures.js`) — fixes D1, non-breaking

```
groupPerGwSlots(perGw) → [{ gw, fixtures: [...], isDouble, isBlank }]
```

Pure, no dependencies beyond its argument. `scoreOverHorizon`'s `perGw` output shape is
**unchanged**; consumers opt in by calling this. The helper is what makes the strip
truthful — one slot per gameweek, slots holding zero, one or two fixtures — without
requiring every existing `perGw` consumer to move at the same time as §5 recalibrates the
values inside it.

Two further pure helpers in the same file:

- `pendingFixturesForTeam(teamId, ctx)` → the postponed fixtures behind the `+n TBD` pill.
- `summariseGwIrregularities(ctx, fromGw, count)` → `[{ gw, doubleTeams, blankTeams }]`,
  computed once per `data:ready` for the context bar (§8).

## 8. UI vocabulary

Defined once, used identically in every module:

| Signal | Treatment |
|---|---|
| Double gameweek | slot's cells wrapped in a `--color-accent` tinted group with a 1px accent outline; slot label gains a `··` marker |
| Blank gameweek | hatched cell (45° repeating gradient in `--band-neutral`) with a dashed subtle border — visibly a known-empty week, distinct from a failed load |
| Kickoff TBC | 4px `--band-tough` dot, top-right of the cell |
| Postponed | dashed-border pill after the strip, `+n TBD` |

All four use existing `--band-…` / `--color-…` tokens per CONVENTIONS §5.3 — no raw hex, no
new colour prefix.

| Tab | Change |
|---|---|
| **Ranker** | `buildFixtureStrip` → GW slots via `groupPerGwSlots`; `+n TBD` pill |
| **Matchup** | `buildPerGwStrip` → same slots, shared CSS with Ranker |
| **Dashboard** | context bar; **fix D2** — `buildFixtureContextLabel` renders all fixtures in the gameweek, not `perGw[0]` |
| **Planner** | context bar; double/blank flag on transfer cards |
| **Fixtures** | context bar; postponed section on the gameweek pane |
| **Shell** | new `js/modules/scheduleBar.js`, markup above `.app-main` in `index.html` |

The context bar renders nothing when every gameweek in the next six is ordinary, which is
most of the season. It subscribes to `data:ready` and `route:changed` following the
CONVENTIONS §8 pattern the other modules use.

## 9. Invariants

1. Colour never encodes schedule structure. Schedule structure never encodes fixture
   quality.
2. `season.pendingFixtures` is display-only. No aggregation reads it.
3. `scoreOverHorizon`'s `perGw` output shape does not change in this work.
4. `expectedPoints`' fixture-count term is never applied to `value`, and §5's uplift is
   never applied to `expectedPoints` — one fact, two axes, one treatment each.
5. `colCount()` in `ranker.js` stays the single source of truth for anything spanning that
   table.
6. No new API calls. Every field named here is on a payload already fetched.

## 10. Verification

Pure functions, each unit-testable under `node --test`, following
`tests/engine/*.test.js`:

- `groupPerGwSlots` — single, double, blank, and a horizon mixing all three.
- The §5 uplift — the four rows of the table in §5, plus `n = 1` leaving the value
  untouched and the asymptote holding at `gwValue = 100`.
- The §6 multiplier — `n = 0` → 0, `n = 1` → unchanged, `n = 2` → ×1.9.
- `pendingFixturesForTeam` — a team with none, a team with one.
- `summariseGwIrregularities` — an ordinary window returning nothing to render.

**Not verifiable in this environment.** SentinelOne EDR blocks test runners and local
servers, so the author cannot run the suite, cannot render the slot layout to check it holds
inside the Ranker's 11% fixture column at a 6-GW horizon, and — most importantly — **cannot
validate the §5 recalibration against real season data.** The uplift constant is a
reasoned starting value, not a fitted one. Whoever implements this must run `npm test`,
open the Ranker on a gameweek containing a real double, and sanity-check that band
distribution has not shifted unreasonably before the change is considered done.

## 11. Deferred

- Fitting `DGW_UPLIFT` and `DGW_EXPECTED_PTS_FACTOR` against historical double gameweeks
  rather than reasoning them from first principles. Needs the calibration harness.
- Chip planning against blank/double structure (Wildcard, Free Hit, Bench Boost timing) —
  ROADMAP Phase 4 already lists it and it depends on this work landing first.
- Triple gameweeks. The `(n − 1)` terms in §5 and §6 extend to them arithmetically, but no
  UI treatment is specified here and none has occurred in the Premier League.
