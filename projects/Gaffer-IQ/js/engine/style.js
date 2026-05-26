/**
 * js/engine/style.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds team style profiles and computes the style clash score between two teams.
 * See FEATURE_ENGINE.md §6.
 *
 * Phase 3A: when ctx.xgProfilesByTeamId is populated (Understat league xG is
 * loaded) the three axes — attackDirectness, defensiveHeight, tempo — come from
 * real per-game xG / xGA min-max normalised across all 20 PL teams. Without
 * Understat data the function falls back to the Phase 1 FPL-derivable proxies
 * (goals-for, clean-sheet rate, total goals per game), flagged estimated.
 *
 * All outputs: 0–100, higher = favourable for the team being scored.
 */

import { STYLE_RULES, STYLE_ANCHORS, MIN_VENUE_GAMES, UNDERSTAT_TEAM_SLUGS } from '../config.js';
import { clamp, invert, normaliseLinear } from '../util.js';

// ─── §6.1  Style profile ─────────────────────────────────────────────────────

/**
 * Build the league-wide xG-based style profile lookup from an Understat
 * league/EPL payload. Pure helper consumed by buildScoreContext so the
 * min-max normalisation runs once per ctx, not once per fixture.
 *
 * MODEL: using Understat xG — real underlying-numbers feed every axis. xGA is
 * inverted (higher xGA = leakier defence) so the defensiveHeight axis keeps
 * the "higher = better" convention universal across the engine (§1).
 *
 * @param {object} leagueXg          parsed Understat league/EPL JSON blocks
 * @param {object} teamsById         FPL team id → Team
 * @returns {Object<number,object>|null}  null when no team could be matched.
 */
export function buildXgProfilesByTeamId(leagueXg, teamsById) {
  if (!leagueXg || !leagueXg.teamsData) return null;

  const understatTeams = Object.values(leagueXg.teamsData);
  // Understat title is space-separated ('Manchester City'); UNDERSTAT_TEAM_SLUGS
  // uses the same name with underscores. Convert once and match by title.
  const findUnderstatTeam = (slug) => {
    const target = slug.replace(/_/g, ' ');
    return understatTeams.find(t => t && t.title === target) || null;
  };

  const rawByTeamId = {};
  for (const team of Object.values(teamsById)) {
    const slug = UNDERSTAT_TEAM_SLUGS[team.id];
    if (!slug) continue;
    const up = findUnderstatTeam(slug);
    if (!up || !Array.isArray(up.history) || up.history.length === 0) continue;

    let xgSum = 0;
    let xgaSum = 0;
    for (const m of up.history) {
      xgSum  += parseFloat(m.xG)  || 0;
      xgaSum += parseFloat(m.xGA) || 0;
    }
    const games = up.history.length;
    rawByTeamId[team.id] = {
      games,
      xgPerGame:    xgSum  / games,
      xgaPerGame:   xgaSum / games,
      tempoPerGame: (xgSum + xgaSum) / games,
      understatTitle: up.title,
    };
  }

  const raws = Object.values(rawByTeamId);
  if (raws.length === 0) return null;

  // Min-max across the 20 PL teams (or however many we matched) — FEATURE_ENGINE.md §1.
  let xgMin = raws[0].xgPerGame,    xgMax = raws[0].xgPerGame;
  let xgaMin = raws[0].xgaPerGame,  xgaMax = raws[0].xgaPerGame;
  let tMin = raws[0].tempoPerGame,  tMax = raws[0].tempoPerGame;
  for (const r of raws) {
    if (r.xgPerGame    < xgMin)  xgMin  = r.xgPerGame;
    if (r.xgPerGame    > xgMax)  xgMax  = r.xgPerGame;
    if (r.xgaPerGame   < xgaMin) xgaMin = r.xgaPerGame;
    if (r.xgaPerGame   > xgaMax) xgaMax = r.xgaPerGame;
    if (r.tempoPerGame < tMin)   tMin   = r.tempoPerGame;
    if (r.tempoPerGame > tMax)   tMax   = r.tempoPerGame;
  }

  const profilesByTeamId = {};
  for (const [teamId, r] of Object.entries(rawByTeamId)) {
    profilesByTeamId[teamId] = {
      // MODEL: using Understat xG — directness ≈ sustained scoring threat per game.
      attackDirectness: normaliseLinear(r.xgPerGame, xgMin, xgMax),
      // MODEL: using Understat xG — invert xGA so higher = stronger defensive resistance.
      defensiveHeight:  invert(normaliseLinear(r.xgaPerGame, xgaMin, xgaMax)),
      // MODEL: using Understat xG — combined xG involvement proxies match tempo.
      tempo:            normaliseLinear(r.tempoPerGame, tMin, tMax),
      games:            r.games,
      xgPerGame:        r.xgPerGame,
      xgaPerGame:       r.xgaPerGame,
      tempoPerGame:     r.tempoPerGame,
      source:           'understat',
      understatTitle:   r.understatTitle,
    };
  }
  return profilesByTeamId;
}

/**
 * Team style profile on three axes. Each axis is 0–100, higher = stronger on
 * that dimension for the team in question.
 *
 *   attackDirectness — sustained scoring threat per game.
 *   defensiveHeight  — resistance to conceding chances (xGA inverted).
 *   tempo            — total xG / goals per game in the team's matches.
 *
 * Data source: Understat when ctx.xgProfilesByTeamId is populated, otherwise
 * the Phase 1 FPL-derivable proxies. See FEATURE_ENGINE.md §6.1.
 *
 * @param {Team} team
 * @param {object} ctx  { playedFixtures, xgProfilesByTeamId? }
 * @returns {{attackDirectness: number, defensiveHeight: number, tempo: number,
 *            games: number, estimated: boolean, source: 'understat'|'fpl-proxy'}}
 */
export function calcStyleProfile(team, ctx) {
  const understatProfile = ctx.xgProfilesByTeamId?.[team.id];
  if (understatProfile) {
    // MODEL: using Understat xG — real underlying-numbers feed the three axes.
    // Estimated only when the team has too few matches to be reliable; the xG
    // numbers themselves are league-relative so the metric self-calibrates.
    return {
      ...understatProfile,
      estimated: understatProfile.games < MIN_VENUE_GAMES,
    };
  }

  // MODEL: using FPL proxy (no Understat data) — fall back to goals-for,
  // clean-sheet rate, and total-goals-per-game proxies as in Phase 1. Flagged
  // estimated so confidence drops everywhere this profile feeds the composite.
  const fixtures = (ctx.playedFixtures || []).filter(
    f => f.homeTeamId === team.id || f.awayTeamId === team.id,
  );

  if (fixtures.length === 0) {
    // MODEL: using FPL proxy (no Understat data) — no games either → neutral 50, flagged.
    return {
      attackDirectness: 50,
      defensiveHeight:  50,
      tempo:            50,
      games:            0,
      estimated:        true,
      source:           'fpl-proxy',
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
    // MODEL: using FPL proxy (no Understat data) — no completed matches yet.
    return {
      attackDirectness: 50,
      defensiveHeight:  50,
      tempo:            50,
      games:            0,
      estimated:        true,
      source:           'fpl-proxy',
    };
  }

  const goalsPerGame      = goalsFor     / counted;
  const cleanSheetRate    = cleanSheets  / counted;
  const totalGoalsPerGame = totalGoals   / counted;

  const a = STYLE_ANCHORS;
  // MODEL: using FPL proxy (no Understat data) — anchors come from config STYLE_ANCHORS.
  return {
    attackDirectness: normaliseLinear(goalsPerGame,      a.attackDirectness.min, a.attackDirectness.max),
    defensiveHeight:  normaliseLinear(cleanSheetRate,    a.defensiveHeight.min,  a.defensiveHeight.max),
    tempo:            normaliseLinear(totalGoalsPerGame, a.tempo.min,            a.tempo.max),
    games:            counted,
    // Thin sample still yields a profile, but flag it so confidence drops.
    // Proxy-derived profiles are always flagged at least until xG arrives.
    estimated:        true,
    source:           'fpl-proxy',
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
 * are merely neutral on one side.
 *
 * Phase 3A: when both profiles come from Understat the value is fully trusted;
 * if either side falls back to the FPL proxy we still produce a value but flag
 * estimated:true so confidence drops, matching the Phase 1 behaviour.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx
 * @returns {{value: number, estimated: boolean, profileA: object, profileB: object,
 *            clashDelta: number}}
 *   value: 0–100, higher = favourable style clash for `teamA`.
 *   See FEATURE_ENGINE.md §6.2.
 */
export function calcStyleClash(teamA, teamB, ctx) {
  const profileA = calcStyleProfile(teamA, ctx);
  const profileB = calcStyleProfile(teamB, ctx);

  // MODEL: speculative metric on thin or proxy-only data → neutral 50, flagged.
  // We still run the rules below for diagnostic output but force the value to
  // neutral when either profile is estimated. With Understat data this branch
  // only fires for teams with very few matches played; with the FPL proxy it
  // fires for every fixture.
  if (profileA.estimated || profileB.estimated) {
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
