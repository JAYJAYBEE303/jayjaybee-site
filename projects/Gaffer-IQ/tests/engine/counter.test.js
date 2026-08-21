/**
 * tests/engine/counter.test.js
 * Unit tests for engine/counter.js. Pure-function tests only — plain object
 * inputs, no DOM, no network (CONVENTIONS.md §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoleSignature } from '../../js/engine/counter.js';

// Real 2025 Understat records, used so the fixtures can't drift from the
// schema the proxy actually returns.
const SALIBA = {
  player_name: 'William Saliba', time: '2609', xG: '1.58', xA: '1.31',
  npxG: '1.58', xGChain: '11.02', xGBuildup: '10.50',
};
const SAKA = {
  player_name: 'Bukayo Saka', time: '2239', xG: '8.70', xA: '8.55',
  npxG: '8.70', xGChain: '19.11', xGBuildup: '8.04',
};

test('buildRoleSignature computes buildupShare as xGBuildup / xGChain', () => {
  const sig = buildRoleSignature(SALIBA);
  assert.ok(Math.abs(sig.buildupShare - 0.9528) < 0.001);
});

test('buildRoleSignature computes createBias as xA90 / (xA90 + npxG90)', () => {
  const sig = buildRoleSignature(SAKA);
  // xA90 = 8.55 / (2239/90) = 0.3437; npxG90 = 8.70 / (2239/90) = 0.3497
  assert.ok(Math.abs(sig.createBias - 0.4957) < 0.001);
});

test('buildRoleSignature returns per-90 rates, not season totals', () => {
  const sig = buildRoleSignature(SAKA);
  assert.ok(Math.abs(sig.chain90 - 0.7682) < 0.001);
  assert.ok(Math.abs(sig.npxg90 - 0.3497) < 0.001);
});

test('buildRoleSignature returns null for a player with no chain involvement', () => {
  assert.equal(buildRoleSignature({ time: '900', xGChain: '0', xGBuildup: '0', xA: '0', npxG: '0' }), null);
});

test('buildRoleSignature returns null for zero minutes', () => {
  assert.equal(buildRoleSignature({ time: '0', xGChain: '5', xGBuildup: '3', xA: '1', npxG: '1' }), null);
});

test('buildRoleSignature returns null for a missing record', () => {
  assert.equal(buildRoleSignature(null), null);
});

test('buildRoleSignature gives createBias 0.5 when a player has neither xA nor npxG', () => {
  // MODEL guard: a pure build-up player has no final action to bias either way.
  const sig = buildRoleSignature({ time: '900', xGChain: '4', xGBuildup: '4', xA: '0', npxG: '0' });
  assert.equal(sig.createBias, 0.5);
});
