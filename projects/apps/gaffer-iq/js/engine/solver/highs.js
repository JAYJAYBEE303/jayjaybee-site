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
 * @returns {Promise<{constants: object, createModel: Function, solve: (lp: string, options?: object) => object}>}
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
 * The problem solved, by HiGHS's Model API so that a solve stopped at its limit still reports how far from the best any
 * plan could be. `options` are HiGHS's own (time_limit, mip_abs_gap, ...).
 * - Optimal, or stopped at the time limit with a plan in hand: the decoded plan; `stopped` says which.
 * - Stopped at the limit before any plan (its objective is not finite), or infeasible: no plan, so the caller keeps the
 *   engine's move.
 * - Any other status: a throw.
 * `bound` is HiGHS's dual bound: the model maximises, so no plan could score more. `gap` is that bound less the plan's
 * own objective, in points: at most the solve's absolute gap when optimal, and what is still unproven when stopped. A
 * bound HiGHS has not reached (it is infinite) is null, and a gap needs both a plan and a bound.
 * @param {{constants: object, createModel: Function}} highs  from loadHighs
 * @param {object} problem  the model's input (buildPlan)
 * @param {object} options
 * @returns {{plan: object|null, stopped: boolean, ms: number, bound: number|null, gap: number|null}}
 */
export function solveProblem(highs, problem, options) {
  const { lp, decode } = buildPlan(problem);
  const { optimal, timeLimit, infeasible } = highs.constants.modelStatus;
  const started = Date.now();
  const model = highs.createModel({ format: 'lp', data: lp });
  try {
    model.options.set({ ...SOLVE_DEFAULTS, ...options });
    const { modelStatus } = model.run();
    const ms = Date.now() - started;
    if (modelStatus === infeasible) return { plan: null, stopped: false, ms, bound: null, gap: null };
    if (modelStatus !== optimal && modelStatus !== timeLimit) {
      const name = Object.keys(highs.constants.modelStatus).find(key => highs.constants.modelStatus[key] === modelStatus);
      throw new Error(`solveProblem: HiGHS returned "${name ?? modelStatus}"`);
    }
    const objective = model.info.get('objective_function_value');
    const dual = model.info.get('mip_dual_bound');
    const bound = Number.isFinite(dual) ? dual : null;
    let plan = null;
    if (Number.isFinite(objective)) {
      // The legacy solve's result, as decode reads it: each column's primal value under its name.
      const Columns = {};
      model.getSolution().colValue.forEach((Primal, index) => { Columns[model.getColName(index)] = { Primal }; });
      plan = decode({ ObjectiveValue: objective, Columns });
    }
    return { plan, stopped: modelStatus !== optimal, ms, bound, gap: plan && bound !== null ? bound - plan.objective : null };
  } finally {
    model.dispose();
  }
}
