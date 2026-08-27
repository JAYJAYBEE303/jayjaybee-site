/**
 * tests/engine/composite.test.js
 * Unit tests for engine/composite.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { metricMaturity, applyDgwUplift, calcExpectedPoints } from '../../js/engine/composite.js';

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

// ─── applyDgwUplift (FEATURE_ENGINE §9) ──────────────────────────────────────

test('applyDgwUplift leaves a single-fixture gameweek untouched', () => {
  assert.equal(applyDgwUplift(30, 1), 30);
  assert.equal(applyDgwUplift(70, 1), 70);
});

test('applyDgwUplift lifts a poor double above a single poor fixture', () => {
  // The defect this exists to fix: two chances at points must never score
  // lower than one. 30 + (100-30)*0.35 = 54.5.
  assert.equal(applyDgwUplift(30, 2), 54.5);
});

test('applyDgwUplift lifts a good double toward the ceiling', () => {
  // 70 + (100-70)*0.35 = 80.5 — better than a single 70, still short of 100.
  assert.equal(applyDgwUplift(70, 2), 80.5);
});

test('applyDgwUplift cannot exceed 100', () => {
  // Asymptotic by construction: the uplift is a fraction of the REMAINING
  // headroom, so a perfect fixture stays perfect rather than overflowing the
  // band scale.
  assert.equal(applyDgwUplift(100, 2), 100);
  assert.ok(applyDgwUplift(99, 3) <= 100);
});

test('applyDgwUplift scales with a third fixture', () => {
  // (n-1) is the multiplier, so a triple gets twice a double's uplift.
  // No Premier League triple has occurred, but the arithmetic must not break.
  assert.equal(applyDgwUplift(30, 3), 79);
});

test('applyDgwUplift returns a blank gameweek value unchanged', () => {
  // fixtureCount 0 means the caller already substituted BLANK_GW_VALUE.
  // A negative (n-1) must never DROP the value further.
  assert.equal(applyDgwUplift(40, 0), 40);
});

// ─── calcExpectedPoints fixture count (FEATURE_ENGINE §10.2) ─────────────────

const EP_NEUTRAL_FIXTURE = { value: 50 };
const EP_FULL_PLAYING    = { value: 100, estimated: false };

test('calcExpectedPoints is unchanged for a single-fixture gameweek', () => {
  const r = calcExpectedPoints({ value: 5, estimated: false }, EP_NEUTRAL_FIXTURE, EP_FULL_PLAYING, 1);
  assert.equal(r.value, 5);
});

test('calcExpectedPoints nearly doubles for a double gameweek', () => {
  // 1 + 0.9*(2-1) = 1.9 — a rotation-risk haircut on a straight doubling.
  const r = calcExpectedPoints({ value: 5, estimated: false }, EP_NEUTRAL_FIXTURE, EP_FULL_PLAYING, 2);
  assert.equal(r.value, 9.5);
});

test('calcExpectedPoints is zero for a blank gameweek', () => {
  // A player whose team does not play cannot score. Before the count term this
  // returned a full projection, which is how a blank-gameweek player could be
  // picked as captain.
  const r = calcExpectedPoints({ value: 5, estimated: false }, EP_NEUTRAL_FIXTURE, EP_FULL_PLAYING, 0);
  assert.equal(r.value, 0);
});

test('calcExpectedPoints defaults to a single fixture when the count is omitted', () => {
  // The early-return path in scorePlayer has no fixture context and relies on
  // this default.
  const r = calcExpectedPoints({ value: 5, estimated: false }, EP_NEUTRAL_FIXTURE, EP_FULL_PLAYING);
  assert.equal(r.value, 5);
});

test('calcExpectedPoints never returns negative points for a nonsense count', () => {
  const r = calcExpectedPoints({ value: 5, estimated: false }, EP_NEUTRAL_FIXTURE, EP_FULL_PLAYING, -3);
  assert.equal(r.value, 0);
});
