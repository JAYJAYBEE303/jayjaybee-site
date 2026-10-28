/**
 * tools/backtest/milp.js
 * The MILP referee in the decision backtest (docs/decision-engine-plan.md,
 * Phase 8): a week's state as js/engine/solver/model.js's problem, on the same
 * projections the engine reads; the plan's first week as moves FPL takes one
 * at a time; and the referee as a policy that makes them. HiGHS is the build
 * vendored for the app (assets/vendor/highs/), loaded as the app's worker does.
 *
 * The candidates are the owned squad plus, per position, the best others by
 * weighted points and by weighted points a tenth: the whole pool is too big
 * to solve thousands of times, and a player outside both lists is rarely in
 * an optimal plan.
 */

import { readFile } from 'node:fs/promises';

import { DECISION_ENGINE, MAX_PER_CLUB, SEASON_GWS, SQUAD_LIMITS, XI_FORMATION_MIN } from '../../js/config.js';
import { SOLVE_DEFAULTS, USABLE, loadHighs } from '../../js/engine/solver/highs.js';
import { buildPlan } from '../../js/engine/solver/model.js';
import { orderMoves as orderFirstWeek } from '../../js/engine/solver/plan.js';
import { fromTenths } from '../../js/util.js';
import { squadState } from './lib.js';

const WASM = new URL(`../../${DECISION_ENGINE.solver.vendor.dir}highs.wasm`, import.meta.url);
export const RETRY_TIME = 4;   // a solve stopped before any plan runs again with this many times the limit

const sum = xs => xs.reduce((a, x) => a + x, 0);

/**
 * The vendored HiGHS (npm "highs", MIT), itself as `highs` (for the app's solveProblem) and as `solve`, which sets
 * `options`: HiGHS's own (time_limit, mip_abs_gap, ...); a solve can override them.
 * @returns {Promise<{highs: object, options: object, solve: (lp: string, extra?: object) => object}>}
 */
export async function loadSolver(options = {}) {
  const highs = await loadHighs({ wasmBinary: await readFile(WASM) });
  return { highs, options, solve: (lp, extra = {}) => highs.solve(lp, { ...SOLVE_DEFAULTS, ...options, ...extra }) };
}

/**
 * The model's problem for a state at gameweek t: each player's xpts for each
 * week of `weights` (cut at the season's end), the owned squad at its sell
 * prices, and the candidates (pool.points best by weighted points and
 * pool.pointsPerTenth best by weighted points a tenth, per position, plus
 * any `include`).
 */
export function milpProblem(world, t, state, {
  weights, pool, include = [], chips = null, fixed = null, seasonGws = SEASON_GWS,
  maxBankedFt = DECISION_ENGINE.maxBankedFt, hitCost = DECISION_ENGINE.hitCost, benchWeights = DECISION_ENGINE.benchWeightsLinear,
}) {
  const gws = weights.map((_, k) => t + k).filter(gw => gw <= seasonGws);
  const projections = world.projections(t);
  const xptsOf = id => gws.map((_, k) => projections.get(id)?.gws[k]?.xpts ?? 0);
  const worth = id => sum(xptsOf(id).map((x, k) => weights[k] * x));
  const current = squadState(state, world, t);
  const owned = new Set(current.players.map(p => p.playerId));
  const players = current.players.map(p => ({ id: p.playerId, position: p.position, teamId: p.teamId, priceTenths: p.priceTenths,
    sellTenths: p.sellPriceTenths, owned: true, xpts: xptsOf(p.playerId) }));
  const chosen = new Set(include.filter(id => !owned.has(id)));
  for (const position of Object.keys(SQUAD_LIMITS)) {
    const others = world.candidates(t).filter(q => q.position === position && !owned.has(q.id))
      .map(q => ({ id: q.id, worth: worth(q.id), perTenth: worth(q.id) / world.priceTenths(q.id, t) }));
    const top = (n, key) => [...others].sort((a, b) => b[key] - a[key]).slice(0, n).map(q => q.id);
    for (const id of [...top(pool.points, 'worth'), ...top(pool.pointsPerTenth, 'perTenth')]) chosen.add(id);
  }
  for (const id of chosen) {
    const { position, teamId } = world.player(id, t);
    const priceTenths = world.priceTenths(id, t);
    players.push({ id, position, teamId, priceTenths, sellTenths: priceTenths, owned: false, xpts: xptsOf(id) });
  }
  return {
    gws, weights: weights.slice(0, gws.length), players, bankTenths: state.bankTenths, ft: state.ft, maxBankedFt, hitCost,
    benchWeights, maxPerClub: MAX_PER_CLUB, squadLimits: SQUAD_LIMITS, xiMin: XI_FORMATION_MIN, chips, fixed,
    lineTerms: DECISION_ENGINE.solver.lpLineTerms,
  };
}

/**
 * The problem solved: the decoded plan, `stopped` when the solve ended at its
 * time limit (its best plan so far, maybe short of the tolerance), counted in
 * `counts` ({solves, ms, stopped}). A solve that stops before it has any plan
 * runs once more with a longer limit, and throws if it still has none.
 */
export function solvePlan(solver, problem, counts) {
  const { lp, decode } = buildPlan(problem);
  const at = `at GW${problem.gws[0]}`;
  const run = extra => {
    const started = Date.now();
    const result = solver.solve(lp, extra);
    counts.solves += 1;
    counts.ms += Date.now() - started;
    if (!USABLE.has(result.Status)) throw new Error(`solvePlan: HiGHS returned "${result.Status}" ${at}`);
    return result;
  };
  let result = run();
  if (!Number.isFinite(result.ObjectiveValue)) result = run({ time_limit: solver.options.time_limit * RETRY_TIME });
  if (!Number.isFinite(result.ObjectiveValue)) throw new Error(`solvePlan: HiGHS found no plan ${at}`);
  const stopped = result.Status !== 'Optimal';
  if (stopped) counts.stopped += 1;
  return { ...decode(result), stopped };
}

export const newCounts = () => ({ solves: 0, ms: 0, stopped: 0, unordered: 0 });

/**
 * The first week's sales and buys as moves FPL takes one at a time, on a backtest state: the app's ordering
 * (js/engine/solver/plan.js) on the same squad and prices, which the world gives at gameweek t.
 */
export function orderMoves(state, ins, outs, world, t) {
  const squad = squadState(state, world, t);
  const candidates = ins.map(id => {
    const { position, teamId } = world.player(id, t);
    return { id, position, teamId, price: fromTenths(world.priceTenths(id, t)) };
  });
  const input = { bankTenths: squad.bankTenths, squad: squad.players, candidates };
  return orderFirstWeek(input, { players: squad.players }, { in: ins, out: outs }).moves;
}

/**
 * The referee as a policy: each week, the best plan over `weights` from the
 * state, and its first week's moves. counts.unordered is the weeks some of
 * them found no legal order (orderMoves).
 */
export function milpPolicy(solver, opts) {
  const counts = newCounts();
  return {
    counts,
    decide({ t, state, world }) {
      const [first] = solvePlan(solver, milpProblem(world, t, state, opts), counts).weeks;
      const moves = orderMoves(state, first.in, first.out, world, t);
      if (moves.length < first.in.length) counts.unordered += 1;
      return { moves };
    },
  };
}
