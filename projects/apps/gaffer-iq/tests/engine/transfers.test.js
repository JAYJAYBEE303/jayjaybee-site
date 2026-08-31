/**
 * tests/engine/transfers.test.js
 * Unit tests for engine/transfers.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enumerateSwaps } from '../../js/engine/transfers.js';

/**
 * A stub scoring context. enumerateSwaps calls scorePlayer, which needs a real
 * ctx, so these tests inject a scorer through opts.scorePlayerFn instead — the
 * seam that keeps this module unit-testable without a full season payload.
 */
function stubCtx() {
  return { currentGw: 10, teamsById: {}, playerSummariesById: {} };
}

function player(id, position, price, ep = 0) {
  return { id, position, price, ep, name: `P${id}`, teamId: 1, status: 'available' };
}

/**
 * Deterministic scorer. Expected points are declared on the player itself so
 * each test can state plainly who starts and who does not — deriving them from
 * the id would make the fixtures say the opposite of what the test names claim.
 */
function stubScorer(p) {
  return {
    value: 50,
    band: 'neutral',
    perGw: [],
    breakdown: { playtime: { value: 0.9 }, minutes: {}, form: {}, fixture: {}, counter: {} },
    expectedPoints: { value: p.ep ?? 0, estimated: false },
    avgPointsPerGw: { value: p.ep ?? 0, estimated: false },
    nextFixtureScore: { value: 50, estimated: false },
  };
}

/**
 * A legal 15. Given these expected points the projected XI is
 * [1, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14] and the bench is [8, 7, 15, 2] —
 * so player 8 is the weakest midfielder and sits on the bench, and player 12
 * is the squad's best player and a certain starter.
 */
function squadOf15() {
  return [
    player(1, 'GKP', 4.5, 3.0), player(2, 'GKP', 4.0, 1.0),
    player(3, 'DEF', 6.0, 5.5), player(4, 'DEF', 5.5, 5.0), player(5, 'DEF', 5.0, 4.5),
    player(6, 'DEF', 4.5, 1.5), player(7, 'DEF', 4.0, 1.0),
    player(8, 'MID', 5.0, 1.2), player(9, 'MID', 8.0, 6.0), player(10, 'MID', 7.0, 7.0),
    player(11, 'MID', 6.0, 6.5), player(12, 'MID', 12.0, 9.0),
    player(13, 'FWD', 9.0, 8.0), player(14, 'FWD', 7.0, 5.0), player(15, 'FWD', 4.5, 0.8),
  ];
}

test('enumerateSwaps only proposes same-position swaps', () => {
  const squad = squadOf15();
  const candidates = [player(100, 'MID', 7.0, 6.0), player(101, 'FWD', 7.0, 6.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  for (const swap of swaps) {
    assert.equal(swap.outPlayer.position, swap.inPlayer.position);
  }
});

test('enumerateSwaps excludes candidates that break the budget', () => {
  const squad = squadOf15();
  // 20.0m in for any midfielder in this squad breaks a 1.0m budget.
  const candidates = [player(102, 'MID', 20.0, 9.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 1.0, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  assert.equal(swaps.some(s => s.inId === 102), false);
});

test('a bench-for-bench swap scores near zero on the Now lane', () => {
  const squad = squadOf15();
  // Player 8 is the weakest midfielder and sits on the bench. Candidate 20 is
  // barely better and would also sit on the bench.
  const candidates = [player(20, 'MID', 5.0, 1.5)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const benchSwap = swaps.find(s => s.outId === 8 && s.inId === 20);
  assert.ok(benchSwap, 'the bench swap is enumerated');
  assert.ok(Math.abs(benchSwap.nearXiDelta) < 1.0,
    `bench churn must be near zero, got ${benchSwap.nearXiDelta}`);
});

test('a swap that promotes a player into the XI beats bench churn', () => {
  const squad = squadOf15();
  const candidates = [player(20, 'MID', 5.0, 1.5), player(40, 'MID', 6.0, 7.5)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const churn   = swaps.find(s => s.outId === 8 && s.inId === 20);
  const upgrade = swaps.find(s => s.outId === 8 && s.inId === 40);
  assert.ok(upgrade.nearXiDelta > churn.nearXiDelta,
    'the XI-reaching move must rank above the bench move');
});

test('enumerateSwaps flags whether the outgoing player was in the XI', () => {
  const squad = squadOf15();
  const candidates = [player(20, 'MID', 5.0, 1.5)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  const fromBench = swaps.find(s => s.outId === 8);
  const fromXi    = swaps.find(s => s.outId === 12);
  assert.equal(fromBench.flags.outInXi, false);
  assert.equal(fromXi.flags.outInXi, true);
});

test('enumerateSwaps returns an empty array for an incomplete squad', () => {
  const squad = squadOf15().slice(0, 10);
  const swaps = enumerateSwaps(squad.map(p => p.id), squad, stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    allowExtraHit: false, scorePlayerFn: stubScorer,
  });
  assert.deepEqual(swaps, []);
});
