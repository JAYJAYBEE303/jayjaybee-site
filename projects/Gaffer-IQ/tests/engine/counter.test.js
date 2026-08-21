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

import { classifyRoleFromSignature } from '../../js/engine/counter.js';

const sig = (buildupShare, createBias, npxg90 = 0.05) =>
  ({ buildupShare, createBias, npxg90, chain90: 0.4 });

test('classifyRoleFromSignature: deep, non-creating defender is a CB', () => {
  assert.equal(classifyRoleFromSignature('DEF', sig(0.95, 0.30)), 'CB');
});

test('classifyRoleFromSignature: shallow, creating defender is a FB', () => {
  assert.equal(classifyRoleFromSignature('DEF', sig(0.72, 0.69)), 'FB');
});

test('classifyRoleFromSignature: set-piece CB stays a CB despite low buildupShare', () => {
  // Tarkowski-shaped: shallow because of corner headers, but a finisher.
  assert.equal(classifyRoleFromSignature('DEF', sig(0.70, 0.30)), 'CB');
});

test('classifyRoleFromSignature: high-shot midfielder is a WM', () => {
  assert.equal(classifyRoleFromSignature('MID', sig(0.37, 0.50, 0.31)), 'WM');
});

test('classifyRoleFromSignature: pure build-up midfielder is a DM', () => {
  assert.equal(classifyRoleFromSignature('MID', sig(0.85, 0.55, 0.05)), 'DM');
});

test('classifyRoleFromSignature: balanced midfielder is a CM', () => {
  assert.equal(classifyRoleFromSignature('MID', sig(0.55, 0.55, 0.13)), 'CM');
});

test('classifyRoleFromSignature: WM test wins over DM for a high-shot deep mid', () => {
  // Ordering matters: shot threat is the more decisive signal.
  assert.equal(classifyRoleFromSignature('MID', sig(0.85, 0.50, 0.30)), 'WM');
});

test('classifyRoleFromSignature: deep-dropping forward is an SS', () => {
  assert.equal(classifyRoleFromSignature('FWD', sig(0.35, 0.40, 0.40)), 'SS');
});

test('classifyRoleFromSignature: penalty-box forward is an ST', () => {
  assert.equal(classifyRoleFromSignature('FWD', sig(0.21, 0.15, 0.44)), 'ST');
});

test('classifyRoleFromSignature: GKP short-circuits without needing a signature', () => {
  assert.equal(classifyRoleFromSignature('GKP', null), 'GKP');
});

test('classifyRoleFromSignature: null signature yields null for outfielders', () => {
  assert.equal(classifyRoleFromSignature('MID', null), null);
});

import { classifyRole } from '../../js/engine/counter.js';

const ictPlayer = (position, threat, influence, creativity) => ({
  id: 1, position, fullName: 'Test Player',
  ict: { threat, influence, creativity },
});

// ctx carrying one Understat record, keyed the way buildUnderstatPlayerLookup keys it.
const ctxWith = (fullName, record) => ({
  understatPlayersByName: { [fullName.toLowerCase().trim()]: record },
});

test('classifyRole prefers the chain signature over ICT when both are present', () => {
  // ICT says FB (high threat share); chain says CB (deep, finishing).
  const p = { ...ictPlayer('DEF', 60, 20, 20), fullName: 'Deep Defender' };
  const ctx = ctxWith('Deep Defender', {
    time: '2000', xGChain: '10', xGBuildup: '9.5', xA: '0.2', npxG: '1.5',
  });
  assert.equal(classifyRole(p, ctx), 'CB');
});

test('classifyRole falls back to ICT when the player is not matched by name', () => {
  const p = ictPlayer('DEF', 60, 20, 20);   // threatShare 0.60 >= 0.30 → FB
  assert.equal(classifyRole(p, ctxWith('Someone Else', { time: '2000', xGChain: '10', xGBuildup: '9', xA: '1', npxG: '1' })), 'FB');
});

test('classifyRole falls back to ICT below the minutes floor', () => {
  const p = { ...ictPlayer('DEF', 60, 20, 20), fullName: 'Fringe Defender' };
  const ctx = ctxWith('Fringe Defender', {
    time: '200', xGChain: '2', xGBuildup: '1.9', xA: '0.1', npxG: '0.1',
  });
  assert.equal(classifyRole(p, ctx), 'FB');   // ICT path, not the chain path
});

test('classifyRole falls back to ICT below the chain floor', () => {
  const p = { ...ictPlayer('DEF', 60, 20, 20), fullName: 'Quiet Defender' };
  const ctx = ctxWith('Quiet Defender', {
    time: '2000', xGChain: '0.2', xGBuildup: '0.2', xA: '0', npxG: '0',
  });
  assert.equal(classifyRole(p, ctx), 'FB');
});

test('classifyRole works with no ctx at all (pure ICT path)', () => {
  assert.equal(classifyRole(ictPlayer('DEF', 60, 20, 20)), 'FB');
  assert.equal(classifyRole(ictPlayer('DEF', 10, 70, 20)), 'CB');
});

test('classifyRole returns GKP without consulting either source', () => {
  assert.equal(classifyRole({ id: 2, position: 'GKP', ict: null }), 'GKP');
});

test('classifyRole returns null when neither chain nor ICT has signal', () => {
  assert.equal(classifyRole({ id: 3, position: 'MID', fullName: 'Ghost', ict: null }), null);
});
