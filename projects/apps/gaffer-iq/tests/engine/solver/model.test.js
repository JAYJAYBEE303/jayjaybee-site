/**
 * tests/engine/solver/model.test.js
 * The MILP model (js/engine/solver/model.js, plan Phase 8): a multi-week
 * transfer plan under FPL's rules - squad shape, clubs, budget at sell
 * prices, free transfers banked to the cap, hits - with each week's XI,
 * captain and bench, solved by HiGHS; and its optional parts: the values at
 * the horizon's end, the hit margin, kept players, Free Hit weeks, dead
 * slots, sale points and no-good cuts. HiGHS is the vendored build, loaded as
 * the solver worker loads it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { DECISION_ENGINE } from '../../../js/config.js';
import { buildPlan } from '../../../js/engine/solver/model.js';
import { loadVendored } from './fixtures.js';

const highs = await loadVendored();

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

function problem({ players, ft = 1, bankTenths = 0, weeks = 2, weights = Array.from({ length: weeks }, () => 1), chips = {} }) {
  return {
    gws: Array.from({ length: weeks }, (_, k) => 10 + k),
    weights,
    players: players.map(p => ({ ...p, xpts: Array.isArray(p.xpts) ? p.xpts : Array(weeks).fill(p.xpts) })),
    bankTenths, ft, maxBankedFt: 5, hitCost: 4, benchWeights: BENCH, maxPerClub: 3, squadLimits: SLOTS,
    xiMin: { GKP: 1, DEF: 3, MID: 2, FWD: 1 }, chips, lineTerms: DECISION_ENGINE.solver.lpLineTerms,
  };
}

// Both gaps zero, so a plan's objective is the optimum itself and comparing two of them holds by guarantee.
const EXACT = { mip_abs_gap: 0, mip_rel_gap: 0 };

const solve = (p, options = {}) => {
  const plan = buildPlan(p);
  const result = highs.solve(plan.lp, { output_flag: false, ...options });
  assert.equal(result.Status, 'Optimal');
  return plan.decode(result);
};

/**
 * A decoded plan's objective by FPL's rules, from its moves alone: each week's XI, captain and bench at their weights,
 * less a hit for every buy past the week's free transfers (the next week's are those unused plus one, to the cap).
 */
function fplScore(p, plan) {
  const at = (id, k) => p.players.find(q => q.id === id).xpts[k];
  const bench = [BENCH.s1, BENCH.s2, BENCH.s3, BENCH.gk];   // decode's order: the three outfield slots, then the keeper
  let ft = p.ft;
  let total = 0;
  plan.weeks.forEach((week, k) => {
    const points = week.xi.reduce((a, id) => a + at(id, k), 0) + at(week.captain, k)
      + week.bench.reduce((a, id, j) => a + bench[j] * at(id, k), 0);
    total += p.weights[k] * (points - p.hitCost * Math.max(0, week.in.length - ft));
    ft = Math.min(p.maxBankedFt, Math.max(0, ft - week.in.length) + 1);
  });
  return total;
}

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

test('the owned squad stands when nobody is better; the XI, captain and bench are picked each week', () => {
  const plan = solve(problem({ players: squad({ 13: 6, 8: 5 }) }));
  assert.deepEqual(plan.weeks.map(w => [w.in.length, w.out.length, w.hits]), [[0, 0, 0], [0, 0, 0]]);
  assert.equal(plan.weeks[0].captain, 13);
  assert.equal(plan.weeks[0].xi.length, 11);
  assert.equal(plan.weeks[0].bench.length, 4);
});

test('a clearly better buy is made with the free transfer', () => {
  const players = [...squad(), { id: 101, position: 'MID', teamId: 101, priceTenths: 50, sellTenths: 50, owned: false, xpts: 6 }];
  const [first] = solve(problem({ players })).weeks;
  assert.deepEqual(first.in, [101]);
  assert.equal(first.out.length, 1);
  assert.equal(first.hits, 0);
});

test('a second move takes a hit only when it gains more than the hit over the weeks; otherwise it waits for next week\'s free transfer', () => {
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

test('banked free transfers make several moves free; the cap is five', () => {
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

test('a buy must fit the bank plus the sale at his sell price, and three a club', () => {
  // 101 costs £6.0m: sellers fetch £5.0m and the bank holds £0.5m, so no.
  const dear = [...squad(), { id: 101, position: 'MID', teamId: 101, priceTenths: 60, sellTenths: 60, owned: false, xpts: 9 }];
  assert.deepEqual(solve(problem({ players: dear, bankTenths: 5 })).weeks[0].in, []);
  assert.deepEqual(solve(problem({ players: dear, bankTenths: 10 })).weeks[0].in, [101]);
  // Three of the squad's midfielders share club 50: a fourth from it is out.
  const crowded = squad().map(p => (p.id >= 8 && p.id <= 10 ? { ...p, teamId: 50 } : p));
  const fourth = [...crowded, { id: 101, position: 'DEF', teamId: 50, priceTenths: 50, sellTenths: 50, owned: false, xpts: 9 }];
  assert.deepEqual(solve(problem({ players: fourth })).weeks[0].in, []);
});

test('Bench Boost goes in the week the bench scores most; Triple Captain in the captain\'s best week', () => {
  // The bench (2, 7, 12, 15 on the default lineup) is strong in one week only; the captain peaks in the other.
  const chipWeeks = (bench, captain) => {
    const xpts = { 2: bench, 7: bench, 12: bench, 15: bench, 13: captain };
    const plan = solve(problem({ players: squad(xpts), chips: { benchboost: true, triplecaptain: true } }));
    return plan.weeks.map(w => [w.benchBoost, w.tripleCaptain]);
  };
  assert.deepEqual(chipWeeks([1, 6], [9, 5]), [[false, true], [true, false]]);
  assert.deepEqual(chipWeeks([6, 1], [5, 9]), [[true, false], [false, true]]);
});

test('a plan with its first week\'s moves or a chip\'s week fixed is priced against the free plan, never above it', () => {
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

test('an owned player sells at his sell price, not his price, when the bank decides a buy', () => {
  // Midfielders 8-12 were bought at £4.0m and now cost £6.0m: each sells for £5.0m. 101 costs £5.5m.
  const risen = squad().map(p => (p.id >= 8 && p.id <= 12 ? { ...p, priceTenths: 60, sellTenths: 50 } : p));
  const buy = [...risen, { id: 101, position: 'MID', teamId: 101, priceTenths: 55, sellTenths: 55, owned: false, xpts: 9 }];
  assert.deepEqual(solve(problem({ players: buy })).weeks[0].in, []);
  assert.deepEqual(solve(problem({ players: buy, bankTenths: 5 })).weeks[0].in, [101]);
});

test('the model banks free transfers only to the cap: five banked, a week without a move, then six moves take one hit', () => {
  // Five banked and this week held without a move (fixed): next week still has five, so six buys worth far more than
  // a hit take exactly one.
  const later = [101, 102, 103, 104, 105, 106].map((id, j) => ({ id, position: j < 3 ? 'DEF' : 'MID', teamId: id,
    priceTenths: 50, sellTenths: 50, owned: false, xpts: [0, 20] }));
  const held = { ...problem({ players: [...squad(), ...later], ft: 5 }), fixed: { first: { in: [], out: [] } } };
  const [first, second] = solve(held).weeks;
  assert.deepEqual([first.in.length, second.in.length, second.hits], [0, 6, 4]);
});

test('Bench Boost and Triple Captain never share a gameweek', () => {
  // Both peak in week 1: one of them has to go elsewhere.
  const xpts = { 2: [6, 1], 7: [6, 1], 12: [6, 1], 15: [6, 1], 13: [9, 5] };
  const plan = solve(problem({ players: squad(xpts), chips: { benchboost: true, triplecaptain: true } }));
  assert.ok(plan.weeks.every(w => !(w.benchBoost && w.tripleCaptain)), JSON.stringify(plan.weeks));
  assert.equal(plan.weeks.filter(w => w.benchBoost).length + plan.weeks.filter(w => w.tripleCaptain).length, 2);
});

test('a problem without lineTerms is refused, not built into a model with empty lines', () => {
  assert.throws(() => buildPlan({ ...problem({ players: squad() }), lineTerms: undefined }), /lineTerms/);
});

test('a kept player, or a Free Hit week, the problem does not hold is refused, not left to do nothing', () => {
  const p = problem({ players: squad() });
  assert.throws(() => buildPlan({ ...p, keep: [8, 99] }), /keep.*99/);
  assert.throws(() => buildPlan({ ...p, frozen: [10, 99] }), /frozen.*99/);
  assert.doesNotThrow(() => buildPlan({ ...p, keep: [8], frozen: [11] }));
});

test('rising weights are accepted', () => {
  assert.match(buildPlan(problem({ players: squad(), weights: [0.5, 1] })).lp, /^Maximize/);
});

test('rising weights: taking a hit cannot buy next week\'s free transfer', () => {
  // Three midfielders who score little now and 3 a week more than the owned ones next week. Week 0 weighs half, so a
  // hit there costs 2 and one in week 1 costs 4: a model in which a week-0 hit bought a week-1 free transfer would take
  // one for nothing and buy all three in week 1 at a cost of 2. By FPL's rule the unused free transfer carries, the
  // hit does not, and three buys in week 1 cost a hit of 4 - so two buys and a roll is best.
  const players = [...squad(), ...[101, 102, 103].map(id => ({ id, position: 'MID', teamId: id, priceTenths: 50,
    sellTenths: 50, owned: false, xpts: [0.5, 5] }))];
  const p = problem({ players, weights: [0.5, 1] });
  const free = solve(p, EXACT);
  // The free plan and every first week the exploit could take - standing, then one, two and three buys, a hit from the
  // second - score what FPL's rules give their moves, and none beats the free plan.
  const firsts = [[], [101], [101, 102], [101, 102, 103]].map(ins => ({ in: ins, out: [8, 9, 10].slice(0, ins.length) }));
  for (const plan of [free, ...firsts.map(first => solve({ ...p, fixed: { first } }, EXACT))]) {
    const [first, second] = plan.weeks;
    assert.equal(first.hits, Math.max(0, first.in.length - p.ft) * p.hitCost);
    assert.equal(second.ft, Math.min(p.maxBankedFt, Math.max(0, p.ft - first.in.length) + 1));
    assert.ok(Math.abs(plan.objective - fplScore(p, plan)) < 1e-6, `${plan.objective} v ${fplScore(p, plan)}`);
    assert.ok(plan.objective <= free.objective + 1e-6);
  }
});

test('next week\'s free transfers are exact: unused ones carry, to the cap', () => {
  const nextFt = (ft, players = squad()) => solve(problem({ players, ft })).weeks[1].ft;
  assert.equal(nextFt(3), 4);
  assert.equal(nextFt(5), 5);
  // Two free transfers and three buys worth far more than a hit: one hit, and next week starts again from one.
  const buys = [...squad(), ...[101, 102, 103].map(id => ({ id, position: 'MID', teamId: id, priceTenths: 50, sellTenths: 50,
    owned: false, xpts: 9 }))];
  const [first, second] = solve(problem({ players: buys, ft: 2 })).weeks;
  assert.deepEqual([first.in.length, first.hits, second.ft], [3, 4, 1]);
});

// ─── The optional parts ──────────────────────────────────────────────────────

/**
 * The owned 15 with the midfielders 8-12 in the XI at 2 each, 13 captain on 6, and the keeper 2, defenders 6-7 and
 * forward 15 on the bench at 0: a midfielder bought on x (up to 6) adds x - 2 over the one he replaces, and no more.
 */
const regulars = (xpts = {}) => squad({ 2: 0, 6: 0, 7: 0, 15: 0, 13: 6, ...xpts });
const buy = (id, xpts, price = 50) => ({ id, position: 'MID', teamId: id, priceTenths: price, sellTenths: price, owned: false, xpts });
const END = { 2: 1.5, 3: 1.0, 4: 0.6, 5: 0.3 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} v ${b}`);

test('the free transfers left at the horizon\'s end are worth the schedule', () => {
  const one = (gain, ft = 1) => ({ ...problem({ players: [...regulars(), buy(101, 2 + gain)], weeks: 1, ft }), endFtValue: END });
  const base = solve(problem({ players: regulars(), weeks: 1 }), EXACT).objective;
  // +1.2 is less than the 1.5 the free transfer is worth banked: the plan rolls and earns it. +1.8 is more: it moves,
  // and leaves none to bank.
  const rolled = solve(one(1.2), EXACT);
  assert.deepEqual(rolled.weeks[0].in, []);
  near(rolled.objective, base + 1.5);
  const moved = solve(one(1.8), EXACT);
  assert.deepEqual(moved.weeks[0].in, [101]);
  near(moved.objective, base + 1.8);
  // Without the schedule the same +1.2 is taken.
  assert.deepEqual(solve({ ...one(1.2), endFtValue: null }, EXACT).weeks[0].in, [101]);
  // Each banked transfer is worth its place in the schedule, to the cap: three become four, five stay five.
  for (const [ft, worth] of [[3, 1.5 + 1.0 + 0.6], [5, 1.5 + 1.0 + 0.6 + 0.3]]) {
    near(solve({ ...problem({ players: regulars(), weeks: 1, ft }), endFtValue: END }, EXACT).objective, base + worth);
  }
});

/** The free transfers a plan hands on after its last week, by FPL's rule from its moves, and what the schedule makes of them. */
function endFtScore(p, plan, schedule) {
  let ft = p.ft;
  for (const week of plan.weeks) ft = Math.min(p.maxBankedFt, Math.max(0, ft - week.in.length) + 1);
  return Object.entries(schedule).filter(([count]) => Number(count) <= ft).reduce((a, [, value]) => a + value, 0);
}

test('a hit shrinks the free transfers banked at a two-week horizon\'s end', () => {
  // Two midfielders pay in the first week only (+2 each over those they replace): the first with the free transfer,
  // the second with a hit of 4. A hit buys no free transfer, so the count handed on after the second week, which
  // rolls, falls from three (worth 2.5) to two (1.5) once a move is made, and a hit does not shrink it further.
  const p = { ...problem({ players: [...regulars(), buy(101, [4, 2]), buy(102, [4, 2])] }), endFtValue: END };
  const base = solve({ ...p, fixed: { first: { in: [], out: [] } } }, EXACT).objective;
  const first = ins => solve({ ...p, fixed: { first: { in: ins, out: [8, 9].slice(0, ins.length) } } }, EXACT);
  for (const [ins, hits, change] of [[[], 0, 0], [[101], 0, 2 - 1.0], [[101, 102], 4, 4 - 4 - 1.0]]) {
    const plan = first(ins);
    assert.deepEqual([plan.weeks[0].hits, plan.weeks[1].in], [hits, []], JSON.stringify(ins));
    near(plan.objective, base + change);
    near(plan.objective, fplScore(p, plan) + endFtScore(p, plan, END));
  }
  // A hit in the second week reads the same. Three midfielders pay in it only, +6 each over three who score nothing;
  // the first week rolls, so two free transfers meet three buys and one hit, and with the count at one afterwards the
  // end is worth nothing (a single buy would end on two, worth 1.5, but gain a third as much).
  const late = { ...problem({ players: [...regulars({ 8: 0, 9: 0, 10: 0 }), ...[101, 102, 103].map(id => buy(id, [0, 6]))] }), endFtValue: END };
  const plan = solve({ ...late, fixed: { first: { in: [], out: [] } } }, EXACT);
  assert.deepEqual([plan.weeks[1].in.length, plan.weeks[1].hits, plan.weeks[1].ft], [3, 4, 2]);
  assert.equal(endFtScore(late, plan, END), 0);
  near(plan.objective, fplScore(late, plan));
});

test('money left in the bank is worth bankPerTenth', () => {
  // 101 costs £2.0m and projects 0.2 under the midfielder he replaces, who sells for £5.0m: a downgrade that frees £3.0m.
  // Five free transfers make the move itself free.
  const p = problem({ players: [...regulars(), buy(101, 1.8, 20)], weeks: 1, ft: 5 });
  const base = solve(problem({ players: regulars(), weeks: 1, ft: 5 }), EXACT).objective;
  assert.deepEqual(solve(p, EXACT).weeks[0].in, []);
  const made = solve({ ...p, bankPerTenth: 0.01 }, EXACT);
  assert.deepEqual(made.weeks[0].in, [101]);
  near(made.objective, base - 0.2 + 30 * 0.01);
});

test('a hit must also clear the margin', () => {
  // Two midfielders on 7: the first adds 5 and the armband's 1, the second 5, against a hit of 4.
  const p = problem({ players: [...regulars(), buy(101, 7), buy(102, 7)], weeks: 1 });
  const plain = solve(p, EXACT);
  assert.deepEqual([plain.weeks[0].in.length, plain.weeks[0].hits], [2, 4]);
  const wide = solve({ ...p, hitMargin: 2 }, EXACT);
  assert.deepEqual([wide.weeks[0].in.length, wide.weeks[0].hits], [1, 0]);
  // A margin the gain clears: the hit still reports at hitCost, and the objective carries the margin.
  const narrow = solve({ ...p, hitMargin: 0.5 }, EXACT);
  assert.deepEqual([narrow.weeks[0].in.length, narrow.weeks[0].hits], [2, 4]);
  near(narrow.objective, plain.objective - 0.5);
});

test('flat hits: a hit costs the same whatever its week weighs, so a light first week cannot make hits cheap', () => {
  // Two buys, each +6 a week, weights [0.25, 1]. Both now (a hit in week 0): 2 x 6 x 1.25 less the hit. One now and
  // one next week on the free transfer: 6 x 1.25 + 6. The hit pays only above 4 a week when it weighs 0.25 x 4, above 16 flat.
  const two = [...squad(), buy(101, 8), buy(102, 8)];
  const p = problem({ players: two, weights: [0.25, 1] });
  const weighted = solve(p, EXACT).weeks;
  assert.deepEqual([weighted[0].in.length, weighted[0].hits], [2, 4]);
  const flat = solve({ ...p, flatHits: true }, EXACT).weeks;
  assert.deepEqual([flat[0].in.length, flat[0].hits, flat[1].in.length, flat[1].hits], [1, 0, 1, 0]);
  // The margin is flat too, and a week that weighs nothing still charges its hit.
  const lp = buildPlan({ ...p, weights: [0, 0.25], flatHits: true, hitMargin: 2 }).lp;
  assert.ok(lp.includes('- 6 h_0') && lp.includes('- 6 h_1'), 'a hit costs hitCost + margin in every week');
});

test('flat hits off or absent leaves the LP text as it was', () => {
  const p = problem({ players: [...squad(), buy(101, 8)], weights: [0.25, 1] });
  assert.equal(buildPlan({ ...p, flatHits: false }).lp, buildPlan(p).lp);
  assert.notEqual(buildPlan({ ...p, flatHits: true }).lp, buildPlan(p).lp);
});

test('a kept player is never sold in the first week', () => {
  // Only 8's sale (£10.0m) pays for 101 (£9.0m), who adds 4 a week.
  const owned = regulars().map(q => (q.id === 8 ? { ...q, priceTenths: 100, sellTenths: 100 } : q));
  const p = problem({ players: [...owned, buy(101, 6, 90)] });
  const free = solve(p, EXACT).weeks;
  assert.deepEqual([free[0].in, free[0].out], [[101], [8]]);
  const kept = solve({ ...p, keep: [8] }, EXACT).weeks;
  assert.deepEqual([kept[0].in, kept[0].out], [[], []]);
  // The first week only: he goes the week after.
  assert.deepEqual([kept[1].in, kept[1].out], [[101], [8]]);
});

test('a Free Hit week has no transfers and leaves the free transfers as they were', () => {
  // Three midfielders who score in the second week only, which is the only one that weighs anything.
  const late = [101, 102, 103].map(id => buy(id, [0, 5]));
  const p = { ...problem({ players: [...regulars(), ...late], ft: 2, weights: [0, 1] }), frozen: [10] };
  const plan = solve(p, EXACT);
  assert.deepEqual([plan.weeks[0].in, plan.weeks[0].out, plan.weeks[0].hits], [[], [], 0]);
  assert.equal(plan.weeks[1].ft, 2);
  // Two free transfers, two buys, no hit; the third would cost a hit of 4 for 3.
  assert.deepEqual([plan.weeks[1].in.length, plan.weeks[1].hits], [2, 0]);
  // Without the Free Hit the first week, which weighs nothing, takes its hit for free and buys all three.
  const open = solve({ ...p, frozen: [] }, EXACT);
  assert.ok(open.weeks[0].in.length >= 2, JSON.stringify(open.weeks[0]));
  near(open.objective, plan.objective + 3);
});

test('a Free Hit week in the middle neither spends nor adds: the count carries across it', () => {
  // One free transfer, a Free Hit in the second of three weeks (weight 0). Three midfielders pay only in the third and
  // lose points if held earlier. Rolled, the count is 2 into the Free Hit and 2 out of it, so three buys take one hit;
  // a Free Hit that added one would make it 3, and no hit.
  const late = [101, 102, 103].map(id => buy(id, [0, 0, 6.6]));
  const p = { ...problem({ players: [...regulars(), ...late], weeks: 3, weights: [1, 0, 1] }), frozen: [11] };
  const plan = solve(p, EXACT);
  assert.deepEqual(plan.weeks.map(w => [w.in.length, w.hits, w.ft]), [[0, 0, 1], [0, 0, 2], [3, 4, 2]]);
});

test('a dead slot kept costs its penalty once', () => {
  // 8 projects 0 and is the XI's last place; 101 projects 0.8 there. One free transfer: rolling banks another, worth 1.5.
  const p = { ...problem({ players: [...regulars({ 8: 0 }), buy(101, 0.8)], weeks: 1 }), endFtValue: END };
  assert.deepEqual(solve(p, EXACT).weeks[0].in, []);
  const moved = solve({ ...p, deadSlot: { ids: [8], penalty: 1 } }, EXACT).weeks[0];
  assert.deepEqual([moved.in, moved.out], [[101], [8]]);
  // Once, not a week: over two weeks with nobody to replace him, he costs the penalty a single time.
  const stuck = problem({ players: regulars({ 8: 0 }) });
  near(solve(stuck, EXACT).objective - solve({ ...stuck, deadSlot: { ids: [8], penalty: 0.7 } }, EXACT).objective, 0.7);
});

test('a likely fall in his sell price counts toward selling now', () => {
  // 101 adds 1.3, less than the 1.5 a rolled free transfer is worth; 8's price is about to fall, worth 0.4 if he goes now.
  const p = { ...problem({ players: [...regulars(), buy(101, 3.3)], weeks: 1 }), endFtValue: END };
  assert.deepEqual(solve(p, EXACT).weeks[0].in, []);
  const sold = solve({ ...p, salePoints: { 8: 0.4 } }, EXACT);
  assert.deepEqual([sold.weeks[0].in, sold.weeks[0].out], [[101], [8]]);
  near(sold.objective, solve(problem({ players: regulars(), weeks: 1 }), EXACT).objective + 1.3 + 0.4);
});

test('an excluded first week is never chosen; the next best is', () => {
  const p = problem({ players: [...regulars(), buy(101, 5), buy(102, 4)] });
  const seen = [];
  let best = Infinity;
  for (let n = 0; n < 3; n++) {
    const plan = solve({ ...p, exclude: seen }, EXACT);
    const first = { in: plan.weeks[0].in, out: plan.weeks[0].out };
    assert.ok(!seen.some(s => JSON.stringify(s) === JSON.stringify(first)), `${JSON.stringify(first)} came back`);
    assert.ok(plan.objective <= best + 1e-6, `${plan.objective} v ${best}`);
    best = plan.objective;
    seen.push(first);
  }
  // Rolling is a first week like any other: excluded, the plan moves even when its only move is a downgrade.
  const dud = problem({ players: [...regulars(), buy(101, 1.5)] });
  assert.deepEqual(solve(dud, EXACT).weeks[0].in, []);
  assert.equal(solve({ ...dud, exclude: [{ in: [], out: [] }] }, EXACT).weeks[0].in.length, 1);
});

// The LP's sha256 for the problem below, as built by the model before any optional part existed (Task 1's
// js/engine/solver/model.js): a change to the default LP fails this test, not only a mismatch between two new builds.
const PHASE8_LP_DIGEST = 'cfaa9d65bdec9f938991a012efb9cf42cc4438895ae2ba6b71d4970cdca25d94';

test('with every new field off, the LP text is byte-identical to Task 1\'s', () => {
  // Three weeks, both chips, a risen owned player, two candidates, a fixed first week and Bench Boost week.
  const owned = squad({ 2: [1, 1, 3], 8: [3, 2, 1], 13: [6, 4, 5] }).map(q => (q.id === 9 ? { ...q, priceTenths: 60, sellTenths: 55 } : q));
  const players = [...owned, buy(101, [4, 4, 4], 60), { ...buy(102, [3, 3, 5], 45), position: 'DEF' }];
  const p = {
    ...problem({ players, ft: 2, bankTenths: 15, weeks: 3, weights: [1, 0.8, 0.64], chips: { benchboost: true, triplecaptain: true } }),
    fixed: { first: { in: [101], out: [9] }, benchboost: 11 },
  };
  const off = { endFtValue: null, bankPerTenth: 0, hitMargin: 0, keep: [], frozen: [], deadSlot: null, salePoints: {}, exclude: [] };
  const { lp } = buildPlan(p);
  assert.equal(buildPlan({ ...p, ...off }).lp, lp);
  assert.equal(createHash('sha256').update(lp).digest('hex'), PHASE8_LP_DIGEST);
});
