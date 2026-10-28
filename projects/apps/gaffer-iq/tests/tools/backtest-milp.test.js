/**
 * tests/tools/backtest-milp.test.js
 * The MILP referee in the decision backtest (tools/backtest/milp.js, plan
 * Phase 8): a week's state as the model's problem, the plan's first week as
 * moves FPL accepts one at a time, and the referee as a policy. The solved
 * tests run on the vendored HiGHS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { milpProblem, orderMoves, milpPolicy, loadSolver, newCounts, solvePlan } from '../../tools/backtest/milp.js';

const solver = await loadSolver();

const SLOTS = [['GKP', 2], ['DEF', 5], ['MID', 5], ['FWD', 3]];

/**
 * A world of 15 owned players (ids 1-15, own clubs, £5.0m, 2 points a week)
 * and the `extra` players, each {id, position, teamId, price, xpts} with xpts
 * a number for every week; prices are the same every week.
 */
function world(extra = [], { owned = {} } = {}) {
  const players = new Map();
  let id = 1;
  for (const [position, n] of SLOTS) {
    for (let i = 0; i < n; i++, id++) players.set(id, { id, position, teamId: id, price: 50, xpts: 2, ...owned[id] });
  }
  for (const p of extra) players.set(p.id, p);
  const projections = new Map([...players.values()].map(p => [p.id,
    { gws: Array.from({ length: 6 }, (_, k) => ({ xpts: Array.isArray(p.xpts) ? p.xpts[k] : p.xpts })) }]));
  return {
    player: pid => players.get(pid),
    priceTenths: pid => players.get(pid).price,
    candidates: () => [...players.values()],
    projections: () => projections,
  };
}
const state = (over = {}) => ({ squad: Array.from({ length: 15 }, (_, i) => ({ id: i + 1, purchaseTenths: 50 })), bankTenths: 0,
  ft: 1, ...over });
const OPTS = { weights: [1, 1, 1], pool: { points: 2, pointsPerTenth: 1 } };

// ─── The problem ─────────────────────────────────────────────────────────────

test('the problem: the owned squad at its sell prices, the best others per position, weeks cut at the season\'s end', () => {
  // Owned 8 was bought at £5.0m and is now £5.4m: he sells for £5.2m.
  const extra = [
    { id: 101, position: 'MID', teamId: 101, price: 50, xpts: 6 },
    { id: 102, position: 'MID', teamId: 102, price: 50, xpts: 5 },
    { id: 103, position: 'MID', teamId: 103, price: 50, xpts: 1 },   // worse than each of the two above
    { id: 104, position: 'MID', teamId: 104, price: 30, xpts: 4 },   // the most points a tenth
    { id: 105, position: 'FWD', teamId: 105, price: 90, xpts: 9 },
  ];
  const w = world(extra, { owned: { 8: { price: 54 } } });
  const p = milpProblem(w, 37, state({ bankTenths: 7, ft: 2 }), OPTS);
  assert.deepEqual(p.gws, [37, 38]);
  assert.deepEqual(p.weights, [1, 1]);
  assert.deepEqual([p.bankTenths, p.ft], [7, 2]);
  const byId = new Map(p.players.map(q => [q.id, q]));
  assert.deepEqual([byId.get(8).owned, byId.get(8).sellTenths, byId.get(8).priceTenths], [true, 52, 54]);
  assert.equal(p.players.filter(q => q.owned).length, 15);
  assert.ok(byId.has(101) && byId.has(102) && byId.has(104) && byId.has(105));
  assert.ok(!byId.has(103), 'the third-best midfielder is not in a pool of two (and one by points a tenth)');
  assert.deepEqual(byId.get(101).xpts, [6, 6]);
});

// ─── The first week's moves, in an order FPL accepts ─────────────────────────

test('the first week\'s moves pair each sale with a buy of his position, in an order that keeps the bank and the clubs legal', () => {
  // Selling 8 (£5.0m) for 101 (£6.0m) needs the money that selling 9 for 102 (£4.0m) frees: that one first.
  const extra = [
    { id: 101, position: 'MID', teamId: 101, price: 60, xpts: 3 },
    { id: 102, position: 'MID', teamId: 102, price: 40, xpts: 3 },
    { id: 103, position: 'FWD', teamId: 103, price: 50, xpts: 3 },
  ];
  const w = world(extra);
  const moves = orderMoves(state(), [101, 102, 103], [8, 9, 13], w, 10);
  assert.equal(moves.length, 3);
  const position = id => w.player(id).position;
  assert.ok(moves.every(m => position(m.outId) === position(m.inId)));
  assert.ok(moves.findIndex(m => m.inId === 102) < moves.findIndex(m => m.inId === 101));
  assert.deepEqual(orderMoves(state(), [], [], w, 10), []);
  // Three of the squad's midfielders share club 50: a forward from it waits for one of them to go.
  const crowded = world([{ id: 102, position: 'FWD', teamId: 50, price: 50, xpts: 3 },
    { id: 103, position: 'MID', teamId: 103, price: 50, xpts: 3 }], { owned: { 8: { teamId: 50 }, 9: { teamId: 50 }, 10: { teamId: 50 } } });
  assert.deepEqual(orderMoves(state(), [102, 103], [13, 9], crowded, 10), [{ outId: 9, inId: 103 }, { outId: 13, inId: 102 }]);
});

test('moves left without a legal order are left out, the legal ones made', () => {
  // 101 costs £7.0m; no sale frees enough.
  const w = world([{ id: 101, position: 'MID', teamId: 101, price: 70, xpts: 3 },
    { id: 102, position: 'FWD', teamId: 102, price: 50, xpts: 3 }]);
  assert.deepEqual(orderMoves(state(), [101, 102], [8, 13], w, 10), [{ outId: 13, inId: 102 }]);
});

// ─── A solve ─────────────────────────────────────────────────────────────────

test('a solve stopped before it has any plan is tried again for longer; a second miss throws; a stop with a plan is flagged', () => {
  const none = { Status: 'Time limit reached', ObjectiveValue: Infinity, Columns: {} };
  const found = status => ({ Status: status, ObjectiveValue: 5, Columns: {} });
  const fake = results => {
    const calls = [];
    return { calls, options: { time_limit: 5 }, solve: (lp, extra = {}) => { calls.push(extra); return results.shift(); } };
  };
  const problem = milpProblem(world(), 10, state(), OPTS);
  const counts = newCounts();
  const retried = fake([none, found('Optimal')]);
  const plan = solvePlan(retried, problem, counts);
  assert.deepEqual([plan.objective, plan.stopped, retried.calls[1].time_limit > 5], [5, false, true]);
  assert.throws(() => solvePlan(fake([none, none]), problem, counts), /no plan/);
  assert.equal(solvePlan(fake([found('Time limit reached')]), problem, counts).stopped, true);
  assert.equal(counts.stopped, 1);
});

// ─── The referee as a policy ─────────────────────────────────────────────────

test('the referee makes its plan\'s first week: a clearly better buy now, nothing when nobody is better', () => {
  const policy = milpPolicy(solver, OPTS);
  const better = world([{ id: 101, position: 'MID', teamId: 101, price: 50, xpts: 6 }]);
  const { moves } = policy.decide({ t: 10, state: state(), world: better });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].inId, 101);
  assert.equal(better.player(moves[0].outId).position, 'MID');
  assert.deepEqual(policy.decide({ t: 10, state: state(), world: world() }).moves, []);
  assert.equal(policy.counts.solves, 2);
});

test('the referee waits for a free transfer it will have next week when the hit is not worth it', () => {
  // Two buys, each a point worse this week and 1.5 better after: both next week on its two free transfers,
  // none now (a hit now, or a point lost now for a free move a week early).
  const policy = milpPolicy(solver, OPTS);
  const later = world([101, 102].map(id => ({ id, position: 'MID', teamId: id, price: 50, xpts: [1, 3.5, 3.5, 3.5] })));
  assert.deepEqual(policy.decide({ t: 10, state: state(), world: later }).moves, []);
});
