# Solver guard and evaluation (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A solve that stops at 3 s with a plan short of its proven bound is not shown (the engine's move stays while a longer solve runs), and every mode's solver policy, guard included, is measured against the previous engine on the backtest, at hit margins 0 and 2, with the robustness check and the browser timings, so the user can decide whether to switch the solver on.

**Architecture:** `solveProblem` moves to HiGHS's `Model` API so each solve also returns its proven bound; `trusted()` and `settlePick()` in `js/engine/solver/plan.js` hold the guard and the settle rules (rolling tie, a wait's kept players) that the runner and the backtest both call. A per-mode solver policy in `tools/backtest/solver.js` runs those same modules; a `--solver-eval` stage writes one data file per margin and the report gains the Phase 4 sections. Browser timings come from a benchmark page the user opens on Safari, Firefox and a phone.

**Tech Stack:** Vanilla ES modules, `node --test`, HiGHS 1.15.4 WebAssembly (its `Model` API: `createModel`, `run`, `info.get('mip_dual_bound')`, `getSolution`, `getColName`), the existing backtest (`tools/backtest/`).

**Spec:** `docs/decision-engine-solver-plan.md` ("Phase 4: evaluation", §1 Robustness, §2 hit margin) and the user's approval at the Phase 3 stop: "approved, build the guard and go ahead with Phase 4", the guard being the coordinator's recommendation: *treat a solve that stopped more than the tolerance short of its best possible score as "no plan", so the card keeps the engine's move; a longer background re-solve can then replace it.*

## Global Constraints

- Work only inside `projects/apps/gaffer-iq/`. Branch `Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`. Never touch `main`, never merge, never open a PR, **never push** (the coordinator verifies and pushes).
- Commit locally after each task, normal prose message ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017PEphFCHRZTojCpp5Dq72E
  ```
- No model identifiers in anything committed.
- `js/engine/solver/*` and new code in `js/engine/*` hold no numeric literals but 0 and 1 (numbers are `DECISION_ENGINE` keys).
- Engine files stay pure; workers, fetch and IndexedDB stay where they are.
- `DECISION_ENGINE.solver.enabled` stays **false** (the user decides after this phase). Solver tests pass their config explicitly.
- Test command: `cd projects/apps/gaffer-iq && npm test`. Baseline at 2bd096f: 692 tests, 686 pass; the 5 `tests/engine/channel.test.js` failures pre-date the branch, and `tests/engine/decision.test.js`'s "600-player pool ... under 200 ms" wall-clock test fails under parallel load (passes alone). Every other test stays green.
- Never edit source while a backtest run is going; never start a full `--solver-eval` or `--solver-repro` run (the coordinator owns them). `--quick` runs are fine.
- The reproduction (`--solver-repro`, `reproFor`) must keep producing the same LP and the same decisions: it runs without the guard and without the settle rules, as Phase 8's planner did.

## Review Focus

1. **The guard hides good plans or shows bad ones.** A 3 s plan proven within `absGap` of its bound is shown at once; one more than `absGap` short is never shown, and the engine's move stays (marked "Engine move") until a longer solve proves a plan within `absGap`. Task 1 and Task 2 tests.
2. **The backtest and the app decide differently.** For the same input and the same solve answers, the backtest's per-mode policy makes exactly the moves the runner's settled card shows. Task 3's parity test.
3. **A long re-solve leaves a card stuck.** A re-solve that times out, fails or is superseded by a newer input ends on the engine's card, never on Refining. Task 2 tests.
4. **Robustness figures computed for one move set landing on another.** The keying rule still holds with the guard's extra solve in between. Task 2 test.
5. **A number in the report that the run did not compute.** Every figure in the Phase 4 sections comes from the data files; no hard-coded findings in the generator. Task 4 review.

---

### Task 1: Every solve reports its proven bound

**Files:**
- Modify: `js/engine/solver/highs.js` (`solveProblem`), `js/engine/solver/worker.js` (pass the new fields through)
- Test: `tests/engine/solver/vendor.test.js` or a new `tests/engine/solver/highs.test.js`, `tests/engine/solver/worker.test.js`

**Interfaces:**
- Produces: `solveProblem(highs, problem, options) -> { plan: object|null, stopped: boolean, ms: number, bound: number|null, gap: number|null }`. `bound` is HiGHS's `mip_dual_bound` (the model maximises, so the best any plan could score); `gap = bound − plan.objective` in points (null with no plan). Status handling as today (Optimal / time limit usable, Infeasible → no plan, anything else throws). Uses `highs.createModel({ format: 'lp', data: lp })`, `model.options.set({ ...SOLVE_DEFAULTS, ...options })`, `model.run()`, the model status from `run()`'s `modelStatus` (map codes with `highs.constants`), `model.info.get('objective_function_value')`, `model.info.get('mip_dual_bound')`, and a `{ ObjectiveValue, Columns: { [getColName(i)]: { Primal: colValue[i] } } }` object built from `getSolution()` so `decode` is unchanged. The model is always disposed (`try/finally`).
- Worker `solve` answer gains `bound` and `gap`.

- [ ] **Step 1: Failing tests:** `the Model API path decodes the same plan and objective as the legacy solve` (every solved problem in `tests/engine/solver/model.test.js`'s helpers, or a representative five: assert equal `objective` within 1e-9 and equal week-0 `in`/`out`); `a stopped solve reports its bound and gap` (a feasibility-size problem from `problem.test.js`'s 600-candidate case or the scratchpad's `feas/lp/gw8-template-structure.lp` loaded as LP text through a test-only path: at `time_limit` 1, `stopped`, `bound` finite, `gap > 0`); `an optimal solve's gap is within the tolerance`; `the model is disposed even when decode throws` (a fake highs whose model counts dispose calls).
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS; `npm test`; the Task 2 (Phase 3) LP sha256 test unchanged and green. Commit** "Solver: every solve reports its proven bound".

### Task 2: The guard, and one settle rule for the runner and the backtest

**Files:**
- Modify: `js/engine/solver/plan.js` (`trusted`, `settlePick`), `js/modules/planner-solver.js` (pickFlow uses them; the re-solve), `js/config.js` (`solver.resolveTimeLimitS: 10`), `js/engine/solver/rescore.js` (hits cost `hitCost + hitMargin`, ruling R29), `docs/decision-engine.md` (the guard; the parked "no second solve" wording: a wait or roll pick's rolling twin still runs in the background, the card just does not wait for it)
- Test: `tests/engine/solver/plan.test.js`, `tests/modules/planner-solver.test.js`, `tests/engine/solver/rescore.test.js`

**Interfaces:**
- Consumes: Task 1's `{ plan, stopped, bound, gap }`.
- Produces:
  - `trusted(answer, config) -> boolean`: `answer.plan !== null && (!answer.stopped || answer.gap <= config.solver.absGap)`.
  - `settlePick({ modeId, plan, rolling, result, input, config }) -> { call: 'move'|'wait'|'roll', moves: Array<{outId, inId}>, rolled: string|null }` — the settle rules now inside `pickFlow`, moved here unchanged in behaviour: the first week ordered by `orderMoves` (unordered → throws, the caller keeps the engine's card); `checkProtected` on week 0, and on week 1 for a wait (a throw on week 1 → `call: 'roll'`, `rolled: 'kept'`); a move whose `gainOverRolling(plan, rolling)` is not above `absGap` → `call: 'roll'`, `rolled: 'tie'`. `rolling` is null for a wait or roll pick (its first week already is rolling).
  - Runner: a pick that is not `trusted` keeps the engine's card in its Refining state and queues one re-solve of the same problem at `resolveTimeLimitS` (a tier after every first pick, before the background figures; its page timeout `resolveTimeLimitS + timeoutMarginS`). A trusted re-solve continues exactly as a trusted pick (its rolling twin solved at the same limit); an untrusted or failed one, or a timeout, settles the engine's card. A superseded run asks for nothing more (as today). The log entry gains `guard: 'trusted'|'resolved'|'engine'` and `gap` (the shown plan's, null for engine).
- [ ] **Step 1: Failing tests:** `trusted: optimal, stopped within absGap, stopped short, no plan`; `settlePick reproduces today's pickFlow decisions` (port the R45/R46 runner cases to direct calls: tie → roll, kept sale in a wait's week 1 → roll, unordered → throws); runner: `a pick short of its bound keeps the engine's card refining, then shows the longer solve's move` (fake worker: first answer `stopped, gap 5`, re-solve `optimal`); `a re-solve still short, failing or timing out ends on the engine's card, not refining` (Review Focus 3); `a re-solve answer for a superseded input is ignored`; `figures land only on the shown move after a re-solve` (Review Focus 4); `the log says trusted, resolved or engine`; rescore: `a hit costs hitCost plus the mode's hitMargin`.
- [ ] **Step 2: FAIL. Step 3: Implement** (pickFlow calls `trusted` and `settlePick`; no new card copy: the existing Refining tag and "Engine move" tag carry the states). **Step 4: PASS; `npm test`; the numeric-literal grep on `js/engine/solver/*.js`. Commit** "Solver: a plan short of its bound waits for a longer solve".

### Task 3: Each mode's solver policy in the backtest, as the app decides

**Files:**
- Modify: `tools/backtest/solver.js` (`modePolicy`), `tools/backtest/run.js` (`--solver-eval` stage), `tools/backtest/lib.js` if a shared helper is needed
- Test: `tests/tools/backtest-solver.test.js`

**Interfaces:**
- Consumes: `runDecisionEngine`, `modeSetting`, `solverProblem`, `solveProblem`, `trusted`, `settlePick`, `rollingProblem`, `alternativesOf`, `pickBeatsAlternatives`, `engineInput` (lib.js).
- Produces:
  - `modePolicy(highs, { modeId, hitMargin, config, robustnessEvery })` → `{ counts, log, decide({ t, state, world, locks, bans }) -> { moves } }`. Each week: the engine on `engineInput(...)`; `modeSetting` with the mode's `hitMargin` overriding config; `null` → no moves; `engine-tail` → the engine's own move for Ceiling (root plus chained); otherwise the pick at `timeLimitS` → `trusted`? else the re-solve at `resolveTimeLimitS` → `trusted`? else the engine's move (root plus chained; a wait or roll: none) → for a move, the rolling twin at the limit the shown plan used → `settlePick` → its moves (an unordered throw → the engine's move). Every `robustnessEvery`-th week (3), when the settled call is a move: `alternativesOf` and `pickBeatsAlternatives` over the pick, its alternatives, the engine's move and rolling → `robustness`. `counts`: solves, ms, stopped, resolved, engineFallback, ties, kept, unordered. `log` per week: `{ t, call, moves, source: 'solver'|'engine'|'engine-tail', guard, gap, gain, robustness }`.
  - Stage `--solver-eval --margin <0|2>`: the 24 asItStood tasks (both seasons, all squads), policies `solver:<mode>` for the six modes, writing `data/solver-eval-m<margin>.json`; resumable (`--resume`) like the others; `--quick` as the others.
- [ ] **Step 1: Failing tests** (on `decision-fixtures.js` worlds, as `backtest-solver.test.js` does): `a mode policy makes the runner's settled moves` — parity (Review Focus 2): for three scripted cases (trusted move, untrusted then resolved, tie → roll) the policy's moves equal the moves of the card `createSolverRunner` settles with a fake worker answering the same plans; `an untrusted pick and re-solve fall back to the engine's move`; `the mode's hit margin reaches the problem`; `robustness is computed every third week on a move, and logged`.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS; `npm test`; `node tools/backtest/run.js --solver-eval --margin 0 --quick` once (state its time). Commit** "Solver: each mode's policy in the backtest, as the app decides".

### Task 4: The Phase 4 report

**Files:**
- Modify: `tools/backtest/run.js` (report sections; `--report` reads `solver-eval-m0.json` and `solver-eval-m2.json` when present, paired with `results.json`'s `old`, `roll+`, `longterm`, `longterm+` on the same tasks)
- Test: `tests/tools/backtest-solver.test.js` (section helpers exported from `solver.js` or a new `tools/backtest/eval.js` so they can be tested without running the CLI)

**Interfaces:**
- Produces, as pure functions with tests, and their sections in `docs/decision-engine-backtest.md`:
  - **Headline** per mode at each margin: season totals and paired differences (`pairedBootstrap`, as the other sections) against the previous engine (`old`), `roll+`, `longterm` and `longterm+`, on 2025-26 and on both seasons; verdict lines in the report's usual form. Pass line per mode: beats `old` on 2025-26 with the interval above zero, and not clearly worse than `longterm`.
  - **Hit margin**: per mode, 2024-25 totals at margin 0 and 2 and the chosen default (the higher 2024-25 total; a tie → 0); 2025-26 reported for the chosen default as held out.
  - **Robustness buckets** (at margin 0): the solver's settled first moves with a robustness figure, bucketed high (≥ 0.67), middle (0.34–0.66), low (≤ 0.33); any bucket under 30 moves → terciles instead, and the section says so. Per bucket and season: moves, mean realised 5-week gain over rolling (the policy's own `moveMetrics` realised[5] less its hits). Pass: high's mean above low's, and the 95% interval of the difference (paired by squad, bootstrap) not wholly below zero.
  - **The guard and the transfers**: per mode, trusted / resolved / engine-fallback / tie / kept shares of weeks, stopped share, mean solve ms; transfers and hits a season per mode against the engine's single-move policy and `longterm+`.
- [ ] **Step 1: Failing tests** for each pure function on hand-built result objects (the bucket rule incl. the tercile fallback, the default-margin rule incl. a tie, the pass lines). **Step 2: FAIL. Step 3: Implement. Step 4: PASS; `--report` renders with fake data files built from the tests' fixtures (scratchpad), then is left for the coordinator's real run. Commit** "Solver: the Phase 4 report".

### Task 5 (coordinator): the runs, the defaults, the browser timings, the docs

Not dispatched to an implementer: the long runs, the artifact and the final decisions are the coordinator's.

- [ ] Run `--solver-eval --margin 0` then `--margin 2`, detached, `--resume` after any restart; then `--report`.
- [ ] Set `DECISION_ENGINE.solver.modes.<id>.hitMargin` to each mode's chosen default (an implementer commit, reviewed).
- [ ] If the robustness check fails: Task 6, then the check runs again. Robustness stays off the cards either way until a check passes.
- [ ] Browser timings: a benchmark page (an Artifact; HiGHS 1.15.4 from `cdn.jsdelivr.net/npm/highs@1.15.4`, a dozen of the feasibility problems embedded, results stored with the page's database capability) the user opens in Safari, Firefox and on a phone; the coordinator reads the stored results and reports them beside Chromium's.
- [ ] Docs: `docs/decision-engine-solver-plan.md` "Phase 4 as built" with every pass check reported plainly, met or not; `docs/decision-engine.md` (the guard, the defaults); whole-branch review of Phase 4 on the most capable model; squash and push; stop for the user's decision whether to switch the solver on.

### Task 6 (only if Task 5's robustness check fails): robustness by re-solving

**Files:** `js/engine/solver/rescore.js` (or a new `resolve-robustness.js`), `tools/backtest/solver.js`, `tests/engine/solver/*`, `tools/backtest/run.js` (the bucket section reads the new figure).

**Interfaces:** `resolveRobustness(input, result, modeId, config, solve) -> number` (0-1): the share of `robustnessResolves` (10, config) re-solves at `robustnessResolveTimeLimitS` (1, config), each on a seeded noisy copy of the input (`noisyInput`), whose first week has the same `moveSetKey` as the pick's. The runner computes it in the background in place of `pickBeatsAlternatives` (still logged, never shown); the backtest computes it every third week, as Task 3 does.

- [ ] Failing tests (a dominant pick scores 1; a pick that is a coin-flip against a near-equal alternative scores between; the same seed gives the same share), implement, pass, commit "Solver: robustness by re-solving". The coordinator re-runs margin 0 and the bucket check.
