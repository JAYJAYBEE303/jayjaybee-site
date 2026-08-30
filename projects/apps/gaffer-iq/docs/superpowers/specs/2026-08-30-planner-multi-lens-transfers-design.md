# Transfer Planner — multi-lens recommendations, XI awareness, and a weekly verdict

**Date:** 2026-08-30
**Status:** design approved, implementation plan pending
**Scope:** `modules/planner.js`, `modules/dashboard.js` (extraction only), `squadImport.js`, `store.js`, three new engine modules, `config.js`, `index.html`, `components.css`

---

## 1. Problem

The Planner ranks transfers by `inScore.value − outScore.value`, computed in
`computeSingleSwaps()` (`modules/planner.js`). `value` is the 0–100 composite
from `scorePlayer()` — a *within-position quality index*, not points.

Two consequences, both observed in use:

1. **Bench churn outranks real upgrades.** A fringe defender scoring 0 and a
   fringe defender scoring a couple of points can differ by 15 composite points.
   That swap outranks a genuine +6 upgrade to a starting midfielder, because the
   composite gap is larger than the points gap. The planner recommends it in
   good faith and it is worth nothing.
2. **The planner cannot see the bench at all.** There is no XI/bench model in
   the transfer path. `pickBenchPlayerIds()` exists but serves only Bench Boost
   analysis. Nothing in the swap ranking knows whether either player involved
   would ever take the pitch.

Beyond the defect, the page optimises a single axis. It has no way to express
preparing for a fixture swing three gameweeks out, freeing cash, fixing a squad
whose value is clumped so tightly that upgrading is impossible, chasing a
ceiling, or — most importantly — **deciding not to transfer at all**.

## 2. Goals

- Rank transfers by **points into the projected starting XI**, not composite delta.
- Present five parallel lenses, each ranked on its own terms, all visible at once.
- Lead with a **verdict** that names a lane, states its margin over the runner-up,
  and can say "close call" or "in a different league".
- Make "roll the transfer" a first-class outcome.
- Keep every recommendation explainable on demand without costing screen space.

## 3. Non-goals

- Multi-week transfer *planning* (a solver for "two moves to reach Haaland").
  Future Prep surfaces the target; it does not sequence the path.
- Mobile layout. Desktop tool, per `CONVENTIONS.md` §5.4.
- Any write to the FPL account. Import stays read-only.

## 4. Decisions taken

| Question | Decision |
|---|---|
| Page shape | Five parallel lens boards, with a verdict banner above them |
| Lens roster | Now · Future Prep · Funds & Flexibility · Ceiling · Structure Fix |
| XI source | Engine-projected XI drives scoring; saved FPL picks imported and shown as a diff |
| Future window | Ranked by fixture *swing*, not raw far-window projection |
| Verdict logic | Comparable lane scores + margin, with override triggers |
| Layout | Grid of compact boards; `why` expands a row in place |
| Architecture | One multi-objective enumeration pass, not five independent lanes |
| Verification | Tests written; behavioural verification via `.claude/devserver.py` |

## 5. Architecture

### 5.1 New files

- `js/engine/lineup.js` — XI/bench selection and XI expected-points totals.
- `js/engine/transfers.js` — swap enumeration and the five lane scores.
- `js/engine/strategy.js` — lane normalisation, the roll lane, triggers, verdict.
- `js/modules/planner-boards.js` — verdict banner and board/row/why-panel HTML.

All three engine files are pure per `CONVENTIONS.md` §3.3: explicit inputs, no
DOM, no network, no store access, no mutation of arguments.

### 5.2 Changed files

- `js/modules/planner.js` — loses transfer analytics and most rendering; keeps
  state, wiring, events, squad rail, import panel, orchestration.
- `js/modules/dashboard.js` — `pickStartingXI` deleted, imported from
  `engine/lineup.js` instead.
- `js/squadImport.js` — returns pick slot and armband alongside ids.
- `js/store.js` — gains `squadPicks` state and `getSavedXi()`.
- `js/config.js` — all new constants (§10), plus three existing ones promoted
  out of module scope (below).
- `index.html`, `css/components.css` — new planner layout.

### 5.3 Constants promoted to `config.js`

`HIT_PENALTY` and `BENCH_SIZE` are currently module-local in `planner.js`
(lines 46 and 55), and `SQUAD_LIMITS` is defined *twice* — once in `planner.js`
and again in `dashboard.js`. The new engine modules need all three, and engine
code may not carry magic numbers (`CONVENTIONS.md` §7.3) or read module state
(§3.3). They move to `config.js` and both modules import them, retiring the
duplicate definition as a side effect.

## 6. The spine

### 6.1 `engine/lineup.js`

```
pickStartingXI(scoredSquad) → { xi, bench }
calcXiExpectedPoints(scoredSquad) → { value, estimated }
```

`pickStartingXI` is lifted from `modules/dashboard.js:490` with its formation
rules intact (exactly 1 GKP, min 3 DEF, min 2 MID, min 1 FWD, 11 total; bench
ordered outfield-by-score descending with the reserve keeper last).

**One behavioural change on extraction:** it currently sorts by
`score.value`, the within-position composite, so a cheap defender can outrank a
premium midfielder in the XI ordering. It moves to `score.expectedPoints.value`,
the points-scale projection the Dashboard's captaincy pick already uses. This is
the same axis error as the transfer bug, in a second place.

`calcXiExpectedPoints` sums the XI's expected points, plus the bench weighted by
`BENCH_CONTRIBUTION_WEIGHT`.

> **MODEL:** a benched player is not worth zero — autosubs mean a bench player
> whose XI counterpart blanks does score. The weight is small but non-zero, so
> that improving your bench registers as a faint positive rather than nothing,
> without ever rivalling an XI upgrade.

### 6.2 The swap delta

For a candidate swap, the squad is re-scored with the incoming player
substituted for the outgoing one, `pickStartingXI` runs again, and:

```
xiDelta = calcXiExpectedPoints(after) − calcXiExpectedPoints(before)
```

This is the fix. A bench-to-bench swap moves the total by roughly nothing
regardless of composite gap. A swap that promotes someone into the XI is
credited for the promotion, including the knock-on demotion of whoever they
displace.

## 7. `engine/transfers.js`

```
enumerateSwaps(squad, allPlayers, ctx, opts) → Swap[]
```

`opts` carries `{ horizon, budget, freeTransfers, allowExtraHit, savedXi }`.

Each candidate is scored in **two windows**: the active horizon (*near*) and a
deferred window running `FUTURE_WINDOW_START` gameweeks out for
`FUTURE_WINDOW_GWS` gameweeks (*far*). Scores are memoised on
`(playerId, windowKey)`.

Returned `Swap` shape:

```
{ outId, inId, outPlayer, inPlayer, outScore, inScore,
  priceDiff, nearXiDelta, farXiDelta,
  lanes: { now, future, funds, ceiling, structure },   // each { value, components, estimated, reasoning }
  flags:  { outInXi, inEntersXi, outUnavailable, scheduleNear, priceRisk } }
```

Lane values are on each lane's own natural unit at this stage. Normalisation to
a comparable 0–100 scale happens in `strategy.js` (§8.1), keeping the raw,
explainable number available for display.

### 7.1 Lane definitions

**Now** — `nearXiDelta`, less `HIT_PENALTY` when the move requires a hit.
Expected points into your XI over the active horizon. Nothing else.

**Future Prep** — ranked by *swing*:

```
swing = farXiDelta − nearXiDelta,  gated on farXiDelta > FUTURE_MIN_FAR_GAIN
```

> **MODEL:** ranking the far window by raw projection would mostly re-list the
> Now board, because a genuinely good player is good in both windows. Swing
> isolates the move that is *specifically* about the future — a player whose
> next two fixtures are rough but whose following four are green — which is the
> buy-before-the-price-rises decision this board exists to serve.

**Funds & Flexibility** — flexibility gained per expected point sacrificed.
Flexibility comes from a new `calcSquadFlexibility(squad)` with two weighted
components:

- *Spread* (`FLEX_W_SPREAD`) — how much squad value is clumped inside a
  `FLEX_CLUMP_BAND`-wide price band. A squad with six players at 7.0–7.5m cannot
  upgrade anyone without selling two, which is the constraint being measured.
- *Headroom* (`FLEX_W_HEADROOM`) — how much could be raised toward a premium by
  selling the most disposable assets.

> **ASSUMPTION (unresolved):** the user described the problem as price clumping
> making up-value moves hard when capped, which is *spread*. *Headroom* is the
> adjacent reading of the same complaint. Both are implemented as weighted
> components so that resolving this is a config change, not a rewrite. Revisit
> after a few weeks of live use.

Cash freed (`−priceDiff`) and `calcPriceChangeRisk()` (already built, in
`engine/prices.js`) fold into this lane's components.

**Ceiling** — peak rather than mean:

```
ceiling = CEILING_W_PEAK × (best single-GW expectedPoints in the near window)
        + CEILING_W_HAUL × (share of played GWs scoring ≥ HAUL_POINTS_THRESHOLD)
```

Haul rate comes from `summary.history[].points` via `ctx.playerSummariesById`.

> **KNOWN WEAKNESS:** FPL exposes no variance data, so haul rate is a
> backward-looking proxy and is thin for players with few starts. Player
> summaries load lazily, so many candidates will have none at all. This lane
> sets `estimated: true` whenever the summary is missing, and the verdict
> downgrades its own confidence accordingly (§8.4). It is the least trustworthy
> of the five and must never present as equally solid.

**Structure Fix** — fires only when the OUT player is in the *projected XI* and
is broken by at least one of: `status !== 'available'`; `breakdown.playtime.value`
below `STRUCTURE_PLAYTIME_FLOOR`; rank tier `bottomPercentile`. Scored by how
much of the XI total the repair restores. Legitimately empty in most weeks — the
board renders an explicit "nothing broken" state rather than padding itself with
the next-best generic swap.

## 8. `engine/strategy.js`

```
buildVerdict(swaps, squadState, ctx) → Verdict
```

### 8.1 Normalisation

Each lane's best move is mapped onto 0–100 through its own config threshold
(`LANE_SCALE_NOW`, `LANE_SCALE_FUTURE`, `LANE_SCALE_FUNDS`,
`LANE_SCALE_CEILING`, `LANE_SCALE_STRUCTURE`).

> **MODEL:** this is the load-bearing and most arbitrary step in the whole
> design. Without a shared scale, "a swing of +6" and "frees £0.5m" have no
> common language and the margin below is meaningless. The thresholds are
> calibration targets, not truths — they are the first thing to tune against
> realised results per `ROADMAP.md` Phase 3B.

### 8.2 The roll lane

Doing nothing is scored as a lane, not treated as a fallback. Its score reflects
the value of banking a transfer toward a two-move target the Future Prep board
has already identified. If no acting lane clears `VERDICT_ACT_THRESHOLD`, the
verdict is **roll it**.

### 8.3 Triggers

Four overrides may promote a lane past the arithmetic. Each supplies its own
headline reason and is always named in the output — a trigger never silently
reorders:

1. `xiPlayerUnavailable` — a projected-XI player is injured, suspended or flagged.
2. `chipWindow` — a chip's recommended GW falls within `CHIP_WINDOW_GWS`,
   reusing `engine/chips.js`.
3. `cashCrunch` — squad flexibility below `FLEX_FLOOR`.
4. `priceDeadline` — high-confidence imminent rise on a lane-leading target.

### 8.4 Verdict shape

```
{ lane, laneScore, margin, confidence, alternatives, triggers, reasoning, estimated }
```

`confidence` derives from `margin`:

- `margin ≥ VERDICT_MARGIN_DOMINANT` → `'dominant'` ("in a different league")
- `margin ≥ VERDICT_MARGIN_CLEAR` → `'clear'`
- otherwise → `'close'`, and `alternatives` names the lanes within the margin

When the winning lane's inputs are estimated, `confidence` is downgraded one
step and `estimated` is set. `reasoning` strings are built here, in the engine,
and merely rendered by the module — matching how `engine/chips.js` already works.

## 9. Store, import, and UI

### 9.1 Saved picks

`fetchAndMapSquad()` currently discards everything but `pick.element`. It starts
returning slot (1–15) and armband flags. `store` keeps `squad` as the id array
both the Dashboard and Planner depend on, and gains a parallel `squadPicks` map
plus `getSavedXi()`. Both setters publish the existing `squad:updated`; no new
event.

**Rule:** a manual squad edit clears `squadPicks`. Saved picks describe an
imported team; once the squad is edited by hand they are stale and must not be
presented as current.

### 9.2 Layout

Full-width verdict banner. Below it, the squad rail on the left and the five
boards in a grid on the right. The chips panel moves *below* the grid — it is
season-level advice, and its urgent signal now reaches the user through the
verdict's `chipWindow` trigger. The "Best 2-Transfer Combo" section survives
unchanged, full-width beneath the grid: it answers a different question and does
not belong in a lane.

### 9.3 The compact row

Each board shows `BOARD_TOP_N` rows; "more" expands to `BOARD_EXPANDED_N`. A row
is one line: `OUT → IN`, the lane's own headline number in its natural unit,
price delta, and badges — the existing schedule marks and price warnings, plus a
new urgency badge for Structure Fix conditions.

`why` expands the row in place to reveal the current rich card: both players'
Form/Fixture/Counter bars, the lane's component breakdown, and the engine's
`reasoning` string. Nothing on the page today is lost; it is demoted one click.

**Open-state preservation:** boards re-render wholesale on every budget keystroke
and free-transfer toggle, which would slam an open `why` panel shut mid-read.
Open rows are tracked in a `Set` keyed `` `${outId}-${inId}` `` and restored
after each render.

### 9.4 Module split

- `planner.js` — state, events, wiring, squad rail, import panel, orchestration.
- `planner-boards.js` — verdict banner, board grid, compact row, why-panel.
  HTML builders only; no listeners, no state.

`planner.js` is 1,324 lines before this change, which is already past the point
where a single file is comfortable to work in.

### 9.5 CSS

New BEM-lite blocks in `components.css`: `planner-verdict`, `planner-board`,
`planner-swap-row`, `planner-why`. Design tokens only, reusing the existing band
and rank-tier colours. No new colour literals (`CONVENTIONS.md` §5.3).

## 10. Config constants

All in `config.js` under a new "§14 Transfer lanes and strategy" section.

| Constant | Purpose |
|---|---|
| `FUTURE_WINDOW_START`, `FUTURE_WINDOW_GWS` | Deferred window offset and length |
| `FUTURE_MIN_FAR_GAIN` | Minimum far-window gain before a swing qualifies |
| `BENCH_CONTRIBUTION_WEIGHT` | Autosub-aware bench weighting in XI totals |
| `CANDIDATE_POOL_PER_POS` | Candidates scored per position, by rank |
| `FLEX_W_SPREAD`, `FLEX_W_HEADROOM`, `FLEX_CLUMP_BAND`, `FLEX_FLOOR` | Squad flexibility model and cash-crunch trigger |
| `CEILING_W_PEAK`, `CEILING_W_HAUL`, `HAUL_POINTS_THRESHOLD` | Ceiling model |
| `STRUCTURE_PLAYTIME_FLOOR` | Playtime below which an XI player counts as broken |
| `LANE_SCALE_NOW/FUTURE/FUNDS/CEILING/STRUCTURE` | Per-lane 0–100 normalisation |
| `VERDICT_ACT_THRESHOLD` | Below this, the verdict is roll |
| `VERDICT_MARGIN_CLEAR`, `VERDICT_MARGIN_DOMINANT` | Confidence bands |
| `CHIP_WINDOW_GWS` | How near a chip GW must be to trigger |
| `BOARD_TOP_N`, `BOARD_EXPANDED_N` | Rows per board, collapsed and expanded |
| `HIT_PENALTY`, `BENCH_SIZE`, `SQUAD_LIMITS` | Promoted from module scope (§5.3) |

## 11. Performance

`computeSingleSwaps()` today scores every same-position candidate on every
render — roughly 2,000 `scorePlayer` calls, fired on each budget keystroke. Two
windows would double it. Three mitigations, part of the design rather than a
later optimisation:

1. A `(playerId, windowKey)` score cache surviving across renders, invalidated
   only on `data:ready` / `horizon:changed` — the same invalidate-always,
   recompute-lazily contract `CONVENTIONS.md` §8 already imposes on modules.
2. `CANDIDATE_POOL_PER_POS` pre-filters candidates by rank *before* scoring,
   bounding the work rather than hoping it stays small.
3. Budget and free-transfer changes re-filter and re-rank **without re-scoring**.
   These are the interactive controls, so this is where responsiveness is felt.

The Planner keeps the existing `route:changed` deferral, so none of this runs
while the tab is off screen.

## 12. Error handling

Per `CONVENTIONS.md` §9, unchanged: engine functions apply documented fallbacks
and record `estimated: true` rather than throwing on absent data; they may throw
on contract violations. The module wraps engine calls in try/catch with
`console.warn`, as `renderChipsPanel()` already does. A board with nothing to
say renders an explicit empty state; it never pads itself with a weaker
suggestion to look busy.

## 13. Verification

**Tests written, not run.** `npm test` is `node --test`, and there is no Node on
this machine and no CI in the repository. Unit tests for `lineup.js`,
`transfers.js` and `strategy.js` will be written in the style of
`tests/engine/prices.test.js` so they are ready the moment a runner exists, but
they cannot be executed as part of this work and must not be reported as passing.

**Behavioural verification** is the real gate for this change. `.claude/devserver.py`
serves the app with a working `/api/fpl` proxy, so the page can be driven against
live FPL data in the browser pane. Specific checks:

- A bench-to-bench swap scores near zero on the Now board.
- A swap that promotes a player into the XI is credited for the promotion.
- Dashboard and Planner agree on the projected XI.
- Imported saved picks render as a diff against the projected XI.
- Structure Fix is empty when nothing is broken, and populated when a squad
  member is flagged.
- The verdict reports "close" when the top two lanes are near-tied, and rolls
  when nothing clears the threshold.
- Budget keystrokes re-rank without a visible stall.

## 14. Documentation to update in the same commits

Per `CONVENTIONS.md` §10, code and docs never disagree in `main`:

- `FEATURE_ENGINE.md` — a new section for the lane models and the verdict.
- `ARCHITECTURE.md` — the three new engine files and the planner module split.
- `ROADMAP.md` — this supersedes the Phase 2D exit criterion.
- `GAFFER_IQ_TESTING_ROADMAP.md` — the behavioural checks in §13.

## 15. Risks

1. **Lane normalisation thresholds are guesses** until calibrated. The verdict's
   margin language is only as meaningful as they are. Mitigation: they are
   config, and Phase 3B calibration is the intended route.
2. **Ceiling is the weakest lane** (§7.1) and depends on lazily-loaded summaries.
3. **Flexibility interpretation is unresolved** (§7.1) and is carried as two
   weighted components pending live use.
4. **The XI-delta spine assumes the projected XI is right.** If `pickStartingXI`
   picks badly, every lane inherits the error. This is why moving it to
   `expectedPoints` and sharing one implementation with the Dashboard matters.
