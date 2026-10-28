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
import { createDecisionCache, moveSetKey, runDecisionEngine } from '../../js/engine/decision.js';
import { pickBeatsAlternatives } from '../../js/engine/solver/rescore.js';
import { solverProblem } from '../../js/engine/solver/problem.js';
import { createSolverRunner } from '../../js/modules/planner-solver.js';
import { GAIN_WINDOWS, engineInput } from '../../tools/backtest/lib.js';
import {
  BUCKETS, bucketGap, bucketMoves, defaultMargin, evalName, guardTotals, passLine, percentOf, robustMoves, robustnessPasses, withEval,
} from '../../tools/backtest/eval.js';
import { solverEvalSection } from '../../tools/backtest/run.js';
import { REPRO, agrees, modePolicy, reproFor, solverPolicy } from '../../tools/backtest/solver.js';
import { GW, MODES, scenario, withDraws } from '../engine/decision-fixtures.js';
import { CONFIG, fakeHighs, loadVendored } from '../engine/solver/fixtures.js';
import { fakeEval, fakeResults, fakeSolverRun } from './backtest-eval-fixtures.js';

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
  const world = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] }));
  // Infeasible, and stopped at the time limit before any plan: the app keeps the engine's move, so the policy makes none.
  for (const status of ['infeasible', 'timeLimit']) {
    const { highs: none, seen } = fakeHighs(highs, { status });
    const policy = solverPolicy(none, REPRO);
    assert.deepEqual(policy.decide({ t: GW, ...world }).moves, [], status);
    assert.equal(policy.counts.noPlan, 1, status);
    assert.equal(policy.counts.solves, 1, status);
    assert.deepEqual(policy.log.map(week => week.first), [[]], status);
    assert.deepEqual(seen.options, { output_flag: false, ...REPRO.options }, status);
  }
});

// ─── Each mode's policy ──────────────────────────────────────────────────────

const { timeLimitS, resolveTimeLimitS, absGap } = CONFIG.solver;
const CANDIDATES = [{ id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'FWD', xip: 11 }];
const MOVE = { outId: 15, inId: 101 };

const week = (gw, out = [], ins = []) => ({ gw, out, in: ins, hits: 0, ft: 1 });
const plan = (objective, ...weeks) => ({ objective, weeks });
/** A plan that sells 15 for 101 this week (or the given sale), and one that does nothing. */
const sells = (objective, out = [15], ins = [101]) => plan(objective, week(GW, out, ins), week(GW + 1));
const rolls = objective => plan(objective, week(GW), week(GW + 1));
const kindOf = problem => (problem.fixed?.first ? 'rolling' : problem.exclude?.length ? 'alt' : 'pick');

/**
 * Solves answering as told, to hand to a policy as its `solve` and to a fake worker alike, so both see the same answers:
 * `answer({ kind, limit })` returns { plan, stopped, gap } - an optimal solve by default, no plan for no `plan` - and
 * `asked` keeps what was asked.
 */
function scripted(answer) {
  const asked = [];
  const solve = (_, problem, options) => {
    const ask = { kind: kindOf(problem), limit: options.time_limit, problem };
    asked.push(ask);
    const { plan: found = null, stopped = false, gap = found ? 0 : null } = answer(ask);
    return { plan: found, stopped, ms: 1, bound: null, gap };
  };
  return { solve, asked };
}

const policyOf = (modeId, solve, extra = {}) =>
  modePolicy(highs, { modeId, hitMargin: 0, config: CONFIG, robustnessEvery: Infinity, solve, ...extra });
const inputOf = bt => engineInput(bt.world.at(GW), GW, bt.state, new Set(), new Set());
const engineMoves = root => (root ? [root, ...(root.chained ? [root.chained] : [])].map(({ outId, inId }) => ({ outId, inId })) : []);

/** Each mode's last log entry from the app's runner on an input, its workers answering from `solve`. */
async function runnerLog(solve, input) {
  const cache = createDecisionCache();
  const logs = [];
  const makeWorker = () => {
    const worker = { onmessage: null, onerror: null, terminate() {},
      postMessage: message => {
        const data = message.kind === 'init' ? { id: message.id, ok: true }
          : { id: message.id, ok: true, ...solve(null, message.problem, message.options) };
        Promise.resolve().then(() => worker.onmessage({ data }));
      } };
    return worker;
  };
  const runner = createSolverRunner({ config: CONFIG, makeWorker, makeRescoreWorker: () => ({ postMessage() {}, terminate() {} }),
    onCard() {}, onLog: entry => logs.push(entry), hardwareConcurrency: 4 });
  runner.refresh(input, runDecisionEngine(input, CONFIG, cache), 1, cache);
  for (let turn = 0; turn < 40; turn++) await new Promise(resolve => setImmediate(resolve));
  runner.stop();
  return Object.fromEntries(MODES.map(mode => [mode, logs.findLast(entry => entry.mode === mode)]));
}

test('a mode policy makes the runner\'s settled moves', async () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const input = inputOf(bt);
  const waits = plan(5, week(GW), week(GW + 1, [15], [101]), week(GW + 2));
  const cases = {
    'a trusted move': { moves: [MOVE], answer: ({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : sells(10) }) },
    'a pick short of its bound, resolved': { moves: [MOVE], answer: ({ kind, limit }) => ({
      plan: kind === 'rolling' ? rolls(4) : sells(10), ...(kind === 'pick' && limit === timeLimitS ? { stopped: true, gap: absGap + 1 } : {}) }) },
    'a move that ties with rolling': { moves: [], answer: ({ kind }) => ({ plan: kind === 'rolling' ? rolls(10 - absGap) : sells(10) }) },
    'a wait': { moves: [], answer: ({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : waits }) },
  };
  for (const [name, { moves, answer }] of Object.entries(cases)) {
    const ran = scripted(answer);
    const shown = await runnerLog(ran.solve, input);
    const own = scripted(answer);
    for (const mode of MODES) {
      const policy = policyOf(mode, own.solve);
      const made = policy.decide({ t: GW, ...bt }).moves;
      const entry = shown[mode];
      assert.deepEqual(made, entry.call === 'move' ? entry.moves : [], `${name}: ${mode}`);
      const [week0] = policy.log;
      assert.deepEqual([week0.source, week0.guard, week0.call, week0.gap], [entry.source, entry.guard, entry.call, entry.gap], `${name}: ${mode} log`);
    }
    // A re-solve and a twin at the limit the runner uses, not another one: the twin's limit lives in two places.
    if (name === 'a pick short of its bound, resolved') {
      const pairs = asked => asked.filter(a => a.kind !== 'alt').map(a => `${a.kind}@${a.limit}`).sort();
      assert.deepEqual(pairs(own.asked), pairs(ran.asked), `${name}: the (kind, limit) pairs asked`);
      assert.ok(pairs(own.asked).includes(`rolling@${resolveTimeLimitS}`), `${name}: the twin was solved at the re-solve's limit`);
    }
    // The cases are not vacuous: Now is solved, and does what the case says.
    const now = policyOf('now', scripted(answer).solve);
    assert.deepEqual(now.decide({ t: GW, ...bt }).moves, moves, name);
    assert.equal(now.log[0].source, 'solver', name);
  }
});

test('a pick that is short of its bound is solved again, its twin as long as the plan shown; the log says which', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const short = { stopped: true, gap: absGap + 1 };
  const { solve, asked } = scripted(({ kind, limit }) => ({ plan: kind === 'rolling' ? rolls(4) : sells(10), ...(limit === timeLimitS ? short : {}) }));
  const policy = policyOf('longterm', solve);
  assert.deepEqual(policy.decide({ t: GW, ...bt }).moves, [MOVE]);
  assert.deepEqual(asked.map(a => [a.kind, a.limit]), [['pick', timeLimitS], ['pick', resolveTimeLimitS], ['rolling', resolveTimeLimitS]]);
  assert.deepEqual(policy.log, [{ t: GW, call: 'move', moves: [MOVE], source: 'solver', guard: 'resolved', gap: 0, gain: 6, robustness: null }]);
  assert.deepEqual(policy.counts, { solves: 3, ms: 3, stopped: 1, resolved: 1, twins: 1, alternatives: 0, engineFallback: 0, ties: 0,
    kept: 0, unordered: 0 });
  // A trusted pick is not solved again, and its twin is as long as the pick.
  const first = scripted(({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : sells(10) }));
  const trusted = policyOf('longterm', first.solve);
  trusted.decide({ t: GW, ...bt });
  assert.deepEqual(first.asked.map(a => [a.kind, a.limit]), [['pick', timeLimitS], ['rolling', timeLimitS]]);
  assert.equal(trusted.log[0].guard, 'trusted');
});

test('an untrusted pick and re-solve fall back to the engine\'s move', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const result = runDecisionEngine(inputOf(bt), CONFIG);
  // Neither answer proves its plan, which sells another player: the engine's move is made, or none where the engine rolls.
  const { solve, asked } = scripted(() => ({ plan: sells(10, [14], [102]), stopped: true, gap: absGap + 1 }));
  const policy = policyOf('now', solve);
  const { moves } = policy.decide({ t: GW, ...bt });
  assert.deepEqual(moves, engineMoves(result.modes.now.root));
  assert.deepEqual(moves, [MOVE], 'the engine\'s buy here');
  assert.deepEqual(asked.map(a => [a.kind, a.limit]), [['pick', timeLimitS], ['pick', resolveTimeLimitS]]);
  assert.deepEqual(policy.log, [{ t: GW, call: 'move', moves, source: 'engine', guard: 'engine', gap: null,
    gain: result.modes.now.root.outScore, robustness: null }]);
  assert.deepEqual(policy.counts, { solves: 2, ms: 2, stopped: 2, resolved: 1, twins: 0, alternatives: 0, engineFallback: 1, ties: 0,
    kept: 0, unordered: 0 });

  // No plan at all is untrusted too; where the engine rolls, so does the policy.
  const flat = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 1 }] }));
  const none = policyOf('now', scripted(() => ({})).solve);
  assert.deepEqual(none.decide({ t: GW, ...flat }).moves, []);
  assert.equal(none.log[0].call, 'roll');
  assert.equal(none.counts.engineFallback, 1);
});

test('a rolling solve with no plan, or moves with no legal order, fall back to the engine\'s move too', () => {
  // Candidate 101 costs more than the bank and the sale pay for: the plan's move cannot be made one at a time; 102 can.
  const bt = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12, price: 60 }, { id: 102, position: 'FWD', xip: 11 }] }));
  const result = runDecisionEngine(inputOf(bt), CONFIG);
  assert.deepEqual(engineMoves(result.modes.now.root), [{ outId: 15, inId: 102 }]);
  const unordered = policyOf('now', scripted(({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : sells(10) })).solve);
  assert.deepEqual(unordered.decide({ t: GW, ...bt }).moves, [{ outId: 15, inId: 102 }]);
  assert.deepEqual([unordered.counts.unordered, unordered.counts.engineFallback, unordered.log[0].source], [1, 1, 'engine']);

  const ok = backtest(scenario({ candidates: CANDIDATES }));
  const noTwin = policyOf('now', scripted(({ kind }) => (kind === 'rolling' ? {} : { plan: sells(10) })).solve);
  assert.deepEqual(noTwin.decide({ t: GW, ...ok }).moves, [MOVE]);
  // The engine's move here is the plan's own, so the source tells them apart.
  assert.deepEqual([noTwin.counts.twins, noTwin.counts.engineFallback, noTwin.log[0].source, noTwin.log[0].guard], [1, 1, 'engine', 'engine']);
});

test('a protected sale is the model\'s bug and stops the run, where the app would only warn', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const policy = policyOf('now', scripted(({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : sells(10, [3], [101]) })).solve);
  const locked = { ...bt, locks: new Set([3]) };
  assert.throws(() => policy.decide({ t: GW, ...locked }), { protectedSale: true });
});

test('a tie with rolling and a wait are counted and make no move', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const tie = policyOf('now', scripted(({ kind }) => ({ plan: kind === 'rolling' ? rolls(10 - absGap) : sells(10) })).solve);
  assert.deepEqual(tie.decide({ t: GW, ...bt }).moves, []);
  assert.deepEqual([tie.counts.ties, tie.log[0].call, tie.log[0].source, tie.log[0].gain], [1, 'roll', 'solver', absGap]);
  const wait = policyOf('now', scripted(({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : plan(5, week(GW), week(GW + 1, [15], [101])) })).solve);
  assert.deepEqual(wait.decide({ t: GW, ...bt }).moves, []);
  assert.deepEqual([wait.log[0].call, wait.log[0].moves, wait.counts.twins], ['wait', [], 0]);
  // A wait that sells a locked player the week after is a roll with its kept players: counted as kept.
  const kept = policyOf('now', scripted(({ kind }) => ({ plan: kind === 'rolling' ? rolls(4) : plan(5, week(GW), week(GW + 1, [3], [101])) })).solve);
  assert.deepEqual(kept.decide({ t: GW, ...bt, locks: new Set([3]) }).moves, []);
  assert.deepEqual([kept.counts.kept, kept.log[0].call], [1, 'roll']);
});

test('the mode\'s hit margin reaches the problem, over the config\'s', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const config = { ...CONFIG, solver: { ...CONFIG.solver, modes: { ...CONFIG.solver.modes, funds: { hitMargin: 1 } } } };
  for (const hitMargin of [0, 2]) {
    const { solve, asked } = scripted(() => ({ plan: rolls(5) }));
    policyOf('funds', solve, { hitMargin, config }).decide({ t: GW, ...bt });
    assert.equal(asked[0].problem.hitMargin, hitMargin);
  }
  assert.equal(config.solver.modes.funds.hitMargin, 1, 'the caller\'s config is left as it was');
});

test('Ceiling in a big week is the engine\'s move, with no solve', () => {
  const base = withDraws(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 8 }, { id: 102, position: 'FWD', xip: 7.9 }] }), { 102: { goals: 3, share: 0.5 } });
  const projections = new Map(base.projections);
  const p = projections.get(3);
  projections.set(3, { ...p, gws: p.gws.map((g, i) => (i === 0 ? { ...g, fixtures: 2 } : g)) });
  const bt = backtest({ ...base, projections });
  const result = runDecisionEngine(inputOf(bt), CONFIG);
  assert.equal(result.modes.ceiling.bigWeek, true);
  const { solve, asked } = scripted(() => ({ plan: rolls(5) }));
  const policy = policyOf('ceiling', solve);
  const { moves } = policy.decide({ t: GW, ...bt });
  assert.deepEqual(moves, result.modes.ceiling.call === 'move' ? engineMoves(result.modes.ceiling.root) : []);
  assert.deepEqual([asked.length, policy.log[0].source, policy.log[0].guard, policy.counts.solves, policy.counts.engineFallback], [0, 'engine-tail', 'engine', 0, 0]);
});

test('a mode with no weeks to weigh rolls with no solve', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const config = { ...CONFIG, modes: { ...CONFIG.modes, now: { ...CONFIG.modes.now, weights: CONFIG.modes.now.weights.map(() => 0) } } };
  const { solve, asked } = scripted(() => ({ plan: sells(10) }));
  const policy = policyOf('now', solve, { config });
  assert.deepEqual(policy.decide({ t: GW, ...bt }).moves, []);
  assert.deepEqual([asked.length, policy.log[0].call, policy.log[0].source], [0, 'roll', 'engine']);
});

test('robustness is computed every third week on a move, and logged', () => {
  const bt = backtest(scenario({ candidates: CANDIDATES }));
  const input = inputOf(bt);
  const result = runDecisionEngine(input, CONFIG);
  // The sixth week ties with rolling: a roll, so no robustness although it is a third week.
  let weekNo = 0;
  const { solve, asked } = scripted(({ kind }) => {
    if (kind === 'alt') return { plan: sells(9.9, [14], [102]) };
    return { plan: kind === 'rolling' ? rolls(weekNo === 6 ? 10 - absGap : 4) : sells(10) };
  });
  const policy = policyOf('now', solve, { robustnessEvery: 3 });
  for (weekNo = 1; weekNo <= 9; weekNo++) policy.decide({ t: GW, ...bt });
  assert.deepEqual(policy.log.map(entry => entry.robustness !== null), [false, false, true, false, false, false, false, false, true]);
  assert.deepEqual(policy.log.map(entry => entry.call), ['move', 'move', 'move', 'move', 'move', 'roll', 'move', 'move', 'move']);
  // The share is the pick against its alternatives, the engine's move and rolling, on the engine's weights.
  const candidate = moves => ({ key: moveSetKey(moves), moves });
  const expected = pickBeatsAlternatives(input, CONFIG, 'now', result.modes.now.weights,
    [candidate([MOVE]), candidate([{ outId: 14, inId: 102 }]), candidate(engineMoves(result.modes.now.root)), candidate([])], moveSetKey([MOVE]));
  assert.equal(policy.log[2].robustness, expected);
  assert.ok(expected >= 0 && expected <= 1);
  // Each of the two weeks asks for alternativesMax alternatives (the script answers the same one twice), and counts them.
  assert.equal(asked.filter(a => a.kind === 'alt').length, 2 * CONFIG.alternativesMax);
  assert.equal(policy.counts.alternatives, 2 * CONFIG.alternativesMax);
});

test('the policy with the vendored HiGHS buys a clearly better player and does nothing when nobody is better', () => {
  const policy = modePolicy(highs, { modeId: 'longterm', hitMargin: 0, config: CONFIG, robustnessEvery: 1 });
  const better = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] }));
  const { moves } = policy.decide({ t: GW, ...better });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].inId, 101);
  assert.equal(better.world.at().s.playersById[moves[0].outId].position, 'FWD');
  const [entry] = policy.log;
  assert.deepEqual([entry.source, entry.guard, entry.call, entry.moves], ['solver', 'trusted', 'move', moves]);
  assert.ok(entry.gain > absGap && entry.robustness >= 0 && entry.robustness <= 1);
  const worse = backtest(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 1 }] }));
  assert.deepEqual(policy.decide({ t: GW, ...worse }).moves, []);
  assert.equal(policy.log[1].call, 'roll');
  assert.equal(policy.counts.twins, 1, 'only the move had a rolling twin');
});

// ─── The Phase 4 report ──────────────────────────────────────────────────────

const BOOT = { draws: 200, seed: 1 };
const LEVELS = { old: 50, 'roll+': 52, longterm: 54, 'longterm+': 55, now: 54, future: 54, funds: 54, ceiling: 54, structure: 54 };
/** The solver's weekly level in each mode: Now beats old and Long term; Future prep beats old but not Long term. */
const solverLevels = (over = {}) => ({ now: 58, longterm: 56, future: 53, funds: 55, ceiling: 55, structure: 55, ...over });
const meanTotal = level => 4 * (level + 1) - 2;   // fakeRun: four weeks of level + squad (0, 1, 2), the first week's two hit points off
const linesOf = md => md.split('\n');

test('each margin\'s runs are laid over the results\' tasks under a name that says the margin', () => {
  const results = fakeResults(LEVELS);
  const rows = withEval(results, { 0: fakeEval(solverLevels()), 2: fakeEval(solverLevels({ now: 60 })) });
  assert.equal(rows.length, results.length);
  assert.deepEqual(Object.keys(rows[0].out).sort(), [...Object.keys(LEVELS), ...MODES.flatMap(m => [0, 2].map(g => evalName(m, g)))].sort());
  assert.equal(rows[0].out[evalName('now', 0)].total, fakeEval(solverLevels())[0].out['solver:now'].total);
  assert.equal(rows[0].out[evalName('now', 2)].total, fakeEval(solverLevels({ now: 60 }))[0].out['solver:now'].total);
  // A margin not run is absent; a task it lacks drops out; another squad under the same index is not the same task.
  assert.deepEqual(Object.keys(withEval(results, { 0: null, 2: fakeEval(solverLevels()) })[0].out).filter(n => n.includes('@')),
    MODES.map(m => evalName(m, 2)));
  assert.equal(withEval(results, { 0: fakeEval(solverLevels()).slice(0, 1) }).length, 1);
  assert.deepEqual(withEval(results, { 0: null, 2: null }), []);
  const other = fakeEval(solverLevels()).map(r => ({ ...r, label: 'someone else' }));
  assert.throws(() => withEval(results, { 0: other }), /not data\/results\.json's/);
});

test('the default margin is the higher 2024-25 total, and a tie is margin 0', () => {
  assert.equal(defaultMargin({ 0: 2100, 2: 2101 }, [0, 2]), 2);
  assert.equal(defaultMargin({ 0: 2101, 2: 2100 }, [0, 2]), 0);
  assert.equal(defaultMargin({ 0: 2100, 2: 2100 }, [0, 2]), 0);
  assert.equal(defaultMargin({ 2: 2100, 0: 2100 }, [2, 0]), 0, 'whatever order the margins come in');
});

test('a mode passes when it beats the old engine with the interval above zero and is not clearly worse than Long term', () => {
  const at = (lo, hi) => ({ mean: (lo + hi) / 2, lo, hi });
  assert.deepEqual(passLine(at(1, 9), at(-4, 2)), { beatsOld: true, notWorse: true, pass: true });
  assert.deepEqual(passLine(at(1, 9), at(-4, -1)), { beatsOld: true, notWorse: false, pass: false }, 'clearly worse than Long term');
  assert.deepEqual(passLine(at(-1, 9), at(1, 2)), { beatsOld: false, notWorse: true, pass: false }, 'an interval that reaches zero');
  assert.deepEqual(passLine(at(0, 9), at(1, 2)).beatsOld, false, 'above zero, not at it');
  assert.equal(passLine(at(1, 9), at(-4, 0)).pass, true, 'worse only if the interval is wholly below zero');
  assert.equal(passLine(null, at(1, 2)).pass, false, 'no pairing, no pass');
});

const moveAt = (robustness, extra = {}) => ({ robustness, gain: 0, ...extra });
const manyAt = (robustness, n) => Array.from({ length: n }, () => moveAt(robustness));
const bucketCounts = ({ moves }) => Object.fromEntries(['high', 'middle', 'low'].map(b => [b, moves.filter(m => m.bucket === b).length]));

test('robustness buckets: high from 0.67, low to 0.33, the rest between', () => {
  const edges = [0.67, 0.66, 0.34, 0.33, 1, 0].map(r => moveAt(r));
  const bucketed = bucketMoves([...edges, ...manyAt(0.9, BUCKETS.min), ...manyAt(0.5, BUCKETS.min), ...manyAt(0.1, BUCKETS.min)]);
  assert.equal(bucketed.rule, 'thresholds');
  assert.deepEqual(edges.map((_, i) => bucketed.moves[i].bucket), ['high', 'middle', 'middle', 'low', 'high', 'low']);
  assert.deepEqual(bucketCounts(bucketed), { high: BUCKETS.min + 2, middle: BUCKETS.min + 2, low: BUCKETS.min + 2 });
  assert.deepEqual(bucketed.moves[0], { robustness: 0.67, gain: 0, bucket: 'high' }, 'a move keeps what it came with');
});

test('robustness is bucketed on the whole percent the card shows: 20/30 is Robust 67% (high), 10/30 is 33% (low)', () => {
  // The app shows Math.round(share * 100) ("Robust 67%"), and a person reads the buckets off that figure.
  const bucketOf = share => bucketMoves([moveAt(share), ...manyAt(0.9, BUCKETS.min), ...manyAt(0.5, BUCKETS.min), ...manyAt(0.1, BUCKETS.min)])
    .moves[0].bucket;
  assert.deepEqual([20, 10, 11, 19].map(n => bucketOf(n / 30)), ['high', 'low', 'middle', 'middle']);
  assert.deepEqual([20, 10, 11, 19].map(n => percentOf(n / 30)), [67, 33, 37, 63]);
  assert.deepEqual([0.665, 0.664, 0.335, 0.325].map(bucketOf), ['high', 'middle', 'middle', 'low'], 'the rounding is the card\'s');
});

test('a bucket under the minimum moves the cut to terciles of the figures themselves', () => {
  // One move short in the low bucket: the three are cut at the figures' own thirds instead (90 distinct figures).
  const short = [...manyAt(0.9, BUCKETS.min), ...manyAt(0.5, BUCKETS.min), ...manyAt(0.1, BUCKETS.min - 1)];
  assert.equal(bucketMoves(short).rule, 'terciles');
  assert.deepEqual(bucketMoves(short).atThresholds, { high: BUCKETS.min, middle: BUCKETS.min, low: BUCKETS.min - 1 }, 'what triggered it');
  const figures = Array.from({ length: 90 }, (_, i) => moveAt(i / 100));
  const terciles = bucketMoves([...figures].reverse());
  assert.equal(terciles.rule, 'terciles');
  assert.deepEqual(bucketCounts(terciles), { high: 30, middle: 30, low: 30 });
  assert.deepEqual([terciles.moves.find(m => m.robustness === 0.29).bucket, terciles.moves.find(m => m.robustness === 0.3).bucket,
    terciles.moves.find(m => m.robustness === 0.59).bucket, terciles.moves.find(m => m.robustness === 0.6).bucket],
  ['low', 'middle', 'middle', 'high']);
  // Equal figures are never split between buckets, whatever the order they came in.
  const tied = bucketMoves([...manyAt(0.2, 40), ...manyAt(0.8, 20), ...manyAt(0.8, 20)]);
  assert.deepEqual([tied.rule, bucketCounts(tied)], ['terciles', { high: 40, middle: 0, low: 40 }]);
  assert.deepEqual(bucketMoves([]), { rule: 'thresholds', moves: [] });
});

/** `n` squads of each of `seasons` seasons, each with the moves `of(squad)` gives. */
const strataOf = (of, n = 6, seasons = 2) => Array.from({ length: seasons }, () => Array.from({ length: n }, (_, i) => of(i)));
const gapOf = (strata, extra = {}) => bucketGap(strata, { ...BOOT, ...extra });

test('high less low, resampling whole squads: an interval above zero when high clearly beats low, across zero when not', () => {
  const clear = gapOf(strataOf(i => [{ bucket: 'high', gain: 10 + (i % 3) }, { bucket: 'low', gain: -5 + (i % 3) * 2 }]));
  assert.equal(clear.mean, 11 - (-5 + 2));
  assert.ok(clear.lo > 0 && clear.hi >= clear.mean && clear.lo <= clear.mean, JSON.stringify(clear));
  assert.equal(robustnessPasses(clear), true);

  const none = gapOf(strataOf(i => [{ bucket: 'high', gain: i % 4 }, { bucket: 'low', gain: (i + 1) % 4 }], 12));
  assert.ok(none.lo < 0 && none.hi > 0, JSON.stringify(none));
  assert.equal(robustnessPasses(none), false, 'a mean that is not above zero');

  const worse = gapOf(strataOf(i => [{ bucket: 'high', gain: -10 + (i % 3) }, { bucket: 'low', gain: 5 + (i % 3) }]));
  assert.ok(worse.mean < 0 && worse.hi < 0);
  assert.equal(robustnessPasses(worse), false);
  assert.equal(robustnessPasses({ mean: 1, lo: -3, hi: 2 }), true, 'above zero and not wholly below it');
  assert.equal(robustnessPasses({ mean: NaN, lo: NaN, hi: NaN }), false);
});

test('the squads are resampled from each season\'s own, the draws are seeded, and a draw without both buckets is drawn again', () => {
  // Only squad 0 holds a high move (10), and the others only low moves (0): every draw that counts holds squad 0 and
  // another, so every one is exactly 10. A draw left empty and counted as zero would pull the interval's low end to 0.
  const lone = [[{ bucket: 'high', gain: 10 }], [{ bucket: 'low', gain: 0 }], [{ bucket: 'low', gain: 0 }], [{ bucket: 'low', gain: 0 }]];
  assert.deepEqual(gapOf([lone]), { mean: 10, lo: 10, hi: 10 });
  const varied = strataOf(i => [{ bucket: 'high', gain: i * i }, { bucket: 'low', gain: -i }]);
  assert.deepEqual(gapOf(varied), gapOf(varied));
  assert.notDeepEqual(gapOf(varied), gapOf(varied, { seed: 2 }));
  // A bucket nobody holds has no gap.
  const noLow = gapOf([[[{ bucket: 'high', gain: 1 }], [{ bucket: 'middle', gain: 2 }]]]);
  assert.ok([noLow.mean, noLow.lo, noLow.hi].every(Number.isNaN));
  // A season of squads is resampled within itself: a season with one squad always draws that squad.
  const seasons = [[[{ bucket: 'high', gain: 7 }]], [[{ bucket: 'low', gain: 3 }]]];
  assert.deepEqual(gapOf(seasons), { mean: 4, lo: 4, hi: 4 });
});

test('a settled first move with a robustness figure is matched to its week\'s realised gain by GW', () => {
  const run = {
    // Metrics are only for weeks with moves, and not in the log's order.
    log: [{ t: 5, robustness: 0.8 }, { t: 6, robustness: null }, { t: 7, robustness: 0.2 }, { t: 8, robustness: 0 }],
    metrics: [{ gw: 8, realised: { 5: 1 } }, { gw: 7, realised: { 5: -3 } }, { gw: 6, realised: { 5: 9 } }, { gw: 5, realised: { 5: 4 } }],
  };
  const row = { season: '2025-26', squad: 4, out: { 'solver:now@0': run, 'solver:funds@0': { log: [], metrics: [] }, 'solver:now@2': run } };
  assert.deepEqual(robustMoves(row, ['solver:now@0', 'solver:funds@0']), [{ robustness: 0.8, gain: 4 }, { robustness: 0.2, gain: -3 },
    { robustness: 0, gain: 1 }]);
  const lost = { ...row, out: { 'solver:now@0': { ...run, metrics: run.metrics.slice(0, 2) } } };
  assert.throws(() => robustMoves(lost, ['solver:now@0']), /GW5/);
});

test('the gain is moveMetrics\' longest window, and a week without one throws, never a silent NaN', () => {
  const longest = Math.max(...GAIN_WINDOWS);
  const at = realised => ({ season: '2025-26', squad: 4, out: { 'solver:now@0': { log: [{ t: 5, robustness: 0.8 }],
    metrics: [{ gw: 5, realised }] } } });
  assert.deepEqual(robustMoves(at({ 1: 1, 3: 2, [longest]: 7 }), ['solver:now@0']), [{ robustness: 0.8, gain: 7 }]);
  assert.throws(() => robustMoves(at({ 1: 1, 3: 2 }), ['solver:now@0']), new RegExp(`realised gain over ${longest} GWs`));
});

test('the guard\'s weeks split into trusted, resolved, engine fallback and no solve, with the ties, kept and the solves', () => {
  const runs = [0, 1, 2].map(squad => fakeSolverRun(50, squad));
  assert.deepEqual(guardTotals(runs), { weeks: 12, trusted: 3, resolved: 3, fallback: 3, noSolve: 3, ties: 3, kept: 0, solves: 24,
    stopped: 6, ms: 2400 });
  assert.deepEqual(guardTotals([]), { weeks: 0, trusted: 0, resolved: 0, fallback: 0, noSolve: 0, ties: 0, kept: 0, solves: 0,
    stopped: 0, ms: 0 });
});

// The section's figures all come from the rows it is given.

const bothMargins = (extra = {}, over = {}) => withEval(fakeResults(LEVELS), {
  0: fakeEval(solverLevels(), extra), 2: fakeEval(solverLevels({ now: 60, ...over }), extra),
});

test('with no solver-eval data the section says each margin has not run yet, and renders nothing else', () => {
  for (const rows of [[], withEval(fakeResults(LEVELS), { 0: null, 2: null })]) {
    const md = solverEvalSection(rows);
    assert.match(md, /^## /);
    for (const margin of [0, 2]) assert.ok(md.includes(`--solver-eval --margin ${margin}`), `margin ${margin}`);
    assert.ok(!md.includes('| mode |'), 'no table');
    assert.ok(!/\d\.\d/.test(md), 'no figure');
  }
});

test('with one margin run, the other\'s sections say not run yet and the rest renders', () => {
  const rows = withEval(fakeResults(LEVELS), { 0: fakeEval(solverLevels(), { robustness: [0.9, 0.5, 0.1] }), 2: null });
  const md = solverEvalSection(rows);
  assert.ok(md.includes(`--solver-eval --margin 2`));
  assert.ok(!md.includes(`--solver-eval --margin 0`));
  assert.ok(md.includes(String(meanTotal(solverLevels().now).toFixed(1))), 'margin 0\'s totals');
  assert.match(md.slice(md.indexOf('### Hit margin'), md.indexOf('### Robustness')), /not run yet/i);
  assert.match(md.slice(md.indexOf('### Robustness'), md.indexOf('### The guard')), /Cut at the thresholds/);
});

test('the headline gives the totals and the pass lines from the rows, a mode passing or not by its own figures', () => {
  const md = solverEvalSection(bothMargins());
  const line = label => linesOf(md).filter(l => l.startsWith(`| ${label} solver `));
  // Margin 0: Now (58) beats old (50) and Long term (54); Future prep (53) beats old but is clearly worse than Long term (54).
  const passRow = label => line(label).find(l => /pass/.test(l));
  assert.match(passRow('Now'), /\| pass \|$/);
  assert.match(passRow('Future prep'), /\| does not pass \|$/);
  for (const level of [58, 56, 53, 50, 54, 55]) assert.ok(md.includes(meanTotal(level).toFixed(1)), `a total of ${meanTotal(level)}`);
  assert.ok(md.includes('Against the old engine'), 'the report\'s usual verdict lines');
  assert.ok(md.includes('Against Long term+'));
  // Totals move with the rows: shift every solver run by ten points a week and the figures follow.
  const moved = solverEvalSection(withEval(fakeResults(LEVELS), { 0: fakeEval(solverLevels({ now: 68 })), 2: fakeEval(solverLevels({ now: 68 })) }));
  assert.ok(moved.includes(meanTotal(68).toFixed(1)) && !moved.includes(meanTotal(58).toFixed(1)));
});

test('the hit margin section picks the margin with the higher 2024-25 total, and shows 2025-26 for it only', () => {
  // Now: margin 2 is two points a week higher in both seasons; the others are alike at both margins (a tie: margin 0).
  const md = solverEvalSection(bothMargins());
  const section = md.slice(md.indexOf('### Hit margin'), md.indexOf('### Robustness'));
  const cells = label => linesOf(section).find(l => l.startsWith(`| ${label} |`)).split('|').map(c => c.trim()).filter(Boolean);
  assert.deepEqual(cells('Now'), ['Now', meanTotal(58).toFixed(1), meanTotal(60).toFixed(1), '2', meanTotal(60).toFixed(1)]);
  assert.deepEqual(cells('Long term'), ['Long term', meanTotal(56).toFixed(1), meanTotal(56).toFixed(1), '0', meanTotal(56).toFixed(1)]);
});

test('the robustness section cuts at the thresholds, or at terciles and says so; its pass line follows the gap', () => {
  const gain = r => (percentOf(r) >= BUCKETS.high ? 8 : 1);
  const thresholds = solverEvalSection(bothMargins({ robustness: [0.9, 0.5, 0.1], gain }));
  const section = md => md.slice(md.indexOf('### Robustness'), md.indexOf('### The guard'));
  assert.ok(section(thresholds).includes('Cut at the thresholds'));
  assert.ok(!section(thresholds).includes('Cut at terciles'));
  // 2 seasons x 3 squads x 6 modes x 4 weeks = 144 moves, 48 in each bucket.
  assert.match(section(thresholds), /\| high \| 2025-26 \| 24 \| \+8\.00 \|/);
  assert.match(section(thresholds), /\| low \| both \| 48 \| \+1\.00 \|/);
  assert.match(section(thresholds), /\+7\.00 \[\+7\.00, \+7\.00\]/);
  assert.match(section(thresholds), /\*\*pass\*\*/);

  // Only two figures: the middle bucket is empty, so the section cuts at terciles and says why.
  const terciles = section(solverEvalSection(bothMargins({ robustness: [0.9, 0.1], gain })));
  assert.ok(terciles.includes('Cut at terciles'));
  assert.ok(terciles.includes(`under ${BUCKETS.min} moves`));
  // 144 moves at 90% and 10%: at the thresholds, 72 high, none in the middle and 72 low.
  assert.ok(terciles.includes('high 72, middle 0, low 72'), 'the counts at the thresholds that triggered it');
  const flat = section(solverEvalSection(bothMargins({ robustness: [0.9, 0.1], gain: () => 3 })));
  assert.match(flat, /\*\*does not pass\*\*/);
});

test('the guard section gives each mode\'s shares of weeks, and transfers and hits beside the engine\'s and Long term+', () => {
  const md = solverEvalSection(bothMargins());
  const section = md.slice(md.indexOf('### The guard'));
  const cells = (label, from = 0) => linesOf(section).filter(l => l.startsWith(`| ${label} |`))[from].split('|').map(c => c.trim()).filter(Boolean);
  // Per run, four weeks: one trusted, one resolved, one engine fallback, one with no solve; 2 of 8 solves stopped, 100 ms each.
  assert.deepEqual(cells('Now'), ['Now', '24', '25%', '25%', '25%', '25%', '25%', '0%', '25%', '100']);
  // Transfers a week 1 for four weeks (4), the first week's 2 hit points; the engine's own policy and Long term+ the same.
  assert.ok(linesOf(section).some(l => /^\| Long term\+ \| 4\.0 \| 2\.0 \| 4\.0 \| 2\.0 \|$/.test(l)));
});
