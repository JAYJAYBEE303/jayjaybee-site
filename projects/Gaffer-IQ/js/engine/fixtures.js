/**
 * js/engine/fixtures.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes fixture-level metrics: base difficulty, home/away split performance,
 * and fixture history (head-to-head). See FEATURE_ENGINE.md §2–§4.
 * All outputs: 0–100, higher = easier/better for the team being scored.
 */

import {
  W_ATTACK_EDGE, W_DEFENCE_EDGE, EDGE_MIN, EDGE_MAX,
  W_PPG, W_GD, MIN_VENUE_GAMES,
  N_H2H,
} from '../config.js';
import { clamp, normaliseLinear } from '../util.js';

// ─── §2  Base fixture difficulty ─────────────────────────────────────────────

/**
 * Base fixture difficulty for `team` playing `opponent` at the given venue,
 * derived from FPL strength priors. Always available — never estimated.
 *
 * @param {Team} team       team being scored
 * @param {Team} opponent
 * @param {boolean} isHome  true if `team` is the home side
 * @returns {{value: number, estimated: boolean, attackEdge: number, defenceEdge: number}}
 *   value: 0–100, higher = easier fixture for `team`.
 *   Direction: higher = better for `team`.
 *   See FEATURE_ENGINE.md §2 for the formula.
 */
export function calcBaseDifficulty(team, opponent, isHome) {
  // MODEL: venue-specific strength fields enter here — home side uses its home
  // strengths, away side uses its away strengths. calcHomeAwaySplit then layers
  // a separate, data-driven venue adjustment on top.
  const ownThreat = isHome ? team.strength.attackHome  : team.strength.attackAway;
  const ownResist = isHome ? team.strength.defenceHome : team.strength.defenceAway;
  const oppThreat = isHome ? opponent.strength.attackAway  : opponent.strength.attackHome;
  const oppResist = isHome ? opponent.strength.defenceAway : opponent.strength.defenceHome;

  const attackEdge  = ownThreat - oppResist;   // higher = `team` can score
  const defenceEdge = ownResist - oppThreat;   // higher = `team` can keep them out
  const rawEdge = (W_ATTACK_EDGE * attackEdge) + (W_DEFENCE_EDGE * defenceEdge);

  return {
    value: normaliseLinear(rawEdge, EDGE_MIN, EDGE_MAX),
    estimated: false,
    attackEdge,
    defenceEdge,
  };
}

// ─── §3  Home/away split performance ─────────────────────────────────────────

/**
 * Internal: aggregate every team's home & away results from this season's played
 * fixtures into a flat per-team venue-stats record. Pure helper; takes the played
 * subset to avoid re-filtering on every call.
 *
 * @param {Fixture[]} playedFixtures
 * @returns {Object<number, {homePPG, awayPPG, homeGD, awayGD, homeGames, awayGames}>}
 */
function buildVenueStats(playedFixtures) {
  const init = () => ({
    homeGames: 0, awayGames: 0,
    homePts:   0, awayPts:   0,
    homeGd:    0, awayGd:    0,
  });
  const accum = {};
  for (const f of playedFixtures) {
    if (!f.result) continue;
    const home = (accum[f.homeTeamId] ||= init());
    const away = (accum[f.awayTeamId] ||= init());
    const hg = f.result.homeGoals;
    const ag = f.result.awayGoals;
    home.homeGames += 1;
    home.homeGd    += hg - ag;
    home.homePts   += hg > ag ? 3 : hg === ag ? 1 : 0;
    away.awayGames += 1;
    away.awayGd    += ag - hg;
    away.awayPts   += ag > hg ? 3 : hg === ag ? 1 : 0;
  }
  const out = {};
  for (const [teamId, s] of Object.entries(accum)) {
    out[teamId] = {
      homeGames: s.homeGames,
      awayGames: s.awayGames,
      homePPG:   s.homeGames ? s.homePts / s.homeGames : 0,
      awayPPG:   s.awayGames ? s.awayPts / s.awayGames : 0,
      homeGD:    s.homeGames ? s.homeGd  / s.homeGames : 0,
      awayGD:    s.awayGames ? s.awayGd  / s.awayGames : 0,
    };
  }
  return out;
}

function rawVenueValue(stats, isHome) {
  if (!stats) return null;
  const ppg = isHome ? stats.homePPG : stats.awayPPG;
  const gd  = isHome ? stats.homeGD  : stats.awayGD;
  return (W_PPG * ppg) + (W_GD * gd);
}

/**
 * Home/away split performance for `team` playing at the relevant venue
 * this season (independent of the FPL strength prior, which calcBaseDifficulty
 * already captures). League-relative: each team's raw venue value is normalised
 * against the spread observed across all 20 teams at the same venue.
 *
 * @param {Team} team
 * @param {boolean} isHome
 * @param {object} ctx  must contain { playedFixtures: Fixture[], teamsById: object }
 * @returns {{value: number, estimated: boolean, gamesAtVenue: number}}
 *   value: 0–100, higher = better venue form for `team`. Direction: higher = better.
 *   See FEATURE_ENGINE.md §3.
 */
export function calcHomeAwaySplit(team, isHome, ctx) {
  const venueByTeam = buildVenueStats(ctx.playedFixtures || []);
  const stats = venueByTeam[team.id];
  const gamesAtVenue = stats ? (isHome ? stats.homeGames : stats.awayGames) : 0;

  // MODEL: too few games at this venue → 50, flag estimated. We don't blend the
  // FPL strength prior in here because calcBaseDifficulty already carries it;
  // double-counting would inflate the metric's leverage.
  if (gamesAtVenue < MIN_VENUE_GAMES) {
    return { value: 50, estimated: true, gamesAtVenue };
  }

  // League-relative normalisation: bound by the observed spread of raw venue
  // values across every team that has played at this venue.
  const allValues = [];
  for (const t of Object.values(ctx.teamsById)) {
    const r = rawVenueValue(venueByTeam[t.id], isHome);
    if (r !== null) allValues.push(r);
  }
  if (allValues.length === 0) {
    return { value: 50, estimated: true, gamesAtVenue };
  }

  const raw = rawVenueValue(stats, isHome);
  let min = allValues[0];
  let max = allValues[0];
  for (const v of allValues) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    value: normaliseLinear(raw, min, max),
    estimated: false,
    gamesAtVenue,
  };
}

// ─── §4  Fixture history (head-to-head) ──────────────────────────────────────

/**
 * Head-to-head nudge: how A has fared against B in their recent meetings.
 *
 * MODEL: Phase 1 uses *this season's* meetings only — historyPast in
 * element-summary is per-player and noisy to aggregate to club level. The
 * weight on this metric is deliberately tiny (§8.1) precisely because the
 * data is thin and football H2H is weakly predictive; richer multi-season
 * depth is a Phase-4 stretch.
 *
 * @param {number} teamAId
 * @param {number} teamBId
 * @param {object} ctx  must contain { playedFixtures: Fixture[] }
 * @returns {{value: number, estimated: boolean, meetings: number, pointsForA: number}}
 *   value: 0–100, higher = A historically does well against B.
 *   Direction: higher = better for `teamA`.
 *   See FEATURE_ENGINE.md §4.
 */
export function calcFixtureHistory(teamAId, teamBId, ctx) {
  const played = ctx.playedFixtures || [];

  // Filter to meetings between A and B that have *numeric* scores. We guard
  // against FPL fixtures flagged finished with null team_h_score/team_a_score
  // (rescheduled / postponed games occasionally appear that way) — otherwise
  // they'd silently inflate the denominator below and skew one side's ratio.
  const meetings = played
    .filter(f => {
      const isPair =
        (f.homeTeamId === teamAId && f.awayTeamId === teamBId) ||
        (f.homeTeamId === teamBId && f.awayTeamId === teamAId);
      if (!isPair) return false;
      const hg = f.result?.homeGoals;
      const ag = f.result?.awayGoals;
      return Number.isFinite(hg) && Number.isFinite(ag);
    })
    .slice(-N_H2H);

  if (meetings.length < 2) {
    // MODEL: < 2 meetings (promoted side, mid-season first leg) → neutral 50,
    // flagged so confidence drops rather than the result quietly pretending
    // we know something.
    return { value: 50, estimated: true, meetings: meetings.length, pointsForA: 0 };
  }

  // Perspective: pointsForA is the points teamA earned across these meetings.
  // For each meeting we look up which side teamA was on, then compare *teamA's*
  // goals against *teamB's* goals — never the reverse. This is symmetric:
  // calling with (A,B) vs (B,A) yields each team's own points across the same
  // set of fixtures (the slice is identical because the filter is symmetric).
  let pointsForA = 0;
  for (const f of meetings) {
    const aWasHome = f.homeTeamId === teamAId;
    const goalsForA     = aWasHome ? f.result.homeGoals : f.result.awayGoals;
    const goalsAgainstA = aWasHome ? f.result.awayGoals : f.result.homeGoals;
    if (goalsForA > goalsAgainstA)      pointsForA += 3;
    else if (goalsForA === goalsAgainstA) pointsForA += 1;
  }
  const ratio = pointsForA / (3 * meetings.length);
  return {
    value: clamp(0, 100, ratio * 100),
    estimated: false,
    meetings: meetings.length,
    pointsForA,
  };
}
