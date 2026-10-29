/**
 * tests/modules/planner-solver.test.js
 * The solver's runner for the Planner (js/modules/planner-solver.js; docs/decision-engine-solver-plan.md §1 and §3),
 * with a fake Worker that answers scripted plans: when workers are made and how many, which cards solve and in what
 * order, the card each mode shows at each step, and the rule that a figure lands only on the card it was computed for
 * (Review Focus 1, 4 and 5). Nothing here loads HiGHS: the solver's own tests do.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_ENGINE } from '../../js/config.js';
import { createDecisionCache, runDecisionEngine } from '../../js/engine/decision.js';
import { modeSetting } from '../../js/engine/solver/problem.js';
import { createSolverRunner } from '../../js/modules/planner-solver.js';
import { GW, MODES, projectionOf, scenario, withDraws } from '../engine/decision-fixtures.js';

// Every mode on the solver at margin 0, as the tests were written; the shipped per-mode switches have their own test.
const CONFIG = { ...DECISION_ENGINE, solver: { ...DECISION_ENGINE.solver, enabled: true,
  modes: Object.fromEntries(Object.keys(DECISION_ENGINE.solver.modes).map(id => [id, { enabled: true, hitMargin: 0 }])) } };
const MODE_IDS = Object.keys(CONFIG.modes);
const { timeLimitS, resolveTimeLimitS, absGap } = CONFIG.solver;

// ─── The engine's side: inputs, results and plans ────────────────────────────

const CANDIDATES = [{ id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'FWD', xip: 11 }];

/** The engine's run on an input, kept with the cache it ran on: what the planner hands the runner. */
function engineOf(input) {
  const cache = createDecisionCache();
  return { input, cache, result: runDecisionEngine(input, CONFIG, cache) };
}

const week = (gw, out = [], ins = []) => ({ gw, out, in: ins, hits: 0, ft: 1 });
const plan = (objective, ...weeks) => ({ objective, weeks });
/** A plan whose first week sells `out` for `ins` and whose later weeks (to the mode's horizon) do nothing. */
const sells = (objective, out, ins, rest = 0) => plan(objective, week(GW, out, ins), ...Array.from({ length: rest }, (_, k) => week(GW + 1 + k)));

/** The mode a problem is of: each mode's weights are its own. */
const modeOf = engine => {
  const byWeights = new Map(MODE_IDS.flatMap(id => {
    const setting = modeSetting(engine.input, engine.result, id, CONFIG);
    return setting?.weights ? [[setting.weights.join(), id]] : [];
  }));
  return problem => byWeights.get(problem.weights.join());
};
const kindOf = problem => (problem.fixed?.first ? 'rolling' : problem.exclude?.length ? 'alt' : 'pick');

// ─── A fake Worker ───────────────────────────────────────────────────────────

const NEVER = new Promise(() => {});

/**
 * Workers that answer from a script. `solve({ modeId, kind, n, limit, problem, worker })` returns a plan, null (no plan
 * inside the cap), a promise of either, or throws (an `ok: false` answer); `init(worker)` and `rescore(message)` likewise.
 * `limit` is the time limit the page asked the solve for. `stopped(ask)` and `gap(ask)` say whether the solve stopped
 * at its limit and how far its plan was from the bound it proved (0 unless told, as an optimal solve's is).
 * `afterAnswer(ask)` runs the moment a solve's answer has been handed to the page, before anything the page does next.
 */
function world({ solve = () => null, init = () => ({ ok: true }), rescore = () => 0.75, afterAnswer = () => {}, stopped = () => false, gap = () => 0, engine, makeFails = null } = {}) {
  const modeIdOf = engine ? modeOf(engine) : () => undefined;
  const made = [];
  const rescorers = [];
  const asked = [];
  const posted = [];
  const reply = (worker, message, answer, after = () => {}) => Promise.resolve(answer).then(
    value => { if (!worker.terminated && value !== undefined) { worker.onmessage?.({ data: value }); after(); } },
    error => { if (!worker.terminated) worker.onmessage?.({ data: { id: message.id, ok: false, error: String(error?.message ?? error) } }); });

  class Fake {
    constructor() { this.terminated = false; this.seen = []; this.onmessage = null; this.onerror = null; }
    terminate() { this.terminated = true; }
  }
  const makeWorker = () => {
    if (makeFails) throw makeFails;
    const worker = Object.assign(new Fake(), {
      postMessage: message => {
        worker.seen.push(message);
        if (message.kind === 'init') return reply(worker, message, Promise.resolve(init(worker)).then(a => a && { id: message.id, ...a }));
        const { problem } = message;
        const ask = { modeId: modeIdOf(problem), kind: kindOf(problem), n: problem.exclude?.length ?? 0, limit: message.options.time_limit, problem, worker };
        asked.push(ask);
        return reply(worker, message, Promise.resolve().then(() => solve(ask))
          .then(plan => ({ id: message.id, ok: true, plan, stopped: stopped(ask), ms: 1, gap: plan ? gap(ask) : null })), () => afterAnswer(ask));
      },
    });
    made.push(worker);
    return worker;
  };
  const makeRescoreWorker = () => {
    const worker = Object.assign(new Fake(), {
      postMessage: message => {
        posted.push(message);
        Promise.resolve().then(() => rescore(message)).then(share => {
          if (!worker.terminated && share !== undefined) worker.onmessage?.({ data: { kind: 'rescore', key: message.key, share } });
        }, error => { if (!worker.terminated) worker.onerror?.({ message: String(error?.message ?? error) }); });
      },
    });
    rescorers.push(worker);
    return worker;
  };
  return { makeWorker, makeRescoreWorker, made, rescorers, asked, posted };
}

/** Let every promise chain the fake workers start run to its end. */
const flush = async (turns = 40) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(t, { engine = engineOf(scenario({ candidates: CANDIDATES })), config = CONFIG, phone = false, cores = 4, ...script } = {}) {
  const w = world({ engine, ...script });
  const cards = [];
  const logs = [];
  const runner = createSolverRunner({
    config, makeWorker: w.makeWorker, makeRescoreWorker: w.makeRescoreWorker, isPhone: () => phone, hardwareConcurrency: cores,
    onCard: (modeId, card) => cards.push({ modeId, card }),
    onLog: entry => logs.push(entry),
  });
  t.after(() => runner.stop());
  const refresh = (e = engine, version = 1) => runner.refresh(e.input, e.result, version, e.cache);
  return { runner, refresh, cards, logs, engine, config, ...w, of: modeId => cards.filter(c => c.modeId === modeId).map(c => c.card) };
}

const quiet = () => ({ warn: mock.method(console, 'warn', () => {}), error: mock.method(console, 'error', () => {}) });

/** The matching plan for a mode: what the engine's own move is (15 out, 101 in), then rolling and one alternative. */
const agree = ({ kind, n }) => {
  if (kind === 'rolling') return sells(4, [], [], 0);
  if (kind === 'alt') return n === 1 ? sells(9.5, [15], [102]) : null;
  return sells(10, [15], [101]);
};

// ─── When workers are made ───────────────────────────────────────────────────

test('nothing makes a worker until the first refresh, and never when the solver is off', async t => {
  const h = harness(t, { solve: agree });
  h.runner.view('now');
  await flush();
  assert.equal(h.made.length, 0, 'a runner alone makes none');
  assert.equal(h.rescorers.length, 0);

  h.refresh();
  assert.ok(h.made.length > 0);
  await flush();

  // The shipped config has the solver off: a refresh does nothing at all, and the page is left as it was.
  const off = harness(t, { solve: agree, config: { ...DECISION_ENGINE, solver: { ...DECISION_ENGINE.solver, enabled: false } } });
  off.refresh();
  await flush();
  assert.deepEqual([off.made.length, off.rescorers.length, off.cards.length], [0, 0, 0]);
});

test('importing the planner makes no worker', async () => {
  const made = [];
  globalThis.Worker = class { constructor(...args) { made.push(args); } };
  try {
    await import('../../js/modules/planner.js');
  } finally {
    delete globalThis.Worker;
  }
  assert.deepEqual(made, []);
});

test('each worker is initialised once with the vendored wasm and its pinned hash', async t => {
  const h = harness(t, { solve: agree });
  h.refresh();
  await flush();
  for (const worker of h.made) {
    const inits = worker.seen.filter(m => m.kind === 'init');
    assert.equal(inits.length, 1);
    assert.match(inits[0].wasmUrl, /assets\/vendor\/highs\/1\.15\.4\/highs\.wasm$/);
    assert.equal(inits[0].integrity, `sha256-${CONFIG.solver.vendor.wasm}`);
    assert.ok(worker.seen.every(m => m.kind !== 'init' || m === inits[0]));
  }
});

test('the pool is the config\'s workers, fewer on a machine with fewer cores, and one on a phone', async t => {
  const sizes = [];
  for (const [cores, phone] of [[8, false], [4, false], [2, false], [1, false], [undefined, false], [8, true]]) {
    const h = harness(t, { solve: agree, cores, phone });
    h.runner.view('now');
    h.refresh();
    await flush();
    sizes.push(h.made.length);
  }
  assert.deepEqual(sizes, [CONFIG.solver.workers, 3, 1, 1, CONFIG.solver.workers, 1]);
});

// ─── The card at each step ───────────────────────────────────────────────────

test('a card shows the engine\'s move refining, then the solver\'s move marked updated when it differs', async t => {
  const h = harness(t, { solve: ({ kind, modeId, n }) => (kind === 'pick' && modeId === 'now' ? sells(10, [14], [102]) : agree({ kind, n })) });
  h.refresh();
  // At once, before any worker has answered: every mode on the engine's move, refining.
  assert.deepEqual(h.cards.map(c => c.modeId), MODE_IDS);
  for (const { card } of h.cards) assert.deepEqual([card.source, card.state], ['engine', 'refining']);
  const engineNow = h.engine.result.modes.now;
  assert.equal(h.of('now')[0].root, engineNow.root);

  await flush();
  const now = h.of('now');
  assert.deepEqual([now[1].source, now[1].state, now[1].updated], ['solver', 'ready', true]);
  assert.equal(now[1].replaced, engineNow.root, 'it names the engine\'s move it replaced');
  assert.deepEqual(now[1].moves.map(m => [m.outId, m.inId]), [[14, 102]]);
  assert.equal(now[1].root.outId, 14);
  assert.equal(now[1].key, '14>102|1');
  // The card settles with its gain over rolling (it is what says the move is worth making); the others are pending.
  assert.deepEqual([now[1].gain, now[1].alternatives, now[1].robustness], [{ key: '14>102|1', value: 6 }, null, null]);
  const last = now.at(-1);
  assert.deepEqual([last.gain.value, last.alternatives.value.length, last.robustness.value], [6, 1, 0.75]);
  assert.equal(h.of('now').filter(c => c.state === 'refining').length, 1);
});

test('a card that replaces the engine\'s wait with the same move now says what the engine did', async t => {
  const engine = engineOf(scenario({ candidates: [{ id: 101, position: 'GKP', xip: [4.5, 6, 6, 6, 6, 6] }] }));
  const { future } = engine.result.modes;
  assert.equal(future.call, 'wait');
  const h = harness(t, { engine, solve: ({ kind, modeId, n }) => (kind === 'pick' && modeId === 'future'
    ? sells(10, [future.root.outId], [future.root.inId], 4) : kind === 'rolling' ? sells(4, [], [], 4) : agree({ kind, n })) });
  h.refresh();
  await flush();
  const card = h.of('future').at(-1);
  assert.deepEqual([card.call, card.updated, card.engineCall, card.replaced], ['move', true, 'wait', future.root]);
});

test('a solver move that matches the engine\'s leaves the card as it is, marked the solver\'s', async t => {
  const h = harness(t, { solve: agree });
  h.refresh();
  await flush();
  for (const modeId of MODE_IDS.filter(id => h.engine.result.modes[id].call === 'move')) {
    const [, settled] = h.of(modeId);
    assert.deepEqual([settled.source, settled.state, settled.updated, settled.replaced], ['solver', 'ready', false, undefined], modeId);
    assert.equal(settled.root, h.engine.result.modes[modeId].root, `${modeId} keeps the engine's own text`);
  }
});

test('a solver card has the explanation of its moves, the later weeks of its plan and the pair order of FPL', async t => {
  // Long term: sell 14 for 101 this week and 15 for 102 in the second; nothing in the third.
  const h = harness(t, { solve: ({ kind, modeId, n }) => (kind === 'pick' && modeId === 'longterm'
    ? plan(12, week(GW, [14], [101]), week(GW + 1, [15], [102]), week(GW + 2)) : agree({ kind, n })) });
  h.refresh();
  await flush();
  const card = h.of('longterm')[1];
  assert.equal(card.call, 'move');
  assert.deepEqual(card.later, [{ gw: GW + 1, moves: [{ outId: 15, inId: 102 }] }]);
  assert.equal(card.root.tentativeFromGw, GW + 1);
  assert.deepEqual(card.moves[0].minutesRisk, { out: 'low', in: 'low' });
  assert.ok(card.root.why.squad);
});

test('a plan with two moves is one card with both, ordered, and the hit counted by FPL\'s rule', async t => {
  const h = harness(t, { solve: ({ kind, modeId, n }) => (kind === 'pick' && modeId === 'now' ? sells(14, [14, 15], [101, 102]) : agree({ kind, n })) });
  h.refresh();
  await flush();
  const card = h.of('now')[1];
  assert.equal(card.moves.length, 2);
  assert.deepEqual(card.moves.map(m => [m.outId, m.inId]).sort(), [[14, 101], [15, 102]].sort());
  assert.equal(card.hits, CONFIG.hitCost, 'two moves on one free transfer: one hit');
  assert.equal(card.key, '14,15>101,102|1');
});

test('a wait is the second week\'s move, a roll has none', async t => {
  const h = harness(t, { solve: ({ kind, modeId, n }) => {
    if (kind !== 'pick') return agree({ kind, n });
    if (modeId === 'longterm') return plan(5, week(GW), week(GW + 1, [15], [101]), week(GW + 2));
    if (modeId === 'future') return plan(5, week(GW), week(GW + 1), week(GW + 2), week(GW + 3), week(GW + 4));
    return agree({ kind, n });
  } });
  h.refresh();
  await flush();
  const wait = h.of('longterm')[1];
  assert.deepEqual([wait.call, wait.deferral?.gw, wait.moves.map(m => m.outId), wait.hits], ['wait', GW + 1, [15], 0]);
  const roll = h.of('future')[1];
  assert.deepEqual([roll.call, roll.moves, roll.root, roll.updated], ['roll', [], null, true]);
  assert.equal(roll.replaced, h.engine.result.modes.future.root);
});

// ─── Figures land on the card they were computed for ─────────────────────────

test('a figure computed for another move set or an older input is never painted', async t => {
  const gate = Promise.withResolvers();
  const first = engineOf(scenario({ candidates: CANDIDATES }));
  // v2: the bank moved, so the whole input did (and the engine's move may not be the solver's).
  const second = engineOf(scenario({ candidates: CANDIDATES, bankTenths: 5 }));
  const h = harness(t, { engine: first, solve: ({ kind, problem }) => {
    const v1 = problem.bankTenths === 0;
    if (kind === 'pick') return v1 ? sells(10, [14], [102]) : sells(10, [15], [101]);
    // v1's alternatives are held back until after v2 has been asked for; v2's answer straight away.
    if (kind === 'rolling') return v1 ? sells(3, [], []) : sells(8, [], []);
    return v1 ? gate.promise.then(() => (problem.exclude.length === 1 ? sells(9, [13], [101]) : null)) : null;
  } });
  h.refresh(first, 1);
  await flush();
  assert.ok(h.of('now').some(c => c.key === '14>102|1'), 'v1\'s pick landed');
  const before = h.cards.length;
  const askedBefore = h.asked.length;

  h.refresh(second, 2);
  gate.resolve();
  await flush();
  // v1's alternatives loop was mid-way when v2 began: its next solve is not asked for.
  assert.ok(h.asked.slice(askedBefore).every(a => a.problem.bankTenths !== 0), 'a v1 problem was dispatched after the second refresh');
  const after = h.cards.slice(before);
  assert.ok(after.length > 0);
  // Nothing painted after v2 asked for its cards is v1's: no v1 key, no v1 pick, no v1 gain or alternative.
  for (const { card } of after) {
    assert.ok(!String(card.key).endsWith('|1'), `key ${card.key}`);
    assert.notEqual(card.gain?.value, 7, 'v1\'s gain over rolling');
    assert.ok(!card.alternatives?.value?.some(a => a.moves.some(m => m.inId === 101 && m.outId === 13)), 'v1\'s alternative');
  }
  const now = h.of('now').at(-1);
  assert.equal(now.key, '15>101|2');
  assert.equal(now.gain.value, 2, 'v2\'s own gain over rolling');
});

test('only the newest input\'s answers paint after a fast sequence of changes', async t => {
  const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const engines = [0, 1, 2].map(k => engineOf(scenario({ candidates: CANDIDATES, bankTenths: k })));
  const h = harness(t, { engine: engines[0], solve: ({ kind, problem }) => (kind === 'pick'
    ? gates[problem.bankTenths].promise.then(() => sells(10 + problem.bankTenths, [15], [101])) : sells(1, [], [])) });
  // The first input's picks are in flight on every worker when the next two inputs arrive.
  h.refresh(engines[0], 1);
  await flush();
  assert.equal(h.asked.filter(a => a.kind === 'pick').length, CONFIG.solver.workers);
  h.refresh(engines[1], 2);
  h.refresh(engines[2], 3);
  // Answer them newest first, then the older two.
  for (const k of [2, 0, 1]) { gates[k].resolve(); await flush(); }
  const painted = h.cards.filter(c => c.card.source === 'solver');
  assert.ok(painted.length > 0);
  assert.ok(painted.every(c => c.card.key.endsWith('|3')), painted.map(c => c.card.key).join());
  assert.equal(h.of('now').at(-1).key, '15>101|3');
});

test('a robustness share for a key that is not the card\'s is dropped', async t => {
  const h = harness(t, { solve: agree, rescore: message => (message.modeId === 'now' ? NEVER : 0.5) });
  h.refresh();
  await flush();
  // The share arrives for a card that has since been replaced: the next refresh makes new keys.
  const v1Messages = h.posted.filter(m => m.modeId === 'now');
  assert.equal(v1Messages.length, 1);
  h.refresh(h.engine, 2);
  h.rescorers[0].onmessage?.({ data: { kind: 'rescore', key: v1Messages[0].key, share: 0.9 } });
  await flush();
  assert.ok(h.cards.every(c => c.card.robustness?.value !== 0.9));
});

// ─── The solver failing or slow ──────────────────────────────────────────────

test('no plan inside the cap leaves the engine\'s move, marked engine', async t => {
  const h = harness(t, { solve: ({ modeId, kind, n }) => (modeId === 'longterm' ? null : agree({ kind, n })) });
  h.refresh();
  await flush();
  const card = h.of('longterm').at(-1);
  assert.deepEqual([card.source, card.state, card.root], ['engine', 'ready', h.engine.result.modes.longterm.root]);
  assert.equal(h.of('longterm').length, 2, 'refining, then the fallback: nothing after');
  // No plan is not a trusted one: it is asked for once more at the longer limit, and nothing after that.
  assert.deepEqual(h.asked.filter(a => a.modeId === 'longterm').map(a => [a.kind, a.limit]), [['pick', timeLimitS], ['pick', resolveTimeLimitS]]);
  assert.equal(h.of('now').at(-1).source, 'solver', 'the other modes are unaffected');
});

test('an error from the worker leaves the engine\'s move, marked engine, and the next solve goes on', async t => {
  const { warn } = quiet();
  const h = harness(t, { solve: ({ modeId, kind, n }) => { if (modeId === 'now') throw new Error('HiGHS returned "Unbounded"'); return agree({ kind, n }); } });
  h.refresh();
  await flush();
  const now = h.of('now').at(-1);
  assert.deepEqual([now.source, now.state], ['engine', 'ready']);
  assert.ok(warn.mock.calls.some(c => /Unbounded/.test(c.arguments.join())));
  assert.equal(h.of('longterm').at(-1).source, 'solver');
  // The worker answered: it was not the worker that was wrong, so it was not replaced.
  assert.ok(h.made.every(w => !w.terminated));
});

test('a worker that will not initialise turns the solver off for the session, warned once', async t => {
  const { warn } = quiet();
  const h = harness(t, { solve: agree, init: () => ({ ok: false, error: 'worker: https://x/highs.wasm answered 404' }) });
  h.refresh();
  await flush();
  assert.deepEqual(h.of('now').map(c => [c.source, c.state]), [['engine', 'refining'], ['engine', 'ready']]);
  for (const modeId of MODE_IDS) assert.equal(h.of(modeId).at(-1).source, 'engine', modeId);
  assert.equal(h.asked.length, 0);
  const offWarnings = warn.mock.calls.filter(c => /^\[planner\] solver off: /.test(String(c.arguments[0])));
  assert.equal(offWarnings.length, 1);
  assert.match(offWarnings[0].arguments[0], /404/);

  // Off for the session: the next refresh makes no worker and shows the engine's cards, ready at once.
  const made = h.made.length;
  h.cards.length = 0;
  h.refresh(h.engine, 2);
  await flush();
  assert.equal(h.made.length, made);
  assert.deepEqual(h.cards.map(c => c.card.state), MODE_IDS.map(() => 'ready'));
  assert.equal(warn.mock.calls.filter(c => /solver off/.test(String(c.arguments[0]))).length, 1, 'once, not on each refresh');
});

test('Worker missing (Node, an old browser) leaves every card the engine\'s and throws nothing', async t => {
  const { warn } = quiet();
  const h = harness(t, { solve: agree, makeFails: new ReferenceError('Worker is not defined') });
  assert.doesNotThrow(() => h.refresh());
  await flush();
  for (const modeId of MODE_IDS) assert.deepEqual([h.of(modeId).at(-1).source, h.of(modeId).at(-1).state], ['engine', 'ready'], modeId);
  assert.ok(warn.mock.calls.some(c => /solver off: Worker is not defined/.test(String(c.arguments[0]))));
  assert.equal(h.logs.length, MODE_IDS.length, 'each fallback is logged');
});

test('a solve that gives no answer in time ends its worker and a fresh one carries on', async t => {
  const { warn } = quiet();
  const config = { ...CONFIG, solver: { ...CONFIG.solver, workers: 1, timeLimitS: 0.01, timeoutMarginS: 0.02, initTimeoutS: 1 } };
  const h = harness(t, { config, cores: 2, solve: ({ modeId, kind, n }) => (modeId === 'now' && kind === 'pick' ? NEVER : agree({ kind, n })) });
  h.refresh();
  await flush(5);
  assert.equal(h.made.length, 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  await flush();
  assert.equal(h.made.length, 2, 'a fresh worker');
  assert.equal(h.made[0].terminated, true, 'the stuck one is ended: its solve cannot be interrupted');
  assert.equal(h.made[1].seen.filter(m => m.kind === 'init').length, 1, 'and initialised');
  const now = h.of('now').at(-1);
  assert.deepEqual([now.source, now.state], ['engine', 'ready']);
  assert.equal(h.of('longterm').at(-1).source, 'solver', 'the next solve ran on the fresh worker');
  assert.ok(warn.mock.calls.some(c => /no answer/.test(c.arguments.join())));
  // The page-side wait sits above the solver's own limit, by a margin taken from config.
  assert.ok(DECISION_ENGINE.solver.timeoutMarginS > 0);
});

test('a plan that sells a protected player is a bug: logged as an error, the engine\'s card kept, the plan never shown', async t => {
  const { error } = quiet();
  // 15 is locked: every mode keeps him, so a plan that sells him is a model bug.
  const engine = engineOf(scenario({ candidates: CANDIDATES, locks: new Set([15]) }));
  const h = harness(t, { engine, solve: ({ kind, modeId }) => (kind === 'pick' ? (modeId === 'now' ? sells(10, [15], [101]) : sells(10, [14], [101])) : sells(1, [], [])) });
  h.refresh();
  await flush();
  const now = h.of('now');
  assert.ok(now.every(c => !(c.source === 'solver')), 'never shown');
  assert.deepEqual([now.at(-1).source, now.at(-1).state], ['engine', 'ready']);
  assert.ok(error.mock.calls.some(c => /sold protected player 15/.test(c.arguments.join())));
  assert.equal(h.of('longterm').at(-1).source, 'solver');
});

test('a wait that sells a locked player the week after is a roll: warned, not an error, the sale never shown', async t => {
  const { warn, error } = quiet();
  // 15 is locked: this week's lock is the model's, so its plan may sell him next week and call that a wait.
  const engine = engineOf(scenario({ candidates: CANDIDATES, locks: new Set([15]) }));
  const waits = plan(5, week(GW), week(GW + 1, [15], [101]), week(GW + 2, [14], [102]));
  const h = harness(t, { engine, solve: ({ kind, modeId, n }) => (kind === 'pick' && modeId === 'longterm' ? waits : agree({ kind, n })) });
  h.refresh();
  await flush();
  const card = h.of('longterm').at(-1);
  assert.deepEqual([card.source, card.state, card.call, card.moves, card.root, card.deferral], ['solver', 'ready', 'roll', [], null, null]);
  assert.deepEqual(card.later, [{ gw: GW + 2, moves: [{ outId: 14, inId: 102 }] }], 'the weeks after the wait stay, tentative');
  const sells15 = c => c.source === 'solver' && (c.moves.some(m => m.outId === 15) || c.later.some(w => w.moves.some(m => m.outId === 15)));
  assert.ok(!h.of('longterm').some(sells15), 'no solver card sells him, now or later');
  assert.ok(warn.mock.calls.some(c => /longterm.*protected player.*the card rolls/.test(c.arguments.join())), 'warned');
  assert.ok(!error.mock.calls.some(c => /longterm sold protected player 15/.test(c.arguments.join())), 'and not an error: it is not a model bug');
  assert.ok(!h.asked.some(a => a.modeId === 'longterm' && a.kind !== 'pick'), 'no follow-ups for a roll');
  const logged = h.logs.filter(e => e.mode === 'longterm');
  assert.deepEqual([logged.length, logged[0].source, logged[0].moves], [1, 'solver', []]);
});

test('an alternative that sells a protected player reverts the card to the engine\'s', async t => {
  const { error } = quiet();
  const engine = engineOf(scenario({ candidates: CANDIDATES, locks: new Set([13]) }));
  const h = harness(t, { engine, solve: ({ kind, n }) => {
    if (kind === 'pick') return sells(10, [14], [101]);
    if (kind === 'alt') return n === 1 ? sells(9.5, [13], [102]) : null;
    return sells(1, [], []);
  } });
  h.refresh();
  await flush();
  assert.ok(error.mock.calls.some(c => /sold protected player 13/.test(c.arguments.join())));
  const now = h.of('now').at(-1);
  assert.deepEqual([now.source, now.state], ['engine', 'ready']);
});

test('a plan that calls a move but has no legal order keeps the engine\'s card', async t => {
  const { warn } = quiet();
  // 101 is £6.0m against 15's £5.0m, with no bank: the sale cannot be made.
  const engine = engineOf(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12, price: 60 }] }));
  const h = harness(t, { engine, solve: ({ kind }) => (kind === 'pick' ? sells(10, [15], [101]) : sells(1, [], [])) });
  h.refresh();
  await flush();
  assert.deepEqual([h.of('now').at(-1).source, h.of('now').at(-1).state], ['engine', 'ready']);
  assert.ok(warn.mock.calls.some(c => /legal order/.test(c.arguments.join())));
});

// ─── Which modes solve ───────────────────────────────────────────────────────

test('a pick whose moves can only be made in part, one at a time, is not shown beside a figure for the whole plan', async t => {
  const { warn } = quiet();
  // £1.0m in the bank and two £6.0m forwards for two £5.0m ones: the first swap is legal, the second is not, until the
  // first has been made - and it cannot be, with the first one's money spent.
  const engine = engineOf(scenario({ bankTenths: 10, freeTransfers: 2, candidates: [
    { id: 101, position: 'FWD', xip: 12, price: 60 }, { id: 102, position: 'FWD', xip: 11, price: 60 }] }));
  const h = harness(t, { engine, solve: ({ kind }) => (kind === 'pick' ? sells(10, [14, 15], [101, 102]) : kind === 'rolling' ? sells(3, [], []) : null) });
  h.refresh();
  await flush();
  for (const modeId of MODE_IDS) {
    const last = h.of(modeId).at(-1);
    assert.deepEqual([last.source, last.state], ['engine', 'ready'], modeId);
    assert.ok(h.of(modeId).every(c => c.source !== 'solver'), `${modeId}: a part of the plan was shown`);
  }
  assert.ok(warn.mock.calls.some(c => /legal order/.test(c.arguments.join())));
  // The rolling twin is asked for before the order is checked (settlePick checks it with the tie); nothing after it is.
  assert.equal(h.asked.filter(a => a.kind !== 'pick' && a.kind !== 'rolling').length, 0, 'no follow-up solves for a plan that is not shown');
});

test('an alternative that cannot be made one move at a time is left out, and not re-scored', async t => {
  const { warn } = quiet();
  // The pick (15 for the £5.0m 103) is legal. The alternative of two £6.0m forwards is not, with £1.0m to spend.
  const engine = engineOf(scenario({ bankTenths: 10, freeTransfers: 2, candidates: [
    { id: 101, position: 'FWD', xip: 12, price: 60 }, { id: 102, position: 'FWD', xip: 11, price: 60 }, { id: 103, position: 'FWD', xip: 10 }] }));
  const h = harness(t, { engine, solve: ({ kind, n }) => {
    if (kind === 'pick') return sells(10, [15], [103]);
    if (kind === 'rolling') return sells(3, [], []);
    return n === 1 ? sells(9.5, [14, 15], [101, 102]) : n === 2 ? sells(9.2, [13], [103]) : null;
  } });
  h.refresh();
  await flush();
  const { alternatives, key } = h.of('now').at(-1);
  assert.equal(alternatives.key, key);
  assert.deepEqual(alternatives.value.map(a => a.key), ['13>103'], 'only the alternative that can be made');
  assert.ok(warn.mock.calls.some(c => /legal order/.test(c.arguments.join())));
  const { candidates } = h.posted.find(m => m.modeId === 'now');
  assert.ok(!candidates.some(c => c.key === '14,15>101,102'));
});

test('Ceiling in a big week stays the engine\'s, marked engine-tail; a mode with no weeks rolls without a solve', async t => {
  // A double at the peak week for a squad player: the engine's upper tail scores Ceiling, which the solver cannot.
  const input = (() => {
    const base = withDraws(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 8 }, { id: 102, position: 'FWD', xip: 7.9 }] }), { 102: { goals: 3, share: 0.5 } });
    const projections = new Map(base.projections);
    const p = projections.get(3);
    projections.set(3, { ...p, gws: p.gws.map((g, i) => (i === 0 ? { ...g, fixtures: 2 } : g)) });
    return { ...base, projections };
  })();
  const engine = engineOf(input);
  assert.equal(engine.result.modes.ceiling.bigWeek, true);
  const h = harness(t, { engine, solve: agree });
  h.refresh();
  await flush();
  assert.deepEqual(h.of('ceiling').map(c => [c.source, c.state]), [['engine-tail', 'ready']]);
  assert.ok(!h.asked.some(a => a.modeId === 'ceiling'));
  assert.equal(h.of('ceiling')[0].root, engine.result.modes.ceiling.root);
  const tail = h.logs.filter(e => e.mode === 'ceiling');
  assert.deepEqual(tail.map(e => [e.source, e.call, e.gain]), [['engine-tail', engine.result.modes.ceiling.call, engine.result.modes.ceiling.root?.outScore ?? null]]);
  assert.equal(h.of('now').at(-1).source, 'solver');

  // Every GW covered by a Wildcard: no mode weighs anything, so each rolls as the engine has it, with no solve.
  const covered = engineOf(scenario({ chipPlan: { [GW]: 'wildcard' }, candidates: CANDIDATES }));
  const none = harness(t, { engine: covered, solve: agree });
  none.refresh();
  await flush();
  assert.equal(none.asked.length, 0);
  assert.equal(none.made.length, 0, 'and no worker is made for it');
  for (const modeId of MODE_IDS) assert.deepEqual(none.of(modeId).map(c => [c.source, c.state, c.call]), [['engine', 'ready', 'roll']], modeId);
});

test('a mode the solver is off for keeps the engine\'s move, with no solve; as shipped, Now and Ceiling are off', async t => {
  const config = { ...CONFIG, solver: { ...CONFIG.solver, modes: { ...CONFIG.solver.modes, now: { enabled: false, hitMargin: 0 } } } };
  const engine = engineOf(scenario({ candidates: CANDIDATES }));
  const h = harness(t, { engine, config, solve: agree });
  h.refresh();
  await flush();
  assert.deepEqual(h.of('now').map(c => [c.source, c.state]), [['engine', 'ready']]);
  assert.equal(h.of('now')[0].root, engine.result.modes.now.root);
  assert.ok(!h.asked.some(a => a.modeId === 'now'), 'no solve for it');
  assert.equal(h.of('longterm').at(-1).source, 'solver', 'the others still solve');
  assert.deepEqual(h.logs.filter(e => e.mode === 'now').map(e => [e.source, e.guard]), [['engine', 'engine']]);
  // As shipped: the solver on, and on for the four modes that passed Phase 4's headline.
  assert.equal(DECISION_ENGINE.solver.enabled, true);
  assert.deepEqual(Object.entries(DECISION_ENGINE.solver.modes).filter(([, m]) => m.enabled).map(([id]) => id).sort(),
    ['funds', 'future', 'longterm', 'structure']);
});

test('on a phone one worker, and only viewed cards solve, in the order viewed', async t => {
  const h = harness(t, { phone: true, solve: agree });
  h.refresh();
  await flush();
  // Nothing is viewed yet: every card is the engine's, ready, and nothing was asked of a worker.
  assert.equal(h.asked.length, 0);
  assert.equal(h.made.length, 0, 'and no worker made for it');
  for (const modeId of MODE_IDS) assert.deepEqual(h.of(modeId).map(c => [c.source, c.state]), [['engine', 'ready']], modeId);

  h.runner.view('structure');
  h.runner.view('now');
  h.runner.view('structure');
  await flush();
  const picks = h.asked.filter(a => a.kind === 'pick').map(a => a.modeId);
  assert.deepEqual(picks, ['structure', 'now']);
  assert.deepEqual(h.of('structure').map(c => [c.source, c.state]).slice(0, 2), [['engine', 'ready'], ['engine', 'refining']]);
  assert.equal(h.of('structure').find(c => c.source === 'solver').state, 'ready');
  assert.deepEqual(h.of('longterm').map(c => c.source), ['engine'], 'a card nobody looked at is never solved');
  assert.equal(h.made.length, 1, 'one worker on a phone');
});

test('on a phone a viewed card solves again after the input changes; one viewed first is first', async t => {
  const h = harness(t, { phone: true, solve: agree });
  h.runner.view('future');
  h.runner.view('now');
  h.refresh();
  await flush();
  assert.deepEqual(h.asked.filter(a => a.kind === 'pick').map(a => a.modeId), ['future', 'now']);
  h.asked.length = 0;
  h.refresh(h.engine, 2);
  await flush();
  assert.deepEqual(h.asked.filter(a => a.kind === 'pick').map(a => a.modeId), ['future', 'now']);
});

test('off a phone all six solve, Now first then the config\'s order, and the picks before any follow-up', async t => {
  const h = harness(t, { solve: agree, cores: 2 });   // one worker, so the order is the queue's
  h.refresh();
  await flush();
  const kinds = h.asked.map(a => a.kind);
  assert.deepEqual(h.asked.filter(a => a.kind === 'pick').map(a => a.modeId), MODE_IDS);
  const lastPick = kinds.lastIndexOf('pick');
  assert.ok(kinds.slice(0, lastPick + 1).every(k => k === 'pick'), 'every pick before any rolling solve or alternative');
  assert.ok(kinds.slice(lastPick + 1).some(k => k === 'rolling') && kinds.slice(lastPick + 1).some(k => k === 'alt'));
});

// ─── The follow-ups ──────────────────────────────────────────────────────────

test('the gain over rolling is the pick less the rolling plan, and lands on the card', async t => {
  const h = harness(t, { solve: ({ kind, n, problem }) => {
    if (kind === 'rolling') {
      assert.deepEqual(problem.fixed.first, { in: [], out: [] });
      return sells(4.25, [], []);
    }
    return agree({ kind, n });
  } });
  h.refresh();
  await flush();
  const now = h.of('now').at(-1);
  assert.deepEqual([now.gain.key, now.gain.value], [now.key, 10 - 4.25]);
});

test('a pick settles only once its rolling solve has landed: refining until then, with its gain on the card', async t => {
  const gate = Promise.withResolvers();
  const h = harness(t, { solve: ({ kind, n, modeId }) => (kind === 'rolling' && modeId === 'now' ? gate.promise.then(() => sells(4, [], [])) : agree({ kind, n })) });
  h.refresh();
  await flush();
  // Every other mode has settled; Now's pick has landed but its rolling solve has not: its card is still the engine's.
  assert.deepEqual(h.of('now').map(c => [c.source, c.state]), [['engine', 'refining']]);
  assert.equal(h.of('longterm').at(-1).source, 'solver');
  assert.ok(h.logs.every(e => e.mode !== 'now'), 'and nothing is logged for it');
  gate.resolve();
  await flush();
  const now = h.of('now');
  assert.deepEqual([now[1].source, now[1].state, now[1].call, now[1].gain], ['solver', 'ready', 'move', { key: '15>101|1', value: 6 }]);
});

test('a pick that gains no more than the solver\'s tolerance over rolling is a roll, with its later weeks kept and the engine\'s move named', async t => {
  // A sideways swap that frees money and nothing else: the plan "gains" a tenth over rolling, inside the gap.
  const { absGap } = CONFIG.solver;
  const pick = plan(10, week(GW, [14], [102]), week(GW + 1, [15], [101]), week(GW + 2));
  const h = harness(t, { solve: ({ kind, modeId, n }) => {
    if (modeId !== 'now' && modeId !== 'longterm') return agree({ kind, n });
    return kind === 'pick' ? pick : kind === 'rolling' ? sells(10 - (modeId === 'now' ? 0.1 : absGap), [], []) : null;
  } });
  h.refresh();
  await flush();
  const now = h.of('now').at(-1);
  assert.deepEqual([now.source, now.state, now.call, now.moves, now.root, now.hits], ['solver', 'ready', 'roll', [], null, 0]);
  assert.deepEqual(now.later, [{ gw: GW + 1, moves: [{ outId: 15, inId: 101 }] }], 'the plan\'s tentative later weeks stay');
  assert.deepEqual([now.updated, now.replaced], [true, h.engine.result.modes.now.root], 'the engine\'s move it replaced is named');
  assert.equal(now.key, '|1');
  // A gain of exactly the tolerance is not above it.
  assert.equal(h.of('longterm').at(-1).call, 'roll');
  // A roll has no figures to calculate: no alternatives or re-scoring for it.
  assert.ok(!h.asked.some(a => a.kind === 'alt' && (a.modeId === 'now' || a.modeId === 'longterm')));
  assert.ok(!h.posted.some(m => m.modeId === 'now' || m.modeId === 'longterm'));
  // It is logged as the roll it is.
  const logged = h.logs.filter(e => e.mode === 'now');
  assert.deepEqual([logged.length, logged[0].source, logged[0].call, logged[0].moves, logged[0].agrees], [1, 'solver', 'roll', [], false]);
  assert.equal(h.of('future').at(-1).call, h.engine.result.modes.future.call, 'a clear gain elsewhere is unaffected');
});

test('a pick just above the tolerance is the move, and a pick that waits does not wait for its rolling twin, which runs in the background', async t => {
  const { absGap } = CONFIG.solver;
  const h = harness(t, { solve: ({ kind, modeId, n }) => {
    if (kind === 'pick' && modeId === 'now') return sells(10, [15], [101]);
    if (kind === 'rolling' && modeId === 'now') return sells(10 - absGap - 0.01, [], []);
    if (kind === 'pick' && modeId === 'longterm') return plan(5, week(GW), week(GW + 1, [15], [101]), week(GW + 2));
    if (kind === 'rolling' && modeId === 'longterm') return NEVER;
    return agree({ kind, n });
  } });
  h.refresh();
  await flush();
  const now = h.of('now').at(-1);
  assert.deepEqual([now.call, now.moves.length], ['move', 1]);
  assert.ok(Math.abs(now.gain.value - (absGap + 0.01)) < 1e-9);
  // Its first week is rolling already: the rolling twin of a wait is the wait, so its card does not wait for the twin
  // (asked in the background, and here never answered).
  const wait = h.of('longterm').at(-1);
  assert.deepEqual([wait.source, wait.state, wait.call], ['solver', 'ready', 'wait']);
});

test('where the rolling solve fails, the mode keeps the engine\'s card, marked engine, and asks for nothing more', async t => {
  const { warn } = quiet();
  for (const rolling of [() => null, () => { throw new Error('HiGHS returned "Infeasible"'); }]) {
    const h = harness(t, { solve: ({ kind, modeId, n }) => (kind === 'rolling' && modeId === 'now' ? rolling() : agree({ kind, n })) });
    h.refresh();
    await flush();
    const now = h.of('now');
    assert.deepEqual(now.map(c => [c.source, c.state]), [['engine', 'refining'], ['engine', 'ready']]);
    assert.equal(now.at(-1).root, h.engine.result.modes.now.root);
    assert.ok(!h.asked.some(a => a.kind === 'alt' && a.modeId === 'now'), 'no alternatives for a card kept as the engine\'s');
    assert.equal(h.of('longterm').at(-1).source, 'solver', 'the other modes are unaffected');
    const logged = h.logs.filter(e => e.mode === 'now');
    assert.deepEqual([logged.length, logged[0].source], [1, 'engine']);
  }
  assert.ok(warn.mock.calls.some(c => /Infeasible/.test(c.arguments.join())));
});

test('alternatives are the re-solves with the first weeks found so far excluded, their moves ordered, gains against the pick', async t => {
  const h = harness(t, { solve: ({ kind, n, problem }) => {
    if (kind === 'alt') {
      assert.equal(problem.exclude.length, n);
      return n === 1 ? sells(9.5, [14, 15], [101, 102]) : n === 2 ? sells(9.2, [], []) : null;
    }
    return kind === 'rolling' ? sells(4, [], []) : sells(10, [15], [101]);
  } });
  h.refresh();
  await flush();
  const { alternatives, key } = h.of('now').at(-1);
  assert.equal(alternatives.key, key);
  assert.equal(alternatives.value.length, 2);
  assert.deepEqual(alternatives.value.map(a => a.moves.length), [2, 0], 'the second alternative is rolling');
  assert.deepEqual(alternatives.value.map(a => Math.round(a.gain * 100) / 100), [-0.5, -0.8]);
  assert.deepEqual(alternatives.value[0].moves.map(m => m.outId).sort((a, b) => a - b), [14, 15]);
  assert.equal(alternatives.value[1].key, '');
});

test('robustness re-scores the pick against its alternatives, the engine\'s move and rolling, on the robustness worker', async t => {
  const h = harness(t, { solve: ({ kind, n, modeId }) => (kind === 'pick' && modeId === 'now' ? sells(10, [14], [102])
    : kind === 'alt' && modeId === 'now' ? (n === 1 ? sells(9.5, [13], [101]) : null) : agree({ kind, n })) });
  h.refresh();
  await flush();
  assert.equal(h.rescorers.length, 1, 'one worker, made on first use');
  const message = h.posted.find(m => m.modeId === 'now');
  const card = h.of('now').at(-1);
  assert.equal(message.kind, 'rescore');
  assert.equal(message.key, `now|${card.key}`, 'the card\'s key and its mode: several modes make the same move');
  assert.equal(message.pickKey, '14>102');
  assert.deepEqual(message.weights, h.engine.result.modes.now.weights);
  assert.deepEqual(message.candidates.map(c => c.key), ['14>102', '13>101', '15>101', '']);
  assert.deepEqual(message.candidates.map(c => c.moves.length), [1, 1, 1, 0]);
  assert.deepEqual(Object.keys(message.input).sort(), ['chipPlan', 'freeTransfers', 'planningGw', 'projections', 'squad']);
  assert.deepEqual([card.robustness.key, card.robustness.value], [card.key, 0.75]);
});

test('each mode gets its own share, though several modes make the same move', async t => {
  const h = harness(t, { solve: agree, rescore: message => (MODE_IDS.indexOf(message.modeId) + 1) / 10 });
  h.refresh();
  await flush();
  const moves = MODE_IDS.map(modeId => h.of(modeId).at(-1).key);
  assert.ok(new Set(moves).size < MODE_IDS.length, 'the fixture makes the same move in more than one mode');
  for (const modeId of MODE_IDS) assert.equal(h.of(modeId).at(-1).robustness.value, (MODE_IDS.indexOf(modeId) + 1) / 10, modeId);
});

test('the engine\'s Funds chained move is part of the engine candidate', async t => {
  // Selling MID 10 for MID 109 frees the money that lets FWD 14 become FWD 111: the engine's Funds move is both.
  const engine = engineOf(scenario({
    changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }],
    freeTransfers: 2,
  }));
  const { root } = engine.result.modes.funds;
  assert.deepEqual([root.outId, root.inId, root.chained.outId, root.chained.inId], [10, 109, 14, 111]);
  const h = harness(t, { engine, solve: ({ kind }) => (kind === 'pick' ? sells(10, [10], [109]) : sells(1, [], [])) });
  h.refresh();
  await flush();
  const { candidates, pickKey } = h.posted.find(m => m.modeId === 'funds');
  assert.equal(pickKey, '10>109');
  const theirs = candidates.find(c => c.key === '10,14>109,111');
  assert.deepEqual(theirs.moves.map(m => [m.outId, m.inId]), [[10, 109], [14, 111]]);
});

test('the engine\'s whole recommendation, a Funds root and its chained move, is what a solver move is compared with and logged against', async t => {
  const engine = engineOf(scenario({
    changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }],
    freeTransfers: 2,
  }));
  const { root } = engine.result.modes.funds;
  assert.deepEqual([root.outId, root.inId, root.chained.outId, root.chained.inId], [10, 109, 14, 111]);

  // A two-move first week that is exactly the engine's two moves: the engine's card, not updated, agreeing.
  const same = harness(t, { engine, solve: ({ kind }) => (kind === 'pick' ? sells(10, [10, 14], [109, 111]) : sells(1, [], [])) });
  same.refresh();
  await flush();
  const card = same.of('funds').find(c => c.source === 'solver');
  assert.deepEqual([card.updated, card.replaced], [false, undefined]);
  assert.equal(card.root, root, 'the engine\'s own text stays');
  assert.equal(card.moves.length, 2);
  const [settled] = same.logs.filter(e => e.mode === 'funds');
  assert.deepEqual(settled.engineFirst, [{ outId: 10, inId: 109 }, { outId: 14, inId: 111 }]);
  assert.deepEqual([settled.source, settled.agrees], ['solver', true]);
  assert.ok(same.logs.filter(e => e.mode === 'funds').every(e => e.agrees), 'and when its figures land');

  // The root alone is not the engine's recommendation: marked updated, and the log disagrees.
  const rootOnly = harness(t, { engine, solve: ({ kind }) => (kind === 'pick' ? sells(10, [10], [109]) : sells(1, [], [])) });
  rootOnly.refresh();
  await flush();
  const less = rootOnly.of('funds').find(c => c.source === 'solver');
  assert.deepEqual([less.updated, less.replaced], [true, root]);
  const [logged] = rootOnly.logs.filter(e => e.mode === 'funds');
  assert.deepEqual([logged.agrees, logged.engineFirst.length], [false, 2]);
});

test('a rescore that fails settles the robustness as unavailable, never pending', async t => {
  quiet();
  const h = harness(t, { solve: agree, rescore: () => { throw new Error('malformed rescore'); } });
  h.refresh();
  await flush();
  const now = h.of('now').at(-1);
  assert.deepEqual([now.robustness.key, now.robustness.value], [now.key, null]);
});

test('the robustness worker is made on first use, and where there is none the figure settles unavailable', async t => {
  quiet();
  const h = harness(t, { solve: agree });
  const w = world({ solve: agree, engine: h.engine });
  const cards = [];
  const runner = createSolverRunner({ config: CONFIG, makeWorker: w.makeWorker, makeRescoreWorker: () => { throw new ReferenceError('no Worker'); },
    isPhone: () => false, hardwareConcurrency: 4, onCard: (modeId, card) => cards.push({ modeId, card }) });
  t.after(() => runner.stop());
  runner.refresh(h.engine.input, h.engine.result, 1, h.engine.cache);
  await flush();
  const now = cards.filter(c => c.modeId === 'now').at(-1).card;
  assert.equal(now.source, 'solver');
  assert.equal(now.robustness.value, null);
});

test('a refresh ends a rescore still waiting, so a fast sequence does not queue behind it', async t => {
  const h = harness(t, { solve: agree, rescore: () => NEVER });
  h.refresh();
  await flush();
  assert.equal(h.rescorers.length, 1);
  h.refresh(h.engine, 2);
  assert.equal(h.rescorers[0].terminated, true);
  await flush();
  assert.equal(h.rescorers.length, 2, 'a fresh one, made when it is next needed');
});

// ─── The guard ───────────────────────────────────────────────────────────────

/** Now's first pick, asked for at the first limit. */
const firstNow = ask => ask.kind === 'pick' && ask.modeId === 'now' && ask.limit === timeLimitS;

test('a pick short of its bound keeps the engine\'s card refining, then shows the longer solve\'s move', async t => {
  const gate = Promise.withResolvers();
  // The 3 s plan sells 14 for 102 and is 5 points short of its bound; the 10 s one is optimal and sells 15 for 101.
  const h = harness(t, { stopped: firstNow, gap: ask => (firstNow(ask) ? 5 : 0), solve: ask => {
    if (ask.kind === 'pick' && ask.modeId === 'now') return firstNow(ask) ? sells(10, [14], [102]) : gate.promise.then(() => sells(10, [15], [101]));
    return agree(ask);
  } });
  h.refresh();
  await flush();
  // Every other mode has settled; Now's short plan has landed and is not shown: the engine's card, still refining.
  assert.deepEqual(h.of('now').map(c => [c.source, c.state]), [['engine', 'refining']]);
  assert.ok(h.logs.every(e => e.mode !== 'now'), 'and nothing is logged for it');
  const nowPicks = h.asked.filter(a => a.kind === 'pick' && a.modeId === 'now');
  assert.deepEqual(nowPicks.map(a => a.limit), [timeLimitS, resolveTimeLimitS], 'one re-solve of the same problem, at the longer limit');
  assert.deepEqual(nowPicks[1].problem, nowPicks[0].problem);
  // It is queued a tier after every first pick, and before any follow-up (alternatives, gain, robustness).
  const at = ask => h.asked.indexOf(ask);
  const firsts = h.asked.filter(a => a.kind === 'pick' && a.limit === timeLimitS);
  assert.equal(firsts.length, MODE_IDS.length);
  assert.ok(firsts.every(a => at(a) < at(nowPicks[1])), 'after every first pick');
  assert.ok(h.asked.filter(a => a.kind === 'alt').every(a => at(a) > at(nowPicks[1])), 'before the alternatives');

  gate.resolve();
  await flush();
  const now = h.of('now');
  assert.deepEqual(now.slice(0, 2).map(c => [c.source, c.state]), [['engine', 'refining'], ['solver', 'ready']]);
  assert.ok(now.every(c => !String(c.key).startsWith('14>102')), 'the short plan\'s move is never shown');
  assert.equal(now[1].key, '15>101|1');
  assert.deepEqual(now[1].moves.map(m => [m.outId, m.inId]), [[15, 101]]);
  // The rolling twin of the plan that is shown is solved at the same limit as that plan.
  assert.deepEqual(h.asked.filter(a => a.kind === 'rolling' && a.modeId === 'now').map(a => a.limit), [resolveTimeLimitS]);
  assert.equal(h.of('now').filter(c => c.state === 'refining').length, 1);
});

test('a pick proven within absGap is shown at once; one more than absGap short is not shown until a longer solve proves it', async t => {
  for (const gap of [0, absGap, absGap + 0.01]) {
    const h = harness(t, { stopped: firstNow, gap: ask => (firstNow(ask) ? gap : 0), solve: ({ kind, modeId, n, limit }) => (
      kind === 'pick' && modeId === 'now' ? sells(10, [15], [101]) : agree({ kind, n, limit })) });
    h.refresh();
    await flush();
    const picks = h.asked.filter(a => a.kind === 'pick' && a.modeId === 'now');
    const now = h.of('now');
    if (gap <= absGap) {
      assert.deepEqual(picks.map(a => a.limit), [timeLimitS], `gap ${gap}: no second solve`);
      assert.deepEqual([now[1].source, now[1].guard, now[1].gap], ['solver', 'trusted', gap]);
    } else {
      assert.deepEqual(picks.map(a => a.limit), [timeLimitS, resolveTimeLimitS], `gap ${gap}: re-solved`);
      assert.deepEqual([now[1].source, now[1].guard, now[1].gap], ['solver', 'resolved', 0]);
    }
  }
});

test('a re-solve still short, failing or timing out ends on the engine\'s card, not refining', async t => {
  quiet();
  const config = { ...CONFIG, solver: { ...CONFIG.solver, resolveTimeLimitS: 0.01, timeoutMarginS: 0.02 } };
  const resolves = {
    'still short': () => sells(10, [15], [101]),
    'no plan': () => null,
    'an error': () => { throw new Error('HiGHS returned "Infeasible"'); },
    'no answer in time': () => NEVER,
  };
  for (const [name, resolve] of Object.entries(resolves)) {
    // Now's pick stops short of its bound at both limits (when it answers at all).
    const h = harness(t, { config, stopped: ask => ask.kind === 'pick' && ask.modeId === 'now', gap: ask => (ask.kind === 'pick' && ask.modeId === 'now' ? 5 : 0),
      solve: ask => (ask.kind === 'pick' && ask.modeId === 'now' ? (ask.limit === timeLimitS ? sells(10, [14], [102]) : resolve()) : agree(ask)) });
    h.refresh();
    await new Promise(resolve => setTimeout(resolve, 80));
    await flush();
    const now = h.of('now');
    assert.deepEqual(now.map(c => [c.source, c.state]), [['engine', 'refining'], ['engine', 'ready']], name);
    assert.equal(now.at(-1).root, h.engine.result.modes.now.root, name);
    assert.equal(h.asked.filter(a => a.kind === 'pick' && a.modeId === 'now').length, 2, `${name}: one re-solve, no more`);
    assert.ok(!h.asked.some(a => a.modeId === 'now' && a.kind !== 'pick'), `${name}: no follow-ups for a card kept as the engine's`);
    assert.deepEqual(h.logs.filter(e => e.mode === 'now').map(e => [e.source, e.guard, e.gap]), [['engine', 'engine', null]], name);
    assert.equal(h.of('longterm').at(-1).source, 'solver', `${name}: the other modes are unaffected`);
  }
});

test('a re-solve answer for a superseded input is ignored, and asks for nothing more', async t => {
  const gate = Promise.withResolvers();
  const first = engineOf(scenario({ candidates: CANDIDATES }));
  const second = engineOf(scenario({ candidates: CANDIDATES, bankTenths: 5 }));
  const v1 = ask => ask.problem.bankTenths === 0;
  const h = harness(t, { engine: first, stopped: ask => v1(ask) && firstNow(ask), gap: ask => (v1(ask) && firstNow(ask) ? 5 : 0), solve: ask => {
    if (ask.kind !== 'pick' || ask.modeId !== 'now') return agree(ask);
    if (!v1(ask)) return sells(10, [15], [101]);
    return firstNow(ask) ? sells(10, [14], [102]) : gate.promise.then(() => sells(10, [14], [102]));
  } });
  h.refresh(first, 1);
  await flush();
  assert.deepEqual(h.of('now').map(c => c.state), ['refining'], 'v1\'s re-solve is on its way');
  const before = h.cards.length;
  h.refresh(second, 2);
  gate.resolve();
  await flush();
  // v1's answer arrives for a run that is over: no card, no log, and no rolling twin or alternatives asked for.
  for (const { card } of h.cards.slice(before)) assert.ok(!String(card.key).endsWith('|1'), `key ${card.key}`);
  assert.ok(!h.asked.some(a => v1(a) && a.modeId === 'now' && a.kind !== 'pick'));
  const now = h.of('now').at(-1);
  assert.deepEqual([now.source, now.state, now.key], ['solver', 'ready', '15>101|2']);
});

test('figures land only on the shown move after a re-solve', async t => {
  // The 3 s plan (sell 14 for 102) is short of its bound; the re-solve's (sell 15 for 101) is the card.
  const h = harness(t, { stopped: firstNow, gap: ask => (firstNow(ask) ? 5 : 0), solve: ask => {
    if (ask.kind === 'pick' && ask.modeId === 'now') return firstNow(ask) ? sells(10, [14], [102]) : sells(10, [15], [101]);
    return agree(ask);
  } });
  h.refresh();
  await flush();
  const now = h.of('now');
  // Every figure on every Now card is the one computed for that card's own move set.
  for (const card of now) {
    for (const name of ['gain', 'alternatives', 'robustness']) {
      if (card[name]) assert.equal(card[name].key, card.key, `${name} on ${card.key}`);
    }
  }
  const last = now.at(-1);
  assert.equal(last.key, '15>101|1');
  assert.deepEqual([last.gain.value, last.alternatives.value.length, last.robustness.value], [6, 1, 0.75]);
  // Its alternatives were found by excluding the shown plan's first week, and it was re-scored as the pick.
  const alts = h.asked.filter(a => a.kind === 'alt' && a.modeId === 'now');
  assert.deepEqual(alts[0].problem.exclude, [{ in: [101], out: [15] }]);
  const rescored = h.posted.filter(m => m.modeId === 'now');
  assert.deepEqual(rescored.map(m => [m.key, m.pickKey]), [['now|15>101|1', '15>101']]);
  assert.ok(!rescored.some(m => m.candidates.some(c => c.key === '14>102')), 'the short plan is not a candidate');
  // The short plan had no card, so a share that arrives for its key has nothing to land on.
  h.rescorers[0].onmessage({ data: { kind: 'rescore', key: 'now|14>102|1', share: 0.9 } });
  await flush();
  assert.ok(h.cards.every(c => c.card.robustness?.value !== 0.9));
});

test('the log says trusted, resolved or engine, with the gap of the plan shown', async t => {
  quiet();
  const stoppedAt = { now: 'first', longterm: 'always', future: 'always' };
  const stopped = ask => ask.kind === 'pick' && (stoppedAt[ask.modeId] === 'always' || (stoppedAt[ask.modeId] === 'first' && ask.limit === timeLimitS));
  const gapOf = ask => {
    if (ask.kind !== 'pick') return 0;
    // Now: short at 3 s, 0.25 from its bound at 10 s. Long term: 0.4 from its bound at 3 s (within absGap). Future: short always.
    return { now: ask.limit === timeLimitS ? 5 : 0.25, longterm: 0.4, future: 5 }[ask.modeId] ?? 0;
  };
  const h = harness(t, { stopped, gap: gapOf, solve: agree });
  h.refresh();
  await flush();
  const entries = mode => h.logs.filter(e => e.mode === mode);
  assert.deepEqual(entries('now').map(e => [e.source, e.guard, e.gap]).at(0), ['solver', 'resolved', 0.25]);
  assert.deepEqual(entries('longterm').map(e => [e.source, e.guard, e.gap]).at(0), ['solver', 'trusted', 0.4]);
  assert.deepEqual(entries('future').map(e => [e.source, e.guard, e.gap]), [['engine', 'engine', null]]);
  assert.deepEqual(entries('funds').map(e => [e.source, e.guard, e.gap]).at(0), ['solver', 'trusted', 0], 'an optimal solve is trusted');
  // Every entry, as its figures land, keeps the guard of its card; an engine card, whatever its source, is the engine's.
  for (const e of h.logs) {
    if (e.source === 'solver') assert.ok(['trusted', 'resolved'].includes(e.guard), `${e.mode}: ${e.guard}`);
    else assert.deepEqual([e.guard, e.gap], ['engine', null], e.mode);
  }
  assert.ok(entries('now').every(e => e.guard === 'resolved'));
});

// ─── The log ─────────────────────────────────────────────────────────────────

test('every settled card is logged with its fields, and a figure landing later logs again', async t => {
  const h = harness(t, { solve: ({ kind, modeId, n }) => (kind === 'pick' && modeId === 'now' ? sells(10, [14], [102]) : agree({ kind, n })) });
  h.refresh();
  await flush();
  const now = h.logs.filter(e => e.mode === 'now');
  // Settled with its gain over rolling, then the robustness landed.
  assert.deepEqual(now.map(e => [e.gain, e.robustness]), [[6, null], [6, 0.75]]);
  const entry = now[0];
  assert.deepEqual(Object.keys(entry).sort(), ['agrees', 'at', 'call', 'engineFirst', 'gain', 'gap', 'guard', 'gw', 'mode', 'moves', 'robustness', 'source', 'stopped'].sort());
  assert.deepEqual([entry.gw, entry.mode, entry.source, entry.call, entry.stopped], [GW, 'now', 'solver', 'move', false]);
  assert.deepEqual(entry.moves, [{ outId: 14, inId: 102 }]);
  assert.deepEqual(entry.engineFirst, [{ outId: 15, inId: 101 }]);
  assert.equal(entry.agrees, false);
  assert.ok(Number.isFinite(entry.at));
  const longterm = h.logs.filter(e => e.mode === 'longterm');
  assert.equal(longterm[0].agrees, true);
});

test('a fallback and a card kept as the engine\'s are logged too', async t => {
  const h = harness(t, { solve: () => null });
  h.refresh();
  await flush();
  const logged = new Map(h.logs.map(e => [e.mode, e]));
  assert.deepEqual([...logged.keys()].sort(), [...MODE_IDS].sort());
  for (const [mode, e] of logged) {
    const engine = h.engine.result.modes[mode];
    // An engine card logs its own call and its root's score as the gain; a roll has none, and no solve stopped for it.
    assert.deepEqual([e.source, e.call, e.stopped, e.agrees, e.robustness], ['engine', engine.call, false, true, null], mode);
    assert.equal(e.gain, engine.root ? engine.root.outScore : null, mode);
  }
  assert.ok([...logged.values()].some(e => e.gain !== null) && [...logged.values()].some(e => e.call === 'roll'), 'the fixture has both');
});

test('a solve that stopped at its limit says so on its card and in its log; a card that never solved says it did not', async t => {
  const h = harness(t, { solve: agree, stopped: ({ kind, modeId }) => kind === 'pick' && (modeId === 'now' || modeId === 'future') });
  h.refresh();
  await flush();
  // A field of the card, not shown; every state of a solver card carries the pick's.
  for (const modeId of ['now', 'future']) {
    assert.ok(h.of(modeId).filter(c => c.source === 'solver').every(c => c.stopped === true), modeId);
    assert.ok(h.logs.filter(e => e.mode === modeId).every(e => e.stopped === true), `${modeId} log`);
  }
  assert.ok(h.logs.filter(e => e.mode === 'longterm').every(e => e.stopped === false));
  // The pick's own solve is the one that counts: a rolling twin or an alternative that stopped does not mark the card.
  const follow = harness(t, { solve: agree, stopped: ({ kind }) => kind !== 'pick' });
  follow.refresh();
  await flush();
  assert.ok(follow.logs.every(e => e.stopped === false));
});

test('a wait and a roll are logged as what they are', async t => {
  const h = harness(t, { solve: ({ kind, modeId, n }) => {
    if (kind !== 'pick') return agree({ kind, n });
    if (modeId === 'longterm') return plan(5, week(GW), week(GW + 1, [15], [101]), week(GW + 2));
    if (modeId === 'future') return plan(5, week(GW), week(GW + 1), week(GW + 2), week(GW + 3), week(GW + 4));
    return agree({ kind, n });
  } });
  h.refresh();
  await flush();
  const wait = h.logs.find(e => e.mode === 'longterm');
  assert.deepEqual([wait.call, wait.moves, wait.source], ['wait', [{ outId: 15, inId: 101 }], 'solver']);
  const roll = h.logs.find(e => e.mode === 'future');
  assert.deepEqual([roll.call, roll.moves, roll.gain], ['roll', [], null]);
});

// ─── The lifecycle ───────────────────────────────────────────────────────────

test('stop ends every worker and drops what was queued', async t => {
  const h = harness(t, { solve: () => NEVER });
  h.refresh();
  await flush(5);
  h.runner.stop();
  assert.ok(h.made.every(w => w.terminated));
  const painted = h.cards.length;
  await flush();
  assert.equal(h.cards.length, painted);
});

test('nothing is dispatched or pooled after stop, though an answer was already on its way to a flow that wants another solve', async t => {
  // The first alternative's answer has been handed to the page when stop() is called: the loop that asked for it goes on
  // to ask for the second.
  const h = harness(t, { solve: agree, afterAnswer: ask => { if (ask.kind === 'alt' && ask.n === 1 && !stopped) { stopped = true; h.runner.stop(); mark = [h.made.length, h.asked.length]; } } });
  let stopped = false;
  let mark = null;
  h.refresh();
  await flush();
  assert.ok(stopped, 'the scripted stop happened');
  assert.deepEqual([h.made.length, h.asked.length], mark, 'no new pool, no new solve');
  assert.ok(h.made.every(w => w.terminated));
});

test('a card that throws in the planner does not stop the others', async t => {
  quiet();
  const w = world({ solve: agree, engine: engineOf(scenario({ candidates: CANDIDATES })) });
  const seen = [];
  const runner = createSolverRunner({ config: CONFIG, makeWorker: w.makeWorker, makeRescoreWorker: w.makeRescoreWorker, isPhone: () => false,
    hardwareConcurrency: 4, onCard: (modeId, card) => { seen.push(modeId); if (modeId === 'now') throw new Error('paint failed'); } });
  t.after(() => runner.stop());
  const e = engineOf(scenario({ candidates: CANDIDATES }));
  assert.doesNotThrow(() => runner.refresh(e.input, e.result, 1, e.cache));
  await flush();
  assert.ok(seen.includes('longterm'));
});

// ─── The phone test ──────────────────────────────────────────────────────────

test('isPhone: a coarse pointer on a narrow screen, few cores or little memory; missing values are not a phone', async () => {
  const { isPhone } = await import('../../js/modules/planner.js');
  const phone = DECISION_ENGINE.solver.phone;
  const env = (over = {}) => ({
    matchMedia: query => ({ matches: query === '(pointer: coarse)' ? over.coarse ?? false : false }),
    innerWidth: over.width ?? 1280,
    navigator: { hardwareConcurrency: over.cores, deviceMemory: over.memory },
  });
  assert.equal(isPhone(env({ coarse: true, width: phone.maxWidthPx, cores: 8, memory: 8 })), true);
  assert.equal(isPhone(env({ coarse: true, width: phone.maxWidthPx + 1, cores: 8, memory: 8 })), false, 'a tablet');
  assert.equal(isPhone(env({ coarse: false, width: 360, cores: 8, memory: 8 })), false, 'a narrow window on a laptop');
  assert.equal(isPhone(env({ cores: phone.minCores - 1 })), true);
  assert.equal(isPhone(env({ cores: phone.minCores })), false);
  assert.equal(isPhone(env({ memory: phone.minMemoryGb - 1 })), true);
  assert.equal(isPhone(env({ memory: phone.minMemoryGb })), false);
  assert.equal(isPhone({}), false, 'nothing known');
  assert.equal(isPhone({ navigator: {} }), false);
});
