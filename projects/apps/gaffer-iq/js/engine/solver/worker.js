/**
 * js/engine/solver/worker.js
 * Layer: engine (module worker entry). Solves the multi-week model off the page's main thread. Messages in, answers
 * out, each carrying the caller's `id`:
 *   { id, kind: 'init', wasmUrl, integrity }  ->  { id, ok: true }
 *   { id, kind: 'solve', problem, options }   ->  { id, ok: true, plan, stopped, ms }
 * `init` fetches highs.wasm against `integrity` (a changed file is refused) and loads HiGHS from the bytes; `solve`
 * answers the decoded plan, or `plan: null` when HiGHS had none inside the limit (highs.js). Anything that goes wrong -
 * the fetch, the hash, the load, the model refusing a problem - is `{ id, ok: false, error }`, never a throw: the page
 * then keeps the engine's move.
 */

import { loadHighs, solveProblem } from './highs.js';

let loading = null;   // HiGHS being loaded, or loaded: a promise of its runtime
// All fetch needs to refuse a changed file is a hash it can read; given anything else it loads the file unchecked.
const SHA256 = /^sha256-[\w+/]+=*$/;

async function start({ wasmUrl, integrity }, fetch, load) {
  const response = await fetch(wasmUrl, { integrity });
  if (!response.ok) throw new Error(`worker: ${wasmUrl} answered ${response.status}`);
  return load({ wasmBinary: await response.arrayBuffer() });
}

/** One message's answer. `deps` are for the tests: the page's fetch and the HiGHS loader. */
export async function handle({ id, kind, ...request }, { fetch = globalThis.fetch, load = loadHighs } = {}) {
  try {
    if (kind === 'init') {
      if (!SHA256.test(request.integrity)) throw new Error('worker: init needs a sha256 integrity hash');
      const previous = loading;
      const next = start(request, fetch, load);
      loading = next;   // before any await, so a solve posted straight after init waits for it
      try {
        await next;
      } catch (error) {
        if (loading === next) loading = previous;   // a runtime already loaded stays
        throw error;
      }
      return { id, ok: true };
    }
    if (kind === 'solve') {
      if (!loading) throw new Error('worker: solve before init');
      return { id, ok: true, ...solveProblem(await loading, request.problem, request.options) };
    }
    throw new Error(`worker: unknown message "${kind}"`);
  } catch (error) {
    return { id, ok: false, error: String(error?.message ?? error) };
  }
}

// The page's glue; there is no worker scope in Node, where the tests call handle.
if (globalThis.WorkerGlobalScope) self.onmessage = ({ data }) => handle(data).then(answer => self.postMessage(answer));
