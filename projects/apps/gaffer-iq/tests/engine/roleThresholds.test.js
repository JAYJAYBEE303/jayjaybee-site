/**
 * tests/engine/roleThresholds.test.js
 * Regression test for the classification thresholds in js/config.js
 * (ROLE_SIGNATURE_THRESHOLDS) against a small set of named, well-known
 * players whose position is unambiguous. This is what makes the §4/§9
 * "known players still land correctly" check run in CI instead of only in
 * a manual browser spot-check — a threshold edit that silently reclassifies
 * Robertson as a CB, or Xhaka as a CM, fails here.
 *
 * MAINTENANCE: the records below are real Understat per-player season
 * totals (time, xG, xA, npxG, xGChain, xGBuildup), captured from a live
 * `getLeagueData/EPL/2025` pull on 2026-08-21 — NOT fabricated. They go
 * stale as a season progresses and a player's role changes clubs or
 * systems. Refresh this fixture set from a live pull each pre-season, and
 * whenever Task 13 Step 2's manual spot-check disagrees with what this
 * test asserts.
 *
 * SEASON: these are season 2025 (the 2025/26 campaign, complete) records,
 * not 2026. Understat's `getLeagueData/EPL/2026` payload was verified live
 * on 2026-08-21 and is still empty — `{"teams":[],"players":[],"dates":[]}`
 * — so no current-season records exist to capture yet. 2025 is also the
 * season ROLE_SIGNATURE_THRESHOLDS was derived from (design spec §4), so
 * these are exactly the players and numbers that derivation was checked
 * against. Re-pull for 2026 once enough of it has been played that regulars
 * clear ROLE_SIGNATURE_MIN_MINUTES.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoleSignature, classifyRoleFromSignature } from '../../js/engine/counter.js';

// One player per role the design spec names as a spot-check in §4: a
// first-choice attacking fullback, a set-piece-taking centre-back, a holding
// midfielder, a high-volume winger, and an out-and-out striker.
const SPOT_CHECK = [
  {
    name: 'Robertson', position: 'DEF', role: 'FB',
    // buildupShare 0.7644 (< 0.82) AND createBias 0.5904 (>= 0.50) -> FB
    record: {
      time: '1160', xG: '1.047316076233983', xA: '1.5095006115734577',
      npxG: '1.047316076233983', xGChain: '5.851028840988874',
      xGBuildup: '4.472272000275552',
    },
  },
  {
    name: 'Tarkowski', position: 'DEF', role: 'CB',
    // buildupShare 0.8161 is BELOW 0.82, so buildupShare alone would misfile
    // him as a fullback — createBias 0.4175 (< 0.50) is what keeps him a CB.
    // This is the set-piece-centre-back case §4 added createBias for.
    record: {
      time: '3330', xG: '2.8690776508301497', xA: '2.0567114762961864',
      npxG: '2.8690776508301497', xGChain: '6.824133190326393',
      xGBuildup: '5.569046746008098',
    },
  },
  {
    name: 'Xhaka', position: 'MID', role: 'DM',
    // npxg90 0.0251 (< 0.22, not a WM) and buildupShare 0.8590 (>= 0.78) -> DM
    record: {
      time: '2896', xG: '0.8072718912735581', xA: '3.7049803622066975',
      npxG: '0.8072718912735581', xGChain: '10.455324796028435',
      xGBuildup: '8.981416845694184',
    },
  },
  {
    name: 'Saka', position: 'MID', role: 'WM',
    // npxg90 0.3192 (>= 0.22) -> WM, tested before the DM build-up rule
    record: {
      time: '2239', xG: '8.701195661909878', xA: '8.552797641605139',
      npxG: '7.940026824362576', xGChain: '19.112561374902725',
      xGBuildup: '8.03783930838108',
    },
  },
  {
    name: 'Haaland', position: 'FWD', role: 'ST',
    // buildupShare 0.1577 (< 0.30) -> ST, not a dropping-off SS
    record: {
      time: '2979', xG: '28.795336209237576', xA: '5.507687093690038',
      npxG: '25.7506607696414', xGChain: '32.735352732241154',
      xGBuildup: '5.163548586890101',
    },
  },
];

for (const { name, position, role, record } of SPOT_CHECK) {
  test(`role threshold spot-check: ${name} classifies as ${role}`, () => {
    const sig = buildRoleSignature(record);
    assert.equal(classifyRoleFromSignature(position, sig), role);
  });
}

test('role threshold spot-check fixture is populated', () => {
  // Fails loudly if Step 1 above was skipped and the TODO records were
  // never filled in — a silent empty array would make every test in this
  // file vacuously pass.
  assert.ok(SPOT_CHECK.length >= 5, 'populate SPOT_CHECK with real current-season records before merging');
});
