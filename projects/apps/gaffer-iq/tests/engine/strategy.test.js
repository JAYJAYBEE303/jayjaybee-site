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
