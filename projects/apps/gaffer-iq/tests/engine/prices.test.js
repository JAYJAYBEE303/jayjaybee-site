/**
 * tests/engine/prices.test.js
 * Unit tests for engine/prices.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calcSeasonPriceChange, calcSellPrice } from '../../js/engine/prices.js';

test('calcSeasonPriceChange reports a rise for a positive cost change', () => {
  // cost_change_start is in TENTHS of a million: 3 → +£0.3m.
  const result = calcSeasonPriceChange({ costChangeStart: 3 });
  assert.equal(result.value, 0.3);
  assert.equal(result.direction, 'rise');
  assert.equal(result.label, '+£0.3m');
});

test('calcSeasonPriceChange reports a fall for a negative cost change', () => {
  // The minus sign belongs to the number, not the currency symbol -
  // "-£0.1m", never "£-0.1m".
  const result = calcSeasonPriceChange({ costChangeStart: -1 });
  assert.equal(result.value, -0.1);
  assert.equal(result.direction, 'fall');
  assert.equal(result.label, '-£0.1m');
});

test('calcSeasonPriceChange reports flat for a zero cost change', () => {
  // The edge case that decides the styling: a player who has not moved must
  // read "£0.0m" with NO sign and a neutral direction - never blank, and
  // never "+£0.0m", which would read as a rise.
  const result = calcSeasonPriceChange({ costChangeStart: 0 });
  assert.equal(result.value, 0);
  assert.equal(result.direction, 'flat');
  assert.equal(result.label, '£0.0m');
});

test('calcSeasonPriceChange treats a missing cost change as flat', () => {
  // Defensive: same zero-safe contract as transfersInEvent/transfersOutEvent
  // above it in normalisePlayer. A player object predating the field must not
  // produce NaN in the Ranker's £ ↑/↓ column.
  const result = calcSeasonPriceChange({});
  assert.equal(result.value, 0);
  assert.equal(result.direction, 'flat');
  assert.equal(result.label, '£0.0m');
});

test('calcSeasonPriceChange handles a change of a full million or more', () => {
  // Guards the tenths→millions divide against an off-by-ten: 15 is £1.5m,
  // not £15.0m and not £0.15m.
  const result = calcSeasonPriceChange({ costChangeStart: 15 });
  assert.equal(result.value, 1.5);
  assert.equal(result.direction, 'rise');
  assert.equal(result.label, '+£1.5m');
});

test('calcSeasonPriceChange keeps one decimal place for a whole-million fall', () => {
  // toFixed(1), not a bare number - "-£1.0m", never "-£1m".
  const result = calcSeasonPriceChange({ costChangeStart: -10 });
  assert.equal(result.value, -1);
  assert.equal(result.direction, 'fall');
  assert.equal(result.label, '-£1.0m');
});

// ─── calcSellPrice (decision engine Phase 1) ─────────────────────────────────
// All prices in TENTHS of a million: 50 = £5.0m. FPL keeps half of any rise,
// rounded down to £0.1m, and passes every fall on in full.

test('calcSellPrice keeps nothing of a single £0.1m rise', () => {
  assert.equal(calcSellPrice(50, 51), 50);
});

test('calcSellPrice keeps £0.1m of a £0.2m rise', () => {
  assert.equal(calcSellPrice(50, 52), 51);
});

test('calcSellPrice rounds half of a £0.3m rise down to £0.1m', () => {
  assert.equal(calcSellPrice(50, 53), 51);
});

test('calcSellPrice passes a fall on in full', () => {
  assert.equal(calcSellPrice(50, 48), 48);
});

test('calcSellPrice sells at the purchase price when the price has not moved', () => {
  assert.equal(calcSellPrice(50, 50), 50);
});

test('calcSellPrice rejects prices in millions instead of tenths', () => {
  // A caller passing 5.0 / 5.3 would otherwise get a silently wrong sell price
  // on the one path where money is at stake.
  assert.throws(() => calcSellPrice(5.0, 5.3), TypeError);
});
