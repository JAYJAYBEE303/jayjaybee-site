/**
 * tests/tools/milp.test.js
 * The MILP referee's model (tools/milp/model.js, plan Phase 8): a multi-week
 * transfer plan under FPL's rules - squad shape, clubs, budget at sell
 * prices, free transfers banked to the cap, hits - with each week's XI,
 * captain and bench, solved by HiGHS. Skipped when tools/milp's own
 * dependency is not installed (npm install --prefix tools/milp).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan } from '../../tools/milp/model.js';

let highs = null;
try {
  highs = await (await import('../../tools/milp/node_modules/highs/build/highs.js')).default();
} catch {
  highs = null;
}
const solved = highs ? test : test.skip;

const SLOTS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const BENCH = { gk: 0.03, s1: 0.3, s2: 0.1, s3: 0.03 };

/**
 * The owned 15: keepers 1-2, defenders 3-7, midfielders 8-12, forwards 13-15,
 * each at his own club and £5.0m, projecting `xpts` (default 2) every week.
 */
function squad(xpts = {}) {
  const positions = [['GKP', 2], ['DEF', 5], ['MID', 5], ['FWD', 3]];
  const players = [];
  let id = 1;
  for (const [position, n] of positions) {
    for (let i = 0; i < n; i++, id++) {
      players.push({ id, position, teamId: id, priceTenths: 50, sellTenths: 50, owned: true, xpts: xpts[id] ?? 2 });
    }
  }
  return players;
}

function problem({ players, ft = 1, bankTenths = 0, weeks = 2, chips = {} }) {
  return {
    gws: Array.from({ length: weeks }, (_, k) => 10 + k),
    weights: Array.from({ length: weeks }, () => 1),
    players: players.map(p => ({ ...p, xpts: Array.isArray(p.xpts) ? p.xpts : Array(weeks).fill(p.xpts) })),
    bankTenths, ft, maxBankedFt: 5, hitCost: 4, benchWeights: BENCH, maxPerClub: 3, squadLimits: SLOTS,
    xiMin: { GKP: 1, DEF: 3, MID: 2, FWD: 1 }, chips,
  };
}

const solve = p => {
  const plan = buildPlan(p);
  const result = highs.solve(plan.lp, { output_flag: false });
  assert.equal(result.Status, 'Optimal');
  return plan.decode(result);
};

// ─── The model's text ────────────────────────────────────────────────────────

test('the model is an LP-format MILP over every player and week, with its rules named', () => {
  const { lp } = buildPlan(problem({ players: squad() }));
  assert.match(lp, /^Maximize/);
  for (const row of ['flow_1_0', 'shape_DEF_0', 'club_1_0', 'xi_0', 'captain_0', 'bank_0', 'hits_0', 'carry_0']) {
    assert.match(lp, new RegExp(`\\b${row}:`), row);
  }
  assert.match(lp, /\bBinaries\b/);
  assert.match(lp, /\bGenerals\b/);
  // A chip's points sit on the product of its week and the bench slot (or the armband), bound from below as well
  // as above, so a plan the solver stops early on still counts them.
  const chips = buildPlan(problem({ players: squad(), chips: { benchboost: true, triplecaptain: true } })).lp;
  for (const row of ['bbs_b1_8_0', 'bbw_b1_8_0', 'bbl_b1_8_0', 'tcc_8_0', 'tcw_8_0', 'tcl_8_0']) {
    assert.match(chips, new RegExp(`\\b${row}:`), row);
  }
});

// ─── Solved ──────────────────────────────────────────────────────────────────

solved('the owned squad stands when nobody is better; the XI, captain and bench are picked each week', () => {
  const plan = solve(problem({ players: squad({ 13: 6, 8: 5 }) }));
  assert.deepEqual(plan.weeks.map(w => [w.in.length, w.out.length, w.hits]), [[0, 0, 0], [0, 0, 0]]);
  assert.equal(plan.weeks[0].captain, 13);
  assert.equal(plan.weeks[0].xi.length, 11);
  assert.equal(plan.weeks[0].bench.length, 4);
});

solved('a clearly better buy is made with the free transfer', () => {
  const players = [...squad(), { id: 101, position: 'MID', teamId: 101, priceTenths: 50, sellTenths: 50, owned: false, xpts: 6 }];
  const [first] = solve(problem({ players })).weeks;
  assert.deepEqual(first.in, [101]);
  assert.equal(first.out.length, 1);
  assert.equal(first.hits, 0);
});

solved('a second move takes a hit only when it gains more than the hit over the weeks; otherwise it waits for next week\'s free transfer', () => {
  // Two buys, each `gain` a week over the midfielder he replaces. Hit now: 2 x gain - 4; wait a week: gain.
  const two = gain => [...squad(), ...[101, 102].map(id => ({ id, position: 'MID', teamId: id, priceTenths: 50, sellTenths: 50,
    owned: false, xpts: 2 + gain }))];
  // +5 a week: 10 - 4 beats waiting's 5, so both now.
  const big = solve(problem({ players: two(5) })).weeks;
  assert.deepEqual([big[0].in.length, big[0].hits], [2, 4]);
  // +1.5 a week: the second buy waits for next week's free transfer (3 - 4 < 1.5).
  const small = solve(problem({ players: two(1.5) })).weeks;
  assert.deepEqual([small[0].in.length, small[0].hits, small[1].in.length, small[1].hits], [1, 0, 1, 0]);
});

solved('banked free transfers make several moves free; the cap is five', () => {
  const players = [...squad(), ...[101, 102, 103].map(id => ({ id, position: 'MID', teamId: id, priceTenths: 50, sellTenths: 50,
    owned: false, xpts: 3 }))];
  const [first] = solve(problem({ players, ft: 3 })).weeks;
  assert.deepEqual([first.in.length, first.hits], [3, 0]);
  // Next week's count: those left plus one, to the cap.
  const nextFt = ft => solve(problem({ players: squad(), ft })).weeks[1].ft;
  assert.deepEqual([2, 4, 5].map(nextFt), [3, 5, 5]);
  const [, after] = solve(problem({ players: players.slice(0, 16), ft: 2 })).weeks;
  assert.equal(after.ft, 2);
});

solved('a buy must fit the bank plus the sale at his sell price, and three a club', () => {
  // 101 costs £6.0m: sellers fetch £5.0m and the bank holds £0.5m, so no.
  const dear = [...squad(), { id: 101, position: 'MID', teamId: 101, priceTenths: 60, sellTenths: 60, owned: false, xpts: 9 }];
  assert.deepEqual(solve(problem({ players: dear, bankTenths: 5 })).weeks[0].in, []);
  assert.deepEqual(solve(problem({ players: dear, bankTenths: 10 })).weeks[0].in, [101]);
  // Three of the squad's midfielders share club 50: a fourth from it is out.
  const crowded = squad().map(p => (p.id >= 8 && p.id <= 10 ? { ...p, teamId: 50 } : p));
  const fourth = [...crowded, { id: 101, position: 'DEF', teamId: 50, priceTenths: 50, sellTenths: 50, owned: false, xpts: 9 }];
  assert.deepEqual(solve(problem({ players: fourth })).weeks[0].in, []);
});

solved('Bench Boost goes in the week the bench scores most; Triple Captain in the captain\'s best week', () => {
  // The bench (2, 7, 12, 15 on the default lineup) is strong in one week only; the captain peaks in the other.
  const chipWeeks = (bench, captain) => {
    const xpts = { 2: bench, 7: bench, 12: bench, 15: bench, 13: captain };
    const plan = solve(problem({ players: squad(xpts), chips: { benchboost: true, triplecaptain: true } }));
    return plan.weeks.map(w => [w.benchBoost, w.tripleCaptain]);
  };
  assert.deepEqual(chipWeeks([1, 6], [9, 5]), [[false, true], [true, false]]);
  assert.deepEqual(chipWeeks([6, 1], [5, 9]), [[true, false], [false, true]]);
});

solved('a plan with its first week\'s moves or a chip\'s week fixed is priced against the free plan, never above it', () => {
  const players = [...squad(), { id: 101, position: 'MID', teamId: 101, priceTenths: 50, sellTenths: 50, owned: false, xpts: 6 }];
  const free = solve(problem({ players }));
  const stood = solve({ ...problem({ players }), fixed: { first: { in: [], out: [] } } });
  assert.deepEqual([stood.weeks[0].in, stood.weeks[0].out], [[], []]);
  assert.deepEqual(stood.weeks[1].in, [101], 'the buy waits a week');
  assert.ok(stood.objective < free.objective - 1, `${stood.objective} v ${free.objective}`);
  // Any midfielder is as good a sale as any other here.
  const forced = solve({ ...problem({ players }), fixed: { first: { in: [101], out: [9] } } });
  assert.deepEqual([forced.weeks[0].in, forced.weeks[0].out], [[101], [9]]);
  assert.ok(Math.abs(forced.objective - free.objective) < 1e-6);

  const xpts = { 2: [1, 6], 7: [1, 6], 12: [1, 6], 15: [1, 6] };
  const chips = { benchboost: true, triplecaptain: true };
  const best = solve(problem({ players: squad(xpts), chips }));
  // Best: Bench Boost in week 1 and Triple Captain on a week-2 six; Bench Boost in week 2 pushes the armband to week 1.
  assert.deepEqual(best.weeks.map(w => [w.benchBoost, w.tripleCaptain]), [[true, false], [false, true]]);
  const late = solve({ ...problem({ players: squad(xpts), chips }), fixed: { benchboost: 11 } });
  assert.deepEqual(late.weeks.map(w => w.benchBoost), [false, true]);
  assert.ok(late.objective < best.objective - 1e-6);
  const none = solve({ ...problem({ players: squad(xpts), chips }), fixed: { benchboost: null, triplecaptain: null } });
  assert.deepEqual(none.weeks.map(w => [w.benchBoost, w.tripleCaptain]), [[false, false], [false, false]]);
});

solved('an owned player sells at his sell price, not his price, when the bank decides a buy', () => {
  // Midfielders 8-12 were bought at £4.0m and now cost £6.0m: each sells for £5.0m. 101 costs £5.5m.
  const risen = squad().map(p => (p.id >= 8 && p.id <= 12 ? { ...p, priceTenths: 60, sellTenths: 50 } : p));
  const buy = [...risen, { id: 101, position: 'MID', teamId: 101, priceTenths: 55, sellTenths: 55, owned: false, xpts: 9 }];
  assert.deepEqual(solve(problem({ players: buy })).weeks[0].in, []);
  assert.deepEqual(solve(problem({ players: buy, bankTenths: 5 })).weeks[0].in, [101]);
});

solved('the model banks free transfers only to the cap: five banked, a week without a move, then six moves take one hit', () => {
  // Five banked and this week held without a move (fixed): next week still has five, so six buys worth far more than
  // a hit take exactly one.
  const later = [101, 102, 103, 104, 105, 106].map((id, j) => ({ id, position: j < 3 ? 'DEF' : 'MID', teamId: id,
    priceTenths: 50, sellTenths: 50, owned: false, xpts: [0, 20] }));
  const held = { ...problem({ players: [...squad(), ...later], ft: 5 }), fixed: { first: { in: [], out: [] } } };
  const [first, second] = solve(held).weeks;
  assert.deepEqual([first.in.length, second.in.length, second.hits], [0, 6, 4]);
});

solved('Bench Boost and Triple Captain never share a gameweek', () => {
  // Both peak in week 1: one of them has to go elsewhere.
  const xpts = { 2: [6, 1], 7: [6, 1], 12: [6, 1], 15: [6, 1], 13: [9, 5] };
  const plan = solve(problem({ players: squad(xpts), chips: { benchboost: true, triplecaptain: true } }));
  assert.ok(plan.weeks.every(w => !(w.benchBoost && w.tripleCaptain)), JSON.stringify(plan.weeks));
  assert.equal(plan.weeks.filter(w => w.benchBoost).length + plan.weeks.filter(w => w.tripleCaptain).length, 2);
});

test('weights that rise from one week to the next are refused: a hit could then buy a free transfer', () => {
  assert.throws(() => buildPlan({ ...problem({ players: squad() }), weights: [1, 2] }), /weights/);
});
