/**
 * js/engine/robustness.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * How far to trust each mode's call (brief §7 Phase 6;
 * docs/decision-engine-plan.md Phase 6): the engine re-runs robustnessRuns
 * times on seeded noisy copies of its input - every player's projected points
 * and chance of no minutes, the free transfer's value and the decay - and each
 * run's top moves per mode score robustnessPoints (3, 2 and 1 for the top
 * three). A move's robustness is its points as a share of the most it could
 * get. The re-runs score only the buys the engine shortlists
 * (DecisionResult.shortlist), which keeps each to a fraction of a full run;
 * the page runs them in a module worker (robustness-worker.js).
 */

import { clamp, normalDeviate, seededRandom } from '../util.js';
import { runDecisionEngine } from './decision.js';

const logistic = z => 1 / (1 + Math.exp(-z));
const logit = p => Math.log(p / (1 - p));

/** A move's key: its seller and its buy. */
export function moveKey(move) {
  return `${move.outId}>${move.inId}`;
}

/**
 * One run's noisy copies of the engine's input and config; neither original
 * is changed. Each player's projected points (xptsIfPlays) scale by one
 * lognormal factor across his GWs and his chance of no minutes moves on the
 * logit scale, unless it is certain either way; a blank stays a blank and
 * xpts stays (1 - pZero) x xptsIfPlays. The free transfer's value scales by
 * one factor and the decay base moves.
 *
 * @param {object} input   runDecisionEngine's input
 * @param {object} config  DECISION_ENGINE, with robustnessNoise
 * @param {() => number} random  seededRandom()
 * @returns {{input: object, config: object}}
 */
export function noisyInput(input, config, random) {
  const noise = config.robustnessNoise;
  const projections = new Map();
  for (const [id, projection] of input.projections) {
    const factor = Math.exp(noise.xpts * normalDeviate(random));
    const shift = noise.pZero * normalDeviate(random);
    projections.set(id, {
      ...projection,
      gws: projection.gws.map(g => {
        if (g.fixtures === 0) return g;
        const pZero = g.pZero > 0 && g.pZero < 1 ? logistic(logit(g.pZero) + shift) : g.pZero;
        const xptsIfPlays = g.xptsIfPlays * factor;
        return { ...g, pZero, xptsIfPlays, xpts: (1 - pZero) * xptsIfPlays };
      }),
    });
  }
  const ft = Math.exp(noise.ftValue * normalDeviate(random));
  return {
    input: { ...input, projections },
    config: {
      ...config,
      ftValueFlat: config.ftValueFlat * ft,
      ftValueSchedule: Object.fromEntries(Object.entries(config.ftValueSchedule).map(([n, v]) => [n, v * ft])),
      decayBase: clamp(0, 1, config.decayBase + (noise.decay * normalDeviate(random))),
    },
  };
}

/**
 * Each mode's moves and the share of the most points they could get over the
 * re-runs.
 *
 * @param {object} input   the engine input `result` came from
 * @param {object} config  the config it ran with
 * @param {{shortlist: number[]}} result  its DecisionResult; the shortlist
 *   names the buys re-scored
 * @returns {Object<string, Map<string, number>>}  { [modeId]: Map<moveKey, share 0-1> }
 */
export function robustness(input, config, result) {
  const random = seededRandom(config.robustnessSeed);
  const shortlist = new Set(result.shortlist);
  const candidates = (input.candidates ?? []).filter(c => shortlist.has(c.id));
  const points = config.robustnessPoints;
  const totals = {};
  for (let run = 0; run < config.robustnessRuns; run++) {
    const noisy = noisyInput({ ...input, candidates }, config, random);
    // Every admissible move ranks, however far behind, so each run has its top moves.
    const runConfig = { ...noisy.config, alternativesWindow: Infinity, alternativesMax: points.length - 1 };
    for (const [modeId, mode] of Object.entries(runDecisionEngine(noisy.input, runConfig).modes)) {
      const tally = totals[modeId] ??= new Map();
      const ranked = mode.root ? [mode.root, ...mode.alternatives] : [];
      ranked.forEach((move, i) => tally.set(moveKey(move), (tally.get(moveKey(move)) ?? 0) + points[i]));
    }
  }
  const most = points[0] * config.robustnessRuns;
  return Object.fromEntries(Object.entries(totals).map(([modeId, tally]) =>
    [modeId, new Map([...tally].map(([key, total]) => [key, total / most]))]));
}

/**
 * The result with each mode's robustness (its move's share) and each
 * alternative's; a mode that rolls has none. The result given is left alone.
 */
export function withRobustness(result, shares) {
  const modes = Object.fromEntries(Object.entries(result.modes).map(([modeId, mode]) => {
    const share = move => shares[modeId]?.get(moveKey(move)) ?? 0;
    return [modeId, {
      ...mode,
      robustness: mode.root ? share(mode.root) : null,
      alternatives: mode.alternatives.map(a => ({ ...a, robustness: share(a) })),
    }];
  }));
  return { ...result, modes };
}
