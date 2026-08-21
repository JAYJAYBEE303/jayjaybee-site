/**
 * tests/engine/composite.test.js
 * Unit tests for engine/composite.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { metricMaturity } from '../../js/engine/composite.js';

test('metricMaturity is 1 for a normal, non-estimated metric', () => {
  // The five metrics that don't opt into the ramp report no maturity at all
  // and must keep their pre-2026-08-21 all-or-nothing behaviour.
  assert.equal(metricMaturity({ value: 62, estimated: false }), 1);
});

test('metricMaturity is 0 for an estimated metric', () => {
  assert.equal(metricMaturity({ value: 50, estimated: true }), 0);
});

test('metricMaturity passes a partial maturity straight through', () => {
  assert.equal(metricMaturity({ value: 62, estimated: false, maturity: 0.1 }), 0.1);
});

test('metricMaturity lets estimated override any maturity claim', () => {
  // estimated means "do not use this reading at all" — it must win.
  assert.equal(metricMaturity({ value: 62, estimated: true, maturity: 0.9 }), 0);
});

test('metricMaturity clamps a nonsense maturity into 0-1', () => {
  assert.equal(metricMaturity({ estimated: false, maturity: 4 }), 1);
  assert.equal(metricMaturity({ estimated: false, maturity: -2 }), 0);
});

test('metricMaturity is 0 for a missing metric', () => {
  assert.equal(metricMaturity(null), 0);
  assert.equal(metricMaturity(undefined), 0);
});

test('metricMaturity is 0 when maturity is not a number', () => {
  assert.equal(metricMaturity({ estimated: false, maturity: NaN }), 0);
});
