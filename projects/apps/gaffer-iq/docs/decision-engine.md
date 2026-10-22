# The decision engine

The Transfer Planner's advice: every legal single transfer scored by what it
does to the whole squad's expected points over the next five gameweeks, and
six modes, each a preset of that one calculation, naming one move, a roll or
(Future prep) a wait. This page is the reference: the data the engine reads,
its formulas, the modes and the config. How it was built and tested is in
`docs/decision-engine-plan.md`; what the backtest found is in
`docs/decision-engine-backtest.md`; the models behind the projections are in
`FEATURE_ENGINE.md` §14.

## Where it lives

| File | Does |
|---|---|
| `js/engine/projections.js` | the data contract below, per player and gameweek |
| `js/engine/minutes.js`, `points.js`, `team-goals.js` | the minutes and points models the projections are built from |
| `js/engine/squad-value.js` | V_t(S): a squad's value in one gameweek |
| `js/engine/decision.js` | `runDecisionEngine(input, config, cache)`: every mode's call |
| `js/engine/robustness.js` | how often a move survives noisy re-runs |
| `js/engine/ceiling.js` | Ceiling's Monte Carlo upper tail |
| `js/engine/prices.js`, `ledger.js`, `feasibility.js`, `price-adapter.js` | sell prices, purchase prices, legality, price signals |
| `js/modules/planner.js` | renders the result, and nothing else |

All of it is pure: no DOM, no network. Money is integer tenths of a million
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
| Ceiling | 1 at the target week t\*, 0.1 elsewhere | 0 | t\* is the week whose 15 highest `xpts` across all players sum highest; at t\* a swap scores its change to the squad's 90th-percentile score over 500 Monte Carlo draws (`tail`; null reads the mean). Lock value: V_t\*(S) - V_t\*(S - p + his best affordable replacement); at `lockThreshold` (3) or more, Now, Long term, Future prep and Funds will not sell him |
| Structure fix | [1, 0.85, 0.72, 0.61, 0.52] | 0.10 | a dead slot (a player expected out `deadSlotMinGws` (2) weeks or more) costs `deadSlotPenalty` (1); holds a flagged player who recovers to `recoveredAvailability` (0.9) inside the window unless his sell price is likely to fall |

Every mode weighs its window as a horizon total, in the same points as the
free transfer's value and the hit it is compared with. Long term and Future
prep were the brief's per-week averages (÷ 3 and ÷ 4.25) until the solver
plan's scale fix (`docs/decision-engine-solver-plan.md`, Phase 1), which also
moved their lambda and Future prep's deferral epsilon by the same sums, so
money and the wait weigh against points as before.

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
//        waitForNews, deferral, targetGw, tail } },
//      players: [{ playerId, sellPriceTenths, keepValue, outScore, best, flags, lockValue, pP90, uncoveredLoss }],
//      lineup, chipHints, shortlist }
```

Each move carries its components (`deltaEv`, `perGw`, `fundsTerm`,
`priceTerm`, `transferCost`, `outScore`), both players' minutes risk, a
Funds chain if any, and its reasons in plain English. Pass the same `cache`
back and a lock, ban or free-transfer change re-runs on cached V values.

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

To change a preset, run the decision backtest (`GAFFER_IQ_TESTING_ROADMAP.md`)
before and after, and read the verdict against the last one.
