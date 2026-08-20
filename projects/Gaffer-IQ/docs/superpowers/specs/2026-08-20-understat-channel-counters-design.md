# Understat Channel Counters — Design

**Status:** approved for planning, 2026-08-20
**Implements:** ROADMAP Phase 3 (refinement), extends FEATURE_ENGINE §7.2
**Plan:** `docs/superpowers/plans/2026-08-20-understat-channel-counters.md`

---

## 1. Problem

`engine/counter.js` produces the signature Gaffer IQ metric — how one team's attacking
unit matches up against the specific defensive unit it will face. Three defects limit it.

**D1 — role classification is quality-confounded and brittle.** `classifyRole` refines
FPL `element_type` into eight roles using ICT component *shares*. ICT `threat` is a
quality measure, so a low-quality winger reads as a CM. Worse, `classifyTeamRoles`
fails closed: if fewer than 90% of a team's outfielders with minutes classify, the
**whole team** drops to `element_type` grouping and every pairing is flagged estimated.

**D2 — the pairing is a quality gap, not a matchup.** `pairingEdge = attackForm −
defenceForm`, where both sides are `calcPlayerForm.value` — an FPL-points composite.
Subtracting two quality reads mostly re-states which side is better, which
`WEIGHTS.baseDifficulty` (0.35) and `WEIGHTS.teamForm` (0.15) already price. This is the
same defect the Phase 3B rewrite identified in `styleClash` and fixed by moving to
quality-neutral axes.

**D3 — the defensive half has no positional resolution.** Defender form uses the
`mode: 'defence'` read of `calcPlayerForm`, which is clean-sheet and goals-conceded
driven. Those are *team* outcomes shared across the entire back line, so a team's CB
form and FB form differ only by attacking returns and minutes. All three pairings for a
fixture therefore move largely together.

## 2. Available data

Verified live against Understat on 2026-08-20 (season `2025`, the last complete season).

**`leagueXg.playersData` — already loaded, zero marginal cost.** Every player carries
`xGChain` and `xGBuildup` alongside `xG`, `xA`, `npxG`, `time`. The payload is already
fetched for `styleClash` and `calcPlayerForm`, and already indexed by lowercased name in
`buildUnderstatPlayerLookup` (`engine/form.js`). 537 players in the 2025 season payload.

**`teamXg.statistics` — one fetch per team, currently unused.** The `team/{slug}/{season}`
endpoint returns a `statistics` block that `renameUnderstatKeys` (`api/fpl.js`) already
passes through untouched "for forward compatibility". `fetchTeamXg` (`js/api.js`),
the proxy allowlist entry, and `store.setTeamXg`/`getTeamXg` all exist and have **no
callers**. Six buckets, each shot-partitioned with a parallel `against` block:
`situation`, `formation`, `gameState`, `timing`, `shotZone`, `attackSpeed`, `result`.

Two properties constrain everything downstream:

- It is **per-team**, so a full-league read costs 20 proxy calls. It must be an
  enrichment with graceful degradation, never a hard dependency.
- It is a **season aggregate** — no per-match rows, no venue split, no decay. It is a
  stable *profile*, so it belongs beside `styleClash`, not beside `teamForm`.

**Understat publishes no per-player defensive data at any endpoint** — no tackles,
interceptions, duels or aerials. D3 is therefore not solvable from player data at any
price. The defensive half of a matchup must come from team `statistics.*.against`.

## 3. Approach

Add a third tier above the existing two, selected by data availability:

```
mode: 'channel'  →  player xGChain personnel weighting × team statistics axes
mode: 'role'     →  chain-based role classification, form-based units   (existing shape, better inputs)
mode: 'element'  →  element_type grouping, form-based units             (unchanged floor)
```

Rejected alternatives: replacing the positional pairings outright (the `statistics`
dependency is not always satisfiable, so a fallback is mandatory regardless), and
display-only channel scoring (the better signal would never reach a fixture ranking).

## 4. Role signature (fixes D1)

Replace ICT shares with a two-dimensional signature derived from chain data:

```
buildupShare = xGBuildup / xGChain          # 0–1, share of involvement BEFORE the final action
createBias   = xA90 / (xA90 + npxG90)       # 0–1, is the final action a pass or a shot?
```

`xGChain − xGBuildup` is by definition the player's involvement in possessions where
they took the shot or made the key pass. `buildupShare` is therefore a positional depth
axis, and because it is a ratio of the player's own involvement it is quality-neutral.

**Evidence (2025 season, 338 players with ≥900 min):** `buildupShare` sorts cleanly by
Understat position bucket — GK 1.00, defenders 0.89–0.91, central mids 0.68, wide and
attacking mids 0.41, forwards 0.21 (medians).

**Evidence (102 regular defenders):**

| Correlation | Value | Reading |
|---|---|---|
| `corr(buildupShare, xA/90)` | **−0.654** | the axis tracks the FB↔CB distinction |
| `corr(buildupShare, xGChain/90)` | **+0.008** | the axis is volume- and quality-neutral |

`buildupShare` alone misfiles two groups in opposite directions: set-piece centre-backs
(Tarkowski, Ballard, Milenković, Ajer, Romero) read low because corner headers are final
actions, and defensive fullbacks (Wan-Bissaka, Spence) read low with no creative output.
`createBias` separates them — a CB's final action is a shot, a fullback's is a cross.

**Thresholds (derived 2025, n=139 DEF / 153 MID / 24 FWD):**

```
GKP  → element_type GKP                                        (unchanged)
DEF  → FB  if buildupShare <  0.82 AND createBias >= 0.50, else CB
MID  → WM  if npxG90 >= 0.22
       DM  if buildupShare >= 0.78
       CM  otherwise
FWD  → SS  if buildupShare >= 0.30, else ST
```

Spot-check of the resulting groups: FB = Robertson, Muñoz, Bradley, Dalot, Truffert,
Gray, Wan-Bissaka, Spence. DM = Xhaka, Ward-Prowse, Baleba, Ampadu, André, Florentino.
WM = Saka, Gordon, Mbeumo, Semenyo, Garnacho. SS = Welbeck, Solanke, Strand Larsen,
Delap; Haaland correctly ST.

**Coverage rule change.** `classifyTeamRoles`' fail-closed 90% bar is replaced by
per-player tiering: chain signature where the player is name-matched and above the
minutes floor, ICT where not, `element_type` where neither. The original MODEL rationale
for failing closed was that mixing refined and unrefined players understates whichever
side has worse coverage — that reasoning applies to mixing *taxonomies*, but chain and
ICT emit the same eight labels from different evidence, so per-player fallback is sound.
A team is flagged `estimated` when fewer than 75% of its outfield minutes are covered by
chain signatures.

**Minutes floor.** Thresholds were derived on ≥900-minute players. In-season the floor is
`ROLE_SIGNATURE_MIN_MINUTES = 450` with `ROLE_SIGNATURE_MIN_CHAIN = 0.5`; below either,
the player falls back to ICT. This is a known extrapolation — §9 carries the check.

## 5. Attack-unit strength (fixes D2, attack side)

`minutesWeightedMeanForm` is joined by `minutesWeightedMeanChain`: the minutes-weighted
mean of `xGChain / 90` across the unit. Chain credits the winger whose cross another
player converts, which both FPL points and ICT `threat` under-reward. It is continuous,
so it degrades smoothly instead of failing closed.

The defensive half of a pairing keeps `calcPlayerForm` in `'defence'` mode in `role`
mode — D3 is only addressed in `channel` mode, where the defensive read comes from team
data.

## 6. Channel axes (fixes D2 and D3)

`situation`, `shotZone` and `attackSpeed` are three **independent partitions of the same
shots**, not one partition of threat. They are therefore modelled as three axes, each
scored as an attacking share against a conceding share.

```
setPieceShare = (FromCorner + SetPiece + DirectFreekick).xG / (that + OpenPlay.xG)
boxShare      = (shotSixYardBox + shotPenaltyArea).xG / (that + shotOboxTotal.xG)
fastShare     = attackSpeed.Fast.xG / Σ attackSpeed.*.xG
```

Penalties are excluded from the set-piece denominator, consistent with `style.js`'s npxG
choice — a penalty is a restart, not evidence about how a team plays.

**An open-play axis is deliberately absent.** `openPlayShare ≡ 1 − setPieceShare` by
construction, so it carries no independent information.

**League baselines (2025, n=20):**

| Axis | mean for | sd for | mean against | sd against | pooled sd |
|---|---|---|---|---|---|
| setPiece | 0.2562 | 0.0555 | 0.2524 | 0.0410 | 0.0690 |
| box | 0.9097 | 0.0170 | 0.9110 | 0.0091 | 0.0193 |
| fast | 0.0822 | 0.0229 | 0.0856 | 0.0263 | 0.0349 |

**The baselines cancel.** Every team's xG-for in an axis is another team's xG-against, so
league-mean-for equals league-mean-against to within 0.004 on all three axes. Subtracting
the two shares removes the league baseline automatically — no baked league constants are
needed for centring, which is what makes the tab-scoped, 2-teams-at-a-time fetch viable.

**Axis independence (n=20):** the largest pairwise correlation among attacking profiles
is `corr(box, fast) = +0.334`; among defensive profiles the largest is
`corr(setPiece, fast) = −0.161`. The axes are near-independent and none needs collapsing.

**Residual quality confound.** The shares are not perfectly quality-neutral:
`corr(boxShare_for, npxG_for) = +0.408`, `corr(setPieceShare_for, npxG_for) = −0.370`,
`corr(fastShare_against, npxGA) = −0.460`. Better teams take a larger share of their
shots inside the box and rely less on dead balls. At |r| ≤ 0.46 that is ~20% shared
variance — far better than raw totals, but it must be recorded as a MODEL note rather
than claimed as zero.

**Scoring.** Each axis edge is z-scored by its own pooled SD so the three axes contribute
on a common scale, then one sensitivity constant converts to points:

```
axisEdge(a)  = attackShare_A(a) − concedeShare_B(a)
axisZ(a)     = axisEdge(a) / CHANNEL_AXIS_POOLED_SD[a]
axisScore(a) = clamp(0, 100, 50 + axisZ(a) * CHANNEL_SENSITIVITY)

channelValue = Σ axisScore(a) * CHANNEL_WEIGHTS[a] / Σ CHANNEL_WEIGHTS[a]
```

**Weights** are set by discriminating power and novelty, not intuition:

| Axis | Weight | Rationale |
|---|---|---|
| setPiece | 0.50 | Widest league spread (0.170–0.370, sd 0.0555) and the only axis on which the composite currently carries no signal at all |
| fast | 0.30 | Moderate spread (0.026–0.117), near-independent of the other two |
| box | 0.20 | Narrowest spread (0.884–0.937, sd 0.0170) and the most quality-confounded (+0.408) |

`CHANNEL_SENSITIVITY = 14`, so a 2-pooled-SD mismatch moves an axis ±28 points.

**Personnel weighting.** `attackShare_A` is scaled by the availability-weighted chain
contribution of the players whose role signature places them on that axis (ST/SS for box,
WM/FB for fast, all outfielders for setPiece). Team `statistics` supply the shape; player
chain data make it respond to injury and rotation, which a season aggregate cannot.

## 7. Invariants

**The sum-to-100 mirroring identity must survive.** FEATURE_ENGINE §7.2 documents and
numerically verifies that `attackingValue + mirroredValue === 100` exactly. It holds only
because `calcCounterMatchupMirrored` derives its values arithmetically from an
already-computed attacking result. Channel mode must not compute a team's Defending
Counters independently from its own `statistics.*.against` — however tempting the
symmetry looks, it breaks the identity.

**Every pairing-key family needs UI entries.** Adding channel keys means adding to
`PAIRING_LABELS`, `DEFENDING_PAIRING_LABELS`, `MIRRORED_PAIRING_KEYS` and
`PAIRING_ROLE_ALIAS`. A missing entry renders raw camelCase in the UI — the exact bug
`PAIRING_LABELS`' comment records from Phase 3C.

**Engine purity holds** (CONVENTIONS §3.3): no DOM, no network, no store reads, no magic
numbers. Every constant in §4 and §6 lands in `config.js`.

## 8. Score consistency across modules

Tier selection is driven by **what is in the store**, not by which tab is active.
Viewing a fixture in Matchup caches those two teams' `statistics` for the session, so
Dashboard, Planner and Ranker then score those same teams in channel mode too. Scores
improve as the user browses and never disagree at a single point in time. This matches
how `leagueXg` already degrades through `buildScoreContext`. The cost is that a team's
score can visibly change after its fixture is visited, which the UI marks explicitly.

## 9. Verification

The repo has no test framework. Engine functions are pure ES modules and CONVENTIONS
§3.3 already requires them to be "unit-testable in isolation with plain object inputs",
so this design adds Node's built-in `node --test` runner — zero dependencies, permitted
by CONVENTIONS §1 ("package.json exists for Vercel/Node detection and dev tooling only").
This is a deliberate addition to project convention and is isolated in the first task so
it can be rejected independently.

Beyond unit tests:

- The mirroring identity is asserted numerically, as §7.2 already does by hand.
- `js/calibration.js` snapshots are compared before and after each scoring change.
- **Threshold re-validation.** §4's thresholds come from ≥900-minute players in a
  complete season and are applied in-season at a 450-minute floor. Mid-season, re-run the
  classification against current data and confirm known players still land correctly.

## 10. Deferred

- `gameState` (xG rate by scoreline, with minutes in state) — real game-script detection,
  but a larger modelling job than the three axes here.
- `formation` (modal shape by minutes) — would replace the hardcoded 4-4-2 baseline in
  `buildLikelyXi`/`calcIndividualDuels`.
- `timing` and `result` — `result` measures finishing luck, better used for confidence
  and regression to mean than for matchup.
- Blending the previous season's `statistics` to stabilise early-season shares. The
  interim guard is `MIN_CHANNEL_SHOTS`, which keeps a thin axis flagged estimated.
- Revisiting `WEIGHTS.counterMatchup` (0.20). §7.2 records that it was raised when the
  attack/defence blend doubled the underlying signal; a materially better counter signal
  is an argument to revisit it again, but that is a calibration question.
