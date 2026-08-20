# Understat Channel Counters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ICT-based role classification with Understat chain data, and add a third counter-matchup tier that scores a team's threat profile against its opponent's conceding profile using Understat's per-team `statistics` block.

**Architecture:** Three-tier ladder selected by data availability — `channel` (team `statistics` axes) → `role` (chain-based classification, form units) → `element` (unchanged floor). Channel logic lives in a new pure engine module `js/engine/channel.js`; `engine/counter.js` selects the tier. All new constants land in `js/config.js`. The sum-to-100 mirroring identity is preserved by keeping `calcCounterMatchupMirrored` arithmetic.

**Tech Stack:** Vanilla ES2022 modules, no runtime dependencies. Tests use Node's built-in `node --test` runner (no packages installed).

**Spec:** `docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md`

## Global Constraints

- **Engine purity** (CONVENTIONS §3.3): files under `js/engine/` take all inputs as explicit parameters, never mutate arguments, never read globals except `config.js` imports, no DOM, no network, no store access.
- **No magic numbers in engine code** (CONVENTIONS §7.3): every numeric constant is a named export in `js/config.js`.
- **Every model assumption gets a `// MODEL:` comment** with a one-line rationale (CONVENTIONS §7.3).
- **Every exported function gets a JSDoc block** stating params, return shape, and for engine functions the **scale and direction** of the output (CONVENTIONS §7.2).
- **Code and docs never disagree in `main`** (CONVENTIONS §10): a commit that changes a documented decision updates `FEATURE_ENGINE.md` in the *same* commit.
- **Style:** 2-space indent, single quotes, semicolons always, soft 100-column cap.
- **Commits:** Conventional Commits, `type(scope): summary`, scope is a module or layer (`feat(engine/counter): …`). Model changes state their expected effect on scores.
- **Higher is always better** for every 0–100 engine output (FEATURE_ENGINE §1).

## Verification command

```bash
npm test
```

---

### Task 1: Test harness and role signature

**Files:**
- Modify: `package.json`
- Create: `tests/engine/counter.test.js`
- Modify: `js/engine/counter.js` (add export after `classifyRole`, currently line 43-96)

**Interfaces:**
- Produces: `buildRoleSignature(understatPlayer)` → `{buildupShare: number, createBias: number, npxg90: number, chain90: number} | null`. Input is a raw Understat player record from `leagueXg.playersData` (string-typed numeric fields). Returns `null` when the record is missing, has no chain involvement, or has zero minutes.

- [ ] **Step 1: Add the test script**

In `package.json`, add a `scripts` block between `"description"` and `"engines"`:

```json
  "scripts": {
    "test": "node --test tests/"
  },
```

- [ ] **Step 2: Write the failing test**

Create `tests/engine/counter.test.js`:

```js
/**
 * tests/engine/counter.test.js
 * Unit tests for engine/counter.js. Pure-function tests only — plain object
 * inputs, no DOM, no network (CONVENTIONS.md §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoleSignature } from '../../js/engine/counter.js';

// Real 2025 Understat records, used so the fixtures can't drift from the
// schema the proxy actually returns.
const SALIBA = {
  player_name: 'William Saliba', time: '2609', xG: '1.58', xA: '1.31',
  npxG: '1.58', xGChain: '11.02', xGBuildup: '10.50',
};
const SAKA = {
  player_name: 'Bukayo Saka', time: '2239', xG: '8.70', xA: '8.55',
  npxG: '8.70', xGChain: '19.11', xGBuildup: '8.04',
};

test('buildRoleSignature computes buildupShare as xGBuildup / xGChain', () => {
  const sig = buildRoleSignature(SALIBA);
  assert.ok(Math.abs(sig.buildupShare - 0.9528) < 0.001);
});

test('buildRoleSignature computes createBias as xA90 / (xA90 + npxG90)', () => {
  const sig = buildRoleSignature(SAKA);
  // xA90 = 8.55 / (2239/90) = 0.3437; npxG90 = 8.70 / (2239/90) = 0.3497
  assert.ok(Math.abs(sig.createBias - 0.4957) < 0.001);
});

test('buildRoleSignature returns per-90 rates, not season totals', () => {
  const sig = buildRoleSignature(SAKA);
  assert.ok(Math.abs(sig.chain90 - 0.7682) < 0.001);
  assert.ok(Math.abs(sig.npxg90 - 0.3497) < 0.001);
});

test('buildRoleSignature returns null for a player with no chain involvement', () => {
  assert.equal(buildRoleSignature({ time: '900', xGChain: '0', xGBuildup: '0', xA: '0', npxG: '0' }), null);
});

test('buildRoleSignature returns null for zero minutes', () => {
  assert.equal(buildRoleSignature({ time: '0', xGChain: '5', xGBuildup: '3', xA: '1', npxG: '1' }), null);
});

test('buildRoleSignature returns null for a missing record', () => {
  assert.equal(buildRoleSignature(null), null);
});

test('buildRoleSignature gives createBias 0.5 when a player has neither xA nor npxG', () => {
  // MODEL guard: a pure build-up player has no final action to bias either way.
  const sig = buildRoleSignature({ time: '900', xGChain: '4', xGBuildup: '4', xA: '0', npxG: '0' });
  assert.equal(sig.createBias, 0.5);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `SyntaxError: The requested module '../../js/engine/counter.js' does not provide an export named 'buildRoleSignature'`.

- [ ] **Step 4: Implement `buildRoleSignature`**

In `js/engine/counter.js`, insert immediately after the `classifyRole` function (after its closing brace, currently line 96) and before the `// ─── Role groupings` banner:

```js
/**
 * Build the two-dimensional role signature for one Understat player record.
 *
 * MODEL: xGChain − xGBuildup is BY DEFINITION the player's involvement in
 * possessions where they took the shot or made the key pass, so buildupShare
 * is a positional depth axis: ~0.95 for a centre-back, ~0.20 for a striker.
 * Because it is a ratio of the player's own involvement it is quality-neutral
 * — measured at corr(buildupShare, xGChain/90) = +0.008 across 102 regular
 * 2025 defenders, versus corr(buildupShare, xA/90) = −0.654.
 *
 * MODEL: buildupShare alone misfiles two groups in OPPOSITE directions — a
 * set-piece centre-back reads low (corner headers are final actions) and a
 * defensive fullback reads low (little of anything). createBias separates
 * them: a centre-back's final action is a shot, a fullback's is a cross.
 *
 * See FEATURE_ENGINE.md §7.2 and the design spec
 * docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md §4.
 *
 * @param {object} understatPlayer  raw record from leagueXg.playersData —
 *                                  numeric fields arrive as STRINGS
 * @returns {{buildupShare: number, createBias: number, npxg90: number,
 *            chain90: number} | null}
 *          buildupShare 0–1 (higher = deeper role); createBias 0–1 (higher =
 *          creator not finisher); per-90 rates. null when there is too little
 *          signal to classify on.
 */
export function buildRoleSignature(understatPlayer) {
  if (!understatPlayer) return null;

  const minutes = parseFloat(understatPlayer.time);
  const chain   = parseFloat(understatPlayer.xGChain);
  if (!(minutes > 0) || !(chain > 0)) return null;

  const nineties = minutes / 90;
  const buildup  = parseFloat(understatPlayer.xGBuildup) || 0;
  const xa90     = (parseFloat(understatPlayer.xA)   || 0) / nineties;
  const npxg90   = (parseFloat(understatPlayer.npxG) || 0) / nineties;
  const final    = xa90 + npxg90;

  return {
    buildupShare: buildup / chain,
    // MODEL: a player with no final action at all has no bias either way —
    // 0.5 is the honest neutral, not 0 (which would read as pure finisher).
    createBias: final > 0 ? xa90 / final : 0.5,
    npxg90,
    chain90: chain / nineties,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/engine/counter.test.js js/engine/counter.js
git commit -m "feat(engine/counter): add chain-based role signature helper

Adds buildRoleSignature() and a node --test harness. No scoring change yet —
nothing calls the helper until the next commit."
```

---

### Task 2: Classify a role from a signature

**Files:**
- Modify: `js/config.js` (add after `ROLE_CLASSIFY_THRESHOLDS`, currently ends line 418)
- Modify: `js/engine/counter.js`
- Modify: `tests/engine/counter.test.js`

**Interfaces:**
- Consumes: `buildRoleSignature` from Task 1.
- Produces: `classifyRoleFromSignature(position, sig)` → `'GKP'|'CB'|'FB'|'DM'|'CM'|'WM'|'SS'|'ST'|null`. `position` is the FPL `Player.position` string (`'GKP'|'DEF'|'MID'|'FWD'`). Returns `null` for an unknown position or a null signature.
- Produces: `ROLE_SIGNATURE_THRESHOLDS`, `ROLE_SIGNATURE_MIN_MINUTES`, `ROLE_SIGNATURE_MIN_CHAIN` from `js/config.js`.

- [ ] **Step 1: Add the config constants**

In `js/config.js`, insert directly after the closing `};` of `ROLE_CLASSIFY_THRESHOLDS`:

```js
// Classification thresholds for classifyRoleFromSignature(position, sig) in
// engine/counter.js — the Understat-chain replacement for the ICT-share
// thresholds above (which remain as the per-player fallback).
//
// MODEL: derived from the 2025 season, 139 DEF / 153 MID / 24 FWD with at
// least 900 minutes. Spot-checked groups: FB = Robertson, Muñoz, Bradley,
// Dalot, Wan-Bissaka, Spence; DM = Xhaka, Ward-Prowse, Baleba, Ampadu;
// WM = Saka, Gordon, Mbeumo, Semenyo; SS = Welbeck, Solanke, Delap.
// See the design spec §4 for the full derivation.
export const ROLE_SIGNATURE_THRESHOLDS = {
  // DEF: a fullback is BOTH shallower than a centre-back (more final-third
  // involvement) AND a creator rather than a finisher. Both conditions are
  // required — a set-piece CB satisfies the first alone.
  defFbBuildupShareMax: 0.82,
  defFbCreateBiasMin:   0.50,
  // MID: a winger / inside-forward is a primary shot threat. Tested first
  // because it is the most decisive signal.
  midWmNpxg90Min:       0.22,
  // MID: a #6 is almost pure build-up.
  midDmBuildupShareMin: 0.78,
  // FWD: a shadow striker drops into pockets, so more of their involvement
  // sits before the final action than an out-and-out striker's.
  fwdSsBuildupShareMin: 0.30,
};

// Minimum evidence before a chain signature is trusted over the ICT fallback.
// MODEL: the thresholds above were derived on 900+ minute players; 450 (five
// full matches) is the in-season floor at which the ratios have stabilised
// enough to beat ICT. Below either bar, classifyRole falls back.
export const ROLE_SIGNATURE_MIN_MINUTES = 450;
export const ROLE_SIGNATURE_MIN_CHAIN   = 0.5;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/engine/counter.test.js`:

```js
import { classifyRoleFromSignature } from '../../js/engine/counter.js';

const sig = (buildupShare, createBias, npxg90 = 0.05) =>
  ({ buildupShare, createBias, npxg90, chain90: 0.4 });

test('classifyRoleFromSignature: deep, non-creating defender is a CB', () => {
  assert.equal(classifyRoleFromSignature('DEF', sig(0.95, 0.30)), 'CB');
});

test('classifyRoleFromSignature: shallow, creating defender is a FB', () => {
  assert.equal(classifyRoleFromSignature('DEF', sig(0.72, 0.69)), 'FB');
});

test('classifyRoleFromSignature: set-piece CB stays a CB despite low buildupShare', () => {
  // Tarkowski-shaped: shallow because of corner headers, but a finisher.
  assert.equal(classifyRoleFromSignature('DEF', sig(0.70, 0.30)), 'CB');
});

test('classifyRoleFromSignature: high-shot midfielder is a WM', () => {
  assert.equal(classifyRoleFromSignature('MID', sig(0.37, 0.50, 0.31)), 'WM');
});

test('classifyRoleFromSignature: pure build-up midfielder is a DM', () => {
  assert.equal(classifyRoleFromSignature('MID', sig(0.85, 0.55, 0.05)), 'DM');
});

test('classifyRoleFromSignature: balanced midfielder is a CM', () => {
  assert.equal(classifyRoleFromSignature('MID', sig(0.55, 0.55, 0.13)), 'CM');
});

test('classifyRoleFromSignature: WM test wins over DM for a high-shot deep mid', () => {
  // Ordering matters: shot threat is the more decisive signal.
  assert.equal(classifyRoleFromSignature('MID', sig(0.85, 0.50, 0.30)), 'WM');
});

test('classifyRoleFromSignature: deep-dropping forward is an SS', () => {
  assert.equal(classifyRoleFromSignature('FWD', sig(0.35, 0.40, 0.40)), 'SS');
});

test('classifyRoleFromSignature: penalty-box forward is an ST', () => {
  assert.equal(classifyRoleFromSignature('FWD', sig(0.21, 0.15, 0.44)), 'ST');
});

test('classifyRoleFromSignature: GKP short-circuits without needing a signature', () => {
  assert.equal(classifyRoleFromSignature('GKP', null), 'GKP');
});

test('classifyRoleFromSignature: null signature yields null for outfielders', () => {
  assert.equal(classifyRoleFromSignature('MID', null), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — no export named `classifyRoleFromSignature`.

- [ ] **Step 4: Implement `classifyRoleFromSignature`**

In `js/engine/counter.js`, add `ROLE_SIGNATURE_THRESHOLDS` to the existing `config.js` import block at the top of the file, then insert this function directly after `buildRoleSignature`:

```js
/**
 * Classify a player into one of GKP, CB, FB, DM, CM, WM, SS, ST from their
 * chain signature. Pure: depends only on its two arguments.
 *
 * MODEL: ordering is deliberate. Within MID, shot threat is tested before
 * build-up share because a deep-lying player who still shoots a lot is a
 * wide/attacking threat first and a #6 second.
 *
 * @param {'GKP'|'DEF'|'MID'|'FWD'} position  FPL element_type, normalised
 * @param {{buildupShare: number, createBias: number, npxg90: number} | null} sig
 * @returns {'GKP'|'CB'|'FB'|'DM'|'CM'|'WM'|'SS'|'ST'|null}  null when the
 *          signature is absent (caller should fall back to ICT).
 */
export function classifyRoleFromSignature(position, sig) {
  // GKP is unambiguous from element_type and has no meaningful chain profile.
  if (position === 'GKP') return 'GKP';
  if (!sig) return null;

  const T = ROLE_SIGNATURE_THRESHOLDS;

  if (position === 'DEF') {
    const shallow  = sig.buildupShare < T.defFbBuildupShareMax;
    const creating = sig.createBias  >= T.defFbCreateBiasMin;
    // MODEL: BOTH conditions required. A set-piece centre-back is shallow but
    // finishes rather than creates, so the createBias test keeps them at CB.
    return (shallow && creating) ? 'FB' : 'CB';
  }

  if (position === 'MID') {
    if (sig.npxg90       >= T.midWmNpxg90Min)       return 'WM';
    if (sig.buildupShare >= T.midDmBuildupShareMin) return 'DM';
    return 'CM';
  }

  if (position === 'FWD') {
    return sig.buildupShare >= T.fwdSsBuildupShareMin ? 'SS' : 'ST';
  }

  return null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 18 tests.

- [ ] **Step 6: Commit**

```bash
git add js/config.js js/engine/counter.js tests/engine/counter.test.js
git commit -m "feat(engine/counter): classify roles from chain signature

Adds classifyRoleFromSignature() and its thresholds. Still unwired — no
scoring change until classifyRole() starts calling it."
```

---

### Task 3: Make `classifyRole` chain-first with an ICT fallback

**Files:**
- Modify: `js/engine/counter.js:43` (`classifyRole`), `:192`, `:551`, `:556` (call sites)
- Modify: `tests/engine/counter.test.js`
- Modify: `FEATURE_ENGINE.md` §7.2

**Interfaces:**
- Consumes: `buildRoleSignature`, `classifyRoleFromSignature` from Tasks 1–2.
- Produces: **breaking signature change** — `classifyRole(player, ctx)` replaces `classifyRole(player)`. `ctx` is a `buildScoreContext` result; only `ctx.understatPlayersByName` is read. Passing `ctx` as `undefined` is legal and forces the ICT path, so existing behaviour is recoverable.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/counter.test.js`:

```js
import { classifyRole } from '../../js/engine/counter.js';

const ictPlayer = (position, threat, influence, creativity) => ({
  id: 1, position, fullName: 'Test Player',
  ict: { threat, influence, creativity },
});

// ctx carrying one Understat record, keyed the way buildUnderstatPlayerLookup keys it.
const ctxWith = (fullName, record) => ({
  understatPlayersByName: { [fullName.toLowerCase().trim()]: record },
});

test('classifyRole prefers the chain signature over ICT when both are present', () => {
  // ICT says FB (high threat share); chain says CB (deep, finishing).
  const p = { ...ictPlayer('DEF', 60, 20, 20), fullName: 'Deep Defender' };
  const ctx = ctxWith('Deep Defender', {
    time: '2000', xGChain: '10', xGBuildup: '9.5', xA: '0.2', npxG: '1.5',
  });
  assert.equal(classifyRole(p, ctx), 'CB');
});

test('classifyRole falls back to ICT when the player is not matched by name', () => {
  const p = ictPlayer('DEF', 60, 20, 20);   // threatShare 0.60 >= 0.30 → FB
  assert.equal(classifyRole(p, ctxWith('Someone Else', { time: '2000', xGChain: '10', xGBuildup: '9', xA: '1', npxG: '1' })), 'FB');
});

test('classifyRole falls back to ICT below the minutes floor', () => {
  const p = { ...ictPlayer('DEF', 60, 20, 20), fullName: 'Fringe Defender' };
  const ctx = ctxWith('Fringe Defender', {
    time: '200', xGChain: '2', xGBuildup: '1.9', xA: '0.1', npxG: '0.1',
  });
  assert.equal(classifyRole(p, ctx), 'FB');   // ICT path, not the chain path
});

test('classifyRole falls back to ICT below the chain floor', () => {
  const p = { ...ictPlayer('DEF', 60, 20, 20), fullName: 'Quiet Defender' };
  const ctx = ctxWith('Quiet Defender', {
    time: '2000', xGChain: '0.2', xGBuildup: '0.2', xA: '0', npxG: '0',
  });
  assert.equal(classifyRole(p, ctx), 'FB');
});

test('classifyRole works with no ctx at all (pure ICT path)', () => {
  assert.equal(classifyRole(ictPlayer('DEF', 60, 20, 20)), 'FB');
  assert.equal(classifyRole(ictPlayer('DEF', 10, 70, 20)), 'CB');
});

test('classifyRole returns GKP without consulting either source', () => {
  assert.equal(classifyRole({ id: 2, position: 'GKP', ict: null }), 'GKP');
});

test('classifyRole returns null when neither chain nor ICT has signal', () => {
  assert.equal(classifyRole({ id: 3, position: 'MID', fullName: 'Ghost', ict: null }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — the first test returns `'FB'` (ICT path) because `classifyRole` ignores `ctx`.

- [ ] **Step 3: Rewrite `classifyRole`**

In `js/engine/counter.js`, add `ROLE_SIGNATURE_MIN_MINUTES` and `ROLE_SIGNATURE_MIN_CHAIN` to the `config.js` import block. Replace the `classifyRole` signature line and insert the chain branch at the top of its body, keeping the entire existing ICT body below as the fallback:

```js
/**
 * Classify a player into one of GKP, CB, FB, DM, CM, WM, SS, ST.
 *
 * Tiered by evidence quality:
 *   1. Understat chain signature (buildupShare × createBias) — preferred.
 *   2. FPL ICT component shares — fallback when the player has no Understat
 *      match, too few minutes, or too little chain involvement.
 *
 * MODEL: chain data is preferred because ICT `threat` is a QUALITY measure —
 * a poor winger has little of it and reads as a central midfielder. The chain
 * signature is a ratio of the player's own involvement and is therefore
 * quality-neutral (see buildRoleSignature).
 *
 * Pure: depends only on its arguments. Returns null when neither tier has
 * enough signal, so callers can fall back to element_type grouping.
 *
 * @param {Player} player  internal Player — see ARCHITECTURE.md §8
 * @param {object} [ctx]   buildScoreContext result; only
 *                         ctx.understatPlayersByName is read. Omit to force
 *                         the ICT path.
 * @returns {'GKP'|'CB'|'FB'|'DM'|'CM'|'WM'|'SS'|'ST'|null}
 */
export function classifyRole(player, ctx) {
  if (!player) return null;

  // GKP: trivial — element_type is unambiguous and neither ICT nor chain is
  // meaningful for a keeper.
  if (player.position === 'GKP') return 'GKP';

  // Tier 1 — Understat chain signature.
  const lookup = ctx?.understatPlayersByName;
  const key    = (player.fullName || '').toLowerCase().trim();
  const up     = (lookup && key) ? lookup[key] : null;
  if (up) {
    const minutes = parseFloat(up.time);
    const chain   = parseFloat(up.xGChain);
    // MODEL: below either floor the ratios are still dominated by sampling
    // noise, and ICT — which accumulates from minute one — is the better read.
    if (minutes >= ROLE_SIGNATURE_MIN_MINUTES && chain >= ROLE_SIGNATURE_MIN_CHAIN) {
      const role = classifyRoleFromSignature(player.position, buildRoleSignature(up));
      if (role) return role;
    }
  }

  // Tier 2 — ICT shares (Phase 3C). Everything below is the existing body.
  const ict = player.ict;
  if (!ict) return null;
```

**This is an insertion, not a rewrite.** The existing function body already begins with
`if (!player) return null;`, the GKP short-circuit, and then `const ict = player.ict;`.
Replace the JSDoc block and the signature line, keep the `!player` and GKP guards where
they are, insert the new "Tier 1" block between the GKP guard and `const ict = player.ict;`,
and leave every line from `const ict = player.ict;` to the function's closing brace exactly
as it is. Do not retype the ICT branch — a transcription error there silently changes the
fallback classification for every unmatched player.

- [ ] **Step 4: Update the three call sites to pass `ctx`**

`js/engine/counter.js:192`, inside `classifyTeamRoles`:

```js
    const role = classifyRole(p, ctx);
```

`js/engine/counter.js:551` and `:556`, inside `calcIndividualDuels`:

```js
    const r = classifyRole(e.player, ctx);
```

`classifyTeamRoles` does not currently receive `ctx` — add it as a second parameter now and thread it through; Task 4 rewrites the body:

```js
function classifyTeamRoles(players, ctx) {
```

and at both call sites (`js/engine/counter.js:238-239`):

```js
  const rolesA = classifyTeamRoles(playersA, ctx);
  const rolesB = classifyTeamRoles(playersB, ctx);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 25 tests.

- [ ] **Step 6: Update FEATURE_ENGINE.md**

In §7.2, replace the sentence "Position grouping is derived from `element_type` plus a light heuristic on each player's typical role (Phase 1: use `element_type`; refine with positional data in Phase 3)." with:

```markdown
Position grouping is tiered by evidence quality: an Understat chain signature
(`buildupShare = xGBuildup/xGChain`, `createBias = xA90/(xA90+npxG90)`) where
the player is name-matched and clears `ROLE_SIGNATURE_MIN_MINUTES`; FPL ICT
component shares otherwise; raw `element_type` when neither has signal.
`buildupShare` measures positional depth and is quality-neutral
(`corr(buildupShare, xGChain/90) = +0.008` across 102 regular 2025 defenders,
vs `corr(buildupShare, xA/90) = −0.654`), which ICT `threat` share is not.
`createBias` prevents set-piece centre-backs being misfiled as fullbacks.
See the design spec `docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md` §4.
```

- [ ] **Step 7: Commit**

```bash
git add js/engine/counter.js tests/engine/counter.test.js FEATURE_ENGINE.md
git commit -m "feat(engine/counter): classify roles from Understat chain data

classifyRole() now prefers a buildupShare x createBias signature over ICT
shares, falling back per player. Expected effect: fullback/centre-back and
CDM/CAM groupings become materially more accurate, so counter-matchup pairings
stop mixing units. Scores move on most fixtures."
```

---

### Task 4: Per-player tiering in `classifyTeamRoles`

**Files:**
- Modify: `js/engine/counter.js:185-208` (`classifyTeamRoles`), `:236-249` (`calcCounterMatchup` head)
- Modify: `js/config.js`
- Modify: `tests/engine/counter.test.js`
- Modify: `FEATURE_ENGINE.md` §7.2

**Interfaces:**
- Consumes: `classifyRole(player, ctx)` from Task 3.
- Produces: **breaking return-type change** — `classifyTeamRoles(players, ctx)` returns `{rolesByPlayerId: Object<number,string>, estimated: boolean} | null` instead of `Object|null`. `null` still means "no outfielder has minutes, fall back to element_type". `estimated: true` means the roles are usable but chain coverage was thin.
- Produces: `ROLE_CHAIN_COVERAGE_MIN` from `js/config.js`.

- [ ] **Step 1: Add the config constant**

In `js/config.js`, directly after `ROLE_SIGNATURE_MIN_CHAIN`:

```js
// Share of a team's outfield MINUTES that must be covered by a chain signature
// before the role grouping is treated as fully data-backed.
// MODEL: replaces Phase 3C's fail-closed 90% player-count bar. That bar existed
// because mixing refined and unrefined players understates whichever side has
// worse coverage — but that reasoning applies to mixing TAXONOMIES, and chain
// and ICT emit the same eight labels from different evidence. Minutes-weighted
// rather than headcount so a fringe squad player can't drag a team below the
// bar. Below this share the roles are still used, just flagged estimated.
export const ROLE_CHAIN_COVERAGE_MIN = 0.75;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/engine/counter.test.js`:

```js
import { classifyTeamRoles } from '../../js/engine/counter.js';

const teamPlayer = (id, position, fullName, minutes, ict) => ({
  id, position, fullName, ict, totals: { minutes },
});

const chainRecord = (time, xGChain, xGBuildup, xA, npxG) =>
  ({ time, xGChain, xGBuildup, xA, npxG });

test('classifyTeamRoles flags estimated:false when chain covers most minutes', () => {
  const players = [
    teamPlayer(1, 'DEF', 'Deep One',  2000, { threat: 10, influence: 70, creativity: 20 }),
    teamPlayer(2, 'MID', 'Wide One',  2000, { threat: 60, influence: 20, creativity: 20 }),
  ];
  const ctx = { understatPlayersByName: {
    'deep one': chainRecord('2000', '10', '9.5', '0.2', '1.5'),
    'wide one': chainRecord('2000', '15', '5',   '5',   '8'),
  } };
  const out = classifyTeamRoles(players, ctx);
  assert.equal(out.estimated, false);
  assert.equal(out.rolesByPlayerId[1], 'CB');
  assert.equal(out.rolesByPlayerId[2], 'WM');
});

test('classifyTeamRoles still classifies, but flags estimated, on thin chain coverage', () => {
  const players = [
    teamPlayer(1, 'DEF', 'Matched',   500,  { threat: 10, influence: 70, creativity: 20 }),
    teamPlayer(2, 'MID', 'Unmatched', 2500, { threat: 60, influence: 20, creativity: 20 }),
  ];
  const ctx = { understatPlayersByName: {
    'matched': chainRecord('500', '4', '3.8', '0.1', '0.2'),
  } };
  const out = classifyTeamRoles(players, ctx);
  // 500 of 3000 outfield minutes chain-covered = 0.167, below 0.75.
  assert.equal(out.estimated, true);
  // Both still get a role — the unmatched one via ICT.
  assert.equal(out.rolesByPlayerId[1], 'CB');
  assert.equal(out.rolesByPlayerId[2], 'WM');
});

test('classifyTeamRoles returns null when no outfielder has minutes', () => {
  const players = [teamPlayer(1, 'GKP', 'Keeper', 3000, null)];
  assert.equal(classifyTeamRoles(players, {}), null);
});

test('classifyTeamRoles no longer fails closed on one unclassifiable player', () => {
  // Phase 3C dropped the WHOLE team to element_type here. It must not now.
  const players = [
    teamPlayer(1, 'DEF', 'Deep One', 2000, { threat: 10, influence: 70, creativity: 20 }),
    teamPlayer(2, 'MID', 'No Signal', 2000, null),
  ];
  const out = classifyTeamRoles(players, {});
  assert.notEqual(out, null);
  assert.equal(out.rolesByPlayerId[1], 'CB');
  assert.equal(out.rolesByPlayerId[2], undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `classifyTeamRoles` returns a bare map, so `out.estimated` is `undefined` and `out.rolesByPlayerId` does not exist.

- [ ] **Step 4: Rewrite `classifyTeamRoles`**

Replace the whole function body (`js/engine/counter.js:185-208`), keeping its position in the file. Add `ROLE_CHAIN_COVERAGE_MIN` to the `config.js` import block:

```js
/**
 * Build a { playerId → role } map for one team's players, plus a flag for how
 * well chain data covered the squad.
 *
 * MODEL: per-player tiering, NOT fail-closed. Phase 3C dropped the whole team
 * to element_type grouping when under 90% of outfielders classified, because
 * mixing refined and unrefined players understates whichever side has worse
 * coverage. That argument applies to mixing TAXONOMIES — chain and ICT emit
 * the same eight labels from different evidence, so a per-player fallback is
 * sound and strictly more informative than collapsing the squad.
 *
 * @param {Player[]} players
 * @param {object}   ctx  buildScoreContext result (read for chain signatures)
 * @returns {{rolesByPlayerId: Object<number,string>, estimated: boolean}|null}
 *          null when no outfielder has any minutes — caller falls back to
 *          element_type grouping. estimated:true when chain data covered less
 *          than ROLE_CHAIN_COVERAGE_MIN of outfield minutes.
 */
function classifyTeamRoles(players, ctx) {
  const rolesByPlayerId = {};
  let outfieldMinutes = 0;
  let chainCoveredMinutes = 0;

  const lookup = ctx?.understatPlayersByName;

  for (const p of players || []) {
    const minutes = p.totals?.minutes ?? 0;
    const role = classifyRole(p, ctx);
    if (role) rolesByPlayerId[p.id] = role;

    if (p.position === 'GKP' || minutes <= 0) continue;
    outfieldMinutes += minutes;

    // Coverage is measured on the SAME conditions classifyRole uses for its
    // tier-1 branch, so the flag can never disagree with what was actually used.
    const key = (p.fullName || '').toLowerCase().trim();
    const up  = (lookup && key) ? lookup[key] : null;
    if (up
        && parseFloat(up.time)    >= ROLE_SIGNATURE_MIN_MINUTES
        && parseFloat(up.xGChain) >= ROLE_SIGNATURE_MIN_CHAIN) {
      chainCoveredMinutes += minutes;
    }
  }

  if (outfieldMinutes === 0) return null;

  return {
    rolesByPlayerId,
    estimated: (chainCoveredMinutes / outfieldMinutes) < ROLE_CHAIN_COVERAGE_MIN,
  };
}
```

- [ ] **Step 5: Update `calcCounterMatchup` for the new return type**

At `js/engine/counter.js:236-249`, replace the role resolution block:

```js
  const roleResultA = classifyTeamRoles(playersA, ctx);
  const roleResultB = classifyTeamRoles(playersB, ctx);
  const useRoles = roleResultA !== null && roleResultB !== null;

  const rolesA = roleResultA?.rolesByPlayerId ?? null;
  const rolesB = roleResultB?.rolesByPlayerId ?? null;
```

and extend the existing `anyEstimated` initialiser (currently `let anyEstimated = !useRoles;`):

```js
  // MODEL: an element_type fallback for either side flags the whole metric as
  // estimated, and so does thin chain coverage — a role grouping built mostly
  // from ICT is materially less trustworthy than one built from chain data.
  let anyEstimated = !useRoles
    || (roleResultA?.estimated ?? false)
    || (roleResultB?.estimated ?? false);
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 29 tests.

- [ ] **Step 7: Update FEATURE_ENGINE.md**

In §7.2, add after the tiering paragraph added in Task 3:

```markdown
Role grouping degrades **per player**, not per team: Phase 3C's fail-closed
90% coverage bar is replaced by `ROLE_CHAIN_COVERAGE_MIN` (0.75 of outfield
MINUTES). Below that share the roles are still used but the metric is flagged
`estimated`, rather than the whole squad collapsing to `element_type`.
```

- [ ] **Step 8: Commit**

```bash
git add js/config.js js/engine/counter.js tests/engine/counter.test.js FEATURE_ENGINE.md
git commit -m "refactor(engine/counter): tier role classification per player

Replaces the fail-closed 90% team coverage bar with per-player fallback plus a
minutes-weighted coverage flag. Expected effect: far fewer teams collapse to
element_type grouping, so counter-matchup is estimated less often and pairings
resolve at role level on most fixtures."
```

---

### Task 5: Chain-based attack-unit strength

**Files:**
- Modify: `js/engine/counter.js` (add beside `minutesWeightedMeanForm`, currently line 145-160; wire into `calcCounterMatchup` around line 260-275)
- Modify: `js/config.js`
- Modify: `tests/engine/counter.test.js`
- Modify: `FEATURE_ENGINE.md` §7.2

**Interfaces:**
- Consumes: `buildRoleSignature` from Task 1.
- Produces: `minutesWeightedMeanChain(players, ctx)` → `number | null` — minutes-weighted mean of `xGChain/90` across the unit, `null` when no player has both minutes and a chain record.
- Produces: `CHAIN_UNIT_ANCHORS` from `js/config.js`.

- [ ] **Step 1: Add the config constant**

In `js/config.js`, after `COUNTER_FALLBACK_EDGE`:

```js
// Anchors mapping a unit's minutes-weighted mean xGChain per 90 onto 0–100,
// so the chain read of an attacking unit is on the same scale as the
// calcPlayerForm read it replaces.
// MODEL: 2025 season per-90 chain distribution — defenders p10 0.165 / p90
// 0.503, midfielders p10 0.272 / p90 0.751, forwards p10 0.358 / p90 0.783.
// A single pair of anchors spanning 0.15–0.80 covers every attacking unit
// without needing per-role scales; units below 0.15 are fringe-squad noise.
export const CHAIN_UNIT_ANCHORS = { min: 0.15, max: 0.80 };
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/engine/counter.test.js`:

```js
import { minutesWeightedMeanChain } from '../../js/engine/counter.js';

test('minutesWeightedMeanChain weights by minutes, not headcount', () => {
  const players = [
    teamPlayer(1, 'FWD', 'Starter', 2700, null),
    teamPlayer(2, 'FWD', 'Sub',      300, null),
  ];
  const ctx = { understatPlayersByName: {
    // chain90 = 0.8 for the starter, 0.2 for the sub
    'starter': chainRecord('2700', '24', '5', '2', '10'),
    'sub':     chainRecord('300',  '0.666', '0.2', '0.05', '0.3'),
  } };
  const v = minutesWeightedMeanChain(players, ctx);
  // (0.8*2700 + 0.2*300) / 3000 = 0.74
  assert.ok(Math.abs(v - 0.74) < 0.005);
});

test('minutesWeightedMeanChain skips players with zero minutes', () => {
  const players = [
    teamPlayer(1, 'FWD', 'Starter', 2700, null),
    teamPlayer(2, 'FWD', 'Unused',     0, null),
  ];
  const ctx = { understatPlayersByName: {
    'starter': chainRecord('2700', '24', '5', '2', '10'),
    'unused':  chainRecord('2700', '99', '5', '2', '10'),
  } };
  assert.ok(Math.abs(minutesWeightedMeanChain(players, ctx) - 0.8) < 0.005);
});

test('minutesWeightedMeanChain returns null when nobody is matched', () => {
  const players = [teamPlayer(1, 'FWD', 'Nobody', 2700, null)];
  assert.equal(minutesWeightedMeanChain(players, { understatPlayersByName: {} }), null);
});

test('minutesWeightedMeanChain returns null for an empty unit', () => {
  assert.equal(minutesWeightedMeanChain([], { understatPlayersByName: {} }), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — no export named `minutesWeightedMeanChain`.

- [ ] **Step 4: Implement it**

In `js/engine/counter.js`, insert directly after `minutesWeightedMeanForm` (after its closing brace, currently line 160), and export it:

```js
/**
 * Minutes-weighted mean of xGChain per 90 across a unit.
 *
 * MODEL: chain credits every player involved in a possession that ended in a
 * shot, so the winger whose cross another player converts is rewarded. FPL
 * points and ICT `threat` both under-reward exactly that contribution, which
 * is why this replaces calcPlayerForm on the ATTACKING side of a pairing.
 * The defending side keeps calcPlayerForm — Understat publishes no per-player
 * defensive data at any endpoint, so there is nothing to replace it with.
 *
 * Minutes-weighted so likely starters drive the read; players with no minutes
 * or no Understat match drop out rather than diluting it.
 *
 * @param {Player[]} players
 * @param {object}   ctx  buildScoreContext result
 * @returns {number|null}  mean xGChain per 90 (raw rate, ~0.15–0.80 in the PL),
 *                         or null when no eligible player is matched.
 */
export function minutesWeightedMeanChain(players, ctx) {
  const lookup = ctx?.understatPlayersByName;
  if (!lookup || !players || players.length === 0) return null;

  let sum = 0;
  let totalW = 0;
  for (const p of players) {
    const minutes = p.totals?.minutes ?? 0;
    if (minutes <= 0) continue;
    const key = (p.fullName || '').toLowerCase().trim();
    const sig = key ? buildRoleSignature(lookup[key]) : null;
    if (!sig) continue;
    sum    += sig.chain90 * minutes;
    totalW += minutes;
  }
  return totalW === 0 ? null : sum / totalW;
}
```

- [ ] **Step 5: Wire it into `calcCounterMatchup`**

Add `normaliseLinear` (already imported) and `CHAIN_UNIT_ANCHORS` to the imports. Inside the pairing loop in `calcCounterMatchup`, replace the `const attackForm = minutesWeightedMeanForm(attackers, ctx);` line with:

```js
    // MODEL: prefer the chain read of the attacking unit; fall back to the
    // form read when Understat can't supply one. Normalised onto the same
    // 0–100 scale calcPlayerForm returns, so pairingEdge stays comparable
    // across both paths.
    const attackChain = minutesWeightedMeanChain(attackers, ctx);
    const attackForm  = attackChain !== null
      ? normaliseLinear(attackChain, CHAIN_UNIT_ANCHORS.min, CHAIN_UNIT_ANCHORS.max)
      : minutesWeightedMeanForm(attackers, ctx);
```

and record the provenance on the pairing object by adding one property to the existing `pairings[key] = { … }` literal:

```js
      attackSource: attackChain !== null ? 'chain' : 'form',
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 33 tests.

- [ ] **Step 7: Update FEATURE_ENGINE.md**

In §7.2, after the `attackUnitForm`/`defenceUnitForm` formula block, add:

```markdown
`attackUnitForm` prefers the **chain** read — the minutes-weighted mean of
`xGChain/90` across the unit, normalised through `CHAIN_UNIT_ANCHORS` — and
falls back to the minutes-weighted `calcPlayerForm` mean when Understat has no
match. Each pairing reports which was used as `attackSource: 'chain'|'form'`.
`defenceUnitForm` is unchanged: Understat publishes no per-player defensive
data, so there is nothing to replace `calcPlayerForm` with on that side.
```

- [ ] **Step 8: Commit**

```bash
git add js/config.js js/engine/counter.js tests/engine/counter.test.js FEATURE_ENGINE.md
git commit -m "feat(engine/counter): score attacking units on xGChain

Attacking unit strength now reads minutes-weighted xGChain/90 where Understat
covers the unit, falling back to calcPlayerForm otherwise. Expected effect:
creative wide players and link forwards gain, pure penalty-box finishers at
low-possession teams lose slightly."
```

---

### Task 6: Understat slug resolution and the full team-xG getter

**Files:**
- Create: `js/engine/channel.js`
- Modify: `js/store.js` (add getter beside `getTeamXg`, currently line 93; export list line 227)
- Create: `tests/engine/channel.test.js`

**Interfaces:**
- Produces: `buildUnderstatSlugsByTeamId(leagueXg, teamsById)` → `Object<number,string>` mapping FPL team id → Understat URL slug (e.g. `42 → 'Arsenal'`, `43 → 'Manchester_City'`). Empty object when `leagueXg` is absent.
- Produces: `store.getAllTeamXg()` → `Object<string,object>` — a shallow copy of every cached team payload keyed by slug.

- [ ] **Step 1: Add the store getter**

In `js/store.js`, directly after `getTeamXg` (line 93):

```js
function getAllTeamXg()               { return { ...state.teamXg }; }
```

and add `getAllTeamXg` to the export list at line 227, after `getTeamXg`:

```js
  getLeagueXg, getLeagueXgPrev, getLeagueXgPrev2, getLeagueXgPrev3, getTeamXg, getAllTeamXg,
```

- [ ] **Step 2: Write the failing test**

Create `tests/engine/channel.test.js`:

```js
/**
 * tests/engine/channel.test.js
 * Unit tests for engine/channel.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUnderstatSlugsByTeamId } from '../../js/engine/channel.js';

const leagueXg = { teamsData: {
  83:  { id: '83',  title: 'Arsenal' },
  88:  { id: '88',  title: 'Manchester City' },
  229: { id: '229', title: 'Wolverhampton Wanderers' },
} };

const teamsById = {
  1:  { id: 1,  name: 'Arsenal',   shortName: 'ARS' },
  13: { id: 13, name: 'Man City',  shortName: 'MCI' },
  20: { id: 20, name: 'Wolves',    shortName: 'WOL' },
};

test('buildUnderstatSlugsByTeamId maps FPL ids to Understat slugs', () => {
  const out = buildUnderstatSlugsByTeamId(leagueXg, teamsById);
  assert.equal(out[1], 'Arsenal');
});

test('buildUnderstatSlugsByTeamId converts spaces to underscores', () => {
  const out = buildUnderstatSlugsByTeamId(leagueXg, teamsById);
  assert.equal(out[13], 'Manchester_City');
  assert.equal(out[20], 'Wolverhampton_Wanderers');
});

test('buildUnderstatSlugsByTeamId returns {} without a league payload', () => {
  assert.deepEqual(buildUnderstatSlugsByTeamId(null, teamsById), {});
});

test('buildUnderstatSlugsByTeamId omits teams it cannot match', () => {
  const out = buildUnderstatSlugsByTeamId(leagueXg, { 9: { id: 9, name: 'Some New Club', shortName: 'SNC' } });
  assert.equal(out[9], undefined);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../js/engine/channel.js'`.

- [ ] **Step 4: Create `js/engine/channel.js`**

```js
/**
 * js/engine/channel.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds Understat channel profiles (set-piece / box / transition threat and
 * vulnerability shares) and scores the channel counter-matchup between two
 * teams. See FEATURE_ENGINE.md §7.2 and the design spec
 * docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md.
 *
 * All outputs: 0–100, higher = favourable for the team being scored.
 */

import { canonicalClubKey } from './normalise.js';

/**
 * Map FPL team id → Understat URL slug, derived from the league payload that
 * is already loaded rather than a hardcoded table.
 *
 * MODEL: matched by NAME via canonicalClubKey, never by Understat's numeric
 * team id — FPL reassigns ids every season as clubs are promoted and
 * relegated, which is exactly what silently broke the previous id-keyed
 * UNDERSTAT_TEAM_SLUGS table (see engine/style.js buildXgProfilesByTeamId).
 * The slug is Understat's own convention: the team title with spaces replaced
 * by underscores.
 *
 * @param {object|null} leagueXg   parsed Understat league/EPL payload
 * @param {Object<number,Team>} teamsById
 * @returns {Object<number,string>}  {} when no payload or no match.
 */
export function buildUnderstatSlugsByTeamId(leagueXg, teamsById) {
  if (!leagueXg || !leagueXg.teamsData) return {};

  const titleByKey = {};
  for (const t of Object.values(leagueXg.teamsData)) {
    if (t && t.title) titleByKey[canonicalClubKey(t.title)] = t.title;
  }

  const out = {};
  for (const team of Object.values(teamsById || {})) {
    for (const raw of [team.name, team.shortName]) {
      if (!raw) continue;
      const title = titleByKey[canonicalClubKey(raw)];
      if (title) {
        out[team.id] = title.replace(/ /g, '_');
        break;
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS, 37 tests.

- [ ] **Step 6: Commit**

```bash
git add js/engine/channel.js js/store.js tests/engine/channel.test.js
git commit -m "feat(engine/channel): resolve Understat team slugs from league data

New pure engine module plus a store.getAllTeamXg() getter. No scoring change —
nothing fetches or consumes team statistics yet."
```

---

### Task 7: Fetch team statistics for the selected fixture

**Files:**
- Modify: `js/modules/matchup.js` (imports; `buildCtx` at line 109-120; `renderMatchup` at line 490)
- Modify: `js/modules/dashboard.js:259`, `js/modules/planner.js:172`, `js/modules/ranker.js:111`, `js/main.js:266` (one line each)
- Modify: `ARCHITECTURE.md` (data-flow section)

**Interfaces:**
- Consumes: `buildUnderstatSlugsByTeamId` (Task 6), `store.getAllTeamXg` (Task 6), existing `fetchTeamXg` from `js/api.js`.
- Produces: every `buildScoreContext` caller passes `teamXgBySlug`. `ensureTeamXg(fixture)` kicks off the two fetches and re-renders when they land.

- [ ] **Step 1: Add the imports**

In `js/modules/matchup.js`, add to the existing import block:

```js
import { fetchTeamXg } from '../api.js';
import { buildUnderstatSlugsByTeamId } from '../engine/channel.js';
```

- [ ] **Step 2: Pass `teamXgBySlug` from every context builder**

There are **five** `buildScoreContext` call sites, and all five need the new option — this is what makes the tier availability-driven rather than tab-scoped (spec §8). Each is a `buildScoreContext(season, { … })` call with an options object literal; add this one property to each, next to the existing `leagueXgPrev3` line:

```js
    teamXgBySlug: store.getAllTeamXg(),
```

The five sites:

| File | Line | Builder |
|---|---|---|
| `js/modules/matchup.js` | 112 | `buildCtx()` |
| `js/modules/dashboard.js` | 259 | `buildCtx()` |
| `js/modules/planner.js` | 172 | `buildCtx()` |
| `js/modules/ranker.js` | 111 | `buildCtx()` |
| `js/main.js` | 266 | `window.__engine.context()` |

`js/main.js` uses a deeper indent (6 spaces, not 4) inside `window.__engine.context()` — match the surrounding lines.

Missing any of these does not break the build; it silently pins that module to the role tier, which is exactly the divergence spec §8 rules out. `js/main.js:266` in particular feeds every browser verification step in Tasks 9, 10 and 13, so those checks will report the wrong tier if it is skipped.

`js/calibration.js:34` also calls `buildScoreContext` and is deliberately **excluded** — backtests must score historical gameweeks on a tier that does not depend on which fixtures a user happened to open.

- [ ] **Step 3: Add the fetch orchestration**

Add module-level state beside the other `_`-prefixed module variables at the top of `js/modules/matchup.js`:

```js
// Slugs whose team-xG fetch has already been started this session, so a
// re-render mid-flight can't fire a duplicate request.
const _teamXgRequested = new Set();
```

and add this function directly above `renderMatchup`:

```js
/**
 * Kick off the Understat team-statistics fetch for both teams in a fixture,
 * re-rendering when each lands. Fire-and-forget by design: the card renders
 * immediately on whatever tier the data supports, and upgrades in place if
 * and when the statistics arrive.
 *
 * MODEL: failures are swallowed to a console warning, never store.setError().
 * The channel tier is an ENRICHMENT — every consumer degrades to the role tier
 * on its own, so a dead Understat upstream must not surface as a page error.
 * Same policy as the league-xG fetch (see js/api.js, ROADMAP §3A).
 */
function ensureTeamXg(fixture) {
  const season = store.getSeason();
  if (!season) return;

  const slugs = buildUnderstatSlugsByTeamId(store.getLeagueXg(), season.teamsById);
  for (const teamId of [fixture.homeTeamId, fixture.awayTeamId]) {
    const slug = slugs[teamId];
    if (!slug || _teamXgRequested.has(slug) || store.getTeamXg(slug)) continue;

    _teamXgRequested.add(slug);
    fetchTeamXg(slug)
      .then((data) => {
        store.setTeamXg(slug, data);
        // Only re-render if the user is still looking at a fixture that
        // needs this team — otherwise the payload just sits in the cache.
        renderMatchup();
      })
      .catch((err) => {
        console.warn(`[Gaffer IQ] team xG unavailable for ${slug}: ${err.message}`);
      });
  }
}
```

- [ ] **Step 4: Call it from `renderMatchup`**

In `renderMatchup`, directly after the `if (!homeTeam || !awayTeam)` guard block returns, insert:

```js
  // Fire-and-forget; upgrades the counter tier in place when it lands.
  ensureTeamXg(fixture);
```

- [ ] **Step 5: Verify in the browser**

Serve the app and open the Matchup tab. In the console:

```js
Object.keys(window.__store.getAllTeamXg())
```

Expected: two slugs after selecting a fixture, e.g. `['Arsenal', 'Liverpool']`. Then:

```js
Object.keys(window.__store.getAllTeamXg().Arsenal.statistics)
```

Expected: `['situation', 'formation', 'gameState', 'timing', 'shotZone', 'attackSpeed', 'result']`.

Confirm no page-level error banner appears, and that selecting a second fixture adds two more slugs rather than replacing the first two.

- [ ] **Step 6: Run the tests**

```bash
npm test
```

Expected: PASS, 37 tests (no new tests — this task is DOM/network wiring, which CONVENTIONS §3.3 keeps out of the engine and therefore out of the unit suite).

- [ ] **Step 7: Update ARCHITECTURE.md**

In the Understat data-flow section, add:

```markdown
`team/{slug}/{season}` is fetched lazily by the Matchup Analyser for the two
teams in the selected fixture only, cached in `store.teamXg` for the session,
and consumed as `ctx.teamXgBySlug`. Failures are swallowed to a console warning
— the channel counter tier degrades to the role tier, so a dead Understat
upstream must never surface as a page error.
```

- [ ] **Step 8: Commit**

```bash
git add js/modules/matchup.js ARCHITECTURE.md
git commit -m "feat(matchup): fetch Understat team statistics for the open fixture

Two lazy proxy calls per fixture, cached per session, swallowed on failure.
No scoring change yet — nothing reads ctx.teamXgBySlug until the channel
engine lands."
```

---

### Task 8: Channel profile from a statistics block

**Files:**
- Modify: `js/engine/channel.js`
- Modify: `js/config.js`
- Modify: `tests/engine/channel.test.js`

**Interfaces:**
- Produces: `buildChannelProfile(statistics)` → `{setPieceThreat: {for, against}, wideTransition: {for, against}, boxThreat: {for, against}, shots: number, hasChannelAxes: boolean}`. All axis values are 0–1 shares. `hasChannelAxes` is `false` when the block is missing or below `MIN_CHANNEL_SHOTS`, in which case every axis value is `null`.
- Produces: `CHANNEL_AXIS_POOLED_SD`, `CHANNEL_WEIGHTS`, `CHANNEL_SENSITIVITY`, `MIN_CHANNEL_SHOTS` from `js/config.js`.

- [ ] **Step 1: Add the config constants**

In `js/config.js`, after `COUNTER_DEFENCE_WEIGHT`:

```js
// ─── Channel counter-matchup (Understat team statistics) ────────────────────
// Three INDEPENDENT partitions of the same shots — not one partition of
// threat. An open-play axis is deliberately absent: openPlayShare is
// identically 1 − setPieceShare, so it carries no extra information.
//
// MODEL: measured across all 20 clubs, 2025 season. Largest pairwise
// correlation among attacking profiles is corr(box, fast) = +0.334; among
// defensive profiles corr(setPiece, fast) = −0.161. The axes are
// near-independent, so none needs collapsing into another.

// Pooled standard deviation of (attacking share − conceding share) per axis,
// used to z-score each edge so all three contribute on a common scale.
// MODEL: sqrt(sd_for² + sd_against²) from the 2025 league distribution —
// setPiece 0.0555/0.0410, box 0.0170/0.0091, fast 0.0229/0.0263.
export const CHANNEL_AXIS_POOLED_SD = {
  setPieceThreat: 0.0690,
  wideTransition: 0.0349,
  boxThreat:      0.0193,
};

// MODEL: weighted by discriminating power and novelty, not intuition.
// setPiece has the widest league spread (0.170–0.370) and is the ONLY axis on
// which the composite currently carries no signal at all. box has the
// narrowest spread (0.884–0.937) and the strongest residual quality confound
// (corr with npxG volume +0.408), so it is weighted least.
export const CHANNEL_WEIGHTS = {
  setPieceThreat: 0.50,
  wideTransition: 0.30,
  boxThreat:      0.20,
};

// Points per pooled standard deviation of axis edge.
// MODEL: 14 puts a 2-SD mismatch at ±28 points, comparable to the spread
// COUNTER_SENSITIVITY produces on the role tier.
export const CHANNEL_SENSITIVITY = 14;

// Minimum shots in a team's situation partition before its channel profile is
// trusted. MODEL: a PL side takes ~13 shots a game, so 120 is roughly nine
// matches — the point at which the set-piece share (the thinnest bucket, ~25%
// of shots) stops being dominated by sampling noise.
export const MIN_CHANNEL_SHOTS = 120;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/engine/channel.test.js`:

```js
import { buildChannelProfile } from '../../js/engine/channel.js';

// Shaped like a real getTeamData statistics block, with round numbers.
const statistics = {
  situation: {
    OpenPlay:       { shots: 300, goals: 30, xG: 30, against: { shots: 200, goals: 20, xG: 24 } },
    FromCorner:     { shots: 60,  goals: 6,  xG: 6,  against: { shots: 40,  goals: 4,  xG: 4  } },
    SetPiece:       { shots: 30,  goals: 3,  xG: 3,  against: { shots: 20,  goals: 2,  xG: 2  } },
    DirectFreekick: { shots: 10,  goals: 1,  xG: 1,  against: { shots: 10,  goals: 1,  xG: 2  } },
    Penalty:        { shots: 8,   goals: 6,  xG: 6,  against: { shots: 4,   goals: 3,  xG: 3  } },
  },
  shotZone: {
    ownGoals:        { shots: 2,   goals: 2,  xG: 2,  against: { shots: 1,   goals: 1,  xG: 1  } },
    shotOboxTotal:   { shots: 100, goals: 2,  xG: 4,  against: { shots: 80,  goals: 2,  xG: 3  } },
    shotPenaltyArea: { shots: 250, goals: 25, xG: 30, against: { shots: 150, goals: 15, xG: 21 } },
    shotSixYardBox:  { shots: 40,  goals: 12, xG: 6,  against: { shots: 30,  goals: 9,  xG: 6  } },
  },
  attackSpeed: {
    Normal:   { shots: 200, goals: 20, xG: 24, against: { shots: 150, goals: 15, xG: 18 } },
    Standard: { shots: 100, goals: 10, xG: 12, against: { shots: 80,  goals: 8,  xG: 9  } },
    Slow:     { shots: 50,  goals: 5,  xG: 6,  against: { shots: 40,  goals: 4,  xG: 5  } },
    Fast:     { shots: 30,  goals: 4,  xG: 6,  against: { shots: 20,  goals: 3,  xG: 8  } },
  },
};

test('buildChannelProfile computes set-piece share excluding penalties', () => {
  const p = buildChannelProfile(statistics);
  // dead ball xG for = 6+3+1 = 10; open play = 30; total = 40 → 0.25
  assert.ok(Math.abs(p.setPieceThreat.for - 0.25) < 1e-9);
  // against: 4+2+2 = 8; open play 24; total 32 → 0.25
  assert.ok(Math.abs(p.setPieceThreat.against - 0.25) < 1e-9);
});

test('buildChannelProfile computes box share excluding own goals', () => {
  const p = buildChannelProfile(statistics);
  // box xG for = 30+6 = 36; obox = 4; total 40 → 0.90
  assert.ok(Math.abs(p.boxThreat.for - 0.90) < 1e-9);
  // against: 21+6 = 27; obox 3; total 30 → 0.90
  assert.ok(Math.abs(p.boxThreat.against - 0.90) < 1e-9);
});

test('buildChannelProfile computes fast share over all attack speeds', () => {
  const p = buildChannelProfile(statistics);
  // fast 6 of (24+12+6+6) = 48 → 0.125
  assert.ok(Math.abs(p.wideTransition.for - 0.125) < 1e-9);
  // against: 8 of (18+9+5+8) = 40 → 0.20
  assert.ok(Math.abs(p.wideTransition.against - 0.20) < 1e-9);
});

test('buildChannelProfile reports hasChannelAxes true above the shot floor', () => {
  assert.equal(buildChannelProfile(statistics).hasChannelAxes, true);
});

test('buildChannelProfile nulls every axis below MIN_CHANNEL_SHOTS', () => {
  const thin = JSON.parse(JSON.stringify(statistics));
  thin.situation.OpenPlay.shots = 20;
  thin.situation.FromCorner.shots = 5;
  thin.situation.SetPiece.shots = 2;
  thin.situation.DirectFreekick.shots = 1;
  const p = buildChannelProfile(thin);
  assert.equal(p.hasChannelAxes, false);
  assert.equal(p.setPieceThreat.for, null);
  assert.equal(p.boxThreat.for, null);
  assert.equal(p.wideTransition.for, null);
});

test('buildChannelProfile handles a missing statistics block', () => {
  const p = buildChannelProfile(null);
  assert.equal(p.hasChannelAxes, false);
  assert.equal(p.setPieceThreat.against, null);
});

test('buildChannelProfile handles a partial statistics block without throwing', () => {
  const p = buildChannelProfile({ situation: statistics.situation });
  assert.equal(p.hasChannelAxes, false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — no export named `buildChannelProfile`.

- [ ] **Step 4: Implement `buildChannelProfile`**

Append to `js/engine/channel.js`, adding the config import at the top of the file:

```js
import { MIN_CHANNEL_SHOTS } from '../config.js';
```

```js
// Every axis value is null rather than a neutral number when the inputs are
// absent. MODEL: a neutral-looking 0.5 is indistinguishable from a genuine
// mid-table reading, and the scoring below would multiply it into a
// confident-looking edge. hasChannelAxes is the single flag every consumer
// checks — same policy as NO_STYLE_AXES in engine/style.js.
const NO_CHANNEL_AXES = Object.freeze({
  hasChannelAxes: false,
  setPieceThreat: Object.freeze({ for: null, against: null }),
  wideTransition: Object.freeze({ for: null, against: null }),
  boxThreat:      Object.freeze({ for: null, against: null }),
  shots: 0,
});

/** Internal: read one side's xG from a statistics bucket. */
function bucketXg(bucket, side) {
  if (!bucket) return 0;
  const v = side === 'for' ? bucket.xG : bucket.against?.xG;
  return typeof v === 'number' ? v : (parseFloat(v) || 0);
}

/** Internal: sum one side's xG across several named buckets. */
function sumXg(group, keys, side) {
  let total = 0;
  for (const k of keys) total += bucketXg(group?.[k], side);
  return total;
}

/** Internal: share of `part` in `part + rest`, or null when the base is empty. */
function share(part, rest) {
  const base = part + rest;
  return base > 0 ? part / base : null;
}

/**
 * Build the three-axis channel profile for one team from its Understat
 * `statistics` block.
 *
 * MODEL: penalties are excluded from the set-piece denominator — a penalty is
 * a restart, not evidence about how a team plays in open field. Same reasoning
 * as the npxG choice in engine/style.js. Own goals are excluded from the shot
 * zone denominator for the same reason.
 *
 * MODEL: the shares are not perfectly quality-neutral. Across the 2025 league,
 * corr(boxShare_for, npxG_for) = +0.408 and corr(setPieceShare_for, npxG_for)
 * = −0.370 — better teams take more of their shots inside the box and rely
 * less on dead balls. At |r| ≤ 0.46 that is ~20% shared variance, far better
 * than raw totals but not zero, and CHANNEL_WEIGHTS leans away from the most
 * confounded axis accordingly.
 *
 * @param {object|null} statistics  the `statistics` block from a getTeamData
 *                                  payload (store.getTeamXg(slug).statistics)
 * @returns {{setPieceThreat: {for: number|null, against: number|null},
 *            wideTransition: {for: number|null, against: number|null},
 *            boxThreat: {for: number|null, against: number|null},
 *            shots: number, hasChannelAxes: boolean}}
 *          Axis values are 0–1 SHARES, not 0–100 scores. Direction is
 *          descriptive, not evaluative: a high setPieceThreat.for means a team
 *          leans on dead balls, which is neither good nor bad on its own.
 */
export function buildChannelProfile(statistics) {
  const sit = statistics?.situation;
  const sz  = statistics?.shotZone;
  const asp = statistics?.attackSpeed;
  if (!sit || !sz || !asp) return NO_CHANNEL_AXES;

  const DEAD = ['FromCorner', 'SetPiece', 'DirectFreekick'];
  const BOX  = ['shotSixYardBox', 'shotPenaltyArea'];

  // Sample-size guard reads SHOTS (a count), not xG (a sum of probabilities).
  let shots = 0;
  for (const k of ['OpenPlay', ...DEAD]) {
    const b = sit[k];
    if (b) shots += (typeof b.shots === 'number' ? b.shots : parseFloat(b.shots) || 0);
  }
  if (shots < MIN_CHANNEL_SHOTS) return { ...NO_CHANNEL_AXES, shots };

  const axis = (side) => ({
    setPiece: share(sumXg(sit, DEAD, side), bucketXg(sit.OpenPlay, side)),
    box:      share(sumXg(sz, BOX, side),   bucketXg(sz.shotOboxTotal, side)),
    fast:     share(bucketXg(asp.Fast, side),
                    ['Normal', 'Standard', 'Slow'].reduce((t, k) => t + bucketXg(asp[k], side), 0)),
  });

  const f = axis('for');
  const a = axis('against');

  return {
    hasChannelAxes: true,
    shots,
    setPieceThreat: { for: f.setPiece, against: a.setPiece },
    wideTransition: { for: f.fast,     against: a.fast },
    boxThreat:      { for: f.box,      against: a.box },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 44 tests.

- [ ] **Step 6: Commit**

```bash
git add js/config.js js/engine/channel.js tests/engine/channel.test.js
git commit -m "feat(engine/channel): derive three-axis profiles from team statistics

Adds buildChannelProfile() and its league-calibrated constants. No scoring
change — nothing consumes the profiles until calcChannelCounter lands."
```

---

### Task 9: Wire channel profiles into the score context

**Files:**
- Modify: `js/engine/channel.js`
- Modify: `js/engine/composite.js:63-140` (`buildScoreContext`)
- Modify: `tests/engine/channel.test.js`

**Interfaces:**
- Consumes: `buildChannelProfile` (Task 8), `buildUnderstatSlugsByTeamId` (Task 6).
- Produces: `buildChannelProfilesByTeamId(teamXgBySlug, slugsByTeamId)` → `Object<number,object>` keyed by FPL team id, containing only teams whose payload yielded `hasChannelAxes: true`.
- Produces: `ctx.channelProfilesByTeamId` — `{}` when no team payloads are cached.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/channel.test.js`:

```js
import { buildChannelProfilesByTeamId } from '../../js/engine/channel.js';

test('buildChannelProfilesByTeamId keys profiles by FPL team id', () => {
  const out = buildChannelProfilesByTeamId({ Arsenal: { statistics } }, { 1: 'Arsenal' });
  assert.equal(out[1].hasChannelAxes, true);
  assert.ok(Math.abs(out[1].setPieceThreat.for - 0.25) < 1e-9);
});

test('buildChannelProfilesByTeamId omits teams with no cached payload', () => {
  const out = buildChannelProfilesByTeamId({ Arsenal: { statistics } }, { 1: 'Arsenal', 2: 'Liverpool' });
  assert.equal(out[2], undefined);
});

test('buildChannelProfilesByTeamId omits teams whose profile is below the shot floor', () => {
  const thin = JSON.parse(JSON.stringify(statistics));
  thin.situation.OpenPlay.shots = 10;
  thin.situation.FromCorner.shots = 2;
  thin.situation.SetPiece.shots = 1;
  thin.situation.DirectFreekick.shots = 0;
  const out = buildChannelProfilesByTeamId({ Leeds: { statistics: thin } }, { 3: 'Leeds' });
  assert.equal(out[3], undefined);
});

test('buildChannelProfilesByTeamId returns {} for empty inputs', () => {
  assert.deepEqual(buildChannelProfilesByTeamId(null, null), {});
  assert.deepEqual(buildChannelProfilesByTeamId({}, {}), {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — no export named `buildChannelProfilesByTeamId`.

- [ ] **Step 3: Implement it**

Append to `js/engine/channel.js`:

```js
/**
 * Build the FPL-team-id-keyed channel profile lookup. Pure helper consumed
 * once per ctx by buildScoreContext, same idiom as buildXgProfilesByTeamId in
 * engine/style.js, so the share arithmetic never repeats per fixture.
 *
 * MODEL: teams whose profile came back below MIN_CHANNEL_SHOTS are OMITTED
 * rather than included with null axes. Presence in this map is exactly the
 * condition calcChannelCounter tests for, so an unusable profile and an absent
 * one behave identically and there is only one degradation path to reason about.
 *
 * @param {Object<string,object>|null} teamXgBySlug   store.getAllTeamXg()
 * @param {Object<number,string>|null} slugsByTeamId  buildUnderstatSlugsByTeamId()
 * @returns {Object<number,object>}  FPL team id → channel profile. {} when empty.
 */
export function buildChannelProfilesByTeamId(teamXgBySlug, slugsByTeamId) {
  if (!teamXgBySlug || !slugsByTeamId) return {};

  const out = {};
  for (const [teamId, slug] of Object.entries(slugsByTeamId)) {
    const payload = teamXgBySlug[slug];
    if (!payload) continue;
    const profile = buildChannelProfile(payload.statistics);
    if (profile.hasChannelAxes) out[teamId] = profile;
  }
  return out;
}
```

- [ ] **Step 4: Wire it into `buildScoreContext`**

In `js/engine/composite.js`, add the import:

```js
import { buildUnderstatSlugsByTeamId, buildChannelProfilesByTeamId } from './channel.js';
```

Directly after the `understatPlayersByName` precompute (currently ends around line 93), insert:

```js
  // Channel tier: the per-team Understat `statistics` block, fetched lazily by
  // the Matchup Analyser for the open fixture only. {} when nothing is cached
  // yet, in which case calcCounterMatchup degrades to the role tier — see the
  // design spec §8 for why the tier is chosen by data availability rather than
  // by which module is asking.
  const teamXgBySlug = opts.teamXgBySlug ?? null;
  const channelProfilesByTeamId = buildChannelProfilesByTeamId(
    teamXgBySlug,
    buildUnderstatSlugsByTeamId(leagueXg, season.teamsById),
  );
```

and add to the returned context object, beside `understatPlayersByName`:

```js
    channelProfilesByTeamId,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 48 tests.

- [ ] **Step 6: Verify in the browser**

Open the Matchup tab, select a fixture, wait for the two fetches, then in the console:

```js
Object.keys(window.__engine.context().channelProfilesByTeamId)
```

Expected: the two FPL team ids for the selected fixture.

- [ ] **Step 7: Commit**

```bash
git add js/engine/channel.js js/engine/composite.js tests/engine/channel.test.js
git commit -m "feat(engine/composite): precompute channel profiles per context

ctx.channelProfilesByTeamId now carries a profile for every team whose
statistics payload is cached. No scoring change — the counter engine does not
read it yet."
```

---

### Task 10: The channel counter and the mode ladder

**Files:**
- Modify: `js/engine/channel.js`
- Modify: `js/engine/counter.js:234-310` (`calcCounterMatchup`), `:312-318` (`MIRRORED_PAIRING_KEYS`)
- Modify: `tests/engine/channel.test.js`, `tests/engine/counter.test.js`
- Modify: `FEATURE_ENGINE.md` §7.2

**Interfaces:**
- Consumes: `ctx.channelProfilesByTeamId` (Task 9), `CHANNEL_WEIGHTS`, `CHANNEL_AXIS_POOLED_SD`, `CHANNEL_SENSITIVITY` (Task 8).
- Produces: `calcChannelCounter(teamA, teamB, ctx)` → `{value: number, estimated: boolean, pairings: Object, mode: 'channel'} | null`. Returns `null` — not a neutral score — when either team has no channel profile, so `calcCounterMatchup` can fall through to the role tier. Pairing keys are `setPieceThreat`, `wideTransition`, `boxThreat`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/channel.test.js`:

```js
import { calcChannelCounter } from '../../js/engine/channel.js';

const teamA = { id: 1, name: 'A' };
const teamB = { id: 2, name: 'B' };

// A leans on set pieces (0.35 vs league 0.256); B is unusually good at
// defending them (0.18 vs league 0.252). A should win that axis heavily.
const profileA = {
  hasChannelAxes: true, shots: 500,
  setPieceThreat: { for: 0.35, against: 0.25 },
  wideTransition: { for: 0.08, against: 0.09 },
  boxThreat:      { for: 0.91, against: 0.91 },
};
const profileB = {
  hasChannelAxes: true, shots: 500,
  setPieceThreat: { for: 0.22, against: 0.18 },
  wideTransition: { for: 0.09, against: 0.08 },
  boxThreat:      { for: 0.90, against: 0.91 },
};
const ctxAB = { channelProfilesByTeamId: { 1: profileA, 2: profileB } };

test('calcChannelCounter scores an axis off attackShare minus concedeShare', () => {
  const out = calcChannelCounter(teamA, teamB, ctxAB);
  // edge = 0.35 − 0.18 = 0.17; z = 0.17/0.0690 = 2.464; 50 + 2.464*14 = 84.5
  assert.ok(Math.abs(out.pairings.setPieceThreat.value - 84.50) < 0.5);
});

test('calcChannelCounter aggregates axes by CHANNEL_WEIGHTS', () => {
  const out = calcChannelCounter(teamA, teamB, ctxAB);
  assert.ok(out.value > 50 && out.value <= 100);
  assert.equal(out.mode, 'channel');
});

test('calcChannelCounter is asymmetric', () => {
  const ab = calcChannelCounter(teamA, teamB, ctxAB).value;
  const ba = calcChannelCounter(teamB, teamA, ctxAB).value;
  assert.notEqual(Math.round(ab), Math.round(ba));
});

test('calcChannelCounter clamps into 0-100 on an extreme mismatch', () => {
  const extremeA = { ...profileA, setPieceThreat: { for: 0.90, against: 0.25 } };
  const out = calcChannelCounter(teamA, teamB, { channelProfilesByTeamId: { 1: extremeA, 2: profileB } });
  assert.ok(out.pairings.setPieceThreat.value <= 100);
  assert.ok(out.value <= 100);
});

test('calcChannelCounter returns null when either team has no profile', () => {
  assert.equal(calcChannelCounter(teamA, teamB, { channelProfilesByTeamId: { 1: profileA } }), null);
  assert.equal(calcChannelCounter(teamA, teamB, { channelProfilesByTeamId: {} }), null);
  assert.equal(calcChannelCounter(teamA, teamB, {}), null);
});

test('calcChannelCounter reports estimated false when both profiles are real', () => {
  assert.equal(calcChannelCounter(teamA, teamB, ctxAB).estimated, false);
});
```

Append to `tests/engine/counter.test.js` — the invariant that must survive:

```js
import { calcCounterMatchupMirrored } from '../../js/engine/counter.js';

test('mirroring identity holds for channel-mode pairings', () => {
  const attacking = {
    value: 61.177534, estimated: false, mode: 'channel',
    pairings: {
      setPieceThreat: { value: 84.502, weight: 0.50, estimated: false },
      wideTransition: { value: 45.783, weight: 0.30, estimated: false },
      boxThreat:      { value: 56.703, weight: 0.20, estimated: false },
    },
  };
  const mirrored = calcCounterMatchupMirrored(attacking);
  for (const [key, mirrorKey] of [
    ['setPieceThreat', 'setPieceDefence'],
    ['wideTransition', 'transitionDefence'],
    ['boxThreat',      'boxDefence'],
  ]) {
    assert.equal(
      attacking.pairings[key].value + mirrored.pairings[mirrorKey].value,
      100,
      `${key} + ${mirrorKey} must total exactly 100`,
    );
  }
  assert.equal(attacking.value + mirrored.value, 100);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — no export named `calcChannelCounter`, and the mirroring test fails because `MIRRORED_PAIRING_KEYS` has no channel entries.

- [ ] **Step 3: Implement `calcChannelCounter`**

Append to `js/engine/channel.js`, extending the config import:

```js
import {
  MIN_CHANNEL_SHOTS, CHANNEL_WEIGHTS, CHANNEL_AXIS_POOLED_SD, CHANNEL_SENSITIVITY,
} from '../config.js';
import { clamp } from '../util.js';
```

```js
/**
 * Channel counter-matchup: team A's threat profile against team B's
 * conceding profile, axis by axis.
 *
 * Asymmetric by design, exactly like calcCounterMatchup — A's attack against
 * B's defence is a different number from B's attack against A's defence.
 *
 * MODEL: the league baseline cancels out of the edge. Every team's xG-for in
 * an axis is another team's xG-against, so league-mean-for equals
 * league-mean-against to within 0.004 on all three axes (2025, n=20).
 * Subtracting the two shares therefore removes the baseline automatically —
 * which is what makes a two-teams-at-a-time fetch viable, since no league-wide
 * sweep is needed to centre the score.
 *
 * MODEL: each edge is z-scored by its OWN pooled SD before scaling. The axes
 * have very different natural spreads (set-piece share ranges 0.170–0.370
 * across the league, box share only 0.884–0.937), so a single shared
 * sensitivity would let the widest axis dominate purely by units.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx  must contain { channelProfilesByTeamId }
 * @returns {{value: number, estimated: boolean, pairings: Object,
 *            mode: 'channel'} | null}
 *          0–100, higher = better for teamA. null when either team has no
 *          usable profile — the caller falls through to the role tier.
 */
export function calcChannelCounter(teamA, teamB, ctx) {
  const profiles = ctx?.channelProfilesByTeamId;
  const a = profiles?.[teamA?.id];
  const b = profiles?.[teamB?.id];
  if (!a?.hasChannelAxes || !b?.hasChannelAxes) return null;

  const pairings = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const key of Object.keys(CHANNEL_WEIGHTS)) {
    const attackShare  = a[key]?.for;
    const concedeShare = b[key]?.against;
    // Guarded even though hasChannelAxes implies both are numbers — a future
    // axis added to CHANNEL_WEIGHTS but not to buildChannelProfile would
    // otherwise silently score NaN.
    if (typeof attackShare !== 'number' || typeof concedeShare !== 'number') continue;

    const edge  = attackShare - concedeShare;
    const value = clamp(0, 100, 50 + (edge / CHANNEL_AXIS_POOLED_SD[key]) * CHANNEL_SENSITIVITY);
    const weight = CHANNEL_WEIGHTS[key];

    pairings[key] = { value, weight, estimated: false, attackShare, concedeShare };
    weightedSum += value * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  return {
    value: clamp(0, 100, weightedSum / totalWeight),
    estimated: false,
    pairings,
    mode: 'channel',
  };
}
```

- [ ] **Step 4: Add the channel mirrors**

In `js/engine/counter.js`, extend `MIRRORED_PAIRING_KEYS` (line 312) with the three channel keys:

```js
const MIRRORED_PAIRING_KEYS = {
  stVsCb:      'cbVsSt',
  wmVsFb:      'fbVsWm',
  cmVsCbDm:    'cbDmVsCm',
  fwdVsCb:     'cbVsFwd',
  wideMidVsFb: 'fbVsWideMid',
  camVsCbMid:  'cbMidVsCam',
  // Channel tier. The mirror is still arithmetic (100 − attacking value), NOT
  // a second read from the defending team's own statistics.against — deriving
  // it independently would break the sum-to-100 identity §7.2 depends on.
  setPieceThreat: 'setPieceDefence',
  wideTransition: 'transitionDefence',
  boxThreat:      'boxDefence',
};
```

- [ ] **Step 5: Add the tier selection to `calcCounterMatchup`**

In `js/engine/counter.js`, import the channel entry point:

```js
import { calcChannelCounter } from './channel.js';
```

and insert at the very top of `calcCounterMatchup`'s body, before `const playersA = …`:

```js
  // Tier 1 — channel mode, when both teams' Understat statistics are cached.
  // MODEL: the tier is chosen by DATA AVAILABILITY, not by which module is
  // asking, so a fixture's score can only improve as payloads land and can
  // never disagree with itself at a single point in time. See the design spec
  // §8 and buildScoreContext's channelProfilesByTeamId precompute.
  const channel = calcChannelCounter(teamA, teamB, ctx);
  if (channel) return channel;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 55 tests.

- [ ] **Step 7: Verify in the browser**

Open a fixture in the Matchup tab and wait for both team fetches, then:

```js
const ctx = window.__engine.context();
const f = window.__store.getFixtures().find(x => !x.played);
window.__engine.calcCounterMatchup(window.__store.getTeam(f.homeTeamId), window.__store.getTeam(f.awayTeamId), ctx).mode
```

Expected: `'channel'`. Before the fetches land, the same call returns `'role'`.

- [ ] **Step 8: Update FEATURE_ENGINE.md**

Add a subsection to §7.2 after the pairing formula:

```markdown
**Channel tier (`engine/channel.js → calcChannelCounter`).** When both teams'
Understat `statistics` payloads are cached, the counter is scored on three
independent axes instead of position pairings:

```
axisEdge(a)  = attackShare_A(a) − concedeShare_B(a)
axisScore(a) = clamp(0,100, 50 + (axisEdge(a) / CHANNEL_AXIS_POOLED_SD[a]) * CHANNEL_SENSITIVITY)
value        = Σ axisScore(a) * CHANNEL_WEIGHTS[a] / Σ CHANNEL_WEIGHTS[a]
```

Axes: `setPieceThreat` (dead-ball share of non-penalty xG, weight 0.50),
`wideTransition` (Fast share of attack-speed xG, 0.30), `boxThreat` (in-box
share of shot-zone xG, 0.20). No open-play axis exists — `openPlayShare` is
identically `1 − setPieceShare`. The league baseline cancels out of every edge
because each team's xG-for in an axis is another team's xG-against, so no
league-wide sweep is needed to centre the scores. The mirrored Defending
Counters stay arithmetic (`100 − attacking`), preserving the identity above.

Tier selection is by data availability: `channel` → `role` → `element`.
```

- [ ] **Step 9: Commit**

```bash
git add js/engine/channel.js js/engine/counter.js tests/engine/*.test.js FEATURE_ENGINE.md
git commit -m "feat(engine/counter): add channel tier above role pairings

calcCounterMatchup now prefers a three-axis threat-vs-vulnerability read when
both teams' Understat statistics are cached. Expected effect: set-piece-reliant
sides gain against poor set-piece defences and lose against good ones — a
dimension the composite previously had no signal on at all."
```

---

### Task 11: Personnel weighting for the channel axes

> Tasks 1–10 deliver a working channel tier. This task refines it and can be
> rejected on its own without unwinding anything above.

**Files:**
- Modify: `js/engine/channel.js`
- Modify: `js/config.js`
- Modify: `tests/engine/channel.test.js`
- Modify: `FEATURE_ENGINE.md` §7.2

**Interfaces:**
- Consumes: `calcChannelCounter` (Task 10), `classifyRole` and `buildRoleSignature` (Tasks 1–3).
- Produces: `channelPersonnelFactor(players, roles, axisKey, ctx)` → `number` in `[CHANNEL_PERSONNEL_MIN, CHANNEL_PERSONNEL_MAX]`, `1` when there is not enough data to judge.
- Produces: `CHANNEL_ROLE_AXES`, `CHANNEL_PERSONNEL_MIN`, `CHANNEL_PERSONNEL_MAX` from `js/config.js`.

- [ ] **Step 1: Add the config constants**

In `js/config.js`, after `MIN_CHANNEL_SHOTS`:

```js
// Which roles supply each channel axis, for personnel weighting.
// MODEL: the axes are shot-partition shares of a SEASON, so they cannot react
// to an injury. Scaling the attacking share by how much of the relevant unit
// is actually available makes a season aggregate respond to this week's squad.
export const CHANNEL_ROLE_AXES = {
  boxThreat:      ['ST', 'SS'],
  wideTransition: ['WM', 'FB'],
  // MODEL: set pieces are attacked by the aerial targets, not the whole XI —
  // weighting by all eleven would make the factor a constant.
  setPieceThreat: ['CB', 'ST', 'SS'],
};

// Bounds on the personnel factor. MODEL: deliberately narrow. The factor
// corrects a season profile for this week's availability; it is not a second
// quality term, and an unbounded ratio would let one missing player swamp the
// axis edge it multiplies.
export const CHANNEL_PERSONNEL_MIN = 0.80;
export const CHANNEL_PERSONNEL_MAX = 1.20;
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/engine/channel.test.js`:

```js
import { channelPersonnelFactor } from '../../js/engine/channel.js';

const squad = [
  { id: 1, position: 'FWD', fullName: 'Big Striker',  totals: { minutes: 2700 }, chanceOfPlayingNext: 100 },
  { id: 2, position: 'FWD', fullName: 'Backup',       totals: { minutes: 300  }, chanceOfPlayingNext: 100 },
  { id: 3, position: 'MID', fullName: 'Winger',       totals: { minutes: 2700 }, chanceOfPlayingNext: 100 },
];
const roles = { 1: 'ST', 2: 'ST', 3: 'WM' };
const chainCtx = { understatPlayersByName: {
  'big striker': { time: '2700', xGChain: '24',    xGBuildup: '5',   xA: '2',    npxG: '12' },
  'backup':      { time: '300',  xGChain: '0.666', xGBuildup: '0.2', xA: '0.05', npxG: '0.3' },
  'winger':      { time: '2700', xGChain: '18',    xGBuildup: '6',   xA: '6',    npxG: '6'  },
} };

test('channelPersonnelFactor is 1.0 when the unit is fully available', () => {
  const f = channelPersonnelFactor(squad, roles, 'boxThreat', chainCtx);
  assert.ok(Math.abs(f - 1) < 1e-9);
});

test('channelPersonnelFactor drops when the unit leader is ruled out', () => {
  const injured = squad.map(p => p.id === 1 ? { ...p, chanceOfPlayingNext: 0 } : p);
  const f = channelPersonnelFactor(injured, roles, 'boxThreat', chainCtx);
  assert.ok(f < 1, `expected a penalty, got ${f}`);
  assert.ok(f >= 0.80, 'must not exceed the configured floor');
});

test('channelPersonnelFactor clamps to the configured bounds', () => {
  const injured = squad.map(p => p.id === 1 ? { ...p, chanceOfPlayingNext: 0 } : p);
  assert.ok(channelPersonnelFactor(injured, roles, 'boxThreat', chainCtx) >= 0.80);
  assert.ok(channelPersonnelFactor(squad,   roles, 'boxThreat', chainCtx) <= 1.20);
});

test('channelPersonnelFactor is a neutral 1.0 when no unit player is matched', () => {
  assert.equal(channelPersonnelFactor(squad, roles, 'boxThreat', { understatPlayersByName: {} }), 1);
});

test('channelPersonnelFactor is a neutral 1.0 when the unit is empty', () => {
  assert.equal(channelPersonnelFactor(squad, {}, 'boxThreat', chainCtx), 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — no export named `channelPersonnelFactor`.

- [ ] **Step 4: Implement it**

Append to `js/engine/channel.js`, extending the config import with `CHANNEL_ROLE_AXES`, `CHANNEL_PERSONNEL_MIN`, `CHANNEL_PERSONNEL_MAX`, and importing the signature helper:

```js
import { buildRoleSignature } from './counter.js';
```

```js
/**
 * How much of an axis's usual chain contribution is actually available this
 * week, as a multiplier on that axis's attacking share.
 *
 * MODEL: self-normalising — availability-weighted chain over total chain for
 * the SAME unit. No league constant is needed, and a team whose whole unit is
 * fit scores exactly 1.0 regardless of how good that unit is, so the factor
 * corrects for availability without smuggling in a second quality term.
 *
 * @param {Player[]} players            the team's squad
 * @param {Object<number,string>} roles playerId → role, from classifyTeamRoles
 * @param {string} axisKey              a key of CHANNEL_ROLE_AXES
 * @param {object} ctx                  buildScoreContext result
 * @returns {number}  CHANNEL_PERSONNEL_MIN–MAX; exactly 1 when there is not
 *                    enough data to judge. Direction: higher = more of the
 *                    unit available.
 */
export function channelPersonnelFactor(players, roles, axisKey, ctx) {
  const wanted = CHANNEL_ROLE_AXES[axisKey];
  const lookup = ctx?.understatPlayersByName;
  if (!wanted || !lookup || !players) return 1;

  let availableChain = 0;
  let totalChain = 0;
  for (const p of players) {
    if (!wanted.includes(roles?.[p.id])) continue;
    const key = (p.fullName || '').toLowerCase().trim();
    const sig = key ? buildRoleSignature(lookup[key]) : null;
    if (!sig) continue;

    const minutes = p.totals?.minutes ?? 0;
    const seasonChain = sig.chain90 * (minutes / 90);
    totalChain += seasonChain;

    // chanceOfPlayingNext is null for most players — FPL populates it only
    // when there is news, so null means "no doubt reported" (FEATURE_ENGINE
    // §7.3), never "no data".
    const availability = (p.chanceOfPlayingNext ?? 100) / 100;
    availableChain += seasonChain * availability;
  }

  if (totalChain <= 0) return 1;
  return clamp(CHANNEL_PERSONNEL_MIN, CHANNEL_PERSONNEL_MAX, availableChain / totalChain);
}
```

- [ ] **Step 5: Apply the factor in `calcChannelCounter`**

`calcChannelCounter` needs the squad and roles, so add a role classification at its head. Replace the pairing loop's `const edge = attackShare - concedeShare;` line with:

```js
    const personnel = channelPersonnelFactor(
      ctx.playersByTeamId?.[teamA.id] || [], rolesA, key, ctx,
    );
    // MODEL: the factor scales the ATTACKING share only. B's conceding profile
    // describes how B leaks, which this week's availability in A's squad
    // cannot change.
    const edge = (attackShare * personnel) - concedeShare;
```

and add, immediately after the `if (!a?.hasChannelAxes || !b?.hasChannelAxes) return null;` guard:

```js
  // Roles for A only — the factor scales A's attacking share, and B's
  // conceding share needs no personnel read.
  const rolesA = {};
  for (const p of ctx.playersByTeamId?.[teamA.id] || []) {
    const role = classifyRole(p, ctx);
    if (role) rolesA[p.id] = role;
  }
```

importing `classifyRole` alongside `buildRoleSignature`. Record the factor on the pairing object by extending its literal:

```js
    pairings[key] = { value, weight, estimated: false, attackShare, concedeShare, personnel };
```

**Circular import note:** `channel.js` now imports from `counter.js`, which already imports `calcChannelCounter` from `channel.js`. ES modules handle this cycle correctly because every binding is a hoisted function declaration, resolved at call time rather than module-evaluation time. If any of these are ever converted to `const fn = () => …`, the cycle breaks — keep them as `function` declarations.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, 60 tests. The Task 10 test `calcChannelCounter is asymmetric` must still pass — if it now fails, the factor is being applied to both sides.

- [ ] **Step 7: Update FEATURE_ENGINE.md**

Append to the channel-tier subsection added in Task 10:

```markdown
`attackShare` is scaled by `channelPersonnelFactor` — the availability-weighted
share of the axis unit's season xGChain that is fit this week, clamped to
0.80–1.20. Self-normalising against the same unit, so a fully fit team scores
exactly 1.0 regardless of quality. This is what lets a season aggregate react
to an injury.
```

- [ ] **Step 8: Commit**

```bash
git add js/config.js js/engine/channel.js tests/engine/channel.test.js FEATURE_ENGINE.md
git commit -m "feat(engine/channel): scale axis threat by unit availability

Channel attacking shares now respond to injuries in the unit that supplies the
axis. Expected effect: teams missing a first-choice striker lose box threat,
teams missing an aerial centre-back lose set-piece threat."
```

---

### Task 12: Render the channel pairings

**Files:**
- Modify: `js/modules/matchup.js:47-70` (`PAIRING_LABELS`, `DEFENDING_PAIRING_LABELS`)
- Modify: `js/engine/counter.js:423` (`PAIRING_ROLE_ALIAS`) and `:448` (`duelsForPairing`)

**Interfaces:**
- Consumes: channel pairing keys from Task 10 (`setPieceThreat`, `wideTransition`, `boxThreat`) and their mirrors (`setPieceDefence`, `transitionDefence`, `boxDefence`).

- [ ] **Step 1: Add the attacking labels**

In `js/modules/matchup.js`, extend `PAIRING_LABELS`:

```js
const PAIRING_LABELS = {
  stVsCb:      'ST vs CB',
  wmVsFb:      'Wingers vs Fullbacks',
  cmVsCbDm:    'CAM vs CDM',
  fwdVsCb:     'FWD vs CB',
  wideMidVsFb: 'Wide MID vs FB',
  camVsCbMid:  'CAM vs CB+DM',
  // Channel tier (engine/channel.js). These are threat-profile axes rather
  // than position pairings, so they read as phases of play, not matchups.
  setPieceThreat: 'Set Pieces',
  wideTransition: 'Transition Speed',
  boxThreat:      'Box Occupation',
};
```

- [ ] **Step 2: Add the defending labels**

Extend `DEFENDING_PAIRING_LABELS` with the three mirrors:

```js
  setPieceDefence:   'Set-Piece Defence',
  transitionDefence: 'Transition Defence',
  boxDefence:        'Box Defence',
```

- [ ] **Step 3: Make `duelsForPairing` return `[]` for channel keys**

Channel axes are not built from named player pairings, so the info disclosure must show its existing "no player data available" state rather than an unrelated duel list. In `js/engine/counter.js`, at the top of `duelsForPairing`'s body:

```js
  // MODEL: channel-tier axes are team shot-profile shares, not player-vs-player
  // pairings, so there is no honest duel list to show. Return empty and let the
  // UI render its explicit "no player data" state rather than surfacing duels
  // that had no part in the score.
  if (!(pairingKey in PAIRING_ROLE_ALIAS)) return [];
```

Confirm `PAIRING_ROLE_ALIAS` is not extended with channel keys — the three channel keys must stay absent from it for this guard to work.

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS, 60 tests.

- [ ] **Step 5: Verify in the browser**

Open a fixture, wait for both team fetches to land, and confirm on the card:

- The Attacking Counters section shows three rows labelled **Set Pieces**, **Transition Speed**, **Box Occupation** — no raw camelCase keys anywhere.
- The Defending Counters section shows **Set-Piece Defence**, **Transition Defence**, **Box Defence**.
- Each attacking row's score plus its mirrored defending row's score on the *other* card totals 100.
- Expanding a channel row's info disclosure shows the "no player data available" state, not a stale duel list.

- [ ] **Step 6: Commit**

```bash
git add js/modules/matchup.js js/engine/counter.js
git commit -m "feat(matchup): label channel-tier counter pairings"
```

---

### Task 13: Calibration comparison

**Files:**
- Modify: `GAFFER_IQ_TESTING_ROADMAP.md`
- No source changes.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Capture a before/after comparison**

With the branch checked out and the app loaded, record composite scores for the current gameweek's fixtures on each tier. In the console:

```js
const ctx = window.__engine.context();
window.__store.getFixtures().filter(f => !f.played && f.gw === window.__store.getNextGw())
  .map(f => {
    const h = window.__store.getTeam(f.homeTeamId), a = window.__store.getTeam(f.awayTeamId);
    const s = window.__engine.scoreFixture(h, f, ctx);
    return { fixture: `${h.shortName} v ${a.shortName}`, value: Math.round(s.value), mode: s.breakdown.counterMatchup.mode, confidence: s.confidence };
  });
```

Run once before opening any fixture (role tier throughout), then again after visiting each fixture so the statistics are cached (channel tier throughout). Record both tables.

- [ ] **Step 2: Sanity-check the deltas**

Confirm all three hold. Any failure is a bug in Tasks 10–11, not a tuning problem:

- No fixture's composite moves by more than 15 points between tiers. A larger swing means `CHANNEL_SENSITIVITY` is overpowered relative to the role tier it replaces.
- The home and away composites for the same fixture still total ~100 (the §8.7 relative property).
- `confidence` does not *fall* when moving to the channel tier — channel pairings are never `estimated`, so it should rise or hold.

- [ ] **Step 3: Add the checks to the testing roadmap**

In `GAFFER_IQ_TESTING_ROADMAP.md`, under the Technical Checklist, add:

```markdown
- [ ] Counter-matchup reaches channel mode — open a fixture, wait for both team
      fetches, and check `window.__engine.counterMatchup(home, away, ctx).mode`
      returns `'channel'`
- [ ] Channel pairing rows render as Set Pieces / Transition Speed / Box
      Occupation, never raw camelCase keys
- [ ] Attacking + Defending counter values still total exactly 100 per pairing
- [ ] Role signature spot-check — classify the current season's squads and
      confirm known players land correctly (a first-choice fullback reads FB,
      a set-piece centre-back reads CB, a holding midfielder reads DM). The
      thresholds were derived on 900+ minute players from a COMPLETE season and
      are applied in-season at a 450-minute floor, so this is the check that
      the extrapolation holds.
```

- [ ] **Step 4: Commit**

```bash
git add GAFFER_IQ_TESTING_ROADMAP.md
git commit -m "docs(testing): add channel counter tier verification checks"
```

---

## Deferred — not in this plan

Per the spec §10, these are explicitly out of scope: `gameState` game-script
modelling, `formation`-driven likely XIs (replacing the 4-4-2 baseline in
`buildLikelyXi`), `timing` and `result` buckets, previous-season blending to
stabilise early-season shares, and revisiting `WEIGHTS.counterMatchup` (0.20).
The last one is a calibration decision and should be made only after Task 13's
comparison has run against real in-season data.
