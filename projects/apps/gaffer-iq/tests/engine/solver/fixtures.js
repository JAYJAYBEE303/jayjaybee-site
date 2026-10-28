/**
 * tests/engine/solver/fixtures.js
 * What the tests that run HiGHS share: the vendored build, loaded the way the worker loads it, and a real problem - a
 * mode's, on the decision tests' own scenario, with the solver switched on as the tests of its path always do.
 */

import { readFileSync } from 'node:fs';

import { DECISION_ENGINE } from '../../../js/config.js';
import { runDecisionEngine } from '../../../js/engine/decision.js';
import { loadHighs } from '../../../js/engine/solver/highs.js';
import { modeSetting, solverProblem } from '../../../js/engine/solver/problem.js';
import { scenario } from '../decision-fixtures.js';

/** The bytes of the vendored highs.wasm. */
export const WASM = readFileSync(new URL(`../../../${DECISION_ENGINE.solver.vendor.dir}highs.wasm`, import.meta.url));
export const loadVendored = () => loadHighs({ wasmBinary: WASM });

export const CONFIG = { ...DECISION_ENGINE, solver: { ...DECISION_ENGINE.solver, enabled: true } };

/**
 * Forward 101 is worth 12 a week against the bench forward 15's 2.2, so Long term's plan sells 15 for him in the first
 * week. A plain object: it crosses postMessage.
 */
export function problemOf(modeId = 'longterm') {
  const input = scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] });
  const result = runDecisionEngine(input, CONFIG);
  return solverProblem(input, result, modeSetting(input, result, modeId, CONFIG), CONFIG);
}

/**
 * HiGHS's Model API answering as told, for the endings a real solve will not reach on demand, and counting what is
 * done to it. `real` is the vendored build, which supplies its status codes. `status` is a name in
 * `constants.modelStatus`; `columns` are the primal values by column name; `onRun` is called as the model runs.
 * @returns {{highs: object, seen: {options: object|null, disposed: number}}}
 */
export function fakeHighs(real, { status, objective = Infinity, bound = Infinity, columns = {}, onRun = () => {} }) {
  const seen = { options: null, disposed: 0 };
  const names = Object.keys(columns);
  const info = { objective_function_value: objective, mip_dual_bound: bound };
  const model = {
    options: { set: options => { seen.options = options; } },
    run: () => { onRun(); return { modelStatus: real.constants.modelStatus[status] }; },
    info: { get: name => { if (!(name in info)) throw new Error(`no info "${name}"`); return info[name]; } },
    getSolution: () => ({ colValue: Float64Array.from(names, name => columns[name]) }),
    getColName: index => names[index],
    dispose: () => { seen.disposed += 1; },
  };
  return { highs: { constants: real.constants, createModel: () => model }, seen };
}
