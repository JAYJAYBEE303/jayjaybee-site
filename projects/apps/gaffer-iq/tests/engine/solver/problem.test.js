/**
 * tests/engine/solver/problem.test.js
 * A mode's solver problem from the decision engine's input and result
 * (js/engine/solver/problem.js; docs/decision-engine-solver-plan.md §2): each
 * mode as a setting - its weights and horizon, the players it keeps, the
 * Free Hit weeks it freezes, who it may buy, what its horizon's end is worth -
 * and that setting as the model's input. The engine inputs are the decision
 * tests' hand-built ones; the solved tests run on the vendored HiGHS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_ENGINE, MAX_PER_CLUB, SEASON_GWS, SQUAD_LIMITS, XI_FORMATION_MIN } from '../../../js/config.js';
import { runDecisionEngine } from '../../../js/engine/decision.js';
import { buildPlan } from '../../../js/engine/solver/model.js';
import { modeSetting, solverProblem } from '../../../js/engine/solver/problem.js';
import { GW, MODES, BASE, close, scenario, playerOf, withDraws } from '../decision-fixtures.js';
import { loadVendored } from './fixtures.js';

const highs = await loadVendored();

// The solver path is off by default; every test of it says so.
// The tests price a hit at margin 0 in every mode; the shipped per-mode margins are the backtest's choice.
const CONFIG = { ...DECISION_ENGINE, solver: { ...DECISION_ENGINE.solver, enabled: true,
  modes: Object.fromEntries(Object.keys(DECISION_ENGINE.solver.modes).map(id => [id, { hitMargin: 0 }])) } };
const withSolver = solver => ({ ...CONFIG, solver: { ...CONFIG.solver, ...solver } });
const PROTECTED_MODES = ['now', 'longterm', 'future', 'funds'];

/**
 * The engine's run on an input, a mode's setting of it, and its problem - which the model must accept: it throws on
 * a kept player or a Free Hit week the problem does not hold.
 */
function problemOf(input, modeId, config = CONFIG) {
  const result = runDecisionEngine(input, config);
  const setting = modeSetting(input, result, modeId, config);
  const p = solverProblem(input, result, setting, config);
  buildPlan(p);
  return { result, setting, p };
}
const settingOf = (input, modeId, config = CONFIG) => modeSetting(input, runDecisionEngine(input, config), modeId, config);
const idsOf = p => p.players.map(q => q.id);

// ─── Who is kept and who is bought ───────────────────────────────────────────

test('a locked player is in keep in every mode; a banned one is in no pool', () => {
  // 101 is the best buy on points, and banned.
  const input = scenario({ locks: new Set([4]), bans: new Set([101]), candidates: [
    { id: 101, position: 'MID', xip: 9 }, { id: 102, position: 'MID', xip: 6 }] });
  for (const modeId of MODES) {
    const { setting, p } = problemOf(input, modeId);
    assert.ok(setting.keep.includes(4), modeId);
    assert.ok(p.keep.includes(4), modeId);
    assert.deepEqual(setting.bans, [101], modeId);
    assert.equal(setting.buyable(101), false, modeId);
    assert.equal(setting.buyable(102), true, modeId);
    assert.ok(!idsOf(p).includes(101), `${modeId}: the banned player is in the pool`);
    assert.ok(idsOf(p).includes(102), modeId);
  }
});

test('Ceiling-protected players are kept by now, longterm, future and funds, not by ceiling or structure', () => {
  // FWD 13 is a 90% doubt in GW10, but a double in GW12, the target week, makes him worth 22 there: protected.
  const input = scenario({
    changes: [{ id: 13, xip: [9, 9, 18, 9, 9, 9], pz: [0.9, 0, 0, 0, 0, 0], fx: [1, 1, 2, 1, 1, 1] }],
    candidates: [{ id: 113, position: 'FWD', xip: 6 }],
  });
  assert.ok(playerOf(runDecisionEngine(input, CONFIG), 13).flags.includes('protected'));
  for (const modeId of MODES) {
    assert.equal(settingOf(input, modeId).keep.includes(13), PROTECTED_MODES.includes(modeId), modeId);
  }
});

test('Structure keeps its holds; no other mode does', () => {
  // DEF 5 is 50% now and back to 95% by GW12, and only he can afford DEF 116.
  const input = scenario({
    changes: [{ id: 5, price: 60, pz: [0.5, 0.15, 0.045, 0.0135, 0.004, 0.0012], av: [0.5, 0.85, 0.955, 0.9865, 0.996, 0.9988] }],
    candidates: [{ id: 116, position: 'DEF', xip: 4, price: 55 }],
  });
  const { flags } = playerOf(runDecisionEngine(input, CONFIG), 5);
  assert.ok(flags.includes('hold') && !flags.includes('protected') && !flags.includes('locked'), flags.join());
  for (const modeId of MODES) {
    assert.equal(settingOf(input, modeId).keep.includes(5), modeId === 'structure', modeId);
  }
});

test('a lock on a player not in the squad is no keep', () => {
  // The model refuses a kept player it does not hold; a stale lock must not reach it.
  const { setting, p } = problemOf(scenario({ locks: new Set([999]), candidates: [{ id: 101, position: 'MID', xip: 6 }] }), 'longterm');
  assert.deepEqual(setting.keep, []);
  assert.deepEqual(p.keep, []);
});

test('Now\'s pool leaves out a buy flagged out or over the pZero gate in the first GW', () => {
  // 106 projects 12 but plays 60% of the time; 108 is flagged out; 109 sits on the gate (0.25), which is allowed.
  const input = scenario({ candidates: [
    { id: 106, position: 'MID', xip: 12, pz: 0.4 }, { id: 107, position: 'MID', xip: 6.6 },
    { id: 108, position: 'MID', xip: 9, av: 0 }, { id: 109, position: 'MID', xip: 5, pz: 0.25 },
    // Doubtful for the planning GW only after it: the gate reads the first GW alone.
    { id: 110, position: 'MID', xip: 5, pz: [0, 0.9, 0.9, 0.9, 0.9, 0.9], av: [1, 0, 0, 0, 0, 0] }] });
  const now = problemOf(input, 'now');
  assert.deepEqual([106, 107, 108, 109, 110].map(now.setting.buyable), [false, true, false, true, true]);
  assert.deepEqual(idsOf(now.p).filter(id => id > 100).sort(), [107, 109, 110]);
  // The other modes have no gate: 106 and 108 are theirs to buy.
  const longterm = problemOf(input, 'longterm');
  assert.deepEqual([106, 108].map(longterm.setting.buyable), [true, true]);
  assert.deepEqual(idsOf(longterm.p).filter(id => id > 100).sort(), [106, 107, 108, 109, 110]);
  // The gate is the config's: widened to 1, 106 is Now's too.
  const wide = { ...CONFIG, modes: { ...CONFIG.modes, now: { ...CONFIG.modes.now, pZeroGate: 1 } } };
  assert.equal(problemOf(input, 'now', wide).setting.buyable(106), true);
});

// ─── Chips ───────────────────────────────────────────────────────────────────

test('a planned Free Hit week is frozen and weighs 0; the horizon ends before a planned Wildcard', () => {
  const candidates = [{ id: 101, position: 'MID', xip: 6 }];
  // Future prep weighs five GWs: the Free Hit week keeps its place in the horizon at weight 0, the Wildcard ends it.
  const input = scenario({ candidates, chipPlan: { [GW + 1]: 'freehit', [GW + 3]: 'wildcard' } });
  const future = problemOf(input, 'future');
  assert.deepEqual(future.setting.gws, [GW, GW + 1, GW + 2]);
  assert.deepEqual(future.setting.weights, [0.5, 0, 1]);
  assert.deepEqual(future.setting.frozen, [GW + 1]);
  assert.deepEqual([future.p.gws, future.p.weights, future.p.frozen], [[GW, GW + 1, GW + 2], [0.5, 0, 1], [GW + 1]]);
  // Long term's three GWs stop before the Wildcard too, and a Free Hit past its horizon freezes nothing.
  const wildcard = problemOf(scenario({ candidates, chipPlan: { [GW + 2]: 'wildcard', [GW + 3]: 'freehit' } }), 'longterm');
  assert.deepEqual([wildcard.setting.gws, wildcard.setting.weights, wildcard.setting.frozen], [[GW, GW + 1], [1, 1], []]);
  // Now weighs the planning GW alone; a Free Hit there leaves it nothing, and Long term a frozen first week.
  const first = scenario({ candidates, chipPlan: { [GW]: 'freehit' } });
  assert.equal(settingOf(first, 'now'), null);
  const longterm = problemOf(first, 'longterm');
  assert.deepEqual([longterm.setting.gws, longterm.setting.weights, longterm.setting.frozen], [[GW, GW + 1, GW + 2], [0, 1, 1], [GW]]);
  // A chip planned for a GW already gone is history, not a plan.
  assert.deepEqual(settingOf(scenario({ candidates, chipPlan: { [GW - 1]: 'freehit' } }), 'longterm').frozen, []);
  // The season's end cuts the horizon like a Wildcard.
  const late = settingOf(scenario({ candidates, planningGw: SEASON_GWS - 1 }), 'future');
  assert.deepEqual(late.gws, [SEASON_GWS - 1, SEASON_GWS]);
});

test('Ceiling in a big week is the engine\'s (engine-tail); a mode with every week covered by chips is null', () => {
  // A planned Bench Boost at the target GW is a big week, and every squad player has draws for the tail to read.
  const big = withDraws(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 8 }], chipPlan: { [GW]: 'benchboost' } }));
  const result = runDecisionEngine(big, CONFIG);
  assert.equal(result.modes.ceiling.bigWeek, true);
  assert.deepEqual(modeSetting(big, result, 'ceiling', CONFIG), { source: 'engine-tail' });
  for (const modeId of MODES.filter(m => m !== 'ceiling')) {
    assert.equal(result.modes[modeId].bigWeek, false, modeId);
    assert.equal(modeSetting(big, result, modeId, CONFIG).modeId, modeId);
  }
  // The same week without the chip: Ceiling reads expected points, and the solver holds it.
  const plain = withDraws(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 8 }] }));
  assert.equal(settingOf(plain, 'ceiling').modeId, 'ceiling');
  // A Wildcard in the planning GW covers every week of every mode.
  const wildcard = scenario({ candidates: [{ id: 101, position: 'FWD', xip: 8 }], chipPlan: { [GW]: 'wildcard' } });
  const covered = runDecisionEngine(wildcard, CONFIG);
  for (const modeId of MODES) assert.equal(modeSetting(wildcard, covered, modeId, CONFIG), null, modeId);
});

test('a planned Bench Boost or Triple Captain inside the horizon is placed in its week; outside it, not at all', () => {
  const candidates = [{ id: 101, position: 'MID', xip: 6 }];
  const input = scenario({ candidates, chipPlan: { [GW + 1]: 'benchboost', [GW + 3]: 'triplecaptain' } });
  // Long term's GWs hold the Bench Boost only.
  const longterm = problemOf(input, 'longterm');
  assert.deepEqual(longterm.setting.chips, { benchboost: GW + 1, triplecaptain: null });
  assert.deepEqual([longterm.p.chips, longterm.p.fixed], [{ benchboost: true }, { benchboost: GW + 1 }]);
  // Future prep's hold both.
  const future = problemOf(input, 'future');
  assert.deepEqual(future.setting.chips, { benchboost: GW + 1, triplecaptain: GW + 3 });
  assert.deepEqual([future.p.chips, future.p.fixed], [{ benchboost: true, triplecaptain: true }, { benchboost: GW + 1, triplecaptain: GW + 3 }]);
  // Now's single GW holds neither; and no chips planned is no chips.
  assert.deepEqual(problemOf(input, 'now').setting.chips, { benchboost: null, triplecaptain: null });
  const none = problemOf(scenario({ candidates }), 'future');
  assert.deepEqual([none.p.chips, none.p.fixed], [{}, {}]);
});

// ─── The pool ────────────────────────────────────────────────────────────────

test('the pool is per position, the best by weighted points and by points a tenth, plus the engine\'s own buys', () => {
  const small = withSolver({ pool: { points: 2, pointsPerTenth: 1 } });
  const input = scenario({ candidates: [
    { id: 101, position: 'MID', xip: 6 }, { id: 102, position: 'MID', xip: 5 },
    { id: 103, position: 'MID', xip: 1 },                      // worse than each of the two above
    { id: 104, position: 'MID', xip: 4, price: 30 },           // the most points a tenth
    // Forwards over Long term's three GWs: 105 24 and 121 21 points, 122 18, and 120 only 20 (all in the planning GW).
    { id: 105, position: 'FWD', xip: 8, price: 90 }, { id: 121, position: 'FWD', xip: 7 }, { id: 122, position: 'FWD', xip: 6 },
    { id: 120, position: 'FWD', xip: [20, 0, 0, 0, 0, 0] },    // Now's best buy by far
  ] });
  const { result, setting, p } = problemOf(input, 'longterm', small);
  assert.equal(result.modes.now.root.inId, 120, 'Now buys 120');
  assert.deepEqual(p.players.find(q => q.id === 101).xpts, [6, 6, 6]);
  assert.deepEqual(p.players.find(q => q.id === 120).xpts, [20, 0, 0]);
  // The pool alone, without the engine's buys (which take 104 too, as the best downgrade for Funds).
  const bare = idsOf(solverProblem(input, { ...result, modes: {} }, setting, small)).filter(id => id > 100).sort();
  // Midfielders: 101 and 102 by points, 104 by points a tenth; 103 is outside. Forwards: 105 and 121 by points, 121
  // again by points a tenth; 122 is outside, and so is 120, whom only the engine's buy brings in.
  assert.deepEqual(bare, [101, 102, 104, 105, 121]);
  assert.ok(idsOf(p).includes(120), 'the engine\'s own buy is in, whatever it ranks');
  assert.ok(!idsOf(p).includes(103) && !idsOf(p).includes(122));
});

test('a setting that turns the engine\'s buys off pools only the best of the others', () => {
  const one = withSolver({ pool: { points: 1, pointsPerTenth: 0 } });
  // Over Long term's three GWs 121 is worth 21 and 120 only 20, but 120 is Now's buy by far.
  const input = scenario({ candidates: [
    { id: 101, position: 'MID', xip: 6 }, { id: 102, position: 'MID', xip: 5 },
    { id: 121, position: 'FWD', xip: 7 }, { id: 120, position: 'FWD', xip: [20, 0, 0, 0, 0, 0] }] });
  const { result, setting, p } = problemOf(input, 'longterm', one);
  assert.equal(result.modes.now.root.inId, 120);
  assert.ok(idsOf(p).includes(120), 'the engine\'s buys are in by default');
  const bare = solverProblem(input, result, { ...setting, engineBuys: false }, one);
  assert.deepEqual(idsOf(bare).filter(id => id > 100).sort(), [101, 121]);
});

test('equal candidates rank by id, whatever order they come in', () => {
  const one = withSolver({ pool: { points: 1, pointsPerTenth: 0 } });
  for (const order of [[201, 202], [202, 201]]) {
    const input = scenario({ candidates: order.map(id => ({ id, position: 'GKP', xip: 3 })) });
    const result = runDecisionEngine(input, one);
    const p = solverProblem(input, { ...result, modes: {} }, modeSetting(input, result, 'longterm', one), one);
    assert.deepEqual(idsOf(p).filter(id => id > 100), [201], order.join());
  }
});

test('the pool leaves out an engine buy the mode cannot make, and holds no more than the config allows', () => {
  // 106 is the engine's Long term buy (it projects 12 and plays 60% of the time) and over Now's gate.
  const input = scenario({ candidates: [
    { id: 106, position: 'MID', xip: 12, pz: 0.4 }, { id: 107, position: 'MID', xip: 6.6 }] });
  const result = runDecisionEngine(input, CONFIG);
  assert.equal(result.modes.longterm.root.inId, 106);
  assert.ok(!idsOf(problemOf(input, 'now').p).includes(106), 'Now cannot buy him, so the engine\'s Long term buy is not in its pool');
  assert.ok(idsOf(problemOf(input, 'longterm').p).includes(106));

  // 600 candidates: 15 owned, and per position at most the best 20 by points and the best 10 a tenth.
  const positions = ['GKP', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD'];
  const many = scenario({ candidates: Array.from({ length: 600 }, (_, i) => ({
    id: 1000 + i, position: positions[i % positions.length], team: 1 + (i % 20), price: 40 + (i % 90), xip: 1 + ((i * 7) % 19) / 2 })) });
  const manyResult = runDecisionEngine(many, CONFIG);
  const setting = modeSetting(many, manyResult, 'future', CONFIG);
  const p = solverProblem(many, manyResult, setting, CONFIG);
  buildPlan(p);
  const { points, pointsPerTenth } = CONFIG.solver.pool;
  const includes = new Set(Object.values(manyResult.modes)
    .flatMap(m => [m.root, ...m.alternatives].filter(Boolean).flatMap(move => [move.inId, move.chained?.inId])).filter(id => id !== undefined));
  assert.ok(p.players.length <= 15 + (4 * (points + pointsPerTenth)) + includes.size, `${p.players.length} players`);
  assert.equal(new Set(idsOf(p)).size, p.players.length);
  assert.deepEqual(p.players.slice(0, 15).map(q => q.id), BASE.map(s => s.id));
  for (const position of Object.keys(SQUAD_LIMITS)) {
    const others = p.players.filter(q => !q.owned && q.position === position && !includes.has(q.id));
    assert.ok(others.length <= points + pointsPerTenth, `${position}: ${others.length}`);
  }
  // Ties rank by id, so the same input is the same problem.
  assert.deepEqual(solverProblem(many, manyResult, setting, CONFIG), p);
});

// ─── The owned squad, the bank, the horizon's end ────────────────────────────

test('the owned squad sells at the engine\'s sell prices', () => {
  // 8 was bought at £5.0m and is now £5.4m: he sells for £5.2m. 9 has no ledger entry: he sells at his price.
  const input = scenario({ changes: [{ id: 8, price: 54, purchase: 50 }, { id: 9, price: 52, purchase: null }],
    candidates: [{ id: 101, position: 'FWD', xip: 6, price: 56 }], bankTenths: 7, freeTransfers: 3 });
  const result = runDecisionEngine(input, CONFIG);
  const { p } = problemOf(input, 'longterm');
  const owned = p.players.filter(q => q.owned);
  assert.deepEqual(owned.map(q => q.id), BASE.map(s => s.id));
  for (const q of owned) assert.equal(q.sellTenths, playerOf(result, q.id).sellPriceTenths, `${q.id}`);
  const byId = new Map(p.players.map(q => [q.id, q]));
  assert.deepEqual([byId.get(8).sellTenths, byId.get(8).priceTenths], [52, 54]);
  assert.deepEqual([byId.get(9).sellTenths, byId.get(9).priceTenths], [52, 52]);
  assert.deepEqual([byId.get(3).position, byId.get(3).teamId, byId.get(3).xpts.length], ['DEF', 3, 3]);
  // The others cost their price, in tenths, and sell for it.
  assert.deepEqual([byId.get(101).owned, byId.get(101).position, byId.get(101).teamId, byId.get(101).priceTenths, byId.get(101).sellTenths],
    [false, 'FWD', 101, 56, 56]);
  assert.deepEqual([p.bankTenths, p.ft], [7, 3]);
  // The rules are the game's, not the problem's.
  assert.deepEqual([p.maxBankedFt, p.hitCost, p.maxPerClub, p.squadLimits, p.xiMin, p.benchWeights],
    [CONFIG.maxBankedFt, CONFIG.hitCost, MAX_PER_CLUB, SQUAD_LIMITS, XI_FORMATION_MIN, CONFIG.benchWeightsLinear]);
  assert.equal(p.lineTerms, CONFIG.solver.lpLineTerms);
});

test('xpts are the projections\' by GW, 0 where a GW is missing', () => {
  const input = scenario({ changes: [{ id: 13, xip: [9, 8, 7, 6, 5, 4] }], candidates: [{ id: 101, position: 'MID', xip: [1, 2, 3, 4, 5, 6] }] });
  const result = runDecisionEngine(input, CONFIG);
  const setting = modeSetting(input, result, 'longterm', CONFIG);
  const projections = new Map(input.projections);
  projections.set(101, { ...projections.get(101), gws: projections.get(101).gws.slice(0, 2) });
  const byId = new Map(solverProblem({ ...input, projections }, result, setting, CONFIG).players.map(q => [q.id, q]));
  assert.deepEqual(byId.get(13).xpts, [9, 8, 7]);
  assert.deepEqual(byId.get(101).xpts, [1, 2, 0]);
});

test('bank value is the mode\'s lambda per £1m; the free transfers left are the schedule', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'MID', xip: 6 }] });
  // Every mode carries its own lambda, as the engine carries it in FundsTerm; Funds has none of its own and reads the
  // default; Now's and Ceiling's is 0.
  const lambdas = { now: 0, longterm: 0.3, future: 0.6375, funds: 0.1, ceiling: 0, structure: 0.1 };
  for (const modeId of MODES) {
    const { setting, p } = problemOf(input, modeId);
    close(setting.bankPerTenth, lambdas[modeId] / 10, modeId);
    close(p.bankPerTenth, lambdas[modeId] / 10, modeId);
    assert.deepEqual(setting.endFtValue, { 2: 1.5, 3: 1.0, 4: 0.6, 5: 0.3 }, modeId);
    assert.deepEqual(p.endFtValue, setting.endFtValue, modeId);
    assert.equal(setting.hitMargin, 0, modeId);
  }
  // Flat: every place a free transfer can be banked in is worth the same.
  const flat = { ...CONFIG, ftValueMode: 'flat', ftValueFlat: 1.75 };
  assert.deepEqual(settingOf(input, 'longterm', flat).endFtValue, { 2: 1.75, 3: 1.75, 4: 1.75, 5: 1.75 });
  // The margin on a hit is the solver config's, by mode.
  const margin = withSolver({ modes: { ...CONFIG.solver.modes, longterm: { hitMargin: 2 } } });
  const wide = problemOf(input, 'longterm', margin);
  assert.deepEqual([wide.setting.hitMargin, wide.p.hitMargin], [2, 2]);
  assert.equal(problemOf(input, 'future', margin).p.hitMargin, 0);
});

test('a likely fall in the sell price is points for selling now: lambda a £1m, per mode', () => {
  // Bought at £5.0m, now £5.2m: he sells for £5.1m, and for £5.0m after a fall. The rising one gains £0.1m.
  const input = scenario({ changes: [{ id: 1, price: 52, purchase: 50 }, { id: 2, price: 53, purchase: 50 }],
    candidates: [{ id: 101, position: 'GKP', xip: 6 }], priceSignals: { 1: { fall: 1, rise: 0, source: 'fpl' }, 2: { fall: 0, rise: 1, source: 'fpl' } } });
  assert.deepEqual([1, 2].map(id => playerOf(runDecisionEngine(input, CONFIG), id).saleTenths), [-1, 1]);
  const longterm = problemOf(input, 'longterm');
  close(longterm.setting.salePoints[1], 0.3 / 10);
  close(longterm.setting.salePoints[2], -0.3 / 10);
  assert.deepEqual(longterm.p.salePoints, longterm.setting.salePoints);
  assert.deepEqual(Object.keys(longterm.p.salePoints).sort(), ['1', '2']);
  // Now puts no value on money, and nobody else's price is expected to move.
  assert.deepEqual(problemOf(input, 'now').p.salePoints, {});
});

test('the money terms follow the engine\'s share: the weight no planned chip covers, as a fraction of the mode\'s', () => {
  // A fall in 1's sell price, and DEF 4 a dead slot. A Wildcard three GWs on covers the last two of a mode's five GWs.
  const base = {
    changes: [{ id: 1, price: 52, purchase: 50 },
      { id: 4, pz: [1, 0.6, 0.36, 0.216, 0.1296, 0.07776], av: [0, 0.4, 0.64, 0.784, 0.8704, 0.92224] }],
    candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 115, position: 'DEF', xip: 4 }],
    priceSignals: { 1: { fall: 1, rise: 0, source: 'fpl' } },
  };
  const plain = scenario(base);
  const wildcard = scenario({ ...base, chipPlan: { [GW + 3]: 'wildcard' } });
  // The first three of each mode's weights over all five (Long term's last two weigh nothing, so its share is whole).
  const funds = k => 0.85 ** k;
  const shares = {
    longterm: 1,
    future: (0.5 + 0.75 + 1) / (0.5 + 0.75 + 1 + 1 + 1),
    funds: (funds(0) + funds(1) + funds(2)) / (funds(0) + funds(1) + funds(2) + funds(3) + funds(4)),
    structure: (1 + 0.85 + 0.72) / (1 + 0.85 + 0.72 + 0.61 + 0.52),
  };
  for (const [modeId, share] of Object.entries(shares)) {
    const [whole, cut] = [settingOf(plain, modeId), settingOf(wildcard, modeId)];
    assert.ok(whole.bankPerTenth > 0 && Object.keys(whole.salePoints).length > 0, `${modeId}: the terms to scale`);
    close(cut.bankPerTenth, whole.bankPerTenth * share, `${modeId} bank`);
    for (const [id, points] of Object.entries(whole.salePoints)) close(cut.salePoints[id], points * share, `${modeId} sale ${id}`);
    assert.deepEqual(Object.keys(cut.salePoints), Object.keys(whole.salePoints), modeId);
    if (modeId === 'structure') close(cut.deadSlot.penalty, whole.deadSlot.penalty * share, 'dead slot');
    else assert.equal(cut.deadSlot, null, modeId);
    if (modeId === 'longterm') assert.deepEqual([cut.bankPerTenth, cut.salePoints], [whole.bankPerTenth, whole.salePoints]);
    else assert.ok(share < 1, modeId);
  }
  // The problem carries the scaled terms, and the whole penalty where no chip covers a week.
  assert.equal(problemOf(plain, 'structure').p.deadSlot.penalty, CONFIG.modes.structure.deadSlotPenalty);
  close(problemOf(wildcard, 'structure').p.deadSlot.penalty, CONFIG.modes.structure.deadSlotPenalty * shares.structure);
});

test('Structure\'s dead slots cost the penalty once; no other mode has any', () => {
  // DEF 4 is out now and slow to return: 2.3 GWs missed of five. Candidate 115 is a dead slot too; 116 is fit.
  const input = scenario({
    changes: [{ id: 4, pz: [1, 0.6, 0.36, 0.216, 0.1296, 0.07776], av: [0, 0.4, 0.64, 0.784, 0.8704, 0.92224] }],
    candidates: [{ id: 115, position: 'DEF', xip: 4, av: [0, 0, 0.5, 1, 1, 1] }, { id: 116, position: 'DEF', xip: 4 }],
  });
  const { setting, p } = problemOf(input, 'structure');
  assert.equal(setting.deadSlot.penalty, CONFIG.modes.structure.deadSlotPenalty);
  assert.deepEqual([3, 4, 115, 116].map(setting.deadSlot.isDead), [false, true, true, false]);
  assert.deepEqual(p.deadSlot, { ids: [4, 115], penalty: CONFIG.modes.structure.deadSlotPenalty });
  for (const modeId of MODES.filter(m => m !== 'structure')) {
    const other = problemOf(input, modeId);
    assert.equal(other.setting.deadSlot, null, modeId);
    assert.equal(other.p.deadSlot, null, modeId);
  }
});

// ─── The plan the problem gives ──────────────────────────────────────────────

const EXACT = { mip_abs_gap: 0, mip_rel_gap: 0 };
const solve = p => {
  const plan = buildPlan(p);
  const result = highs.solve(plan.lp, { output_flag: false, ...EXACT });
  assert.equal(result.Status, 'Optimal');
  return plan.decode(result);
};

test('a locked or protected player is never in the first week\'s sales', () => {
  // Forward 101 is worth 12 a week against the bench forward 15's 2.2: the plan sells 15 for him.
  const candidates = [{ id: 101, position: 'FWD', xip: 12 }];
  assert.deepEqual(solve(problemOf(scenario({ candidates }), 'longterm').p).weeks[0].out, [15]);
  // Locked, he stays, and another forward goes.
  const locked = solve(problemOf(scenario({ candidates, locks: new Set([15]) }), 'longterm').p).weeks[0];
  assert.deepEqual([locked.in, locked.out.includes(15)], [[101], false]);

  // FWD 13 is protected: a 40-point double in GW12, the target week, against the 6 that 113 projects there. Every
  // other week 113 is far better, so the plan would sell him for 113 (14 and 15 are locked, so a forward is all it can
  // sell) - and where he is protected, it does not.
  const input = scenario({
    changes: [{ id: 13, xip: [9, 9, 40, 9, 9, 9], pz: [0.9, 0, 0, 0, 0, 0], fx: [1, 1, 2, 1, 1, 1] }],
    candidates: [{ id: 113, position: 'FWD', xip: [30, 30, 6, 30, 30, 30] }], locks: new Set([14, 15]),
  });
  for (const modeId of PROTECTED_MODES) {
    const { p } = problemOf(input, modeId);
    assert.ok(p.keep.includes(13), modeId);
    assert.deepEqual(solve(p).weeks[0].out, [], modeId);
    assert.deepEqual(solve({ ...p, keep: p.keep.filter(id => id !== 13) }).weeks[0].out, [13], `${modeId}: sold unless kept`);
  }
});

test('a Free Hit week has no transfers and passes the free transfers on; a Wildcard ends the horizon', () => {
  // Four midfielders who pay in GW12 only. Future prep's second GW is a Free Hit (weight 0): left open, its hit and its
  // moves would cost nothing and the plan would use them.
  const late = [102, 103, 104, 105].map(id => ({ id, position: 'MID', xip: [2, 2, 12, 12, 12, 12] }));
  const input = scenario({ candidates: late, freeTransfers: 2, chipPlan: { [GW + 1]: 'freehit', [GW + 3]: 'wildcard' } });
  const { p } = problemOf(input, 'future');
  const weeks = solve(p).weeks;
  assert.deepEqual(weeks.map(w => w.gw), [GW, GW + 1, GW + 2]);
  assert.deepEqual([weeks[1].in, weeks[1].out, weeks[1].hits], [[], [], 0]);
  assert.equal(weeks[2].ft, weeks[1].ft, 'a Free Hit week neither spends nor adds');
  assert.ok(weeks[2].in.length > 0, 'the moves wait for GW12');
  // The same problem without the freeze moves in the Free Hit week, which is what the freeze is for.
  assert.ok(solve({ ...p, frozen: [] }).weeks[1].in.length > 0);
});

test('every app mode prices a hit flat, as the engine does; the reproduction setting does not', async () => {
  const input = scenario({ freeTransfers: 1 });
  for (const modeId of MODES) {
    const { setting, p } = problemOf(input, modeId);
    assert.equal(setting.flatHits, true, `${modeId}: setting`);
    assert.equal(p.flatHits, true, `${modeId}: problem`);
  }
  // Phase 8's problem, which the reproduction check holds, weights its hits: its LP does not change.
  const { REPRO } = await import('../../../tools/backtest/solver.js');
  const result = runDecisionEngine(input, CONFIG);
  const repro = REPRO.setting(input, result);
  assert.ok(!repro.flatHits);
  assert.ok(!solverProblem(input, result, repro, REPRO.config).flatHits);
});

test('a hit costs hitCost plus the margin in every mode\'s objective, whatever its week weighs', () => {
  const input = scenario({ freeTransfers: 1 });
  const margined = withSolver({ modes: Object.fromEntries(MODES.map(m => [m, { hitMargin: 1 }])) });
  for (const modeId of ['future', 'ceiling', 'funds']) {
    const { setting, p } = problemOf(input, modeId, margined);
    if (setting.source) continue;
    const cost = DECISION_ENGINE.hitCost + 1;
    const { lp } = buildPlan(p);
    const objective = lp.slice(lp.indexOf('obj:'), lp.indexOf('Subject To'));
    for (let k = 0; k < p.gws.length; k++) assert.ok(objective.includes(`- ${cost} h_${k} `) || objective.includes(`- ${cost} h_${k}\n`), `${modeId}: week ${k}`);
  }
});

test('Ceiling does not take a hit in a light first week that its own five points a week do not repay', () => {
  // Ceiling weighs t* (GW12) at 1 and the others at 0.1. Two buys that pay only a little in GW12: a hit in GW10 at a tenth of
  // its cost was cheap, and the plan took one; at a flat 4 the second buy waits for next week's free transfer.
  const input = scenario({ bankTenths: 0, freeTransfers: 1, changes: [{ id: 12, xip: 5 }, { id: 15, xip: 6 }, { id: 7, xip: 3 }], candidates: [
    { id: 211, position: 'DEF', xip: [3, 3, 4.5, 3, 3, 3] }, { id: 212, position: 'MID', xip: [5, 5, 6.5, 5, 5, 5] },
    { id: 213, position: 'FWD', xip: [6, 6, 7.5, 6, 6, 6] }, { id: 214, position: 'DEF', xip: [4, 4, 5.5, 4, 4, 4] },
    { id: 299, position: 'GKP', xip: [1, 1, 60, 1, 1, 1], price: 300 },
  ] });
  const { p } = problemOf(input, 'ceiling');
  const [first] = solve(p).weeks;
  assert.equal(first.hits, 0, 'no hit in the first week');
  assert.ok(first.in.length <= 1, 'one free transfer, one move');
  // The same problem weighted, as it was, takes the hit.
  assert.equal(solve({ ...p, flatHits: false }).weeks[0].hits, DECISION_ENGINE.hitCost);
});
