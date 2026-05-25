/**
 * js/engine/counter.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes position-based counter-matchup scores: how team A's attacking unit
 * matches up against team B's defensive unit, by position pairing.
 * See FEATURE_ENGINE.md §7.2. Phase 1: position-group aggregates only (element_type).
 * TODO(phase-3): refine with role-level grouping beyond raw element_type.
 * Output: 0–100, higher = better for the team being scored.
 */

import { COUNTER_SENSITIVITY, PAIRING_WEIGHTS, COUNTER_FALLBACK_EDGE } from '../config.js';
import { clamp, normaliseLinear } from '../util.js';
import { calcPlayerForm } from './form.js';

// Phase-1 position groupings keyed by the same names used in PAIRING_WEIGHTS.
// MODEL: Phase 1 derives groups from element_type alone — a wide MID and a
// central attacking MID land in the same bucket because the FPL `element_type`
// field doesn't distinguish them. Phase 3 will use role data to split MIDs
// across the wideMidVsFb / camVsCbMid pairings properly.
const ATTACK_GROUPS = {
  fwdVsCb:     ['FWD'],
  wideMidVsFb: ['MID'],
  camVsCbMid:  ['MID'],
};
const DEFENCE_GROUPS = {
  fwdVsCb:     ['DEF'],
  wideMidVsFb: ['DEF'],
  camVsCbMid:  ['DEF', 'MID'],
};

function selectByPosition(players, allowedPositions) {
  return (players || []).filter(p => allowedPositions.includes(p.position));
}

/**
 * Internal: minutes-weighted mean of calcPlayerForm.value across a unit. Players
 * with zero career minutes drop out (fringe squad / academy) so they don't dilute
 * the read. Returns null when no eligible player has any minutes.
 */
function minutesWeightedMeanForm(players, ctx) {
  if (!players || players.length === 0) return null;
  let sum = 0;
  let totalW = 0;
  for (const p of players) {
    const minutes = p.totals?.minutes ?? 0;
    if (minutes <= 0) continue;
    const form = calcPlayerForm(p, ctx);
    sum    += form.value * minutes;
    totalW += minutes;
  }
  return totalW === 0 ? null : sum / totalW;
}

/**
 * Internal: when a unit can't be assembled (no minutes, no players, no summary),
 * fall back to FPL strength priors mapped to a 0–100 pairing score.
 * MODEL: same scale family as base difficulty but tighter, since this captures
 * one side of the attack/defence interaction rather than both.
 */
function fallbackPairingFromStrength(teamA, teamB) {
  const attack  = (teamA.strength.attackHome  + teamA.strength.attackAway)  / 2;
  const defence = (teamB.strength.defenceHome + teamB.strength.defenceAway) / 2;
  return normaliseLinear(
    attack - defence,
    COUNTER_FALLBACK_EDGE.min,
    COUNTER_FALLBACK_EDGE.max,
  );
}

/**
 * Position counter-matchup score for team A's attack vs team B's defence.
 *
 * Asymmetric by design: A's attack vs B's defence is a different number from
 * B's attack vs A's defence. Each side of a fixture uses *its own* attacking
 * counter-matchup (see FEATURE_ENGINE.md §7.2).
 *
 * MODEL: minutes-weighted mean per unit, so likely starters drive the score
 * rather than fringe-squad players who happen to share a position. Defender
 * form uses the defensive read of calcPlayerForm (mode === 'defence') —
 * clean-sheet + saves-driven rather than attacking returns.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx  must contain { playersByTeamId, playerSummariesById, teamsById }
 * @returns {{value: number, estimated: boolean, pairings: Object}}
 *   value: 0–100, higher = A's attack profile favours it against B's defence.
 *   Direction: higher = better for `teamA`.
 *   pairings: per-pairing breakdown for the matchup module's drill-down.
 */
export function calcCounterMatchup(teamA, teamB, ctx) {
  const playersA = ctx.playersByTeamId?.[teamA.id] || [];
  const playersB = ctx.playersByTeamId?.[teamB.id] || [];

  const pairings = {};
  let weightedSum = 0;
  let totalWeight = 0;
  let anyEstimated = false;

  for (const key of Object.keys(PAIRING_WEIGHTS)) {
    const attackers = selectByPosition(playersA, ATTACK_GROUPS[key]);
    const defenders = selectByPosition(playersB, DEFENCE_GROUPS[key]);
    const attackForm  = minutesWeightedMeanForm(attackers, ctx);
    const defenceForm = minutesWeightedMeanForm(defenders, ctx);

    let pairingScore;
    let pairingEstimated = false;
    if (attackForm === null || defenceForm === null) {
      // MODEL: missing unit data → fall back to strength priors and flag.
      pairingScore = fallbackPairingFromStrength(teamA, teamB);
      pairingEstimated = true;
      anyEstimated = true;
    } else {
      // signed: positive = A's attack outperforms B's defence on form.
      const pairingEdge = attackForm - defenceForm;
      pairingScore = clamp(0, 100, 50 + (pairingEdge * COUNTER_SENSITIVITY));
    }

    pairings[key] = {
      value:        pairingScore,
      weight:       PAIRING_WEIGHTS[key],
      estimated:    pairingEstimated,
      attackForm,
      defenceForm,
      attackerCount: attackers.length,
      defenderCount: defenders.length,
    };

    weightedSum += pairingScore * PAIRING_WEIGHTS[key];
    totalWeight += PAIRING_WEIGHTS[key];
  }

  // MODEL: totalWeight is 0 only if PAIRING_WEIGHTS is empty — a config bug.
  // Defensive 50/estimated rather than NaN if that ever happens.
  const value = totalWeight === 0
    ? 50
    : clamp(0, 100, weightedSum / totalWeight);

  return {
    value,
    estimated: anyEstimated || totalWeight === 0,
    pairings,
  };
}
