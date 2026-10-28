/**
 * tests/tools/backtest-solver.test.js
 * The reproduction check in the decision backtest (tools/backtest/solver.js,
 * solver plan Phase 3): the app's own solver modules - problem, HiGHS, plan -
 * set as Phase 8's offline planner was, as a policy. The solved tests run on
 * the vendored HiGHS, on the decision tests' hand-built scenario.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_ENGINE, SEASON_GWS } from '../../js/config.js';
import { runDecisionEngine } from '../../js/engine/decision.js';
import { solverProblem } from '../../js/engine/solver/problem.js';
import { REPRO, agrees, reproFor, solverPolicy } from '../../tools/backtest/solver.js';
import { GW, MODES, scenario } from '../engine/decision-fixtures.js';
import { loadVendored } from '../engine/solver/fixtures.js';

const highs = await loadVendored();

/** A backtest world and state around an engine input: the parts of them the policy reads. */
function backtest(input) {
  const players = [...input.squad.map(s => ({ id: s.playerId, name: s.name, position: s.position, teamId: s.teamId,
    price: s.priceTenths / 10 })), ...input.candidates];
  const s = { players, playersById: Object.fromEntries(players.map(p => [p.id, p])) };
  return {
    world: { at: () => ({ s, projections: input.projections }) },
    state: { squad: input.squad.map(p => ({ id: p.playerId, purchaseTenths: p.purchaseTenths })), bankTenths: input.bankTenths,
      ft: input.freeTransfers },
  };
}

// ─── The setting ─────────────────────────────────────────────────────────────

test('the reproduction setting: decay weights over five GWs cut at the season\'s end, and nothing the app adds', () => {
  const input = scenario({ planningGw: SEASON_GWS - 1 });
  const setting = REPRO.setting(input, runDecisionEngine(input, REPRO.config));
  const decay = Array.from({ length: 2 }, (_, k) => DECISION_ENGINE.decayBase ** k);
  assert.deepEqual([setting.gws, setting.weights], [[SEASON_GWS - 1, SEASON_GWS], decay]);
  const full = scenario();
  assert.equal(REPRO.setting(full, runDecisionEngine(full, REPRO.config)).weights.length, DECISION_ENGINE.modes.now.weights.length);
  assert.deepEqual([setting.endFtValue, setting.bankPerTenth, setting.hitMargin, setting.deadSlot], [null, 0, 0, null]);
  assert.equal(setting.engineBuys, false);
  assert.deepEqual([setting.keep, setting.frozen, setting.bans, setting.salePoints, setting.chips],
    [[], [], [], {}, { benchboost: null, triplecaptain: null }]);
  assert.equal(setting.buyable(1), true);
  assert.deepEqual(REPRO.options, { time_limit: DECISION_ENGINE.solver.timeLimitS, mip_abs_gap: DECISION_ENGINE.solver.absGap });
  assert.deepEqual(REPRO.config.solver.pool, { points: 20, pointsPerTenth: 10 });
});

test('the solve limits are the app\'s, whatever they are tuned to, and the pool stays Phase 8\'s', () => {
  const retuned = { ...DECISION_ENGINE, solver: { ...DECISION_ENGINE.solver, timeLimitS: 7, absGap: 0.25,
    pool: { points: 5, pointsPerTenth: 2 } } };
  const repro = reproFor(retuned);
  assert.deepEqual(repro.options, { time_limit: 7, mip_abs_gap: 0.25 });
  assert.deepEqual(repro.config.solver.pool, { points: 20, pointsPerTenth: 10 });
  assert.equal(repro.config.solver.timeLimitS, 7);
});

// ─── The policy ──────────────────────────────────────────────────────────────

test('the reproduction policy makes a clearly better buy and nothing when nobody is better', () => {
  const policy = solverPolicy(highs, REPRO);
  // Forward 101 is worth 12 a week; the squad's forwards are worth 9, 6 and 2.2.
  const better = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] }));
  const { moves } = policy.decide({ t: GW, ...better });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].inId, 101);
  assert.equal(better.world.at().s.playersById[moves[0].outId].position, 'FWD');
  const worse = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 1 }] }));
  assert.deepEqual(policy.decide({ t: GW, ...worse }).moves, []);
  assert.deepEqual(policy.counts, { solves: 2, ms: policy.counts.ms, stopped: 0, noPlan: 0, unordered: 0 });
});

/** What the engine recommends in a mode, as moves: its root, and for Funds the second move the root pays for. */
const movesOf = root => (root ? [root, ...(root.chained ? [root.chained] : [])].map(({ outId, inId }) => ({ outId, inId })) : []);

test('it logs the engine\'s move for each of its six modes beside its own first week', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] });
  const policy = solverPolicy(highs, REPRO);
  const { moves } = policy.decide({ t: GW, ...backtest(input) });
  const engine = Object.fromEntries(Object.entries(runDecisionEngine(input, REPRO.config).modes)
    .map(([id, m]) => [id, movesOf(m.root)]));
  assert.deepEqual(Object.keys(engine).sort(), [...MODES].sort());
  assert.ok(Object.values(engine).some(set => set.length > 0), 'the scenario gives some mode a move');
  assert.deepEqual(policy.log, [{ t: GW, first: moves, engine }]);
});

test('it logs Funds\' chained second move with its root', () => {
  // Selling MID 10 for MID 109 frees the £3.0m that lets FWD 14 become FWD 111 (decision.test.js's chained scenario).
  const input = scenario({
    changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }],
    freeTransfers: 2,
  });
  const policy = solverPolicy(highs, REPRO);
  policy.decide({ t: GW, ...backtest(input) });
  assert.deepEqual(policy.log[0].engine.funds, [{ outId: 10, inId: 109 }, { outId: 14, inId: 111 }]);
});

test('a first week agrees with a mode when it is that mode\'s whole move set, a chained second move included', () => {
  const week = { t: GW, first: [{ outId: 14, inId: 111 }, { outId: 10, inId: 109 }], engine: {
    funds: [{ outId: 10, inId: 109 }, { outId: 14, inId: 111 }], now: [{ outId: 10, inId: 109 }], ceiling: [] } };
  assert.equal(agrees(week, 'funds'), true, 'the same two moves, in the other order');
  assert.equal(agrees(week, 'now'), false, 'one of the two is not the whole week');
  assert.equal(agrees(week, 'ceiling'), false, 'a roll is not a two-move week');
  assert.equal(agrees({ ...week, first: [] }, 'ceiling'), true, 'both roll');
});

test('the reproduction problem holds Phase 8\'s pool and none of the engine\'s own buys', () => {
  // 120 is Now's buy by far (20 in the planning GW), but 21 forwards each worth more over five GWs fill the pool of 20.
  const input = scenario({ candidates: [{ id: 120, position: 'FWD', xip: [20, 0, 0, 0, 0, 0] },
    ...Array.from({ length: 21 }, (_, i) => ({ id: 201 + i, position: 'FWD', xip: 6 }))] });
  const result = runDecisionEngine(input, REPRO.config);
  assert.equal(result.modes.now.root.inId, 120);
  const problem = solverProblem(input, result, REPRO.setting(input, result), REPRO.config);
  const bought = problem.players.filter(q => !q.owned).map(q => q.id).sort((a, b) => a - b);
  assert.deepEqual(bought, Array.from({ length: REPRO.config.solver.pool.points }, (_, i) => 201 + i));
  assert.deepEqual(problem, solverProblem(input, { ...result, modes: {} }, REPRO.setting(input, result), REPRO.config));
});

test('moves with no legal order one at a time are left out of the week, the legal ones made, the week counted', () => {
  // Clubs 50 and 60 each hold three of the squad. The plan sells bench defender 7 (club 60) for defender 101 (club 50), bench
  // forward 15 (club 50) for forward 102 (club 60) and bench midfielder 12 for midfielder 103: as a set, legal; one at a
  // time, the defender or the forward would be a fourth of a club, whichever goes first.
  const input = scenario({
    changes: [1, 2, 15].map(id => ({ id, team: 50 })).concat([3, 4, 7].map(id => ({ id, team: 60 }))),
    candidates: [{ id: 101, position: 'DEF', team: 50, xip: 12 }, { id: 102, position: 'FWD', team: 60, xip: 12 },
      { id: 103, position: 'MID', xip: 12 }],
  });
  const policy = solverPolicy(highs, REPRO);
  assert.deepEqual(policy.decide({ t: GW, ...backtest(input) }).moves, [{ outId: 12, inId: 103 }]);
  assert.deepEqual(policy.counts, { solves: 1, ms: policy.counts.ms, stopped: 0, noPlan: 0, unordered: 1 });
  assert.deepEqual(policy.log.map(week => week.first), [[{ outId: 12, inId: 103 }]]);
});

test('no plan means no moves, counted', () => {
  const seen = [];
  const none = Status => ({
    solve: (lp, options) => {
      seen.push(options);
      return { Status, ObjectiveValue: Infinity, Columns: {} };
    },
  });
  const world = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] }));
  // Infeasible, and stopped at the time limit before any plan: the app keeps the engine's move, so the policy makes none.
  for (const status of ['Infeasible', 'Time limit reached']) {
    const policy = solverPolicy(none(status), REPRO);
    assert.deepEqual(policy.decide({ t: GW, ...world }).moves, [], status);
    assert.equal(policy.counts.noPlan, 1, status);
    assert.equal(policy.counts.solves, 1, status);
    assert.deepEqual(policy.log.map(week => week.first), [[]], status);
  }
  assert.deepEqual(seen, Array(2).fill({ output_flag: false, ...REPRO.options }));
});
