/**
 * tests/engine/solver/worker.test.js
 * The solver worker's protocol (js/engine/solver/worker.js): `init` fetches the wasm against its integrity hash and
 * loads HiGHS from the bytes; `solve` answers the decoded plan, or none inside the limit. Every failure - no fetch, a
 * bad response, a hash mismatch, a build that will not load, a problem the model refuses, a solve before init - is an
 * `ok: false` answer, never a throw: the page keeps the engine's move (solver plan, Review Focus 4). The worker's
 * handler runs here in Node, with the page's glue absent as it is wherever there is no Worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { DECISION_ENGINE } from '../../../js/config.js';
import { WASM, problemOf } from './fixtures.js';

const { vendor, timeLimitS, absGap } = DECISION_ENGINE.solver;
const INTEGRITY = `sha256-${vendor.wasm}`;
const SOLVE = { time_limit: timeLimitS, mip_abs_gap: absGap };

// Each test gets a worker of its own: the loaded runtime is module state, and a query string makes a new instance.
let workers = 0;
const freshWorker = async () => (await import(`../../../js/engine/solver/worker.js?${++workers}`)).handle;
const bytes = async () => new Response(WASM);
const init = { id: 1, kind: 'init', wasmUrl: 'https://example.test/highs.wasm', integrity: INTEGRITY };

test('loading the worker where there is no worker scope sets no handler and throws nothing', async () => {
  await freshWorker();
  assert.equal(globalThis.onmessage, undefined);
});

test('the worker answers a solve with the decoded plan', async () => {
  const handle = await freshWorker();
  const seen = [];
  const fetch = async (...args) => { seen.push(args); return bytes(); };
  assert.deepEqual(await handle(init, { fetch }), { id: init.id, ok: true });
  // The hash goes to fetch itself, which refuses a body that does not match it.
  assert.deepEqual(seen, [[init.wasmUrl, { integrity: INTEGRITY }]]);

  const problem = structuredClone(problemOf());   // as postMessage hands it over
  const answer = await handle({ id: 2, kind: 'solve', problem, options: SOLVE });
  assert.deepEqual([answer.id, answer.ok, answer.stopped], [2, true, false]);
  assert.deepEqual([answer.plan.weeks[0].in, answer.plan.weeks[0].out], [[101], [15]]);
  assert.ok(answer.ms >= 0);
});

test('a solve that ends with no plan answers plan: null', async () => {
  const handle = await freshWorker();
  const load = async () => ({ solve: () => ({ Status: 'Time limit reached', ObjectiveValue: Infinity }) });
  await handle(init, { fetch: bytes, load });
  const answer = await handle({ id: 2, kind: 'solve', problem: problemOf(), options: SOLVE });
  assert.deepEqual([answer.id, answer.ok, answer.plan, answer.stopped], [2, true, null, true]);
});

test('a fetch that fails, a response that is not ok, and a build that will not load each answer ok: false', async () => {
  const handle = await freshWorker();
  const failures = {
    'a fetch that rejects': [async () => { throw new TypeError('Failed to fetch'); }, /Failed to fetch/],
    'a 404': [async () => new Response('', { status: 404 }), /404/],
    'bytes that are not WebAssembly': [async () => new Response(new Uint8Array([0, 1, 2, 3])), /./],
  };
  for (const [name, [fetch, error]] of Object.entries(failures)) {
    const answer = await handle(init, { fetch });
    assert.deepEqual([answer.id, answer.ok], [init.id, false], name);
    assert.match(answer.error, error, name);
    // A failed init leaves nothing to solve with.
    const solve = await handle({ id: 2, kind: 'solve', problem: problemOf(), options: SOLVE });
    assert.equal(solve.ok, false, name);
  }
});

test('an init without a sha256 integrity answers ok: false and fetches nothing', async () => {
  const handle = await freshWorker();
  let fetched = 0;
  const fetch = async () => { fetched += 1; return bytes(); };
  // A fetch given nothing it can read as a hash loads the file unchecked, so the worker refuses to ask.
  for (const integrity of [undefined, '', 'sha256', 'garbage', 'md5-AAAA']) {
    const answer = await handle({ ...init, integrity }, { fetch });
    assert.deepEqual([answer.ok, typeof answer.error], [false, 'string'], String(integrity));
  }
  assert.equal(fetched, 0);
});

test('a failed init leaves a runtime already loaded in place', async () => {
  const handle = await freshWorker();
  await handle(init, { fetch: bytes });
  const failed = await handle({ ...init, id: 2 }, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(failed.ok, false);
  const answer = await handle({ id: 3, kind: 'solve', problem: problemOf(), options: SOLVE });
  assert.deepEqual([answer.ok, answer.plan.weeks[0].in], [true, [101]]);
});

test('a solve posted straight after init waits for the load, and fails with it', async () => {
  const solve = { id: 2, kind: 'solve', problem: problemOf(), options: SOLVE };
  const handle = await freshWorker();
  const [ready, answer] = await Promise.all([handle(init, { fetch: bytes }), handle(solve)]);
  assert.equal(ready.ok, true);
  assert.deepEqual([answer.ok, answer.plan.weeks[0].in], [true, [101]]);

  const other = await freshWorker();
  const failing = { fetch: async () => { throw new TypeError('Failed to fetch'); } };
  const [failed, refused] = await Promise.all([other(init, failing), other(solve)]);
  assert.deepEqual([failed.ok, refused.ok], [false, false]);
});

test('the wasm is loaded only against the pinned hash', async () => {
  const handle = await freshWorker();
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/wasm'); res.end(WASM); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const wasmUrl = `http://127.0.0.1:${server.address().port}/highs.wasm`;
  try {
    // The real fetch, as the worker has it: the base64 hash in the config is the integrity value.
    const wrong = `sha256-${Buffer.alloc(32).toString('base64')}`;
    const refused = await handle({ id: 1, kind: 'init', wasmUrl, integrity: wrong });
    assert.equal(refused.ok, false);
    // A refused file is not loaded: there is nothing to solve with.
    assert.equal((await handle({ id: 4, kind: 'solve', problem: problemOf(), options: SOLVE })).ok, false);
    assert.deepEqual(await handle({ id: 2, kind: 'init', wasmUrl, integrity: INTEGRITY }), { id: 2, ok: true });
    assert.equal((await handle({ id: 3, kind: 'solve', problem: problemOf(), options: SOLVE })).ok, true);
  } finally {
    server.close();
  }
});

test('a solve before init, a problem the model refuses, and an unknown message each answer ok: false', async () => {
  const handle = await freshWorker();
  const problem = problemOf();
  assert.equal((await handle({ id: 1, kind: 'solve', problem, options: SOLVE })).ok, false);
  await handle(init, { fetch: bytes });
  const refused = await handle({ id: 2, kind: 'solve', problem: { ...problem, keep: [-1] }, options: SOLVE });
  assert.deepEqual([refused.id, refused.ok], [2, false]);
  assert.match(refused.error, /keep/);
  assert.deepEqual([await handle({ id: 3, kind: 'nope' })].map(a => [a.id, a.ok]), [[3, false]]);
});
