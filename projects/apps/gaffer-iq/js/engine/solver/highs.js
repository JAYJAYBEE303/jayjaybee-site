/**
 * js/engine/solver/highs.js
 * Layer: engine (the solver's runtime; imported by worker.js, the tests and tools/backtest, never by the page). HiGHS
 * loaded from the vendored build (assets/vendor/highs/, its README names the source), and a model's problem solved
 * by it. Works in a module worker and in Node.
 */

import { DECISION_ENGINE } from '../../config.js';
import { buildPlan } from './model.js';

const HIGHS = new URL(`../../../${DECISION_ENGINE.solver.vendor.dir}highs.mjs`, import.meta.url).href;
// A solve that stops at its time limit has the best plan found so far, if it found one.
export const USABLE = new Set(['Optimal', 'Time limit reached']);
// What every solve sets before the caller's own options: HiGHS prints nothing.
export const SOLVE_DEFAULTS = { output_flag: false };

/**
 * HiGHS, ready to solve, from the bytes of highs.wasm. The build ignores a `wasmBinary` option (it reads the file
 * beside itself), so the bytes go in through its instantiate hook; a failure, whether the instantiate's or the build's
 * own when it takes the instance, rejects instead of leaving the load waiting.
 * @param {object} source
 * @param {ArrayBuffer|ArrayBufferView} source.wasmBinary
 * @returns {Promise<{solve: (lp: string, options?: object) => object}>}
 */
export async function loadHighs({ wasmBinary }) {
  const { default: Module } = await import(HIGHS);
  return new Promise((resolve, reject) => {
    Module({
      instantiateWasm: (imports, receive) => {
        WebAssembly.instantiate(wasmBinary, imports).then(({ instance }) => receive(instance)).catch(reject);
      },
    }).then(resolve, reject);
  });
}

/**
 * The problem solved. `options` are HiGHS's own (time_limit, mip_abs_gap, ...).
 * - Optimal, or stopped at the time limit with a plan in hand: the decoded plan; `stopped` says which.
 * - Stopped at the limit before any plan (its objective is not finite), or infeasible: no plan, so the caller keeps the
 *   engine's move.
 * - Any other status: a throw.
 * @param {{solve: (lp: string, options?: object) => object}} highs  from loadHighs
 * @param {object} problem  the model's input (buildPlan)
 * @param {object} options
 * @returns {{plan: object|null, stopped: boolean, ms: number}}
 */
export function solveProblem(highs, problem, options) {
  const { lp, decode } = buildPlan(problem);
  const started = Date.now();
  const result = highs.solve(lp, { ...SOLVE_DEFAULTS, ...options });
  const ms = Date.now() - started;
  if (result.Status === 'Infeasible') return { plan: null, stopped: false, ms };
  if (!USABLE.has(result.Status)) throw new Error(`solveProblem: HiGHS returned "${result.Status}"`);
  return { plan: Number.isFinite(result.ObjectiveValue) ? decode(result) : null, stopped: result.Status !== 'Optimal', ms };
}
