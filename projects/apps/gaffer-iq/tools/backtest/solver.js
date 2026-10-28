/**
 * tools/backtest/solver.js
 * The reproduction check in the decision backtest (docs/decision-engine-solver-plan.md, Phase 3): the app's own solver
 * path - the engine's result, solverProblem, HiGHS through solveProblem, orderMoves - set exactly as Phase 8's offline
 * planner (tools/backtest/milp.js) was, as a policy. If the app's path is faithful, its season matches data/milp.json's
 * on the same squads; the gap is the measure of it (run.js --solver-repro).
 *
 * What differs from milpPolicy is the time limit, which is the app's, and a solve that stops before it has a plan: the
 * planner (solvePlan) solves it again at a longer limit and throws if there is still none, where this makes no move and
 * counts the week. The pool is Phase 8's (the engine's own buys, which the app adds, are turned off), and a first week
 * some of whose moves have no legal order one at a time is handled as milpPolicy handles it: the legal moves are made and
 * the week is counted.
 */

import { DECISION_ENGINE, SEASON_GWS } from '../../js/config.js';
import { moveSetKey, runDecisionEngine } from '../../js/engine/decision.js';
import { solveProblem } from '../../js/engine/solver/highs.js';
import { orderMoves } from '../../js/engine/solver/plan.js';
import { solverProblem } from '../../js/engine/solver/problem.js';
import { engineInput } from './lib.js';
import { newCounts } from './milp.js';

// Phase 8's weights (run.js decayWeights): Funds' decay over the engine's five GWs, as a horizon total, so points and
// hits share a unit. Its pool: per position, the 20 best others by weighted points and the 10 best by weighted points a
// tenth. The solve limits (a time limit, and a tolerance within which a solve stops short of its bound) are the app's.
const WEIGHTS = DECISION_ENGINE.modes.now.weights.map((_, k) => DECISION_ENGINE.decayBase ** k);
const POOL = { points: 20, pointsPerTenth: 10 };

/** Phase 8's problem as a solver setting: the horizon cut at the season's end, and none of the terms the app's modes add. */
function reproSetting(input) {
  const gws = WEIGHTS.map((_, k) => input.planningGw + k).filter(gw => gw <= SEASON_GWS);
  return {
    modeId: 'solver-repro',
    gws,
    weights: WEIGHTS.slice(0, gws.length),
    frozen: [],
    keep: [],
    bans: [],
    buyable: () => true,
    engineBuys: false,
    endFtValue: null,
    bankPerTenth: 0,
    hitMargin: 0,
    deadSlot: null,
    salePoints: {},
    chips: { benchboost: null, triplecaptain: null },
  };
}

/**
 * What solverPolicy takes for the reproduction, from an app config: the setting, HiGHS's options (the config's own limits)
 * and the config with Phase 8's pool in place of its pool.
 */
export const reproFor = config => ({
  setting: reproSetting,
  options: { time_limit: config.solver.timeLimitS, mip_abs_gap: config.solver.absGap },
  config: { ...config, solver: { ...config.solver, pool: POOL } },
});

export const REPRO = reproFor(DECISION_ENGINE);

/** What the engine recommends in a mode, as moves: its root, and for Funds the second move the root pays for; none for a roll. */
const engineMoves = root => (root ? [root, ...(root.chained ? [root.chained] : [])].map(({ outId, inId }) => ({ outId, inId })) : []);

/** Whether a logged week's first week is a mode's whole recommendation: the same sales and buys, however paired or ordered. */
export const agrees = (week, mode) => moveSetKey(week.first) === moveSetKey(week.engine[mode]);

/**
 * The app's solver as a policy: each week, the engine on the state, `setting` of its input and result, the problem
 * solved with `options`, and the plan's first week as moves FPL takes one at a time. No plan (infeasible, or stopped
 * before one): no moves, where the planner would solve again at a longer limit. Moves with no legal order: the legal ones
 * are made. Both are counted in `counts` ({solves, ms, stopped, noPlan, unordered}). `log` has each week's {t, first: the
 * moves made, engine: each mode's moves, its root and Funds' chained second move, as [{outId, inId}] (empty for a roll)}.
 *
 * @param {{solve: Function}} highs  from loadHighs
 * @param {{setting: Function, options: object, config?: object}} spec  see REPRO
 */
export function solverPolicy(highs, { setting, options, config = DECISION_ENGINE }) {
  const counts = { ...newCounts(), noPlan: 0 };
  const log = [];
  return {
    counts,
    log,
    decide({ t, state, world, locks = new Set(), bans = new Set() }) {
      const input = engineInput(world.at(t), t, state, locks, bans);
      const result = runDecisionEngine(input, config);
      const { plan, stopped, ms } = solveProblem(highs, solverProblem(input, result, setting(input, result), config), options);
      counts.solves += 1;
      counts.ms += ms;
      if (stopped) counts.stopped += 1;
      const { moves, unordered } = plan ? orderMoves(input, result, plan.weeks[0]) : { moves: [], unordered: false };
      if (!plan) counts.noPlan += 1;
      if (unordered) counts.unordered += 1;
      const engine = Object.fromEntries(Object.entries(result.modes).map(([id, m]) => [id, engineMoves(m.root)]));
      log.push({ t, first: moves, engine });
      return { moves };
    },
  };
}
