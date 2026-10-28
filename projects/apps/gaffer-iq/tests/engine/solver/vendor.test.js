/**
 * tests/engine/solver/vendor.test.js
 * The vendored HiGHS build (assets/vendor/highs/<version>/) and its loader (js/engine/solver/highs.js): the shipped
 * files match the SHA-256 pinned in DECISION_ENGINE.solver.vendor, so a changed file is caught here and refused by the
 * worker; the licence and the README ship with them; the build loads from its bytes; and solveProblem turns each
 * status HiGHS can end on into a plan, no plan, or a throw - with the proven bound and gap of every plan it returns, and
 * the model disposed whatever the ending.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { DECISION_ENGINE } from '../../../js/config.js';
import { runDecisionEngine } from '../../../js/engine/decision.js';
import { loadHighs, solveProblem } from '../../../js/engine/solver/highs.js';
import { buildPlan } from '../../../js/engine/solver/model.js';
import { modeSetting, solverProblem } from '../../../js/engine/solver/problem.js';
import { MODES, scenario } from '../decision-fixtures.js';
import { CONFIG, fakeHighs, loadVendored, problemOf } from './fixtures.js';

const { vendor } = DECISION_ENGINE.solver;
const file = name => new URL(`../../../${vendor.dir}${name}`, import.meta.url);
const sha256 = name => createHash('sha256').update(readFileSync(file(name))).digest('base64');

test('the vendored files match the pinned SHA-256 hashes', () => {
  assert.equal(sha256('highs.mjs'), vendor.mjs);
  assert.equal(sha256('highs.wasm'), vendor.wasm);
});

test('the vendor folder carries the licence and the README', () => {
  for (const name of ['LICENSE', 'README']) assert.ok(existsSync(file(name)), name);
  assert.match(readFileSync(file('LICENSE'), 'utf8'), /^MIT License/);
});

const highs = await loadVendored();
const OPTIONS = { time_limit: DECISION_ENGINE.solver.timeLimitS, mip_abs_gap: DECISION_ENGINE.solver.absGap };

test('the build loads from its bytes, and bytes that are not WebAssembly are refused', async () => {
  assert.equal(typeof highs.solve, 'function');
  assert.equal(typeof highs.createModel, 'function');
  await assert.rejects(loadHighs({ wasmBinary: new Uint8Array([0, 1, 2, 3]) }));
});

test('a build that cannot take the module rejects instead of leaving the load waiting', { timeout: 5000 }, async () => {
  // A valid, empty module: it instantiates, but has none of the exports the build then reads inside its own callback.
  const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await assert.rejects(loadHighs({ wasmBinary: empty }));
});

const { absGap } = DECISION_ENGINE.solver;

/**
 * A pool of 600 candidates over the planner's horizon, as the problem tests build one: Long term's plan of it takes
 * HiGHS a couple of seconds to prove, so a solve at a one second limit stops with a plan in hand and a bound above it.
 */
function bigProblem(modeId) {
  const positions = ['GKP', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD'];
  const input = scenario({ candidates: Array.from({ length: 600 }, (_, i) => ({
    id: 1000 + i, position: positions[i % positions.length], team: 1 + (i % 20), price: 40 + (i % 90), xip: 1 + ((i * 7) % 19) / 2 })) });
  const result = runDecisionEngine(input, CONFIG);
  return solverProblem(input, result, modeSetting(input, result, modeId, CONFIG), CONFIG);
}
// Both gaps zero: nothing but the clock ends the solve.
const NEVER_PROVEN = { mip_abs_gap: 0, mip_rel_gap: 0 };

test('the Model API path decodes the same plan and objective as the legacy solve', () => {
  for (const modeId of MODES) {
    const problem = problemOf(modeId);
    const { lp, decode } = buildPlan(problem);
    const legacy = decode(highs.solve(lp, { output_flag: false, ...OPTIONS }));
    const { plan, stopped } = solveProblem(highs, problem, OPTIONS);
    assert.equal(stopped, false, modeId);
    assert.ok(Math.abs(plan.objective - legacy.objective) < 1e-9, `${modeId}: ${plan.objective} against ${legacy.objective}`);
    assert.deepEqual(plan.weeks, legacy.weeks, modeId);
  }
});

test('solveProblem solves the problem with the options it is given', () => {
  const { plan, stopped, ms } = solveProblem(highs, problemOf(), OPTIONS);
  assert.deepEqual([plan.weeks[0].in, plan.weeks[0].out], [[101], [15]]);
  assert.equal(stopped, false);
  assert.ok(Number.isFinite(ms) && ms >= 0);

  // HiGHS is told to stay quiet, and the options pass through.
  const { highs: fake, seen } = fakeHighs(highs, { status: 'infeasible' });
  solveProblem(fake, problemOf(), OPTIONS);
  assert.deepEqual(seen.options, { output_flag: false, ...OPTIONS });
});

test('an optimal solve\'s gap is within the tolerance', () => {
  for (const modeId of MODES) {
    const { plan, bound, gap, stopped } = solveProblem(highs, problemOf(modeId), OPTIONS);
    assert.equal(stopped, false, modeId);
    assert.ok(Number.isFinite(bound) && bound >= plan.objective - 1e-9, `${modeId}: bound ${bound}, plan ${plan.objective}`);
    assert.ok(Math.abs(gap - (bound - plan.objective)) < 1e-9, modeId);
    assert.ok(gap >= -1e-9 && gap <= absGap, `${modeId}: gap ${gap}`);
  }
});

test('a stopped solve reports its bound and gap', () => {
  const problem = bigProblem('longterm');
  const { plan, stopped, bound, gap } = solveProblem(highs, problem, { time_limit: 1, ...NEVER_PROVEN });
  assert.equal(stopped, true);
  assert.ok(plan, 'a plan in hand at the limit');
  assert.ok(Number.isFinite(bound) && bound > plan.objective, `bound ${bound}, plan ${plan.objective}`);
  assert.ok(gap > absGap, `gap ${gap}`);
  assert.ok(Math.abs(gap - (bound - plan.objective)) < 1e-9);
});

test('a solve stopped before any plan has no gap, and no bound when HiGHS had none', () => {
  // A limit of 0 stops HiGHS before it has done anything.
  const none = solveProblem(highs, problemOf(), { time_limit: 0 });
  assert.deepEqual([none.plan, none.stopped, none.bound, none.gap], [null, true, null, null]);

  // Stopped before any plan, but with a bound (HiGHS's objective is infinite until it has a plan).
  const { highs: fake } = fakeHighs(highs, { status: 'timeLimit', objective: Infinity, bound: 12.5 });
  const bounded = solveProblem(fake, problemOf(), OPTIONS);
  assert.deepEqual([bounded.plan, bounded.stopped, bounded.bound, bounded.gap], [null, true, 12.5, null]);
});

test('solveProblem reads an infeasible problem as no plan, and any other status as a failure', () => {
  const problem = problemOf();
  const { highs: infeasibleHighs } = fakeHighs(highs, { status: 'infeasible' });
  const infeasible = solveProblem(infeasibleHighs, problem, OPTIONS);
  assert.deepEqual([infeasible.plan, infeasible.stopped, infeasible.bound, infeasible.gap], [null, false, null, null]);
  for (const status of ['unboundedOrInfeasible', 'modelError', 'interrupted']) {
    const { highs: fake } = fakeHighs(highs, { status, objective: 0 });
    assert.throws(() => solveProblem(fake, problem, OPTIONS), new RegExp(`"${status}"`));
  }
  // The model's refusal of a problem it cannot hold comes before HiGHS is asked.
  assert.throws(() => solveProblem(highs, { ...problem, keep: [-1] }, OPTIONS), /keep/);
});

test('the model is disposed on every ending, even when decode throws', () => {
  const endings = {
    'a plan': { status: 'optimal', objective: 1, bound: 1 },
    'no plan at the limit': { status: 'timeLimit' },
    'infeasible': { status: 'infeasible' },
    'a status that is a failure': { status: 'solveError' },
    'decode throwing': { status: 'optimal', objective: 1, bound: 1, breaksDecode: true },
  };
  for (const [name, { breaksDecode, ...ending }] of Object.entries(endings)) {
    const problem = problemOf();
    // decode reads the problem when it runs: with its players gone, it throws.
    const onRun = breaksDecode ? () => { problem.players = null; } : undefined;
    const { highs: fake, seen } = fakeHighs(highs, { ...ending, onRun });
    try { solveProblem(fake, problem, OPTIONS); } catch { /* the endings that throw are the point */ }
    assert.equal(seen.disposed, 1, name);
  }
});
