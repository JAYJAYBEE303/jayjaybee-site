# Solver integration (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The six Planner modes get their moves from the multi-week MILP planner (HiGHS WebAssembly in module workers), the engine explains them, and the backtest shows the app's solver reproduces Phase 8's offline planner.

**Architecture:** Phase 8's model moves into the app (`js/engine/solver/model.js`) and gains the exact free-transfer count, end-of-horizon values and the constraints. `problem.js` turns the engine's input and result into a mode's problem; `plan.js` turns a solved plan into ordered moves and a card; `rescore.js` re-scores the pick under the engine's noise. A module-layer runner (`js/modules/planner-solver.js`) drives up to 3 workers; the cards paint the engine's move at once and switch to the solver's when it lands. Everything sits behind `DECISION_ENGINE.solver.enabled`.

**Tech Stack:** Vanilla ES modules, `node --test`, HiGHS 1.15.4 WebAssembly (npm `highs`, MIT), CPLEX LP format, IndexedDB.

**Spec:** `docs/decision-engine-solver-plan.md` (§1–§4 and "Phase 3: solver integration"). Read both. The UI checklist for the card is `/tmp/claude-0/-home-user-jayjaybee-site/96f531f4-6ce0-524e-85ca-87a916994f86/scratchpad/ui-checklist-mode-card-solver.md`.

## Global Constraints

- Work only inside `projects/apps/gaffer-iq/`. Branch `Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`. Never touch `main`, never merge, never open a PR, **never push** (the coordinator verifies and pushes).
- Commit locally after each task (normal prose message, trailer below). The coordinator squashes them into one Phase 3 commit before pushing.
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017PEphFCHRZTojCpp5Dq72E
  ```
- No model identifiers in anything committed.
- New engine files (`js/engine/solver/*`, and new code in `js/engine/*`) hold no numeric literals but 0 and 1: every number is a key of `DECISION_ENGINE` in `js/config.js` (or an existing config export such as `SQUAD_TOTAL`, `MAX_PER_CLUB`).
- Money is integer tenths everywhere; a sold player is valued at his sell price.
- Engine files stay pure (no DOM, no network). Workers, `fetch` and IndexedDB live in `js/modules/*`, `js/engine/solver/worker.js` and `js/snapshots.js` only.
- Comments, docs and commits in the codebase's own style: full sentences, British spelling, "MODEL:" for modelling calls.
- Never commit vaastav data (`tools/backtest/data/` is gitignored). Never enter a real FPL team ID. No network calls to FPL.
- Never edit source while a backtest run is in progress (it reads the live tree).
- Test command: `cd projects/apps/gaffer-iq && npm test`. Baseline before this phase: 519 tests, **514 pass, 5 fail** — all 5 in `tests/engine/channel.test.js`, failing before this branch existed (also red at commit 3aa8f3a). Leave them; report them by name; never skip or hide them. Every other test must stay green.
- Verify UI with the app served locally (`cd projects/apps/gaffer-iq && python3 -m http.server 8080`) and Playwright (Chromium is preinstalled; launch with `executablePath: '/opt/pw-browsers/chromium'` if the pinned version differs; the harness in `…/scratchpad/browser36/ui-p2.cjs` with its `bootstrap.json`/`fixtures.json`/`squad.json` serves FPL data offline — reuse it). The proxy and FPL are blocked from the container.
- `DECISION_ENGINE.solver.enabled` ships as **`false`** (the user switches it on after Phase 4). Every test of the solver path passes the config with `enabled: true` explicitly.

## Review Focus

1. **A solver move beside an engine figure.** A card whose move changed (solver lands, re-solve after a lock, ban, bank or FT change) must never show a gain, alternative or robustness computed for another move set or an older input. Task 7 pins it with the keying test.
2. **A protected or locked player sold.** Ceiling-protected players in Now, Long term, Future prep and Funds, locked players in every mode, and Structure's holds in Structure: never in the first week's sales. Task 2 (model fix), Task 3 (problem), Task 5 (decode throws).
3. **Free Hit / Wildcard weeks bought for nothing.** A zero-weight week must not let hits or moves through free of cost (a Free Hit week: no transfers, FT count unchanged; from a Wildcard: the horizon ends). Task 2 and Task 3 tests.
4. **The solver failing or slow.** No plan inside 3 s, a worker that fails to load, a checksum mismatch, `Worker` missing (Node, old browsers): the card keeps the engine's move marked "Engine move", nothing throws into the page. Task 4 and Task 7 tests.
5. **Stale results after a fast sequence of changes.** Lock, unlock, lock within a second: only the newest input's answers may paint. Task 7 test (results from an older input version are dropped).

---

### Task 1: The model moves into the app, with the exact free-transfer count

**Files:**
- Move: `tools/milp/model.js` → `js/engine/solver/model.js` (`git mv`, then edit)
- Move: `tests/tools/milp.test.js` → `tests/engine/solver/model.test.js`
- Modify: `tools/backtest/milp.js` (import path), `js/config.js` (`DECISION_ENGINE.solver.lpLineTerms: 8`)
- Scratch (not committed): a golden-comparison script under the scratchpad

**Interfaces:**
- Produces: `buildPlan(p) -> { lp: string, decode(result) -> { objective, weeks: [{ gw, in, out, hits, ft, xi, captain, bench, benchBoost, tripleCaptain }] } }` — same signature and decode shape as today, plus `p.lineTerms` (from `DECISION_ENGINE.solver.lpLineTerms`; the module itself holds no 8).

- [ ] **Step 1: Golden capture before any change.** In the scratchpad, write a script that builds the problems of every `solved(...)` test in `tests/tools/milp.test.js` **and** the non-rising-weight problems (now, longterm, funds, structure) of the feasibility harness (`…/scratchpad/feas/gen.mjs` builds them from the backtest world; adapt it to dump each problem object as JSON instead of LP text), solves each with today's `tools/milp/model.js` (HiGHS from `tools/milp/node_modules/highs/build/highs.js`, `mip_abs_gap` 0.5, `time_limit` 30), and stores `{ name, objective, first: { in, out } }` to `…/scratchpad/golden-model.json`.
- [ ] **Step 2: Move the files** (`git mv`) and fix imports; run `npm test`; expect the baseline (514/5).
- [ ] **Step 3: Write the failing tests** in `tests/engine/solver/model.test.js`:
  - `rising weights: taking a hit cannot buy next week's free transfer` — two weeks, weights `[0.5, 1]`, ft 1, one candidate MID 1 pt better each week than owned 8, a second MID candidate 1 pt better each week than owned 9; assert the solved plan's objective equals the best plan found with `fixed.first` = the moves the old exploit takes (a hit in week 0 plus a move in week 1) **or less**, and assert `decode(...).weeks[1].ft` equals FPL's rule `min(5, max(0, ft0 − transfers0) + 1)` and `hits` of week 0 equal `max(0, transfers0 − ft0) × 4`.
  - `rising weights are accepted` — replace the old "refused" test: `buildPlan` with `[0.5, 1]` returns an LP.
  - `next week's free transfers are exact: unused ones carry, to the cap` — ft 3, no move: `weeks[1].ft === 4`; ft 5, no move: `weeks[1].ft === 5`; ft 2, three moves: one hit and `weeks[1].ft === 1`.
- [ ] **Step 4: Run them; expect FAIL** (the exploit test, and "rising weights are accepted" with "weights must not rise").
- [ ] **Step 5: Implement the exact count in `buildPlan`.** Remove the rising-weights guard. Per week k, with `T_k = Σ i_{q,k}`, an integer `ft_k` (k ≥ 1; week 0 is `p.ft`), an integer `u_k ≥ 0` (unused) and a binary `all_k` ("every free transfer used"), with `M = SQUAD_TOTAL` (import from config):
  ```
  u_k ≥ ft_k − T_k            u_k ≤ ft_k − T_k + M·all_k            u_k ≤ M·(1 − all_k)
  h_k = T_k − ft_k + u_k      ft_{k+1} ≤ u_k + 1                    1 ≤ ft_{k+1} ≤ maxBankedFt
  ```
  Keep hits charged at the week's weight (`−w_k · hitCost · h_k`) as today. `ft_{k+1}` needs no lower row: more free transfers never cost the objective.
- [ ] **Step 6: Run the new tests and the whole file; expect PASS.**
- [ ] **Step 7: Golden comparison.** Re-run the Step 1 script against `js/engine/solver/model.js` (same HiGHS, same options). Expected: every objective equal within 1e-6; every first week identical, or, where not, the golden first week fixed (`fixed.first`) scores the same objective under the new model (a tie). Write the table to `…/scratchpad/golden-compare.md`; any objective that moved is a bug — stop and fix.
- [ ] **Step 8: `npm test`; expect baseline + the new tests. Commit** "Solver model moves into the app with the exact free-transfer count".

### Task 2: End-of-horizon values and the constraints in the model

**Files:**
- Modify: `js/engine/solver/model.js`
- Test: `tests/engine/solver/model.test.js`

**Interfaces:**
- Consumes: Task 1's `buildPlan`.
- Produces: new optional fields of `p` (all default to "off", so Phase 8's problems build the same LP):
  - `endFtValue: {[n: number]: number} | null` — the value of each banked free transfer at the horizon's end, the engine's `ftValueSchedule` (`{2: 1.5, 3: 1.0, 4: 0.6, 5: 0.3}`); the plan earns `Σ_{j=2..ft_H} endFtValue[j]`, where `ft_H` is the count carried into the week after the horizon (add `ft_H` and `u_{H−1}` for the last week). Concave, so continuous `0 ≤ e_j ≤ 1`, `Σ e_j = ft_H − 1`, objective `+ endFtValue[j] · e_j`, no binaries.
  - `bankPerTenth: number` — objective `+ bankPerTenth · bank_{H−1}`.
  - `hitMargin: number` — each hit costs `w_k · (hitCost + hitMargin)` in the objective; `decode` still reports `hits` at `hitCost` and `objective` as HiGHS returns it.
  - `keep: number[]` — owned ids whose week-0 sale is fixed to 0.
  - `frozen: number[]` — GWs of the horizon with no transfers at all (a planned Free Hit): `i = o = 0` that week, `h = 0`, and `ft_{k+1} = ft_k` (the ledger's rule, `js/engine/ledger.js`: a Free Hit week neither spends nor adds).
  - `deadSlot: { ids: number[], penalty: number } | null` — `−penalty · s_{id,0}` for each listed id (owned or candidate).
  - `salePoints: {[id: number]: number}` — objective `+ salePoints[id] · o_{id,0}` (the sell-price term).
  - `exclude: Array<{in: number[], out: number[]}>` — no-good cuts: each listed first week is infeasible. For a set (I, O): `Σ_{q∈I} i_{q,0} + Σ_{q∈O} o_{q,0} − Σ_{q∉I} i_{q,0} − Σ_{q∉O} o_{q,0} ≤ |I| + |O| − 1`. (The empty set (rolling) is excluded by `Σ all i_{q,0} ≥ 1`.)

- [ ] **Step 1: Write the failing tests** (one each, on the `squad()`/`problem()` helpers already in the file):
  - `the free transfers left at the horizon's end are worth the schedule` — one week, ft 1, a buy worth +1.2: with `endFtValue` the plan rolls (1.2 < 1.5); with +1.8 it moves; objective of the roll = squad points + 1.5.
  - `money left in the bank is worth bankPerTenth` — a downgrade losing 0.2 pts freeing £3.0m: rolls at `bankPerTenth` 0, makes it at 0.01 (3.0 × 10 × 0.01 = 0.3 > 0.2 + 0, with ft 5 so the move is free).
  - `a hit must also clear the margin` — a second move gaining 5: taken at margin 0, not at margin 2 with gain 5 < 4 + 2.
  - `a kept player is never sold in the first week` — owned 8 the clear sale; `keep: [8]` → week 0 `out` excludes 8.
  - `a Free Hit week has no transfers and leaves the free transfers as they were` — weights `[0, 1]`, frozen `[10]`, ft 2: `weeks[0].in` empty, `weeks[1].ft === 2`, and no hit anywhere for the week-1 move.
  - `a dead slot kept costs its penalty once` — owned 8 a dead slot (xpts 0), a replacement worth 0.5: rolls at penalty 0 with ft 1 and `endFtValue` set; moves at penalty 1.
  - `a likely fall in his sell price counts toward selling now` — `salePoints: {8: 0.4}` tips a 1.3-gain move over the 1.5 roll.
  - `an excluded first week is never chosen; the next best is` — solve, exclude its first week, re-solve: a different first week, objective ≤ the first.
  - `with every new field off, the LP text is byte-identical to Task 1's` — build one Phase 8–style problem with and without explicit defaults; `assert.equal(a.lp, b.lp)`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement each field in `buildPlan`** as specified in Interfaces.
- [ ] **Step 4: Run; expect PASS. `npm test` baseline + new. Commit** "Solver model: end-of-horizon values and the constraints".

### Task 3: A mode's problem from the engine's input

**Files:**
- Create: `js/engine/solver/problem.js`
- Modify: `js/engine/decision.js` (two additions to the result, below), `js/config.js` (`solver` block)
- Test: `tests/engine/solver/problem.test.js` (use `tests/engine/decision-fixtures.js`'s `scenario()`/`projectionOf()`)

**Interfaces:**
- Consumes: `runDecisionEngine(input, config, cache)`; Task 2's `p` fields.
- Produces:
  - `DECISION_ENGINE.solver` (config): `{ enabled: false, workers: 3, phone: { maxWidthPx: 639, minCores: 4, minMemoryGb: 4 }, timeLimitS: 3, absGap: 0.5, pool: { points: 20, pointsPerTenth: 10 }, lpLineTerms: 8, showRobustness: false, logMax: 5000, vendor: { dir: 'assets/vendor/highs/1.15.4/', mjs: '<sha256-base64>', wasm: '<sha256-base64>' }, modes: { now: { hitMargin: 0 }, longterm: { hitMargin: 0 }, future: { hitMargin: 0 }, funds: { hitMargin: 0 }, ceiling: { hitMargin: 0 }, structure: { hitMargin: 0 } } }` — each key with a one-line comment in the file's style; 639 is `css/planner.css`'s narrow breakpoint.
  - DecisionResult additions in `decision.js`: `players[].saleTenths` — the expected change in his sell price before the next chance to act (`sellOutlook(...).expected`, tenths); and `modes[m].bigWeek: boolean` (Ceiling: true when its tail applied; others false).
  - `modeSetting(input, result, modeId, config) -> SolverSetting | { source: 'engine-tail' } | null`
    - `null`: every weight of the mode is 0 (the card rolls with no solve).
    - `{ source: 'engine-tail' }`: Ceiling with `result.modes.ceiling.bigWeek` (user item 4).
    - `SolverSetting = { modeId, gws: number[], weights: number[], frozen: number[], keep: number[], bans: number[], buyable: (id) => boolean, endFtValue, bankPerTenth, hitMargin, deadSlot, salePoints, chips: { benchboost: gw|null, triplecaptain: gw|null } }`
      - `weights`: `result.modes[modeId].weights` (already masked by the engine's `masked`), cut after the last non-zero weight, and cut before the first GW from a planned Wildcard (`input.chipPlan`); `gws` the matching GWs.
      - `frozen`: horizon GWs with a planned Free Hit.
      - `keep`: `input.locks` ∪ (Ceiling-protected ids, from `result.players[].flags` 'protected', for now/longterm/future/funds) ∪ (Structure holds, flag 'hold', for structure).
      - `buyable`: not banned; for Now also `availability > 0` and `pZero ≤ mode.pZeroGate` in the first GW (the engine's own gate, read from config).
      - `endFtValue`: `ftValueSchedule` when `ftValueMode` is 'decreasing', else every n at `ftValueFlat`.
      - `bankPerTenth`: `(mode.lambda ?? lambdaDefault) / 10` per tenth. MODEL (coordinator's call): every mode carries its own λ as bank value, as the engine carries it as FundsTerm; Now and Ceiling's λ is 0.
      - `deadSlot`: Structure only, the engine's dead slots (`result.players[].flags`/the engine's `isDeadSlot` exposed as needed) and `deadSlotPenalty`.
      - `salePoints[id] = −λ · saleTenths / 10` for owned ids (a likely fall makes selling now worth more).
      - `chips`: the planned Bench Boost / Triple Captain GW inside `gws`, else null.
  - `solverProblem(input, result, setting, config) -> p` (Task 2's `buildPlan` input): the owned 15 at `sellPriceTenths` from `result.players`, priced at `priceTenths`; the pool per position = the `pool.points` best by weighted `xpts` over `setting.gws` and the `pool.pointsPerTenth` best by weighted `xpts` a tenth, among `input.candidates` that are not owned and pass `buyable`, plus `include` (the engine's roots, alternatives and chained buys across modes, if buyable); `xpts[k]` from `input.projections.get(id).gws` by GW (0 when missing); chips as `chips/fixed` (`{benchboost: true}` + `fixed.benchboost = gw`); `maxBankedFt`, `hitCost`, `benchWeights: benchWeightsLinear`, `maxPerClub: MAX_PER_CLUB`, `squadLimits: SQUAD_LIMITS`, `xiMin: XI_FORMATION_MIN`, `lineTerms`. This replaces the pool logic of `tools/backtest/milp.js`'s `milpProblem` for the app; leave `milpProblem` as it is.

- [ ] **Step 1: Write the failing tests**, one per rule:
  - `a locked player is in keep in every mode; a banned one is in no pool`
  - `Ceiling-protected players are kept by now, longterm, future and funds, not by ceiling or structure`
  - `Structure keeps its holds; no other mode does`
  - `a planned Free Hit week is frozen and weighs 0; the horizon ends before a planned Wildcard`
  - `Now's pool leaves out a buy flagged out or over the pZero gate in the first GW`
  - `Ceiling in a big week is the engine's (engine-tail); a mode with every week covered by chips is null`
  - `the pool is per position, the best by weighted points and by points a tenth, plus the engine's own buys` (assert sizes ≤ 15 + 4 × 30 + includes, and named ids present/absent as in `tests/tools/backtest-milp.test.js`'s pool test)
  - `the owned squad sells at the engine's sell prices`
  - `bank value is the mode's lambda per £1m; the free transfers left are the schedule`
- [ ] **Step 2: Run; expect FAIL. Step 3: Implement. Step 4: PASS; `npm test`. Commit** "Solver: each mode's problem from the engine's input".

### Task 4: HiGHS vendored, checked, and run in a module worker

**Files:**
- Create: `assets/vendor/highs/1.15.4/highs.mjs`, `highs.wasm` (copied byte-for-byte from `tools/milp/node_modules/highs/build/`), `LICENSE` (HiGHS's and highs-js's MIT texts — the package's `LICENSE` plus HiGHS's own, from the ERGO-Code/HiGHS licence, MIT), `README` (source package `highs@1.15.4` = HiGHS 1.15.1, how to update: copy, re-hash, update config)
- Create: `js/engine/solver/highs.js` (`loadHighs({ wasmBinary }) -> highs` — imports the vendored `highs.mjs`, works in a module worker and in Node), `js/engine/solver/worker.js`
- Modify: `js/config.js` (the two hashes), `tools/backtest/milp.js` (`loadSolver` loads the vendored copy through `loadHighs`, `wasmBinary` read from disk), `tests/tools/milp*.test.js` and the new tests load it the same way so solved tests no longer skip; delete `tools/milp/package.json` and `package-lock.json` once every solved test passes on the vendored copy (if `highs.mjs` will not load in Node, keep `tools/milp` and say so in the task report)
- Modify: `ARCHITECTURE.md` (the CSP note from spec §1 Shipping)
- Test: `tests/engine/solver/vendor.test.js`, `tests/engine/solver/worker.test.js`

**Interfaces:**
- Produces:
  - Worker protocol (`worker.js`): in `{ id, kind: 'init', wasmUrl, integrity }` → out `{ id, ok: true }` or `{ id, ok: false, error }`; in `{ id, kind: 'solve', problem, options: { time_limit, mip_abs_gap } }` → out `{ id, ok: true, plan, stopped, ms }` or `{ id, ok: false, error }` (`plan` = `decode(...)`, or `null` when HiGHS found none inside the limit). `init` fetches with `fetch(wasmUrl, { integrity })` and passes the bytes as `wasmBinary`; a fetch or integrity failure answers `ok: false`.
  - `solveProblem(highs, problem, options) -> { plan: object|null, stopped: boolean, ms: number }` in `js/engine/solver/highs.js` — shared by the worker, the tests and the backtest (status 'Optimal' or 'Time limit reached' usable; any other status throws; a non-finite objective is `plan: null`).
- [ ] **Step 1: Failing tests:** `the vendored files match the pinned SHA-256 hashes` (read files, `crypto.createHash('sha256')`, base64, compare to `DECISION_ENGINE.solver.vendor`); `solveProblem returns a plan, or null when the limit passes before any plan` (a fake highs returning `{Status:'Time limit reached', ObjectiveValue: Infinity}`); `the worker answers a solve with the decoded plan` (load `worker.js`'s message handler in Node by exporting `handle(message, deps)` and keeping `self.onmessage = e => handle(e.data).then(postMessage)` as the only browser glue).
- [ ] **Step 2: FAIL. Step 3: Implement.** The vendored copy is never imported by the page at load: only `worker.js` imports `highs.js`, and the worker is created on first use (Task 7).
- [ ] **Step 4: PASS; `npm test` (the solved model tests now run, not skip). Browser check: in Chromium, create the worker from a scratch page served by the local server, `init` + one `solve` of a Task 3 problem; record the time. Commit** "Solver: HiGHS vendored with pinned hashes, run in a module worker".

### Task 5: A solved plan as moves and a card

**Files:**
- Create: `js/engine/solver/plan.js`
- Modify: `js/engine/decision.js` (one new export, `describePlan`)
- Test: `tests/engine/solver/plan.test.js`

**Interfaces:**
- Consumes: Tasks 2–4; `checkSwap` (`js/engine/feasibility.js`).
- Produces:
  - `orderMoves(input, result, firstWeek: {in, out}) -> { moves: [{outId, inId}], unordered: boolean }` — the greedy of `tools/backtest/milp.js`'s `orderMoves` (each step the legal same-position pair that frees most money), on the engine's squad state (`result.players[].sellPriceTenths`, `input.squad`, `input.candidates`), legality by `checkSwap`. Then make `tools/backtest/milp.js` call this one (delete its copy) only if its tests still pass unchanged; otherwise leave it and say why.
  - `checkProtected(modeId, firstWeek, result)` — throws `Error('solver: <mode> sold protected player <id> in its first week')` for a sale of a 'protected' id in now/longterm/future/funds, a 'locked' id in any mode, a 'hold' in structure.
  - `moveSetKey(moves) -> string` — the sorted sales and the sorted buys, each joined by ',' and the two by '>' (`out,out>in,in`; one move is `out>in`), so how a squad change is paired does not change it (a key of pairs never matched a figure computed under the other pairing); `''` for rolling.
  - `callOf(plan) -> 'move' | 'wait' | 'roll'` — spec §3: move if week 0 has moves; wait if it has none and week 1 does; roll otherwise.
  - `describePlan(input, config, cache, modeId, moves) -> { perGw, deltaEv, overFiveGws, waitForNews, moves: [{ outId, inId, minutesRisk, tags }], why: { squad, cost } }` in `decision.js` — the engine on the squad after all of `moves`; `waitForNews` is Now's flag (spec §2: "stays the engine's flag, applied to the solver's move"): `waitsForNews`'s rule true for any move of the set, false in other modes; `perGw[k] = w_k · (V_k(S') − V_k(S))` with the mode's masked weights, the same cache keys `prepare` uses (key a move set by its `moveSetKey`), `overFiveGws` as `overGws`, each move's `minutesRisk` and `tags` as `buildMove` makes them; `why.squad` in `explain`'s wording ("A, B out, C, D in: +x weighted points for the squad over GWa–b."); `why.cost` "Uses N free transfers" / "Uses N free transfers and takes one 4-point hit" / "… two 4-point hits" (from config numbers).
  - `solverCard(engineMode, { plan, moves, describe, inputVersion }) -> card` — the card object `modeCardHTML` renders: the engine mode's fields, plus `source: 'solver'`, `call` (`callOf`), `moves`, `root` (= `{...moves[0], ...describe per-move fields, perGw, deltaEv, why, overFiveGws, tags, minutesRisk, tentativeFromGw}` so single-move rendering is unchanged), `hits` (week 0's), `later: [{gw, moves}]` (weeks ≥ 1 of the plan, tentative), `key: moveSetKey(moves) + '|' + inputVersion`, and the keyed figures `gain`, `alternatives`, `robustness`, each `{ key, value }` or `null` (not yet computed). For a `wait`, `root` is week 1's first move and `deferral` is `{ gw: plan.weeks[1].gw }`.
  - `gainOverRolling(plan, rollingPlan) = plan.objective − rollingPlan.objective` (rolling = the same problem with `fixed.first = {in: [], out: []}`).
  - `alternativesOf(problem, plan, solveFn, config) -> [{ moves, gain }]` — up to `alternativesMax` re-solves, each adding the previous first weeks to `exclude`, kept while `plan.objective − alt.objective ≤ alternativesWindow`.
- [ ] **Step 1: Failing tests:** `orderMoves keeps the bank and the clubs legal after every move` (port `tests/tools/backtest-milp.test.js`'s two ordering tests onto engine input); `a protected sale in Now throws; the same sale in Ceiling does not; a locked sale throws in every mode`; `moveSetKey is order-free and keys the sales and buys, not how they are paired`; `callOf: move, wait, roll`; `describePlan of one move equals the engine's own root for that move` (perGw, deltaEv, overFiveGws on `decision-fixtures.js`'s scenario); `the card's figures start null and carry the card's key`; `alternatives exclude the pick and stay within the window`; `gain over rolling is the plan less its rolled plan`.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS; `npm test`. Commit** "Solver: plans as ordered moves, cards and their figures".

### Task 6: Robustness as re-scoring (`pickBeatsAlternatives`)

**Files:**
- Create: `js/engine/solver/rescore.js`
- Modify: `js/engine/robustness-worker.js` (a second message kind)
- Test: `tests/engine/solver/rescore.test.js`

**Interfaces:**
- Consumes: `noisyInput` (`js/engine/robustness.js`), `squadValue` (`js/engine/squad-value.js`), `moveSetKey`.
- Produces: `pickBeatsAlternatives(input, config, modeId, weights, candidates: Array<{key, moves}>, pickKey) -> number` (0–1). For each of `robustnessRuns` noisy copies (`seededRandom(robustnessSeed)`), each distinct candidate (by key) scores `Σ_k w_k · V_k(S after its moves) − hits(n) + ftEnd(n)` where `n` = its number of moves, `hits(n) = hitCost · max(0, n − freeTransfers)`, `ftEnd(n)` = the end-of-horizon free-transfer value of `min(maxBankedFt, max(0, freeTransfers − n) + 1)` banked (Task 2's schedule). The share is the fraction of copies where the pick's score is ≥ every other candidate's. The weights stay the mode's own (MODEL: the copies move points, pZero and the free transfer's value; not the decay). Candidates in Phase 3: the solver's pick, its alternatives, the engine's root, and rolling (`moves: []`). The figure is logged and stored on the card under `robustness`; it is rendered only when `solver.showRobustness` is true.
  - Worker: `{ kind: 'rescore', input, modeId, weights, candidates, pickKey, key }` → `{ kind: 'rescore', key, share }`; the existing message (no `kind`) keeps today's behaviour.
- [ ] **Step 1: Failing tests:** `a pick that dominates scores 1; rolling against a clearly better move scores 0`; `the same seed gives the same share`; `duplicate candidates count once`; `the label is pickBeatsAlternatives, not a confidence` (assert the export name and that `rescore.js`'s header comment says "how often the pick beats these alternatives under noise, not how often a fresh solve would choose it").
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS; `npm test`. Commit** "Solver: robustness as re-scoring of the pick".

### Task 7: The runner, the card states and the switch

**Before starting:** read the UI checklist (`…/scratchpad/ui-checklist-mode-card-solver.md`) in full. It is the spec for every visible change in this task.

**Files:**
- Create: `js/modules/planner-solver.js` (the runner: pool, queue, keying)
- Modify: `js/modules/planner.js` (`runEngine` hands the result to the runner when `solver.enabled`; `modeCardHTML` renders the card states; a repaint-in-place like `paintRobustness` for landed figures), `css/planner.css` (only what the checklist needs, tokens only)
- Test: `tests/modules/planner-solver.test.js` (Node, with a fake `Worker`), plus pure render tests where `modeCardHTML`'s helpers are exported for test as the existing `resolveSettings`/`sortSellHold` are

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - `createSolverRunner({ config, makeWorker, isPhone, onCard, onLog }) -> { refresh(input, result, inputVersion), view(modeId), stop() }`:
    - Pool size `isPhone ? 1 : min(config.solver.workers, max(1, hardwareConcurrency − 1))`; workers made by `makeWorker()` on the first `refresh` only (never at page load); each `init`ed with the vendored wasm URL and `integrity: 'sha256-' + vendor.wasm`. An `init` failure, or `makeWorker` throwing (no `Worker`), turns the runner off for the session: every card stays the engine's (`source: 'engine'`), logged once with `console.warn('[planner] solver off: …')`.
    - `refresh`: drop everything queued or in flight for older versions (answers carrying an older `inputVersion` are ignored); per mode, `modeSetting` → `null` (no solve, roll card as the engine has it), `engine-tail` (the engine's card, `source: 'engine-tail'`), or a setting → queue its **pick** solve. Order: on a phone, only modes passed to `view(modeId)` (cards entering the viewport, via an `IntersectionObserver` the planner owns), in the order viewed; elsewhere all six, Now first then the config's order. After every pick, queue its rolling solve and alternatives, then its rescore (robustness worker).
    - Each card goes through `onCard(modeId, card)`: first with the engine's move and `state: 'refining'`; on a pick, `solverCard(...)` (`state: 'ready'`, `updated: true` and `replaced: engine root` when its `moveSetKey` differs from the engine's root's, else the card stays the engine's text with `source: 'solver'`); on no plan inside the cap or an error, the engine's card, `source: 'engine'`, `state: 'ready'`. Figures land via `onCard` with their key; a figure whose key is not the card's current key is dropped (Review Focus 1).
    - Every settled card goes through `onLog(entry)` (Task 8).
  - `isPhone()` (planner): spec §1 — `matchMedia('(pointer: coarse)')` and `innerWidth ≤ phone.maxWidthPx`, or `hardwareConcurrency < phone.minCores`, or `navigator.deviceMemory < phone.minMemoryGb` (missing values count as not a phone).
  - Planner: `runEngine` bumps `_inputVersion` on every run; with the solver on it calls `runner.refresh(input, _result, _inputVersion)`; cards render from `_cards[modeId] ?? engine mode`. With the solver off, none of this runs and the markup is exactly today's (Review: `git diff` of the rendered HTML for a fixture squad, solver off, is empty).
- [ ] **Step 1: Failing tests** (fake Worker answering scripted plans):
  - `nothing makes a worker until the first refresh, and never when the solver is off`
  - `a card shows the engine's move refining, then the solver's move marked updated when it differs`
  - `a figure computed for another move set or an older input is never painted` (Review Focus 1, 5: refresh v1, refresh v2 before v1's answers; inject v1's pick and gain; assert no `onCard` carries them)
  - `no plan inside the cap, an error, or a failed init leaves the engine's move, marked engine` (Review Focus 4)
  - `Ceiling in a big week stays the engine's, marked engine-tail; a mode with no weeks rolls without a solve`
  - `on a phone one worker, and only viewed cards solve, in the order viewed`
  - render: `modeCardHTML with the solver off is unchanged` (snapshot of today's output for the `decision-fixtures` scenario, captured before editing); `a pending gain shows the skeleton and "Still calculating", the card aria-busy`; `two moves render two .mc__mv blocks and "2 transfers · one −4 hit"`; `later weeks render under "Plan for GWa–b · tentative"`; `robustness is not rendered while showRobustness is false`
- [ ] **Step 2: FAIL. Step 3: Implement** per the checklist.
- [ ] **Step 4: PASS; `npm test`.** Browser check with `solver.enabled` set true in a scratch copy of `js/config.js` served locally (never commit it on): 1280 px and 360 px, a squad from `browser36`: screenshots of a card refining, updated, with two moves, with a pending figure; no overflow at 360 px; console clean. Save to the scratchpad.
- [ ] **Step 5: UI check by a fresh subagent** with `ui-consistency:verifying` against the checklist, one calibration plant in a `mktemp -d` copy of `planner.js`. Fix what it finds.
- [ ] **Step 6: Commit** "Solver: runner, card states and the switch".

### Task 8: The decision log

**Files:**
- Modify: `js/snapshots.js` (DB_VERSION 2, a `decisions` store, `logDecision`, export), `js/modules/planner.js` (`onLog` → `logDecision`; the export's "Nothing archived" check counts decisions too)
- Test: `tests/snapshots.test.js` (extend the in-memory adapter tests already there, or create beside them)

**Interfaces:**
- Produces: `logDecision(db, entry, { max })` — `entry = { gw, at, mode, source, moves, gain, robustness, engineFirst, agrees }` (spec §4; `moves` and `engineFirst` as `[{outId, inId}]`, `gain`/`robustness` null until computed). Keyed `${gw}|${mode}|${moveSetKey}|${source}`: a repeat of the same key updates `gain`/`robustness`/`at` in place, a new key adds an entry; past `max` (`solver.logMax`) the oldest by `at` go. `exportSnapshots(db)` → `{ snapshots, gwTables, decisions }`. The adapter gains `delete(store, key)` (NO_STORE and the IDB wrapper both).
- [ ] **Step 1: Failing tests:** `a settled card is logged with every field`; `a figure landing later updates the same entry`; `the log keeps at most logMax entries, oldest first out`; `the export includes the log`; `NO_STORE still never throws`.
- [ ] **Step 2: FAIL. Step 3: Implement** (upgrade path: `onupgradeneeded` creates `decisions` when missing, keyPath `key`). **Step 4: PASS; `npm test`. Commit** "Solver: the decision log, kept with the snapshots and exported".

### Task 9: The reproduction check in the backtest

**Files:**
- Create: `tools/backtest/solver.js` (`solverPolicy(highs, setting)` through the app's modules)
- Modify: `tools/backtest/run.js` (`--solver-repro` stage → `data/solver-repro.json`, a report section)
- Test: `tests/tools/backtest-solver.test.js`

**Interfaces:**
- Consumes: `engineInput` (run.js — export it or move it to `lib.js`), `runDecisionEngine`, `solverProblem`, `solveProblem`, `orderMoves` (Task 5).
- Produces:
  - `solverPolicy(highs, { setting: (input, result) => SolverSetting, options }) -> { counts, log, decide({ t, state, world, locks, bans }) -> { moves } }` — each week: the engine on `engineInput(...)`, the setting, `solverProblem`, `solveProblem` with `options`, `orderMoves`; no plan → no moves, `counts.noPlan += 1`. `log` gets, each week, `{ t, first: moves, engine: { [modeId]: root ? {outId, inId} : null } }`.
  - The reproduction setting (in `solver.js`): weights `decayBase^k` over five GWs as a total, cut at the season's end; `endFtValue: null`, `bankPerTenth: 0`, `hitMargin: 0`, `keep: []`, `frozen: []`, no dead slots or sale points, no chips; pool `{ points: 20, pointsPerTenth: 10 }`, no include; hits at 4. Options: `{ time_limit: 3, mip_abs_gap: 0.5 }`.
  - Stage `--solver-repro`: the same 24 tasks as `--milp` (both seasons, asItStood, all squads), policies roll and `solver-repro`; resumable like the others.
  - Report section "The app's solver against the offline planner": per season, the policy's season total against `data/milp.json`'s `milp` on the same squad (paired, `pairedBootstrap`), the gap in points a season with its interval, `counts` (solves, ms, stopped, noPlan, unordered), and the disagreement log: per mode, the share of weeks the solver's first week equals the engine's root (as a set), and the first 20 weeks where they differ (season, squad, GW, the solver's moves, the engine's).
- [ ] **Step 1: Failing tests** (on `tests/tools/backtest-milp.test.js`'s fake `world()`): `the reproduction policy makes a clearly better buy and nothing when nobody is better`; `it logs the engine's six roots beside its own first week`; `no plan means no moves, counted`.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS; `npm test`.**
- [ ] **Step 5: `node tools/backtest/run.js --solver-repro --quick`**, then the full run (`--old` is not needed for this stage; if `run.js` requires it, pass `…/scratchpad/old-engine/projects/apps/gaffer-iq`). Run it in the background, `--resume` after any container restart, touch no source while it runs. Then `--report`.
- [ ] **Step 6:** Read the section. If any season's gap is over 20 points, find the cause (the 3 s cap against Phase 8's 10 s is expected and small: re-run the worst squad at `time_limit: 10` to show it), and write the explanation into the section's text. **Commit** "Solver: the reproduction check against the offline planner".

### Task 10: Docs and the phase's verification

**Files:** `docs/decision-engine-solver-plan.md` ("Phase 3 as built", the status line), `docs/decision-engine.md` (a "Solver" section: the files, the mode settings, the switch), `ARCHITECTURE.md` (already has the CSP note from Task 4; add the solver files), `FEATURE_ENGINE.md` §14 pointer if it lists engine files, `GAFFER_IQ_TESTING_ROADMAP.md` (the `--solver-repro` stage), `ROADMAP.md`.

- [ ] **Step 1:** Write the docs in the existing docs' style (short sections, tables, plain prose).
- [ ] **Step 2: Whole-branch review** by a fresh reviewer subagent (`superpowers:requesting-code-review`, base = `origin/Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`), with the spec and this plan; fix Critical and Important findings.
- [ ] **Step 3: Verify:** `npm test` (baseline + new; the 5 channel failures named), the numeric-literal grep on `js/engine/solver/*.js` (`grep -nE '[^0-9a-zA-Z_.][2-9][0-9]*|[^0-9a-zA-Z_.]1[0-9]+|[0-9]\.[0-9]' js/engine/solver/*.js` → none outside comments), the hash test, the solver-off render test, and `git status` clean but for local commits. Do not push.
- [ ] **Step 4: Commit** "Solver Phase 3: docs".

## Final report (the orchestrator's last message)

1. Per task: done / not done, commits, tests added, anything left out and why.
2. `npm test` totals with the 5 failing test names.
3. The reproduction gap per season (points a season, interval), counts, and the disagreement table — copied from the report section.
4. Browser times from Task 4 and Task 7, and the screenshot paths.
5. **"Rulings I made"** — every decision this plan left open that you or a subagent settled, one line each, verbatim as you would defend it.
