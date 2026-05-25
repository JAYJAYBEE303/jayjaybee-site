/**
 * js/engine/style.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds team style profiles and computes the style clash score between two teams.
 * See FEATURE_ENGINE.md §6. Phase 1 uses FPL-derivable proxies for all three axes;
 * TODO(phase-3): replace proxies with real xG/pressing data via the proxy.
 * All outputs: 0–100, higher = favourable for the team being scored.
 */

import { STYLE_RULES, STYLE_ANCHORS, MIN_VENUE_GAMES } from '../config.js';
import { clamp, normaliseLinear } from '../util.js';

// ─── §6.1  Style profile ─────────────────────────────────────────────────────

/**
 * Team style profile on three Phase-1 proxy axes. Each axis is 0–100.
 *
 * MODEL: rich possession/pressing data isn't in the FPL API, so Phase 1 leans
 * on goals/clean-sheets/total-goals proxies. These are acknowledged simplifications
 * and the styleClash weight in the composite (§8.1) is deliberately small until
 * Phase 3 swaps them for real xG/pressing data.
 *
 * @param {Team} team
 * @param {object} ctx  { playedFixtures }
 * @returns {{attackDirectness: number, defensiveHeight: number, tempo: number,
 *            games: number, estimated: boolean}}
 *   attackDirectness — higher = scores more freely (goals-per-game proxy).
 *   defensiveHeight  — higher = concedes fewer chances (clean-sheet-rate proxy).
 *   tempo            — higher = more total goals in their matches per game.
 *   See FEATURE_ENGINE.md §6.1.
 */
export function calcStyleProfile(team, ctx) {
  const fixtures = (ctx.playedFixtures || []).filter(
    f => f.homeTeamId === team.id || f.awayTeamId === team.id,
  );

  if (fixtures.length === 0) {
    // MODEL: no data → all three axes neutral, flag estimated.
    return {
      attackDirectness: 50,
      defensiveHeight:  50,
      tempo:            50,
      games:            0,
      estimated:        true,
    };
  }

  let goalsFor = 0;
  let goalsAgainst = 0;
  let totalGoals = 0;
  let cleanSheets = 0;
  let counted = 0;
  for (const f of fixtures) {
    if (!f.result) continue;
    counted += 1;
    const isHome = f.homeTeamId === team.id;
    const gf = isHome ? f.result.homeGoals : f.result.awayGoals;
    const ga = isHome ? f.result.awayGoals : f.result.homeGoals;
    goalsFor     += gf;
    goalsAgainst += ga;
    totalGoals   += gf + ga;
    if (ga === 0) cleanSheets += 1;
  }

  if (counted === 0) {
    return {
      attackDirectness: 50,
      defensiveHeight:  50,
      tempo:            50,
      games:            0,
      estimated:        true,
    };
  }

  const goalsPerGame      = goalsFor     / counted;
  const cleanSheetRate    = cleanSheets  / counted;
  const totalGoalsPerGame = totalGoals   / counted;

  const a = STYLE_ANCHORS;
  return {
    attackDirectness: normaliseLinear(goalsPerGame,      a.attackDirectness.min, a.attackDirectness.max),
    defensiveHeight:  normaliseLinear(cleanSheetRate,    a.defensiveHeight.min,  a.defensiveHeight.max),
    tempo:            normaliseLinear(totalGoalsPerGame, a.tempo.min,            a.tempo.max),
    games:            counted,
    // MODEL: thin sample still yields a profile, but flag it so confidence drops.
    estimated:        counted < MIN_VENUE_GAMES,
    // Surfaced for the matchup module's transparency requirement (ARCHITECTURE.md §8).
    goalsPerGame,
    cleanSheetRate,
    totalGoalsPerGame,
    goalsAgainst,
  };
}

// ─── §6.2  Style clash ────────────────────────────────────────────────────────

/**
 * Directional style-clash score from team A's point of view. Interactions and
 * magnitudes live in config.js (STYLE_RULES) — this function only applies them.
 *
 * MODEL: a rule fires only when *both* teams sit above the midpoint on their
 * respective axes (co-activation). This avoids spurious deltas from teams that
 * are merely neutral on one side. Phase 3 may switch to a signed product across
 * the full -1..+1 range once real underlying-numbers back the axes.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx
 * @returns {{value: number, estimated: boolean, profileA: object, profileB: object,
 *            clashDelta: number}}
 *   value: 0–100, higher = favourable style clash for `teamA`.
 *   Direction: higher = better for `teamA`.
 *   See FEATURE_ENGINE.md §6.2.
 */
export function calcStyleClash(teamA, teamB, ctx) {
  const profileA = calcStyleProfile(teamA, ctx);
  const profileB = calcStyleProfile(teamB, ctx);

  if (profileA.estimated || profileB.estimated) {
    // MODEL: speculative metric on thin data → neutral 50, flagged. We still
    // run the rules below for diagnostic output but force the value to neutral.
    return {
      value:      50,
      estimated:  true,
      profileA,
      profileB,
      clashDelta: 0,
    };
  }

  let clashDelta = 0;
  for (const rule of STYLE_RULES) {
    // -1..+1 each: how far above (or below) the neutral midpoint each side sits
    // on the rule's relevant axis.
    const aHigh = (profileA[rule.axisA] - 50) / 50;
    const bHigh = (profileB[rule.axisB] - 50) / 50;
    // Co-activation: only positive contributions when both sides are above mid.
    const coAct = Math.max(0, aHigh) * Math.max(0, bHigh);
    clashDelta += rule.sign * rule.magnitude * coAct;
  }

  return {
    value:     clamp(0, 100, 50 + clashDelta),
    estimated: false,
    profileA,
    profileB,
    clashDelta,
  };
}
