/**
 * js/engine/counter.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes position-based counter-matchup scores: how team A's attacking unit
 * matches up against team B's defensive unit, by role pairing.
 * See FEATURE_ENGINE.md §7.2.
 *
 * Phase 3C: refines raw element_type grouping into the eight roles GKP, CB,
 * FB, DM, CM, WM, SS, ST using each player's FPL ICT index shares (threat,
 * influence, creativity). When ICT data is missing for either side, falls
 * back to the Phase-1 element_type grouping and flags estimated:true.
 *
 * Output: 0–100, higher = better for the team being scored.
 */

import {
  COUNTER_SENSITIVITY,
  PAIRING_WEIGHTS,
  ROLE_PAIRING_WEIGHTS,
  ROLE_CLASSIFY_THRESHOLDS,
  COUNTER_FALLBACK_EDGE,
} from '../config.js';
import { clamp, normaliseLinear } from '../util.js';
import { calcPlayerForm } from './form.js';

// ─── Role classification ─────────────────────────────────────────────────────

/**
 * Classify a player into one of GKP, CB, FB, DM, CM, WM, SS, ST using their
 * FPL element_type as the base and the relative shares of their ICT index
 * components (threat, influence, creativity) as the refining heuristic.
 *
 * Pure: depends only on the player object. Returns null when the player has
 * no recorded ICT activity at all (too little signal to refine confidently)
 * so callers can decide to fall back to element_type grouping.
 *
 * @param {Player} player  internal Player — see ARCHITECTURE.md §8
 * @returns {'GKP'|'CB'|'FB'|'DM'|'CM'|'WM'|'SS'|'ST'|null}
 */
export function classifyRole(player) {
  if (!player) return null;

  // GKP: trivial — element_type is unambiguous and ICT is rarely meaningful.
  if (player.position === 'GKP') return 'GKP';

  const ict = player.ict;
  if (!ict) return null;
  const threat     = ict.threat     ?? 0;
  const influence  = ict.influence  ?? 0;
  const creativity = ict.creativity ?? 0;
  const total      = threat + influence + creativity;

  // MODEL: a player with literally no ICT activity (back-up keepers, fringe
  // squad) has no signal to refine on — let the caller fall back.
  if (total <= 0) return null;

  const threatShare     = threat     / total;
  const creativityShare = creativity / total;
  const influenceShare  = influence  / total;

  const T = ROLE_CLASSIFY_THRESHOLDS;

  if (player.position === 'DEF') {
    // MODEL: full-backs get into the final third — they produce shots, crosses
    // and assists, so their ICT threat share runs higher than a CB's. CBs are
    // influence-dominant (defensive contribution, clearances, headers).
    return threatShare >= T.defThreatShare ? 'FB' : 'CB';
  }

  if (player.position === 'MID') {
    // MODEL: a wide MID / inside-forward is a primary scoring threat, so
    // threatShare dominates. Tested first because it's the most decisive signal.
    if (threatShare >= T.midWmThreatShare) return 'WM';
    // MODEL: a defensive midfielder accrues influence (interceptions, tackles,
    // recovery work) but not creativity (rarely key-passes). The dual
    // condition guards against ball-playing #6s being mis-classified.
    if (influenceShare >= T.midDmInfluenceShare &&
        creativityShare < T.midDmCreativityShareMax) {
      return 'DM';
    }
    // Default: a balanced central midfielder.
    return 'CM';
  }

  if (player.position === 'FWD') {
    // MODEL: a "shadow striker" / deep-lying forward drops into pockets and
    // creates rather than purely finishing — creativity share is the cleanest
    // separator from an out-and-out ST. Lower threshold than for MIDs because
    // every FWD threats; the question is whether they *also* create.
    return creativityShare >= T.fwdSsCreativityShare ? 'SS' : 'ST';
  }

  return null;
}

// ─── Role groupings used by calcCounterMatchup ───────────────────────────────

// Role-based attacking / defending unit per pairing (Phase 3C refinement).
// MODEL: SS sits in both stVsCb (acts as a second striker) and cmVsCbDm (drops
// between the lines into the CM band) — it appears in both pairings by design,
// reflecting that a shadow striker contributes to both interactions.
const ROLE_ATTACK_GROUPS = {
  stVsCb:   ['ST', 'SS'],
  wmVsFb:   ['WM'],
  cmVsCbDm: ['CM', 'SS'],
};
const ROLE_DEFENCE_GROUPS = {
  stVsCb:   ['CB'],
  wmVsFb:   ['FB'],
  cmVsCbDm: ['CB', 'DM'],
};

// Phase-1 fallback (element_type only). Used when ICT data is missing on either
// side, flagging the pairing estimated:true. Kept here, not in config, because
// it's a structural fallback rather than a tunable.
const ELEMENT_ATTACK_GROUPS = {
  fwdVsCb:     ['FWD'],
  wideMidVsFb: ['MID'],
  camVsCbMid:  ['MID'],
};
const ELEMENT_DEFENCE_GROUPS = {
  fwdVsCb:     ['DEF'],
  wideMidVsFb: ['DEF'],
  camVsCbMid:  ['DEF', 'MID'],
};

// ─── Selection helpers ───────────────────────────────────────────────────────

function selectByRole(players, allowedRoles, rolesByPlayerId) {
  return (players || []).filter(p => allowedRoles.includes(rolesByPlayerId[p.id]));
}

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
 * Build a { playerId → role } map for one team's players. Returns null if
 * any outfield player in the squad fails classification (signals that ICT
 * data is too thin to refine — the caller should fall back to element_type
 * grouping and flag estimated:true).
 *
 * MODEL: "fail closed" on the squad as a whole rather than mixing refined and
 * unrefined players in the same pairing — that would silently understate the
 * unit for whichever side has worse ICT coverage.
 */
function classifyTeamRoles(players) {
  const rolesByPlayerId = {};
  let outfieldClassified = 0;
  let outfieldTotalWithMinutes = 0;

  for (const p of players || []) {
    const minutes = p.totals?.minutes ?? 0;
    const role = classifyRole(p);
    if (role) rolesByPlayerId[p.id] = role;

    // Only count outfield, played-this-season players when judging coverage.
    if (p.position !== 'GKP' && minutes > 0) {
      outfieldTotalWithMinutes++;
      if (role) outfieldClassified++;
    }
  }

  if (outfieldTotalWithMinutes === 0) return null;
  // Require almost-full coverage of regulars to trust the refined grouping.
  // MODEL: a 90% bar tolerates a single fringe outfielder with no ICT signal
  // without forcing a fallback for the whole team.
  if ((outfieldClassified / outfieldTotalWithMinutes) < 0.9) return null;

  return rolesByPlayerId;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Position counter-matchup score for team A's attack vs team B's defence.
 *
 * Asymmetric by design: A's attack vs B's defence is a different number from
 * B's attack vs A's defence. Each side of a fixture uses *its own* attacking
 * counter-matchup (see FEATURE_ENGINE.md §7.2).
 *
 * Phase 3C: uses role-based pairings (ROLE_PAIRING_WEIGHTS) when ICT data
 * lets us classify both teams; falls back to element_type pairings
 * (PAIRING_WEIGHTS) with estimated:true otherwise.
 *
 * MODEL: minutes-weighted mean per unit, so likely starters drive the score
 * rather than fringe-squad players who happen to share a role. Defender form
 * uses the defensive read of calcPlayerForm (mode === 'defence') —
 * clean-sheet + saves-driven rather than attacking returns.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx  must contain { playersByTeamId, playerSummariesById, teamsById }
 * @returns {{value: number, estimated: boolean, pairings: Object, mode: 'role'|'element'}}
 */
export function calcCounterMatchup(teamA, teamB, ctx) {
  const playersA = ctx.playersByTeamId?.[teamA.id] || [];
  const playersB = ctx.playersByTeamId?.[teamB.id] || [];

  const rolesA = classifyTeamRoles(playersA);
  const rolesB = classifyTeamRoles(playersB);
  const useRoles = rolesA !== null && rolesB !== null;

  const pairingWeights = useRoles ? ROLE_PAIRING_WEIGHTS    : PAIRING_WEIGHTS;
  const attackGroups   = useRoles ? ROLE_ATTACK_GROUPS      : ELEMENT_ATTACK_GROUPS;
  const defenceGroups  = useRoles ? ROLE_DEFENCE_GROUPS     : ELEMENT_DEFENCE_GROUPS;

  const pairings = {};
  let weightedSum = 0;
  let totalWeight = 0;
  // MODEL: an element_type fallback for either side flags the whole metric
  // as estimated — the refinement is the headline of Phase 3C and its absence
  // is material context for the UI.
  let anyEstimated = !useRoles;

  for (const key of Object.keys(pairingWeights)) {
    const attackers = useRoles
      ? selectByRole(playersA, attackGroups[key], rolesA)
      : selectByPosition(playersA, attackGroups[key]);
    const defenders = useRoles
      ? selectByRole(playersB, defenceGroups[key], rolesB)
      : selectByPosition(playersB, defenceGroups[key]);

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
      weight:       pairingWeights[key],
      estimated:    pairingEstimated,
      attackForm,
      defenceForm,
      attackerCount: attackers.length,
      defenderCount: defenders.length,
    };

    weightedSum += pairingScore * pairingWeights[key];
    totalWeight += pairingWeights[key];
  }

  // MODEL: totalWeight is 0 only if the active pairing-weights table is empty —
  // a config bug. Defensive 50/estimated rather than NaN if that ever happens.
  const value = totalWeight === 0
    ? 50
    : clamp(0, 100, weightedSum / totalWeight);

  return {
    value,
    estimated: anyEstimated || totalWeight === 0,
    pairings,
    mode: useRoles ? 'role' : 'element',
  };
}
