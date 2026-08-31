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

test('calcXiExpectedPoints reports estimated when any input score is estimated', () => {
  const squad = squadOf15();
  squad[7].score.expectedPoints.estimated = true;   // the 9.0 MID, a certain starter
  assert.equal(calcXiExpectedPoints(squad).estimated, true);
});

test('calcXiExpectedPoints is zero for an empty squad rather than NaN', () => {
  const result = calcXiExpectedPoints([]);
  assert.equal(result.value, 0);
  assert.equal(Number.isNaN(result.value), false);
});
