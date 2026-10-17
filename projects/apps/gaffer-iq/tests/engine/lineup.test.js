/**
 * tests/engine/lineup.test.js
 * Unit tests for engine/lineup.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickStartingXI } from '../../js/engine/lineup.js';

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

// ─── Value accessor (decision engine plan Phase 2) ───────────────────────────

test('pickStartingXI orders by a value accessor when given one', () => {
  // The decision engine picks by a gameweek's xpts, not by expectedPoints.
  // Inverting the values flips who starts in midfield.
  const squad = squadOf15().map(e => ({ ...e, xpts: 10 - e.score.expectedPoints.value }));
  const startingIds = pickStartingXI(squad, e => e.xpts).xi.map(e => e.player.id);
  assert.ok(startingIds.includes(12), 'the 8.5 MID starts');
  assert.ok(!startingIds.includes(8),  'the 1.0 MID does not');
});

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The best XI total over every legal formation - the brief's "enumerate formations". */
function bruteForceBest(squad, valueOf) {
  const top = (pos, n) => squad.filter(e => e.player.position === pos)
    .map(valueOf).sort((a, b) => b - a).slice(0, n).reduce((s, v) => s + v, 0);
  let best = -Infinity;
  for (let d = 3; d <= 5; d++) {
    for (let m = 2; m <= 5; m++) {
      const f = 10 - d - m;
      if (f >= 1 && f <= 3) best = Math.max(best, top('GKP', 1) + top('DEF', d) + top('MID', m) + top('FWD', f));
    }
  }
  return best;
}

test('pickStartingXI\'s greedy XI matches brute-force formation enumeration', () => {
  const random = seeded(2026);
  const positions = ['GKP', 'GKP', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF',
    'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD'];
  for (let run = 0; run < 500; run++) {
    // Rounded to halves so ties are common, as they are with real projections.
    const squad = positions.map((position, i) => ({
      player: { id: i + 1, position }, xpts: Math.round(random() * 24) / 2,
    }));
    const { xi } = pickStartingXI(squad, e => e.xpts);
    const total = xi.reduce((s, e) => s + e.xpts, 0);
    assert.equal(total, bruteForceBest(squad, e => e.xpts), `run ${run}`);
  }
});
