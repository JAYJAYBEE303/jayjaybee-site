/**
 * js/engine/solver/rescore.js
 * Layer: engine (pure). Robustness of the solver's pick (docs/decision-engine-solver-plan.md §1): how often the pick
 * beats these alternatives under noise, not how often a fresh solve would choose it. The engine's seeded noisy copies
 * of its input (engine/robustness.js: noisyInput) re-score a handful of fixed move sets - the pick, its alternatives,
 * the engine's own move and rolling - on the engine's squad value, so nothing is re-solved. The figure is logged, and
 * it is a share of copies, not a confidence: it stays off the cards until a later check on it passes
 * (DECISION_ENGINE.solver.showRobustness).
 */

import { seededRandom } from '../../util.js';
import { noisyInput } from '../robustness.js';
import { squadValue } from '../squad-value.js';
import { endFtValueOf } from './problem.js';

/**
 * The share of the noisy copies in which the pick scores at least as well as every other candidate. A candidate's
 * score is the mode's weights times the squad value of each week with its moves made, less its hits, plus what the
 * free transfers it leaves banked are worth at the horizon's end (the solver's own terms for them, so a hit and a
 * rolled transfer are priced as the plan priced them). A hit costs hitCost plus the mode's solver hit margin
 * (solver.modes[modeId].hitMargin, not the engine's own hitMargin) flat, whatever the week weighs, as the engine's
 * transferCost and the solver's flatHits do, so a margin that kept a hit out of the plan keeps it out of the re-score.
 *
 * MODEL: the copies move the players' points and chances of no minutes and the free transfer's value; the weights stay
 * the mode's own, so the decay is not moved. Only the engine's squad value and the transfer terms are re-scored, not
 * the solver's money terms: every candidate here is a move set the engine can also explain.
 *
 * @param {object} input   runDecisionEngine's input
 * @param {object} config  DECISION_ENGINE, with robustnessRuns, robustnessSeed and robustnessNoise
 * @param {string} modeId  the mode the weights are of
 * @param {number[]} weights  the mode's weights from the planning GW, as the engine masked them (summary.weights)
 * @param {Array<{key: string, moves: Array<{outId: number, inId: number}>}>} candidates  the pick, its alternatives, the
 *   engine's move and rolling (`moves: []`); `key` is moveSetKey's, and a key given twice is one candidate
 * @param {string} pickKey  the key of the candidate that is the pick
 * @returns {number}  0-1
 */
export function pickBeatsAlternatives(input, config, modeId, weights, candidates, pickKey) {
  const distinct = [...new Map(candidates.map(c => [c.key, c])).values()];
  if (!distinct.some(c => c.key === pickKey)) {
    throw new Error(`pickBeatsAlternatives: the ${modeId} pick (${pickKey}) is not among its candidates`);
  }
  const hitPoints = config.hitCost + config.solver.modes[modeId].hitMargin;
  const random = seededRandom(config.robustnessSeed);
  let wins = 0;
  for (let run = 0; run < config.robustnessRuns; run++) {
    const copy = noisyInput(input, config, random);
    const scores = new Map(distinct.map(c => [c.key, scoreOf(copy, config, weights, hitPoints, c.moves)]));
    if (distinct.every(c => scores.get(pickKey) >= scores.get(c.key))) wins++;
  }
  return wins / config.robustnessRuns;
}

/** One candidate's score on one noisy copy: `config` is the engine's, `copy` its noisy input and config. */
function scoreOf({ input, config: noisy }, config, weights, hitPoints, moves) {
  const swapped = new Map(moves.map(m => [m.outId, m.inId]));
  const squad = input.squad.map(s => swapped.get(s.playerId) ?? s.playerId);
  // A chip the engine does not price in V (Free Hit, Wildcard) leaves squadValue as it was, and its weeks weigh 0.
  const points = weights.reduce((total, w, k) => {
    if (w === 0) return total;
    const gw = input.planningGw + k;
    const { value } = squadValue(squad, gw, input.projections, {
      chip: input.chipPlan?.[gw] ?? null, autosubMode: config.autosubMode, benchWeightsLinear: config.benchWeightsLinear,
    });
    return total + (w * value);
  }, 0);
  const hits = hitPoints * Math.max(0, moves.length - input.freeTransfers);
  const banked = Math.min(config.maxBankedFt, Math.max(0, input.freeTransfers - moves.length) + 1);
  // The schedule starts at the second transfer banked: the first is the one every week starts with.
  const kept = Object.entries(endFtValueOf(noisy)).filter(([count]) => Number(count) <= banked)
    .reduce((total, [, value]) => total + value, 0);
  return points - hits + kept;
}
