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
