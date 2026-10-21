/**
 * tests/tools/backtest-sim.test.js
 * The decision backtest's season simulator (tools/backtest/lib.js, plan
 * Phase 7): FPL's free transfers, hits and sell prices, its autosubs and
 * armband on actual points, the starting squads, the baseline policy, the
 * per-move metrics and the paired bootstrap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextFreeTransfers, pickSquad, randomSquad, scoreGameweek, applyMoves, simulate, simulateAll, moveMetrics, rollPolicy,
  enginePolicy, pairedBootstrap, slope, slopeInterval,
} from '../../tools/backtest/lib.js';
import { seededRandom } from '../../js/util.js';

const SLOTS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

// ─── Free transfers ──────────────────────────────────────────────────────────

test('free transfers: what is left plus one, never below one or above the cap; a top-up sets them', () => {
  assert.equal(nextFreeTransfers(1, 0, { max: 5 }), 2);
  assert.equal(nextFreeTransfers(2, 1, { max: 5 }), 2);
  assert.equal(nextFreeTransfers(1, 3, { max: 5 }), 1);   // two hits taken: still one next week
  assert.equal(nextFreeTransfers(5, 0, { max: 5 }), 5);   // the sixth is lost
  assert.equal(nextFreeTransfers(1, 1, { max: 5, topUp: 5 }), 5);
});

// ─── Starting squads ─────────────────────────────────────────────────────────

/** A pool of 6 clubs x (2 GKP, 4 DEF, 4 MID, 3 FWD), priced by index so the order is known. */
function pool() {
  const players = [];
  let id = 1;
  for (const teamId of [1, 2, 3, 4, 5, 6]) {
    for (const [position, n] of [['GKP', 2], ['DEF', 4], ['MID', 4], ['FWD', 3]]) {
      for (let k = 0; k < n; k++) players.push({ id: id++, position, teamId, priceTenths: 40 + (k * 10) + teamId });
    }
  }
  return players;
}

const valid = (ids, players, budget) => {
  const byId = new Map(players.map(p => [p.id, p]));
  const chosen = ids.map(id => byId.get(id));
  const count = key => chosen.reduce((m, p) => m.set(p[key], (m.get(p[key]) ?? 0) + 1), new Map());
  return ids.length === 15 && new Set(ids).size === 15
    && Object.entries(SLOTS).every(([pos, n]) => count('position').get(pos) === n)
    && [...count('teamId').values()].every(n => n <= 3)
    && chosen.reduce((a, p) => a + p.priceTenths, 0) <= budget;
};

test('pickSquad walks its order, keeping 2/5/5/3, three a club and enough money to fill every slot left', () => {
  const players = pool();
  // Dearest first: it must stop buying dear players while cheap ones are still needed.
  const order = [...players].sort((a, b) => b.priceTenths - a.priceTenths);
  const squad = pickSquad(order, { budgetTenths: 900, maxPerClub: 3, slots: SLOTS });
  assert.ok(valid(squad.ids, players, 900), JSON.stringify(squad));
  assert.equal(squad.costTenths, squad.ids.reduce((a, id) => a + players.find(p => p.id === id).priceTenths, 0));
  // The first player in the order is always taken.
  assert.equal(squad.ids[0], order[0].id);
  assert.equal(pickSquad(order, { budgetTenths: 500, maxPerClub: 3, slots: SLOTS }), null);
});

test('randomSquad draws different legal squads that spend at least the floor, the same ones for a seed', () => {
  const players = pool();
  const opts = { budgetTenths: 900, minSpendTenths: 860, maxPerClub: 3, slots: SLOTS };
  const a = randomSquad(players, seededRandom(1), opts);
  const b = randomSquad(players, seededRandom(2), opts);
  assert.ok(valid(a.ids, players, 900) && valid(b.ids, players, 900));
  assert.ok(a.costTenths >= 860 && b.costTenths >= 860);
  assert.notDeepEqual([...a.ids].sort(), [...b.ids].sort());
  assert.deepEqual(randomSquad(players, seededRandom(1), opts), a);
});

// ─── A gameweek on actual points ─────────────────────────────────────────────

// Keeper 1; defenders 2-4; midfielders 5-8; forwards 9-11. Bench: 12 (DEF), 13 (MID), 14 (FWD), keeper 15.
const POSITION = new Map([[1, 'GKP'], [2, 'DEF'], [3, 'DEF'], [4, 'DEF'], [5, 'MID'], [6, 'MID'], [7, 'MID'], [8, 'MID'],
  [9, 'FWD'], [10, 'FWD'], [11, 'FWD'], [12, 'DEF'], [13, 'MID'], [14, 'FWD'], [15, 'GKP']]);
const LINEUP = { xi: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], bench: [12, 13, 14, 15], captainId: 9, viceId: 5 };
const played = (overrides = {}) => id => overrides[id] ?? { points: 2, minutes: 90 };

test('a full XI scores its points and the captain twice', () => {
  assert.equal(scoreGameweek(LINEUP, POSITION, played({ 9: { points: 10, minutes: 90 } })).points, (10 * 2) + 20);
});

test('autosubs: the first bench player who played and keeps the formation legal; the keeper only for the keeper', () => {
  const none = { points: 0, minutes: 0 };
  // Defender 2 out: 3 DEF would drop to 2, so the bench defender comes on, not the midfielder.
  let r = scoreGameweek({ ...LINEUP, bench: [13, 12, 14, 15] }, POSITION, played({ 2: none, 12: { points: 6, minutes: 90 } }));
  assert.deepEqual([r.points, r.xi.includes(12), r.xi.includes(13)], [(10 * 2) + 6 + 2, true, false]);
  // Midfielder 5 out: bench 12 (a defender) keeps it legal and comes first.
  r = scoreGameweek(LINEUP, POSITION, played({ 5: none, 12: { points: 1, minutes: 30 } }));
  assert.deepEqual([r.points, r.xi.includes(12)], [(10 * 2) + 1 + 2, true]);
  // A bench player who did not play is passed over; each comes on once.
  r = scoreGameweek(LINEUP, POSITION, played({ 5: none, 6: none, 12: none }));
  assert.deepEqual([r.points, r.xi.includes(13), r.xi.includes(14)], [(11 * 2) + 2, true, true]);
  // The keeper out: only the reserve keeper covers him.
  r = scoreGameweek(LINEUP, POSITION, played({ 1: none, 15: { points: 3, minutes: 90 } }));
  assert.equal(r.points, (10 * 2) + 3 + 2);
  r = scoreGameweek(LINEUP, POSITION, played({ 1: none, 15: none }));
  assert.deepEqual([r.points, r.xi.includes(1)], [(10 * 2) + 2, true]);
  // ... and never an outfield player, even when he is the only bench player who played.
  r = scoreGameweek(LINEUP, POSITION, played({ 5: none, 12: none, 13: none, 14: none, 15: { points: 3, minutes: 90 } }));
  assert.deepEqual([r.points, r.xi.includes(15)], [(10 * 2) + 2, false]);
});

test('the vice takes the armband only when the captain did not play, and only if he did', () => {
  const none = { points: 0, minutes: 0 };
  let r = scoreGameweek(LINEUP, POSITION, played({ 9: none, 5: { points: 7, minutes: 90 } }));
  // 9 out, bench defender 12 on for him (four at the back is legal); the vice's 7 doubled.
  assert.equal(r.points, (9 * 2) + 7 + 2 + 7);
  r = scoreGameweek(LINEUP, POSITION, played({ 9: none, 5: none }));
  assert.deepEqual([r.points, r.captainId], [(11 * 2), null]);
  // A captain who played and blanked keeps the armband.
  r = scoreGameweek(LINEUP, POSITION, played({ 9: { points: 1, minutes: 5 }, 5: { points: 9, minutes: 90 } }));
  assert.equal(r.points, (9 * 2) + 9 + 1 + 1);
});

// ─── Moves on a state ────────────────────────────────────────────────────────

function smallWorld() {
  // Club 1 has three in the squad below (1, 5, 6); prices by gameweek.
  const players = new Map([
    [1, { id: 1, position: 'MID', teamId: 1 }], [2, { id: 2, position: 'MID', teamId: 2 }],
    [3, { id: 3, position: 'MID', teamId: 3 }], [5, { id: 5, position: 'DEF', teamId: 1 }],
    [6, { id: 6, position: 'DEF', teamId: 1 }], [7, { id: 7, position: 'DEF', teamId: 4 }],
    [8, { id: 8, position: 'MID', teamId: 1 }],
  ]);
  const prices = { 1: [60, 63], 2: [50, 50], 3: [80, 80], 5: [45, 45], 6: [45, 45], 7: [40, 40], 8: [50, 50] };
  return {
    player: id => players.get(id),
    priceTenths: (id, t) => prices[id][t - 1],
  };
}

test('applyMoves sells at the sell price, buys at the price, and records what each was bought for', () => {
  const world = smallWorld();
  const state = { squad: [{ id: 1, purchaseTenths: 60 }, { id: 5, purchaseTenths: 45 }, { id: 6, purchaseTenths: 45 },
    { id: 2, purchaseTenths: 50 }], bankTenths: 5 };
  // Bought at 6.0, now 6.3: sells for 6.1.
  const next = applyMoves(state, [{ outId: 6, inId: 7 }, { outId: 1, inId: 8 }], world, 2);
  assert.deepEqual(next.squad.map(p => [p.id, p.purchaseTenths]), [[8, 50], [5, 45], [7, 40], [2, 50]]);
  assert.equal(next.bankTenths, 5 + (45 - 40) + (61 - 50));
  assert.equal(state.squad[0].id, 1, 'the old state is left alone');
  assert.throws(() => applyMoves(state, [{ outId: 1, inId: 3 }], world, 2), /budget/);
  assert.throws(() => applyMoves(state, [{ outId: 5, inId: 3 }], world, 2), /position/);
  // Selling the club-2 midfielder for a fourth from club 1.
  assert.throws(() => applyMoves(state, [{ outId: 2, inId: 8 }], world, 2), /club-limit/);
});

// ─── The season ──────────────────────────────────────────────────────────────

/**
 * A fake world for simulate: one position, 15 interchangeable midfielders
 * (ids 1-15) plus buys 16-18, every price 5.0; each gameweek every player
 * scores his id's points (a full squad's "points" is the sum of its ids).
 */
function fakeWorld({ topUps = {} } = {}) {
  const player = id => ({ id, position: 'MID', teamId: id });
  return {
    player,
    priceTenths: () => 50,
    gwPoints: ids => ids.reduce((a, id) => a + id, 0),
    expectedPoints: ids => ids.reduce((a, id) => a + id, 0) + 1,   // a projection one point high
    ftTopUp: t => topUps[t] ?? null,
  };
}
const startState = () => ({ squad: Array.from({ length: 15 }, (_, i) => ({ id: i + 1, purchaseTenths: 50 })), bankTenths: 0, ft: 1 });

test('simulate banks free transfers, charges hits, and scores each week after its moves', () => {
  // Week 1 rolls, week 2 makes three moves (two free, one hit), week 3 rolls.
  const plan = { 2: [{ outId: 1, inId: 16 }, { outId: 2, inId: 17 }, { outId: 3, inId: 18 }] };
  const policy = { decide: ({ t }) => ({ moves: plan[t] ?? [] }) };
  const run = simulate(fakeWorld(), startState(), policy, { fromGw: 1, toGw: 3, maxBankedFt: 5, hitCost: 4 });
  assert.deepEqual(run.gws.map(g => g.ft), [1, 2, 1]);
  assert.deepEqual(run.gws.map(g => g.hits), [0, 4, 0]);
  const base = 120;   // 1 + ... + 15
  const after = base - 6 + (16 + 17 + 18);
  assert.deepEqual(run.gws.map(g => g.points), [base, after, after]);
  assert.equal(run.total, base + after - 4 + after);
  assert.deepEqual(run.gws[1].before.length, 15);
  assert.ok(run.gws[1].after.includes(18) && !run.gws[1].after.includes(3));
});

test('simulate tops up free transfers when the season does, and loses the one past the cap', () => {
  const policy = { decide: () => ({ moves: [] }) };
  const world = fakeWorld({ topUps: { 3: 5 } });
  const run = simulate(world, startState(), policy, { fromGw: 1, toGw: 8, maxBankedFt: 5, hitCost: 4 });
  assert.deepEqual(run.gws.map(g => g.ft), [1, 2, 5, 5, 5, 5, 5, 5]);
  // The last week's is not lost: the season ends.
  assert.deepEqual(run.gws.map(g => g.lostFt), [false, false, true, true, true, true, true, false]);
});

test('moveMetrics: realised and expected gain over 1, 3 and 5 GWs against keeping the squad, less hits, and sell regret', () => {
  const plan = { 2: [{ outId: 5, inId: 16 }] };
  const policy = { decide: ({ t }) => ({ moves: plan[t] ?? [] }) };
  const world = fakeWorld();
  const opts = { fromGw: 1, toGw: 4, maxBankedFt: 5, hitCost: 4 };
  const run = simulate(world, startState(), policy, opts);
  const [m] = moveMetrics(run, world, opts);
  assert.equal(m.gw, 2);
  // 16 for 5 is +11 a week; the window is cut at GW4 (3 weeks).
  assert.deepEqual([m.realised[1], m.realised[3], m.realised[5]], [11, 33, 33]);
  assert.deepEqual([m.expected[1], m.expected[3]], [11, 33]);
  // Selling player 1 for 16 would have gained 15 a week: regret 4 a week over the 3.
  assert.equal(m.sellRegret, 12);
  assert.deepEqual([m.free, m.hit], [1, 0]);
  // Selling the weakest (player 1) leaves nothing to regret.
  const best = simulate(world, startState(), { decide: ({ t }) => ({ moves: t === 2 ? [{ outId: 1, inId: 16 }] : [] }) }, opts);
  assert.equal(moveMetrics(best, world, opts)[0].sellRegret, 0);
});

// ─── The baseline ────────────────────────────────────────────────────────────

test('rollPolicy makes the best free move by its own projected points, only past the threshold, never a hit', () => {
  const projections = new Map([1, 2, 16].map(id => [id, { gws: Array.from({ length: 5 }, () => ({ xpts: id === 16 ? 3 : 2 })) }]));
  const world = {
    player: id => ({ id, position: 'MID', teamId: id, price: 5 }),
    priceTenths: () => 50,
    projections: () => projections,
    candidates: () => [16, 1, 2].map(id => ({ id, position: 'MID', teamId: id, price: 5 })),
  };
  const state = { squad: [{ id: 1, purchaseTenths: 50 }, { id: 2, purchaseTenths: 50 }], bankTenths: 0, ft: 1 };
  // 16 beats 1 or 2 by 5 points over five GWs.
  const roll = gain => rollPolicy({ gain, horizon: 5, maxBankedFt: 5 });
  assert.deepEqual(roll(4).decide({ t: 1, state, world }).moves, [{ outId: 1, inId: 16 }]);
  assert.equal(roll(6).decide({ t: 1, state, world }).moves.length, 0);
  assert.equal(roll(4).decide({ t: 1, state: { ...state, ft: 0 }, world }).moves.length, 0);
  // At the cap any gain will do: rolling would waste the free transfer.
  assert.equal(roll(6).decide({ t: 1, state: { ...state, ft: 5 }, world }).moves.length, 1);
});

test('enginePolicy makes its mode\'s root move, and Funds\' chained move after it; a roll or a wait makes none', () => {
  const result = call => ({ modes: {
    funds: { call, root: call === 'move' ? { outId: 1, inId: 16, chained: { outId: 2, inId: 17 } } : null },
    now: { call, root: call === 'move' ? { outId: 3, inId: 18, chained: null } : null },
  } });
  const seen = [];
  const policy = call => mode => enginePolicy(mode, ctx => { seen.push(ctx); return result(call); });
  const ctx = { t: 4, state: startState(), world: {} };
  assert.deepEqual(policy('move')('funds').decide(ctx).moves, [{ outId: 1, inId: 16 }, { outId: 2, inId: 17 }]);
  assert.deepEqual(policy('move')('now').decide(ctx).moves, [{ outId: 3, inId: 18 }]);
  assert.deepEqual(policy('wait')('now').decide(ctx).moves, []);
  assert.deepEqual(policy('roll')('funds').decide(ctx).moves, []);
  assert.deepEqual([seen[0].t, seen[0].state, [...seen[0].locks]], [ctx.t, ctx.state, []]);
});

test('simulateAll runs every policy a week at a time, each exactly as simulate would on its own', () => {
  const calls = [];
  const plan = { 2: [{ outId: 1, inId: 16 }] };
  const policies = {
    mover: { decide: ({ t }) => { calls.push(`mover@${t}`); return { moves: plan[t] ?? [] }; } },
    roller: { decide: ({ t }) => { calls.push(`roller@${t}`); return { moves: [] }; } },
  };
  const opts = { fromGw: 1, toGw: 3, maxBankedFt: 5, hitCost: 4 };
  const runs = simulateAll(fakeWorld(), startState(), policies, opts);
  assert.deepEqual(calls, ['mover@1', 'roller@1', 'mover@2', 'roller@2', 'mover@3', 'roller@3']);
  for (const [name, policy] of Object.entries(policies)) {
    assert.deepEqual(runs[name], simulate(fakeWorld(), startState(), policy, opts));
  }
});

/** A stub engine that sells the lowest unlocked id for the next buy while a free transfer is left, recording what it was asked. */
function greedyEngine(asked, { buys = [16, 17, 18, 19, 20, 21] } = {}) {
  return ({ state, locks }) => {
    asked.push({ ft: state.ft, locks: [...locks].sort((a, b) => a - b) });
    const owned = new Set(state.squad.map(p => p.id));
    const out = state.squad.map(p => p.id).filter(id => !locks.has(id)).sort((a, b) => a - b)[0];
    const inId = buys.find(id => !owned.has(id));
    return { modes: { now: state.ft > 0 ? { call: 'move', root: { outId: out, inId, chained: null } } : { call: 'roll', root: null } } };
  };
}

test('a multi-move engine policy asks again on the new squad, a free transfer fewer, until the engine rolls', () => {
  const asked = [];
  const policy = enginePolicy('now', greedyEngine(asked), { maxPicks: 5 });
  const moves = policy.decide({ t: 2, state: { ...startState(), ft: 2 }, world: fakeWorld() }).moves;
  assert.deepEqual(moves, [{ outId: 1, inId: 16 }, { outId: 2, inId: 17 }]);
  // Never sells what it bought this week.
  assert.deepEqual(asked, [{ ft: 2, locks: [] }, { ft: 1, locks: [16] }, { ft: 0, locks: [16, 17] }]);
  // ... and stops at maxPicks.
  const capped = enginePolicy('now', greedyEngine([]), { maxPicks: 3 });
  assert.equal(capped.decide({ t: 2, state: { ...startState(), ft: 5 }, world: fakeWorld() }).moves.length, 3);
  // Single-move (the default) asks once and passes no locks.
  const once = [];
  assert.equal(enginePolicy('now', greedyEngine(once)).decide({ t: 2, state: { ...startState(), ft: 5 }, world: fakeWorld() }).moves.length, 1);
  assert.deepEqual(once, [{ ft: 5, locks: [] }]);
});

test('the multi-move roll baseline keeps making free moves past the threshold, never selling what it bought', () => {
  const xpts = { 1: 2, 2: 2, 16: 3, 17: 2.5, 18: 2.1 };
  const projections = new Map(Object.entries(xpts).map(([id, x]) => [Number(id), { gws: Array.from({ length: 5 }, () => ({ xpts: x })) }]));
  const world = {
    player: id => ({ id, position: 'MID', teamId: id }),
    priceTenths: () => 50,
    projections: () => projections,
    candidates: () => [16, 17, 18, 1, 2].map(id => ({ id, position: 'MID', teamId: id, price: 5 })),
  };
  const state = { squad: [{ id: 1, purchaseTenths: 50 }, { id: 2, purchaseTenths: 50 }], bankTenths: 0, ft: 3 };
  const roll = rollPolicy({ gain: 2, horizon: 5, maxBankedFt: 5, maxPicks: 5 });
  // 16 for 1 (+5), then 17 for 2 (+2.5); 18 for 2 would be +0.5, under the threshold, and 16 is not sold again.
  assert.deepEqual(roll.decide({ t: 1, state, world }).moves, [{ outId: 1, inId: 16 }, { outId: 2, inId: 17 }]);
  assert.equal(roll.decide({ t: 1, state: { ...state, ft: 1 }, world }).moves.length, 1);
});

// ─── Statistics ──────────────────────────────────────────────────────────────

test('pairedBootstrap: a constant difference has a zero-width interval; the mean is over every squad and GW', () => {
  const opts = { block: 2, draws: 200, seed: 1 };
  assert.deepEqual(pairedBootstrap([[[2, 2, 2], [2, 2, 2]]], opts), { mean: 2, lo: 2, hi: 2 });
  const r = pairedBootstrap([[[1, 3, 5, 7], [0, 2, 4, 6]], [[10, 10]]], opts);
  assert.equal(r.mean, (16 + 12 + 20) / 10);
  assert.ok(r.lo < r.mean && r.mean < r.hi);
  // Squads differ but each is steady: only resampling the squads widens the interval.
  const squads = pairedBootstrap([[[1, 1, 1, 1], [3, 3, 3, 3]]], opts);
  assert.ok(squads.lo < 2 && squads.hi > 2, JSON.stringify(squads));
});

test('slope is ordinary least squares of y on x', () => {
  assert.deepEqual(slope([0, 1, 2, 3], [1, 3, 5, 7]), { slope: 2, intercept: 1 });
});

test('slopeInterval resamples the pairs: an exact line has a zero-width interval, a noisy one does not', () => {
  const opts = { draws: 200, seed: 1 };
  const exact = slopeInterval([0, 1, 2, 3, 4], [1, 3, 5, 7, 9], opts);
  assert.ok([exact.slope, exact.lo, exact.hi].every(b => Math.abs(b - 2) < 1e-9), JSON.stringify(exact));
  const noisy = slopeInterval([0, 1, 2, 3, 4, 5], [0, 2, 1, 4, 3, 5], opts);
  assert.ok(noisy.lo < noisy.slope && noisy.slope < noisy.hi);
  // No slope to find: one pair, or every x alike.
  for (const [xs, ys] of [[[1], [2]], [[3, 3, 3], [1, 2, 3]]]) {
    assert.ok(Object.values(slopeInterval(xs, ys, opts)).every(Number.isNaN));
  }
});
