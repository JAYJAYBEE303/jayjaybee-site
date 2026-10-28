# Solver-led decision engine: plan (Phase 0)

Date: 2026-10-22. Status: **approved with conditions** (your reply of
22 Oct, items 1-10, folded in below). Phases 1, 2 and 3 done; Phase 2 awaiting your check of the cards, Phase 3 your
review of the gap and the disagreement log. The solver ships off (`solver.enabled: false`) until you switch it on after Phase 4.
Source: "Gaffer IQ engine: recommended changes" (22 Oct 2026, Josh Bailey),
its Build scope, Mode scale fix, Solver feasibility check and Phases table.
Branch: `Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`; `main` is
not touched.

## What this pass builds

- **The solver picks the moves.** Each of the six modes becomes a setting of
  the multi-week planner built as Phase 8's referee (`tools/milp/model.js`, now
  `js/engine/solver/model.js`):
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
  - Before Phase 3 a hit could buy next week's free transfer whenever weights
    rise, so the model refused rising weights. Future prep's and Ceiling's rise.
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
- `call` (move, wait or roll) and `stopped` (the pick's solve stopped at its
  limit);
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

### Phase 1: the mode scale fix (done, approved)

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

**Phase 1 as built** (`js/config.js`, `tests/engine/decision.test.js`, `tools/backtest/run.js`; report
`docs/decision-engine-backtest.md`, "The weight units")

- **The config.** Long term [1, 1, 1, 0, 0], λ 0.30; Future prep [0.5, 0.75, 1, 1, 1], λ 0.6375, `deferralEpsilon` 0.425.
- **Tests.** Six tests moved to the new scale, with their arithmetic restated in totals (KeepValue 22.5, the money
  terms ×3). A new test pins every mode as a total and λ in step.
  - One test changed meaning: Future prep's "wait to turn a hit into a free transfer". With a gain of about 7
    points a week, waiting saved 4.5 points of hit and gave up about 7 points of this week. The averaged scale
    counted that week as 1.6, so the mode waited. In true totals it now moves at once, which is correct.
  - The test now covers both sides: a 2-point-a-week move waits, a 14-point one moves.
  - `npm test`: 512 of 517, the five `channel.test.js` baseline failures.
- **The backtest.**
  - The old presets ran as a variant, `averaged`, beside the new ones: both seasons, 12 squads, both schedules,
    `--merge` over `data/results.json` (51 minutes).
  - The variant reproduces the old presets week for week (24 of 24 squad-seasons, one move and several).
  - The four untouched modes, the roll baseline and the old engine are identical before and after.
- **After less before** (points a season, 95% intervals):

  | Mode | 2025-26 | Both seasons |
  |---|---|---|
  | Long term | +15.8 [-30.7, +62.4] | +22.7 [-20.1, +62.4] |
  | Future prep | -4.0 [-42.2, +25.1] | +3.3 [-19.5, +26.6] |
  | Long term+ | +0.8 [-49.8, +58.8] | -5.3 [-48.0, +41.4] |
  | Future prep+ | +5.3 [-32.8, +40.5] | -2.4 [-36.8, +28.4] |

  **Pass:** no interval is wholly below zero.
- **Transfers a season** (before → after; 2024-25, then 2025-26):
  - Long term: 32.1 → 33.6, 33.3 → 34.8.
  - Future prep: 31.0 → 31.0, 32.5 → 32.9.
  - Long term+: 32.2 → 37.1, 34.9 → 40.8.
  - Future prep+: 31.0 → 32.8, 33.4 → 36.1.
  - Now, Funds, Ceiling and Structure, one move and several, are unchanged by construction: 33.6 / 34.1, 39.6 /
    39.4, 34.8 / 35.0, 33.8 / 35.0; with several moves 35.0 / 37.8, 41.5 / 43.3, 37.4 / 40.3, 39.1 / 41.1.
- **Elsewhere in the report:**
  - Against the old engine, pooled, Long term is now +163.1 [+82.9, +247.3] (was +140.5) and Future prep +125.8
    [+44.6, +219.1] (was +122.4).
  - On roll's squads, Future prep's pick now realises 1.25 a week less than roll's [-2.81, +0.28], no longer
    clearly worse (it was -1.81 [-3.41, -0.30]). Long term's gap is -0.32 [-1.94, +1.34].
  - The tuning sweep and Long term's alternative ran before the fix, and the report says so.

### Phase 2: cards and Ceiling's default (done, awaiting your check)

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

**Phase 2 as built** (`js/engine/decision.js` `tailShortlist`, `bigWeek`, `overGws`; `js/modules/planner.js` the mode
card; tests in `tests/engine/decision.test.js`)

- **The trigger.**
  - `bigWeek` returns `benchboost` or `triplecaptain` when either is planned for t\*. Otherwise it returns `double`
    when a squad player, or a replacement the tail shortlists (`tailShortlist`, the same list the tail draws), plays
    twice at t\*; otherwise null.
  - Only then does `upperTail` run, and `tail.trigger` says why.
  - `modes.ceiling.tail` stays configured; the big week switches it on.
- **Tests.** One test covers six cases:
  - a squad player's double;
  - a shortlisted replacement's double;
  - a double only at an uninvolved club (tail off);
  - a banned player's double (tail off);
  - each chip;
  - the default.

  The five existing tail tests now run on a real big week. Four mutants were all caught: tail always on, squad
  only, chips ignored, bans not excluded.
- **The 5-GW figure.** Every move carries `overFiveGws: { points, gws }`: the swap's expected-points gain over the
  mode GWs the squad plays, at full weight, less its transfer's cost.
  - GWs a planned Free Hit or Wildcard covers, or past GW38, are left out and named. At GW36 it reads "Over
    GW36–38".
  - Tested with a plain week, a Wildcard and the season's end.
- **The card.**
  - Now's and Ceiling's move cards show "Over GW10–14: +x pts vs rolling" under the headline figure. It is a
    `p.mc__sum` with `pts()` in `b.num`, as the card's other figures are; no new CSS.
  - Ceiling's header reads "on its 90th percentile (a double GW / Bench Boost / Triple Captain)" or "on expected
    points".
  - `ui-consistency:adjusting`: one region, about 10 files and 14 searches with the checkers.
  - Checked by a separate agent after a calibration whose planted difference (raw `toFixed`, no `.num`) it found.
    One fix came of it: a fallback for an unknown trigger.
- **In the browser** (headless Chromium, 2025-26 as it stood before GW36, the most-owned squad, 1280 and 360 px):
  - Now: "+1.4 pts vs rolling", then "Over GW36–38: +0.4".
  - Ceiling: "Peak GW36 · on its 90th percentile (a double GW)", "+2.3", "Over GW36–38: −0.4". With Bench Boost
    planned there: "(Bench Boost)".
  - No horizontal scroll at either width.
  - The only console errors are files the main site serves (`back-to-jayjaybee`) and the harness's blocked FPL
    calls.
- **The backtest** (`--merge`, Ceiling one move and several, both seasons and schedules, 19 minutes):

  | Ceiling | 2024-25 before / after | 2025-26 before / after |
  |---|---|---|
  | One move a week, points | 2002.4 / 2060.8 | 1815.8 / 1866.2 |
  | One move a week, transfers | 34.8 / 33.7 | 35.0 / 34.6 |
  | Several a week, points | 2010.7 / 2045.3 | 1815.9 / 1886.8 |
  | Several a week, transfers | 37.4 / 35.8 | 40.3 / 38.3 |

  - Against the roll rule on 2025-26 it is now −56.8 [−134.9, +22.3], no longer clearly worse (was −107.2).
  - Both seasons pooled, against the old engine, +113.5 [+37.8, +200.7], now clearly better (was +59.2), so all six
    modes beat it there.
  - Same-squad picks: −0.61 a week against roll's [−2.17, +1.09], no longer clearly worse (was −2.72).
  - The tail itself, read in big weeks only, against Ceiling on the mean every week:
    - −16.5 [−43.9, +1.0] on 2025-26 and −15.7 [−38.1, +3.6] pooled, neither clear;
    - its squads' five best weeks −7.0 and −4.8, both worse.

    With no chips played here, the tail buys no upside even in big weeks.

### Phase 3: solver integration (done, awaiting your review)

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

**Phase 3 as built** (`js/engine/solver/`, `js/modules/planner-solver.js`, `js/modules/planner.js`, `js/snapshots.js`,
`js/engine/decision.js`, `js/config.js` `solver`, `assets/vendor/highs/1.15.4/`, `tools/backtest/solver.js`; tests in
`tests/engine/solver/`, `tests/modules/` and `tests/tools/`; report `docs/decision-engine-backtest.md`, "The app's solver
against the offline planner"; reference `docs/decision-engine.md`, "The solver")

- **The switch.** `DECISION_ENGINE.solver.enabled` ships `false`: the single-move engine advises, nothing loads HiGHS,
  and the Planner's markup is byte for byte what it was (a snapshot test pins it). Every test of the solver path passes
  the config with `enabled: true` itself, so switching it on turns no test red.
- **The model** (`engine/solver/model.js`, moved from `tools/milp/model.js` with its test).
  - Free transfers are counted as FPL counts them: per week an integer count of those unused and a binary "every free
    transfer used", so a hit buys none and weights may rise from one week to the next. The rising-weights guard is gone.
  - On weights that do not rise it is Phase 8's model: of the 56 Phase 8 problems, 52 agree to 1e-6 at the backtest's
    tolerance (a gap of 0.5), the four long-horizon ones differing by 0.03 to 0.1 where the old and new builds stopped at
    different points inside that gap, and all 56 agree to 1e-11 solved to zero gap. A test pins the LP text of one of them
    by its digest.
  - It takes, each off unless given: the value of the free transfers and the bank at the horizon's end, a margin on every
    hit, players kept in the first week, Free Hit weeks with no transfers at all, dead slots, sale points, and first weeks
    to exclude (the alternatives). The terms per line of its text are `solver.lpLineTerms`, so the file holds no number.
- **A mode as a problem** (`engine/solver/problem.js`).
  - `modeSetting` reads everything from the engine's result: the weights as it masked them, cut at the mode's last
    weighted GW (so the horizon ends before a planned Wildcard); a Free Hit week frozen; the kept players from the
    engine's flags (locks, Ceiling's protected players in Now, Long term, Future prep and Funds, Structure's holds); bans;
    Now's `pZeroGate` as a test of who may be bought in the first GW; a planned Bench Boost or Triple Captain; the
    end-of-horizon free-transfer values (the engine's schedule, or its flat value); Structure's dead slots (the engine's
    own test, `isDeadSlot`); `solver.modes.<id>.hitMargin`, 0 for all six.
  - Money follows the engine. The bank at the horizon's end is worth the mode's own lambda per £1m (Now's and Ceiling's
    is 0), and the bank, the sale points for a likely price fall and the dead-slot penalty are scaled by the engine's
    `share`: the part of the mode's weight no planned chip covers. A Wildcard cuts its weeks from the horizon but not from
    the share.
  - Ceiling in a big week returns `engine-tail`: no solve, the engine's tail-scored move, recorded as the engine's.
  - `solverProblem` builds the owned 15 at the engine's sell prices and the pool: per position the `pool.points` (20) best
    others by weighted points and the `pool.pointsPerTenth` (10) best by weighted points a tenth among those the mode
    can buy, plus the buys the engine itself made in any mode. A setting flag, `engineBuys: false`, drops the last
    (the reproduction check uses it to hold Phase 8's pool).
- **A plan as moves and a card** (`engine/solver/plan.js`; `describePlan` and `moveSetKey` in `engine/decision.js`).
  - `orderMoves` pairs the first week's sales and buys into moves FPL takes one at a time, greedily by the legal pair that
    frees most money, on the engine's squad by `checkSwap`; moves with no legal order are left out and the week is called
    unordered. The backtest's `orderMoves` is an adapter onto it, so the app and the referee order alike.
  - `checkProtected` throws when a first week sells a player the mode must not sell. The runner then keeps the engine's
    card and logs the error.
  - `describePlan` is the engine's explanation of any move set: the mode's masked weights times the change the set makes
    to V in each GW, its five-GW figure, each move's minutes risk and tags, Now's wait-for-team-news flag, and the words.
    For one move its figures equal the engine's own for that swap.
  - A card's call is a move, a wait (no move now, one next week, shown tentative) or a roll. Its hits are counted from its
    moves by FPL's rule, never from the plan's own count.
  - A move set is keyed by its sorted sales and its sorted buys (`out,out>in,in`; one move is `out>in`), not by how they
    are paired: `orderMoves` and `pairMoves` can pair one squad change two ways, and a figure keyed to one pairing never
    landed on the other. `solverCard` throws on what it cannot render: no `positionOf`, a `describe` for other moves, a
    move or wait with no legal order.
- **HiGHS** (`assets/vendor/highs/1.15.4/`, `engine/solver/highs.js`, `engine/solver/worker.js`).
  - The npm `highs` 1.15.4 build (HiGHS 1.15.1) byte for byte, with its MIT licence and a README on how to update. The
    SHA-256 of `highs.mjs` and `highs.wasm` is pinned in `solver.vendor`; `vendor.test.js` checks the shipped files.
  - The module worker fetches `highs.wasm` with the hash as the fetch's `integrity`, so a changed file is refused, and
    loads HiGHS from the bytes. An init with no readable hash fetches nothing, a failed init does not replace a runtime
    already loaded, and every failure is an `ok: false` answer, never a throw.
  - `tools/milp/package.json` and its lockfile are gone: the solved model tests and the backtest load the vendored build
    through the same loader and no longer skip. `package.json` `engines.node` is `>=22` (the quoted test glob needs 21).
  - `vercel.json` serves the versioned folder with `Cache-Control: public, max-age=31536000, immutable`, so the 3.5 MB wasm
    is not revalidated at every worker start; a new HiGHS version goes in a new folder and its own header.
- **The runner** (`modules/planner-solver.js`; the Planner hands it every engine run).
  - **Workers.** A pool of module workers made on the first solve, `min(workers, cores - 1)` and at least one. A phone
    gets one, and solves only the cards that came into view, in the order viewed. A queue runs every pick and every rolling
    twin before any follow-up (alternatives, robustness), so a card's move never waits on another card's figures.
  - **Limits.** Each solve stops at `timeLimitS` (3) or within `absGap` (0.5) of its bound. The page gives up on a worker
    `timeoutMarginS` (2) seconds after that limit, since a solve cannot be interrupted: that worker is ended and replaced.
    A worker that has not loaded HiGHS in `initTimeoutS` (20) turns the solver off for the session.
  - **Stale answers.** Each run carries the input's version. A newer refresh, or `stop()`, drops what the older run queued,
    and an answer for an older run is ignored. The runner owns its robustness worker and ends a re-score still running for
    a card that is gone.
  - **Falling back.** No plan inside the cap, an error, a stuck or failed worker, a protected sale, a pick with no legal
    order, or no `Worker` (Node, old browsers): the card keeps the engine's move, marked as the engine's, and nothing
    throws into the page.
- **The cards** (`modules/planner.js`, `css/planner.css`: three lines).
  - A card paints the engine's move at once, marked Refining; when the solver lands it is repainted in place. It carries a
    source tag (Solver plan, Engine move, Engine move · upper tail), several moves with their transfers line, the later
    weeks as a tentative plan, and an "Updated" note naming the engine's move it replaced when the two differ.
  - The engine's recommendation is its whole move set (its root and, for Funds, the second move the root pays for), both
    when the runner compares it and when it logs it.
  - The gain over rolling, the alternatives and the robustness each land keyed to the card's move set and input. One whose
    key is not the card's is dropped, and the skeleton with "Still calculating" stands in its place. A pick that can only be
    had in part, one move at a time, is never shown beside figures computed for the whole plan.
  - With the solver on, no robustness shows on any card (`solver.showRobustness: false`), the engine's own included.
- **Robustness** (`engine/solver/rescore.js`). `pickBeatsAlternatives` re-scores the pick, its alternatives, the engine's
  move and rolling on each of the engine's 30 seeded noisy copies of its input (the mode's weights times the squad value
  after the moves, less the hits, plus the free transfers left banked) and answers the share of copies in which the pick is
  best. It is what the pick beats, not how often a fresh solve would choose it. The robustness worker takes it as a second
  message kind (`{ kind: 'rescore' }`); the existing message is unchanged. It is logged, not shown.
- **The decision log** (`js/snapshots.js`).
  - The snapshot database is at version 2 with a `decisions` store keyed by gameweek, mode, call, move set and source. A repeat of
    a key updates the gain, robustness, time and what the engine would have done in place (an entry describes one run); a
    new key adds an entry, and the oldest go past `solver.logMax` (5000).
  - `exportSnapshots` carries `decisions`. The Planner writes each settled card, off the render path, and counts it in the
    "Nothing archived" check. An upgrade blocked by an older tab answers with the keep-nothing store and one warning.
- **The backtest** (`tools/backtest/solver.js`, `run.js --solver-repro`).
  - `solverPolicy` runs the app's own path - the engine's result, `solverProblem`, HiGHS through `solveProblem`,
    `orderMoves` - set as Phase 8's planner was (`REPRO`): decay 0.85 over five GWs as a total, cut at the season's end,
    no end-of-horizon values, hits at 4, no margin, no kept players, dead slots, sale points or chips, Phase 8's pool. Its
    time limit and tolerance are the app's, read from the config. No plan, or no legal order, makes no move that week.
  - It plays the same 24 squads as `--milp`, resumable, into `data/solver-repro.json`, and each mode's engine move is logged
    beside the solver's first week. `engineInput` moved from `run.js` to `lib.js`, since importing `run.js` runs the CLI.
- **Tests.** `npm test`: 692, of which 687 pass, 173 more than the 519 before this phase. The 5 failures are the baseline
  ones in `tests/engine/channel.test.js`, red before this branch existed:
  - `buildChannelProfile no longer nulls a thin profile - it scales it`;
  - `buildChannelProfile reports maturity 1 at or above the full-evidence bar`;
  - `buildChannelProfile scores a thin profile instead of nulling it`;
  - `buildChannelProfile clamps maturity to 1, never above`;
  - `buildChannelProfilesByTeamId keeps thin profiles now that they score`.

  The tests of the solver path cover each Review Focus risk: a figure beside another move's, a protected or locked sale, a
  zero-weight week bought for nothing, a solver that fails or is slow, and a stale answer after a quick sequence of changes.
  `js/engine/solver/*.js` and the new code in `engine/decision.js` and `engine/robustness-worker.js` hold no number but 0
  and 1: the grep for them finds none outside comments.

**The reproduction** (`--solver-repro`: 12 squads in each season, the schedule as it stood).
- **The gap**, the app's solver less Phase 8's planner, points a season (95% intervals):

  | Season | Planner | App's solver | Gap |
  |---|---|---|---|
  | 2024-25 | 2161.0 | 2119.8 | -41.3 [-111.0, +24.6] |
  | 2025-26 | 1968.3 | 1950.3 | -17.9 [-71.9, +37.2] |
  | Both | 2064.6 | 2035.0 | -29.6 [-72.0, +13.5] |

  No interval excludes zero. The gap is over 20 in 2024-25 and over both seasons, so it is explained below.
- **The solves:** 840, 2.5 s each; 532 stopped at the 3 s limit (the run's workers shared four cores, so each had less than 3
  s of CPU); 10 found no plan (8 in 2024-25, 2 in 2025-26); in 2 weeks some of the plan's moves had no legal order.
- **The disagreement log.** The solver's first week is the same sales and buys as each mode's move in 22% of weeks for Now,
  33% Long term, 23% Future prep, 19% Funds & flexibility, 25% Ceiling and 31% Structure fix (840 weeks each; a mode's move
  is its root and, for Funds, the second move the root pays for). The report lists the first five weeks each mode differs.
- **The gap is the 3 s limit, not the model.** On the two 2024-25 squads with the widest gaps (random 8, -162; random 9, -106),
  run alone with nothing else on the machine, the app's path at 10 s gives the planner's objective and first-week moves in
  all 70 weeks. At 3 s, 47 of those 70 solves stop at the limit: 31 within the 0.5-point tolerance, 15 short of it by 34
  horizon points on average (at most 116), and one with no plan. A short plan can be a poor one: random 8's 3 s plan at GW32
  makes 12 moves for 2 and loses 92 points that week, which is most of its 162. Season totals also follow their path: a
  first week tied inside the tolerance sends a squad's season elsewhere, so one squad's difference carries about 100 points
  of run-to-run noise (random 9: the planner 2197 in its loaded run and 2072 alone; the app at 3 s 1918, 2072 and 2091 on
  three runs). The full run's workers shared four cores, so its 3 s solves had less than 3 s of CPU each, and 532 of 840
  stopped.
- **Left for Phase 4, not built.** A 3 s solve that stops with a poor incumbent is shown as the solver's move: your
  condition 1 covers only "no plan". A candidate guard is to treat a stopped solve whose incumbent is more than the tolerance short of
  its bound as no plan, and/or to re-solve longer in the background. Phase 4's margin runs should use the app's 3 s cap,
  measured on a quiet machine.

**In the browser** (headless Chromium, 4 cores, a scratch copy of the app with the switch on):
- HiGHS initialises in about 100 ms.
- At 1280 px, all six picks land in 1.4-1.5 s and all the figures (gain, alternatives, robustness) in 2.9-3.4 s.
- At 360 px, one worker: the picks in 1.7-2.3 s and the figures in 5.2-6.0 s.
- Safari, Firefox and a phone are Phase 4's checks.

**Decisions this phase settled** (the plan left them open):
- A move set is keyed by its sales and buys, not their pairing (`out,out>in,in`).
- The money terms follow the engine's share, and the bank is worth each mode's lambda.
- `engineBuys` lets a setting drop the engine's buys from the pool; the reproduction uses it.
- The page waits `timeoutMarginS` (2) past the solve limit, and `initTimeoutS` (20) for HiGHS to load.
- `solverCard` throws on what it cannot render, and the runner then keeps the engine's card.
- The runner owns its rescore worker, and ends one still running for a card that is gone.
- With the solver on, no robustness shows on any card, the engine's included, until Phase 4's check passes.

**After the whole-branch review** (rulings R44-R47):
- **R44, hits cost the same in every week.** The model's `flatHits` prices a hit at `hitCost` plus the margin whatever its week
  weighs, as the engine's `transferCost` does; on for every app mode, off in the reproduction, so its LP is unchanged. Before it,
  Ceiling's 0.1-weight weeks made a hit cost 0.4 and the plan bought two players on one free transfer.
- **R45, a move must beat rolling.** A pick that moves settles its card only once its rolling solve has landed (Refining until
  then, the gain landing with the card). A gain over rolling not above `absGap` makes the card a roll (source `solver`, the
  plan's later weeks kept, logged as a roll), where the solver had moved for money alone or for nothing the engine rolled on;
  if the rolling solve fails the mode keeps the engine's card. A wait is its own rolling twin and needs no second solve.
- **R46, a wait cannot sell a kept player.** `checkProtected` also runs on a wait card's own move week (week 1); on a throw the
  card is a roll that keeps the weeks after the wait as its tentative list, warned and not an error (the lock is the first
  week's by spec, so this is not a model bug). A locked player is no longer offered for sale as "Wait ... Sell".
- **R47, the log tells a wait from a move.** An entry carries `call` and `stopped` (the pick's solve stopped at its limit; false
  for an engine card), the key is `gw|mode|call|moveSetKey|source`, and an engine card logs its root's `outScore` as the gain
  (null for an engine roll). The dispatch carries `stopped` from the worker's answer to the card, as a field that is not shown.
- **R48, small fixes.** A solver wait shows none of the engine's scores, and the Updated note says so when the engine would have
  waited for this very move. The report generator carries no findings (they are in this section), this section states the
  Phase 8 agreement as measured, and the decision log notes that an older tab blocking the IndexedDB upgrade leaves that visit
  with no snapshots, no log and the Planner on season totals.

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
