/**
 * tests/engine/solver/vendor.test.js
 * The vendored HiGHS build (assets/vendor/highs/<version>/) and its loader (js/engine/solver/highs.js): the shipped
 * files match the SHA-256 pinned in DECISION_ENGINE.solver.vendor, so a changed file is caught here and refused by the
 * worker; the licence and the README ship with them; the build loads from its bytes; and solveProblem turns each
 * status HiGHS can end on into a plan, no plan, or a throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { DECISION_ENGINE } from '../../../js/config.js';
import { loadHighs, solveProblem } from '../../../js/engine/solver/highs.js';
import { WASM, loadVendored, problemOf } from './fixtures.js';

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
  await assert.rejects(loadHighs({ wasmBinary: new Uint8Array([0, 1, 2, 3]) }));
});

test('a build that cannot take the module rejects instead of leaving the load waiting', { timeout: 5000 }, async () => {
  // A valid, empty module: it instantiates, but has none of the exports the build then reads inside its own callback.
  const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await assert.rejects(loadHighs({ wasmBinary: empty }));
});

test('solveProblem solves the problem with the options it is given', () => {
  const { plan, stopped, ms } = solveProblem(highs, problemOf(), OPTIONS);
  assert.deepEqual([plan.weeks[0].in, plan.weeks[0].out], [[101], [15]]);
  assert.equal(stopped, false);
  assert.ok(Number.isFinite(ms) && ms >= 0);

  // HiGHS is told to stay quiet, and the options pass through.
  let seen;
  solveProblem({ solve: (lp, options) => { seen = options; return highs.solve(lp, options); } }, problemOf(), OPTIONS);
  assert.deepEqual(seen, { output_flag: false, ...OPTIONS });
});

test('solveProblem returns a plan, or null when the limit passes before any plan', () => {
  const problem = problemOf();
  const stoppedWith = fields => solveProblem({ solve: (lp, options) => ({ ...highs.solve(lp, options), ...fields }) }, problem, OPTIONS);

  // Stopped at the limit with a plan in hand: usable, and flagged.
  const early = stoppedWith({ Status: 'Time limit reached' });
  assert.equal(early.stopped, true);
  assert.deepEqual(early.plan.weeks[0].in, [101]);

  // Stopped at the limit before any plan: HiGHS's objective is infinite.
  const none = solveProblem({ solve: () => ({ Status: 'Time limit reached', ObjectiveValue: Infinity }) }, problem, OPTIONS);
  assert.deepEqual([none.plan, none.stopped], [null, true]);
});

test('solveProblem reads an infeasible problem as no plan, and any other status as a failure', () => {
  const problem = problemOf();
  const infeasible = solveProblem({ solve: () => ({ Status: 'Infeasible', ObjectiveValue: Infinity }) }, problem, OPTIONS);
  assert.deepEqual([infeasible.plan, infeasible.stopped], [null, false]);
  for (const Status of ['Unbounded or infeasible', 'Model error', 'Interrupted']) {
    assert.throws(() => solveProblem({ solve: () => ({ Status, ObjectiveValue: 0 }) }, problem, OPTIONS), new RegExp(Status));
  }
  // The model's refusal of a problem it cannot hold comes before HiGHS is asked.
  assert.throws(() => solveProblem(highs, { ...problem, keep: [-1] }, OPTIONS), /keep/);
});
