# Full Season Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-width GW1–38 planning strip to the foot of the Matchup page, showing each gameweek's top 3 matchups and top 5 players, its schedule irregularities, and a chip window per half-season.

**Architecture:** One new pure engine (`js/engine/season.js`) computes a whole-season model from the existing `buildScoreContext` output; one new module (`js/modules/fullSeason.js`) owns the strip's DOM and its expand/collapse choreography. Nothing existing changes behaviour — `index.html`, `config.js` and `main.js` gain additive entries only.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. Tests use `node:test` + `node:assert/strict`. CSS is hand-written BEM-lite against the tokens in `css/base.css`.

**Spec:** `docs/superpowers/specs/2026-09-01-full-season-strip-design.md`

**Motion reference:** `docs/superpowers/specs/2026-09-01-full-season-strip-prototype.html` — a working, browser-verified prototype of the ribbon and its choreography. Tasks 8–11 port from it. It is the source of truth for timing and geometry; where this plan and the prototype disagree, the plan wins.

## Global Constraints

- **Engine files are pure** (`ARCHITECTURE.md` §3): no DOM, no `fetch`, no store access, no mutation of inputs. Same inputs → same outputs.
- **Modules own DOM only** (`ARCHITECTURE.md` §3 hard rule 2): no analytical logic in `js/modules/*`. Anything that computes a number belongs in the engine.
- **Render only while on screen** (`CONVENTIONS.md` §8): `data:ready` does cheap bookkeeping unconditionally; expensive work defers to `route:changed` when the view is hidden.
- **CSS is BEM-lite** (`CONVENTIONS.md` §5.1): `block`, `block__element`, `block--modifier`. Lowercase kebab-case, no IDs for styling, **no hard-coded colours** — every colour via `var(--…)` from `css/base.css`.
- **Block prefix for all new CSS is `season-`.** e.g. `.season-strip`, `.season-gw__tile`, `.season-gw--hot`.
- **Postponed fixtures never feed a score** (`ARCHITECTURE.md` §9). `fixturesForTeamInWindow`'s `f.gw === null` guard stays untouched. The attribution added here is display-only.
- **Node is not installed on this machine.** `npm test` cannot be run locally. Write the tests anyway — they are the deliverable and run in CI/elsewhere. Behavioural verification is live in the browser via `.claude/devserver.py` (see `README` of that file), navigating to `http://localhost:3000/#matchup`.
- **Motion budget: 3 phases × 330ms = 990ms**, chained by `transition-delay`, easing `cubic-bezier(.32,.72,0,1)`.
- Commit after every task. Conventional Commits, lowercase subject ≤72 chars.

---

### Task 1: Config constants

**Files:**
- Modify: `js/config.js` (append a new section after the Phase 4-3 chip block, ~line 1000)

**Interfaces:**
- Consumes: nothing.
- Produces: `SEASON_TOP_MATCHUPS: number`, `SEASON_TOP_PLAYERS: number`, `SEASON_LOADED_MIN_GREAT: number`, `SEASON_PHASE_MS: number`, `SEASON_COL_W: number`, `SEASON_COL_WIDE: number`. All consumed by Tasks 2–11.

- [ ] **Step 1: Add the constants**

Append to `js/config.js`:

```js
// ─── §12  Full Season strip (Matchup page) ───────────────────────────────────
// See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.

// Matchup rows and player rows shown per gameweek. Three and five are what the
// collapsed column has room for at 54px — the tiles and dots are the collapsed
// summary of exactly these lists, so changing either number changes both the
// panel and the ribbon glyph.
export const SEASON_TOP_MATCHUPS = 3;
export const SEASON_TOP_PLAYERS  = 5;

// How many of a week's top matchups must land in the `great` band before the
// week reads as "loaded". Two of three: one blowout is an ordinary week with a
// good fixture in it, two is a week worth waiting for.
export const SEASON_LOADED_MIN_GREAT = 2;

// One phase of the expand/collapse choreography. Three phases run back to back
// (vertical, horizontal, fade), so the whole transition is 3x this.
export const SEASON_PHASE_MS = 330;

// Ribbon column geometry. Fixed rather than flexed to the page width: 38 weeks
// sharing one viewport made every tile unreadable.
export const SEASON_COL_W    = 54;
export const SEASON_COL_WIDE = 268;
```

- [ ] **Step 2: Verify the module still parses**

Run: open `http://localhost:3000/#matchup` in the Browser pane and check the console.
Expected: no errors. `config.js` is imported by every module, so a syntax error surfaces immediately as a blank app.

- [ ] **Step 3: Commit**

```bash
git add projects/apps/gaffer-iq/js/config.js
git commit -m "feat(config): add Full Season strip constants"
```

---

### Task 2: Per-gameweek matchups

**Files:**
- Create: `js/engine/season.js`
- Test: `tests/engine/season.test.js`

**Interfaces:**
- Consumes: `scoreFixture(team, fixture, ctx)` from `js/engine/composite.js` — returns `{ value: number, band: string, … }`. `ctx` from `buildScoreContext(season, opts)` carries `{ teamsById, fixtures, currentGw, … }`.
- Produces:
  - `buildGameweekMatchups(gw, ctx, opts?) -> Array<Matchup>` where
    `Matchup = { fixtureId: number, homeId: number, awayId: number, favouredId: number, value: number, band: string, isDouble: boolean, postponed: false }`,
    sorted by `value` descending, length ≤ `SEASON_TOP_MATCHUPS`.
  - `LAST_GW = 38`.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/season.test.js`:

```js
/**
 * tests/engine/season.test.js
 * Unit tests for engine/season.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGameweekMatchups } from '../../js/engine/season.js';

/**
 * Minimal ctx double. buildGameweekMatchups only reads `fixtures` and
 * `teamsById`, and takes scoreFixture by injection so these tests never depend
 * on the real composite model.
 */
function ctxWith(fixtures, teamIds = [1, 2, 3, 4, 5, 6]) {
  const teamsById = {};
  for (const id of teamIds) teamsById[id] = { id, name: `T${id}`, shortName: `T${id}` };
  return { fixtures, teamsById };
}

// Scores a fixture by a lookup keyed "fixtureId:teamId", so each test states
// exactly which side is favoured and by how much.
function scorerFrom(table) {
  return (team, fixture) => ({ value: table[`${fixture.id}:${team.id}`] ?? 50, band: 'neutral' });
}

test('buildGameweekMatchups scores both sides and keeps the higher one', () => {
  const ctx = ctxWith([{ id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const score = scorerFrom({ '10:1': 82, '10:2': 18 });
  const [m] = buildGameweekMatchups(5, ctx, { score });
  assert.equal(m.value, 82);
  assert.equal(m.favouredId, 1);
});

test('buildGameweekMatchups favours the away side when it scores higher', () => {
  const ctx = ctxWith([{ id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const score = scorerFrom({ '10:1': 31, '10:2': 77 });
  const [m] = buildGameweekMatchups(5, ctx, { score });
  assert.equal(m.value, 77);
  assert.equal(m.favouredId, 2);
});

test('buildGameweekMatchups returns the top three, descending', () => {
  const ctx = ctxWith([
    { id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 11, gw: 5, homeTeamId: 3, awayTeamId: 4 },
    { id: 12, gw: 5, homeTeamId: 5, awayTeamId: 6 },
    { id: 13, gw: 5, homeTeamId: 2, awayTeamId: 3 },
  ]);
  const score = scorerFrom({ '10:1': 60, '11:3': 90, '12:5': 75, '13:2': 40 });
  const out = buildGameweekMatchups(5, ctx, { score });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.value), [90, 75, 60]);
});

test('buildGameweekMatchups ignores other gameweeks and unscheduled fixtures', () => {
  const ctx = ctxWith([
    { id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 11, gw: 6, homeTeamId: 3, awayTeamId: 4 },
    { id: 12, gw: null, homeTeamId: 5, awayTeamId: 6 },
  ]);
  const out = buildGameweekMatchups(5, ctx, { score: scorerFrom({}) });
  assert.equal(out.length, 1);
  assert.equal(out[0].fixtureId, 10);
});

test('buildGameweekMatchups flags a fixture whose team plays twice that week', () => {
  const ctx = ctxWith([
    { id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 11, gw: 5, homeTeamId: 1, awayTeamId: 3 },
  ]);
  const out = buildGameweekMatchups(5, ctx, { score: scorerFrom({}) });
  assert.equal(out.every(m => m.isDouble), true);
});

test('buildGameweekMatchups leaves a single-fixture week unflagged', () => {
  const ctx = ctxWith([{ id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const [m] = buildGameweekMatchups(5, ctx, { score: scorerFrom({}) });
  assert.equal(m.isDouble, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test` (or `node --test tests/engine/season.test.js`)
Expected: FAIL — `Cannot find module '../../js/engine/season.js'`.

*(Node is unavailable locally — see Global Constraints. If you cannot run it, confirm the file does not exist yet and proceed.)*

- [ ] **Step 3: Write the implementation**

Create `js/engine/season.js`:

```js
/**
 * js/engine/season.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds the whole-season model behind the Matchup page's Full Season strip:
 * per-gameweek matchups, per-gameweek player projections, schedule
 * irregularities and chip windows.
 * See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.
 */

import { SEASON_TOP_MATCHUPS, SEASON_LOADED_MIN_GREAT, BANDS } from '../config.js';
import { scoreFixture } from './composite.js';

/** Premier League seasons are 38 gameweeks. */
export const LAST_GW = 38;

/**
 * The top matchups of one gameweek.
 *
 * A fixture carries TWO composite scores, one per side. The matchup's score is
 * the higher of them and the side that produced it is the favoured side — so
 * the UI's "which team does this fixture favour" ring falls out of the same
 * calculation rather than needing a second rule.
 *
 * @param {number} gw
 * @param {object} ctx   from buildScoreContext
 * @param {{score?: Function}} [opts]  scoreFixture injection point, for tests
 * @returns {Array<object>}  at most SEASON_TOP_MATCHUPS, value descending
 */
export function buildGameweekMatchups(gw, ctx, opts = {}) {
  const score = opts.score ?? scoreFixture;
  const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);

  // A team playing twice this week makes every fixture it appears in a double.
  const counts = new Map();
  for (const f of fixtures) {
    counts.set(f.homeTeamId, (counts.get(f.homeTeamId) ?? 0) + 1);
    counts.set(f.awayTeamId, (counts.get(f.awayTeamId) ?? 0) + 1);
  }

  const rows = [];
  for (const f of fixtures) {
    const home = ctx.teamsById[f.homeTeamId];
    const away = ctx.teamsById[f.awayTeamId];
    if (!home || !away) continue;
    const h = score(home, f, ctx);
    const a = score(away, f, ctx);
    const homeLeads = h.value >= a.value;
    const best = homeLeads ? h : a;
    rows.push({
      fixtureId:  f.id,
      homeId:     f.homeTeamId,
      awayId:     f.awayTeamId,
      favouredId: homeLeads ? f.homeTeamId : f.awayTeamId,
      value:      best.value,
      band:       best.band,
      isDouble:   (counts.get(f.homeTeamId) > 1) || (counts.get(f.awayTeamId) > 1),
      postponed:  false,
    });
  }

  return rows.sort((x, y) => y.value - x.value).slice(0, SEASON_TOP_MATCHUPS);
}

/**
 * Is this a week worth waiting for? True once SEASON_LOADED_MIN_GREAT of the
 * week's top matchups reach the `great` band. One blowout is an ordinary week
 * with a good fixture in it; several together is a different thing.
 *
 * @param {Array<object>} matchups  buildGameweekMatchups output
 */
export function isLoadedWeek(matchups) {
  return matchups.filter(m => !m.postponed && m.value >= BANDS.great).length
    >= SEASON_LOADED_MIN_GREAT;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/engine/season.js projects/apps/gaffer-iq/tests/engine/season.test.js
git commit -m "feat(season): score each gameweek's top matchups"
```

---

### Task 3: Postponement attribution

**Files:**
- Modify: `js/engine/season.js`
- Test: `tests/engine/season.test.js`

**Interfaces:**
- Consumes: `LAST_GW` from Task 2. Reads `ctx.fixtures` (scheduled, `gw` a number) and a separate list of pending fixtures (`gw === null`).
- Produces: `attributePostponements(pending, ctx) -> Map<number, Array<Fixture>>` — gameweek number → the pending fixtures inferred to belong to it.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/season.test.js`:

```js
import { attributePostponements } from '../../js/engine/season.js';

/** ctx whose scheduled fixtures pair up teams across the given gameweeks. */
function scheduleCtx(fixtures, teamIds) {
  const teamsById = {};
  for (const id of teamIds) teamsById[id] = { id };
  return { fixtures, teamsById };
}

test('attributePostponements places a pending tie in the week both clubs are blank', () => {
  // GW5: teams 1 and 2 have no fixture, everyone else plays. The pending 1v2
  // tie is the hole's obvious cause.
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 3, awayTeamId: 4 },
    { id: 21, gw: 6, homeTeamId: 1, awayTeamId: 3 },
    { id: 22, gw: 6, homeTeamId: 2, awayTeamId: 4 },
  ], [1, 2, 3, 4]);
  const pending = [{ id: 99, gw: null, homeTeamId: 1, awayTeamId: 2 }];
  const map = attributePostponements(pending, ctx);
  assert.deepEqual(map.get(5).map(f => f.id), [99]);
});

test('attributePostponements ignores a week where only one club is blank', () => {
  // Team 1 is blank in GW5 but team 2 plays, so the 1v2 tie cannot have been
  // removed from GW5.
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 2, awayTeamId: 3 },
    { id: 21, gw: 6, homeTeamId: 1, awayTeamId: 2 },
  ], [1, 2, 3]);
  const pending = [{ id: 99, gw: null, homeTeamId: 1, awayTeamId: 2 }];
  const map = attributePostponements(pending, ctx);
  assert.equal(map.has(5), false);
});

test('attributePostponements picks the earliest matching week', () => {
  // Both clubs are blank in GW5 and again in GW9. The postponement left its
  // hole at the original date; the rearranged date is always later.
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 3, awayTeamId: 4 },
    { id: 21, gw: 9, homeTeamId: 3, awayTeamId: 4 },
    { id: 22, gw: 6, homeTeamId: 1, awayTeamId: 2 },
  ], [1, 2, 3, 4]);
  const pending = [{ id: 99, gw: null, homeTeamId: 1, awayTeamId: 2 }];
  const map = attributePostponements(pending, ctx);
  assert.equal(map.has(5), true);
  assert.equal(map.has(9), false);
});

test('attributePostponements gives two ties in one week both slots', () => {
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 5, awayTeamId: 6 },
    { id: 21, gw: 6, homeTeamId: 1, awayTeamId: 5 },
    { id: 22, gw: 6, homeTeamId: 2, awayTeamId: 6 },
    { id: 23, gw: 6, homeTeamId: 3, awayTeamId: 5 },
    { id: 24, gw: 6, homeTeamId: 4, awayTeamId: 6 },
  ], [1, 2, 3, 4, 5, 6]);
  const pending = [
    { id: 98, gw: null, homeTeamId: 1, awayTeamId: 2 },
    { id: 99, gw: null, homeTeamId: 3, awayTeamId: 4 },
  ];
  const map = attributePostponements(pending, ctx);
  assert.deepEqual(map.get(5).map(f => f.id).sort(), [98, 99]);
});

test('attributePostponements returns an empty map when nothing is pending', () => {
  const ctx = scheduleCtx([{ id: 20, gw: 5, homeTeamId: 1, awayTeamId: 2 }], [1, 2]);
  assert.equal(attributePostponements([], ctx).size, 0);
});

test('attributePostponements ignores weeks with no fixtures at all', () => {
  // GW7 has no scheduled fixtures anywhere — an unplayed part of the season,
  // not a hole. Every club is "blank", which must not swallow every pending tie.
  const ctx = scheduleCtx([{ id: 20, gw: 5, homeTeamId: 1, awayTeamId: 2 }], [1, 2, 3, 4]);
  const pending = [{ id: 99, gw: null, homeTeamId: 3, awayTeamId: 4 }];
  const map = attributePostponements(pending, ctx);
  assert.equal(map.has(7), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `attributePostponements is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `js/engine/season.js`:

```js
/**
 * Infer which gameweek each postponed fixture was taken out of.
 *
 * WHY THIS IS AN INFERENCE. FPL sets `event: null` on a postponed fixture and
 * does not retain the gameweek it was scheduled for, so the answer is not in
 * the feed. What IS observable is the hole it left: two clubs with no fixture
 * in a week the rest of the league plays. A pending tie between exactly those
 * two clubs is the obvious cause.
 *
 * DISPLAY-ONLY. Nothing here feeds a score, and ARCHITECTURE.md §9's rule that
 * gameweek aggregation must skip `gw === null` fixtures is untouched. The UI
 * states that the attribution is inferred, so a wrong guess reads as a guess.
 *
 * Earliest match wins: a rearranged date is always later than the hole.
 * A gameweek with NO scheduled fixtures at all is skipped — that is an unplayed
 * stretch of the season, not a hole, and every club is trivially "blank" in it.
 *
 * @param {Array<object>} pending  fixtures with gw === null
 * @param {object} ctx             from buildScoreContext
 * @returns {Map<number, Array<object>>}  gameweek → fixtures attributed to it
 */
export function attributePostponements(pending, ctx) {
  const out = new Map();
  if (!pending || pending.length === 0) return out;

  // Which clubs play in each gameweek that has any fixtures at all.
  const playingByGw = new Map();
  for (const f of (ctx.fixtures || [])) {
    if (typeof f.gw !== 'number') continue;
    let set = playingByGw.get(f.gw);
    if (!set) playingByGw.set(f.gw, set = new Set());
    set.add(f.homeTeamId);
    set.add(f.awayTeamId);
  }

  const gws = [...playingByGw.keys()].sort((a, b) => a - b);
  for (const f of pending) {
    for (const gw of gws) {
      const playing = playingByGw.get(gw);
      if (playing.has(f.homeTeamId) || playing.has(f.awayTeamId)) continue;
      let list = out.get(gw);
      if (!list) out.set(gw, list = []);
      list.push(f);
      break;                       // earliest match only
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 12 tests total.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/engine/season.js projects/apps/gaffer-iq/tests/engine/season.test.js
git commit -m "feat(season): infer which gameweek a postponement left"
```

---

### Task 4: Bottom-up matchup slots

**Files:**
- Modify: `js/engine/season.js`
- Test: `tests/engine/season.test.js`

**Interfaces:**
- Consumes: `buildGameweekMatchups` (Task 2), `attributePostponements` (Task 3).
- Produces: `fillMatchupSlots(live, postponed) -> Array<Matchup>` — length ≤ `SEASON_TOP_MATCHUPS`. Postponed entries carry `{ postponed: true, value: null, band: 'neutral', favouredId: null }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/season.test.js`:

```js
import { fillMatchupSlots } from '../../js/engine/season.js';

const live = n => Array.from({ length: n }, (_, i) => ({
  fixtureId: 100 + i, value: 90 - i * 10, postponed: false,
}));
const pp = n => Array.from({ length: n }, (_, i) => ({
  id: 200 + i, homeTeamId: 1, awayTeamId: 2,
}));

test('fillMatchupSlots leaves a clean week untouched', () => {
  const out = fillMatchupSlots(live(3), []);
  assert.equal(out.length, 3);
  assert.equal(out.some(m => m.postponed), false);
  assert.deepEqual(out.map(m => m.value), [90, 80, 70]);
});

test('fillMatchupSlots puts one postponement in the LAST slot', () => {
  const out = fillMatchupSlots(live(3), pp(1));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.postponed), [false, false, true]);
  // Slot 1 keeps the week's genuine best fixture.
  assert.equal(out[0].value, 90);
});

test('fillMatchupSlots fills upward for two postponements', () => {
  const out = fillMatchupSlots(live(3), pp(2));
  assert.deepEqual(out.map(m => m.postponed), [false, true, true]);
  assert.equal(out[0].value, 90);
});

test('fillMatchupSlots keeps slot 1 live even with three postponements', () => {
  // Three would fill every slot; slot 1 is reserved for a real fixture
  // whenever one exists, because that is the whole point of the ordering.
  const out = fillMatchupSlots(live(3), pp(3));
  assert.deepEqual(out.map(m => m.postponed), [false, true, true]);
});

test('fillMatchupSlots allows an all-postponed week when nothing is live', () => {
  const out = fillMatchupSlots([], pp(2));
  assert.deepEqual(out.map(m => m.postponed), [true, true]);
});

test('fillMatchupSlots marks postponed rows as unscored', () => {
  const [row] = fillMatchupSlots([], pp(1));
  assert.equal(row.value, null);
  assert.equal(row.favouredId, null);
  assert.equal(row.homeId, 1);
  assert.equal(row.awayId, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `fillMatchupSlots is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `js/engine/season.js`:

```js
/**
 * Lay a gameweek's rows out, postponements filling FROM THE BOTTOM.
 *
 * Slot 1 always holds the week's genuine best fixture whenever one exists, no
 * matter how much of the schedule has fallen over. Two postponements therefore
 * read as "one real fixture left to plan around", which is the signal worth
 * acting on — where sorting them in among the live rows would just look like a
 * thin week.
 *
 * @param {Array<object>} liveRows   buildGameweekMatchups output, descending
 * @param {Array<object>} postponed  fixtures attributed to this gameweek
 * @returns {Array<object>}  at most SEASON_TOP_MATCHUPS rows
 */
export function fillMatchupSlots(liveRows, postponed) {
  const total = Math.min(SEASON_TOP_MATCHUPS, liveRows.length + postponed.length);
  const slots = new Array(total).fill(null);

  // Reserve slot 0 for a live fixture whenever there is one to put there, then
  // fill postponements upward from the bottom of what remains.
  const reserved = liveRows.length > 0 ? 1 : 0;
  const room     = total - reserved;
  const ppShown  = Math.min(postponed.length, room);

  for (let i = 0; i < ppShown; i++) {
    const f = postponed[i];
    slots[total - 1 - i] = {
      fixtureId:  f.id,
      homeId:     f.homeTeamId,
      awayId:     f.awayTeamId,
      favouredId: null,
      value:      null,
      band:       'neutral',
      isDouble:   false,
      postponed:  true,
    };
  }

  let next = 0;
  for (let i = 0; i < total; i++) {
    if (!slots[i]) slots[i] = liveRows[next++] ?? null;
  }
  return slots.filter(Boolean);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 18 tests total.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/engine/season.js projects/apps/gaffer-iq/tests/engine/season.test.js
git commit -m "feat(season): fill postponed matchup slots from the bottom"
```

---

### Task 5: Per-gameweek player projections

**Files:**
- Modify: `js/engine/season.js`
- Test: `tests/engine/season.test.js`

**Interfaces:**
- Consumes: `calcPlayerForm(player, ctx)` and `calcPlayingLikelihood(player, formResult)` from `js/engine/form.js`; `calcAvgPointsPerGw(player, ctx)` and `calcExpectedPoints(avgPointsPerGw, nextFixtureScore, playing, fixtureCount)` from `js/engine/composite.js`. `calcExpectedPoints` returns `{ value: number, estimated: boolean }`.
- Produces:
  - `buildPlayerFormCache(ctx) -> Map<number, object>` — player id → `calcPlayerForm` result. Computed once, reused for all 38 gameweeks.
  - `buildGameweekPlayers(gw, ctx, formCache, opts?) -> Array<PlayerRow>` where
    `PlayerRow = { playerId, name, position, teamId, price, points }`, sorted by `points` descending, length ≤ `SEASON_TOP_PLAYERS`.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/season.test.js`:

```js
import { buildGameweekPlayers } from '../../js/engine/season.js';

function playerCtx(fixtures) {
  return {
    fixtures,
    teamsById: { 1: { id: 1 }, 2: { id: 2 } },
    playersByTeamId: {
      1: [
        { id: 11, teamId: 1, name: 'Alpha', position: 'FWD', price: 10 },
        { id: 12, teamId: 1, name: 'Bravo', position: 'MID', price: 8 },
      ],
      2: [{ id: 21, teamId: 2, name: 'Charlie', position: 'DEF', price: 5 }],
    },
  };
}
// Projection injection: every player scores its own id, so ordering is exact.
const projectFrom = table => (player, fixtureCount) =>
  ({ value: (table[player.id] ?? 0) * fixtureCount, estimated: false });

test('buildGameweekPlayers ranks the league for one gameweek', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const out = buildGameweekPlayers(5, ctx, new Map(), {
    project: projectFrom({ 11: 9, 12: 4, 21: 6 }),
  });
  assert.deepEqual(out.map(p => p.playerId), [11, 21, 12]);
  assert.equal(out[0].points, 9);
});

test('buildGameweekPlayers excludes clubs with no fixture that week', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  ctx.fixtures.push({ id: 31, gw: 6, homeTeamId: 1, awayTeamId: 2 });
  ctx.playersByTeamId[3] = [{ id: 31, teamId: 3, name: 'Delta', position: 'MID', price: 6 }];
  ctx.teamsById[3] = { id: 3 };
  const out = buildGameweekPlayers(5, ctx, new Map(), {
    project: projectFrom({ 11: 9, 12: 4, 21: 6, 31: 100 }),
  });
  assert.equal(out.some(p => p.playerId === 31), false);
});

test('buildGameweekPlayers passes the fixture count through for a double', () => {
  const ctx = playerCtx([
    { id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 31, gw: 5, homeTeamId: 1, awayTeamId: 2 },
  ]);
  const out = buildGameweekPlayers(5, ctx, new Map(), {
    project: projectFrom({ 11: 5, 12: 1, 21: 1 }),
  });
  // Team 1 plays twice, so its projection doubles; team 2 also plays twice.
  assert.equal(out[0].playerId, 11);
  assert.equal(out[0].points, 10);
});

test('buildGameweekPlayers caps at SEASON_TOP_PLAYERS', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  ctx.playersByTeamId[1].push(
    { id: 13, teamId: 1, name: 'E', position: 'MID', price: 5 },
    { id: 14, teamId: 1, name: 'F', position: 'MID', price: 5 },
    { id: 15, teamId: 1, name: 'G', position: 'MID', price: 5 },
    { id: 16, teamId: 1, name: 'H', position: 'MID', price: 5 },
  );
  const out = buildGameweekPlayers(5, ctx, new Map(), { project: projectFrom({}) });
  assert.equal(out.length, 5);
});

test('buildGameweekPlayers returns nothing for a gameweek with no fixtures', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  assert.deepEqual(buildGameweekPlayers(9, ctx, new Map(), { project: projectFrom({}) }), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildGameweekPlayers is not a function`.

- [ ] **Step 3: Write the implementation**

Add the imports at the top of `js/engine/season.js`:

```js
import { SEASON_TOP_MATCHUPS, SEASON_TOP_PLAYERS, SEASON_LOADED_MIN_GREAT, BANDS } from '../config.js';
import { scoreFixture, calcAvgPointsPerGw, calcExpectedPoints } from './composite.js';
import { calcPlayerForm, calcPlayingLikelihood } from './form.js';
```

Then append:

```js
/**
 * Player form for the whole pool, computed ONCE.
 *
 * This is what makes 38 gameweeks of league-wide ranking affordable:
 * calcPlayerForm reads a player's history and the league context, neither of
 * which depends on which gameweek you are asking about. Only the cheap
 * per-gameweek fixture read repeats.
 *
 * @param {object} ctx
 * @returns {Map<number, object>} player id → PlayerForm
 */
export function buildPlayerFormCache(ctx) {
  const cache = new Map();
  for (const list of Object.values(ctx.playersByTeamId || {})) {
    for (const p of list) cache.set(p.id, calcPlayerForm(p, ctx));
  }
  return cache;
}

/**
 * The players most worth owning for ONE gameweek, league-wide.
 *
 * Deliberately not squad-aware: the strip is a season guide that has to work
 * before anyone has imported a team.
 *
 * @param {number} gw
 * @param {object} ctx
 * @param {Map<number, object>} formCache  from buildPlayerFormCache
 * @param {{project?: Function}} [opts]    projection injection point, for tests
 * @returns {Array<object>}  at most SEASON_TOP_PLAYERS, points descending
 */
export function buildGameweekPlayers(gw, ctx, formCache, opts = {}) {
  const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);
  if (fixtures.length === 0) return [];

  // How many games each club plays this week, and its best fixture score.
  // The fixture scores are only needed by the real projection, so they are
  // skipped entirely when a test injects `project`.
  const counts = new Map();
  const bestFixture = new Map();
  for (const f of fixtures) {
    for (const teamId of [f.homeTeamId, f.awayTeamId]) {
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
      const team = ctx.teamsById[teamId];
      if (!team || opts.project) continue;
      const s = scoreFixture(team, f, ctx);
      const prev = bestFixture.get(teamId);
      if (!prev || s.value > prev.value) bestFixture.set(teamId, s);
    }
  }

  const project = opts.project ?? ((player, fixtureCount) => {
    const form    = formCache.get(player.id) ?? calcPlayerForm(player, ctx);
    const playing = calcPlayingLikelihood(player, form);
    const avg     = calcAvgPointsPerGw(player, ctx);
    const fx      = bestFixture.get(player.teamId) ?? { value: 50 };
    return calcExpectedPoints(avg, fx, playing, fixtureCount);
  });

  const rows = [];
  for (const [teamId, list] of Object.entries(ctx.playersByTeamId || {})) {
    const count = counts.get(Number(teamId));
    if (!count) continue;                       // club is blank this week
    for (const p of list) {
      const proj = project(p, count);
      rows.push({
        playerId: p.id,
        name:     p.name,
        position: p.position,
        teamId:   p.teamId,
        price:    p.price,
        points:   proj.value,
      });
    }
  }

  return rows.sort((a, b) => b.points - a.points).slice(0, SEASON_TOP_PLAYERS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 23 tests total.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/engine/season.js projects/apps/gaffer-iq/tests/engine/season.test.js
git commit -m "feat(season): rank the league per gameweek"
```

---

### Task 6: Chip windows per half-season

**Files:**
- Modify: `js/engine/season.js`
- Test: `tests/engine/season.test.js`

**Interfaces:**
- Consumes: `CHIP_RESET_AFTER_GW` (19), `WC_WINDOW`, `WC_TOP_TEAMS` from `js/config.js`; `LAST_GW` from Task 2.
- Produces: `buildChipWindows(gwStats, opts?) -> Array<ChipWindow>` where
  `ChipWindow = { chip: 'wildcard'|'freehit'|'triplecaptain', from: number, to: number, half: 1|2 }`.
  `gwStats` is `Array<{ gw, matchupTotal, blankCount, bestPlayerPoints }>` — one entry per gameweek, produced by Task 7.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/season.test.js`:

```js
import { buildChipWindows } from '../../js/engine/season.js';

/** 38 flat gameweeks, then callers spike the ones they care about. */
function flatStats() {
  return Array.from({ length: 38 }, (_, i) => ({
    gw: i + 1, matchupTotal: 100, blankCount: 0, bestPlayerPoints: 5,
  }));
}

test('buildChipWindows picks one window per chip per half', () => {
  const out = buildChipWindows(flatStats());
  const key = w => `${w.chip}:${w.half}`;
  const keys = out.map(key).sort();
  assert.deepEqual(keys, [
    'freehit:1', 'freehit:2',
    'triplecaptain:1', 'triplecaptain:2',
    'wildcard:1', 'wildcard:2',
  ]);
});

test('buildChipWindows never lets a window straddle the chip reset', () => {
  const out = buildChipWindows(flatStats());
  for (const w of out) {
    const crosses = w.from <= 19 && w.to >= 20;
    assert.equal(crosses, false, `${w.chip} ${w.from}-${w.to} straddles the reset`);
  }
});

test('buildChipWindows sends the wildcard to the best fixture run in its half', () => {
  const stats = flatStats();
  for (const gw of [6, 7, 8, 9, 10]) stats[gw - 1].matchupTotal = 500;
  const wc = buildChipWindows(stats).find(w => w.chip === 'wildcard' && w.half === 1);
  assert.equal(wc.from, 6);
});

test('buildChipWindows sends the free hit to the most damaged week', () => {
  const stats = flatStats();
  stats[13].blankCount = 6;             // GW14
  const fh = buildChipWindows(stats).find(w => w.chip === 'freehit' && w.half === 1);
  assert.equal(fh.from, 14);
  assert.equal(fh.to, 14);
});

test('buildChipWindows sends the triple captain to the best captain week', () => {
  const stats = flatStats();
  stats[24].bestPlayerPoints = 19;      // GW25, second half
  const tc = buildChipWindows(stats).find(w => w.chip === 'triplecaptain' && w.half === 2);
  assert.equal(tc.from, 25);
});

test('buildChipWindows skips a half with no gameweeks left', () => {
  // Late season: only GW30 onward remain, so the first half has nothing.
  const stats = flatStats().filter(s => s.gw >= 30);
  const out = buildChipWindows(stats);
  assert.equal(out.some(w => w.half === 1), false);
  assert.equal(out.some(w => w.half === 2), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildChipWindows is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the `config.js` import line in `js/engine/season.js`:

```js
import {
  SEASON_TOP_MATCHUPS, SEASON_TOP_PLAYERS, SEASON_LOADED_MIN_GREAT, BANDS,
  CHIP_RESET_AFTER_GW, WC_WINDOW,
} from '../config.js';
```

Then append:

```js
/**
 * The best gameweek to play each chip, in each half of the season.
 *
 * EACH HALF IS SEARCHED SEPARATELY, which is also the mechanism that stops a
 * window straddling the GW19 reset: a run that would cross it is simply never a
 * candidate in either half. FPL reissues every chip after GW19, so a window
 * spanning it would be advice you cannot take.
 *
 * SQUAD-AGNOSTIC. Triple Captain reads the best available captain in the league
 * that week rather than a player you own, and Bench Boost is absent entirely —
 * a bench you do not own carries no information. This is what lets the strip
 * work on a first visit.
 *
 * @param {Array<object>} gwStats  one entry per gameweek:
 *   { gw, matchupTotal, blankCount, bestPlayerPoints }
 * @param {{wcWindow?: number}} [opts]
 * @returns {Array<object>}  { chip, from, to, half }
 */
export function buildChipWindows(gwStats, opts = {}) {
  const wcWindow = opts.wcWindow ?? WC_WINDOW;
  const halves = [
    { half: 1, rows: gwStats.filter(s => s.gw <= CHIP_RESET_AFTER_GW) },
    { half: 2, rows: gwStats.filter(s => s.gw >  CHIP_RESET_AFTER_GW) },
  ];

  const out = [];
  for (const { half, rows } of halves) {
    if (rows.length === 0) continue;

    // Wildcard — the best run of wcWindow consecutive weeks by fixture quality.
    // Runs must sit wholly inside the half, so they cannot cross the reset.
    let bestSum = -Infinity, bestStart = null;
    for (let i = 0; i + wcWindow <= rows.length; i++) {
      const slice = rows.slice(i, i + wcWindow);
      // Only contiguous gameweeks form a run.
      if (slice[slice.length - 1].gw - slice[0].gw !== wcWindow - 1) continue;
      const sum = slice.reduce((a, s) => a + s.matchupTotal, 0);
      if (sum > bestSum) { bestSum = sum; bestStart = slice[0].gw; }
    }
    if (bestStart !== null) {
      out.push({ chip: 'wildcard', from: bestStart, to: bestStart + wcWindow - 1, half });
    }

    // Free Hit — the single most damaged week: the one where the squad you own
    // is least able to field an XI, so renting a different one pays.
    const fh = rows.reduce((best, s) => (s.blankCount > best.blankCount ? s : best), rows[0]);
    out.push({ chip: 'freehit', from: fh.gw, to: fh.gw, half });

    // Triple Captain — the single best captain week available anywhere.
    const tc = rows.reduce((best, s) =>
      (s.bestPlayerPoints > best.bestPlayerPoints ? s : best), rows[0]);
    out.push({ chip: 'triplecaptain', from: tc.gw, to: tc.gw, half });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 29 tests total.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/engine/season.js projects/apps/gaffer-iq/tests/engine/season.test.js
git commit -m "feat(season): choose a chip window in each half-season"
```

---

### Task 7: Assemble the season model

**Files:**
- Modify: `js/engine/season.js`
- Test: `tests/engine/season.test.js`

**Interfaces:**
- Consumes: every export from Tasks 2–6.
- Produces: `buildSeasonModel(ctx, season, opts?) -> SeasonModel` where
  ```
  SeasonModel = {
    gameweeks: Array<{ gw, played, matchups, loaded, blankCount, players|null, note }>,
    chipWindows: Array<ChipWindow>,
    currentGw: number,
  }
  ```
  `players` is `null` until Task 11's background pass fills it. `gameweeks` always has 38 entries, `gw` 1…38.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/season.test.js`:

```js
import { buildSeasonModel } from '../../js/engine/season.js';

test('buildSeasonModel returns all 38 gameweeks in order', () => {
  const ctx = { fixtures: [], teamsById: {}, playersByTeamId: {}, currentGw: 3 };
  const model = buildSeasonModel(ctx, { pendingFixtures: [] }, { skipPlayers: true });
  assert.equal(model.gameweeks.length, 38);
  assert.deepEqual(model.gameweeks.map(g => g.gw).slice(0, 3), [1, 2, 3]);
});

test('buildSeasonModel marks gameweeks before currentGw as played', () => {
  const ctx = { fixtures: [], teamsById: {}, playersByTeamId: {}, currentGw: 4 };
  const model = buildSeasonModel(ctx, { pendingFixtures: [] }, { skipPlayers: true });
  assert.deepEqual(model.gameweeks.slice(0, 5).map(g => g.played),
    [true, true, true, false, false]);
});

test('buildSeasonModel leaves players null when the pass is skipped', () => {
  const ctx = { fixtures: [], teamsById: {}, playersByTeamId: {}, currentGw: 1 };
  const model = buildSeasonModel(ctx, { pendingFixtures: [] }, { skipPlayers: true });
  assert.equal(model.gameweeks[0].players, null);
});

test('buildSeasonModel counts blank clubs per gameweek', () => {
  // Four clubs; only two play in GW5, so two are blank.
  const ctx = {
    fixtures: [{ id: 1, gw: 5, homeTeamId: 1, awayTeamId: 2 }],
    teamsById: { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 }, 4: { id: 4 } },
    playersByTeamId: {}, currentGw: 1,
  };
  const model = buildSeasonModel(ctx, { pendingFixtures: [] }, { skipPlayers: true });
  assert.equal(model.gameweeks[4].blankCount, 2);
});

test('buildSeasonModel notes a postponement in the week it was taken from', () => {
  const ctx = {
    fixtures: [
      { id: 1, gw: 5, homeTeamId: 3, awayTeamId: 4 },
      { id: 2, gw: 6, homeTeamId: 1, awayTeamId: 3 },
      { id: 3, gw: 6, homeTeamId: 2, awayTeamId: 4 },
    ],
    teamsById: { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 }, 4: { id: 4 } },
    playersByTeamId: {}, currentGw: 1,
  };
  const season = { pendingFixtures: [{ id: 9, gw: null, homeTeamId: 1, awayTeamId: 2 }] };
  const model = buildSeasonModel(ctx, season, { skipPlayers: true });
  const gw5 = model.gameweeks[4];
  assert.equal(gw5.matchups.some(m => m.postponed), true);
  assert.match(gw5.note, /postponed/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildSeasonModel is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `js/engine/season.js`:

```js
/**
 * Plain-English note for one gameweek. The panel shows this under its rows.
 * Postponement wording says the attribution is INFERRED, because it is — see
 * attributePostponements.
 */
function gameweekNote(ppCount, isDouble, loaded) {
  if (ppCount > 1) {
    return `${ppCount} fixtures look postponed out of this week — only one matchup `
         + `left to plan around. Inferred from the clubs left without a game.`;
  }
  if (ppCount === 1) {
    return 'A fixture looks postponed out of this week and will be rearranged later. '
         + 'Inferred from the clubs left without a game.';
  }
  if (isDouble) return 'Double gameweek. The strongest captaincy week of this stretch.';
  if (loaded)   return 'Several heavily one-sided fixtures land together here.';
  return 'An ordinary week — nothing worth holding a transfer for.';
}

/**
 * The whole-season model behind the Full Season strip.
 *
 * Players are the expensive half and are LEFT NULL here. The module fills them
 * in per gameweek from a chunked background pass (see modules/fullSeason.js),
 * so the ribbon can paint from fixtures alone without waiting on ~700 form
 * computations. `skipPlayers` is that path; it is also what the unit tests use.
 *
 * @param {object} ctx      from buildScoreContext
 * @param {object} season   from normaliseSeason — read for pendingFixtures
 * @param {{skipPlayers?: boolean}} [opts]
 * @returns {object} SeasonModel
 */
export function buildSeasonModel(ctx, season, opts = {}) {
  const pending  = season?.pendingFixtures ?? [];
  const ppByGw   = attributePostponements(pending, ctx);
  const currentGw = ctx.currentGw ?? 1;
  const teamCount = Object.keys(ctx.teamsById || {}).length;
  const formCache = opts.skipPlayers ? null : buildPlayerFormCache(ctx);

  const gameweeks = [];
  const gwStats   = [];
  for (let gw = 1; gw <= LAST_GW; gw++) {
    const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);
    const live     = buildGameweekMatchups(gw, ctx, opts);
    const pp       = ppByGw.get(gw) ?? [];
    const matchups = fillMatchupSlots(live, pp);
    const loaded   = isLoadedWeek(matchups);
    const playing  = new Set();
    for (const f of fixtures) { playing.add(f.homeTeamId); playing.add(f.awayTeamId); }
    const blankCount = fixtures.length === 0 ? 0 : Math.max(0, teamCount - playing.size);
    const players  = opts.skipPlayers ? null : buildGameweekPlayers(gw, ctx, formCache, opts);

    gameweeks.push({
      gw,
      played: gw < currentGw,
      matchups,
      loaded,
      blankCount,
      players,
      note: gameweekNote(pp.length, matchups.some(m => m.isDouble), loaded),
    });
    gwStats.push({
      gw,
      matchupTotal: matchups.reduce((a, m) => a + (m.value ?? 0), 0),
      blankCount,
      bestPlayerPoints: players?.[0]?.points ?? 0,
    });
  }

  return { gameweeks, chipWindows: buildChipWindows(gwStats), currentGw };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 34 tests total.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/engine/season.js projects/apps/gaffer-iq/tests/engine/season.test.js
git commit -m "feat(season): assemble the whole-season model"
```

---

### Task 8: Strip markup and the collapsed ribbon

**Files:**
- Create: `js/modules/fullSeason.js`
- Modify: `index.html:202` (inside `[data-module="matchup"]`, after `</div>` closing `.matchup-shell`)
- Modify: `js/main.js:38` (import) and `js/main.js:454` (init call)
- Modify: `css/components.css` (append a new section at the end)

**Interfaces:**
- Consumes: `buildSeasonModel(ctx, season, opts)` from Task 7; `store` from `js/store.js` (`store.getSeason()`, `store.isFresh()`, `store.subscribe(event, fn)`).
- Produces: `initFullSeason()` — called once from `main.js`.

- [ ] **Step 1: Add the markup**

In `index.html`, immediately after the `</div>` that closes `.matchup-shell` and before `</section>`:

```html
        <!-- FULL SEASON — GW1-38 planning strip (js/modules/fullSeason.js).
             Container only; the module fills it. Sits below the matchup shell
             and runs the full page width. -->
        <section class="season-strip" aria-label="Full season outlook">
          <header class="season-strip__head">
            <h2 class="season-strip__title">Full Season</h2>
          </header>
          <div class="season-strip__body">
            <div class="season-scroller">
              <div class="season-track">
                <div class="season-ribbon" aria-label="Gameweeks 1 to 38"></div>
                <div class="season-rail" aria-label="Chip windows"></div>
              </div>
            </div>
            <div class="season-key"></div>
          </div>
        </section>
```

- [ ] **Step 2: Write the module**

Create `js/modules/fullSeason.js`:

```js
/**
 * js/modules/fullSeason.js
 * Layer: module. Owns the DOM for the Full Season strip on the Matchup page.
 * Side effects: DOM writes only. Reads from store; calls engine/season.js.
 * No analytical logic lives here — every number comes from engine/season.js
 * (ARCHITECTURE.md §3 hard rule 2).
 *
 * Subscriptions: data:ready, route:changed
 * Renders only while on screen (CONVENTIONS.md §8).
 * See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.
 */

import { store } from '../store.js';
import { CHIP_RESET_AFTER_GW } from '../config.js';
import { buildScoreContext } from '../engine/composite.js';
import { buildSeasonModel } from '../engine/season.js';

let _root = null, _ribbon = null, _rail = null;
let _model = null;

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One collapsed column: number, three tiles, five dots. */
function columnHTML(g) {
  if (g.played) {
    return `<div class="season-gw season-gw--past" data-gw="${g.gw}">`
         + `<span class="season-gw__n">${g.gw}</span></div>`;
  }
  // Tile is the BAND TINT alone — no club swatches. The prototype drew two
  // colour chips per tile from a hard-coded palette, but a normalised Team
  // carries no club colour (only name, shortName, code, badgeUrl), and a 70px
  // badge shrunk to 9px is mud. Spec §9 asks the tile to encode one-sidedness,
  // which the tint does on its own; the clubs are named in the panel.
  const tiles = g.matchups.map(m => {
    const cls = m.postponed ? 'season-gw__tile season-gw__tile--postponed'
      : `season-gw__tile season-gw__tile--${esc(m.band)}${m.isDouble ? ' season-gw__tile--double' : ''}`;
    return `<span class="${cls}"></span>`;
  }).join('');
  const dots = (g.players ?? []).map(() => '<i class="season-gw__dot"></i>').join('');
  return `<div class="season-gw${g.loaded ? ' season-gw--hot' : ''}" data-gw="${g.gw}"
               role="button" tabindex="0" aria-expanded="false"
               aria-label="Gameweek ${g.gw}">
      <span class="season-gw__n">${g.gw}</span>
      <span class="season-gw__summary">${tiles}<span class="season-gw__dots">${dots}</span></span>
      <span class="season-gw__body"></span>
    </div>`;
}

/** Rebuild the ribbon and rail from `_model`. */
function render() {
  if (!_model || !_ribbon) return;
  const cols = [];
  for (const g of _model.gameweeks) {
    cols.push(columnHTML(g));
    if (g.gw === CHIP_RESET_AFTER_GW) {
      cols.push('<span class="season-split" role="separator"'
        + ' aria-label="Chips reset after Gameweek 19"'
        + ' title="FPL chips reset after Gameweek 19"></span>');
    }
  }
  _ribbon.innerHTML = cols.join('');
}

function rebuild() {
  const season = store.getSeason();
  if (!season) return;
  // Same options matchup.js passes (js/modules/matchup.js buildCtx), so the
  // strip and the cards above it score from identical inputs.
  const ctx = buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg:            store.getLeagueXg(),
    leagueXgPrev:        store.getLeagueXgPrev(),
  });
  _model = buildSeasonModel(ctx, season, { skipPlayers: true });
  render();
}

function onDataReady() {
  if (store.getActiveModule() !== 'matchup') return;   // CONVENTIONS §8
  rebuild();
}

function onRouteChanged(module) {
  if (module !== 'matchup') return;
  if (store.isFresh()) rebuild();
}

/** Initialise the strip. Called once from main.js on bootstrap. */
export function initFullSeason() {
  _root = document.querySelector('.season-strip');
  if (!_root) return;
  _ribbon = _root.querySelector('.season-ribbon');
  _rail   = _root.querySelector('.season-rail');

  store.subscribe('data:ready',    onDataReady);
  store.subscribe('route:changed', onRouteChanged);

  if (store.isFresh()) onDataReady();
}
```

- [ ] **Step 3: Wire it into main.js**

In `js/main.js`, add after the `initMatchup` import (line ~38):

```js
import { initFullSeason }   from './modules/fullSeason.js';
```

and after the `initMatchup();` call (line ~454):

```js
initFullSeason();
```

- [ ] **Step 4: Add the CSS**

Append to `css/components.css`. Port the collapsed-column rules from the prototype at `docs/superpowers/specs/2026-09-01-full-season-strip-prototype.html`, renaming its classes to the `season-` block:

| Prototype | Ship as |
|---|---|
| `.gw` | `.season-gw` |
| `.gw--past` / `.gw--hot` | `.season-gw--past` / `.season-gw--hot` |
| `.gw__n` | `.season-gw__n` |
| `.summary` | `.season-gw__summary` |
| `.fx` / `.fx--great` … | `.season-gw__tile` / `.season-gw__tile--great` … |
| `.fx--dgw` / `.fx--pp` | `.season-gw__tile--double` / `.season-gw__tile--postponed` |
| `.dots` / `.dot` | `.season-gw__dots` / `.season-gw__dot` |
| `.swatch` | *dropped* — no club colour exists on a Team (see `columnHTML`) |
| `.ribbon` / `.scroller` / `.track` | `.season-ribbon` / `.season-scroller` / `.season-track` |
| `.split` | `.season-split` |

Replace every literal colour in the ported rules with its token (`#0d1117` → `var(--color-bg)` etc.); the prototype's `:root` block maps one-to-one onto `css/base.css`.

- [ ] **Step 5: Verify in the browser**

Run: start the dev server, open `http://localhost:3000/#matchup`.
Expected: 38 columns below the matchup cards, a 1px divider between GW19 and GW20, played weeks as dashed stubs, no console errors, and — critically — `document.body.scrollHeight` unchanged by anything the strip does.

- [ ] **Step 6: Commit**

```bash
git add projects/apps/gaffer-iq/js/modules/fullSeason.js projects/apps/gaffer-iq/index.html \
        projects/apps/gaffer-iq/js/main.js projects/apps/gaffer-iq/css/components.css
git commit -m "feat(season): render the collapsed GW1-38 ribbon"
```

---

### Task 9: Chip rail and colour key

**Files:**
- Modify: `js/modules/fullSeason.js`
- Modify: `css/components.css`

**Interfaces:**
- Consumes: `_model.chipWindows` from Task 7.
- Produces: `renderRail()` and `renderKey()`, called from `render()`.

- [ ] **Step 1: Render the rail**

Add to `js/modules/fullSeason.js`, and call both from `render()`:

```js
const CHIP_CLASS = {
  wildcard:      'season-rail__cell--wildcard',
  freehit:       'season-rail__cell--freehit',
  triplecaptain: 'season-rail__cell--triplecaptain',
};

/**
 * The chip rail: one cell per gameweek, mirroring the ribbon's widths and gap
 * exactly, so a band's left edge IS its gameweek's left edge.
 *
 * Consecutive weeks of one chip are CONJOINED — bridged across the flex gap by
 * an overlay (see .season-rail__cell--bridge::after), never by a negative
 * margin. A negative margin consumes layout width and drifts every later cell
 * leftward: 32px of accumulated error by GW38 when the prototype tried it.
 */
function renderRail() {
  if (!_rail || !_model) return;
  const chipAt = gw => _model.chipWindows.find(w => gw >= w.from && gw <= w.to);
  const cells = [];
  for (const g of _model.gameweeks) {
    const w = chipAt(g.gw);
    const cls = ['season-rail__cell'];
    if (g.played) cls.push('season-rail__cell--past');
    if (w) {
      cls.push(CHIP_CLASS[w.chip]);
      if (g.gw === w.from) cls.push('season-rail__cell--head');
      // A run cannot bridge the reset: a chip window may not straddle GW19.
      const continues = g.gw !== CHIP_RESET_AFTER_GW && chipAt(g.gw + 1) === w;
      cls.push(continues ? 'season-rail__cell--bridge' : 'season-rail__cell--tail');
    }
    cells.push(`<span class="${cls.join(' ')}" data-gw="${g.gw}"></span>`);
    if (g.gw === CHIP_RESET_AFTER_GW) cells.push('<span class="season-rail__split"></span>');
  }
  _rail.innerHTML = cells.join('');
}

/** Static legend. Every graphic on the strip is named here. */
function renderKey() {
  const key = _root?.querySelector('.season-key');
  if (!key) return;
  const group = (title, items) =>
    `<div class="season-key__group"><span class="season-key__heading">${title}</span>`
    + items.map(([cls, label]) =>
      `<span class="season-key__item"><i class="season-key__swatch ${cls}"></i>${label}</span>`).join('')
    + '</div>';
  key.innerHTML = [
    group('Matchup one-sidedness', [
      ['season-key__swatch--great', 'Heavily favoured'],
      ['season-key__swatch--good',  'Favoured'],
      ['season-key__swatch--even',  'Even'],
    ]),
    group('Schedule', [
      ['season-key__swatch--double',    'Double gameweek'],
      ['season-key__swatch--postponed', 'Postponed fixture'],
      ['season-key__swatch--split',     'Chip reset (after GW19)'],
    ]),
    group('Players', [
      ['season-key__swatch--player',   "In the week's top five"],
      ['season-key__swatch--standout', 'Standout — captaincy shout'],
      ['season-key__swatch--favoured', 'Favoured side of a matchup'],
    ]),
    group('Chip windows', [
      ['season-key__swatch--wildcard',      'Wildcard'],
      ['season-key__swatch--triplecaptain', 'Triple Captain'],
      ['season-key__swatch--freehit',       'Free Hit'],
    ]),
    group('Week strength', [
      ['season-key__swatch--loaded', 'Loaded — several one-sided ties'],
    ]),
  ].join('');
}
```

- [ ] **Step 2: Add the CSS**

Port `.rail*` and `.key*` from the prototype under the `season-` names above. The bridge rule must be the overlay form:

```css
.season-rail__cell { position: relative; width: var(--season-col-w); flex: none; }
.season-rail__cell--bridge::after {
  content: "";
  position: absolute;
  top: 0; bottom: 0; left: 100%;
  width: var(--season-col-gap);
  background: inherit;
}
```

- [ ] **Step 3: Verify in the browser**

Run: reload `http://localhost:3000/#matchup`.
Expected: bands below the ribbon, each starting exactly at its first gameweek's left edge. Check in the console that every rail cell aligns with its column:

```js
[...document.querySelectorAll('.season-ribbon .season-gw')]
  .map(c => { const r = document.querySelector(`.season-rail__cell[data-gw="${c.dataset.gw}"]`);
              return Math.abs(c.getBoundingClientRect().left - r.getBoundingClientRect().left); })
  .reduce((a, b) => Math.max(a, b), 0)
```
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add projects/apps/gaffer-iq/js/modules/fullSeason.js projects/apps/gaffer-iq/css/components.css
git commit -m "feat(season): draw chip windows and the colour key"
```

---

### Task 10: Expand and collapse

**Files:**
- Modify: `js/modules/fullSeason.js`
- Modify: `css/components.css`

**Interfaces:**
- Consumes: `SEASON_PHASE_MS`, `SEASON_COL_W`, `SEASON_COL_WIDE` (Task 1); `_model` (Task 7).
- Produces: `expand(col, prev)`, `collapse(el, col, skipScroll)`, and a document-level click/keydown handler. One float element per open action.

- [ ] **Step 1: Port the choreography**

Port the `bezier`, `EASE`, `scrollShiftFor`, `animateScroll`, `placeFloats`, `heightAt`, `expand`, `collapse` and the click/keydown handlers from the prototype's `<script>` block, renaming classes to the `season-` block and reading rows from `_model.gameweeks[gw - 1]` instead of the mock `DATA`.

**Five constraints that must survive the port.** Each produced a visible defect during prototyping and is easy to reintroduce:

1. **Never set a transitioned value inside a `setTimeout` whose delay matches that property's own `transition-delay`.** They compound: the phase starts at 2×delay and is cut off when the node is removed. This broke both the expand (shooting) and the collapse (delayed, then sharp).
2. **Measure the collapsed height before injecting the panel content.** Measuring after gives the detail's height at 54px wide — huge and wrapped — and the box snaps to it on frame 0.
3. **One float element per open action.** A shared element cannot collapse the old week and expand the new one at once; the loser aborts mid-animation and strands its column at 268px.
4. **`collapse()` never aborts.** It owns its float from the moment it is called. An early return leaves the float in the DOM and the column widened under it.
5. **`animateScroll`'s rAF loop runs even when `from === to`.** Its real job is re-gluing panels to their columns each frame, and a column moves during that window whether or not the track scrolls.

- [ ] **Step 2: Add the CSS**

Port `.gw--float`, `.body`, `.fxrow*`, `.prow*`, `.side*` and the `is-open` / chrome rules. Three CSS specifics that are load-bearing:

```css
/* Fixed, so it escapes .season-scroller's overflow clipping. Both selectors
   are needed: an equal-specificity .season-gw rule later in the sheet would
   otherwise win and reset position to relative. */
.season-gw.season-gw--float,
.season-gw.season-gw--float.is-open { position: fixed; z-index: 60; margin: 0; }

/* The accent chrome is its OWN class, not .is-open. .is-open carries layout
   (the summary's positioning) and `position` cannot transition, so it can only
   be dropped at the start of phase 3 — while the chrome must be dropped at the
   START of the collapse for its 2x-phase delay to schedule the fade. */
.season-gw--float.season-gw--chrome { /* accent border, shadow, padding */ }
```

The panel is pinned by its **bottom** edge (`el.style.bottom = innerHeight - colRect.bottom`) so it grows upward over the matchup cards.

- [ ] **Step 3: Verify the choreography in the browser**

Run: reload, open a gameweek, and instrument the transitions:

```js
window.__l = []; const t0 = performance.now();
const rec = e => { if (!e.target.closest?.('.season-gw--float')) return;
  if (!['height','width','opacity'].includes(e.propertyName)) return;
  window.__l.push(e.propertyName + (e.type === 'transitionend' ? ':end' : '') + '@' + Math.round(performance.now() - t0)); };
document.addEventListener('transitionstart', rec, true);
document.addEventListener('transitionend', rec, true);
document.querySelector('.season-gw[data-gw="17"]').click();
```

Expected after ~1.2s: `height@~0, height:end@~330, width@~330, width:end@~660, opacity@~660, opacity:end@~990`. The handoffs must share a timestamp — a gap of more than ~2ms means the phases are being chained in JS rather than by `transition-delay`.

Also confirm nothing moves:

```js
document.body.scrollHeight   // identical open and closed
```

- [ ] **Step 4: Commit**

```bash
git add projects/apps/gaffer-iq/js/modules/fullSeason.js projects/apps/gaffer-iq/css/components.css
git commit -m "feat(season): expand a gameweek into a floating panel"
```

---

### Task 11: Background player pass

**Files:**
- Modify: `js/modules/fullSeason.js`
- Modify: `js/engine/season.js`

**Interfaces:**
- Consumes: `buildPlayerFormCache(ctx)` and `buildGameweekPlayers(gw, ctx, formCache)` (Task 5); `buildChipWindows(gwStats)` (Task 6).
- Produces: `recomputeChipWindows(model) -> Array<ChipWindow>` (new export in `js/engine/season.js`); `runPlayerPass(ctx)` in the module — an async pass over gameweeks that fills `_model.gameweeks[i].players`, repaints the dots, and refreshes the chip rail when it finishes.

- [ ] **Step 1: Add the chip-window recompute to the engine**

`buildSeasonModel` is called with `skipPlayers: true` so the ribbon can paint
immediately, which means `bestPlayerPoints` is `0` for every gameweek when the
chip windows are first computed. Triple Captain's `reduce` therefore never
beats its seed and lands on the first gameweek of each half — a visibly wrong
band. Once the player pass has run, the windows have to be computed again from
real numbers.

Add to `js/engine/season.js` (it stays in the engine — a module may not compute
a number, `ARCHITECTURE.md` §3 hard rule 2):

```js
/**
 * Recompute the chip windows from a model whose players have since arrived.
 *
 * buildSeasonModel runs first with `skipPlayers` so the ribbon can paint from
 * fixtures alone, and at that point every gameweek's `bestPlayerPoints` is 0 —
 * which silently pins Triple Captain to the first gameweek of each half,
 * because its `reduce` never finds a value greater than its seed. The module
 * calls this once its background pass has filled `players`.
 *
 * @param {object} model  a SeasonModel whose gameweeks now carry `players`
 * @returns {Array<object>}  fresh chip windows
 */
export function recomputeChipWindows(model) {
  return buildChipWindows(model.gameweeks.map(g => ({
    gw:               g.gw,
    matchupTotal:     g.matchups.reduce((a, m) => a + (m.value ?? 0), 0),
    blankCount:       g.blankCount,
    bestPlayerPoints: g.players?.[0]?.points ?? 0,
  })));
}
```

- [ ] **Step 2: Write the pass**

Add to `js/modules/fullSeason.js`:

```js
let _passId = 0;

/**
 * Fill in every gameweek's top five, one week at a time.
 *
 * The ribbon paints from fixtures alone first, because the player half needs
 * ~700 form computations before it can rank anything and that is far too long
 * to hold the first paint. Weeks land progressively; a panel opened before its
 * week arrives shows skeleton rows (see panelHTML).
 *
 * `_passId` abandons an in-flight pass when the data refreshes underneath it,
 * exactly as ranker.js's `_computeId` does.
 */
async function runPlayerPass(ctx) {
  const my = ++_passId;
  const formCache = buildPlayerFormCache(ctx);
  for (const g of _model.gameweeks) {
    if (my !== _passId) return;                 // superseded
    g.players = buildGameweekPlayers(g.gw, ctx, formCache);
    paintDots(g);
    await new Promise(r => setTimeout(r, 0));   // yield a frame
  }
  // The chip windows were first computed against players that had not arrived
  // yet, which pins Triple Captain to each half's opening gameweek. Now that
  // every week has its five, they can be computed for real and the rail
  // repainted — renderRail() is written to be safe to call twice.
  _model.chipWindows = recomputeChipWindows(_model);
  renderRail();
}

/** Repaint one column's dots once its players have arrived. */
function paintDots(g) {
  const dots = _ribbon?.querySelector(`.season-gw[data-gw="${g.gw}"] .season-gw__dots`);
  if (!dots) return;
  dots.innerHTML = (g.players ?? [])
    .map((p, i) => `<i class="season-gw__dot${i < 2 ? ' season-gw__dot--standout' : ''}"></i>`)
    .join('');
}
```

Call it at the end of `rebuild()`:

```js
  render();
  runPlayerPass(ctx);
```

- [ ] **Step 3: Show skeletons for a week that has not arrived**

In the panel builder from Task 10, when `g.players` is `null`:

```js
const playerRows = g.players
  ? g.players.map(p => `<span class="season-player">
        <span class="season-player__pos">${esc(p.position)}</span>
        <span class="season-player__name">${esc(p.name)}</span>
        <span class="season-player__price">£${p.price.toFixed(1)}m</span>
        <span class="season-player__pts">${p.points.toFixed(1)}</span>
      </span>`).join('')
  : Array.from({ length: 5 }, () =>
      '<span class="season-player"><span class="skeleton skeleton--text"></span></span>').join('');
```

- [ ] **Step 4: Verify in the browser**

Run: reload `http://localhost:3000/#matchup` and immediately open a late gameweek.
Expected: skeleton rows, replaced by real names within a second or two. Then check the pass completed:

```js
// after ~5s
document.querySelectorAll('.season-gw__dot').length   // > 0 across the ribbon
```

**Performance gate.** Time the pass:

```js
performance.mark('a'); /* reload, wait for dots */ performance.measure('pass', 'a');
```
If the ribbon is unresponsive for more than ~2s, switch to the fallback in spec §7: compute a week's players on demand when it is opened, and drop the dots to a cheaper proxy.

Also confirm the chip rail corrects itself. Before the pass finishes, the
Triple Captain bands sit on gameweeks 1 and 20; after it completes they should
move. Check in the console:

```js
[...document.querySelectorAll('.season-rail__cell--triplecaptain')].map(c => c.dataset.gw)
```
Expected: NOT `["1","20"]` on a season with any played fixtures.

- [ ] **Step 5: Commit**

```bash
git add projects/apps/gaffer-iq/js/modules/fullSeason.js projects/apps/gaffer-iq/js/engine/season.js
git commit -m "feat(season): fill player rankings from a background pass"
```

---

### Task 12: Documentation and cleanup

**Files:**
- Modify: `ARCHITECTURE.md` (§9 and the module list)
- Modify: `FEATURE_ENGINE.md` (new section for `engine/season.js`)
- Delete: `_mockup-strip.html`

- [ ] **Step 1: Document the engine**

Add a `FEATURE_ENGINE.md` section covering `engine/season.js`: the two-sided matchup read (§6.1 of the spec), the postponement inference and its display-only status (§6.3), the form cache that makes 38 gameweeks affordable (§6.4), and the per-half chip search (§6.5).

- [ ] **Step 2: Update the architecture notes**

In `ARCHITECTURE.md`:
- Add `modules/fullSeason.js` and `engine/season.js` to the module list.
- In §9, note that `attributePostponements` derives a gameweek for display only, and that the `f.gw === null` guard in `fixturesForTeamInWindow` is untouched.

- [ ] **Step 3: Remove the loose prototype**

```bash
rm projects/apps/gaffer-iq/_mockup-strip.html
```

The committed copy at `docs/superpowers/specs/2026-09-01-full-season-strip-prototype.html` stays as the motion reference.

- [ ] **Step 4: Full verification pass**

Open `http://localhost:3000/#matchup` and confirm:
- 38 columns; GW19|20 hairline; played weeks as stubs.
- Opening a week: panel floats upward over the cards; document height unchanged.
- Switching weeks: both animate together; the clicked column moves only by its own directional shift.
- Postponed weeks: red-outlined rows filling from the bottom, slot 1 still live.
- No console errors on any route (`#matchup`, `#fixtures`, `#ranker`, `#dashboard`, `#planner`).

- [ ] **Step 5: Commit**

```bash
git add -A projects/apps/gaffer-iq
git commit -m "docs(season): document the Full Season engine and strip"
```

---

## Self-review notes

**Spec coverage.** §5 layout → Tasks 8–10. §6.1 matchups → Task 2. §6.2 week strength → Task 2 (`isLoadedWeek`). §6.3 postponements → Tasks 3–4. §6.4 players → Tasks 5, 11. §6.5 chip windows → Task 6. §7 module and loading → Tasks 8, 11. §8 motion → Task 10. §9 visual language → Tasks 8–10. §10 config → Task 1. §11 risks → Task 11's performance gate.

**Type consistency.** `Matchup` shape is fixed in Task 2 and reused unchanged in Tasks 4 and 7 — `postponed` rows differ only in carrying `value: null` and `favouredId: null`. `PlayerRow` is fixed in Task 5 and consumed in Task 11. `ChipWindow` is fixed in Task 6 and consumed in Task 9. `gwStats` is produced in Task 7 and consumed in Task 6 — Task 6 is written first, so its test defines the shape Task 7 must emit.
