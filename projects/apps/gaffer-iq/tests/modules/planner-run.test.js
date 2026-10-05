/**
 * tests/modules/planner-run.test.js
 * The Planner run's transfer-rule arithmetic (js/modules/planner-run.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRun } from '../../js/modules/planner-run.js';

const TEAM = { 1: 10, 2: 10, 3: 10, 4: 20, 5: 10, 6: 30 };
const base = {
  gws: [8, 9, 10],
  ft: 1, hit: false, bank: 1.0,
  squad: [1, 2, 3, 4],
  teamOf: id => TEAM[id] ?? null,
  nameOf: id => `P${id}`,
  teamName: t => `T${t}`,
};
const mv = (id, outId, inId, gw, priceDiff = 0, gain = 1) => ({ id, outId, inId, gw, priceDiff, gain });

test('free transfers roll over, one new each week', () => {
  const r = evaluateRun([mv('a', 4, 6, 10)], {}, base);
  assert.deepEqual(r.weeks.map(w => w.ftAvail), [1, 2, 3]);
  assert.equal(r.valid, true);
  assert.equal(r.gain, 1);
});

test('a second move in one week is a hit — refused unless hits are on', () => {
  const two = [mv('a', 4, 6, 8), mv('b', 1, 6 + 100, 8)];
  const off = evaluateRun(two, {}, base);
  assert.equal(off.valid, false);
  assert.equal(off.weeks[0].hits, 1);

  const on = evaluateRun(two, {}, { ...base, hit: true });
  assert.equal(on.valid, true);
  assert.equal(on.hitCost, 4);
  assert.equal(on.net, on.gain - 4);
});

test('a wildcard week has no hits and keeps the free-transfer count', () => {
  const two = [mv('a', 4, 6, 8), mv('b', 1, 106, 8)];
  const r = evaluateRun(two, { wildcard: 8 }, base);
  assert.equal(r.weeks[0].hits, 0);
  assert.equal(r.weeks[1].ftAvail, 1);
});

test('bank, club limit, double sale and two chips are all problems', () => {
  assert.equal(evaluateRun([mv('a', 4, 6, 8, 2.0)], {}, base).valid, false);          // over budget
  assert.equal(evaluateRun([mv('a', 4, 5, 8)], {}, base).valid, false);               // fourth T10 player
  const twice = evaluateRun([mv('a', 4, 6, 8), mv('b', 4, 106, 9)], {}, base);
  assert.deepEqual([...twice.badMoves].sort(), ['a', 'b']);
  assert.equal(evaluateRun([], { wildcard: 9, freehit: 9 }, base).valid, false);
});
