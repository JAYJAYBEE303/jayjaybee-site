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
  BANDS,
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

// ─── Phase 4-2: individual player-vs-player duels ────────────────────────────

// MODEL: a baseline 4-4-2 used to pick a likely starting XI by minutes security
// alone. Not formation-aware (no detection of 4-3-3 vs 3-5-2) — the goal is
// to surface the eleven players most likely to be on the pitch, not to predict
// the manager's exact shape. The duels module is supplementary and tolerates
// the simplification; a fancier formation pick would be overfitting given the
// data we have.
const LIKELY_XI_FORMATION = { GKP: 1, DEF: 4, MID: 4, FWD: 2 };

// MODEL: which defender role(s) each attacker role most likely duels with.
// Mirrors the unit pairings used by calcCounterMatchup but applied per player:
//   ST  → CB        out-and-out striker vs centre-back
//   SS  → CB or DM  shadow striker drops between the lines — both apply
//   WM  → FB        wide attacker vs the full-back on his flank
//   CM  → CB or DM  central creator vs CBs and the shielding mid
// DM / CB / FB / GKP omitted: those are defenders, not attackers initiating
// the duel from the scoring side. They appear as defenders only.
const DUEL_OPPONENT_ROLES = {
  ST: ['CB'],
  SS: ['CB', 'DM'],
  WM: ['FB'],
  CM: ['CB', 'DM'],
};

/** Map a 0–100 value to a band string using config thresholds. */
function bandFromValue(v) {
  if (v >= BANDS.great)   return 'great';
  if (v >= BANDS.good)    return 'good';
  if (v >= BANDS.neutral) return 'neutral';
  if (v >= BANDS.tough)   return 'tough';
  return 'brutal';
}

/**
 * Internal: pick the likely starting XI for a team by ranking each position
 * group by calcPlayerForm.minutesSecurity and slicing to LIKELY_XI_FORMATION.
 * Returns entries paired with their full PlayerForm so downstream callers
 * avoid recomputing it for the duel score.
 */
function buildLikelyXi(players, ctx) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of players || []) {
    if (byPos[p.position]) {
      byPos[p.position].push({ player: p, form: calcPlayerForm(p, ctx) });
    }
  }
  const xi = [];
  for (const pos of Object.keys(LIKELY_XI_FORMATION)) {
    byPos[pos].sort((a, b) => b.form.minutesSecurity - a.form.minutesSecurity);
    xi.push(...byPos[pos].slice(0, LIKELY_XI_FORMATION[pos]));
  }
  return xi;
}

/**
 * Individual player-vs-player duels for team A's attackers against the likely
 * defenders they will face in team B. Phase 4-2 evolution of calcCounterMatchup:
 * instead of averaging across the whole position group, pair specific players
 * (Salah vs the full-back nearest to him) and score that single duel.
 *
 * Likely XI: per-team, top N by minutesSecurity in the 1-4-4-2 baseline. Role
 * classification re-uses Phase 3C's classifyRole on each XI player; players
 * with no ICT signal are silently skipped (they wouldn't have a meaningful
 * role read anyway).
 *
 * Duel score: same shape as the position-group pairing — clamp(50 + edge * COUNTER_SENSITIVITY).
 * "Most interesting" = largest absolute form differential: a striker on fire
 * vs a struggling CB is as worth surfacing as the inverse.
 *
 * MODEL: graceful degradation. When either team has no players loaded, or
 * when no attacker XI player has both a classified role and a matching
 * defender in the opposing XI, returns []. The Matchup Analyser falls back
 * to the position-group counter pairings already on screen.
 *
 * @param {Team} teamA   attacker side — we want this team's attacking duels
 * @param {Team} teamB   defender side
 * @param {object} ctx   same context shape as calcCounterMatchup
 * @returns {{attacker: object, defender: object, duelScore: number, band: string}[]}
 *   top 5 duels by |attackerForm − defenderForm|, descending.
 */
export function calcIndividualDuels(teamA, teamB, ctx) {
  const playersA = ctx.playersByTeamId?.[teamA.id] || [];
  const playersB = ctx.playersByTeamId?.[teamB.id] || [];
  if (playersA.length === 0 || playersB.length === 0) return [];

  const xiA = buildLikelyXi(playersA, ctx);
  const xiB = buildLikelyXi(playersB, ctx);

  // Role-classify each XI player independently. Unlike calcCounterMatchup
  // (which fails closed on the whole team), here we tolerate per-player gaps:
  // a duel just isn't surfaced if its participants can't be classified.
  const rolesA = {};
  for (const e of xiA) {
    const r = classifyRole(e.player);
    if (r) rolesA[e.player.id] = r;
  }
  const rolesB = {};
  for (const e of xiB) {
    const r = classifyRole(e.player);
    if (r) rolesB[e.player.id] = r;
  }

  // Index team B's defenders by role for O(1) candidate lookup per attacker.
  // Each entry retains its PlayerForm so the duel pairing can prefer the
  // higher-minutes-security candidate (the man more likely to actually be
  // on the pitch).
  const defendersByRole = {};
  for (const e of xiB) {
    const r = rolesB[e.player.id];
    if (!r) continue;
    (defendersByRole[r] ||= []).push(e);
  }

  const duels = [];
  for (const atk of xiA) {
    const atkRole = rolesA[atk.player.id];
    if (!atkRole) continue;
    const oppRoles = DUEL_OPPONENT_ROLES[atkRole];
    if (!oppRoles) continue;

    const candidates = [];
    for (const r of oppRoles) {
      if (defendersByRole[r]) candidates.push(...defendersByRole[r]);
    }
    if (candidates.length === 0) continue;
    // MODEL: most likely opponent = highest-minutes-security defender in the
    // candidate role pool. A one-to-many mapping (e.g. one striker vs four
    // CB+DMs) collapses to the single duel we trust most.
    candidates.sort((a, b) => b.form.minutesSecurity - a.form.minutesSecurity);
    const def = candidates[0];

    const edge = atk.form.value - def.form.value;
    const duelScore = clamp(0, 100, 50 + edge * COUNTER_SENSITIVITY);

    duels.push({
      attacker: {
        id:        atk.player.id,
        name:      atk.player.name,
        position:  atk.player.position,
        role:      atkRole,
        formValue: atk.form.value,
      },
      defender: {
        id:        def.player.id,
        name:      def.player.name,
        position:  def.player.position,
        role:      rolesB[def.player.id],
        formValue: def.form.value,
      },
      duelScore,
      band: bandFromValue(duelScore),
    });
  }

  // MODEL: rank by absolute form differential — the most lopsided duels are
  // the most decision-relevant whether they favour the attacker or the
  // defender. A 60-vs-30 striker-favoured duel is no less interesting than a
  // 30-vs-60 defender-favoured one.
  duels.sort((x, y) =>
    Math.abs(y.attacker.formValue - y.defender.formValue) -
    Math.abs(x.attacker.formValue - x.defender.formValue));

  return duels.slice(0, 5);
}
