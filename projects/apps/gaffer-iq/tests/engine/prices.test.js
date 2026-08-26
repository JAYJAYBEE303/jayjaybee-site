/**
 * tests/engine/prices.test.js
 * Unit tests for engine/prices.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calcSeasonPriceChange } from '../../js/engine/prices.js';

test('calcSeasonPriceChange reports a rise for a positive cost change', () => {
  // cost_change_start is in TENTHS of a million: 3 → +£0.3m.
  const result = calcSeasonPriceChange({ costChangeStart: 3 });
  assert.equal(result.value, 0.3);
  assert.equal(result.direction, 'rise');
  assert.equal(result.label, '+£0.3m');
});

test('calcSeasonPriceChange reports a fall for a negative cost change', () => {
  // The minus sign belongs to the number, not the currency symbol —
  // "-£0.1m", never "£-0.1m".
  const result = calcSeasonPriceChange({ costChangeStart: -1 });
  assert.equal(result.value, -0.1);
  assert.equal(result.direction, 'fall');
  assert.equal(result.label, '-£0.1m');
});

test('calcSeasonPriceChange reports flat for a zero cost change', () => {
  // The edge case that decides the styling: a player who has not moved must
  // read "£0.0m" with NO sign and a neutral direction — never blank, and
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
  // toFixed(1), not a bare number — "-£1.0m", never "-£1m".
  const result = calcSeasonPriceChange({ costChangeStart: -10 });
  assert.equal(result.value, -1);
  assert.equal(result.direction, 'fall');
  assert.equal(result.label, '-£1.0m');
});
