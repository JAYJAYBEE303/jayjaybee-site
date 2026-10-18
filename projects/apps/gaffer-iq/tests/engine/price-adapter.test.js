/**
 * tests/engine/price-adapter.test.js
 * The price adapter (docs/decision-engine-plan.md Phase 5): the one reader of
 * FPL's undocumented 2026/27 price-change predictor, and its fallback to the
 * transfer-flow estimate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { priceSignal, priceSignals } from '../../js/engine/price-adapter.js';
import { calcPriceChangeRisk } from '../../js/engine/prices.js';

/**
 * FPL's predictor fields as bootstrap-static sends them: progress towards a
 * price change in percent (as text), now and at each update it projects.
 */
const feed = (percent, projected) => ({
  price_change_percent: String(percent),
  price_change_projections: projected.map((p, offset) => ({ offset, projected_percent: String(p), likelihood: 0 })),
  price_change_calibrating: false,
  price_change_locked_until: null,
  price_change_hourly_rate: 0,
});
const player = (priceFeed, overrides = {}) => ({
  id: 7, priceFeed, transfersInEvent: 0, transfersOutEvent: 0, ownership: 5, ...overrides,
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

test('a fall FPL projects past its threshold within its window is certain; progress short of it is a partial chance', () => {
  assert.deepEqual(priceSignal(player(feed(-56.6, [-56.6, -80.2, -120.4]))), { fall: 1, rise: 0, source: 'fpl' });
  const partial = priceSignal(player(feed(-20, [-20, -30, -40.5])));
  assert.equal(partial.rise, 0);
  close(partial.fall, 0.405);
});

test('a rise reads the same way, from the furthest the projections reach', () => {
  const signal = priceSignal(player(feed(10, [10, 50, 90])));
  close(signal.rise, 0.9);
  assert.equal(signal.fall, 0);
});

test('FPL\'s "-0.0" reads as no move at all, not a negative zero', () => {
  assert.deepEqual(priceSignal(player(feed('-0.0', ['-0.0', '-0.0', '-0.0']))), { fall: 0, rise: 0, source: 'fpl' });
});

test('without projections his current progress stands alone', () => {
  close(priceSignal(player({ price_change_percent: '-75.0', price_change_calibrating: false })).fall, 0.75);
});

test('while FPL calibrates him, or with no predictor at all, the transfer-flow estimate stands in, flagged', () => {
  const flow = { transfersInEvent: 1000, transfersOutEvent: 99000 };
  const risk = calcPriceChangeRisk(player(null, flow));
  assert.equal(risk.direction, 'fall');
  const estimate = { fall: risk.confidence, rise: 0, source: 'estimate' };
  assert.deepEqual(priceSignal(player(null, flow)), estimate);
  assert.deepEqual(priceSignal(player({ ...feed(-150, [-150, -150, -150]), price_change_calibrating: true }, flow)),
    estimate);
  assert.deepEqual(priceSignal(player({ price_change_percent: 'n/a' })), { fall: 0, rise: 0, source: 'estimate' });
});

test('priceSignals reads every player, keyed by id', () => {
  const signals = priceSignals([player(feed(0, [0, 0, 0])), player(feed(5, [5, 5, 5]), { id: 9 })]);
  assert.deepEqual(Object.keys(signals), ['7', '9']);
  close(signals[9].rise, 0.05);
});
