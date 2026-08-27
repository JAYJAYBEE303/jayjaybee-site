# Schedule Irregularities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make double gameweeks, blank gameweeks, postponed fixtures and TBC kickoffs visible in every tab, and fix the two model defects underneath them.

**Architecture:** Schedule structure is expressed through geometry (grouped cells, hatching, dots, pills); fixture quality keeps colour, because colour is already committed to the five score bands app-wide. Engine work splits into two independent edits: a scoring recalibration that moves numbers, and a derived grouping helper that moves none. The grouping helper leaves `scoreOverHorizon`'s `perGw` output shape untouched so renderers migrate independently of the recalibration.

**Tech Stack:** Vanilla ES modules, no framework, no build step. `node --test` for unit tests. CSS custom properties in `css/base.css`, BEM-lite components in `css/components.css`.

**Spec:** `docs/superpowers/specs/2026-08-26-schedule-irregularities-design.md`

## Global Constraints

- **No new API calls.** Every field used here is already on the bootstrap-static or fixtures payload the app fetches. If a field appears missing, extend the existing normalise step — never add a second request. (ARCHITECTURE §3 rule 1: only `api.js` calls `fetch()`.)
- **Colour never encodes schedule structure; schedule structure never encodes fixture quality.** The five `--band-…` colours mean fixture quality in all four modules (CONVENTIONS §5.2).
- **Dashed borders mean model confidence**, not schedule state. `--estimated-border-style` is already taken by `pgw-cell--estimated` / `score-chip--estimated`.
- **No raw hex, no new colour prefix.** All colours are `--band-…` / `--color-…` tokens declared in `css/base.css` `:root` (CONVENTIONS §5.3).
- **`season.pendingFixtures` is display-only.** No aggregation may read it. `fixturesForTeamInWindow` keeps its `if (f.gw === null) continue;` guard.
- **`DGW_UPLIFT = 0.35`** and **`DGW_EXPECTED_PTS_FACTOR = 0.9`** — exact values, `js/config.js`.
- **`scoreOverHorizon`'s `perGw` stays one entry per FIXTURE, and no existing field is removed or renamed.** Task 3 adds `provisionalKickoff` to each entry — additive only, so every current consumer keeps working untouched. The gameweek fold is a derived view (`groupPerGwSlots`), never a change to the engine's output.
- **`colCount()` in `ranker.js` stays the single source of truth** for anything spanning that table.
- **Docs and code stay in sync in the same commit** (project convention).
- **This environment cannot run tests.** SentinelOne EDR quarantines test runners and local servers. Every task below gives the real command; if you are Claude Code running in this environment, do not execute it — write the test, write the code, and hand the command to the user. If you are a human or an unrestricted environment, run it.

---

### Task 1: Retain postponed fixtures and TBC kickoffs

Implements spec §4.

**Files:**
- Modify: `js/engine/normalise.js` — `normaliseFixture` (~line 250), `normaliseSeason` (~line 350)
- Test: `tests/engine/normalise.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `Fixture.provisionalKickoff: boolean`; `Season.pendingFixtures: Fixture[]`; `Season.pendingFixturesByTeam: Record<number, Fixture[]>`.

- [ ] **Step 1: Write the failing tests**

```js
/**
 * tests/engine/normalise.test.js
 * Unit tests for engine/normalise.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseFixture } from '../../js/engine/normalise.js';

test('normaliseFixture flags a provisional kickoff time', () => {
  // FPL sets provisional_start_time when the kickoff is TBC — often the
  // precursor to a postponement, so it must survive normalisation.
  const f = normaliseFixture({
    id: 1, event: 24, team_h: 1, team_a: 2, provisional_start_time: true,
  });
  assert.equal(f.provisionalKickoff, true);
});

test('normaliseFixture treats a missing provisional flag as confirmed', () => {
  const f = normaliseFixture({ id: 1, event: 24, team_h: 1, team_a: 2 });
  assert.equal(f.provisionalKickoff, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/engine/normalise.test.js`
Expected: FAIL — `provisionalKickoff` is `undefined`, not `true`.

- [ ] **Step 3: Add the field**

In `normaliseFixture`, directly after the `kickoff:` line:

```js
    kickoff: raw.kickoff_time,       // ISO string; engine never reformats
    // FPL sets provisional_start_time while a kickoff is unconfirmed. It is a
    // schedule-confidence signal, NOT a model-confidence one — do not render it
    // with --estimated-border-style, which already means `provisional` in the
    // scoring sense (see composite.js). See FEATURE_ENGINE §9.1.
    provisionalKickoff: Boolean(raw.provisional_start_time),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/engine/normalise.test.js`
Expected: PASS, 2/2.

- [ ] **Step 5: Add pendingFixtures to normaliseSeason**

In `normaliseSeason`, after `sortedFixtures` is built and before `teams` is assembled:

```js
  // Fixtures with no gameweek assigned — postponed, awaiting a rearranged date.
  // Held in a DISPLAY-ONLY channel: they are deliberately NOT appended to
  // `fixtures`, because fixturesForTeamInWindow (and every other aggregation)
  // keys off a gameweek these do not have. See the spec's §4 invariant.
  const pendingFixtures = (fixturesRaw || [])
    .map(normaliseFixture)
    .filter(f => f.gw === null);

  const pendingFixturesByTeam = {};
  for (const f of pendingFixtures) {
    (pendingFixturesByTeam[f.homeTeamId] ||= []).push(f);
    (pendingFixturesByTeam[f.awayTeamId] ||= []).push(f);
  }
```

Add both to the returned object alongside `fixtures`.

**Note:** check whether `sortedFixtures` already excludes `gw === null` entries. If it retains them, derive `pendingFixtures` from `sortedFixtures` by filter instead of re-mapping the raw array, and filter them back out of `sortedFixtures`.

- [ ] **Step 6: Commit**

```bash
git add js/engine/normalise.js tests/engine/normalise.test.js
git commit -m "feat(normalise): retain postponed fixtures and TBC kickoff flag"
```

---

### Task 2: The double-gameweek uplift, as a pure function

Implements spec §5's formula, isolated so it is testable without running the whole aggregation.

**Files:**
- Modify: `js/config.js` (~line 788, beside `BLANK_GW_VALUE`)
- Modify: `js/engine/composite.js` — new export near `scoreOverHorizon`
- Test: `tests/engine/composite.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `applyDgwUplift(gwValue: number, fixtureCount: number) => number`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/composite.test.js`:

```js
import { applyDgwUplift } from '../../js/engine/composite.js';

test('applyDgwUplift leaves a single-fixture gameweek untouched', () => {
  assert.equal(applyDgwUplift(30, 1), 30);
  assert.equal(applyDgwUplift(70, 1), 70);
});

test('applyDgwUplift lifts a poor double above a single poor fixture', () => {
  // The defect this fixes: two chances at points must beat one. 30 + 70*0.35.
  assert.equal(applyDgwUplift(30, 2), 54.5);
});

test('applyDgwUplift lifts a good double toward the ceiling', () => {
  // 70 + 30*0.35 = 80.5 — better than a single 70, still short of 100.
  assert.equal(applyDgwUplift(70, 2), 80.5);
});

test('applyDgwUplift cannot exceed 100', () => {
  // Asymptotic by construction: the uplift is a fraction of the REMAINING
  // headroom, so a perfect fixture stays perfect rather than overflowing.
  assert.equal(applyDgwUplift(100, 2), 100);
  assert.ok(applyDgwUplift(99, 3) <= 100);
});

test('applyDgwUplift scales with a third fixture', () => {
  // (n-1) is the multiplier, so a triple gets twice a double's uplift.
  assert.equal(applyDgwUplift(30, 3), 79);
});

test('applyDgwUplift returns a blank gameweek value unchanged', () => {
  // fixtureCount 0 means the caller already substituted BLANK_GW_VALUE;
  // (n-1) would be negative, which must never DROP the value further.
  assert.equal(applyDgwUplift(40, 0), 40);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/engine/composite.test.js`
Expected: FAIL — `applyDgwUplift` is not exported.

- [ ] **Step 3: Add the constant**

In `js/config.js`, beside `BLANK_GW_VALUE`:

```js
// MODEL: a double gameweek is two chances at a return, not one week that
// matters twice. The uplift is a fraction of the REMAINING headroom to 100, so
// it is asymptotic — a double can never overflow the 0-100 band scale. At 0.35
// a double at 30 lands on 54.5: clearly better than a single 30, clearly worse
// than a single 55. REASONED, NOT FITTED — see the spec's §11 deferred item.
export const DGW_UPLIFT = 0.35;
```

- [ ] **Step 4: Implement**

In `js/engine/composite.js`, import `DGW_UPLIFT` from `../config.js` and add above `scoreOverHorizon`:

```js
/**
 * Lift a gameweek's value for each fixture beyond the first.
 *
 * MODEL: FEATURE_ENGINE §9. Applied to a per-GW value AFTER its fixtures have
 * been collapsed to a mean, never to an individual fixture score. Asymptotic
 * toward 100 so the band scale cannot overflow.
 *
 * @param {number} gwValue      the gameweek's collapsed 0-100 value
 * @param {number} fixtureCount how many fixtures the team plays that gameweek
 * @returns {number}
 */
export function applyDgwUplift(gwValue, fixtureCount) {
  // 0 fixtures means the caller already substituted BLANK_GW_VALUE. Guarding
  // here rather than at the call site keeps the function total: a negative
  // (n-1) would otherwise DEDUCT from a blank, which is not the model.
  if (fixtureCount <= 1) return gwValue;
  return gwValue + (100 - gwValue) * DGW_UPLIFT * (fixtureCount - 1);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/engine/composite.test.js`
Expected: PASS. Existing `metricMaturity` tests still pass.

- [ ] **Step 6: Commit**

```bash
git add js/config.js js/engine/composite.js tests/engine/composite.test.js
git commit -m "feat(engine): add the double-gameweek uplift"
```

---

### Task 3: Collapse-then-aggregate in scoreOverHorizon

Implements spec §5. **This task changes numbers users see.**

**Files:**
- Modify: `js/engine/composite.js` — `scoreOverHorizon`, the `for` loop (~line 790) and the aggregation loop (~line 831)

**Interfaces:**
- Consumes: `applyDgwUplift` (Task 2).
- Produces: unchanged public shape — `{ value, band, confidence, provisional, perGw, breakdown }`. `perGw` entries keep `{ gw, value, band, opponent, venue, isBlank, provisional }`.

- [ ] **Step 1: Restructure the entries loop**

`entries` becomes one element per GAMEWEEK rather than per fixture. Replace the body of the `for (let i = 0; i < gwWindow.length; i++)` loop:

```js
    const gw       = gwWindow[i];
    const gwOffset = i;  // 0 = nearest, matches HORIZON_DECAY exponent
    const fixtures = teamFixturesByGw.get(gw) ?? [];

    if (fixtures.length === 0) {
      // MODEL: blank GW — BLANK_GW_VALUE (40) reflects zero return for assets;
      // mildly bad rather than neutral, never silently skipped. FEATURE_ENGINE §9.
      entries.push({ gwOffset, value: BLANK_GW_VALUE, fixtureScores: [] });
      perGw.push({
        gw, value: BLANK_GW_VALUE, band: bandFromValue(BLANK_GW_VALUE),
        opponent: null, venue: null, isBlank: true,
      });
      continue;
    }

    // Collapse this gameweek's fixtures to ONE aggregation entry, then apply the
    // double uplift. Pushing one entry per fixture (as this did) made a double
    // reweight the gameweek instead of adding a fixture's worth of return, so a
    // bad double scored LOWER than a single bad fixture. See spec §1 D3.
    const scores = fixtures.map(f => scoreFixture(team, f, ctx));
    const rawGwValue = scores.reduce((s, x) => s + x.value, 0) / scores.length;
    const gwValue = applyDgwUplift(rawGwValue, fixtures.length);

    entries.push({ gwOffset, value: gwValue, fixtureScores: scores });

    // perGw stays ONE ENTRY PER FIXTURE — its shape is unchanged and renderers
    // depend on it. groupPerGwSlots (engine/fixtures.js) is what folds it into
    // gameweeks for display.
    fixtures.forEach((f, fi) => {
      const score  = scores[fi];
      const isHome = f.homeTeamId === team.id;
      const oppId  = isHome ? f.awayTeamId : f.homeTeamId;
      const opp    = ctx.teamsById[oppId];
      perGw.push({
        gw,
        value:       score.value,
        band:        score.band,
        opponent:    opp?.shortName ?? null,
        venue:       isHome ? 'H' : 'A',
        isBlank:     false,
        provisional: score.provisional,
        provisionalKickoff: Boolean(f.provisionalKickoff),
      });
    });
```

- [ ] **Step 2: Update the aggregation and confidence loops**

`minVal` now tracks the ADJUSTED per-GW value, which is the point — see spec §5.

```js
  for (const e of entries) {
    const w = Math.pow(HORIZON_DECAY, e.gwOffset);
    wSum   += e.value * w;
    wTotal += w;
    if (e.value < minVal) minVal = e.value;
  }
```

This code is unchanged, but its meaning changes because `entries` is now per-gameweek. Add a comment saying so.

Then replace the confidence block, which currently assumes one `fixtureScore` per entry:

```js
  const allScores = entries.flatMap(e => e.fixtureScores);
  const avgConfidence = allScores.length === 0 ? 0.5
    : allScores.reduce((s, x) => s + (x.confidence ?? 0), 0) / allScores.length;
  const numBlanks = entries.filter(e => e.fixtureScores.length === 0).length;
```

- [ ] **Step 3: Add numDoubles to the breakdown**

```js
    breakdown: {
      aggregateMean,
      aggregateMin,
      aggMethod:  AGG_METHOD,
      numGws,
      numBlanks,
      numDoubles: entries.filter(e => e.fixtureScores.length > 1).length,
    },
```

- [ ] **Step 4: Verify nothing else reads the old entry shape**

Run: `grep -n "fixtureScore" js/engine/composite.js`
Expected: no remaining singular `fixtureScore` references inside `scoreOverHorizon`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If `tests/engine/composite.test.js` has tests asserting horizon values for a double, they will now fail — that is the intended recalibration, so update the expected values and note why in the test comment.

- [ ] **Step 6: Commit**

```bash
git add js/engine/composite.js
git commit -m "fix(engine): score a double gameweek as two chances, not one heavy week"
```

---

### Task 4: expectedPoints fixture-count term

Implements spec §6.

**Files:**
- Modify: `js/config.js` (beside `EXPECTED_PTS_FIXTURE_SWING`, ~line 817)
- Modify: `js/engine/composite.js` — `calcExpectedPoints` (~line 991), call sites at ~1047 and ~1125
- Test: `tests/engine/composite.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `calcExpectedPoints(avgPointsPerGw, nextFixtureScore, playing, fixtureCount)` — **fourth parameter added**, defaults to `1`.

- [ ] **Step 1: Write the failing tests**

```js
import { calcExpectedPoints } from '../../js/engine/composite.js';

const NEUTRAL = { value: 50 };
const FULL    = { value: 100, estimated: false };

test('calcExpectedPoints is unchanged for a single-fixture gameweek', () => {
  const r = calcExpectedPoints({ value: 5, estimated: false }, NEUTRAL, FULL, 1);
  assert.equal(r.value, 5);
});

test('calcExpectedPoints nearly doubles for a double gameweek', () => {
  // 1 + 0.9*(2-1) = 1.9 — a haircut on a straight doubling, because the second
  // fixture of a double carries rotation risk.
  const r = calcExpectedPoints({ value: 5, estimated: false }, NEUTRAL, FULL, 2);
  assert.equal(r.value, 9.5);
});

test('calcExpectedPoints is zero for a blank gameweek', () => {
  // A player whose team does not play cannot score. Today this returns a full
  // projection, which is how a blank-gameweek player can be picked as captain.
  const r = calcExpectedPoints({ value: 5, estimated: false }, NEUTRAL, FULL, 0);
  assert.equal(r.value, 0);
});

test('calcExpectedPoints defaults to a single fixture when count is omitted', () => {
  const r = calcExpectedPoints({ value: 5, estimated: false }, NEUTRAL, FULL);
  assert.equal(r.value, 5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/engine/composite.test.js`
Expected: FAIL — the double case returns 5, not 9.5.

- [ ] **Step 3: Add the constant**

```js
// MODEL: a double gameweek is nearly two gameweeks of return for captaincy
// purposes — but not exactly two. 0.9 is a rotation-risk haircut on the second
// fixture: managers rest players across a congested double far more often than
// across a single. Applied ONLY to expectedPoints; `value` handles the same
// fact through DGW_UPLIFT. See FEATURE_ENGINE §10.2.
export const DGW_EXPECTED_PTS_FACTOR = 0.9;
```

- [ ] **Step 4: Implement**

```js
export function calcExpectedPoints(avgPointsPerGw, nextFixtureScore, playing, fixtureCount = 1) {
  const fixtureMultiplier = 1 + EXPECTED_PTS_FIXTURE_SWING * ((nextFixtureScore.value - 50) / 50);
  const minutesMultiplier = playing.value / 100;
  // A blank yields 0 (the team does not play); a double yields ~1.9x. Clamped at
  // 0 so a negative count can never invert the projection.
  const countMultiplier   = Math.max(0, 1 + DGW_EXPECTED_PTS_FACTOR * (fixtureCount - 1));
  return {
    value:     avgPointsPerGw.value * fixtureMultiplier * minutesMultiplier * countMultiplier,
    estimated: avgPointsPerGw.estimated || playing.estimated,
  };
}
```

- [ ] **Step 5: Pass the count at the real call site**

At `js/engine/composite.js:1125`, inside `scorePlayer`, `teamFixturesByGw` is already in scope:

```js
    expectedPoints: calcExpectedPoints(
      avgPointsPerGw, nextFixtureScore, playing,
      (teamFixturesByGw.get(ctx.currentGw) ?? []).length,
    ),
```

Leave the early-return call at line ~1047 alone — it has no fixture context and correctly defaults to 1.

- [ ] **Step 6: Run and commit**

Run: `npm test` — Expected: PASS.

```bash
git add js/config.js js/engine/composite.js tests/engine/composite.test.js
git commit -m "fix(engine): project double-gameweek captains at ~2x and blanks at zero"
```

---

### Task 5: groupPerGwSlots

Implements spec §7. Pure, non-breaking — this is what makes the strips truthful.

**Files:**
- Modify: `js/engine/fixtures.js` (append export)
- Test: `tests/engine/fixtures.test.js` (create)

**Interfaces:**
- Consumes: `perGw` from `scoreOverHorizon` (unchanged shape).
- Produces: `groupPerGwSlots(perGw) => Array<{ gw, fixtures, isDouble, isBlank }>`.

- [ ] **Step 1: Write the failing tests**

```js
/**
 * tests/engine/fixtures.test.js
 * Unit tests for engine/fixtures.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupPerGwSlots } from '../../js/engine/fixtures.js';

test('groupPerGwSlots gives one slot per gameweek for a plain run', () => {
  const slots = groupPerGwSlots([
    { gw: 23, opponent: 'BUR', isBlank: false },
    { gw: 24, opponent: 'ARS', isBlank: false },
  ]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].fixtures.length, 1);
  assert.equal(slots[0].isDouble, false);
});

test('groupPerGwSlots folds a double into one slot holding two fixtures', () => {
  // The whole point: perGw carries two entries with the SAME gw, and the strip
  // must render them as one week rather than two.
  const slots = groupPerGwSlots([
    { gw: 24, opponent: 'EVE', isBlank: false },
    { gw: 24, opponent: 'SHU', isBlank: false },
    { gw: 25, opponent: 'ARS', isBlank: false },
  ]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].gw, 24);
  assert.equal(slots[0].fixtures.length, 2);
  assert.equal(slots[0].isDouble, true);
  assert.equal(slots[1].isDouble, false);
});

test('groupPerGwSlots marks a blank slot and keeps it in sequence', () => {
  const slots = groupPerGwSlots([
    { gw: 25, opponent: 'ARS', isBlank: false },
    { gw: 26, opponent: null,  isBlank: true  },
    { gw: 27, opponent: 'MCI', isBlank: false },
  ]);
  assert.equal(slots.length, 3);
  assert.equal(slots[1].isBlank, true);
  assert.equal(slots[1].isDouble, false);
});

test('groupPerGwSlots preserves gameweek order', () => {
  // perGw is built in window order, but never rely on it — the slot sequence is
  // what the strip renders left to right.
  const slots = groupPerGwSlots([
    { gw: 27, isBlank: false }, { gw: 24, isBlank: false }, { gw: 24, isBlank: false },
  ]);
  assert.deepEqual(slots.map(s => s.gw), [24, 27]);
});

test('groupPerGwSlots returns an empty array for empty input', () => {
  assert.deepEqual(groupPerGwSlots([]), []);
  assert.deepEqual(groupPerGwSlots(null), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/engine/fixtures.test.js`
Expected: FAIL — `groupPerGwSlots` is not exported.

- [ ] **Step 3: Implement**

```js
/**
 * Fold scoreOverHorizon's flat perGw array into one slot per GAMEWEEK.
 *
 * perGw carries one entry per FIXTURE, so a double gameweek appears as two
 * entries sharing a `gw`. Rendered flat, a 6-GW horizon containing a double
 * shows seven cells with nothing tying two of them together. This is the fold
 * that makes the strip say what it means.
 *
 * Deliberately a DERIVED view rather than a change to scoreOverHorizon's output:
 * the engine's contract stays stable while renderers migrate one at a time.
 *
 * @param {Array} perGw  from scoreOverHorizon
 * @returns {Array<{gw:number, fixtures:Array, isDouble:boolean, isBlank:boolean}>}
 *          ordered by gameweek ascending
 */
export function groupPerGwSlots(perGw) {
  if (!perGw || perGw.length === 0) return [];

  const byGw = new Map();
  for (const entry of perGw) {
    const list = byGw.get(entry.gw) ?? [];
    list.push(entry);
    byGw.set(entry.gw, list);
  }

  return [...byGw.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gw, fixtures]) => ({
      gw,
      fixtures,
      // A blank is ONE entry flagged isBlank, never two — so these are mutually
      // exclusive by construction, not by assertion.
      isDouble: fixtures.length > 1,
      isBlank:  fixtures.length === 1 && Boolean(fixtures[0].isBlank),
    }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/engine/fixtures.test.js`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add js/engine/fixtures.js tests/engine/fixtures.test.js
git commit -m "feat(engine): fold the per-GW strip into gameweek slots"
```

---

### Task 6: Pending fixtures and the gameweek irregularity summary

Implements the remaining two helpers in spec §7.

**Files:**
- Modify: `js/engine/fixtures.js` (append two exports)
- Test: `tests/engine/fixtures.test.js` (append)

**Interfaces:**
- Consumes: `Season.pendingFixturesByTeam` (Task 1).
- Produces:
  - `pendingFixturesForTeam(teamId, ctx) => Fixture[]`
  - `summariseGwIrregularities(ctx, fromGw, count) => Array<{ gw, doubleTeams: number, blankTeams: number }>` — only gameweeks that are irregular appear; an ordinary window returns `[]`.

- [ ] **Step 1: Write the failing tests**

```js
import { pendingFixturesForTeam, summariseGwIrregularities } from '../../js/engine/fixtures.js';

test('pendingFixturesForTeam returns nothing when the team has no postponements', () => {
  assert.deepEqual(pendingFixturesForTeam(1, { pendingFixturesByTeam: {} }), []);
});

test('pendingFixturesForTeam returns the team postponed fixtures', () => {
  const f = { id: 9, gw: null, homeTeamId: 1, awayTeamId: 2 };
  const out = pendingFixturesForTeam(1, { pendingFixturesByTeam: { 1: [f] } });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 9);
});

test('summariseGwIrregularities returns nothing for an ordinary window', () => {
  // Two teams, one fixture each per gameweek — the context bar must stay hidden.
  const ctx = { fixtures: [
    { gw: 23, homeTeamId: 1, awayTeamId: 2 },
    { gw: 24, homeTeamId: 2, awayTeamId: 1 },
  ], teams: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(summariseGwIrregularities(ctx, 23, 2), []);
});

test('summariseGwIrregularities counts doubling and idle teams', () => {
  // GW24: team 1 plays twice, team 3 not at all.
  const ctx = { fixtures: [
    { gw: 24, homeTeamId: 1, awayTeamId: 2 },
    { gw: 24, homeTeamId: 1, awayTeamId: 4 },
  ], teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
  const out = summariseGwIrregularities(ctx, 24, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].gw, 24);
  assert.equal(out[0].doubleTeams, 1);
  assert.equal(out[0].blankTeams, 1);   // team 3 only; team 4 plays once
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/engine/fixtures.test.js`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement**

```js
/**
 * Postponed fixtures awaiting a rearranged date for one team.
 * Display-only — these have no gameweek, so nothing that aggregates over a
 * gameweek window may read them. See the spec's §4 invariant.
 *
 * @param {number} teamId
 * @param {object} ctx  must carry pendingFixturesByTeam (engine/normalise.js)
 * @returns {Array}
 */
export function pendingFixturesForTeam(teamId, ctx) {
  return ctx?.pendingFixturesByTeam?.[teamId] ?? [];
}

/**
 * Which gameweeks in a window are irregular, and how many teams each affects.
 *
 * Returns ONLY irregular gameweeks — an ordinary window returns an empty array,
 * which is the signal the schedule bar uses to render nothing at all. Most of
 * the season is ordinary, so this is the common case, not the edge case.
 *
 * @param {object} ctx      must carry `fixtures` and `teams`
 * @param {number} fromGw   first gameweek in the window
 * @param {number} count    how many gameweeks to inspect
 * @returns {Array<{gw:number, doubleTeams:number, blankTeams:number}>}
 */
export function summariseGwIrregularities(ctx, fromGw, count) {
  const teams = ctx?.teams ?? [];
  if (teams.length === 0) return [];

  const out = [];
  for (let gw = fromGw; gw < fromGw + count; gw++) {
    const playCount = new Map(teams.map(t => [t.id, 0]));
    for (const f of ctx.fixtures ?? []) {
      if (f.gw !== gw) continue;
      if (playCount.has(f.homeTeamId)) playCount.set(f.homeTeamId, playCount.get(f.homeTeamId) + 1);
      if (playCount.has(f.awayTeamId)) playCount.set(f.awayTeamId, playCount.get(f.awayTeamId) + 1);
    }
    let doubleTeams = 0;
    let blankTeams  = 0;
    for (const n of playCount.values()) {
      if (n > 1) doubleTeams++;
      else if (n === 0) blankTeams++;
    }
    if (doubleTeams > 0 || blankTeams > 0) out.push({ gw, doubleTeams, blankTeams });
  }
  return out;
}
```

- [ ] **Step 4: Run and commit**

Run: `node --test tests/engine/fixtures.test.js` — Expected: PASS, 9/9.

```bash
git add js/engine/fixtures.js tests/engine/fixtures.test.js
git commit -m "feat(engine): summarise gameweek irregularities and pending fixtures"
```

---

### Task 7: The shared visual vocabulary (CSS)

Implements spec §8's four treatments. No JS in this task — the classes land first so Tasks 8–12 consume a vocabulary that already exists.

**Files:**
- Modify: `css/components.css` — beside the existing `.pgw-cell` block

**Interfaces:**
- Produces these classes, consumed by Tasks 8, 9, 12:
  - `.pgw-slot`, `.pgw-slot__cells`, `.pgw-slot__label`, `.pgw-slot--double`
  - `.pgw-cell--blank`, `.pgw-cell--tbc`
  - `.pgw-pending`

- [ ] **Step 1: Add the slot wrapper**

```css
/* ── Gameweek slots ────────────────────────────────────────────────────────
   One slot per GAMEWEEK, holding zero, one or two fixture cells. Schedule
   structure is carried by GEOMETRY here, never colour: the five band colours
   already mean fixture quality in all four modules (CONVENTIONS §5.2), so a
   double against brutal opposition must read as red-and-grouped. */

.pgw-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.pgw-slot__cells {
  display: flex;
  gap: 2px;
}

.pgw-slot__label {
  font-size: 0.5625rem;
  line-height: 1;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

/* Double: the two cells are bound into one week by an accent-tinted group.
   --color-accent is the app's "structural emphasis" colour and is NOT one of
   the five band colours, so this cannot be misread as a quality signal. */
.pgw-slot--double .pgw-slot__cells {
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--color-accent-muted);
  outline: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
}

.pgw-slot--double .pgw-slot__label {
  color: var(--color-accent);
}
```

- [ ] **Step 2: Add the blank, TBC and pending treatments**

```css
/* Blank: hatched, so a known-empty week is visibly different from a failed
   load. A bare "–" reads as missing data, which is the bug this replaces. */
.pgw-cell--blank {
  background: repeating-linear-gradient(
    -45deg,
    transparent 0 3px,
    color-mix(in srgb, var(--band-neutral) 28%, transparent) 3px 5px
  );
  border: 1px solid var(--color-border);
  color: var(--color-muted);
}

/* Kickoff TBC: a corner dot in --band-tough. Deliberately NOT a dashed border,
   which already means low MODEL confidence (--estimated-border-style). This is
   schedule confidence — a different axis that must stay legible alongside it. */
.pgw-cell--tbc {
  position: relative;
}

.pgw-cell--tbc::after {
  content: '';
  position: absolute;
  top: 2px;
  right: 2px;
  width: 4px;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--band-tough);
}

/* Postponed: lives OFF the strip, because it has no gameweek to sit in. */
.pgw-pending {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 var(--space-2);
  margin-left: var(--space-1);
  border-radius: var(--radius-sm);
  border: 1px dashed var(--color-border);
  background: color-mix(in srgb, var(--band-neutral) 6%, transparent);
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--color-muted);
  white-space: nowrap;
}
```

- [ ] **Step 3: Realign both strip containers**

The strip children stop being bare 28px cells and become column-flex slots with a gameweek label underneath. The `.pgw-pending` pill has no label, so it is shorter than a slot. Both containers must align their children to the top or the pill floats to the middle of the row.

In `.pgw-strip` (currently sets no `align-items`, so it inherits `stretch`):

```css
.pgw-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: flex-start;   /* slots are column-flex and unequal in height */
}
```

In `.ranker-fixtures` (currently `align-items: center`):

```css
.ranker-fixtures {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 2px;
  align-items: flex-start;   /* was center — see .pgw-strip above */
}
```

- [ ] **Step 4: Verify token discipline**

Run: `grep -nE "#[0-9a-fA-F]{3,6}" css/components.css | grep -iE "pgw-slot|pgw-pending|pgw-cell--blank|pgw-cell--tbc"`
Expected: no output. Every colour must be a `var(--…)` token (CONVENTIONS §5.3).

- [ ] **Step 5: Commit**

```bash
git add css/components.css
git commit -m "style(strip): add the gameweek-slot visual vocabulary"
```

---

### Task 8: Ranker strip → gameweek slots

**Files:**
- Modify: `js/modules/ranker.js` — `buildFixtureStrip`, and its call site in `buildRow`
- Modify: `css/components.css` — the `[data-col="fixtures"]` width may need widening

**Interfaces:**
- Consumes: `groupPerGwSlots`, `pendingFixturesForTeam` (Tasks 5, 6).

- [ ] **Step 1: Rewrite buildFixtureStrip**

```js
/**
 * Render one team's fixture run as a row of GAMEWEEK slots. Each slot holds
 * zero (blank), one, or two (double) fixture cells. Postponed fixtures have no
 * gameweek, so they trail the strip as a pill rather than sitting inside it.
 *
 * @param {Array} perGw   from scoreOverHorizon
 * @param {Array} pending from pendingFixturesForTeam
 * @returns {string} HTML
 */
function buildFixtureStrip(perGw, pending = []) {
  const slots = groupPerGwSlots(perGw);
  if (slots.length === 0) {
    return '<span class="ranker-no-fixtures">—</span>';
  }

  const slotHtml = slots.map(slot => {
    const cells = slot.fixtures.map(entry => {
      const band = entry.isBlank ? 'neutral' : entry.band;
      const tooltip = entry.isBlank
        ? `GW${entry.gw} (blank — no fixture)`
        : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}`
          + `${entry.provisional ? ' ~est' : ''}`
          + `${entry.provisionalKickoff ? ' — kickoff TBC' : ''}`;
      const label    = entry.isBlank ? '∅' : (entry.opponent ?? '?');
      const estClass = (!entry.isBlank && entry.provisional) ? ' pgw-cell--estimated' : '';
      const blkClass = entry.isBlank ? ' pgw-cell--blank' : '';
      const tbcClass = entry.provisionalKickoff ? ' pgw-cell--tbc' : '';
      return `<span class="pgw-cell pgw-cell--${esc(band)}${estClass}${blkClass}${tbcClass}" title="${esc(tooltip)}">${esc(label)}</span>`;
    }).join('');

    const dblClass = slot.isDouble ? ' pgw-slot--double' : '';
    const dblMark  = slot.isDouble ? ' ··' : '';
    return `<span class="pgw-slot${dblClass}">`
      + `<span class="pgw-slot__cells">${cells}</span>`
      + `<span class="pgw-slot__label">${slot.gw}${dblMark}</span>`
      + `</span>`;
  }).join('');

  const pendingHtml = pending.length > 0
    ? `<span class="pgw-pending" title="${pending.length} postponed fixture${pending.length > 1 ? 's' : ''} awaiting a rearranged date">+${pending.length} TBD</span>`
    : '';

  return `<span class="ranker-fixtures">${slotHtml}${pendingHtml}</span>`;
}
```

- [ ] **Step 2: Update the import and the call site**

Add to the imports at the top of `ranker.js`:

```js
import { groupPerGwSlots, pendingFixturesForTeam } from '../engine/fixtures.js';
```

In `buildRow`, replace `${buildFixtureStrip(score.perGw)}` with:

```js
        ${buildFixtureStrip(score.perGw, pendingFixturesForTeam(player.teamId, buildCtx()))}
```

**Performance note:** `buildCtx()` is called once per row here, which is wrong at ~700 rows. Hoist it: `renderTable` already builds a ctx for `buildLastSeasonLookup` — pass the pending list down through `buildRow`'s existing parameter list instead, the same way `nextFixtureRankById` is passed.

- [ ] **Step 3: Widen the fixtures column**

Slots are taller and slightly wider than bare cells. In `css/components.css`, the `[data-col="fixtures"]` width is `11.00%` after the Ranker column work. Raise it to `13.00%` and take `2.00%` off `[data-sort="name"]` (`13.60%` → `11.60%`).

Run: `grep -o 'ranker-table__th\[data-[a-z]*="[a-zA-Z-]*"\][ ]*{ width: [0-9.]*%' css/components.css | sed 's/.*width: //;s/%//' | awk '{s+=$1} END {printf "%.2f%%\n", s}'`
Expected: `100.00%`. `table-layout: fixed` silently redistributes any shortfall.

- [ ] **Step 4: Verify by reading**

Run: `node --check js/modules/ranker.js`
Expected: exit 0.

**Cannot be verified here:** whether the slot row fits the widened column at a 6-GW horizon without wrapping. Open the Ranker and look.

- [ ] **Step 5: Commit**

```bash
git add js/modules/ranker.js css/components.css
git commit -m "feat(ranker): render the fixture strip as gameweek slots"
```

---

### Task 9: Matchup strip → gameweek slots

**Files:**
- Modify: `js/modules/matchup.js` — `buildPerGwStrip` (~line 647), `resolveFixtureId` (~line 619)

**Interfaces:**
- Consumes: `groupPerGwSlots`, `pendingFixturesForTeam` (Tasks 5, 6).

- [ ] **Step 1: Wrap the existing cells in slots**

`buildPerGwStrip` currently maps `perGw` directly to cells. Keep every existing cell attribute — the click-through `data-fixture-id`, `pgw-cell--estimated`, `pgw-cell--static`, and the `.pgw-cell__extra` hover block — and wrap the map in the same slot structure Task 8 introduced:

```js
function buildPerGwStrip(team, perGw, pending = []) {
  const slots = groupPerGwSlots(perGw);
  if (slots.length === 0) return '';

  const slotHtml = slots.map(slot => {
    const cells = slot.fixtures.map(entry => {
      const bandClass  = entry.isBlank ? 'neutral' : entry.band;
      const estClass   = (!entry.isBlank && entry.provisional) ? ' pgw-cell--estimated' : '';
      const blkClass   = entry.isBlank ? ' pgw-cell--blank' : '';
      const tbcClass   = entry.provisionalKickoff ? ' pgw-cell--tbc' : '';
      const fixtureId  = findFixtureId(team, entry);
      const clickClass = fixtureId !== null ? '' : ' pgw-cell--static';
      const idAttr     = fixtureId !== null ? ` data-fixture-id="${fixtureId}"` : '';
      const tabAttr    = fixtureId !== null ? ' tabindex="0"' : '';
      const label = entry.isBlank
        ? `GW${entry.gw} — blank (no fixture)`
        : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}`
          + `${entry.provisionalKickoff ? ' — kickoff TBC' : ''}`;
      const display = entry.isBlank ? '∅' : Math.round(entry.value);
      const oppText = entry.isBlank ? '–' : esc(String(entry.opponent ?? '').toUpperCase());
      const venText = entry.isBlank ? '' : esc(entry.venue ?? '');
      return `<div class="pgw-cell pgw-cell--${esc(bandClass)}${estClass}${blkClass}${tbcClass}${clickClass}"${idAttr}${tabAttr} title="${esc(label)}">`
        + `<span class="pgw-cell__score">${esc(String(display))}</span>`
        + `<div class="pgw-cell__extra"><div class="pgw-cell__extra-inner">`
        + `<span class="pgw-cell__opponent">${oppText}</span>`
        + `<span class="pgw-cell__venue">${venText}</span>`
        + `</div></div></div>`;
    }).join('');

    const dblClass = slot.isDouble ? ' pgw-slot--double' : '';
    const dblMark  = slot.isDouble ? ' ··' : '';
    return `<div class="pgw-slot${dblClass}">`
      + `<div class="pgw-slot__cells">${cells}</div>`
      + `<div class="pgw-slot__label">${slot.gw}${dblMark}</div>`
      + `</div>`;
  }).join('');

  const pendingHtml = pending.length > 0
    ? `<div class="pgw-pending" title="${pending.length} postponed fixture${pending.length > 1 ? 's' : ''} awaiting a rearranged date">+${pending.length} TBD</div>`
    : '';

  // Keep the .pgw-strip wrapper — components.css lays the strip out through it,
  // and the delegated click handler in initMatchup() is scoped to it.
  return `<div class="pgw-strip">${slotHtml}${pendingHtml}</div>`;
}
```

Three details that are easy to lose in this rewrite:

1. `findFixtureId(team, entry)` is the existing private helper at `js/modules/matchup.js:618` — **not** `resolveFixtureId`. It already disambiguates a double's two same-gameweek fixtures by matching on `gw` + venue + opponent short name, so it needs no change.
2. The blank cell's `display` changes from `'–'` to `'∅'`, matching Task 8. The dash is what currently makes a blank indistinguishable from a load failure.
3. Both strip containers need `align-items: flex-start` — see Task 7 Step 3. `.pgw-strip` currently sets none (defaults to `stretch`) and `.ranker-fixtures` sets `center`. Neither works once the children are column-flex slots of differing height: the `.pgw-pending` pill has no gameweek label under it, so it is shorter than a slot and would float to the middle instead of sitting level with the cell rows.

- [ ] **Step 2: Pass pending fixtures at the call site**

At `js/modules/matchup.js:717`, `${buildPerGwStrip(team, horizonScore.perGw)}` becomes:

```js
      ${buildPerGwStrip(team, horizonScore.perGw, pendingFixturesForTeam(team.id, ctx))}
```

Use whatever `ctx` variable is already in scope at that point — do not build a new one.

- [ ] **Step 3: Confirm the click-through still resolves**

Run: `grep -n "data-fixture-id" js/modules/matchup.js`
Expected: still present inside the cell body. The slot wrapper must not swallow the click — the delegated handler uses `closest('[data-fixture-id]')`, which still matches.

- [ ] **Step 4: Run and commit**

Run: `node --check js/modules/matchup.js` — Expected: exit 0.

```bash
git add js/modules/matchup.js
git commit -m "feat(matchup): render the horizon strip as gameweek slots"
```

---

### Task 10: Dashboard — show both fixtures of a double

Fixes spec §1 D2.

**Files:**
- Modify: `js/modules/dashboard.js` — `buildFixtureContextLabel` (~line 189)

**Interfaces:**
- Consumes: `groupPerGwSlots` (Task 5).

- [ ] **Step 1: Write the failing test**

`buildFixtureContextLabel` is module-private. Export it for testing — the module already exports `initDashboard`, and a second named export costs nothing.

```js
/**
 * tests/modules/dashboard.test.js
 * Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFixtureContextLabel } from '../../js/modules/dashboard.js';

test('buildFixtureContextLabel names a single fixture', () => {
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 24, opponent: 'ARS', venue: 'H', isBlank: false },
  ] });
  assert.equal(label, 'GW24 vs ARS (H)');
});

test('buildFixtureContextLabel names BOTH fixtures of a double', () => {
  // The defect: this read perGw[0] and silently dropped the second fixture,
  // so the line used to sanity-check a captaincy pick told half the truth.
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 24, opponent: 'EVE', venue: 'H', isBlank: false },
    { gw: 24, opponent: 'SHU', venue: 'A', isBlank: false },
  ] });
  assert.equal(label, 'GW24 (double) vs EVE (H), SHU (A)');
});

test('buildFixtureContextLabel marks a blank gameweek', () => {
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 26, opponent: null, venue: null, isBlank: true },
  ] });
  assert.equal(label, 'GW26 — Blank');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/modules/dashboard.test.js`
Expected: FAIL — the double case returns `GW24 vs EVE (H)`.

- [ ] **Step 3: Implement**

```js
/**
 * Build the "which fixture is this" context line for a breakdown panel.
 * Dashboard is GW1-locked, so score.perGw covers exactly one gameweek — but
 * that gameweek may hold TWO fixtures. This previously read perGw[0] and
 * discarded the second, which is precisely the information a user opens this
 * line to check on a double.
 */
export function buildFixtureContextLabel(score) {
  const slots = groupPerGwSlots(score?.perGw ?? []);
  const slot  = slots[0];
  if (!slot) return HORIZON.label;
  if (slot.isBlank) return `GW${slot.gw} — Blank`;

  const fixtures = slot.fixtures
    .map(f => `${f.opponent ?? '?'} (${f.venue ?? '?'})`)
    .join(', ');
  const marker = slot.isDouble ? ' (double)' : '';
  return `GW${slot.gw}${marker} vs ${fixtures}`;
}
```

Add `import { groupPerGwSlots } from '../engine/fixtures.js';` to the module imports.

- [ ] **Step 4: Run and commit**

Run: `node --test tests/modules/dashboard.test.js` — Expected: PASS, 3/3.

```bash
git add js/modules/dashboard.js tests/modules/dashboard.test.js
git commit -m "fix(dashboard): show both fixtures of a double gameweek"
```

---

### Task 11: The app-wide schedule context bar

Implements spec §8's shell row. This is what makes the feature reach Dashboard, Planner and Fixtures, none of which render a fixture strip.

**Files:**
- Create: `js/modules/scheduleBar.js`
- Modify: `index.html` — above `<main class="app-main">` (~line 49)
- Modify: `js/main.js` — import and init
- Modify: `css/components.css` — bar styles

**Interfaces:**
- Consumes: `summariseGwIrregularities` (Task 6), `store.getCurrentGw`, `store.subscribe`.
- Produces: `initScheduleBar()`.

- [ ] **Step 1: Add the markup**

In `index.html`, immediately before `<main class="app-main">`:

```html
      <!-- Schedule context bar. Hidden unless the next six gameweeks contain a
           double or a blank — see js/modules/scheduleBar.js. -->
      <div class="schedule-bar" id="schedule-bar" hidden></div>
```

- [ ] **Step 2: Write the module**

```js
/**
 * js/modules/scheduleBar.js
 * Layer: module. Owns the DOM for the app-wide schedule context bar.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders a one-line summary of which gameweeks in the next six are doubles or
 * blanks. Hidden entirely when the window is ordinary, which is most of the
 * season — the bar must never cost vertical space it has nothing to say in.
 * See FEATURE_ENGINE §9.1.
 *
 * Subscriptions: data:ready
 */

import { store } from '../store.js';
import { summariseGwIrregularities } from '../engine/fixtures.js';

const WINDOW_GWS = 6;

let _root = null;

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render() {
  if (!_root) return;

  const season   = store.getSeason();
  const currentGw = store.getCurrentGw();
  if (!season || currentGw === null) {
    _root.hidden = true;
    return;
  }

  const rows = summariseGwIrregularities(season, currentGw, WINDOW_GWS);
  if (rows.length === 0) {
    // Nothing to say: render nothing at all rather than an empty bar.
    _root.hidden = true;
    _root.innerHTML = '';
    return;
  }

  const items = rows.map(r => {
    const parts = [];
    if (r.doubleTeams > 0) {
      parts.push(`<b class="schedule-bar__gw">GW${r.gw} · Double</b>`
        + `<span class="schedule-bar__detail">${r.doubleTeams} team${r.doubleTeams > 1 ? 's' : ''} play twice</span>`);
    }
    if (r.blankTeams > 0) {
      parts.push(`<b class="schedule-bar__gw">GW${r.gw} · Blank</b>`
        + `<span class="schedule-bar__detail">${r.blankTeams} team${r.blankTeams > 1 ? 's' : ''} idle</span>`);
    }
    return parts.join('<span class="schedule-bar__sep"></span>');
  }).join('<span class="schedule-bar__sep"></span>');

  _root.innerHTML = `<div class="schedule-bar__inner">${items}</div>`;
  _root.hidden = false;
}

export function initScheduleBar() {
  _root = document.getElementById('schedule-bar');
  if (!_root) return;
  store.subscribe('data:ready', render);
  render();
}
```

`esc` is unused in the current body but kept for the moment team names are added — **delete it instead** if you are not adding names, per the project's no-dead-code convention.

- [ ] **Step 3: Wire it into main.js**

```js
import { initScheduleBar } from './modules/scheduleBar.js';
```

Call `initScheduleBar()` alongside the other `init*` calls.

- [ ] **Step 4: Style it**

```css
/* ── Schedule context bar ──────────────────────────────────────────────────
   App-wide, above every module view. Carries schedule shape to the three tabs
   that render no fixture strip (Dashboard, Planner, Fixtures). Uses
   --color-accent, the structural-emphasis colour, so it cannot be misread as a
   fixture-quality signal. */

.schedule-bar {
  padding: var(--space-2) var(--space-4) 0;
}

.schedule-bar__inner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-accent-muted);
  border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
  font-size: var(--font-size-xs);
  color: var(--color-text);
}

.schedule-bar__gw     { color: var(--color-accent); font-weight: 700; margin-right: var(--space-2); }
.schedule-bar__detail { color: var(--color-muted); }

.schedule-bar__sep {
  width: 1px;
  height: 12px;
  background: var(--color-border);
}
```

- [ ] **Step 5: Verify**

Run: `node --check js/modules/scheduleBar.js && node --check js/main.js`
Expected: exit 0 for both.

**Cannot be verified here:** that the bar hides itself on an ordinary window. Load the app on a week with no doubles and confirm no empty bar appears.

- [ ] **Step 6: Commit**

```bash
git add js/modules/scheduleBar.js js/main.js index.html css/components.css
git commit -m "feat(shell): add the app-wide schedule context bar"
```

---

### Task 12: Planner and Fixtures tabs

**Files:**
- Modify: `js/modules/planner.js` — `renderTransferCard` (~line 510)
- Modify: `js/modules/fixtures.js` — `renderGameweekPane` (~line 815)

**Interfaces:**
- Consumes: `groupPerGwSlots`, `pendingFixturesForTeam` (Tasks 5, 6).

- [ ] **Step 1: Flag doubles and blanks on transfer cards**

In `renderTransferCard`, for the incoming player, derive the slot for the current gameweek and add a marker beside the name:

```js
  const inSlots  = groupPerGwSlots(swap.in?.score?.perGw ?? []);
  const inSlot   = inSlots[0];
  const scheduleMark = !inSlot ? ''
    : inSlot.isDouble
      ? '<span class="planner-schedule-mark planner-schedule-mark--double" title="Double gameweek — plays twice">··</span>'
      : inSlot.isBlank
        ? '<span class="planner-schedule-mark planner-schedule-mark--blank" title="Blank gameweek — does not play">∅</span>'
        : '';
```

Interpolate `${scheduleMark}` after the incoming player's name. Do the same for the outgoing player — transferring OUT of a double is the mistake this is meant to catch.

Add to `css/components.css`:

```css
.planner-schedule-mark {
  margin-left: var(--space-1);
  font-size: 0.625rem;
  font-weight: 700;
}
.planner-schedule-mark--double { color: var(--color-accent); }
.planner-schedule-mark--blank  { color: var(--color-muted); }
```

- [ ] **Step 2: Add a postponed section to the Fixtures gameweek pane**

At the end of `renderGameweekPane`, after the fixture list:

```js
  const pending = store.getSeason()?.pendingFixtures ?? [];
  const pendingHtml = pending.length === 0 ? '' : `
    <section class="fixtures-pending">
      <h3 class="fixtures-pending__heading">Postponed — awaiting a date</h3>
      <ul class="fixtures-pending__list">
        ${pending.map(f => {
          const h = store.getTeam(f.homeTeamId);
          const a = store.getTeam(f.awayTeamId);
          return `<li class="fixtures-pending__item">${esc(h?.shortName ?? '?')} v ${esc(a?.shortName ?? '?')}</li>`;
        }).join('')}
      </ul>
    </section>`;
```

Append `pendingHtml` to the pane's output. Renders nothing when there are no postponements, which is the normal state.

- [ ] **Step 3: Verify**

Run: `node --check js/modules/planner.js && node --check js/modules/fixtures.js`
Expected: exit 0 for both.

- [ ] **Step 4: Commit**

```bash
git add js/modules/planner.js js/modules/fixtures.js css/components.css
git commit -m "feat(planner,fixtures): flag doubles, blanks and postponements"
```

---

### Task 13: Documentation sync

Project convention: docs and code land in the same commit. This task exists because Tasks 3 and 4 made two FEATURE_ENGINE claims false.

**Files:**
- Modify: `FEATURE_ENGINE.md` — §9, §10.2, new §9.1
- Modify: `ARCHITECTURE.md` — §9's blank/double paragraph
- Modify: `docs/superpowers/specs/2026-08-26-schedule-irregularities-design.md` — the `**Plan:**` header line

- [ ] **Step 1: Correct FEATURE_ENGINE §9's double-gameweek claim**

The current text — "both fixtures are scored and included; the team effectively gets two entries in the window, naturally boosting its horizon score" — describes behaviour that did not exist and no longer describes the implementation. Replace with the collapse-then-uplift model, including the worked table from spec §5 and the `DGW_UPLIFT` constant.

- [ ] **Step 2: Add FEATURE_ENGINE §9.1 — schedule irregularities**

Document all four states (double, blank, postponed, TBC), the geometry-not-colour rule, the four CSS treatments, and `groupPerGwSlots`' role as a derived view that leaves `perGw` unchanged.

- [ ] **Step 3: Correct FEATURE_ENGINE §10.2**

Add the `DGW_EXPECTED_PTS_FACTOR` term to the `expectedPoints` formula block, and state that a blank yields zero.

- [ ] **Step 4: Update ARCHITECTURE §9**

The blank/double paragraph says `engine/fixtures.js` "is responsible for resolving each team's fixture list per horizon correctly". That is `composite.js`'s `fixturesForTeamInWindow`. Correct the attribution and add the pending-fixtures display-only invariant.

- [ ] **Step 5: Confirm the spec points at this plan**

Run: `grep -n '^\*\*Plan:\*\*' docs/superpowers/specs/2026-08-26-schedule-irregularities-design.md`
Expected: `**Plan:** \`docs/superpowers/plans/2026-08-26-schedule-irregularities.md\`` — already set when the plan was written. If it still reads "not yet written", set it.

- [ ] **Step 6: Commit**

```bash
git add FEATURE_ENGINE.md ARCHITECTURE.md docs/superpowers/specs/2026-08-26-schedule-irregularities-design.md
git commit -m "docs: sync the engine docs with the schedule-irregularity work"
```

---

## Final verification

Run these before calling the work done. **None of them can be run by Claude Code in this environment** — SentinelOne EDR quarantines test runners and local servers.

```bash
npm test
```

Expected: all suites pass — `composite`, `fixtures`, `normalise`, `dashboard`, `channel`, `counter`, `roleThresholds`, `prices`.

Then, in a browser:

1. **Ranker** — open a gameweek containing a real double. Confirm the strip shows six slots for a 6-GW horizon, the double is grouped and outlined, and the row does not wrap inside the fixtures column.
2. **Matchup** — same strip, and confirm clicking a cell still opens that fixture.
3. **Dashboard** — on a double, confirm the fixture-context line names both fixtures.
4. **Schedule bar** — confirm it is absent on an ordinary week and present on an irregular one.
5. **Recalibration sanity check** — compare the Ranker's band distribution before and after Task 3. A large shift in how many players sit in each band means `DGW_UPLIFT` needs revisiting. This is the check that cannot be automated and matters most; the constant is reasoned, not fitted.
