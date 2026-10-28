# The decision engine

The Transfer Planner's advice: every legal single transfer scored by what it
does to the whole squad's expected points over the next five gameweeks, and
six modes, each a preset of that one calculation, naming one move, a roll or
(Future prep) a wait. This page is the reference: the data the engine reads,
its formulas, the modes and the config. With the multi-week solver switched on
(it ships off) each mode's move comes from a plan over several weeks instead,
and the engine explains it: see "The solver" below. How it was built and tested
is in `docs/decision-engine-plan.md` and, for the solver,
`docs/decision-engine-solver-plan.md`; what the backtest found is in
`docs/decision-engine-backtest.md`; the models behind the projections are in
`FEATURE_ENGINE.md` §14.

## Where it lives

| File | Does |
|---|---|
| `js/engine/projections.js` | the data contract below, per player and gameweek |
| `js/engine/minutes.js`, `points.js`, `team-goals.js` | the minutes and points models the projections are built from |
| `js/engine/squad-value.js` | V_t(S): a squad's value in one gameweek |
| `js/engine/decision.js` | `runDecisionEngine(input, config, cache)`: every mode's call; `describePlan`: the engine's explanation of any move set (the solver's) |
| `js/engine/robustness.js` | how often a move survives noisy re-runs |
| `js/engine/ceiling.js` | Ceiling's Monte Carlo upper tail |
| `js/engine/solver/` | the multi-week solver's model, problem, plans, re-scoring and HiGHS runtime (below) |
| `js/engine/prices.js`, `ledger.js`, `feasibility.js`, `price-adapter.js` | sell prices, purchase prices, legality, price signals |
| `js/modules/planner.js` | renders the result, and nothing else |
| `js/modules/planner-solver.js` | the solver's workers and queue, and the card each mode shows at each step |

All of it is pure: no DOM, no network (`engine/solver/worker.js` alone fetches, and only the vendored `highs.wasm`). Money is integer tenths of a million
everywhere in the engine, and a sold player is always valued at his sell
price, never his price.

## The data contract

`buildProjections` gives every player (the squad and every candidate) one
entry per gameweek of the horizon (`horizonGws`, six): a blank has no
fixtures, a double sums its two.

| Field | Meaning |
|---|---|
| `xpts` | expected points, minutes included, summed over the week's fixtures |
| `xptsIfPlays` | expected points given he plays |
| `pZero` | chance of no minutes at all |
| `pStart` | chance he starts at least once |
| `p60` | chance he plays 60 minutes or more |
| `availability` | chance he is fit and permitted to play (FPL's flag and its recovery) |
| `fixtures` | 0 blank, 1, 2 double |
| `draw` | what Ceiling's draws are made from; null on the v1 basis |
| `estimated`, `p60Approx`, `availabilitySource` | flags: where a figure came from a fallback |

The fixture enters only here, through each club's expected goals for and
against; nothing downstream adds a difficulty term on top.

## V_t(S): a squad's value in one gameweek

For squad S at gameweek t (`squadValue`):

- **The XI**: each position's best fill FPL's formation minimums, the best of
  the rest take the remaining slots, by `xpts`. Its value is their `xpts`.
- **The captain**: the XI player who maximises `xpts_c + pZero_c x xpts_v`
  (the vice covers only a captain who does not play). His bonus counts once
  more; under Triple Captain, twice more.
- **Autosubs**: the bench's expected recovery of absent starters. In
  `probability` mode it is exact over every pattern of absences, under FPL's
  bench order and formation rules; in `linear` mode each bench slot recovers
  `benchWeightsLinear` of its player's points.
- **Bench Boost**: the bench's `xpts`, less the recovery already counted.

V_t(S) is their sum. Free Hit and Wildcard act through the weights, not V: a
week a planned Free Hit or Wildcard covers has weight zero (from a Wildcard on,
every week).

## Scoring a move

For each owned player p and each legal buy q (`checkSwap`: position, budget at
sell prices, three a club):

- **dV_t** = V_t(S - p + q) - V_t(S), for each gameweek of the mode's window.
- **DeltaEV** = sum over t of w_t x dV_t, with the mode's weights w.
- **FundsTerm** = lambda x (money freed, in £m) x the share of the mode's
  weight no chip covers. Funds replaces it with its chained second move's net
  gain when that is larger.
- **PriceTerm** = lambda x the change to expect in p's sell price before the
  next chance to act (from the price signals). A tie-break, never a reason.
- **TransferCost**: with no free transfer, `hitCost + hitMargin`; at
  `maxBankedFt`, 0 (rolling would waste one); otherwise the value of the free
  transfer rolling would bank (`ftValueSchedule`, or `ftValueFlat`).
- **OutScore** = DeltaEV + FundsTerm (+ Structure's dead-slot term) -
  PriceTerm - TransferCost: the gain over rolling, the transfer already paid.

A mode makes its best move only when OutScore clears its `threshold` (0), the
seller is not locked or protected, and the move is not for money alone. Long
term also needs DeltaEV itself to beat the transfer's cost. Up to
`alternativesMax` alternatives within `alternativesWindow` points are shown.

**KeepValue** of p = sum of w_t x (V_t(S) - V_t(S - p + ghost)), the ghost
scoring nothing: what he is worth to this squad.

## The modes

Weights cover the next five gameweeks, the planning week first.

| Mode | Weights | lambda | Its own rule |
|---|---|---|---|
| Now | [1, 0, 0, 0, 0] | 0 | never buys a player flagged out or likelier than `pZeroGate` (0.25) to get no minutes; flags "wait for team news" when a doubt is in the move, the deadline is over `waitForNewsMinHours` away and no price is likely to move first |
| Long term | [1, 1, 1, 0, 0] | 0.30 | DeltaEV must also beat the transfer's cost |
| Future prep | [0.5, 0.75, 1, 1, 1] | 0.6375 | waits when the same move made next week scores within `deferralEpsilon` (0.425), unless at the free-transfer cap, at the season's end or before a Wildcard, or when a likely price move would put the buy out of reach |
| Funds & flexibility | 0.85^k, a horizon total | 0.10 | only downgrades losing at most `tau` (1.0) points; the `chainTopK` (5) most efficient (money freed per point lost) are credited with the best second move the money makes newly affordable, less its own transfer cost; money alone moves only from `minFreedTenths` (£0.5m) |
| Ceiling | 1 at the target week t\*, 0.1 elsewhere | 0 | t\* is the week whose 15 highest `xpts` across all players sum highest; in a big week (t\* a double for a squad player or a replacement the tail shortlists, or Bench Boost or Triple Captain planned for it) a swap at t\* scores its change to the squad's 90th-percentile score over 500 Monte Carlo draws (`tail`); otherwise expected points. Its card, and Now's, also show the move over the next five GWs at full weight. Lock value: V_t\*(S) - V_t\*(S - p + his best affordable replacement); at `lockThreshold` (3) or more, Now, Long term, Future prep and Funds will not sell him |
| Structure fix | [1, 0.85, 0.72, 0.61, 0.52] | 0.10 | a dead slot (a player expected out `deadSlotMinGws` (2) weeks or more) costs `deadSlotPenalty` (1); holds a flagged player who recovers to `recoveredAvailability` (0.9) inside the window unless his sell price is likely to fall |

Every mode weighs its window as a horizon total, in the same points as the
free transfer's value and the hit it is compared with. Long term and Future
prep were the brief's per-week averages (÷ 3 and ÷ 4.25) until the solver
plan's scale fix (`docs/decision-engine-solver-plan.md`, Phase 1), which also
moved their lambda and Future prep's deferral epsilon by the same sums, so
money and the wait weigh against points as before.

## The solver

Off as shipped. With `DECISION_ENGINE.solver.enabled`, each of the six modes becomes a setting of one multi-week
planner, a mixed-integer program solved by HiGHS (WebAssembly, in module workers). It may make several moves in a week
and take hits. The engine stays: it supplies the sell and keep values, the protected players, the robustness candidates
and the explanation of every move, and it supplies the move itself while the solver is working, when a solve returns
nothing inside its cap, and on Ceiling's card in a big week. The solver plays no chip: the hints are unchanged, and a
chip you have planned shapes its objective as it shapes V.

| File | Does |
|---|---|
| `js/engine/solver/model.js` | the model: a multi-week plan as an LP-format MILP, and a solution read back; free transfers counted exactly |
| `js/engine/solver/problem.js` | `modeSetting`: a mode as a setting from the engine's input and result; `solverProblem`: that setting as the model's input |
| `js/engine/solver/plan.js` | a solved plan as ordered moves (`orderMoves`), the protected-sale check, the card and its keyed figures, the gain over rolling, the alternatives |
| `js/engine/solver/rescore.js` | `pickBeatsAlternatives`: robustness as re-scoring of the pick under the engine's noise |
| `js/engine/solver/highs.js` | loads the vendored HiGHS from bytes, solves a problem (module worker and Node) |
| `js/engine/solver/worker.js` | the module worker: fetches `highs.wasm` against its pinned hash, then answers `init` and `solve` |
| `assets/vendor/highs/1.15.4/` | HiGHS 1.15.1 as WebAssembly (npm `highs` 1.15.4, MIT), byte for byte, with its licence and a README |
| `js/modules/planner-solver.js` | the runner: the pool, the queue, the card states, the keying of every figure |
| `js/snapshots.js` | the decision log, kept with the snapshots and in the export |
| `tools/backtest/solver.js` | the app's solver path as a backtest policy, set as the offline planner was (`--solver-repro`) |

### A mode as a setting

The weights are the table above, as the engine masks them: a planned Free Hit week weighs 0, and every week from a
planned Wildcard on, so the horizon ends at the mode's last weighted week and before a Wildcard.

| Mode | What the solver adds to the shared terms |
|---|---|
| Now | a buy flagged out, or likelier than `pZeroGate` to get no minutes in the first GW, is not in the pool; "wait for team news" stays the engine's flag, applied to the solver's move |
| Long term | nothing: its gate (DeltaEV must beat the transfer's cost) is what the objective does anyway |
| Future prep | "wait" is no move now and one next week: the card shows WAIT with next week's move, tentative |
| Funds & flexibility | each £1m left in the bank at the horizon's end is worth lambda |
| Ceiling | expected points; in a big week (the tail's trigger) the card keeps the engine's tail-scored move, `source: 'engine-tail'` |
| Structure fix | a dead slot kept costs `deadSlotPenalty` once; a player Structure holds is not sold in the first week |

Shared by all of them:
- **Kept players**, not sold in the first week: locked players in every mode; Ceiling's protected players (lock value at
  or over `lockThreshold`) in Now, Long term, Future prep and Funds; Structure's holds in Structure. Banned players are
  left out of the pool. A plan that sells a kept player in the first week is a bug: `checkProtected` throws, and the card
  keeps the engine's move. The model keeps them in the first week only, so a plan may sell one the week after and call
  that a wait: the runner checks a wait in the week it waits for, and on a hit the card is a roll (warned, not an error;
  the plan's weeks after the wait stay as its tentative list).
- **Free transfers** are counted as FPL counts them: the unused ones carry to the cap, and a hit buys none, so weights
  may rise week to week. At the horizon's end each banked free transfer is worth the engine's schedule
  (`ftValueSchedule`, or `ftValueFlat`), and the bank is worth the mode's lambda a £1m.
- **Money** follows the engine: the bank's value, a likely fall in an owned player's sell price (worth selling for) and
  Structure's dead-slot penalty are scaled by `modes[m].share`, the part of the mode's weight no planned chip covers.
- **Hits** cost `hitCost` plus the mode's `solver.modes.<id>.hitMargin` (0 as shipped; Phase 4 runs 0 and 2), flat: a hit in a
  week that weighs 0.1 costs the same as one in a week that weighs 1, as the engine's `transferCost` prices it (the
  model's `flatHits`, on for every mode; only the reproduction check leaves it off, to hold Phase 8's planner).
- **Planned Bench Boost and Triple Captain** put the bench at full weight, or the armband three times, in that GW.
- **The pool** of players a plan may buy, per position: the `pool.points` best by weighted points over the horizon and the
  `pool.pointsPerTenth` best by weighted points a tenth of £1m, among those the mode can buy, plus every buy the engine
  itself made in any mode. A setting with `engineBuys: false` leaves that last part out (the reproduction check does).
- **Sell prices** are the engine's, from the ledger; a player bought within the horizon sells at his price.

### What a card shows

A card paints the engine's move at once, marked Refining while its solve runs, and is repainted in place when the
solver's plan lands. The first week's sales and buys are paired into moves FPL takes one at a time (`orderMoves`); the
card holds several moves with their transfers line, and the later weeks of the plan shown tentative.

| Field | From |
|---|---|
| `source` | `solver`; `engine` (no solver answer yet, or none inside the cap); `engine-tail` (Ceiling in a big week). Shown on the card |
| `call` | `move` if the first week has moves and its gain over rolling is above `absGap`; `wait` if it has none and the second week does; else `roll` |
| `moves[]`, `root` | the first week's moves, ordered; `root` is the first, carrying the whole set's figures |
| `perGw`, `deltaEv`, `why`, `minutesRisk`, `tags` | the engine, on the squad after the moves (`describePlan`) |
| `gain` | the plan less its best plan with the first week held to no moves, on the mode's own objective |
| `alternatives` | re-solves with the chosen first week excluded, up to `alternativesMax` within `alternativesWindow` |
| `robustness` | `pickBeatsAlternatives`; computed and logged, not shown while `showRobustness` is false |
| `updated`, `replaced`, `engineCall` | the solver's move differs from the engine's: an "Updated" note names the engine's move it replaced, or, when the engine would have waited for this very move, says the plan makes it now. A solver wait shows no scores: those are the engine's |

**Every figure is keyed to the move it was computed for**: the move set (its sales and its buys, sorted, so how they
are paired does not matter) and the input's version. A figure whose key is not the card's is dropped, and "Still
calculating" stands in its place, so a solver move never sits beside a figure computed for the engine's move or an older
input. A newer input drops everything still queued for an older one.

### The runner

- **Workers.** Made on the first solve, never at page load: `min(workers, cores - 1)`, at least one. A phone (a coarse
  pointer on a screen at most `phone.maxWidthPx` wide, or fewer than `phone.minCores` cores, or under
  `phone.minMemoryGb` of device memory) gets one, and solves the cards that came into view, in the order viewed.
- **The queue.** Every solve a card's move waits on (its pick and, for a move, its rolling twin) before any follow-up
  (alternatives, then robustness), so a card's move never waits on another card's figures.
- **A move must beat rolling.** A pick that moves settles only once its rolling twin has landed. If its gain over rolling is
  not above `absGap` it is within the solve's own noise (a sideways swap that frees £0.1m, say), and the card is a roll:
  source `solver`, call `roll`, the plan's later weeks kept as its tentative list, the engine's move named as replaced.
  A wait or a roll pick is its own rolling twin and needs no second solve.
- **Limits.** A solve stops at `timeLimitS` or within `absGap` points of its bound. The page gives up on it
  `timeoutMarginS` later and replaces the worker, since a synchronous solve cannot be interrupted. A worker that has not
  loaded HiGHS by `initTimeoutS` turns the solver off for the session.
- **Falling back.** No plan inside the cap, an error, a stuck or failed worker, a changed `highs.wasm` (its hash is
  pinned in `solver.vendor` and checked by the fetch), a protected sale, a plan with no legal order, a rolling solve that
  fails or no `Worker`: the card keeps the engine's move, marked as the engine's, and nothing throws into the page.

### The decision log

Every card the Planner settles is logged, one entry per gameweek, mode, call, move set and source (key
`gw|mode|call|moveSetKey|source`, so a wait of a move set is not a move of it, and a roll has the empty set):
`{ gw, at, mode, source, call, stopped, moves, gain, robustness, engineFirst, agrees }`. It lives in the `decisions` store
of the snapshot database (`js/snapshots.js`, version 2), is updated in place as the gain and robustness land, drops the
oldest past `solver.logMax`, and is in "Export snapshots" as `decisions`.
- `call` is `move`, `wait` or `roll`; `stopped` says the solve that made the card (its pick) stopped at its time limit,
  false for an engine card.
- `gain` is the gain over rolling that landed on a solver card (null until then); for an engine card it is its root's
  `outScore`, and null for an engine roll.
- `engineFirst` is the engine's whole move set (its root and, for Funds, the second move it chains), and `agrees` says
  whether the two match.
If an older tab still holds the database at version 1 and blocks the upgrade to version 2, that visit keeps no snapshots
and no log (the store answers with the keep-nothing one, with one warning), and the Planner projects without the stored
per-gameweek minutes tables, from season totals. The next visit with no older tab open upgrades it.

### The reproduction check

`node tools/backtest/run.js --solver-repro` plays the app's own solver path on the backtest's squads, set exactly as
Phase 8's offline planner was, and pairs it with `data/milp.json`. The report ("The app's solver against the offline
planner" in `docs/decision-engine-backtest.md`) holds the gap in points a season, the solves and where the solver's
first week and each mode's move differ.

## Robustness

`robustness` re-runs the engine `robustnessRuns` (30) times on seeded noisy
copies of its input (each player's points scaled by one factor, `pZero` moved
on the logit scale, the free transfer's value and the decay moved), buying
only from the result's shortlist, in a module worker after the cards have
painted. Each run's top three moves per mode score 3, 2 and 1; a move's
robustness is its share of the most it could score (`withRobustness` writes
it onto the result).

## Chip hints

`chipHints` pre-fills the chip plan, never applied unless accepted: Bench
Boost in the week of the horizon where the bench adds most beyond the autosubs
already counted, Triple Captain where the captain's extra armband is worth
most, each only in a half whose chip is unused and before any planned
Wildcard.

## Input and output

```js
runDecisionEngine({
  planningGw, squad: [{ playerId, name, position, teamId, priceTenths, purchaseTenths }],  // 15
  bankTenths, freeTransfers, chipPlan: { [gw]: chip }, chipsUsed: [{ chip, gw }],
  locks, bans,                          // Sets of player ids
  projections, candidates,              // buildProjections output; every possible buy
  priceSignals, hoursToDeadline,        // or null
}, DECISION_ENGINE, cache)
// -> { modes: { [modeId]: { call: 'move'|'roll'|'wait', root, alternatives, rollValue, robustness,
//        waitForNews, deferral, targetGw, tail, bigWeek, share } },
//      players: [{ playerId, sellPriceTenths, saleTenths, keepValue, outScore, best, flags, lockValue, pP90, uncoveredLoss }],
//      lineup, chipHints, shortlist }
```

Each move carries its components (`deltaEv`, `perGw`, `fundsTerm`,
`priceTerm`, `transferCost`, `outScore`), both players' minutes risk, a
Funds chain if any, and its reasons in plain English. Pass the same `cache`
back and a lock, ban or free-transfer change re-runs on cached V values.

`players[].saleTenths` is the change to expect in the player's sell price before the next chance to act (tenths of £1m,
from the price signals). `modes[m].bigWeek` says the upper tail scored the card (Ceiling's, in a big week), which the
solver leaves to the engine, and `modes[m].share` is the part of the mode's weight no planned chip covers (0-1), which
scales the mode's money terms, the solver's too.

## Config

Every tunable is a key of `DECISION_ENGINE` in `js/config.js`; the engine
files hold no other numbers but 0 and 1.

| Key | Value | Meaning |
|---|---|---|
| `horizonGws` | 6 | gameweeks projected (the sixth feeds only the chip hints and plan) |
| `maxBankedFt` | 5 | the free-transfer cap |
| `ftValueMode`, `ftValueFlat`, `ftValueSchedule` | decreasing; 1.75; {2: 1.5, 3: 1.0, 4: 0.6, 5: 0.3} | what a rolled free transfer is worth |
| `hitCost`, `hitMargin` | 4, 2 | a hit, and the margin a move taking one must also clear |
| `lambdaDefault`, `decayBase` | 0.10, 0.85 | points per £1.0m; Funds' weight decay |
| `autosubMode`, `benchOrder`, `benchWeightsLinear` | probability; xptsIfPlays; {s1: 0.30, s2: 0.10, s3: 0.03, gk: 0.03} | how V credits the bench |
| `alternativesWindow`, `alternativesMax` | 2, 2 | alternatives shown under a move |
| `minutesRiskPZero` | {medium: 0.1, high: 0.3} | a player's minutes-risk badge |
| `priceMoveLikely`, `waitForNewsMinHours` | 0.95, 24 | a likely price move; the team-news wait |
| `robustness*` | 30 runs, [3, 2, 1], seed 1, noise, shortlist 10 | the re-runs |
| `absenceCarryOver`, `absenceMinRunGws`, `absenceLookbackGws`, `minContentionGws` | | availability and recovery |
| `minutesFeatures`, `minutesModel` | fitted by `tools/minutes` | the minutes model; null runs the v1 rates |
| `pointsModel` | fitted by `tools/points` | the points model; null runs the v1 basis |
| `modes` | the table above | each mode's preset |
| `solver` | see below | the multi-week solver: its switch, workers, limits, pool and per-mode hit margin |

`solver` (`DECISION_ENGINE.solver`):

| Key | Value | Meaning |
|---|---|---|
| `enabled` | false | the switch: false is the single-move engine exactly as it was |
| `lpLineTerms` | 8 | terms per line of the model's LP text, which stays readable |
| `workers`, `phone` | 3; { maxWidthPx 639, minCores 4, minMemoryGb 4 } | solver workers at most, and what counts as a phone (one worker) |
| `timeLimitS`, `absGap` | 3, 0.5 | a solve stops at the limit or within `absGap` points of its bound |
| `timeoutMarginS`, `initTimeoutS` | 2, 20 | the page's wait past a solve's limit, and for a worker to load HiGHS |
| `pool` | { points 20, pointsPerTenth 10 } | the others a problem may buy, per position |
| `showRobustness` | false | robustness stays off every card until Phase 4's check passes |
| `logMax` | 5000 | decision log entries kept |
| `vendor` | folder, SHA-256 (base64) of `highs.mjs` and `highs.wasm` | the build to load, and the hashes it must match |
| `modes.<id>.hitMargin` | 0 | points added to every hit's cost in the solver's objective, per mode |

To change a preset, run the decision backtest (`GAFFER_IQ_TESTING_ROADMAP.md`)
before and after, and read the verdict against the last one.
