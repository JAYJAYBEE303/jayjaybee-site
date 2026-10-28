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
 *
 * modePolicy is the other half: each of the app's six modes as the app decides it, guard and settle rules included.
 */

import { DECISION_ENGINE, SEASON_GWS } from '../../js/config.js';
import { moveSetKey, runDecisionEngine } from '../../js/engine/decision.js';
import { solveProblem } from '../../js/engine/solver/highs.js';
import {
  alternativesSync, callOf, gainOverRolling, orderMoves, rollingProblem, settlePick, trusted,
} from '../../js/engine/solver/plan.js';
import { modeSetting, solverProblem } from '../../js/engine/solver/problem.js';
import { pickBeatsAlternatives } from '../../js/engine/solver/rescore.js';
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
 * @param {{createModel: Function}} highs  from loadHighs
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

/**
 * One of the app's modes as a policy, deciding each week as the app's runner settles its card (js/modules/planner-solver.js;
 * the guard and the settle rules are plan.js's, which both call). Each week: the engine on the state, the mode's setting
 * with `hitMargin` in place of the config's, and then
 * - no weeks to weigh, or Ceiling in a big week: the engine's own move, root and Funds' chained second move, with no solve;
 * - the pick at solver.timeLimitS; if it is not trusted, the same problem at solver.resolveTimeLimitS; if that is not
 *   trusted either, the engine's move (none where the engine waits or rolls);
 * - for a move, its rolling twin at the limit the shown plan used, then settlePick: a tie with rolling or a wait that sells a
 *   kept player is a roll, and a move with no legal order one at a time is the engine's. A wait makes no move this week.
 * Every `robustnessEvery`-th week, when the call is a move, the pick is re-scored against its alternatives, the engine's move
 * and rolling (rescore.js), and the share is logged: the weeks are counted from the first, and Infinity never.
 *
 * A protected sale is the model's bug, never a recommendation: it stops the run here where the app only warns. A solve that
 * throws stops it too.
 *
 * `counts`: solves (every call of HiGHS), ms, stopped (solves that stopped at their limit), resolved (picks solved again),
 * twins (rolling solves), alternatives (solves for the re-score), engineFallback (weeks that settled on the engine's move
 * after a solve), ties, kept (waits turned into rolls) and unordered. `log` per week: {t, call, moves (made this week),
 * source: 'solver' | 'engine' | 'engine-tail', guard: 'trusted' | 'resolved' | 'engine', gap (of the shown plan to its
 * bound), gain (the pick's over rolling where it had a rolling twin, a tie included; an engine week's is its root's own
 * score; else null), robustness}.
 *
 * @param {{createModel: Function}} highs  from loadHighs
 * @param {{modeId: string, hitMargin: number, config: object, robustnessEvery: number, solve?: Function}} spec  `solve` is
 *   solveProblem's place, for the tests to script the answers
 */
export function modePolicy(highs, { modeId, hitMargin, config, robustnessEvery, solve = solveProblem }) {
  const modes = { ...config.solver.modes, [modeId]: { ...config.solver.modes[modeId], hitMargin } };
  const tuned = { ...config, solver: { ...config.solver, modes } };
  const { timeLimitS, resolveTimeLimitS, absGap } = tuned.solver;
  const counts = { ...newCounts(), resolved: 0, twins: 0, alternatives: 0, engineFallback: 0, ties: 0, kept: 0 };
  const log = [];
  const solved = (problem, limitS) => {
    const answer = solve(highs, problem, { time_limit: limitS, mip_abs_gap: absGap });
    counts.solves += 1;
    counts.ms += answer.ms;
    if (answer.stopped) counts.stopped += 1;
    return answer;
  };
  return {
    counts,
    log,
    decide({ t, state, world, locks = new Set(), bans = new Set() }) {
      const input = engineInput(world.at(t), t, state, locks, bans);
      const result = runDecisionEngine(input, tuned);
      const engine = result.modes[modeId];
      const engineMade = engine.call === 'move' ? engineMoves(engine.root) : [];
      const week = entry => {
        log.push({ t, ...entry });
        return { moves: entry.moves };
      };
      const keepEngine = source => week({ call: engine.call, moves: engineMade, source, guard: 'engine', gap: null,
        gain: engine.root?.outScore ?? null, robustness: null });
      const fallBack = () => {
        counts.engineFallback += 1;
        return keepEngine('engine');
      };

      const setting = modeSetting(input, result, modeId, tuned);
      if (setting === null || setting.source === 'engine-tail') return keepEngine(setting?.source ?? 'engine');
      const problem = solverProblem(input, result, setting, tuned);
      let guard = 'trusted';
      let answer = solved(problem, timeLimitS);
      if (!trusted(answer, tuned)) {
        guard = 'resolved';
        counts.resolved += 1;
        answer = solved(problem, resolveTimeLimitS);
      }
      if (!trusted(answer, tuned)) return fallBack();
      const { plan } = answer;

      // The rolling twin is solved as long as the plan it is priced against.
      let rolling = null;
      if (callOf(plan) === 'move') {
        counts.twins += 1;
        rolling = solved(rollingProblem(problem), guard === 'resolved' ? resolveTimeLimitS : timeLimitS);
        if (!rolling.plan) return fallBack();
      }
      let settled;
      try {
        settled = settlePick({ modeId, plan, rolling: rolling?.plan ?? null, result, input, config: tuned });
      } catch (error) {
        if (!error.unordered) throw error;
        counts.unordered += 1;
        return fallBack();
      }
      if (settled.rolled === 'tie') counts.ties += 1;
      if (settled.rolled === 'kept') counts.kept += 1;
      const moves = settled.call === 'move' ? settled.moves : [];

      let robustness = null;
      if (settled.call === 'move' && (log.length + 1) % robustnessEvery === 0) {
        const found = alternativesSync(problem, plan, other => {
          counts.alternatives += 1;
          return solved(other, timeLimitS).plan;
        }, tuned);
        // An alternative is FPL's own move set too: ordered, or left out where it has no legal order one at a time.
        const alternatives = found.flatMap(alt => {
          const ordered = orderMoves(input, result, { in: alt.moves.map(m => m.inId), out: alt.moves.map(m => m.outId) });
          return ordered.unordered ? [] : [ordered.moves];
        });
        const candidates = [moves, ...alternatives, engineMade, []].map(set => ({ key: moveSetKey(set), moves: set }));
        robustness = pickBeatsAlternatives(input, tuned, modeId, engine.weights, candidates, candidates[0].key);
      }
      return week({ call: settled.call, moves, source: 'solver', guard, gap: answer.gap,
        gain: rolling ? gainOverRolling(plan, rolling.plan) : null, robustness });
    },
  };
}
