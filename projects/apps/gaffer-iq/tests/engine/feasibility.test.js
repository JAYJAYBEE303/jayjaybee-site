/**
 * tests/engine/feasibility.test.js
 * Unit tests for engine/feasibility.js. Pure-function tests only (CONVENTIONS §3.3).
 * Prices are integer TENTHS of a million throughout the squad state (50 = £5.0m);
 * incoming players are normalised Players, priced in millions like the rest of
 * the app.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSwap } from '../../js/engine/feasibility.js';

// A legal 2/5/5/3 squad. Club 1 already has three players (ids 1, 3, 4).
// Player 8 was bought at £5.6m and now costs £6.0m, so he sells for £5.8m.
const SQUAD = {
  bankTenths: 1,
  players: [
    { playerId: 1,  position: 'GKP', teamId: 1,  priceTenths: 45, sellPriceTenths: 45 },
    { playerId: 2,  position: 'GKP', teamId: 2,  priceTenths: 40, sellPriceTenths: 40 },
    { playerId: 3,  position: 'DEF', teamId: 1,  priceTenths: 55, sellPriceTenths: 55 },
    { playerId: 4,  position: 'DEF', teamId: 1,  priceTenths: 50, sellPriceTenths: 50 },
    { playerId: 5,  position: 'DEF', teamId: 3,  priceTenths: 45, sellPriceTenths: 45 },
    { playerId: 6,  position: 'DEF', teamId: 4,  priceTenths: 45, sellPriceTenths: 45 },
    { playerId: 7,  position: 'DEF', teamId: 5,  priceTenths: 40, sellPriceTenths: 40 },
    { playerId: 8,  position: 'MID', teamId: 6,  priceTenths: 60, sellPriceTenths: 58 },
    { playerId: 9,  position: 'MID', teamId: 7,  priceTenths: 80, sellPriceTenths: 80 },
    { playerId: 10, position: 'MID', teamId: 8,  priceTenths: 70, sellPriceTenths: 70 },
    { playerId: 11, position: 'MID', teamId: 9,  priceTenths: 55, sellPriceTenths: 55 },
    { playerId: 12, position: 'MID', teamId: 10, priceTenths: 50, sellPriceTenths: 50 },
    { playerId: 13, position: 'FWD', teamId: 11, priceTenths: 90, sellPriceTenths: 90 },
    { playerId: 14, position: 'FWD', teamId: 12, priceTenths: 75, sellPriceTenths: 75 },
    { playerId: 15, position: 'FWD', teamId: 13, priceTenths: 45, sellPriceTenths: 45 },
  ],
};

const player = (id, position, teamId, price) => ({ id, position, teamId, price });

test('checkSwap accepts a like-for-like swap the bank and sell price can fund', () => {
  assert.deepEqual(checkSwap(SQUAD, 5, player(100, 'DEF', 14, 4.6)), { ok: true });
});

test('checkSwap allows spending the bank down to the last £0.1m', () => {
  // Sell £4.5m + bank £0.1m = £4.6m: exactly enough.
  assert.equal(checkSwap(SQUAD, 6, player(101, 'DEF', 14, 4.6)).ok, true);
  assert.equal(checkSwap(SQUAD, 6, player(102, 'DEF', 14, 4.7)).reason, 'budget');
});

test('checkSwap rejects a swap affordable at current price but not at sell price', () => {
  // Current £6.0m + bank £0.1m would cover £6.0m; the real sell price £5.8m does not.
  const result = checkSwap(SQUAD, 8, player(103, 'MID', 14, 6.0));
  assert.deepEqual(result, { ok: false, reason: 'budget' });
});

test('checkSwap rejects a fourth player from one club', () => {
  const result = checkSwap(SQUAD, 5, player(104, 'DEF', 1, 4.5));
  assert.deepEqual(result, { ok: false, reason: 'club-limit' });
});

test('checkSwap allows a club\'s third player back in when the outgoing player is from that club', () => {
  assert.equal(checkSwap(SQUAD, 4, player(105, 'DEF', 1, 5.0)).ok, true);
});

test('checkSwap rejects a swap across positions', () => {
  const result = checkSwap(SQUAD, 5, player(106, 'MID', 14, 4.5));
  assert.deepEqual(result, { ok: false, reason: 'position' });
});

test('checkSwap rejects buying a player already in the squad', () => {
  const result = checkSwap(SQUAD, 5, player(6, 'DEF', 4, 4.5));
  assert.deepEqual(result, { ok: false, reason: 'already-owned' });
});

test('checkSwap rejects selling a player who is not in the squad', () => {
  const result = checkSwap(SQUAD, 999, player(107, 'DEF', 14, 4.5));
  assert.deepEqual(result, { ok: false, reason: 'not-in-squad' });
});
