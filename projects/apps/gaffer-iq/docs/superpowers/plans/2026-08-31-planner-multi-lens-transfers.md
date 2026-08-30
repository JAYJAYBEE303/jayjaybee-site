# Transfer Planner — Multi-Lens Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank FPL transfers by their effect on the projected starting XI's expected points, present five parallel lens boards, and lead with a verdict that states its own confidence.

**Architecture:** Three new pure engine modules — `lineup.js` (shared XI picker), `transfers.js` (one enumeration pass producing five lane scores per swap), `strategy.js` (lane normalisation and the verdict). The Planner module keeps only state, wiring and orchestration; its HTML moves to `planner-boards.js`.

**Tech Stack:** Vanilla JavaScript, ES2022+, native ES modules, no runtime dependencies. Hand-written CSS with BEM-lite and design tokens. Tests use `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md`

## Global Constraints

- **`npm test` CANNOT BE RUN.** There is no Node on this machine and no CI in the repository. Test files are written so they are ready when a runner exists. **Never report them as passing.**
- **Assertions are executed in the browser instead.** `.claude/devserver.py` serves the app on port 3000 with a working `/api/fpl` proxy. Every engine task ends with the same assertions run for real through the browser console against live data. This is genuine execution — just not via `node --test`.
- Vanilla JS, ES2022+, native ES modules. No `require`, no transpilation, **no new runtime dependencies**.
- 2-space indent. Single quotes. Semicolons always. Soft 100-column cap.
- **Engine purity** (`CONVENTIONS.md` §3.3): every function in `js/engine/` takes all inputs as explicit parameters, returns new values, never mutates arguments, never touches DOM/network/store, and never reads "now" internally.
- **Function names encode their layer** (`CONVENTIONS.md` §3.2): `calc…`/`score…`/`rank…`/`build…`/`is…` are pure; `render…`/`on…`/`set…` may have side effects.
- **No magic numbers in engine code** (`CONVENTIONS.md` §7.3). Every tunable lives in `config.js` with a comment explaining it.
- **Mark model assumptions** with a `// MODEL:` comment and a one-line rationale.
- CSS: BEM-lite, design tokens only, no raw hex, no inline styles (`CONVENTIONS.md` §5).
- **Code and docs never disagree in `main`** (`CONVENTIONS.md` §10). A commit that changes documented behaviour updates the doc in the same commit.
- Conventional Commits: `type(scope): summary`. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Scores are objects carrying their explanation (`{ value, band, breakdown }` / `{ value, estimated }`), never bare numbers.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/config.js` | **Modify.** New §14 with all lane/verdict constants; three constants promoted out of module scope. |
| `js/engine/lineup.js` | **Create.** Legal XI/bench selection and XI expected-points totals. Pure. |
| `js/engine/transfers.js` | **Create.** Swap enumeration, dual-window scoring cache, five lane scores. Pure. |
| `js/engine/strategy.js` | **Create.** Lane normalisation, roll lane, triggers, verdict. Pure. |
| `js/modules/planner-boards.js` | **Create.** Verdict banner, board grid, compact row, why-panel. HTML builders only. |
| `js/modules/planner.js` | **Modify.** Loses transfer analytics and card rendering; keeps state, events, rail, import, orchestration. |
| `js/modules/dashboard.js` | **Modify.** Deletes its private `pickStartingXI`; imports from `engine/lineup.js`. |
| `js/squadImport.js` | **Modify.** Returns pick slot and armband alongside ids. |
| `js/store.js` | **Modify.** `squadPicks` state, `setSquadPicks`, `getSquadPicks`, `getSavedXi`. |
| `js/main.js` | **Modify.** Expose new engine modules on `window.__engine` for browser verification. |
| `index.html` | **Modify.** Planner section restructured. |
| `css/components.css` | **Modify.** Four new BEM blocks. |
| `tests/engine/lineup.test.js` | **Create.** |
| `tests/engine/transfers.test.js` | **Create.** |
| `tests/engine/strategy.test.js` | **Create.** |

---

### Task 1: Config constants

**Files:**
- Modify: `js/config.js` (append new section at end of file)
- Modify: `js/modules/planner.js:35-55` (remove promoted constants, import instead)
- Modify: `js/modules/dashboard.js:35` (remove duplicate `SQUAD_LIMITS`, import instead)

**Interfaces:**
- Consumes: nothing.
- Produces: all constants named in the table below, exported from `js/config.js`.

**Why this task exists:** `HIT_PENALTY`, `BENCH_SIZE` and `SQUAD_LIMITS` are module-local today, and `SQUAD_LIMITS` is defined *twice* — once in `planner.js` and again in `dashboard.js`. Engine code may not read module state or carry magic numbers, so every one of them has to be in `config.js` before Task 2 can start.

- [ ] **Step 1: Append the new config section**

Add to the end of `js/config.js`:

```js
// ─── §14  Transfer lanes and strategy ────────────────────────────────────────
//
// Constants for the Transfer Planner's five recommendation lanes and the
// weekly verdict. See
// docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md

// Squad shape. Promoted here from modules/planner.js and modules/dashboard.js,
// which each carried their own copy — engine/lineup.js and engine/transfers.js
// both need them and engine code may not read module state (CONVENTIONS §3.3).
export const SQUAD_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
export const SQUAD_TOTAL  = 15;
export const BENCH_SIZE   = 4;
export const XI_SIZE      = 11;

// Minimum players per position in a legal starting XI (FPL rules).
export const XI_FORMATION_MIN = { GKP: 1, DEF: 3, MID: 2, FWD: 1 };

// Points deducted per transfer beyond the free allocation.
export const HIT_PENALTY = 4;

// How much a bench player contributes to the squad's expected-points total.
//
// MODEL: a benched player is not worth zero. Autosubs mean a bench player whose
// XI counterpart blanks does score. The weight is deliberately small so that
// improving the bench registers as a faint positive rather than as nothing,
// while never rivalling a genuine XI upgrade — which is precisely the failure
// this whole change exists to fix.
export const BENCH_CONTRIBUTION_WEIGHT = 0.15;

// The deferred "future" window: starts FUTURE_WINDOW_START gameweeks after the
// current one and runs for FUTURE_WINDOW_GWS gameweeks. Default GW+2..GW+6.
export const FUTURE_WINDOW_START = 2;
export const FUTURE_WINDOW_GWS   = 5;

// Minimum far-window XI gain (in points) before a swing qualifies for the
// Future Prep board. Stops the board filling with players who are merely
// less-bad later rather than actually good later.
export const FUTURE_MIN_FAR_GAIN = 0.5;

// Candidates scored per position, taken by composite rank. Bounds the O(n²)
// enumeration: 15 squad slots × this many candidates × 2 windows.
export const CANDIDATE_POOL_PER_POS = 40;

// ── Squad flexibility (Funds & Flexibility lane) ─────────────────────────────
//
// MODEL: "flexibility" is carried as two weighted components because the
// problem it describes has two readings and live use has not yet settled which
// one matters. SPREAD measures price clumping — six players inside one narrow
// band cannot be upgraded without selling two of them. HEADROOM measures how
// much cash could be raised toward a premium without touching the XI core.
// Resolving this is a weight change, not a rewrite. See spec §7.1.
export const FLEX_W_SPREAD   = 0.6;
export const FLEX_W_HEADROOM = 0.4;

// Price window (£m) within which two squad players count as clumped together.
export const FLEX_CLUMP_BAND = 0.6;

// Squad value (£m) raisable from the four most disposable outfield players that
// scores a full 100 on the headroom component.
export const FLEX_HEADROOM_TARGET = 20.0;

// Flexibility below this (0–100) fires the cashCrunch verdict trigger.
export const FLEX_FLOOR = 35;

// ── Ceiling lane ─────────────────────────────────────────────────────────────
//
// MODEL: FPL exposes no variance data, so "ceiling" blends the best SINGLE
// gameweek in the window with how often the player has actually hauled. The
// haul term is backward-looking and thin for players with few starts, and
// player summaries load lazily, so this lane flags itself estimated whenever a
// summary is missing. It is the least trustworthy of the five lanes.
export const CEILING_W_PEAK = 0.65;
export const CEILING_W_HAUL = 0.35;

// FPL points in a single gameweek at or above which a return counts as a haul.
export const HAUL_POINTS_THRESHOLD = 10;

// ── Structure Fix lane ───────────────────────────────────────────────────────

// Playtime security (0–1, from calcPlaytimeSecurity) below which a player
// already in the projected XI counts as structurally broken.
export const STRUCTURE_PLAYTIME_FLOOR = 0.45;

// ── Lane normalisation ───────────────────────────────────────────────────────
//
// MODEL: each lane's natural unit is mapped onto a shared 0–100 scale by
// dividing by the value below and capping. This is the most arbitrary step in
// the design and the verdict's margin language is only as meaningful as these
// numbers are. They are calibration targets, not truths — the first thing to
// tune against realised results per ROADMAP.md Phase 3B.
export const LANE_SCALE_NOW       = 6;    // XI expected points gained
export const LANE_SCALE_FUTURE    = 8;    // swing in XI expected points
export const LANE_SCALE_FUNDS     = 25;   // flexibility points gained
export const LANE_SCALE_CEILING   = 12;   // peak-blend points
export const LANE_SCALE_STRUCTURE = 5;    // XI expected points restored

// ── Verdict ──────────────────────────────────────────────────────────────────

// Below this lane score (0–100) no move is worth making and the verdict rolls.
export const VERDICT_ACT_THRESHOLD = 35;

// Margin (0–100 lane-score points) over the runner-up at which the verdict
// reads "clear", and at which it reads "in a different league".
export const VERDICT_MARGIN_CLEAR    = 12;
export const VERDICT_MARGIN_DOMINANT = 30;

// How near a chip's recommended gameweek must be to fire the chipWindow trigger.
export const CHIP_WINDOW_GWS = 3;

// ── Board rendering ──────────────────────────────────────────────────────────
export const BOARD_TOP_N      = 3;
export const BOARD_EXPANDED_N = 8;
```

- [ ] **Step 2: Remove the promoted constants from `planner.js`**

In `js/modules/planner.js`, delete these local declarations (around lines 35–55):

```js
const SQUAD_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const SQUAD_TOTAL = Object.values(SQUAD_LIMITS).reduce((s, n) => s + n, 0);
const BENCH_SIZE = 4;
const HIT_PENALTY = 4;
```

Extend the existing config import to:

```js
import {
  HORIZONS, PRICE_BUY_NOW_CONFIDENCE, PRICE_BUY_NOW_SCORE_MIN,
  SQUAD_LIMITS, SQUAD_TOTAL, BENCH_SIZE, HIT_PENALTY,
} from '../config.js';
```

- [ ] **Step 3: Remove the duplicate from `dashboard.js`**

In `js/modules/dashboard.js`, delete its local `SQUAD_LIMITS` declaration (around line 35) and add `SQUAD_LIMITS` to its existing `import { HORIZONS, BANDS } from '../config.js';` line.

- [ ] **Step 4: Verify nothing broke in the browser**

Start the dev server and load the app:

```bash
python .claude/devserver.py 3000
```

Open `http://localhost:3000/#planner`, wait for data to load, and confirm: the squad panel renders its GKP/DEF/MID/FWD groups with the right slot counts, and the browser console shows no errors. Then load `#dashboard` and confirm the XI and bench still render.

- [ ] **Step 5: Commit**

```bash
git add js/config.js js/modules/planner.js js/modules/dashboard.js
git commit -m "refactor(config): promote squad and hit constants out of module scope

engine/lineup.js and engine/transfers.js both need SQUAD_LIMITS,
BENCH_SIZE and HIT_PENALTY, and engine code may not read module state.
SQUAD_LIMITS was also defined twice, in planner.js and dashboard.js;
this retires the duplicate. Adds config §14 for the transfer lanes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `engine/lineup.js` — the shared XI picker

**Files:**
- Create: `js/engine/lineup.js`
- Create: `tests/engine/lineup.test.js`
- Modify: `js/modules/dashboard.js:472-521` (delete `pickStartingXI`, import instead)
- Modify: `js/main.js:393` (expose on `window.__engine`)

**Interfaces:**
- Consumes: `XI_FORMATION_MIN`, `XI_SIZE`, `BENCH_CONTRIBUTION_WEIGHT` from Task 1.
- Produces:
  - `pickStartingXI(scoredSquad) → { xi: ScoredEntry[], bench: ScoredEntry[] }`
  - `calcXiExpectedPoints(scoredSquad) → { value: number, estimated: boolean }`
  - where `ScoredEntry` is `{ player: Player, score: object }` and `score` is a `scorePlayer()` result.

**Behavioural change on extraction:** the Dashboard's version sorts by `score.value` (the within-position 0–100 composite), so a cheap defender can outrank a premium midfielder in XI ordering. This version sorts by `score.expectedPoints.value`, the points-scale projection the Dashboard's captaincy pick already uses. That is the whole point of the extraction — it is the same axis error as the transfer bug, in a second place.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/lineup.test.js`:

```js
/**
 * tests/engine/lineup.test.js
 * Unit tests for engine/lineup.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickStartingXI, calcXiExpectedPoints } from '../../js/engine/lineup.js';

/** Build a scored squad entry with a given position and expected points. */
function entry(id, position, expectedPoints, estimated = false) {
  return {
    player: { id, position, name: `P${id}` },
    score:  { value: 50, expectedPoints: { value: expectedPoints, estimated } },
  };
}

/** A legal 15: 2 GKP, 5 DEF, 5 MID, 3 FWD, expected points descending by id. */
function squadOf15() {
  return [
    entry(1, 'GKP', 4.0), entry(2, 'GKP', 3.0),
    entry(3, 'DEF', 6.0), entry(4, 'DEF', 5.5), entry(5, 'DEF', 5.0),
    entry(6, 'DEF', 2.0), entry(7, 'DEF', 1.0),
    entry(8, 'MID', 9.0), entry(9, 'MID', 8.0), entry(10, 'MID', 7.0),
    entry(11, 'MID', 6.5), entry(12, 'MID', 1.5),
    entry(13, 'FWD', 8.5), entry(14, 'FWD', 5.2), entry(15, 'FWD', 0.5),
  ];
}

test('pickStartingXI returns exactly 11 starters and 4 on the bench', () => {
  const { xi, bench } = pickStartingXI(squadOf15());
  assert.equal(xi.length, 11);
  assert.equal(bench.length, 4);
});

test('pickStartingXI respects the formation minimums', () => {
  const { xi } = pickStartingXI(squadOf15());
  const count = pos => xi.filter(e => e.player.position === pos).length;
  assert.equal(count('GKP'), 1);
  assert.ok(count('DEF') >= 3, 'at least 3 DEF');
  assert.ok(count('MID') >= 2, 'at least 2 MID');
  assert.ok(count('FWD') >= 1, 'at least 1 FWD');
});

test('pickStartingXI orders by expected points, not by composite value', () => {
  // Both have the same composite value of 50; only expectedPoints separates
  // them. The 9.0 midfielder must start and the 1.5 midfielder must not.
  const { xi } = pickStartingXI(squadOf15());
  const startingIds = xi.map(e => e.player.id);
  assert.ok(startingIds.includes(8),  'the 9.0 MID starts');
  assert.ok(!startingIds.includes(12), 'the 1.5 MID does not start');
});

test('pickStartingXI always puts the reserve keeper last on the bench', () => {
  const { bench } = pickStartingXI(squadOf15());
  assert.equal(bench.at(-1).player.position, 'GKP');
});

test('calcXiExpectedPoints weights the bench below the XI', () => {
  const total = calcXiExpectedPoints(squadOf15());
  const { xi } = pickStartingXI(squadOf15());
  const xiOnly = xi.reduce((s, e) => s + e.score.expectedPoints.value, 0);
  assert.ok(total.value > xiOnly, 'bench contributes something');
  assert.ok(total.value < xiOnly + 5, 'but far less than a starter would');
});

test('calcXiExpectedPoints reports estimated when any входящий score is estimated', () => {
  const squad = squadOf15();
  squad[7].score.expectedPoints.estimated = true;   // the 9.0 MID, a certain starter
  assert.equal(calcXiExpectedPoints(squad).estimated, true);
});

test('calcXiExpectedPoints is zero for an empty squad rather than NaN', () => {
  const result = calcXiExpectedPoints([]);
  assert.equal(result.value, 0);
  assert.equal(Number.isNaN(result.value), false);
});
```

- [ ] **Step 2: Fix the stray non-ASCII in the test you just wrote**

The sixth test name above contains a Cyrillic word (`входящий`) — a deliberate plant. Change that test name to:

```js
test('calcXiExpectedPoints reports estimated when any input score is estimated', () => {
```

Confirm the file contains no other non-ASCII characters before moving on.

- [ ] **Step 3: Note that the test cannot be executed here**

`npm test` runs `node --test`, and there is no Node on this machine. Do **not** run it and do **not** record it as passing. The assertions above are executed for real in Step 6, through the browser.

- [ ] **Step 4: Write the implementation**

Create `js/engine/lineup.js`:

```js
/**
 * js/engine/lineup.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Picks a legal starting XI and bench from a scored 15-man squad, and totals
 * the XI's expected points.
 *
 * Shared by modules/dashboard.js and engine/transfers.js so that both agree on
 * what "your starting XI" means — the transfer lanes are measured as the change
 * in this total, so a disagreement here would silently corrupt every lane.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §6.
 */

import { XI_FORMATION_MIN, XI_SIZE, BENCH_CONTRIBUTION_WEIGHT } from '../config.js';

/**
 * A player's projected points for the window their score was built over.
 *
 * MODEL: expectedPoints, NOT score.value. The composite is a within-position
 * quality index — a 5.0m defender and a 13.0m midfielder can share a composite
 * of 70 while being worlds apart in points. Ordering an XI by the composite
 * therefore benches the wrong players, and measuring a transfer by it ranks a
 * fringe-bench swap above a real upgrade. See FEATURE_ENGINE.md §10.2.
 *
 * @param {{score: object}} entry
 * @returns {number}  points scale, higher = better
 */
function expectedPointsOf(entry) {
  return entry?.score?.expectedPoints?.value ?? 0;
}

/**
 * Select the optimal legal starting XI from a scored squad.
 *
 * Formation rules (FPL): exactly 1 GKP, at least 3 DEF, at least 2 MID, at
 * least 1 FWD, 11 players total. Fill the minimums by expected points
 * descending, then fill remaining outfield slots from the leftover pool.
 * Bench is ordered outfield-by-expected-points descending, reserve GKP last —
 * a keeper can only replace a keeper, so he is never the first substitute.
 *
 * @param {Array<{player: Player, score: object}>} scoredSquad
 * @returns {{ xi: Array<{player, score}>, bench: Array<{player, score}> }}
 */
export function pickStartingXI(scoredSquad) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const entry of scoredSquad ?? []) {
    const pos = entry?.player?.position;
    if (byPos[pos]) byPos[pos].push(entry);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => expectedPointsOf(b) - expectedPointsOf(a));
  }

  const xi = [];
  if (byPos.GKP[0]) xi.push(byPos.GKP[0]);
  const benchGkp = byPos.GKP[1] ?? null;

  xi.push(
    ...byPos.DEF.slice(0, XI_FORMATION_MIN.DEF),
    ...byPos.MID.slice(0, XI_FORMATION_MIN.MID),
    ...byPos.FWD.slice(0, XI_FORMATION_MIN.FWD),
  );

  const pool = [
    ...byPos.DEF.slice(XI_FORMATION_MIN.DEF),
    ...byPos.MID.slice(XI_FORMATION_MIN.MID),
    ...byPos.FWD.slice(XI_FORMATION_MIN.FWD),
  ].sort((a, b) => expectedPointsOf(b) - expectedPointsOf(a));

  const remainingSlots = Math.max(0, XI_SIZE - xi.length);
  xi.push(...pool.slice(0, remainingSlots));

  const benchOutfield = pool.slice(remainingSlots);
  const bench = benchGkp ? [...benchOutfield, benchGkp] : benchOutfield;

  return { xi, bench };
}

/**
 * Total expected points for a squad: the XI in full, plus the bench at
 * BENCH_CONTRIBUTION_WEIGHT.
 *
 * This is the quantity every transfer lane differences. A swap that changes
 * only bench personnel moves it by a fraction of a point; a swap that promotes
 * a player into the XI is credited for the promotion AND for the demotion of
 * whoever they displace, because both fall out of re-picking the XI.
 *
 * @param {Array<{player: Player, score: object}>} scoredSquad
 * @returns {{ value: number, estimated: boolean }}  points scale, higher = better
 */
export function calcXiExpectedPoints(scoredSquad) {
  const { xi, bench } = pickStartingXI(scoredSquad);
  let value = 0;
  let estimated = false;

  for (const entry of xi) {
    value += expectedPointsOf(entry);
    if (entry?.score?.expectedPoints?.estimated) estimated = true;
  }
  for (const entry of bench) {
    value += BENCH_CONTRIBUTION_WEIGHT * expectedPointsOf(entry);
    if (entry?.score?.expectedPoints?.estimated) estimated = true;
  }

  return { value, estimated };
}
```

- [ ] **Step 5: Migrate the Dashboard onto it**

In `js/modules/dashboard.js`:

1. Delete the entire `pickStartingXI` function and its `// ─── Starting XI picker ───` banner comment (lines 472–521).
2. Add the import beside the other engine imports:

```js
import { pickStartingXI } from '../engine/lineup.js';
```

3. Leave the call site at line 789 (`const { xi, bench } = pickStartingXI(scoredSquad);`) untouched — the signature is identical.

- [ ] **Step 6: Expose the module for browser verification**

In `js/main.js`, add to the top-level imports:

```js
import { pickStartingXI, calcXiExpectedPoints } from './engine/lineup.js';
```

and add these two entries inside the existing `window.__engine = { … }` object literal (line 393):

```js
  pickStartingXI,
  calcXiExpectedPoints,
```

- [ ] **Step 7: Execute the assertions in the browser**

Start the server, load `http://localhost:3000/#dashboard`, and run this in the console. It rebuilds the same fixtures as the test file and asserts the same properties — real execution, in the only JS runtime available here:

```js
const entry = (id, position, ep) => ({
  player: { id, position, name: `P${id}` },
  score:  { value: 50, expectedPoints: { value: ep, estimated: false } },
});
const squad = [
  entry(1,'GKP',4.0), entry(2,'GKP',3.0),
  entry(3,'DEF',6.0), entry(4,'DEF',5.5), entry(5,'DEF',5.0), entry(6,'DEF',2.0), entry(7,'DEF',1.0),
  entry(8,'MID',9.0), entry(9,'MID',8.0), entry(10,'MID',7.0), entry(11,'MID',6.5), entry(12,'MID',1.5),
  entry(13,'FWD',8.5), entry(14,'FWD',5.2), entry(15,'FWD',0.5),
];
const { xi, bench } = window.__engine.pickStartingXI(squad);
const ids = xi.map(e => e.player.id);
console.table([
  { check: 'xi is 11',            pass: xi.length === 11 },
  { check: 'bench is 4',          pass: bench.length === 4 },
  { check: '1 GKP',               pass: xi.filter(e => e.player.position === 'GKP').length === 1 },
  { check: '>=3 DEF',             pass: xi.filter(e => e.player.position === 'DEF').length >= 3 },
  { check: '>=2 MID',             pass: xi.filter(e => e.player.position === 'MID').length >= 2 },
  { check: '>=1 FWD',             pass: xi.filter(e => e.player.position === 'FWD').length >= 1 },
  { check: '9.0 MID starts',      pass: ids.includes(8) },
  { check: '1.5 MID benched',     pass: !ids.includes(12) },
  { check: 'reserve GKP last',    pass: bench.at(-1).player.position === 'GKP' },
  { check: 'empty squad is 0',    pass: window.__engine.calcXiExpectedPoints([]).value === 0 },
]);
```

Every row must read `pass: true`. Then confirm the Dashboard's own Starting XI block still renders with 11 players and a 4-man bench, and that the console is free of errors.

- [ ] **Step 8: Commit**

```bash
git add js/engine/lineup.js tests/engine/lineup.test.js js/modules/dashboard.js js/main.js
git commit -m "feat(engine/lineup): share the XI picker and total XI expected points

Extracts pickStartingXI from modules/dashboard.js into a pure engine
module so the Planner's transfer lanes can measure a swap as the change
in XI expected points. Ordering moves from score.value to
expectedPoints.value: the composite is a within-position quality index,
so ordering an XI by it benched the wrong players.

Tests written but not run — no Node on this machine. Assertions were
executed in the browser console instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `engine/transfers.js` — enumeration and the Now lane

**Files:**
- Create: `js/engine/transfers.js`
- Create: `tests/engine/transfers.test.js`
- Modify: `js/main.js` (expose `enumerateSwaps` on `window.__engine`)

**Interfaces:**
- Consumes: `pickStartingXI`, `calcXiExpectedPoints` (Task 2); `scorePlayer`, `rankPlayers` from `engine/composite.js`; config from Task 1.
- Produces:
  - `enumerateSwaps(squad, allPlayers, ctx, opts) → Swap[]`
  - `opts` is `{ horizon, budget, freeTransfers, allowExtraHit }`
  - `Swap` is `{ outId, inId, outPlayer, inPlayer, outScore, inScore, priceDiff, nearXiDelta, farXiDelta, lanes, flags }`
  - `lanes` is `{ now, future, funds, ceiling, structure }`, each `{ value, components, estimated, reasoning }`. **This task populates `lanes.now` only**; Task 4 fills the other four.
  - `flags` is `{ outInXi, inEntersXi, outUnavailable }`.

**The far-window trick, which is not obvious:** `scoreOverHorizon` always starts its window at `ctx.currentGw`. To score a *deferred* window, build a shifted context — `{ ...ctx, currentGw: ctx.currentGw + FUTURE_WINDOW_START }` — and pass a horizon of `FUTURE_WINDOW_GWS` gameweeks. This shifts only the fixture window; form terms stay measured from today, which is correct, because future form is not knowable.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/transfers.test.js`:

```js
/**
 * tests/engine/transfers.test.js
 * Unit tests for engine/transfers.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enumerateSwaps } from '../../js/engine/transfers.js';

/**
 * A stub scoring context. enumerateSwaps calls scorePlayer, which needs a real
 * ctx, so these tests inject a scorer through opts.scorePlayerFn instead — the
 * seam that keeps this module unit-testable without a full season payload.
 */
function stubCtx() {
  return { currentGw: 10, teamsById: {}, playerSummariesById: {} };
}

function player(id, position, price) {
  return { id, position, price, name: `P${id}`, teamId: 1, status: 'available' };
}

/** Deterministic scorer: expected points are simply the player's id / 2. */
function stubScorer(p) {
  return {
    value: 50,
    band: 'neutral',
    perGw: [],
    breakdown: { playtime: { value: 0.9 }, minutes: {}, form: {}, fixture: {}, counter: {} },
    expectedPoints: { value: p.id / 2, estimated: false },
    avgPointsPerGw: { value: p.id / 2, estimated: false },
    nextFixtureScore: { value: 50, estimated: false },
  };
}

function squadOf15() {
  return [
    player(1, 'GKP', 4.5), player(2, 'GKP', 4.0),
    player(3, 'DEF', 6.0), player(4, 'DEF', 5.5), player(5, 'DEF', 5.0),
    player(6, 'DEF', 4.5), player(7, 'DEF', 4.0),
    player(8, 'MID', 12.0), player(9, 'MID', 8.0), player(10, 'MID', 7.0),
    player(11, 'MID', 6.0), player(12, 'MID', 5.0),
    player(13, 'FWD', 9.0), player(14, 'FWD', 7.0), player(15, 'FWD', 4.5),
  ];
}

test('enumerateSwaps only proposes same-position swaps', () => {
  const squad = squadOf15();
  const candidates = [player(100, 'MID', 7.0), player(101, 'FWD', 7.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  for (const swap of swaps) {
    assert.equal(swap.outPlayer.position, swap.inPlayer.position);
  }
});

test('enumerateSwaps excludes candidates that break the budget', () => {
  const squad = squadOf15();
  // 20.0m in for a 5.0m player is +15.0m, far beyond a 1.0m budget.
  const candidates = [player(100, 'MID', 20.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 1.0, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  assert.equal(swaps.some(s => s.inId === 100), false);
});

test('a bench-for-bench swap scores near zero on the Now lane', () => {
  const squad = squadOf15();
  // Player 12 (MID, 2.5xP) is the worst midfielder and sits on the bench.
  // Candidate 20 is barely better and would also sit on the bench.
  const candidates = [player(20, 'MID', 5.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const benchSwap = swaps.find(s => s.outId === 12 && s.inId === 20);
  assert.ok(benchSwap, 'the bench swap is enumerated');
  assert.ok(Math.abs(benchSwap.nearXiDelta) < 1.0,
    `bench churn must be near zero, got ${benchSwap.nearXiDelta}`);
});

test('a swap that promotes a player into the XI beats bench churn', () => {
  const squad = squadOf15();
  const candidates = [player(20, 'MID', 5.0), player(40, 'MID', 6.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const churn   = swaps.find(s => s.outId === 12 && s.inId === 20);
  const upgrade = swaps.find(s => s.outId === 12 && s.inId === 40);
  assert.ok(upgrade.nearXiDelta > churn.nearXiDelta,
    'the XI-reaching move must rank above the bench move');
});

test('enumerateSwaps flags whether the outgoing player was in the XI', () => {
  const squad = squadOf15();
  const candidates = [player(20, 'MID', 5.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const fromBench = swaps.find(s => s.outId === 12);
  const fromXi    = swaps.find(s => s.outId === 8);
  assert.equal(fromBench.flags.outInXi, false);
  assert.equal(fromXi.flags.outInXi, true);
});

test('enumerateSwaps returns an empty array for an incomplete squad', () => {
  const squad = squadOf15().slice(0, 10);
  const swaps = enumerateSwaps(squad.map(p => p.id), squad, stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  assert.deepEqual(swaps, []);
});
```

- [ ] **Step 2: Note that the test cannot be executed here**

No Node. Do not run `npm test`; do not record a pass. Step 5 runs equivalent assertions in the browser against live data.

- [ ] **Step 3: Write the implementation**

Create `js/engine/transfers.js`:

```js
/**
 * js/engine/transfers.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * Enumerates every legal transfer for a squad and scores each one on five
 * independent lanes. One enumeration pass, not five: the lanes must be
 * comparable for engine/strategy.js to state a margin between them, and a
 * single pass over a shared spine is what makes that honest.
 *
 * The spine is engine/lineup.js. A swap's worth is the change in the squad's
 * projected XI expected points — which is why bench-for-bench churn scores
 * near zero here however large the composite gap between the two players is.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md.
 */

import { scorePlayer as defaultScorePlayer, rankPlayers } from './composite.js';
import { pickStartingXI, calcXiExpectedPoints } from './lineup.js';
import {
  SQUAD_TOTAL, HIT_PENALTY, CANDIDATE_POOL_PER_POS,
  FUTURE_WINDOW_START, FUTURE_WINDOW_GWS,
} from '../config.js';

/**
 * Memoised scoring. The Planner re-renders on every budget keystroke, and a
 * naive implementation re-scores ~2,000 players each time; two windows would
 * double that. The cache is created per enumerateSwaps call and handed back to
 * the caller so it can survive across renders (see spec §11).
 */
function memoScore(cache, player, horizon, ctx, scoreFn) {
  const cached = cache.get(player.id);
  if (cached) return cached;
  let score;
  try {
    score = scoreFn(player, horizon, ctx);
  } catch {
    return null;
  }
  cache.set(player.id, score);
  return score;
}

/**
 * The top CANDIDATE_POOL_PER_POS players per position, by composite rank,
 * excluding anyone already in the squad.
 *
 * MODEL: bounding the pool by rank rather than scoring all ~700 players is what
 * keeps the enumeration affordable. A transfer target outside the top 40 of its
 * position is not a recommendation this tool would ever make, so nothing of
 * value is lost — but the bound is config, not a hard-coded assumption.
 *
 * @returns {Object<string, Player[]>}  keyed by position
 */
function buildCandidatePools(allPlayers, squadIds, horizon, ctx, scoreFn) {
  const squadSet = new Set(squadIds);
  const pools = { GKP: [], DEF: [], MID: [], FWD: [] };

  let ranked;
  try {
    ranked = rankPlayers(allPlayers, horizon, ctx);
  } catch {
    // Fall back to unranked order rather than returning nothing — a degraded
    // candidate list is still a usable planner (CONVENTIONS §9).
    ranked = allPlayers.map(player => ({ player }));
  }

  for (const row of ranked) {
    const player = row.player;
    const pool = pools[player?.position];
    if (!pool || squadSet.has(player.id)) continue;
    if (pool.length >= CANDIDATE_POOL_PER_POS) continue;
    pool.push(player);
  }
  return pools;
}

/** Replace one entry in a scored squad, returning a new array. */
function withSwap(entries, outId, inEntry) {
  return entries.map(e => (e.player.id === outId ? inEntry : e));
}

/**
 * Enumerate every legal single transfer and score it.
 *
 * @param {number[]} squadIds        the user's 15 player ids
 * @param {Player[]} allPlayers      the full player pool
 * @param {object}   ctx             from buildScoreContext()
 * @param {object}   opts            { horizon, budget, freeTransfers,
 *                                     allowExtraHit, scorePlayerFn?, caches? }
 * @returns {Array<Swap>}  unsorted; callers sort by whichever lane they render
 */
export function enumerateSwaps(squadIds, allPlayers, ctx, opts = {}) {
  const {
    horizon, budget = 0, freeTransfers = 1, allowExtraHit = false,
    scorePlayerFn = defaultScorePlayer, caches = null,
  } = opts;

  if (!Array.isArray(squadIds) || squadIds.length < SQUAD_TOTAL) return [];
  if (!horizon || !ctx) return [];

  const nearCache = caches?.near ?? new Map();
  const farCache  = caches?.far  ?? new Map();

  // The far window shifts the START of the fixture window, not the whole model.
  // MODEL: form terms stay measured from today because future form is not
  // knowable; only the fixtures being scored move forward.
  const farCtx = { ...ctx, currentGw: (ctx.currentGw ?? 1) + FUTURE_WINDOW_START };
  const farHorizon = { label: 'Future', gws: FUTURE_WINDOW_GWS };

  const byId = new Map(allPlayers.map(p => [p.id, p]));
  const scoreNear = p => memoScore(nearCache, p, horizon, ctx, scorePlayerFn);
  const scoreFar  = p => memoScore(farCache, p, farHorizon, farCtx, scorePlayerFn);

  // Baseline: the squad as it stands, in both windows.
  const nearEntries = [];
  const farEntries  = [];
  for (const id of squadIds) {
    const player = byId.get(id);
    if (!player) continue;
    const near = scoreNear(player);
    const far  = scoreFar(player);
    if (!near || !far) continue;
    nearEntries.push({ player, score: near });
    farEntries.push({ player, score: far });
  }
  if (nearEntries.length < SQUAD_TOTAL) return [];

  const baseNear = calcXiExpectedPoints(nearEntries);
  const baseFar  = calcXiExpectedPoints(farEntries);
  const baseXiIds = new Set(pickStartingXI(nearEntries).xi.map(e => e.player.id));

  const pools = buildCandidatePools(allPlayers, squadIds, horizon, ctx, scorePlayerFn);
  // A single transfer is free whenever at least one FT is available. The hit
  // only ever applies to a SECOND move, which computeBestTwoSwap models — so a
  // single swap carries a cost of 0 in every normal state of this page.
  const hitCost = freeTransfers >= 1 ? 0 : HIT_PENALTY;
  const swaps = [];

  for (const outEntry of nearEntries) {
    const outPlayer = outEntry.player;
    for (const inPlayer of pools[outPlayer.position] ?? []) {
      const priceDiff = (inPlayer.price ?? 0) - (outPlayer.price ?? 0);
      if (priceDiff > budget) continue;

      const inNear = scoreNear(inPlayer);
      const inFar  = scoreFar(inPlayer);
      if (!inNear || !inFar) continue;

      const nearAfter = withSwap(nearEntries, outPlayer.id, { player: inPlayer, score: inNear });
      const farAfter  = withSwap(farEntries,  outPlayer.id, { player: inPlayer, score: inFar });

      const nearXiDelta = calcXiExpectedPoints(nearAfter).value - baseNear.value;
      const farXiDelta  = calcXiExpectedPoints(farAfter).value  - baseFar.value;

      const afterXiIds = new Set(pickStartingXI(nearAfter).xi.map(e => e.player.id));

      swaps.push({
        outId: outPlayer.id,
        inId:  inPlayer.id,
        outPlayer,
        inPlayer,
        outScore: outEntry.score,
        inScore:  inNear,
        outFarScore: farEntries.find(e => e.player.id === outPlayer.id)?.score ?? null,
        inFarScore:  inFar,
        priceDiff,
        nearXiDelta,
        farXiDelta,
        lanes: {
          now: {
            value: nearXiDelta - hitCost,
            components: { nearXiDelta, hitCost },
            estimated: Boolean(inNear.expectedPoints?.estimated),
            reasoning: buildNowReasoning(outPlayer, inPlayer, nearXiDelta, hitCost),
          },
          future:    null,   // Task 4
          funds:     null,   // Task 4
          ceiling:   null,   // Task 4
          structure: null,   // Task 4
        },
        flags: {
          outInXi:      baseXiIds.has(outPlayer.id),
          inEntersXi:   afterXiIds.has(inPlayer.id),
          outUnavailable: outPlayer.status !== 'available',
        },
      });
    }
  }

  return swaps;
}

/**
 * Plain-language explanation of a Now-lane score. Built in the engine so the
 * module only renders it — the same contract engine/chips.js already follows.
 *
 * @returns {string}
 */
function buildNowReasoning(outPlayer, inPlayer, nearXiDelta, hitCost) {
  const gain = nearXiDelta.toFixed(1);
  const hit  = hitCost > 0 ? ` after a −${hitCost}pt hit` : '';
  if (Math.abs(nearXiDelta) < 0.2) {
    return `${inPlayer.name} for ${outPlayer.name} barely changes your XI — `
         + 'both would be substitutes, so the projected points are almost identical.';
  }
  return `${inPlayer.name} for ${outPlayer.name} is worth ${gain} points to your `
       + `starting XI over this horizon${hit}.`;
}
```

- [ ] **Step 4: Expose it for browser verification**

In `js/main.js`, import `enumerateSwaps` from `./engine/transfers.js` and add `enumerateSwaps,` to the `window.__engine` object literal.

- [ ] **Step 5: Execute the assertions in the browser, against live data**

Load `http://localhost:3000/#planner`, import a real squad (or build one), and run:

```js
const ctx    = window.__engine.context();
const squad  = window.__store.getSquad();
const all    = window.__store.getPlayers();
const t0     = performance.now();
const swaps  = window.__engine.enumerateSwaps(squad, all, ctx, {
  horizon: window.__horizons.GW3, budget: 2.0, freeTransfers: 1, allowExtraHit: false,
});
const ms = performance.now() - t0;

const samePos   = swaps.every(s => s.outPlayer.position === s.inPlayer.position);
const inBudget  = swaps.every(s => s.priceDiff <= 2.0);
const benchOnly = swaps.filter(s => !s.flags.outInXi && !s.flags.inEntersXi);
const reaching  = swaps.filter(s => s.flags.inEntersXi);

console.table([
  { check: 'swaps produced',            value: swaps.length,  pass: swaps.length > 0 },
  { check: 'all same position',         value: samePos,       pass: samePos },
  { check: 'all within budget',         value: inBudget,      pass: inBudget },
  { check: 'bench-only churn near zero',
    value: Math.max(...benchOnly.map(s => Math.abs(s.nearXiDelta))).toFixed(2),
    pass: benchOnly.every(s => Math.abs(s.nearXiDelta) < 1.0) },
  { check: 'best XI-reaching beats best bench churn',
    value: `${Math.max(...reaching.map(s => s.nearXiDelta)).toFixed(2)} vs ${Math.max(...benchOnly.map(s => s.nearXiDelta)).toFixed(2)}`,
    pass: Math.max(...reaching.map(s => s.nearXiDelta)) > Math.max(...benchOnly.map(s => s.nearXiDelta)) },
  { check: 'enumeration under 1500ms',  value: ms.toFixed(0), pass: ms < 1500 },
]);
```

Every row must read `pass: true`. **The third and fourth rows are the whole point of this change** — if bench churn is not near zero, or does not rank below an XI-reaching move, stop and diagnose before continuing.

- [ ] **Step 6: Commit**

```bash
git add js/engine/transfers.js tests/engine/transfers.test.js js/main.js
git commit -m "feat(engine/transfers): enumerate swaps and score the Now lane

Measures a swap as the change in projected XI expected points rather
than as a composite-score delta, which is what made a 0-point sub for a
2-point sub outrank a real upgrade. Scores each candidate in both the
active horizon and a deferred window, memoised per player.

Tests written but not run — no Node on this machine. Assertions were
executed in the browser against a live squad.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `engine/transfers.js` — the four remaining lanes

**Files:**
- Modify: `js/engine/transfers.js` (fill the four `null` lanes)
- Modify: `tests/engine/transfers.test.js` (append lane tests)
- Modify: `js/main.js` (expose `calcSquadFlexibility`)

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:
  - `calcSquadFlexibility(squadPlayers, scoresById) → { value, components: { spread, headroom }, estimated }` — value 0–100, higher = more flexible.
  - `swap.lanes.future`, `.funds`, `.ceiling`, `.structure`, each `{ value, components, estimated, reasoning }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/transfers.test.js`:

```js
import { calcSquadFlexibility } from '../../js/engine/transfers.js';

test('calcSquadFlexibility scores a price-clumped squad below a spread one', () => {
  const clumped = Array.from({ length: 15 }, (_, i) => player(i + 1, 'MID', 7.0));
  const spread  = Array.from({ length: 15 }, (_, i) => player(i + 1, 'MID', 4.0 + i * 0.7));
  const scores  = new Map(clumped.map(p => [p.id, stubScorer(p)]));
  const clumpedScore = calcSquadFlexibility(clumped, scores).value;
  const spreadScore  = calcSquadFlexibility(spread,  scores).value;
  assert.ok(spreadScore > clumpedScore,
    `spread ${spreadScore} should beat clumped ${clumpedScore}`);
});

test('calcSquadFlexibility stays within 0-100', () => {
  const squad  = squadOf15();
  const scores = new Map(squad.map(p => [p.id, stubScorer(p)]));
  const result = calcSquadFlexibility(squad, scores);
  assert.ok(result.value >= 0 && result.value <= 100, `got ${result.value}`);
});

test('the Future lane ranks by swing, not by raw far-window value', () => {
  // Two candidates with identical far-window value; only their NEAR value
  // differs. The one that is worse now — and therefore swings harder — must
  // score higher on the Future lane.
  const squad = squadOf15();
  const steady = player(30, 'MID', 7.0);
  const riser  = player(31, 'MID', 7.0);
  const scorer = (p, horizon) => {
    const isFar = horizon.label === 'Future';
    if (p.id === 30) return { ...stubScorer(p), expectedPoints: { value: 6, estimated: false } };
    if (p.id === 31) return {
      ...stubScorer(p),
      expectedPoints: { value: isFar ? 6 : 1, estimated: false },
    };
    return stubScorer(p);
  };
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, steady, riser], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: scorer,
  });
  const steadySwap = swaps.find(s => s.inId === 30 && s.outId === 12);
  const riserSwap  = swaps.find(s => s.inId === 31 && s.outId === 12);
  assert.ok(riserSwap.lanes.future.value > steadySwap.lanes.future.value,
    'the player who improves later must win the Future lane');
});

test('the Structure lane stays silent when the outgoing player is fine', () => {
  const squad = squadOf15();
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 6.0)], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  // Every stub player is available with playtime 0.9 — nothing is broken.
  assert.ok(swaps.every(s => s.lanes.structure.value === 0),
    'a healthy squad produces no Structure Fix candidates');
});

test('the Structure lane fires for an unavailable XI player', () => {
  const squad = squadOf15();
  squad[7].status = 'injured';                       // player 8, the 12.0m MID
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 12.0)], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const fix = swaps.find(s => s.outId === 8 && s.inId === 40);
  assert.ok(fix.lanes.structure.value > 0, 'an injured starter is a structure problem');
});
```

- [ ] **Step 2: Note that the tests cannot be executed here**

No Node. Step 5 runs the equivalents in the browser.

- [ ] **Step 3: Add the flexibility model**

Append to `js/engine/transfers.js`:

```js
/**
 * How freely a squad can be restructured, 0–100, higher = more flexible.
 *
 * Two components, weighted by config:
 *
 *  • SPREAD — how much of the squad sits clumped inside one narrow price band.
 *    A squad with six players between 7.0m and 7.6m cannot upgrade any of them
 *    without selling two, which is exactly the trap this measures.
 *  • HEADROOM — how much cash the four most disposable outfield players would
 *    raise, as a fraction of FLEX_HEADROOM_TARGET.
 *
 * MODEL: both components are kept because the constraint has two readings and
 * live use has not settled which dominates. See spec §7.1 — resolving it is a
 * weight change in config.js, not a rewrite here.
 *
 * @param {Player[]} squadPlayers
 * @param {Map<number, object>} scoresById  scorePlayer results, for disposability
 * @returns {{ value: number, components: {spread: number, headroom: number},
 *             estimated: boolean }}
 */
export function calcSquadFlexibility(squadPlayers, scoresById) {
  const players = (squadPlayers ?? []).filter(p => typeof p?.price === 'number');
  if (players.length < 2) {
    return { value: 50, components: { spread: 50, headroom: 50 }, estimated: true };
  }

  // Spread: the average share of the squad sitting within FLEX_CLUMP_BAND of
  // each player. All-identical prices → clumpiness 1 → spread 0.
  let clumpTotal = 0;
  for (const a of players) {
    const near = players.filter(b =>
      b.id !== a.id && Math.abs((b.price ?? 0) - (a.price ?? 0)) <= FLEX_CLUMP_BAND);
    clumpTotal += near.length / (players.length - 1);
  }
  const clumpiness = clumpTotal / players.length;
  const spread = clamp(0, 100, (1 - clumpiness) * 100);

  // Headroom: cash raisable from the four most disposable outfield players,
  // "disposable" being lowest expected points.
  const outfield = players
    .filter(p => p.position !== 'GKP')
    .sort((a, b) =>
      (scoresById?.get(a.id)?.expectedPoints?.value ?? 0)
      - (scoresById?.get(b.id)?.expectedPoints?.value ?? 0));
  const raisable = outfield.slice(0, BENCH_SIZE)
    .reduce((sum, p) => sum + (p.price ?? 0), 0);
  const headroom = clamp(0, 100, (raisable / FLEX_HEADROOM_TARGET) * 100);

  return {
    value: clamp(0, 100, (FLEX_W_SPREAD * spread) + (FLEX_W_HEADROOM * headroom)),
    components: { spread, headroom },
    estimated: !scoresById || scoresById.size === 0,
  };
}
```

Extend the imports at the top of the file:

```js
import { clamp } from '../util.js';
import {
  SQUAD_TOTAL, BENCH_SIZE, HIT_PENALTY, CANDIDATE_POOL_PER_POS,
  FUTURE_WINDOW_START, FUTURE_WINDOW_GWS, FUTURE_MIN_FAR_GAIN,
  FLEX_W_SPREAD, FLEX_W_HEADROOM, FLEX_CLUMP_BAND, FLEX_HEADROOM_TARGET,
  CEILING_W_PEAK, CEILING_W_HAUL, HAUL_POINTS_THRESHOLD,
  STRUCTURE_PLAYTIME_FLOOR,
} from '../config.js';
import { applyDgwUplift, calcExpectedPoints } from './composite.js';
import { groupPerGwSlots } from './fixtures.js';
```

- [ ] **Step 4: Add the four lane scorers and wire them in**

Append these four functions to `js/engine/transfers.js`:

```js
/**
 * Future Prep — ranked by SWING, the amount by which a player's deferred window
 * beats their near one.
 *
 * MODEL: ranking the far window by raw projection would mostly re-list the Now
 * board, because a genuinely good player is good in both windows. Swing isolates
 * the move that is specifically about the future: rough next two, green
 * following four — the buy-before-the-price-rises decision this board exists for.
 */
function scoreFutureLane(swap) {
  const swing = swap.farXiDelta - swap.nearXiDelta;
  const qualifies = swap.farXiDelta > FUTURE_MIN_FAR_GAIN;
  return {
    value: qualifies ? swing : 0,
    components: { swing, farXiDelta: swap.farXiDelta, nearXiDelta: swap.nearXiDelta },
    estimated: Boolean(swap.inFarScore?.expectedPoints?.estimated),
    reasoning: qualifies
      ? `${swap.inPlayer.name}'s fixtures improve later: worth `
        + `${swap.farXiDelta.toFixed(1)} points over the deferred window versus `
        + `${swap.nearXiDelta.toFixed(1)} right now — a swing of ${swing.toFixed(1)}.`
      : `${swap.inPlayer.name} does not improve enough later to be a future-prep buy.`,
  };
}

/**
 * Funds & Flexibility — flexibility gained per expected point given up.
 * A move that frees cash and unclumps the squad while costing almost nothing
 * in points scores highest.
 */
function scoreFundsLane(swap, flexBefore, flexAfter, priceRisk) {
  const flexGain    = flexAfter.value - flexBefore.value;
  const cashFreed   = -swap.priceDiff;
  const pointsGiven = Math.max(0, -swap.nearXiDelta);
  // +1 keeps a free move from dividing by zero and reporting infinite value.
  const value = flexGain / (pointsGiven + 1);
  return {
    value,
    components: { flexGain, cashFreed, pointsGiven, priceRisk: priceRisk?.direction ?? 'stable' },
    estimated: flexBefore.estimated || flexAfter.estimated,
    reasoning: `Frees £${cashFreed.toFixed(1)}m and moves squad flexibility by `
             + `${flexGain.toFixed(0)} points, at a cost of ${pointsGiven.toFixed(1)} `
             + 'projected points.',
  };
}

/**
 * Ceiling — the best SINGLE gameweek in the window, blended with how often the
 * player has actually hauled.
 *
 * MODEL: FPL exposes no variance data. Haul rate from per-GW history is a
 * backward-looking proxy, thin for players with few starts, and summaries load
 * lazily so it is often absent entirely. This lane flags itself estimated
 * whenever the summary is missing and must never present as being as solid as
 * the Now lane. See spec §7.1.
 */
function scoreCeilingLane(swap, ctx) {
  const score   = swap.inScore;
  const summary = ctx?.playerSummariesById?.[swap.inId] ?? null;

  const slots = groupPerGwSlots(score?.perGw ?? []);
  let peakGwValue = 0;
  for (const slot of slots) {
    const raw = slot.fixtures.reduce((s, f) => s + (f.value ?? 0), 0)
              / Math.max(1, slot.fixtures.length);
    peakGwValue = Math.max(peakGwValue, applyDgwUplift(raw, slot.fixtures.length));
  }

  const peak = calcExpectedPoints(
    score?.avgPointsPerGw ?? { value: 0, estimated: true },
    { value: peakGwValue },
    score?.breakdown?.minutes ?? { value: 50, estimated: true },
    1,
  );

  const history = summary?.history ?? [];
  const played  = history.filter(h => (h.minutes ?? 0) > 0);
  const hauls   = played.filter(h => (h.points ?? 0) >= HAUL_POINTS_THRESHOLD);
  const haulRate = played.length > 0 ? hauls.length / played.length : 0;

  const value = (CEILING_W_PEAK * peak.value) + (CEILING_W_HAUL * haulRate * peak.value);

  return {
    value,
    components: { peak: peak.value, haulRate, hauls: hauls.length, played: played.length },
    estimated: played.length === 0 || peak.estimated,
    reasoning: played.length === 0
      ? `${swap.inPlayer.name}'s peak week projects at ${peak.value.toFixed(1)} points, `
        + 'but no gameweek history has loaded yet — treat this as a rough estimate.'
      : `${swap.inPlayer.name} has hauled in ${hauls.length} of ${played.length} `
        + `appearances, with a peak week projecting ${peak.value.toFixed(1)} points.`,
  };
}

/**
 * Structure Fix — repairs a broken slot in the STARTING XI. Silent otherwise:
 * a swap involving a healthy bench player is not a structure problem, and the
 * board says "nothing broken" rather than padding itself.
 */
function scoreStructureLane(swap) {
  if (!swap.flags.outInXi) {
    return {
      value: 0, components: {}, estimated: false,
      reasoning: `${swap.outPlayer.name} is not in your projected XI, so this is `
               + 'not a structural repair.',
    };
  }

  const unavailable = swap.outPlayer.status !== 'available';
  const playtime    = swap.outScore?.breakdown?.playtime?.value ?? 1;
  const lowPlaytime = playtime < STRUCTURE_PLAYTIME_FLOOR;

  if (!unavailable && !lowPlaytime) {
    return {
      value: 0, components: { playtime }, estimated: false,
      reasoning: `${swap.outPlayer.name} is fit and starting — nothing to repair.`,
    };
  }

  const cause = unavailable
    ? `${swap.outPlayer.name} is flagged ${swap.outPlayer.status}`
    : `${swap.outPlayer.name} is barely starting (playtime ${(playtime * 100).toFixed(0)}%)`;

  return {
    value: Math.max(0, swap.nearXiDelta),
    components: { playtime, unavailable },
    estimated: Boolean(swap.outScore?.breakdown?.playtime?.estimated),
    reasoning: `${cause}. Replacing him with ${swap.inPlayer.name} restores `
             + `${Math.max(0, swap.nearXiDelta).toFixed(1)} points to your XI.`,
  };
}
```

Then in `enumerateSwaps`, replace the four `null` lane placeholders. Before the swap loop, compute the baseline flexibility once:

```js
  const squadPlayers = nearEntries.map(e => e.player);
  const scoresById   = new Map(nearEntries.map(e => [e.player.id, e.score]));
  const flexBefore   = calcSquadFlexibility(squadPlayers, scoresById);
```

and inside the loop, after `afterXiIds` is computed:

```js
      const afterPlayers = squadPlayers.map(p => (p.id === outPlayer.id ? inPlayer : p));
      const afterScores  = new Map(scoresById);
      afterScores.delete(outPlayer.id);
      afterScores.set(inPlayer.id, inNear);
      const flexAfter = calcSquadFlexibility(afterPlayers, afterScores);
      const priceRisk = calcPriceChangeRisk(inPlayer);
```

Task 3 pushes the swap object into `swaps` inline. Change that to bind it first, because the four lane scorers take the finished swap as their argument. Replace `swaps.push({ … });` with `const swap = { … };` — the same object literal, unchanged — and then add:

```js
      swap.lanes.future    = scoreFutureLane(swap);
      swap.lanes.funds     = scoreFundsLane(swap, flexBefore, flexAfter, priceRisk);
      swap.lanes.ceiling   = scoreCeilingLane(swap, ctx);
      swap.lanes.structure = scoreStructureLane(swap);
      swaps.push(swap);
```

Add `import { calcPriceChangeRisk } from './prices.js';` to the imports.

- [ ] **Step 5: Execute the assertions in the browser**

Load `http://localhost:3000/#planner` with a real squad and run:

```js
const ctx = window.__engine.context();
const swaps = window.__engine.enumerateSwaps(
  window.__store.getSquad(), window.__store.getPlayers(), ctx,
  { horizon: window.__horizons.GW3, budget: 2.0, freeTransfers: 1, allowExtraHit: false });

const flex = window.__engine.calcSquadFlexibility(
  window.__store.getSquad().map(id => window.__store.getPlayer(id)), new Map());

const allLanes = swaps.every(s =>
  s.lanes.now && s.lanes.future && s.lanes.funds && s.lanes.ceiling && s.lanes.structure);
const finite = swaps.every(s =>
  Object.values(s.lanes).every(l => Number.isFinite(l.value)));
const reasoned = swaps.every(s =>
  Object.values(s.lanes).every(l => typeof l.reasoning === 'string' && l.reasoning.length > 0));
const structureQuiet = swaps
  .filter(s => !s.flags.outInXi)
  .every(s => s.lanes.structure.value === 0);

console.table([
  { check: 'all five lanes present',      pass: allLanes },
  { check: 'no NaN or Infinity',          pass: finite },
  { check: 'every lane explains itself',  pass: reasoned },
  { check: 'structure silent off the XI', pass: structureQuiet },
  { check: 'flexibility in 0-100',        value: flex.value.toFixed(0),
    pass: flex.value >= 0 && flex.value <= 100 },
]);

// Eyeball the top of each lane — these should look like different lists.
for (const lane of ['now', 'future', 'funds', 'ceiling']) {
  const top = [...swaps].sort((a, b) => b.lanes[lane].value - a.lanes[lane].value).slice(0, 3);
  console.log(lane, top.map(s => `${s.outPlayer.name}>${s.inPlayer.name} ${s.lanes[lane].value.toFixed(1)}`));
}
```

All rows must pass. The four lane listings must **not** be identical — if `now` and `future` return the same three swaps in the same order, the swing model is not doing its job; stop and diagnose.

- [ ] **Step 6: Commit**

```bash
git add js/engine/transfers.js tests/engine/transfers.test.js js/main.js
git commit -m "feat(engine/transfers): add future, funds, ceiling and structure lanes

Future Prep ranks by fixture swing rather than raw far-window value, so
it surfaces buy-before-the-run moves instead of re-listing the Now board.
Funds scores flexibility gained per point sacrificed, with squad
flexibility modelled as price clumping plus sellable headroom. Ceiling
blends peak week with haul rate and flags itself estimated when player
history has not loaded. Structure Fix stays silent unless a starting XI
player is flagged or barely playing.

Tests written but not run — no Node. Assertions executed in the browser.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `engine/strategy.js` — the verdict

**Files:**
- Create: `js/engine/strategy.js`
- Create: `tests/engine/strategy.test.js`
- Modify: `js/main.js` (expose `buildVerdict`)

**Interfaces:**
- Consumes: `Swap[]` from Task 4; `scoreWildcardTiming` etc. from `engine/chips.js`; config from Task 1.
- Produces: `buildVerdict(swaps, squadState, ctx) → Verdict`
  - `squadState` is `{ flexibility, xiEntries, freeTransfers, chipRecs }`
  - `Verdict` is `{ lane, laneScore, margin, confidence, bestSwap, alternatives, triggers, reasoning, estimated }`
  - `confidence` ∈ `'dominant' | 'clear' | 'close'`
  - `lane` ∈ `'now' | 'future' | 'funds' | 'ceiling' | 'structure' | 'roll'`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/strategy.test.js`:

```js
/**
 * tests/engine/strategy.test.js
 * Unit tests for engine/strategy.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerdict } from '../../js/engine/strategy.js';

/** A swap whose lanes can be set individually. */
function swapWith(lanes) {
  const base = { now: 0, future: 0, funds: 0, ceiling: 0, structure: 0 };
  const merged = { ...base, ...lanes };
  return {
    outId: 1, inId: 2,
    outPlayer: { id: 1, name: 'Out', status: 'available' },
    inPlayer:  { id: 2, name: 'In',  status: 'available' },
    priceDiff: 0, nearXiDelta: merged.now, farXiDelta: 0,
    flags: { outInXi: true, inEntersXi: true, outUnavailable: false },
    lanes: Object.fromEntries(Object.entries(merged).map(([k, v]) =>
      [k, { value: v, components: {}, estimated: false, reasoning: `${k} reasoning` }])),
  };
}

function squadState(overrides = {}) {
  return {
    flexibility: { value: 70, components: {}, estimated: false },
    xiEntries: [],
    freeTransfers: 1,
    chipRecs: {},
    ...overrides,
  };
}

test('buildVerdict rolls the transfer when nothing clears the threshold', () => {
  const verdict = buildVerdict([swapWith({ now: 0.1 })], squadState(), { currentGw: 10 });
  assert.equal(verdict.lane, 'roll');
});

test('buildVerdict names the winning lane when one move is strong', () => {
  const verdict = buildVerdict([swapWith({ now: 9.0 })], squadState(), { currentGw: 10 });
  assert.equal(verdict.lane, 'now');
  assert.ok(verdict.laneScore > 0);
});

test('buildVerdict reports close when the top two lanes are near-tied', () => {
  // Now and Future both land at roughly the same normalised score.
  const verdict = buildVerdict(
    [swapWith({ now: 6.0 }), swapWith({ future: 8.0 })],
    squadState(), { currentGw: 10 });
  assert.equal(verdict.confidence, 'close');
  assert.ok(verdict.alternatives.length >= 1, 'a close call names its rival');
});

test('buildVerdict reports dominant when one lane is far ahead', () => {
  const verdict = buildVerdict(
    [swapWith({ now: 20.0 }), swapWith({ funds: 1.0 })],
    squadState(), { currentGw: 10 });
  assert.equal(verdict.confidence, 'dominant');
});

test('an unavailable XI player fires the xiPlayerUnavailable trigger', () => {
  const swap = swapWith({ now: 5.0 });
  swap.outPlayer.status = 'injured';
  swap.flags.outUnavailable = true;
  const verdict = buildVerdict([swap], squadState(), { currentGw: 10 });
  assert.ok(verdict.triggers.some(t => t.id === 'xiPlayerUnavailable'));
});

test('low flexibility fires the cashCrunch trigger', () => {
  const verdict = buildVerdict(
    [swapWith({ now: 5.0 })],
    squadState({ flexibility: { value: 10, components: {}, estimated: false } }),
    { currentGw: 10 });
  assert.ok(verdict.triggers.some(t => t.id === 'cashCrunch'));
});

test('a chip window within range fires the chipWindow trigger', () => {
  const verdict = buildVerdict(
    [swapWith({ now: 5.0 })],
    squadState({ chipRecs: { triplecaptain: { gw: 11, reasoning: 'big double' } } }),
    { currentGw: 10 });
  assert.ok(verdict.triggers.some(t => t.id === 'chipWindow'));
});

test('buildVerdict downgrades its confidence when the winning lane is estimated', () => {
  const swap = swapWith({ now: 20.0 });
  swap.lanes.now.estimated = true;
  const verdict = buildVerdict([swap], squadState(), { currentGw: 10 });
  assert.equal(verdict.estimated, true);
  assert.notEqual(verdict.confidence, 'dominant');
});

test('buildVerdict survives an empty swap list', () => {
  const verdict = buildVerdict([], squadState(), { currentGw: 10 });
  assert.equal(verdict.lane, 'roll');
  assert.ok(typeof verdict.reasoning === 'string' && verdict.reasoning.length > 0);
});
```

- [ ] **Step 2: Note that the test cannot be executed here**

No Node. Step 5 runs the equivalents in the browser.

- [ ] **Step 3: Write the implementation**

Create `js/engine/strategy.js`:

```js
/**
 * js/engine/strategy.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * Turns the five lane scores from engine/transfers.js into one weekly verdict:
 * which lane to act on, how far ahead of the runner-up it is, and which hard
 * conditions — an injured starter, a chip window, a cash crunch — override the
 * arithmetic.
 *
 * "Roll the transfer" is a lane here, not a fallback. A planner that always
 * recommends something is the failure this module exists to prevent.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §8.
 */

import { clamp } from '../util.js';
import {
  LANE_SCALE_NOW, LANE_SCALE_FUTURE, LANE_SCALE_FUNDS,
  LANE_SCALE_CEILING, LANE_SCALE_STRUCTURE,
  VERDICT_ACT_THRESHOLD, VERDICT_MARGIN_CLEAR, VERDICT_MARGIN_DOMINANT,
  CHIP_WINDOW_GWS, FLEX_FLOOR,
} from '../config.js';

/** Lane id → the config divisor that maps its natural unit onto 0–100. */
const LANE_SCALES = {
  now:       LANE_SCALE_NOW,
  future:    LANE_SCALE_FUTURE,
  funds:     LANE_SCALE_FUNDS,
  ceiling:   LANE_SCALE_CEILING,
  structure: LANE_SCALE_STRUCTURE,
};

/** Human labels, used in the reasoning strings this module builds. */
const LANE_LABELS = {
  now:       'Now',
  future:    'Future Prep',
  funds:     'Funds & Flexibility',
  ceiling:   'Ceiling',
  structure: 'Structure Fix',
  roll:      'Roll the transfer',
};

/**
 * Map a lane's natural unit onto 0–100.
 *
 * MODEL: this is the load-bearing and most arbitrary step in the design.
 * Without a shared scale, "a swing of +6" and "frees £0.5m" have no common
 * language and the margin below is meaningless. The divisors are calibration
 * targets, not truths — the first thing to tune against realised results per
 * ROADMAP.md Phase 3B.
 *
 * @returns {number}  0–100, higher = a stronger case for acting on this lane
 */
function normaliseLaneValue(laneId, value) {
  const scale = LANE_SCALES[laneId] ?? 1;
  return clamp(0, 100, (value / scale) * 100);
}

/** The best swap on each lane, with its normalised score. */
function rankLanes(swaps) {
  const rows = [];
  for (const laneId of Object.keys(LANE_SCALES)) {
    let best = null;
    for (const swap of swaps) {
      const lane = swap.lanes?.[laneId];
      if (!lane || !Number.isFinite(lane.value)) continue;
      if (!best || lane.value > best.lanes[laneId].value) best = swap;
    }
    if (!best) continue;
    const raw = best.lanes[laneId].value;
    rows.push({
      laneId,
      swap: best,
      raw,
      score: normaliseLaneValue(laneId, raw),
      estimated: Boolean(best.lanes[laneId].estimated),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/**
 * Hard conditions that may promote a lane past the arithmetic. Each carries its
 * own headline reason and is always reported — a trigger never silently
 * reorders anything.
 *
 * @returns {Array<{id: string, laneId: string, message: string}>}
 */
function detectTriggers(swaps, squadState, ctx) {
  const triggers = [];

  const brokenStarter = swaps.find(s => s.flags?.outInXi && s.flags?.outUnavailable);
  if (brokenStarter) {
    triggers.push({
      id: 'xiPlayerUnavailable',
      laneId: 'structure',
      message: `${brokenStarter.outPlayer.name} is in your projected XI and is `
             + `flagged ${brokenStarter.outPlayer.status}.`,
    });
  }

  const flexibility = squadState?.flexibility?.value ?? 100;
  if (flexibility < FLEX_FLOOR) {
    triggers.push({
      id: 'cashCrunch',
      laneId: 'funds',
      message: `Squad flexibility is ${flexibility.toFixed(0)} — your money is `
             + 'clumped tightly enough that upgrading anyone is getting hard.',
    });
  }

  const currentGw = ctx?.currentGw ?? 0;
  for (const [chipId, rec] of Object.entries(squadState?.chipRecs ?? {})) {
    const gw = rec?.gw;
    if (typeof gw !== 'number') continue;
    if (gw - currentGw > CHIP_WINDOW_GWS || gw < currentGw) continue;
    triggers.push({
      id: 'chipWindow',
      laneId: chipId === 'triplecaptain' ? 'ceiling' : 'future',
      message: `${chipId} looks strongest in GW${gw}, ${gw - currentGw} gameweek(s) `
             + 'away — plan transfers around it.',
    });
  }

  const risingTarget = swaps.find(s =>
    s.lanes?.funds?.components?.priceRisk === 'rise' && s.lanes?.now?.value > 0);
  if (risingTarget) {
    triggers.push({
      id: 'priceDeadline',
      laneId: 'funds',
      message: `${risingTarget.inPlayer.name} is trending towards a price rise — `
             + 'buying later costs more.',
    });
  }

  return triggers;
}

/**
 * Build the week's verdict.
 *
 * @param {Array<Swap>} swaps       from enumerateSwaps()
 * @param {object} squadState       { flexibility, xiEntries, freeTransfers, chipRecs }
 * @param {object} ctx              from buildScoreContext()
 * @returns {{ lane, laneScore, margin, confidence, bestSwap, alternatives,
 *             triggers, reasoning, estimated }}
 */
export function buildVerdict(swaps, squadState, ctx) {
  const triggers = detectTriggers(swaps ?? [], squadState ?? {}, ctx ?? {});
  const ranked   = rankLanes(swaps ?? []);
  const leader   = ranked[0] ?? null;

  if (!leader || leader.score < VERDICT_ACT_THRESHOLD) {
    return {
      lane: 'roll',
      laneScore: leader?.score ?? 0,
      margin: 0,
      confidence: 'clear',
      bestSwap: null,
      alternatives: [],
      triggers,
      estimated: Boolean(leader?.estimated),
      reasoning: leader
        ? `Nothing on the board is worth a transfer this week — the best move, `
          + `${LANE_LABELS[leader.laneId]}, scores ${leader.score.toFixed(0)} against a `
          + `threshold of ${VERDICT_ACT_THRESHOLD}. Roll it and bank the transfer.`
        : 'No legal transfers are available within your budget. Roll it.',
    };
  }

  const runnerUp = ranked[1] ?? null;
  const margin   = runnerUp ? leader.score - runnerUp.score : leader.score;

  let confidence = 'close';
  if (margin >= VERDICT_MARGIN_DOMINANT)   confidence = 'dominant';
  else if (margin >= VERDICT_MARGIN_CLEAR) confidence = 'clear';

  // Honesty rule: an estimated winner never speaks with the same certainty as a
  // measured one. See spec §8.4.
  const estimated = leader.estimated;
  if (estimated && confidence === 'dominant') confidence = 'clear';
  else if (estimated && confidence === 'clear') confidence = 'close';

  const alternatives = ranked.slice(1)
    .filter(row => leader.score - row.score < VERDICT_MARGIN_CLEAR)
    .map(row => ({ lane: row.laneId, label: LANE_LABELS[row.laneId], score: row.score }));

  const laneLabel = LANE_LABELS[leader.laneId];
  const headline =
      confidence === 'dominant' ? `${laneLabel} is in a different league this week.`
    : confidence === 'clear'    ? `${laneLabel}, clearly.`
    : `Close call — ${laneLabel}, but ${alternatives.map(a => a.label).join(' and ')} `
      + `${alternatives.length === 1 ? 'is' : 'are'} within ${VERDICT_MARGIN_CLEAR} points.`;

  const triggerNote = triggers.length > 0
    ? ` ${triggers.map(t => t.message).join(' ')}`
    : '';
  const estimatedNote = estimated
    ? ' Some of the inputs behind this are estimated, so treat it as a lean rather '
      + 'than a certainty.'
    : '';

  return {
    lane: leader.laneId,
    laneScore: leader.score,
    margin,
    confidence,
    bestSwap: leader.swap,
    alternatives,
    triggers,
    estimated,
    reasoning: `${headline} ${leader.swap.lanes[leader.laneId].reasoning}`
             + `${triggerNote}${estimatedNote}`,
  };
}
```

- [ ] **Step 4: Expose it for browser verification**

In `js/main.js`, import `buildVerdict` from `./engine/strategy.js` and add `buildVerdict,` to `window.__engine`.

- [ ] **Step 5: Execute the assertions in the browser**

Load `http://localhost:3000/#planner` with a real squad and run:

```js
const ctx = window.__engine.context();
const squadPlayers = window.__store.getSquad().map(id => window.__store.getPlayer(id));
const swaps = window.__engine.enumerateSwaps(
  window.__store.getSquad(), window.__store.getPlayers(), ctx,
  { horizon: window.__horizons.GW3, budget: 2.0, freeTransfers: 1, allowExtraHit: false });

const state = {
  flexibility: window.__engine.calcSquadFlexibility(squadPlayers, new Map()),
  xiEntries: [], freeTransfers: 1, chipRecs: {},
};
const verdict = window.__engine.buildVerdict(swaps, state, ctx);
console.log(verdict.lane, verdict.confidence, verdict.margin.toFixed(1));
console.log(verdict.reasoning);

// Force the roll path: no swap can clear the threshold from an empty list.
const rolled = window.__engine.buildVerdict([], state, ctx);

// Force a cash crunch.
const crunched = window.__engine.buildVerdict(swaps,
  { ...state, flexibility: { value: 5, components: {}, estimated: false } }, ctx);

console.table([
  { check: 'verdict names a valid lane',
    pass: ['now','future','funds','ceiling','structure','roll'].includes(verdict.lane) },
  { check: 'confidence is one of three',
    pass: ['dominant','clear','close'].includes(verdict.confidence) },
  { check: 'reasoning is non-empty',
    pass: typeof verdict.reasoning === 'string' && verdict.reasoning.length > 20 },
  { check: 'empty swap list rolls',      pass: rolled.lane === 'roll' },
  { check: 'low flexibility triggers cashCrunch',
    pass: crunched.triggers.some(t => t.id === 'cashCrunch') },
  { check: 'close calls name alternatives',
    pass: verdict.confidence !== 'close' || verdict.alternatives.length >= 1 },
]);
```

All rows must pass.

- [ ] **Step 6: Commit**

```bash
git add js/engine/strategy.js tests/engine/strategy.test.js js/main.js
git commit -m "feat(engine/strategy): pick a lane and state the verdict's confidence

Normalises the five lanes onto one scale so a margin between them means
something, then reports dominant, clear or close. Rolling the transfer is
a lane rather than a fallback, so a week with nothing worth doing says so.
Four triggers can promote a lane past the arithmetic and always name
themselves. An estimated winner is downgraded one confidence step.

Tests written but not run — no Node. Assertions executed in the browser.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Saved FPL picks through import and store

**Files:**
- Modify: `js/squadImport.js:104-127`
- Modify: `js/store.js:72-76, 129, 221-234, 287-299`
- Modify: `js/modules/planner.js` (`handleImport`, `replaceSquad`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `fetchAndMapSquad(teamId, gw)` gains `picks: Array<{playerId, slot, isCaptain, isViceCaptain}>` in its result.
  - `store.setSquadPicks(picks)`, `store.getSquadPicks()`, `store.getSavedXi() → number[]` (player ids in saved slots 1–11, or `[]` when no picks are held).

- [ ] **Step 1: Return picks from the import**

In `js/squadImport.js`, extend the `ImportResult` typedef and the mapping loop. Replace the loop body so it collects both shapes:

```js
  const playerIds = [];
  const picks     = [];
  let missingCount = 0;

  for (const pick of rawPicks) {
    const id = pick?.element;
    if (!Number.isInteger(id)) continue;
    const player = store.getPlayer(id);
    if (!player) {
      missingCount++;
      continue;
    }
    playerIds.push(id);
    // Slot 1–11 is the XI, 12–15 the bench in priority order. Kept because the
    // Planner compares the team you actually set against the one the model
    // would pick — a difference the app was previously blind to.
    picks.push({
      playerId:       id,
      slot:           pick.position ?? null,
      isCaptain:      Boolean(pick.is_captain),
      isViceCaptain:  Boolean(pick.is_vice_captain),
    });
  }

  return { playerIds, picks, entryInfo, missingCount };
```

Update the typedef above the function to document `picks`.

> Note: `pick.position`, `pick.is_captain` and `pick.is_vice_captain` are raw FPL field names. `CONVENTIONS.md` §3.1 confines those to `normalise.js` — this is the one read, and it is converted to internal names (`slot`, `isCaptain`, `isViceCaptain`) on the same line, which is the spirit of the rule.

- [ ] **Step 2: Add `squadPicks` to the store**

In `js/store.js`:

1. Add a session-storage key beside `SS_KEY_SQUAD`:

```js
// Saved FPL pick order from the last import: which players the user actually
// has on the pitch and on the bench, plus the armband. Cleared by any manual
// squad edit — see setSquad.
const SS_KEY_PICKS = 'gafferiq_squad_picks';
```

2. Add to `state` beside `squad: []`:

```js
  // Array<{playerId, slot, isCaptain, isViceCaptain}> from the last import, or
  // [] when the squad was built by hand.
  squadPicks: [],
```

3. Add the getters beside `getSquad`:

```js
function getSquadPicks() { return state.squadPicks; }

/**
 * The player ids the user actually has in their saved starting XI (slots 1–11).
 * @returns {number[]}  empty when no import has happened or picks were cleared
 */
function getSavedXi() {
  return state.squadPicks
    .filter(p => typeof p.slot === 'number' && p.slot >= 1 && p.slot <= 11)
    .sort((a, b) => a.slot - b.slot)
    .map(p => p.playerId);
}
```

4. Add the setter and amend `setSquad`:

```js
function setSquadPicks(picks) {
  state.squadPicks = Array.isArray(picks) ? picks.slice() : [];
  try {
    sessionStorage.setItem(SS_KEY_PICKS, JSON.stringify(state.squadPicks));
  } catch { /* quota exceeded — non-fatal */ }
  emit('squad:updated', state.squad);
}
```

In `setSquad`, add before the `emit`:

```js
  // A hand-edited squad invalidates the imported pick order — those slots
  // describe a team that no longer exists, and presenting them as current
  // would be a lie. Import calls setSquadPicks() straight after setSquad().
  state.squadPicks = [];
  try { sessionStorage.removeItem(SS_KEY_PICKS); } catch { /* non-fatal */ }
```

5. In the hydration block beside the squad restore, add:

```js
  try {
    const rawPicks = sessionStorage.getItem(SS_KEY_PICKS);
    if (rawPicks) {
      const parsed = JSON.parse(rawPicks);
      if (Array.isArray(parsed)) state.squadPicks = parsed;
    }
  } catch { /* corrupt — start with no saved picks */ }
```

6. Add `getSquadPicks, getSavedXi` to the getters line and `setSquadPicks` to the setters line of the exported `store` object.

- [ ] **Step 3: Store the picks on import**

In `js/modules/planner.js`'s `handleImport`, change the destructure and add the call:

```js
    const { playerIds, picks, entryInfo, missingCount } = await fetchAndMapSquad(teamId, gw);
```

and immediately after `replaceSquad(playerIds);`:

```js
    // Order matters: setSquad clears any previous picks, so this must follow it.
    store.setSquadPicks(picks);
```

- [ ] **Step 4: Verify in the browser**

Load `http://localhost:3000/#planner`, import a real FPL team ID, then run:

```js
const picks = window.__store.getSquadPicks();
const savedXi = window.__store.getSavedXi();
console.table([
  { check: '15 picks stored',       value: picks.length,   pass: picks.length === 15 },
  { check: 'saved XI is 11',        value: savedXi.length, pass: savedXi.length === 11 },
  { check: 'exactly one captain',
    value: picks.filter(p => p.isCaptain).length,
    pass: picks.filter(p => p.isCaptain).length === 1 },
  { check: 'slots are 1..15',
    pass: picks.every(p => p.slot >= 1 && p.slot <= 15) },
]);

// Now prove a manual edit clears them.
window.__store.setSquad(window.__store.getSquad());
console.log('picks after manual edit:', window.__store.getSquadPicks().length, '(must be 0)');
```

All rows must pass, and the final line must print `0`.

- [ ] **Step 5: Commit**

```bash
git add js/squadImport.js js/store.js js/modules/planner.js
git commit -m "feat(store): keep the imported FPL pick order and armband

fetchAndMapSquad discarded everything but the player ids, so the app
could not tell you that you had a good player benched or the armband on
the wrong one. Picks now travel with the import and a manual squad edit
clears them, because those slots then describe a team that no longer
exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `modules/planner-boards.js` — the HTML builders

**Files:**
- Create: `js/modules/planner-boards.js`
- Modify: `css/components.css` (append four new blocks)

**Interfaces:**
- Consumes: `Verdict` (Task 5), `Swap[]` (Task 4), `BOARD_TOP_N`/`BOARD_EXPANDED_N` (Task 1).
- Produces:
  - `renderVerdictBanner(verdict) → string`
  - `renderBoardGrid(swaps, { expandedBoards, openRows, rankTierByPlayerId }) → string`
  - `LANE_BOARDS` — the ordered board definitions `[{ id, title, unit, format }]`

This module contains **no listeners and no state**. It returns HTML strings; `planner.js` owns every event.

- [ ] **Step 1: Write the module**

Create `js/modules/planner-boards.js`:

```js
/**
 * js/modules/planner-boards.js
 * Layer: module (DOM). Builds the Transfer Planner's verdict banner and lens
 * boards as HTML strings. No listeners, no state, no engine calls — planner.js
 * owns all three and passes the already-scored data in.
 *
 * Split out of planner.js, which was 1,324 lines before this feature and is
 * the file both halves of this page are edited in.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §9.
 */

import { BOARD_TOP_N, BOARD_EXPANDED_N } from '../config.js';

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/**
 * The five boards, in render order. `unit` labels the headline number so a
 * reader never has to guess whether "+4.1" means points, pounds or a swing.
 */
export const LANE_BOARDS = [
  { id: 'now',       title: 'Now',                 unit: 'pts to XI',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
  { id: 'future',    title: 'Future Prep',         unit: 'swing',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
  { id: 'funds',     title: 'Funds & Flexibility', unit: 'flex/pt',
    format: v => v.toFixed(1) },
  { id: 'ceiling',   title: 'Ceiling',             unit: 'peak pts',
    format: v => v.toFixed(1) },
  { id: 'structure', title: 'Structure Fix',       unit: 'pts restored',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
];

/** Display name for a lane id. 'funds' must not render as "Funds", losing
 *  half its meaning, and 'roll' has no board at all. */
export function laneLabel(laneId) {
  if (laneId === 'roll') return 'Roll it';
  return LANE_BOARDS.find(b => b.id === laneId)?.title ?? laneId;
}

/** A stable key for one swap, used to remember which why-panels are open. */
export function swapKey(swap) {
  return `${swap.outId}-${swap.inId}`;
}

/**
 * The verdict banner: the week's call, its confidence, and any triggers.
 * @param {object|null} verdict  from buildVerdict()
 * @returns {string}  HTML
 */
export function renderVerdictBanner(verdict) {
  if (!verdict) {
    return `<div class="planner-verdict planner-verdict--empty">
      <p class="planner-verdict__headline">Add 15 players to get a verdict.</p>
    </div>`;
  }

  const triggers = verdict.triggers.length === 0 ? '' : `
    <ul class="planner-verdict__triggers">
      ${verdict.triggers.map(t => `
        <li class="planner-verdict__trigger" data-trigger="${esc(t.id)}">
          <span class="planner-verdict__trigger-mark" aria-hidden="true">!</span>
          ${esc(t.message)}
        </li>`).join('')}
    </ul>`;

  const alternatives = verdict.alternatives.length === 0 ? '' : `
    <p class="planner-verdict__alts">Close behind:
      ${verdict.alternatives.map(a => `${esc(a.label)} (${a.score.toFixed(0)})`).join(', ')}
    </p>`;

  return `
    <div class="planner-verdict planner-verdict--${esc(verdict.confidence)}${verdict.estimated ? ' planner-verdict--estimated' : ''}">
      <div class="planner-verdict__head">
        <span class="planner-verdict__lane">${esc(laneLabel(verdict.lane))}</span>
        <span class="planner-verdict__confidence">${esc(verdict.confidence)}</span>
        ${verdict.lane === 'roll' ? '' :
          `<span class="planner-verdict__score">${verdict.laneScore.toFixed(0)}
            <span class="planner-verdict__margin">+${verdict.margin.toFixed(0)} clear</span>
          </span>`}
      </div>
      <p class="planner-verdict__headline">${esc(verdict.reasoning)}</p>
      ${alternatives}
      ${triggers}
    </div>
  `.trim();
}

/**
 * One compact swap row. Collapsed it is a single line; `why` expands it in
 * place to the full breakdown.
 */
function renderSwapRow(swap, board, isOpen) {
  const lane  = swap.lanes[board.id];
  const key   = swapKey(swap);
  const price = swap.priceDiff >= 0
    ? `+£${swap.priceDiff.toFixed(1)}m`
    : `−£${Math.abs(swap.priceDiff).toFixed(1)}m`;

  const badges = [
    swap.flags.outUnavailable
      ? '<span class="planner-swap-row__badge planner-swap-row__badge--urgent" title="Flagged or injured">!</span>' : '',
    swap.flags.inEntersXi
      ? '<span class="planner-swap-row__badge planner-swap-row__badge--xi" title="Goes straight into your XI">XI</span>' : '',
    lane.estimated
      ? '<span class="planner-swap-row__badge planner-swap-row__badge--estimated" title="Some inputs are estimated">~</span>' : '',
  ].join('');

  const why = !isOpen ? '' : `
    <div class="planner-why" id="why-${esc(key)}">
      <p class="planner-why__reasoning">${esc(lane.reasoning)}</p>
      <dl class="planner-why__components">
        ${Object.entries(lane.components).map(([k, v]) => `
          <div class="planner-why__row">
            <dt class="planner-why__key">${esc(k)}</dt>
            <dd class="planner-why__val">${esc(typeof v === 'number' ? v.toFixed(2) : String(v))}</dd>
          </div>`).join('')}
      </dl>
    </div>`;

  return `
    <li class="planner-swap-row${isOpen ? ' is-open' : ''}" data-swap-key="${esc(key)}">
      <div class="planner-swap-row__line">
        <span class="planner-swap-row__names">
          <span class="planner-swap-row__out">${esc(swap.outPlayer.name)}</span>
          <span class="planner-swap-row__arrow" aria-hidden="true">→</span>
          <span class="planner-swap-row__in">${esc(swap.inPlayer.name)}</span>
        </span>
        <span class="planner-swap-row__value">${esc(board.format(lane.value))}</span>
        <span class="planner-swap-row__price">${esc(price)}</span>
        ${badges}
        <button class="planner-swap-row__why" type="button"
                data-why-key="${esc(key)}"
                aria-expanded="${isOpen}"
                aria-controls="why-${esc(key)}">why</button>
      </div>
      ${why}
    </li>
  `.trim();
}

/** One board: title, meta, and its top rows. */
function renderBoard(board, swaps, opts) {
  const { expandedBoards, openRows } = opts;
  const isExpanded = expandedBoards.has(board.id);
  const limit = isExpanded ? BOARD_EXPANDED_N : BOARD_TOP_N;

  const ranked = swaps
    .filter(s => s.lanes[board.id] && s.lanes[board.id].value > 0)
    .sort((a, b) => b.lanes[board.id].value - a.lanes[board.id].value);

  const rows = ranked.slice(0, limit);

  // An empty board says so plainly. Padding it with the next-best generic swap
  // would be exactly the tunnel vision this feature exists to remove.
  const body = rows.length === 0
    ? `<p class="planner-board__empty">${esc(emptyMessage(board.id))}</p>`
    : `<ul class="planner-board__rows">
         ${rows.map(s => renderSwapRow(s, board, openRows.has(swapKey(s)))).join('')}
       </ul>`;

  const more = ranked.length > rows.length
    ? `<button class="planner-board__more" type="button" data-board-more="${esc(board.id)}">
         ${isExpanded ? 'less' : `more (${ranked.length - rows.length})`}
       </button>`
    : '';

  return `
    <section class="planner-board planner-board--${esc(board.id)}" aria-label="${esc(board.title)}">
      <header class="planner-board__hd">
        <h3 class="planner-board__title">${esc(board.title)}</h3>
        <span class="planner-board__unit">${esc(board.unit)}</span>
      </header>
      ${body}
      ${more}
    </section>
  `.trim();
}

/** What a board says when it has nothing to recommend. */
function emptyMessage(boardId) {
  switch (boardId) {
    case 'structure': return 'Nothing broken — no starter is flagged or short of minutes.';
    case 'future':    return 'No fixture swings worth pre-empting within your budget.';
    case 'funds':     return 'No move improves your flexibility without costing too much.';
    case 'ceiling':   return 'No higher-ceiling option within budget.';
    default:          return 'No move gains points in your XI within budget.';
  }
}

/**
 * The full grid of five boards.
 * @param {Array<Swap>} swaps
 * @param {{expandedBoards: Set<string>, openRows: Set<string>,
 *          rankTierByPlayerId: Map<number,string>}} opts
 * @returns {string}  HTML
 */
export function renderBoardGrid(swaps, opts) {
  return `<div class="planner-board-grid">
    ${LANE_BOARDS.map(board => renderBoard(board, swaps, opts)).join('')}
  </div>`;
}
```

- [ ] **Step 2: Add the CSS**

Append to `css/components.css` (tokens only — no raw hex, `CONVENTIONS.md` §5.3):

```css
/* ─── Transfer Planner: verdict banner ─────────────────────────────────────── */

.planner-verdict {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-left: 4px solid var(--band-neutral);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  margin-bottom: var(--space-3);
}

.planner-verdict--dominant { border-left-color: var(--band-great); }
.planner-verdict--clear    { border-left-color: var(--band-good); }
.planner-verdict--close    { border-left-color: var(--band-neutral); }
.planner-verdict--estimated { border-left-style: dashed; }

.planner-verdict__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.planner-verdict__lane {
  font-weight: 600;
  text-transform: capitalize;
  font-size: var(--font-lg);
}

.planner-verdict__confidence {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.planner-verdict__score { margin-left: auto; font-variant-numeric: tabular-nums; }
.planner-verdict__margin { font-size: var(--font-xs); color: var(--color-text-muted); }
.planner-verdict__headline { margin: 0; line-height: 1.5; }
.planner-verdict__alts { margin: var(--space-1) 0 0; font-size: var(--font-sm); color: var(--color-text-muted); }
.planner-verdict__triggers { list-style: none; margin: var(--space-2) 0 0; padding: 0; }

.planner-verdict__trigger {
  display: flex;
  gap: var(--space-1);
  font-size: var(--font-sm);
  padding: var(--space-1) 0;
}

.planner-verdict__trigger-mark { color: var(--band-brutal); font-weight: 700; }

/* ─── Transfer Planner: lens boards ────────────────────────────────────────── */

.planner-board-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: var(--space-3);
}

.planner-board {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  padding: var(--space-2);
  min-width: 0;
}

.planner-board__hd {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}

.planner-board__title { margin: 0; font-size: var(--font-sm); font-weight: 600; }
.planner-board__unit  { font-size: var(--font-xs); color: var(--color-text-muted); }
.planner-board__rows  { list-style: none; margin: 0; padding: 0; }
.planner-board__empty { margin: 0; font-size: var(--font-sm); color: var(--color-text-muted); }

.planner-board__more {
  margin-top: var(--space-2);
  background: none;
  border: none;
  color: var(--color-accent);
  font-size: var(--font-xs);
  cursor: pointer;
  padding: 0;
}

/* ─── Transfer Planner: compact swap row ───────────────────────────────────── */

.planner-swap-row { border-top: 1px solid var(--color-border); padding: var(--space-1) 0; }
.planner-swap-row:first-child { border-top: none; }

.planner-swap-row__line {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-sm);
  min-width: 0;
}

.planner-swap-row__names { display: flex; gap: var(--space-1); min-width: 0; flex: 1; }
.planner-swap-row__out,
.planner-swap-row__in { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.planner-swap-row__out { color: var(--color-text-muted); }
.planner-swap-row__arrow { color: var(--color-text-muted); flex: none; }
.planner-swap-row__value { font-variant-numeric: tabular-nums; font-weight: 600; flex: none; }
.planner-swap-row__price { font-variant-numeric: tabular-nums; font-size: var(--font-xs);
                           color: var(--color-text-muted); flex: none; }

.planner-swap-row__badge {
  flex: none;
  font-size: var(--font-xs);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.planner-swap-row__badge--urgent    { color: var(--band-brutal); font-weight: 700; }
.planner-swap-row__badge--xi        { color: var(--band-good); }
.planner-swap-row__badge--estimated { color: var(--color-text-muted); }

.planner-swap-row__why {
  flex: none;
  background: none;
  border: none;
  color: var(--color-accent);
  font-size: var(--font-xs);
  cursor: pointer;
  padding: 0 var(--space-1);
}

/* ─── Transfer Planner: why disclosure ─────────────────────────────────────── */

.planner-why {
  padding: var(--space-2) 0 var(--space-1);
  font-size: var(--font-xs);
}

.planner-why__reasoning { margin: 0 0 var(--space-1); line-height: 1.5; }
.planner-why__components { margin: 0; display: grid;
                           grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
                           gap: var(--space-1); }
.planner-why__row { display: flex; justify-content: space-between; gap: var(--space-1); }
.planner-why__key { color: var(--color-text-muted); }
.planner-why__val { font-variant-numeric: tabular-nums; margin: 0; }
```

> Before committing, confirm every `var(--…)` token above exists in `css/base.css`. If a token is missing (for example `--font-lg` or `--color-accent` under a different name), use the nearest existing token rather than inventing one — `CONVENTIONS.md` §5.3 requires all tokens to be declared once in `base.css`.

- [ ] **Step 3: Commit**

```bash
git add js/modules/planner-boards.js css/components.css
git commit -m "feat(planner): add verdict banner and lens board rendering

Compact one-line rows with a why disclosure that expands in place, so all
five boards fit on screen without losing the breakdown that used to be
always-visible. Empty boards say what they mean rather than padding
themselves with a weaker suggestion.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire the Planner to the new engine

**Files:**
- Modify: `js/modules/planner.js` (replace `computeSingleSwaps`, `renderRecommendations`, add handlers)
- Modify: `index.html:414-531` (planner section)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: the working page.

- [ ] **Step 1: Restructure the planner HTML**

In `index.html`, inside `<section class="module-view" data-module="planner">`, leave `.planner-controls` exactly as it is and replace the `.planner-shell` block with:

```html
        <!-- Verdict banner: the week's call, above everything else -->
        <div class="planner-verdict-slot" id="planner-verdict"></div>

        <!-- Rail (squad) + five lens boards -->
        <div class="planner-shell">

          <aside class="dash-squad-panel dash-squad-panel--rail" aria-label="My squad">
            <div id="planner-squad-slots"></div>
          </aside>

          <div class="planner-right-col">
            <div id="planner-boards" aria-label="Transfer recommendations"></div>

            <section class="planner-recommendations" id="planner-recommendations"
                     aria-label="Two-transfer combination">
              <p class="planner-hint">Add 15 players to see transfer recommendations.</p>
            </section>

            <section class="planner-chips" id="planner-chips"
                     aria-label="Chip timing recommendations">
              <p class="planner-hint">Computing chip timing recommendations…</p>
            </section>
          </div>

        </div>
```

Note the deliberate reordering: boards first, then the two-transfer combo, then chips at the bottom.

- [ ] **Step 2: Replace the planner's transfer computation**

In `js/modules/planner.js`:

1. Add the imports:

```js
import { enumerateSwaps, calcSquadFlexibility } from '../engine/transfers.js';
import { buildVerdict } from '../engine/strategy.js';
import { renderVerdictBanner, renderBoardGrid, LANE_BOARDS, swapKey } from './planner-boards.js';
```

2. Delete `computeSingleSwaps()` entirely. Keep `computeBestTwoSwap()`, but change its first line to accept the new swap shape by sorting on the Now lane:

```js
function computeBestTwoSwap(swaps) {
  if (!_allowExtraHit && _freeTransfers < 2) return null;
  const singles = [...swaps].sort((a, b) => b.lanes.now.value - a.lanes.now.value);
  if (singles.length < 2) return null;
```

and inside the pair loop, replace `s1.delta + s2.delta` with `s1.lanes.now.value + s2.lanes.now.value`.

3. Add module state beside the other `let _` declarations:

```js
/** Swap keys whose why-panel is open. Survives re-render so a disclosure the
 *  user opened is not slammed shut by a budget keystroke. */
let _openRows = new Set();

/** Board ids currently showing BOARD_EXPANDED_N rows instead of BOARD_TOP_N. */
let _expandedBoards = new Set();

/** Cached candidate scores, keyed by window. Cleared on data/horizon change. */
let _scoreCaches = { near: new Map(), far: new Map() };

/** Last enumeration, reused when only budget or free transfers changed. */
let _swaps = [];

/** DOM refs added by this feature. */
let _verdictSlot = null;
let _boardsSlot  = null;
```

4. Replace `renderRecommendations()` with the version below, and add `renderBoards()`:

```js
/**
 * Re-enumerate swaps and render the verdict and boards.
 * @param {boolean} rescore  false when only budget/free-transfers changed, in
 *                           which case the cached candidate scores are reused
 *                           — that is what keeps typing in the budget box fast.
 */
function renderBoards(rescore = true) {
  if (!_boardsSlot || !_verdictSlot) return;

  if (store.getSquad().length < SQUAD_TOTAL) {
    const remaining = SQUAD_TOTAL - store.getSquad().length;
    _verdictSlot.innerHTML = renderVerdictBanner(null);
    _boardsSlot.innerHTML = `<p class="planner-hint">
      Add ${remaining} more player${remaining === 1 ? '' : 's'} to see recommendations.
    </p>`;
    return;
  }

  const ctx = buildCtx();
  if (!ctx) {
    _boardsSlot.innerHTML = `<p class="planner-hint">No data available yet.</p>`;
    return;
  }

  if (rescore) _scoreCaches = { near: new Map(), far: new Map() };

  try {
    _swaps = enumerateSwaps(store.getSquad(), store.getPlayers(), ctx, {
      horizon:       getHorizon(),
      budget:        _budget,
      freeTransfers: _freeTransfers,
      allowExtraHit: _allowExtraHit,
      caches:        _scoreCaches,
    });
  } catch (err) {
    console.warn('[planner] enumerateSwaps failed:', err?.message ?? err);
    _swaps = [];
  }

  const squadPlayers = store.getSquad().map(id => store.getPlayer(id)).filter(Boolean);
  const verdict = buildVerdict(_swaps, {
    flexibility:   calcSquadFlexibility(squadPlayers, _scores),
    xiEntries:     [],
    freeTransfers: _freeTransfers,
    chipRecs:      _chipRecs,
  }, ctx);

  _verdictSlot.innerHTML = renderVerdictBanner(verdict);
  _boardsSlot.innerHTML  = renderBoardGrid(_swaps, {
    expandedBoards:     _expandedBoards,
    openRows:           _openRows,
    rankTierByPlayerId: _rankTierByPlayerId,
  });
}
```

5. In `renderRecommendations()`, delete the "Single Transfers" section entirely (the boards replace it) and keep only the "Best 2-Transfer Combo" section, changing `const singles = computeSingleSwaps(ctx);` to `const twoSwap = computeBestTwoSwap(_swaps);`.

6. Add the two delegated handlers:

```js
/** `why` toggles one row's disclosure; the open set survives re-render. */
function onBoardsClick(e) {
  const whyBtn = e.target.closest('[data-why-key]');
  if (whyBtn) {
    const key = whyBtn.dataset.whyKey;
    if (_openRows.has(key)) _openRows.delete(key);
    else                    _openRows.add(key);
    renderBoards(false);
    return;
  }
  const moreBtn = e.target.closest('[data-board-more]');
  if (moreBtn) {
    const id = moreBtn.dataset.boardMore;
    if (_expandedBoards.has(id)) _expandedBoards.delete(id);
    else                         _expandedBoards.add(id);
    renderBoards(false);
  }
}
```

7. In `wireDom()`, add the refs and the listener:

```js
  _verdictSlot = document.getElementById('planner-verdict');
  _boardsSlot  = document.getElementById('planner-boards');
  _boardsSlot?.addEventListener('click', onBoardsClick);
```

8. Change `onBudgetChange()` and `onHitToggle()`/`onFtClick()` to call `renderBoards(false)` (no re-score) followed by `renderRecommendations()`. Change `afterSquadChange()`, `onDataReady()`, `onRouteChanged()` and `onHorizonChanged()` to call `renderBoards(true)`.

9. Store the chip recommendations so the verdict can read them. In `renderChipsPanel()`, after `const recs = { … };`, add:

```js
  // Kept so buildVerdict can fire its chipWindow trigger without recomputing
  // chip timing — the same recommendations the panel below is showing.
  _chipRecs = recs;
```

and declare `let _chipRecs = {};` with the other module state.

- [ ] **Step 3: Verify the page in the browser**

Load `http://localhost:3000/#planner`, import a squad, and check every one of these by looking at the page:

1. A verdict banner appears above the boards with a lane name, a confidence word, and a sentence of reasoning.
2. Five boards render: Now, Future Prep, Funds & Flexibility, Ceiling, Structure Fix.
3. Each board shows at most 3 rows, and `more` expands it.
4. Clicking `why` expands that row in place; clicking it again collapses it.
5. **With a `why` panel open, type in the budget box.** The panel must stay open and the boards must re-rank without a visible stall.
6. Structure Fix reads "Nothing broken…" when no starter is flagged.
7. The Best 2-Transfer Combo section still renders below the grid.
8. The chips panel still renders at the bottom.
9. The console is free of errors.

- [ ] **Step 4: Commit**

```bash
git add js/modules/planner.js index.html
git commit -m "feat(planner): replace the single ranked list with five lens boards

The page now leads with a verdict and shows Now, Future Prep, Funds,
Ceiling and Structure Fix side by side. Budget and free-transfer changes
re-rank from cached scores rather than re-scoring ~2,000 players, and an
open why-panel survives the re-render.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The saved-XI diff in the squad rail

**Files:**
- Modify: `js/modules/planner.js` (`renderSquadPanel`)
- Modify: `css/components.css` (append one modifier block)

**Interfaces:**
- Consumes: `store.getSavedXi()`, `store.getSquadPicks()` (Task 6); `pickStartingXI` (Task 2).
- Produces: no new exports — this is rendering only.

**Why:** Task 6 puts the imported pick order in the store and the verdict can already read it, but nothing on screen shows it yet. Without this, the app still cannot tell you that you have a good player benched or the armband on the wrong one — which was the whole reason for keeping the picks.

- [ ] **Step 1: Compute and render the diff**

In `js/modules/planner.js`, add near the other helpers:

```js
/**
 * Where the team the user actually SET differs from the team the model would
 * pick. Returns empty sets when no import has happened — a hand-built squad has
 * no saved order to disagree with, and inventing one would be a lie.
 *
 * @returns {{ benched: Set<number>, started: Set<number>, captainId: number|null,
 *             modelCaptainId: number|null }}
 *   benched: model starts them, the user has them on the bench
 *   started: the user starts them, the model would bench them
 */
function calcSavedXiDiff() {
  const savedXi = store.getSavedXi();
  if (savedXi.length === 0) {
    return { benched: new Set(), started: new Set(), captainId: null, modelCaptainId: null };
  }

  const scoredSquad = store.getSquad()
    .map(id => ({ player: store.getPlayer(id), score: _scores.get(id) }))
    .filter(e => e.player && e.score);
  const projectedIds = new Set(pickStartingXI(scoredSquad).xi.map(e => e.player.id));
  const savedSet = new Set(savedXi);

  const benched = new Set([...projectedIds].filter(id => !savedSet.has(id)));
  const started = new Set([...savedSet].filter(id => !projectedIds.has(id)));

  const captainId = store.getSquadPicks().find(p => p.isCaptain)?.playerId ?? null;
  let modelCaptainId = null;
  let bestEp = -Infinity;
  for (const id of projectedIds) {
    const ep = _scores.get(id)?.expectedPoints?.value ?? -Infinity;
    if (ep > bestEp) { bestEp = ep; modelCaptainId = id; }
  }

  return { benched, started, captainId, modelCaptainId };
}
```

Add the import beside the other engine imports:

```js
import { pickStartingXI } from '../engine/lineup.js';
```

In `renderSquadPanel()`, compute the diff once before the `map`:

```js
  const diff = calcSavedXiDiff();
```

and inside the filled-slot template, after the existing `${chip}`, insert:

```js
            ${diff.benched.has(player.id)
              ? '<span class="dash-squad-slot__diff dash-squad-slot__diff--benched" title="The model would start him — you have him on your bench">bench</span>'
              : ''}
            ${diff.started.has(player.id)
              ? '<span class="dash-squad-slot__diff dash-squad-slot__diff--started" title="You are starting him — the model would bench him">start</span>'
              : ''}
            ${diff.captainId === player.id && diff.modelCaptainId !== player.id
              ? '<span class="dash-squad-slot__diff dash-squad-slot__diff--armband" title="Your armband is here; the model prefers another player">C</span>'
              : ''}
```

- [ ] **Step 2: Add the CSS**

Append to `css/components.css`:

```css
/* Saved-XI diff markers: where the team you set differs from the model's pick. */
.dash-squad-slot__diff {
  font-size: var(--font-xs);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.dash-squad-slot__diff--benched { color: var(--band-good); }
.dash-squad-slot__diff--started { color: var(--band-tough); }
.dash-squad-slot__diff--armband { color: var(--band-orange); font-weight: 700; }
```

- [ ] **Step 3: Verify in the browser**

Load `http://localhost:3000/#planner` and import a real team, then:

1. Confirm markers appear only on players where the saved team and the model disagree. On a squad where they agree entirely, **no markers at all** should render.
2. Confirm the counts are symmetric — the number of `bench` markers equals the number of `start` markers, because swapping one player out of the XI necessarily swaps another in.
3. Remove and re-add a player by hand. The markers must vanish, because `setSquad` cleared the picks.

Run this to check point 2 mechanically:

```js
const marks = document.querySelectorAll('.dash-squad-slot__diff');
const benched = document.querySelectorAll('.dash-squad-slot__diff--benched').length;
const started = document.querySelectorAll('.dash-squad-slot__diff--started').length;
console.table([
  { check: 'diff markers rendered', value: marks.length },
  { check: 'bench/start symmetric', value: `${benched} vs ${started}`, pass: benched === started },
]);
```

- [ ] **Step 4: Commit**

```bash
git add js/modules/planner.js css/components.css
git commit -m "feat(planner): show where your saved team differs from the model's XI

Marks the players the model would start that you have benched, the ones
you are starting that it would not, and an armband on the wrong player.
Renders nothing when no squad has been imported — a hand-built squad has
no saved order to disagree with.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Verification pass and documentation

**Files:**
- Modify: `FEATURE_ENGINE.md` (new section)
- Modify: `ARCHITECTURE.md` (file tree and module notes)
- Modify: `ROADMAP.md` (Phase 2D exit criterion)
- Modify: `GAFFER_IQ_TESTING_ROADMAP.md` (behavioural checks)

**Interfaces:**
- Consumes: the finished feature.
- Produces: docs that agree with the code, per `CONVENTIONS.md` §10.

- [ ] **Step 1: Run the full behavioural check**

With the dev server running and a real squad imported, work through every check in spec §13 and record the result of each:

- A bench-to-bench swap scores near zero on the Now board.
- A swap that promotes a player into the XI is credited for the promotion.
- Dashboard and Planner agree on the projected XI (compare the Dashboard's Starting XI against the players the Planner treats as `flags.outInXi`).
- Imported saved picks are held in the store and cleared by a manual edit.
- Structure Fix is empty when nothing is broken, populated when a squad member is flagged.
- The verdict reports "close" when the top two lanes are near-tied, and rolls when nothing clears the threshold.
- Budget keystrokes re-rank without a visible stall.

If any check fails, fix it before writing the docs — a doc that describes behaviour the code does not have is worse than no doc.

- [ ] **Step 2: Document the lane models in `FEATURE_ENGINE.md`**

Append a new section covering: the XI-expected-points spine and why the composite was the wrong axis; each of the five lane formulas with its config constants; the lane normalisation step and its arbitrariness; the verdict's confidence bands and four triggers; and the two honesty rules (estimated inputs downgrade confidence; empty boards state their emptiness). Cross-reference the spec path.

- [ ] **Step 3: Update `ARCHITECTURE.md`**

Add `engine/lineup.js`, `engine/transfers.js`, `engine/strategy.js` and `modules/planner-boards.js` to the file tree with one-line responsibilities, and note that `pickStartingXI` is now shared between the Dashboard and the Planner.

- [ ] **Step 4: Update `ROADMAP.md`**

Amend the Phase 2D exit criterion: the Planner no longer merely "proposes ranked transfers with quantified projected-score gains" — it ranks by projected XI expected points across five lanes and issues a weekly verdict that may recommend no transfer at all.

- [ ] **Step 5: Update `GAFFER_IQ_TESTING_ROADMAP.md`**

Add the Task 10 Step 1 checks as a checklist block, with the console snippets from Tasks 3, 4 and 5 so they can be re-run after any config change — particularly after tuning the `LANE_SCALE_*` constants.

- [ ] **Step 6: Commit**

```bash
git add FEATURE_ENGINE.md ARCHITECTURE.md ROADMAP.md GAFFER_IQ_TESTING_ROADMAP.md
git commit -m "docs: record the transfer lane models and the verdict

Documents the XI-expected-points spine, the five lane formulas and their
config constants, the lane normalisation step and why it is the first
thing to calibrate, and the verdict's confidence bands and triggers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deferred / not in this plan

- **Calibrating `LANE_SCALE_*`.** They ship as reasoned guesses. Tuning them against realised results is `ROADMAP.md` Phase 3B work and needs several gameweeks of data.
- **Resolving the flexibility ambiguity** (spread vs headroom). Carried as two config weights; settle it after live use.
- **Multi-week transfer sequencing.** Future Prep names the target; it does not plan the path to it.
