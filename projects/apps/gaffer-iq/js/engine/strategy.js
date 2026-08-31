/**
 * js/engine/strategy.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * Turns the five lane scores from engine/transfers.js into one weekly verdict:
 * which lane to act on, how far ahead of the runner-up it is, and which hard
 * conditions — an injured starter, a chip window, a cash crunch — override the
 * arithmetic.
 *
 * "Roll the transfer" is a lane here, not a fallback. A planner that always
 * recommends something is the failure this module exists to prevent.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §8.
 */

import { clamp } from '../util.js';
import {
  LANE_SCALE_NOW, LANE_SCALE_FUTURE, LANE_SCALE_FUNDS,
  LANE_SCALE_CEILING, LANE_SCALE_STRUCTURE,
  VERDICT_ACT_THRESHOLD, VERDICT_MARGIN_CLEAR, VERDICT_MARGIN_DOMINANT,
  CHIP_WINDOW_GWS, FLEX_FLOOR,
} from '../config.js';

/** Lane id → the config divisor that maps its natural unit onto 0–100. */
const LANE_SCALES = {
  now:       LANE_SCALE_NOW,
  future:    LANE_SCALE_FUTURE,
  funds:     LANE_SCALE_FUNDS,
  ceiling:   LANE_SCALE_CEILING,
  structure: LANE_SCALE_STRUCTURE,
};

/** Human labels, used in the reasoning strings this module builds. */
const LANE_LABELS = {
  now:       'Now',
  future:    'Future Prep',
  funds:     'Funds & Flexibility',
  ceiling:   'Ceiling',
  structure: 'Structure Fix',
  roll:      'Roll the transfer',
};

/**
 * Map a lane's natural unit onto 0–100.
 *
 * MODEL: this is the load-bearing and most arbitrary step in the design.
 * Without a shared scale, "a swing of +6" and "frees £0.5m" have no common
 * language and the margin below is meaningless. The divisors are calibration
 * targets, not truths — the first thing to tune against realised results per
 * ROADMAP.md Phase 3B.
 *
 * @returns {number}  0–100, higher = a stronger case for acting on this lane
 */
function normaliseLaneValue(laneId, value) {
  const scale = LANE_SCALES[laneId] ?? 1;
  return clamp(0, 100, (value / scale) * 100);
}

/** The best swap on each lane, with its normalised score. */
function rankLanes(swaps) {
  const rows = [];
  for (const laneId of Object.keys(LANE_SCALES)) {
    let best = null;
    for (const swap of swaps) {
      const lane = swap.lanes?.[laneId];
      if (!lane || !Number.isFinite(lane.value)) continue;
      if (!best || lane.value > best.lanes[laneId].value) best = swap;
    }
    if (!best) continue;
    const raw = best.lanes[laneId].value;
    rows.push({
      laneId,
      swap: best,
      raw,
      score: normaliseLaneValue(laneId, raw),
      estimated: Boolean(best.lanes[laneId].estimated),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/**
 * Hard conditions that may promote a lane past the arithmetic. Each carries its
 * own headline reason and is always reported — a trigger never silently
 * reorders anything.
 *
 * @returns {Array<{id: string, laneId: string, message: string}>}
 */
function detectTriggers(swaps, squadState, ctx) {
  const triggers = [];

  const brokenStarter = swaps.find(s => s.flags?.outInXi && s.flags?.outUnavailable);
  if (brokenStarter) {
    triggers.push({
      id: 'xiPlayerUnavailable',
      laneId: 'structure',
      message: `${brokenStarter.outPlayer.name} is in your projected XI and is `
             + `flagged ${brokenStarter.outPlayer.status}.`,
    });
  }

  const flexibility = squadState?.flexibility?.value ?? 100;
  if (flexibility < FLEX_FLOOR) {
    triggers.push({
      id: 'cashCrunch',
      laneId: 'funds',
      message: `Squad flexibility is ${flexibility.toFixed(0)} — your money is `
             + 'clumped tightly enough that upgrading anyone is getting hard.',
    });
  }

  const currentGw = ctx?.currentGw ?? 0;
  for (const [chipId, rec] of Object.entries(squadState?.chipRecs ?? {})) {
    const gw = rec?.gw;
    if (typeof gw !== 'number') continue;
    if (gw - currentGw > CHIP_WINDOW_GWS || gw < currentGw) continue;
    triggers.push({
      id: 'chipWindow',
      laneId: chipId === 'triplecaptain' ? 'ceiling' : 'future',
      message: `${chipId} looks strongest in GW${gw}, ${gw - currentGw} gameweek(s) `
             + 'away — plan transfers around it.',
    });
  }

  const risingTarget = swaps.find(s =>
    s.lanes?.funds?.components?.priceRisk === 'rise' && s.lanes?.now?.value > 0);
  if (risingTarget) {
    triggers.push({
      id: 'priceDeadline',
      laneId: 'funds',
      message: `${risingTarget.inPlayer.name} is trending towards a price rise — `
             + 'buying later costs more.',
    });
  }

  return triggers;
}

/**
 * Build the week's verdict.
 *
 * @param {Array<Swap>} swaps       from enumerateSwaps()
 * @param {object} squadState       { flexibility, xiEntries, freeTransfers, chipRecs }
 * @param {object} ctx              from buildScoreContext()
 * @returns {{ lane, laneScore, margin, confidence, bestSwap, alternatives,
 *             triggers, reasoning, estimated }}
 */
export function buildVerdict(swaps, squadState, ctx) {
  const triggers = detectTriggers(swaps ?? [], squadState ?? {}, ctx ?? {});
  const ranked   = rankLanes(swaps ?? []);
  const leader   = ranked[0] ?? null;

  if (!leader || leader.score < VERDICT_ACT_THRESHOLD) {
    return {
      lane: 'roll',
      laneScore: leader?.score ?? 0,
      margin: 0,
      confidence: 'clear',
      bestSwap: null,
      alternatives: [],
      triggers,
      estimated: Boolean(leader?.estimated),
      reasoning: leader
        ? `Nothing on the board is worth a transfer this week — the best move, `
          + `${LANE_LABELS[leader.laneId]}, scores ${leader.score.toFixed(0)} against a `
          + `threshold of ${VERDICT_ACT_THRESHOLD}. Roll it and bank the transfer.`
        : 'No legal transfers are available within your budget. Roll it.',
    };
  }

  const runnerUp = ranked[1] ?? null;
  const margin   = runnerUp ? leader.score - runnerUp.score : leader.score;

  let confidence = 'close';
  if (margin >= VERDICT_MARGIN_DOMINANT)   confidence = 'dominant';
  else if (margin >= VERDICT_MARGIN_CLEAR) confidence = 'clear';

  // Honesty rule: an estimated winner never speaks with the same certainty as a
  // measured one. See spec §8.4.
  const estimated = leader.estimated;
  if (estimated && confidence === 'dominant') confidence = 'clear';
  else if (estimated && confidence === 'clear') confidence = 'close';

  const alternatives = ranked.slice(1)
    .filter(row => leader.score - row.score < VERDICT_MARGIN_CLEAR)
    .map(row => ({ lane: row.laneId, label: LANE_LABELS[row.laneId], score: row.score }));

  const laneLabel = LANE_LABELS[leader.laneId];
  const headline =
      confidence === 'dominant' ? `${laneLabel} is in a different league this week.`
    : confidence === 'clear'    ? `${laneLabel}, clearly.`
    : `Close call — ${laneLabel}, but ${alternatives.map(a => a.label).join(' and ')} `
      + `${alternatives.length === 1 ? 'is' : 'are'} within ${VERDICT_MARGIN_CLEAR} points.`;

  const triggerNote = triggers.length > 0
    ? ` ${triggers.map(t => t.message).join(' ')}`
    : '';
  const estimatedNote = estimated
    ? ' Some of the inputs behind this are estimated, so treat it as a lean rather '
      + 'than a certainty.'
    : '';

  return {
    lane: leader.laneId,
    laneScore: leader.score,
    margin,
    confidence,
    bestSwap: leader.swap,
    alternatives,
    triggers,
    estimated,
    reasoning: `${headline} ${leader.swap.lanes[leader.laneId].reasoning}`
             + `${triggerNote}${estimatedNote}`,
  };
}
