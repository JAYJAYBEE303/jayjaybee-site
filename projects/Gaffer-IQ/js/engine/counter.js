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
  ROLE_SIGNATURE_THRESHOLDS,
  ROLE_SIGNATURE_MIN_MINUTES,
  ROLE_SIGNATURE_MIN_CHAIN,
  ROLE_CHAIN_COVERAGE_MIN,
  COUNTER_FALLBACK_EDGE,
  CHAIN_UNIT_ANCHORS,
  COUNTER_ATTACK_WEIGHT,
  COUNTER_DEFENCE_WEIGHT,
  BANDS,
} from '../config.js';
import { clamp, normaliseLinear } from '../util.js';
import { calcPlayerForm } from './form.js';
import { calcChannelCounter } from './channel.js';

// ─── Role classification ─────────────────────────────────────────────────────

/**
 * Classify a player into one of GKP, CB, FB, DM, CM, WM, SS, ST.
 *
 * Tiered by evidence quality:
 *   1. Understat chain signature (buildupShare × createBias) — preferred.
 *   2. FPL ICT component shares — fallback when the player has no Understat
 *      match, too few minutes, or too little chain involvement.
 *
 * MODEL: chain data is preferred because ICT `threat` is a QUALITY measure —
 * a poor winger has little of it and reads as a central midfielder. The chain
 * signature is a ratio of the player's own involvement and is therefore
 * quality-neutral (see buildRoleSignature).
 *
 * Pure: depends only on its arguments. Returns null when neither tier has
 * enough signal, so callers can fall back to element_type grouping.
 *
 * @param {Player} player  internal Player — see ARCHITECTURE.md §8
 * @param {object} [ctx]   buildScoreContext result; only
 *                         ctx.understatPlayersByName is read. Omit to force
 *                         the ICT path.
 * @returns {'GKP'|'CB'|'FB'|'DM'|'CM'|'WM'|'SS'|'ST'|null}
 */
export function classifyRole(player, ctx) {
  if (!player) return null;

  // GKP: trivial — element_type is unambiguous and neither ICT nor chain is
  // meaningful for a keeper.
  if (player.position === 'GKP') return 'GKP';

  // Tier 1 — Understat chain signature.
  const lookup = ctx?.understatPlayersByName;
  const key    = (player.fullName || '').toLowerCase().trim();
  const up     = (lookup && key) ? lookup[key] : null;
  if (up) {
    const minutes = parseFloat(up.time);
    const chain   = parseFloat(up.xGChain);
    // MODEL: below either floor the ratios are still dominated by sampling
    // noise, and ICT — which accumulates from minute one — is the better read.
    if (minutes >= ROLE_SIGNATURE_MIN_MINUTES && chain >= ROLE_SIGNATURE_MIN_CHAIN) {
      const role = classifyRoleFromSignature(player.position, buildRoleSignature(up));
      if (role) return role;
    }
  }

  // Tier 2 — ICT shares (Phase 3C). Everything below is the existing body.
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

/**
 * Build the two-dimensional role signature for one Understat player record.
 *
 * MODEL: xGChain − xGBuildup is BY DEFINITION the player's involvement in
 * possessions where they took the shot or made the key pass, so buildupShare
 * is a positional depth axis: ~0.95 for a centre-back, ~0.20 for a striker.
 * Because it is a ratio of the player's own involvement it is quality-neutral
 * — measured at corr(buildupShare, xGChain/90) = +0.008 across 102 regular
 * 2025 defenders, versus corr(buildupShare, xA/90) = −0.654.
 *
 * MODEL: buildupShare alone misfiles two groups in OPPOSITE directions — a
 * set-piece centre-back reads low (corner headers are final actions) and a
 * defensive fullback reads low (little of anything). createBias separates
 * them: a centre-back's final action is a shot, a fullback's is a cross.
 *
 * See FEATURE_ENGINE.md §7.2 and the design spec
 * docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md §4.
 *
 * @param {object} understatPlayer  raw record from leagueXg.playersData —
 *                                  numeric fields arrive as STRINGS
 * @returns {{buildupShare: number, createBias: number, npxg90: number,
 *            chain90: number} | null}
 *          buildupShare 0–1 (higher = deeper role); createBias 0–1 (higher =
 *          creator not finisher); per-90 rates. null when there is too little
 *          signal to classify on.
 */
export function buildRoleSignature(understatPlayer) {
  if (!understatPlayer) return null;

  const minutes = parseFloat(understatPlayer.time);
  const chain   = parseFloat(understatPlayer.xGChain);
  if (!(minutes > 0) || !(chain > 0)) return null;

  const nineties = minutes / 90;
  const buildup  = parseFloat(understatPlayer.xGBuildup) || 0;
  const xa90     = (parseFloat(understatPlayer.xA)   || 0) / nineties;
  const npxg90   = (parseFloat(understatPlayer.npxG) || 0) / nineties;
  const final    = xa90 + npxg90;

  return {
    buildupShare: buildup / chain,
    // MODEL: a player with no final action at all has no bias either way —
    // 0.5 is the honest neutral, not 0 (which would read as pure finisher).
    createBias: final > 0 ? xa90 / final : 0.5,
    npxg90,
    chain90: chain / nineties,
  };
}

/**
 * Classify a player into one of GKP, CB, FB, DM, CM, WM, SS, ST from their
 * chain signature. Pure: depends only on its two arguments.
 *
 * MODEL: ordering is deliberate. Within MID, shot threat is tested before
 * build-up share because a deep-lying player who still shoots a lot is a
 * wide/attacking threat first and a #6 second.
 *
 * @param {'GKP'|'DEF'|'MID'|'FWD'} position  FPL element_type, normalised
 * @param {{buildupShare: number, createBias: number, npxg90: number} | null} sig
 * @returns {'GKP'|'CB'|'FB'|'DM'|'CM'|'WM'|'SS'|'ST'|null}  null when the
 *          signature is absent (caller should fall back to ICT).
 */
export function classifyRoleFromSignature(position, sig) {
  // GKP is unambiguous from element_type and has no meaningful chain profile.
  if (position === 'GKP') return 'GKP';
  if (!sig) return null;

  const T = ROLE_SIGNATURE_THRESHOLDS;

  if (position === 'DEF') {
    const shallow  = sig.buildupShare < T.defFbBuildupShareMax;
    const creating = sig.createBias  >= T.defFbCreateBiasMin;
    // MODEL: BOTH conditions required. A set-piece centre-back is shallow but
    // finishes rather than creates, so the createBias test keeps them at CB.
    return (shallow && creating) ? 'FB' : 'CB';
  }

  if (position === 'MID') {
    if (sig.npxg90       >= T.midWmNpxg90Min)       return 'WM';
    if (sig.buildupShare >= T.midDmBuildupShareMin) return 'DM';
    return 'CM';
  }

  if (position === 'FWD') {
    return sig.buildupShare >= T.fwdSsBuildupShareMin ? 'SS' : 'ST';
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
 * Minutes-weighted mean of xGChain per 90 across a unit.
 *
 * MODEL: chain credits every player involved in a possession that ended in a
 * shot, so the winger whose cross another player converts is rewarded. FPL
 * points and ICT `threat` both under-reward exactly that contribution, which
 * is why this replaces calcPlayerForm on the ATTACKING side of a pairing.
 * The defending side keeps calcPlayerForm — Understat publishes no per-player
 * defensive data at any endpoint, so there is nothing to replace it with.
 *
 * Minutes-weighted so likely starters drive the read; players with no minutes
 * or no Understat match drop out rather than diluting it.
 *
 * @param {Player[]} players
 * @param {object}   ctx  buildScoreContext result
 * @returns {number|null}  mean xGChain per 90 (raw rate, ~0.15–0.80 in the PL),
 *                         or null when no eligible player is matched.
 */
export function minutesWeightedMeanChain(players, ctx) {
  const lookup = ctx?.understatPlayersByName;
  if (!lookup || !players || players.length === 0) return null;

  let sum = 0;
  let totalW = 0;
  for (const p of players) {
    const minutes = p.totals?.minutes ?? 0;
    if (minutes <= 0) continue;
    const key = (p.fullName || '').toLowerCase().trim();
    const sig = key ? buildRoleSignature(lookup[key]) : null;
    if (!sig) continue;
    sum    += sig.chain90 * minutes;
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
 * Build a { playerId → role } map for one team's players, plus a flag for how
 * well chain data covered the squad.
 *
 * MODEL: per-player tiering, NOT fail-closed. Phase 3C dropped the whole team
 * to element_type grouping when under 90% of outfielders classified, because
 * mixing refined and unrefined players understates whichever side has worse
 * coverage. That argument applies to mixing TAXONOMIES — chain and ICT emit
 * the same eight labels from different evidence, so a per-player fallback is
 * sound and strictly more informative than collapsing the squad.
 *
 * @param {Player[]} players
 * @param {object}   ctx  buildScoreContext result (read for chain signatures)
 * @returns {{rolesByPlayerId: Object<number,string>, estimated: boolean}|null}
 *          null when no outfielder has any minutes — caller falls back to
 *          element_type grouping. estimated:true when chain data covered less
 *          than ROLE_CHAIN_COVERAGE_MIN of outfield minutes.
 */
export function classifyTeamRoles(players, ctx) {
  const rolesByPlayerId = {};
  let outfieldMinutes = 0;
  let chainCoveredMinutes = 0;

  const lookup = ctx?.understatPlayersByName;

  for (const p of players || []) {
    const minutes = p.totals?.minutes ?? 0;
    const role = classifyRole(p, ctx);
    if (role) rolesByPlayerId[p.id] = role;

    if (p.position === 'GKP' || minutes <= 0) continue;
    outfieldMinutes += minutes;

    // Coverage is measured on the SAME conditions classifyRole uses for its
    // tier-1 branch, so the flag can never disagree with what was actually used.
    const key = (p.fullName || '').toLowerCase().trim();
    const up  = (lookup && key) ? lookup[key] : null;
    if (up
        && parseFloat(up.time)    >= ROLE_SIGNATURE_MIN_MINUTES
        && parseFloat(up.xGChain) >= ROLE_SIGNATURE_MIN_CHAIN) {
      chainCoveredMinutes += minutes;
    }
  }

  if (outfieldMinutes === 0) return null;

  return {
    rolesByPlayerId,
    estimated: (chainCoveredMinutes / outfieldMinutes) < ROLE_CHAIN_COVERAGE_MIN,
  };
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
 * @returns {{value: number|null, estimated: boolean, maturity: number,
 *            pairings: Object, mode: 'channel'}}
 *          value is null and maturity 0 when Understat has published nothing
 *          for either team — the UI renders blank rows and the composite gives
 *          the metric no weight at all.
 */
export function calcCounterMatchup(teamA, teamB, ctx) {
  // Channel is now the ONLY tier. Everything below is the retired role /
  // element pairing ladder, kept commented rather than deleted so it can be
  // switched back on wholesale if the channel read disappoints in-season.
  //
  // RETIRED 2026-08-21. It scored a team's attacking unit against the
  // opponent's defending unit by position pairing (ST vs CB, Wingers vs
  // Fullbacks, CAM vs CDM). Replaced because it answered a quality question
  // ("are my strikers better than their centre-backs") rather than a matchup
  // question ("does the way I score match the way they concede"), and because
  // its 120-shot gate meant the better read was unavailable until ~GW10.
  //
  // TO RE-ENABLE: uncomment the block below and restore the `if (channel)
  // return channel;` guard in place of the unconditional return. classifyRole,
  // buildRoleSignature, classifyRoleFromSignature, ROLE_ATTACK_GROUPS and
  // ROLE_DEFENCE_GROUPS are all still live — the channel tier's personnel
  // weighting and duelsForPairing depend on them — so only this block and
  // classifyTeamRoles need waking up.
  return calcChannelCounter(teamA, teamB, ctx);

//   const playersA = ctx.playersByTeamId?.[teamA.id] || [];
//   const playersB = ctx.playersByTeamId?.[teamB.id] || [];
// 
//   const roleResultA = classifyTeamRoles(playersA, ctx);
//   const roleResultB = classifyTeamRoles(playersB, ctx);
//   const useRoles = roleResultA !== null && roleResultB !== null;
// 
//   const rolesA = roleResultA?.rolesByPlayerId ?? null;
//   const rolesB = roleResultB?.rolesByPlayerId ?? null;
// 
//   const pairingWeights = useRoles ? ROLE_PAIRING_WEIGHTS    : PAIRING_WEIGHTS;
//   const attackGroups   = useRoles ? ROLE_ATTACK_GROUPS      : ELEMENT_ATTACK_GROUPS;
//   const defenceGroups  = useRoles ? ROLE_DEFENCE_GROUPS     : ELEMENT_DEFENCE_GROUPS;
// 
//   const pairings = {};
//   let weightedSum = 0;
//   let totalWeight = 0;
//   // MODEL: an element_type fallback for either side flags the whole metric as
//   // estimated, and so does thin chain coverage — a role grouping built mostly
//   // from ICT is materially less trustworthy than one built from chain data.
//   let anyEstimated = !useRoles
//     || (roleResultA?.estimated ?? false)
//     || (roleResultB?.estimated ?? false);
// 
//   for (const key of Object.keys(pairingWeights)) {
//     const attackers = useRoles
//       ? selectByRole(playersA, attackGroups[key], rolesA)
//       : selectByPosition(playersA, attackGroups[key]);
//     const defenders = useRoles
//       ? selectByRole(playersB, defenceGroups[key], rolesB)
//       : selectByPosition(playersB, defenceGroups[key]);
// 
//     // MODEL: prefer the chain read of the attacking unit; fall back to the
//     // form read when Understat can't supply one. Normalised onto the same
//     // 0–100 scale calcPlayerForm returns, so pairingEdge stays comparable
//     // across both paths.
//     const attackChain = minutesWeightedMeanChain(attackers, ctx);
//     const attackForm  = attackChain !== null
//       ? normaliseLinear(attackChain, CHAIN_UNIT_ANCHORS.min, CHAIN_UNIT_ANCHORS.max)
//       : minutesWeightedMeanForm(attackers, ctx);
//     const defenceForm = minutesWeightedMeanForm(defenders, ctx);
// 
//     let pairingScore;
//     let pairingEstimated = false;
//     if (attackForm === null || defenceForm === null) {
//       // MODEL: missing unit data → fall back to strength priors and flag.
//       pairingScore = fallbackPairingFromStrength(teamA, teamB);
//       pairingEstimated = true;
//       anyEstimated = true;
//     } else {
//       // signed: positive = A's attack outperforms B's defence on form.
//       const pairingEdge = attackForm - defenceForm;
//       pairingScore = clamp(0, 100, 50 + (pairingEdge * COUNTER_SENSITIVITY));
//     }
// 
//     pairings[key] = {
//       value:        pairingScore,
//       weight:       pairingWeights[key],
//       estimated:    pairingEstimated,
//       attackForm,
//       defenceForm,
//       attackSource: attackChain !== null ? 'chain' : 'form',
//       attackerCount: attackers.length,
//       defenderCount: defenders.length,
//     };
// 
//     weightedSum += pairingScore * pairingWeights[key];
//     totalWeight += pairingWeights[key];
//   }
// 
//   // MODEL: totalWeight is 0 only if the active pairing-weights table is empty —
//   // a config bug. Defensive 50/estimated rather than NaN if that ever happens.
//   const value = totalWeight === 0
//     ? 50
//     : clamp(0, 100, weightedSum / totalWeight);
// 
//   return {
//     value,
//     estimated: anyEstimated || totalWeight === 0,
//     pairings,
//     mode: useRoles ? 'role' : 'element',
//   };
}

// ─── Defending Counters (mirrored pairings) ──────────────────────────────────

// Attacking pairing key → its defending mirror. Covers both the role-mode keys
// (ROLE_ATTACK_GROUPS/ROLE_DEFENCE_GROUPS) and the element-fallback keys
// (ELEMENT_ATTACK_GROUPS/ELEMENT_DEFENCE_GROUPS) — either can be the active
// mode depending on ICT data availability, so both need a mirror.
const MIRRORED_PAIRING_KEYS = {
  stVsCb:      'cbVsSt',
  wmVsFb:      'fbVsWm',
  cmVsCbDm:    'cbDmVsCm',
  fwdVsCb:     'cbVsFwd',
  wideMidVsFb: 'fbVsWideMid',
  camVsCbMid:  'cbMidVsCam',
  // Channel tier. The mirror is still arithmetic (100 − attacking value), NOT
  // a second read from the defending team's own statistics.against — deriving
  // it independently would break the sum-to-100 identity §7.2 depends on.
  setPieceThreat: 'setPieceDefence',
  wideTransition: 'transitionDefence',
  boxThreat:      'boxDefence',
};

/**
 * Derive "Defending Counters" from an already-computed calcCounterMatchup()
 * result — the same attack-vs-defence interaction, re-read from the defending
 * side. NOT a second independent calculation: each mirrored pairing's value
 * is exactly `100 - attackingPairing.value`, so the two are guaranteed to sum
 * to 100 by construction (see FEATURE_ENGINE.md §7.2). This holds even
 * through clamp(0,100,...): 100 - clamp(0,100,y) === clamp(0,100,100-y) for
 * every real y, so the identity survives the attacking side's own clamping.
 *
 * Call with the OPPONENT's attacking result to get THIS team's defending
 * pairings — e.g. for home team's "my defence vs their attack" section, pass
 * awayTeam's calcCounterMatchup(awayTeam, homeTeam, ctx) result.
 *
 * @param {{pairings: Object, estimated: boolean}} attackingResult
 *   output of calcCounterMatchup (or composite.js's breakdown.counterMatchup,
 *   same shape) for the OTHER team's attack against this team's defence.
 * @returns {{value: number, estimated: boolean, pairings: Object}}
 *   value: 0–100, higher = better defensively for the team this mirror is for.
 */
export function calcCounterMatchupMirrored(attackingResult) {
  const pairings = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, p] of Object.entries(attackingResult.pairings)) {
    const mirroredKey = MIRRORED_PAIRING_KEYS[key] ?? `${key}Mirrored`;
    // MODEL: a blank pairing mirrors to blank, never to 100. `100 - null` is
    // 100 in JS — a confident-looking score invented out of no data at all.
    const mirroredValue = p.value === null || p.value === undefined ? null : 100 - p.value;
    if (mirroredValue === null) {
      pairings[mirroredKey] = { ...p, value: null };
      continue;
    }

    pairings[mirroredKey] = {
      value:         mirroredValue,
      weight:        p.weight,
      estimated:     p.estimated,
      attackForm:    p.attackForm,
      defenceForm:   p.defenceForm,
      attackerCount: p.attackerCount,
      defenderCount: p.defenderCount,
    };

    weightedSum += mirroredValue * p.weight;
    totalWeight += p.weight;
  }

  // totalWeight is 0 when every pairing was blank — mirror that as blank too,
  // rather than a defensive 50 that reads like a real neutral score.
  const value = totalWeight === 0
    ? null
    : clamp(0, 100, weightedSum / totalWeight);

  return {
    value,
    estimated: attackingResult.estimated || totalWeight === 0,
    maturity: attackingResult.maturity ?? (attackingResult.estimated ? 0 : 1),
    pairings,
  };
}

/**
 * Blend a team's Attacking Counters (its attack vs the opponent's defence,
 * `calcCounterMatchup(team, opponent, ctx)`) with its Defending Counters (its
 * defence vs the opponent's attack, `calcCounterMatchupMirrored(calcCounterMatchup
 * (opponent, team, ctx))`) into the single Counter-Matchup figure the fixture
 * composite weights (`WEIGHTS.counterMatchup`, engine/composite.js).
 *
 * MODEL: before this, the composite's Counter-Matchup term reflected ONLY a
 * team's own attacking prowess against the opponent's defence — its defensive
 * strength against THIS opponent's attack earned no direct credit on its own
 * card, only an indirect, heavily-diluted one via the opponent's raw score in
 * the §8.7 zero-sum relative step. A team with an elite defence but a
 * middling attack had that defensive quality essentially invisible to its own
 * composite. See FEATURE_ENGINE.md §7.2.
 *
 * Keeps `pairings` as the ATTACKING pairings, unblended, so existing
 * consumers keep working unchanged: the Matchup Analyser's Attacking Counters
 * rows read straight from `pairings`, and its `calcCounterMatchupMirrored(...)`
 * call for the Defending Counters section still mirrors pure attacking data
 * (preserving the `attackingValue + mirroredValue === 100` identity).
 *
 * @param {{value: number, estimated: boolean, pairings: Object}} attackingCounter
 *   this team's attack vs the opponent's defence.
 * @param {{value: number, estimated: boolean}} defendingCounter
 *   this team's defence vs the opponent's attack (already mirrored).
 * @returns {{value: number, estimated: boolean, pairings: Object,
 *            attackingValue: number, defendingValue: number}}
 *   value: 0–100, blend of attackingCounter.value and defendingCounter.value.
 *   attackingValue/defendingValue: the two unblended inputs, exposed so the
 *   UI can explain the blend (ARCHITECTURE.md §12 rule 6).
 */
export function calcCombinedCounterMatchup(attackingCounter, defendingCounter) {
  return {
    value: clamp(0, 100,
      (COUNTER_ATTACK_WEIGHT * attackingCounter.value) + (COUNTER_DEFENCE_WEIGHT * defendingCounter.value)),
    estimated:      attackingCounter.estimated || defendingCounter.estimated,
    pairings:       attackingCounter.pairings,
    attackingValue: attackingCounter.value,
    defendingValue: defendingCounter.value,
    // Which tier produced the pairings above ('channel' | 'role' | 'element').
    // Taken from the ATTACKING read because `pairings` is the attacking read —
    // the two must always describe the same object. Surfaced so the testing
    // roadmap's tier check and the channel-vs-role comparison can see it
    // without re-deriving which tier ran.
    mode: attackingCounter.mode,
  };
}

// ─── Pairing → individual-duel bridge ────────────────────────────────────────

// Every pairing key in the app — role-mode (stVsCb…), element-fallback
// (fwdVsCb…), and defending mirror (cbVsSt…) — describes the same three
// underlying unit interactions, so one alias table collapses all of them onto
// the canonical role-mode key. Lives here, not in matchup.js, so the knowledge
// of which roles constitute a pairing stays in the module that defines it.
const PAIRING_ROLE_ALIAS = {
  // attacking, role mode
  stVsCb: 'stVsCb',       wmVsFb: 'wmVsFb',           cmVsCbDm: 'cmVsCbDm',
  // attacking, element fallback
  fwdVsCb: 'stVsCb',      wideMidVsFb: 'wmVsFb',      camVsCbMid: 'cmVsCbDm',
  // defending mirrors — same two units, viewed from the defending side
  cbVsSt: 'stVsCb',       fbVsWm: 'wmVsFb',           cbDmVsCm: 'cmVsCbDm',
  cbVsFwd: 'stVsCb',      fbVsWideMid: 'wmVsFb',      cbMidVsCam: 'cmVsCbDm',
};

/**
 * Select the individual duels that sit behind a given position-group pairing —
 * i.e. the actual named players whose form produced that pairing's score.
 *
 * Pure filter over an existing calcIndividualDuels() result. Deliberately does
 * NOT re-identify players: the duel list already resolved likely XI, roles and
 * defender assignment, so re-deriving any of that here would risk the info
 * panel disagreeing with the Individual Duels section on the same card.
 *
 * @param {Array} duels        output of calcIndividualDuels for the ATTACKING side
 *   of this pairing (for a defending pairing, that is the opponent's duel list).
 * @param {string} pairingKey  any attacking, element-fallback, or defending key.
 * @returns {Array} the subset of `duels` belonging to that pairing; [] when the
 *   key is unknown or no duel matched (caller renders a no-data state).
 */
export function duelsForPairing(duels, pairingKey) {
  // MODEL: channel-tier axes are team shot-profile shares, not player-vs-player
  // pairings, so there is no honest duel list to show. Return empty and let the
  // UI render its explicit "no player data" state rather than surfacing duels
  // that had no part in the score.
  if (!(pairingKey in PAIRING_ROLE_ALIAS)) return [];

  const canonical = PAIRING_ROLE_ALIAS[pairingKey];
  if (!canonical || !duels || duels.length === 0) return [];
  const attackRoles  = ROLE_ATTACK_GROUPS[canonical];
  const defenceRoles = ROLE_DEFENCE_GROUPS[canonical];
  return duels.filter(d =>
    attackRoles.includes(d.attacker.role) && defenceRoles.includes(d.defender.role));
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
    const r = classifyRole(e.player, ctx);
    if (r) rolesA[e.player.id] = r;
  }
  const rolesB = {};
  for (const e of xiB) {
    const r = classifyRole(e.player, ctx);
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

  // MODEL: distribute attackers across the defensive unit rather than dog-piling
  // every WM onto the same FB. A defender becomes "taken" the moment it's picked
  // as a primary opponent; subsequent attackers in the same role family prefer
  // an untaken candidate. Reuse is only allowed when the candidate pool is
  // exhausted (small unit — e.g. three CMs sharing two CBs).
  const takenDefenderIds = new Set();
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
    // Sort by minutes-security desc so the most-likely starters are preferred.
    candidates.sort((a, b) => b.form.minutesSecurity - a.form.minutesSecurity);
    // MODEL: prefer an untaken defender; fall back to allowing reuse only when
    // every candidate in the role pool has already been assigned. That keeps a
    // 1-CB pool from blanking the second striker entirely while still spreading
    // the load whenever the unit is large enough.
    const def = candidates.find(c => !takenDefenderIds.has(c.player.id))
             ?? candidates[0];
    takenDefenderIds.add(def.player.id);

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
