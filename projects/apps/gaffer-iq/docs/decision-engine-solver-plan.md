# Solver-led decision engine: plan (Phase 0)

Date: 2026-10-22. Status: **awaiting your approval**. No code has changed for
this pass.
Source: "Gaffer IQ engine: recommended changes" (22 Oct 2026, Josh Bailey),
its Build scope, Mode scale fix, Solver feasibility check and Phases table.
Branch: `Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`; `main` is
not touched.

## What this pass builds

- **The solver picks the moves.** Each of the six modes becomes a setting of
  the multi-week planner built as Phase 8's referee (`tools/milp/model.js`):
  its horizon and weights, free-transfer value, bank value and constraints.
  It may plan several moves in a week and take hits.
- **The engine stays** for sell and keep values, explanations, the
  robustness shortlist and as a cross-check. When the two disagree on the
  first week, the card shows the solver's move and the disagreement is
  logged.
- **Chips stay suggestions.** The solver plays none; the chip hints are
  unchanged. Chips you have planned do shape its objective, as they shape V.
- **One switch.** `DECISION_ENGINE.solver.enabled`; `false` is the
  single-move engine exactly as today.
- **Out of scope:** the extra test measures and the projection upgrades.

The phases and stops are the source's: 0 plan (this), 1 mode scale fix,
2 cards and Ceiling default, 3 solver integration, 4 evaluation. Each ends at
your check.

## 1. Solver feasibility

### What exists

npm `highs` 1.15.4 (MIT) is HiGHS 1.15.1 compiled to WebAssembly. It is
already installed in `tools/milp/` and ran every Phase 8 solve. It ships:

- `highs.js` (168 KB, a classic script) and `highs.mjs` (an ES module, so a
  module worker can import it);
- `highs.wasm`: 3.5 MB, or 1.2 MB gzipped.

It runs unchanged in Node and in Chromium. Native HiGHS (`highspy` 1.15.1,
the same solver version) was installed for comparison.

### How it was measured

- **Problems:** 48 real ones from 2025-26 (vaastav as it stood before each
  deadline, the app's own projection path).
  - **Weeks:** GW8, 16, 24 and 32.
  - **Squads:** two at each week. One is that week's most-owned template. The
    other is GW4's template held unchanged, a squad that needs work.
  - **Settings:** each squad under all six mode settings, with Long term and
    Future prep as totals.
  - **Solver input:** 2 free transfers; candidates are the owned 15 plus, per
    position, the 20 best by weighted points and the 10 best by points a
    tenth (about 125 players).
- **Machine:** this container, 4 cores.
- **Tolerance:** within half a point of the bound (`mip_abs_gap` 0.5), as in
  Phase 8.

### Results

| Runtime | Median solve | 90th percentile | Slowest | Over 3 s (of 48) | Memory |
|---|---|---|---|---|---|
| WebAssembly in Node | 2.2 s | 8.9 s | 15.8 s | 12 | 400 MB process after 48 solves |
| WebAssembly in Chromium (headless) | 2.3 s | 8.9 s | 15.6 s | 13 | WASM compiles in 59 ms |
| Native HiGHS, 1 thread | 2.2 s | 7.0 s | 20.5 s | 11 | 213 MB |
| Native HiGHS, 4 threads | 1.8 s | 7.2 s | 22.5 s | 10 | 219 MB |

By mode (WebAssembly in Node):

| Mode | Median | Slowest |
|---|---|---|
| Now | 0.07 s | 0.5 s |
| Long term | 1.7 s | 5.8 s |
| Future prep | 2.7 s | 11.8 s |
| Funds | 3.2 s | 15.8 s |
| Ceiling | 2.6 s | 3.0 s |
| Structure | 4.4 s | 14.8 s |

- **Native code is not faster.** The time goes on the problem itself (HiGHS
  spends it closing the last fraction of a point of gap), not on
  WebAssembly. A server buys parallelism and offloading, not speed.
- **A 3-second cap costs little.**
  - With `time_limit: 3`, 14 of 48 solves stopped early.
  - 46 of 48 still chose the same first week as the 30-second solve.
  - The two that differed lost 1.6 and 2.1 points on the solver's own
    objective.
  - The best plan is usually found early; the rest of the time goes on
    proving it.
- **A full refresh of all six cards** (3 s cap, WebAssembly, the eight
  states):

| Workers | Wall time per refresh (median) | Peak memory |
|---|---|---|
| 1 | 13.3 s | 394 MB |
| 3 | 6.0 s | 694 MB |
| 6 (4 cores) | 3.1 s | 1,010 MB |

  Each extra solver instance costs about 100–150 MB.

### The three options

| Option | Solve time | Fits the app? | Lock/ban re-solve | 30 noisy re-solves per mode |
|---|---|---|---|---|
| **A. WebAssembly in the browser**, module workers | as above: 2–3 s a mode with the cap; 6 s for six cards on 3 workers | Yes. No server; the squad never leaves the browser. 1.2 MB gzipped, loaded only when the Planner opens. No CSP to change (`vercel.json` sets none). | 3–6 s, the engine's instant answer shown meanwhile | No: 150 heavy solves, about 2 min on 3 workers, at full CPU |
| **B. A Vercel function** (`api/solve.js`, Node, the same package) | the same per solve, plus a cold start; six modes as six parallel calls, about 3 s | Partly. The projections (about 600 players × 6 GWs) have to be posted each time. Duration limits and cost depend on the project's Vercel plan, not checked here. Native HiGHS would mean a Python function (risk 5) for no gain in speed. | about 3 s, with network latency | Only as 150 calls of about 3 s each per refresh, per user: too costly to run on every change |
| **C. A scheduled job** precomputing plans | any | Poorly. The app has no server-side store (plan risk 1); squads, bank, locks and bans live in the browser, and any change invalidates a plan. | not possible | yes, overnight |

### Recommendation: A, WebAssembly in the browser

- **Speed.** It is as fast as any option, because native code is not faster.
- **No infrastructure.** No server, no data leaving the browser, and no
  third-party solver service.
- **How it runs:**
  - A pool of solver workers: `min(3, navigator.hardwareConcurrency − 1)`,
    about 100–150 MB each.
  - Each solve is capped at 3 s with a half-point tolerance.
  - The cards paint at once from the engine, as now. Each mode's card
    switches to the solver's move when its solve lands, about 3–6 s for all
    six.
  - Lock and ban work the same way: the engine's answer at once, the
    solver's within seconds.
- **The 3-second target is met per solve**, by the cap. A full six-card
  refresh is 3–6 s, depending on the device's cores.

### The robustness load: needs your call

No option carries 30 noisy re-solves per mode interactively, so I propose
**re-scoring instead of re-solving**:

1. Each mode's candidates for its first week are the solver's pick, its two
   alternatives (below) and rolling.
2. Each of the existing 30 noisy copies of the input scores every candidate
   with the engine's V over the mode's window, less its transfers' cost.
3. Robustness is the share of copies in which the solver's pick scores
   best.

This costs about what today's robustness costs. It measures whether the pick
survives noise against its real rivals, not whether a re-solve would find
the same plan.

The alternative is 10 re-solves per mode with a 1 s cap, run in the
background. That is about 50 s of full CPU per refresh on 3 workers.

### Not yet verified

- Safari and Firefox, and any phone.
- Phones have fewer cores and less memory: expect 2 workers there and a
  refresh nearer 8 s.

Phase 3 includes a check on a real phone.

## 2. Each mode as a solver setting

Weights are over the next five GWs, planning week first. A mode's horizon
ends at its last non-zero weight, which also makes its solve smaller.

| Mode | Weights (after the scale fix) | Its own rule, as the solver holds it |
|---|---|---|
| Now | [1] | A buy flagged out, or with pZero above `pZeroGate` (0.25) this week, is not in the pool. "Wait for team news" stays the engine's flag, applied to the solver's move. |
| Long term | [1, 1, 1] | Its gate (DeltaEV must beat the transfer's cost) is what the solver's objective does anyway. |
| Future prep | [0.5, 0.75, 1, 1, 1] | "Wait": a plan with no move this week and one next week shows WAIT with next week's move, tentative. The engine's deferral test is no longer needed for the call; it stays in the explanation. |
| Funds | 0.85^k | Bank value: λ per £1m left in the bank at the horizon's end, so money freed counts as it does in FundsTerm. The engine's chain and efficiency stay as the explanation. |
| Ceiling | 1 at t\*, 0.1 elsewhere | Expected points (Phase 2's default). Players the lock list protects (lock value ≥ 3) cannot be sold in the first week by Now, Long term, Future prep or Funds, as today. In weeks where the upper tail applies (a double gameweek or a planned chip at t\*), the Ceiling card keeps the engine's tail-scored move: the tail is not linear, so the solver cannot hold it. |
| Structure | [1, 0.85, 0.72, 0.61, 0.52] | A dead-slot player kept costs `deadSlotPenalty` once, as now. A player Structure holds (recovering, no likely price fall) cannot be sold in the first week. |

**Shared by all modes:**
- Locks (never sold) and bans (never bought).
- Planned Bench Boost and Triple Captain: the bench at full weight, or the
  armband three times, in that GW.
- Planned Free Hit and Wildcard GWs: weight 0, and every GW after a
  Wildcard, as in V.
- Selling prices from the ledger.
- The free-transfer value schedule, at the horizon's end: each banked free
  transfer is worth 1.5 / 1.0 / 0.6 / 0.3, so the plan stops spending them
  just because the horizon ends.
- A hit's cost of 4. The 2-point hit margin: your call, see §6.

**Model work this needs** (Phase 3, tests first):
- **An exact free-transfer carry.** The current model refuses weights that
  rise from week to week, because a hit could then buy a free transfer.
  Future prep's and Ceiling's weights rise. One binary a week, "any free
  transfer left unused", makes the carry exact, so hits buy nothing.
- **End-of-horizon terms:** the free-transfer value and the bank value.
- **Constraints:** a pool filter for Now's gate, first-week sale bans for
  protected and held players, and the dead-slot term.
- **The sell-price term:** a likely sell-price change on first-week sales,
  as PriceTerm.

## 3. Solver output onto the cards

| Card field | From |
|---|---|
| `call` | `move` if the first week has moves; `wait` if it has none and the second week does; `roll` otherwise |
| The move | The first week's sales and buys, paired and ordered by `orderMoves`. A card can now hold several moves with their hits: `root` becomes `moves[]`, and `root` stays as the first for the parts that read one. |
| Gain over rolling (`outScore`) | The solver's plan less its best plan with the first week fixed to no moves, on the mode's own objective: one more solve per mode, in the background |
| `perGw`, `deltaEv`, `why`, `minutesRisk`, `tags` | The engine, on the squad after the first week's moves (engine explains) |
| `robustness` | Re-scoring, as above |
| `alternatives` | Re-solves with the chosen first week excluded (a no-good cut), up to 2 within `alternativesWindow`: two more solves per mode, in the background |
| Later weeks of the plan | New: shown greyed as tentative, as the brief's §8 item 7 asks |
| Disagreement | New: when the engine's root move set differs from the solver's first week, a log entry (GW, mode, both move sets, what the engine's week costs the solver's plan). It is kept with the snapshots in IndexedDB and included in the export, and in the backtest written per week. |

Per refresh that is 6 picks first (about 3–6 s). In the background follow 5
rolling plans and 10 alternatives (about 20 s more on 3 workers).

## 4. Phase 1: the mode scale fix

**Change.** Long term's weights go from [1, 1, 1, 0, 0] ÷ 3 to
[1, 1, 1, 0, 0], and Future prep's from [0.5, 0.75, 1, 1, 1] ÷ 4.25 to
[0.5, 0.75, 1, 1, 1]. The free-transfer schedule, the hit cost and the margin
stay.

**How the money terms scale (my finding).**
- FundsTerm and PriceTerm are λ × £m × share. Share is a ratio of weights,
  unchanged by the scale.
- DeltaEV grows by the sum of the weights: ×3 for Long term, ×4.25 for
  Future prep.
- So, to value £1m against a point exactly as before, λ moves in step:
  - Long term 0.10 → 0.30.
  - Future prep 0.15 → 0.6375.
- Two more of Future prep's settings are in DeltaEV units and move the same
  way:
  - `deferralEpsilon` 0.1 → 0.425.
  - Its later-score money term, which uses the same λ.
- `alternativesWindow` (2 points) stays: it is the brief's "within about 2
  points" of the move's gain.
- Funds, Structure, Now and Ceiling do not change: their weights were never
  divided.

**What to expect.** Phase 7a's risk-8 test already ran these two modes as
totals, but with λ left as written:
- Long term: −32.6 [−95.6, +22.7] on 2025-26, −11.1 pooled.
- Future prep: −1.0 and +1.2.
- About 1.5 more transfers a season for Long term and none for Future prep.

Phase 1 reruns both seasons and all 12 squads with λ rescaled. It reports
each mode against its old self (pass: no paired interval wholly below zero)
and transfers a season per mode.

## 5. Phase 2: cards and the Ceiling default

- **Ceiling defaults to expected points.** `modes.ceiling.tail` stays
  configured, but applies only when t\* has a double gameweek (any club
  playing twice that week) or Bench Boost or Triple Captain planned for it.
  Tests cover both conditions and the default.
- **Now and Ceiling cards show the 5-week figure:** the move's squad gain
  summed over the next five GWs at full weight, less its transfers' cost. It
  reads as "over 5 GWs: +x points against rolling" beside the mode's own
  figure. Checked on a real squad in the browser.

## 6. Decisions for you before Phase 1

1. **The runtime.** Approve option A: WebAssembly in the browser, 3 workers
   at most, each solve capped at 3 s.
2. **Robustness.** Re-scoring the pick against its alternatives and rolling
   under the 30 noisy copies (recommended), or 10 background re-solves per
   mode.
3. **The hit margin in the solver.**
   - 0, as the offline planner that tested well used (recommended for the
     Phase 3 reproduction check, which needs the planner's own settings).
   - Or 2, as the engine uses.
   - Either is one config key per mode.
4. **Ceiling when the tail applies.** Keep the engine's tail move on the
   Ceiling card (recommended), or let the solver choose on expected points
   there too.
5. **Shipping the solver in the app.**
   - `highs.wasm` and its loader, MIT, go into `assets/vendor/highs/` with
     the licence file.
   - The app's first self-hosted binary, 1.2 MB gzipped, fetched only when
     the Planner opens.

## 7. Files

| Phase | Files |
|---|---|
| 1 | `js/config.js` (weights, λ, `deferralEpsilon`); `tests/engine/decision.test.js`; `tools/backtest/run.js` (a stage comparing the presets before and after); `docs/decision-engine.md`, the plan and the backtest report |
| 2 | `js/engine/decision.js` (the tail condition, the 5-week figure on Now and Ceiling moves); `js/config.js`; `js/modules/planner.js`; `css/planner.css`; tests |
| 3 | `js/engine/solver/model.js` (from `tools/milp/model.js`, with the exact free-transfer carry, end-of-horizon terms and constraints; numbers into config); `js/engine/solver/problem.js` (from `tools/backtest/milp.js`: a mode's setting and the engine's input to a problem); `js/engine/solver/plan.js` (decode, `orderMoves`, card fields, disagreement); `js/engine/solver/worker.js` (module worker loading `highs.mjs`); `assets/vendor/highs/` (`highs.mjs`, `highs.wasm`, licence); `js/modules/planner.js` and `css/planner.css` (several moves a card, tentative later weeks, progressive update); `js/snapshots.js` (the disagreement log in the export); `js/config.js` (`solver`: enabled, workers, time limit, gap, pool, each mode's settings); `tools/backtest/` (the solver policy per mode through the app's own modules; the reproduction check); tests for each module; docs |
| 4 | `tools/backtest/run.js` (a stage: each mode's solver policy against the old engine, roll+ and Long term+, on 2025-26 and pooled); the report; the plan |

**Phase 3's pass check.** I run a solver policy set exactly as the offline
planner was (decay 0.85 over five GWs as a total, no end-of-horizon values,
hits at 4, no margin, the same pool) through the app's new modules, on the
same backtest squads. I report the gap to `data/milp.json`'s planner in
points a season, and explain any gap over 20. The 3 s cap against Phase 8's
10 s is the expected source of a small gap.

**Phase 4's runtime.** Six solver policies over 24 squad-seasons is about
5,000 solves: roughly an hour on four cores, resumable as before.
