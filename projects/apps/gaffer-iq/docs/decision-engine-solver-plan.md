# Solver-led decision engine: plan (Phase 0)

Date: 2026-10-22. Status: **approved with conditions** (your reply of
22 Oct, items 1-10, folded in below). Phase 1 is in progress.
Source: "Gaffer IQ engine: recommended changes" (22 Oct 2026, Josh Bailey),
its Build scope, Mode scale fix, Solver feasibility check and Phases table.
Branch: `Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`; `main` is
not touched.

## What this pass builds

- **The solver picks the moves.** Each of the six modes becomes a setting of
  the multi-week planner built as Phase 8's referee (`tools/milp/model.js`):
  its horizon and weights, free-transfer value, bank value, hit margin and
  constraints. It may plan several moves in a week and take hits.
- **The engine stays** for sell and keep values, explanations, the
  robustness candidates and as a cross-check, and it supplies the move in
  three cases:
  - while the solver is working;
  - when a solve returns nothing inside its cap;
  - on Ceiling's card in a big week (§2).
- **Chips stay suggestions.** The solver plays none; the chip hints are
  unchanged. Chips you have planned do shape its objective, as they shape V.
- **One switch.** `DECISION_ENGINE.solver.enabled`; `false` is the
  single-move engine exactly as today.
- **Out of scope:** the extra test measures (other than the robustness check
  below) and the projection upgrades.

The phases and stops are the source's, with your added checks:
- 0: this plan.
- 1: the mode scale fix.
- 2: the cards and Ceiling's default.
- 3: solver integration.
- 4: evaluation.

Each ends at your check.

## Conditions you set, and where each is covered

| # | Condition | Covered in |
|---|---|---|
| 1 | Browser, at most 3 workers, 3 s cap. Safari, Firefox and a phone tested before Phase 4 ends, with solve times. Phones: fewer workers, the selected card solved first, the others on demand. A solve with nothing inside the cap keeps the engine's move. A "refining" state while a card re-solves, and an "updated" mark when the solver's move differs from the engine's. | §1 Runtime, §3 Cards, Phase 3, Phase 4 checks |
| 2 | Robustness as re-scoring of the solver's pick, its two alternatives, the engine's best move and rolling under the 30 noisy inputs, labelled honestly. A Phase 4 bucket check; until it passes, no robustness % shown as confidence. If it fails, 10 background re-solves per mode. | §1 Robustness, §3 Cards, Phase 4 checks |
| 3 | Hit margin 0 in Phase 3; Phase 4 runs margin 0 and margin 2 on the same backtest and reports both; a config value per mode; the default picked on 2024-25, with 2025-26 reported as held out. | §2, Phase 3, Phase 4 checks |
| 4 | Ceiling's card keeps the engine's move in a big week; every card and log entry records which engine produced its move. | §2, §3, §4 Decision log |
| 5 | The tail applies only when t\* has a double involving a squad player or one of Ceiling's candidate replacements, or Bench Boost or Triple Captain is planned for t\*. | Phase 2 |
| 6 | The WebAssembly file self-hosted, version and checksum pinned, licence included, loaded only when the Planner opens, CSP checked. | §1 Shipping |
| 7 | The exact free-transfer count first, with a test that a hit cannot buy a free transfer, and no change to the reproduction for non-rising weights. | §2 Model work, Phase 3 |
| 8 | Locks, bans, Ceiling's protected players (never sold by Now, Long term, Future prep or Funds) and the Wildcard / Free Hit weights, each with a test. Selling a protected player is a bug. | §2 Constraints, Phase 3 |
| 9 | A decision log of every recommendation, kept with the snapshots and in the export. | §4 Decision log |
| 10 | Gain over rolling, robustness and alternatives shown only once computed for the move on the card; "calculating" until then; never a solver move beside an engine figure. | §3 Cards |

**Confirmed:**
- Items 8 and 9 are covered (§2 Constraints, §4 Decision log), each with its
  own tests in Phase 3.
- The robustness bucket check and the margin-2 run are among Phase 4's pass
  checks (Phase 4 below).

## 1. Runtime

### Feasibility, as measured

- **The package.** npm `highs` 1.15.4 (MIT) is HiGHS 1.15.1 compiled to
  WebAssembly. It ships:
  - `highs.js` (168 KB) and `highs.mjs` (an ES module, so a module worker can
    import it);
  - `highs.wasm`: 3.5 MB, 1.2 MB gzipped.
- **The problems.** 48 real ones from 2025-26, taken as each week stood
  before its deadline.
  - **Weeks:** GW8, 16, 24 and 32.
  - **Squads:** each week's most-owned template, and GW4's template held
    unchanged.
  - **Settings:** all six mode settings.
  - **Solver input:** 2 free transfers; a pool of about 125 players.
  - **Tolerance:** half a point.
  - **Machine:** this container, 4 cores.

| Runtime | Median solve | 90th percentile | Slowest | Over 3 s (of 48) |
|---|---|---|---|---|
| WebAssembly in Node | 2.2 s | 8.9 s | 15.8 s | 12 |
| WebAssembly in Chromium (headless) | 2.3 s | 8.9 s | 15.6 s | 13 |
| Native HiGHS, 1 thread | 2.2 s | 7.0 s | 20.5 s | 11 |
| Native HiGHS, 4 threads | 1.8 s | 7.2 s | 22.5 s | 10 |

By mode (WebAssembly in Node), median and slowest:
- Now: 0.07 s, 0.5 s.
- Long term: 1.7 s, 5.8 s.
- Future prep: 2.7 s, 11.8 s.
- Funds: 3.2 s, 15.8 s.
- Ceiling: 2.6 s, 3.0 s.
- Structure: 4.4 s, 14.8 s.

What the numbers show:
- **Native code is not faster.** The time is the problem itself.
- **The 3 s cap costs little.** 46 of 48 solves capped at 3 s chose the same
  first week as at 30 s; the other two lost 1.6 and 2.1 points of objective.
- **A full six-card refresh**, capped:
  - 1 worker: 13.3 s, 394 MB.
  - 3 workers: 6.0 s, 694 MB.
  - 6 workers: 3.1 s, 1,010 MB.

  Each extra solver instance costs about 100-150 MB.
- **Load and compile.** WebAssembly compiles in 59 ms.

### Decided: WebAssembly in the browser (your item 1)

- **Workers.** The pool is `min(3, navigator.hardwareConcurrency − 1)`, at
  least 1.
  - On a phone (a coarse pointer and a narrow screen, or under 4 logical
    cores, or `navigator.deviceMemory` under 4 GB) it is 1 worker.
  - Phones solve the card you have selected first. Each other card solves
    when you open it, not all six at once.
- **The cap.** Each solve stops at 3 s (`time_limit`) or within half a point
  of its bound (`mip_abs_gap`).
- **Before the solver answers.** The cards paint at once with the engine's
  move.
- **While a card is being solved or re-solved,** after a lock, ban, bank or
  free-transfer change, it shows a "refining" state.
- **When the solver lands:**
  - If its move matches the engine's, the card stays as it is.
  - If it differs, the card switches to the solver's move and carries an
    "updated" mark naming what changed. A recommendation never changes
    silently.
- **A solve with no plan inside the cap,** or one that fails, leaves the
  engine's move on the card, marked as the engine's.
- **Browser and phone tests** before Phase 4 ends: Safari, Firefox and one
  phone, the same problems timed in each, reported in Phase 4.

### Robustness, first version (your item 2)

- **What is scored.** For each mode, the candidate first weeks are:
  - the solver's pick;
  - its two alternatives;
  - the engine's best move;
  - rolling.
- **How.** Each of the existing 30 noisy copies of the input (`noisyInput`)
  scores every candidate with the engine's V over the mode's window, less its
  transfers' cost. The figure is the share of copies in which the solver's
  pick scores best.
- **The label,** in the UI and in code: it measures how often the pick beats
  these alternatives under noise, not how often a fresh solve would choose
  it. The code calls it `pickBeatsAlternatives`; the card's words come with
  Phase 3's UI.
- **Until Phase 4's bucket check passes,** the card does not show it as a
  confidence number. It is computed, logged and backtested, and stays off
  the card (`solver.showRobustness: false`).
- **If the check fails,** it switches to 10 background re-solves per mode
  (1 s cap), and the check runs again.

### Shipping the WebAssembly file (your item 6)

- **Where.** `assets/vendor/highs/1.15.4/highs.mjs` and `highs.wasm`, plus
  `LICENSE` (HiGHS and highs-js, both MIT) and a `README` naming the source
  package and version.
- **The checksum.** The SHA-256 of each file is pinned in
  `DECISION_ENGINE.solver.vendor`.
  - The worker fetches `highs.wasm` with `fetch(url, { integrity })` and
    hands the bytes to the loader (`wasmBinary`), so a changed file fails
    to load. The engine then stays on the single-move engine.
  - A test checks the shipped files against the pinned hashes.
- **Loaded only when the Planner opens:** the worker is created on first
  use.
- **CSP:** none is set today, by `vercel.json` here or by the main site's
  (checked, read only), so nothing needs to change. If a policy is ever
  added, its `script-src` needs `'wasm-unsafe-eval'`. This is noted in
  `ARCHITECTURE.md`.

## 2. Each mode as a solver setting

Weights are over the next five GWs, planning week first. A mode's horizon
ends at its last non-zero weight.

| Mode | Weights (after the scale fix) | Its own rule, as the solver holds it |
|---|---|---|
| Now | [1] | A buy flagged out, or with pZero above `pZeroGate` (0.25) this week, is not in the pool. "Wait for team news" stays the engine's flag, applied to the solver's move. |
| Long term | [1, 1, 1] | Its gate (DeltaEV must beat the transfer's cost) is what the solver's objective does anyway. |
| Future prep | [0.5, 0.75, 1, 1, 1] | "Wait": no move this week and one next week shows WAIT with next week's move, tentative. |
| Funds | 0.85^k | Bank value: λ per £1m left in the bank at the horizon's end. |
| Ceiling | 1 at t\*, 0.1 elsewhere | Expected points (Phase 2's default). In a big week, when the tail applies (Phase 2's trigger), the card keeps the engine's tail-scored move, recorded as such (your item 4). |
| Structure | [1, 0.85, 0.72, 0.61, 0.52] | A dead-slot player kept costs `deadSlotPenalty` once. A player Structure holds cannot be sold in the first week. |

**Shared by all modes:**
- Planned Bench Boost or Triple Captain: the bench at full weight, or the
  armband three times, in that GW.
- The free-transfer value schedule at the horizon's end: each banked free
  transfer is worth 1.5 / 1.0 / 0.6 / 0.3.
- A hit's cost of 4.
- A per-mode hit margin `solver.modes.<id>.hitMargin` (your item 3):
  - 0 in Phase 3;
  - Phase 4 runs 0 and 2;
  - the default is chosen on 2024-25.
- Selling prices from the ledger.

### Constraints (your item 8), each with a test in Phase 3

- **Locked players** are never sold. Their sale variables are fixed to 0 in
  the first week; a lock is this week's.
- **Banned players** are never bought: they are left out of the pool.
- **Ceiling's protected players** (lock value ≥ `lockThreshold`, 3) are
  never sold in the first week by Now, Long term, Future prep or Funds.
  - The decoder checks every plan: a protected sale in those modes throws.
  - That is a bug, not a recommendation.
- **Free Hit and Wildcard:**
  - A planned Free Hit GW has weight 0.
  - Every GW from a planned Wildcard on has weight 0, and the horizon ends
    there.
  - This is the engine's existing rule (`masked`), taken from the engine,
    not restated.
- **Structure's holds** are never sold in the first week by Structure.

### Model work (your item 7), Phase 3, tests first

- **The exact free-transfer count, first.**
  - Today a hit can buy next week's free transfer whenever weights rise, so
    the model refuses rising weights. Future prep's and Ceiling's rise.
  - One binary a week, "every free transfer used", makes the count exact:
    unused = max(0, free − transfers), hits = transfers − free + unused, and
    next week's = min(5, unused + 1).
- **Its tests:**
  - With rising weights, a plan that takes a hit to bank an extra free
    transfer scores no better than one that does not.
  - On weights that do not rise, the objective and the first week are
    identical before and after the change. This is checked on the existing
    model tests and on the Phase 8 problems, so the reproduction does not
    move.
- **Then:**
  - the end-of-horizon terms (free-transfer value, bank value);
  - the constraints above, Now's pool filter and the dead-slot term;
  - the sell-price term on first-week sales.

## 3. Solver output onto the cards (your items 1, 2, 4, 10)

| Card field | From |
|---|---|
| `call` | `move` if the first week has moves; `wait` if it has none and the second week does; `roll` otherwise |
| The move | The first week's sales and buys, paired and ordered by `orderMoves`. A card holds several moves with their hits: `moves[]`, with `root` kept as the first for the parts that read one. |
| `source` | New: `solver`, `engine` (no solver answer yet, or none inside the cap) or `engine-tail` (Ceiling in a big week). Shown on the card. |
| Gain over rolling | The solver's plan less its best plan with the first week fixed to no moves, on the mode's own objective. One more solve, in the background. |
| `perGw`, `deltaEv`, `why`, `minutesRisk`, `tags` | The engine, on the squad after the first week's moves |
| Robustness | Re-scoring, as above. Off the card until Phase 4's check passes. |
| `alternatives` | Re-solves with the chosen first week excluded, up to 2 within `alternativesWindow`: two more solves, in the background |
| Later weeks of the plan | Shown greyed as tentative |
| States | "Refining" while a solve runs. "Updated" when the solver's move replaced the engine's on this card. "Calculating" beside any figure (gain over rolling, robustness, alternatives) not yet computed for the move now on the card. |

**Rule (your item 10).** Every figure on a card is keyed to the move it was
computed for: its move-set key and the input's version. A figure whose key
does not match the move on the card is not shown, and "calculating" stands
in its place. So a solver move never sits beside a figure computed for the
engine's move, or for an older input.

Per refresh: the picks first (on a phone, the selected card only), then the
rolling plans and alternatives in the background.

## 4. Decision log (your item 9)

**Every recommendation** a card shows is logged, not only disagreements. One
entry per mode each time a card's move is settled (first solve, re-solve or
fallback):
- the GW and the time;
- the mode;
- `source`;
- the move set;
- the expected gain over rolling (or null while uncomputed, updated when it
  lands);
- the robustness figure (likewise);
- the engine's first move;
- whether the two agree.

**Where it lives.**
- It is kept with the snapshots in IndexedDB (`js/snapshots.js`), bounded
  like them.
- It is included in "Export snapshots".
- The backtest writes the same fields for every solver week.

## Phases

### Phase 1: the mode scale fix (in progress)

**Change.** Long term [1, 1, 1, 0, 0] (no ÷ 3) and Future prep
[0.5, 0.75, 1, 1, 1] (no ÷ 4.25). The free-transfer schedule, the hit cost
and the margin stay.

**The money terms (confirmed).**
- FundsTerm and PriceTerm are λ × £m × share. Share is a ratio of weights,
  unchanged by the scale.
- DeltaEV grows by the sum of the weights, so λ moves in step:
  - Long term 0.10 → 0.30;
  - Future prep 0.15 → 0.6375.
- Future prep's `deferralEpsilon`, in DeltaEV units, goes 0.1 → 0.425. Its
  later-score money term uses the same λ.
- Funds, Structure, Now and Ceiling are unchanged.
- `alternativesWindow` stays at 2 points.

**The backtest.**
- The old presets run as a variant, `averaged`, beside the new ones, both
  seasons, all 12 squads.
- **Pass:** no mode clearly worse than before (paired 95% interval not
  wholly below zero), one move a week and several.
- It reports transfers a season for each mode. The four other modes are
  unchanged by construction; their numbers are the same runs.
- The report's risk-8 section changes too. Its "totals" variants of Long
  term and Future prep are now the presets, so the old averaged presets take
  their place.

**Stop:** you review the numbers.

### Phase 2: cards and Ceiling's default

- **Ceiling defaults to expected points.** The tail applies only when either
  of these holds:
  - t\* has a double gameweek involving at least one player in the squad or
    one of Ceiling's candidate replacements: the players its tail would
    shortlist, each owned player's best replacements by expected points at
    t\*;
  - Bench Boost or Triple Captain is planned for t\*.

  Not merely because some club plays twice.
- **Tests cover each case:**
  - a double for a squad player;
  - a double for a shortlisted replacement;
  - a double only for clubs neither involves, where the tail is off;
  - each chip;
  - the default.
- **The 5-week figure on Now and Ceiling cards:** the move's squad gain
  summed over the next five GWs at full weight, less its transfers' cost,
  shown as "over 5 GWs: +x against rolling". Checked on a real squad in the
  browser.

**Stop:** you check the cards.

### Phase 3: solver integration

- **Order of work:**
  1. The model fix and its tests (§2).
  2. The constraints and their tests (§2).
  3. The problem builder from the engine's input.
  4. The worker with the pinned, checked WebAssembly file (§1).
  5. The card states and the figure-keying rule (§3).
  6. Robustness re-scoring (§1).
  7. The decision log (§4).
  8. The config switch.
- **Pass check.**
  - A solver policy set exactly as the offline planner was runs through the
    app's new modules on the same backtest squads: decay 0.85 over five GWs
    as a total, no end-of-horizon values, hits at 4, margin 0, the same
    pool.
  - I report the gap to `data/milp.json`'s planner in points a season, and
    explain any gap over 20. The 3 s cap against Phase 8's 10 s is the
    expected source of a small gap.
  - The disagreement log from that run comes with it.

**Stop:** you review the gap and the log.

### Phase 4: evaluation

Each mode's solver policy runs against the previous engine, roll+ and Long
term+, on 2025-26 alone and both seasons. The run is about 5,000 solves per
hit margin, roughly an hour each on four cores, and resumable.

**Pass checks**, each reported plainly whether met or not:
1. **The headline.** The solver policy beats the previous engine on 2025-26
   with its 95% interval above zero, and is not clearly worse than Long
   term. The offline planner scored +109 [+18, +199].
2. **The hit margin.**
   - The whole run at margin 0 and again at margin 2, both reported.
   - Each mode's default is chosen on 2024-25 alone.
   - 2025-26 is reported as held out for the chosen default.
3. **Robustness.**
   - The solver's recommended first moves are bucketed by robustness: high
     (67% or more), middle (34-66%), low (33% or less). If a bucket holds
     fewer than 30 moves, terciles are used instead, and I say so.
   - Each bucket's realised 5-week gain over rolling is reported, on both
     seasons.
   - **Pass:** the high bucket realises more than the low bucket, with the
     95% interval of the difference (paired by squad) not wholly below zero.
   - If it fails, it switches to 10 background re-solves per mode, and the
     check runs again.
   - Until it passes, robustness is not shown on the cards as a confidence
     number.
4. **Browsers.** Solve times in Safari, Firefox and one phone, on the same
   problems.

**Stop:** you decide whether to switch it on.

## Files

| Phase | Files |
|---|---|
| 1 | `js/config.js` (weights, λ, `deferralEpsilon`); `tests/engine/decision.test.js`; `tools/backtest/run.js` (the `averaged` variant in place of risk 8's totals for these two modes); `docs/decision-engine.md`, `FEATURE_ENGINE.md`, this plan, the backtest report |
| 2 | `js/engine/decision.js` (the tail trigger, the 5-week figure on Now and Ceiling moves); `js/config.js`; `js/modules/planner.js`; `css/planner.css`; tests |
| 3 | `js/engine/solver/model.js` (from `tools/milp/model.js`: the exact free-transfer count, end-of-horizon terms, constraints; numbers in config); `js/engine/solver/problem.js` (a mode's setting and the engine's input to a problem); `js/engine/solver/plan.js` (decode, the protected-sale check, `orderMoves`, card fields, robustness re-scoring); `js/engine/solver/worker.js` (module worker loading the pinned `highs.mjs` and `highs.wasm`); `assets/vendor/highs/1.15.4/`; `js/modules/planner.js`, `css/planner.css` (several moves a card, tentative weeks, refining / updated / calculating states, the source label); `js/snapshots.js` (the decision log, in the export); `js/config.js` (`solver`: enabled, workers, time limit, gap, pool, vendor hashes, showRobustness, each mode's settings and hit margin); `tools/backtest/` (the solver policy per mode through the app's modules; the reproduction check); tests; `ARCHITECTURE.md` (the CSP note) |
| 4 | `tools/backtest/run.js` (the evaluation stage, both margins, the robustness buckets); the report; this plan |
