/**
 * js/engine/fixtures.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes fixture-level metrics: base difficulty, home/away split performance,
 * and fixture history (head-to-head). See FEATURE_ENGINE.md §2–§4.
 * All outputs: 0–100. Higher = easier/better for the team being scored, EXCEPT
 * calcBaseDifficulty, which is stored higher = HARDER — see its own doc block
 * and FEATURE_ENGINE.md §1 rule 2 / §2 for why.
 */

import {
  W_OPP_ATTACK, W_OPP_DEFENCE, OPP_STRENGTH_MIN, OPP_STRENGTH_MAX,
  FDR_FALLBACK_VALUES,
  TENURE_MAX_PENALTY, TENURE_FLOOR, TENURE_CURVE,
  W_PPG, W_GD, MIN_VENUE_GAMES,
  N_H2H,
} from '../config.js';
import { clamp, normaliseLinear } from '../util.js';

// ─── §2  Base fixture difficulty ─────────────────────────────────────────────

/**
 * Points deducted from an opponent's strength reading to reflect how little
 * recent Premier League history that opponent has.
 *
 * MODEL: FPL's strength_* priors systematically over-rate newly promoted sides,
 * because they are seeded rather than earned. Tenure is a pure punishment — it
 * only ever lowers a reading, and only ever the reading of the side that lacks
 * history. An established club's own numbers are never touched.
 *
 * @param {Team} opponent  the side whose strength is being read
 * @returns {number}       0–TENURE_MAX_PENALTY; 0 for an ever-present club.
 *   See FEATURE_ENGINE.md §2.1.
 */
export function calcTenurePenalty(opponent) {
  const ratio = opponent?.plTenure?.ratio ?? 0;
  const deficit = clamp(0, 1, 1 - ratio);
  // MODEL: the curve is what keeps this a promoted-team rule rather than a tax
  // on anyone who was ever in the Championship. A club with several consecutive
  // recent seasons up carries a small deficit, which TENURE_CURVE shrinks to
  // near-nothing; a genuine newcomer sits at deficit 1 and takes the full hit.
  return TENURE_MAX_PENALTY * (deficit ** TENURE_CURVE);
}

/**
 * Base fixture difficulty facing `team` — an absolute read of how strong
 * `opponent` is, tempered by how much top-flight history they actually have.
 * Always available — never estimated.
 *
 * A strong club posts the same high number in whoever's box it appears in:
 * Man City are a hard fixture for Wolves and for Arsenal alike. Two weak sides
 * meeting produces a low number on both sides of the tie.
 *
 * @param {Team} team       team being scored (used only to resolve venue)
 * @param {Team} opponent   the side whose strength this measures
 * @param {boolean} isHome  true if `team` is the home side
 * @param {number} [fdrForTeam]  `team`'s own FPL FDR (1-5) for this fixture —
 *   fixture.fplDifficulty.home/away, picked by the caller per `isHome`. Only
 *   consulted when FPL's granular strength fields read as not-yet-published
 *   (see MODEL note below); optional so existing call sites without a fixture
 *   in scope keep working.
 * @returns {{value: number, estimated: boolean, rawStrength: number,
 *            strengthScore: number, tenurePenalty: number, tenureRatio: number,
 *            usedFdrFallback: boolean}}
 *   value: 0–100.
 *   Direction: **higher = HARDER for `team`** — the one metric in the engine
 *   stored inverted relative to FEATURE_ENGINE.md §1 rule 2, because the UI
 *   surfaces it directly as "how tough is this opponent". engine/composite.js
 *   applies invert() before weighting it. See FEATURE_ENGINE.md §2.
 */
export function calcBaseDifficulty(team, opponent, isHome, fdrForTeam) {
  // MODEL: the opponent is read at the venue they will actually play at — an
  // away side is measured on its away strengths. calcHomeAwaySplit then layers
  // a separate, data-driven venue adjustment on top.
  const oppThreat = isHome ? opponent.strength.attackAway  : opponent.strength.attackHome;
  const oppResist = isHome ? opponent.strength.defenceAway : opponent.strength.defenceHome;

  const rawStrength = (W_OPP_ATTACK * oppThreat) + (W_OPP_DEFENCE * oppResist);

  // MODEL: FPL occasionally leaves the granular attack/defence breakdown at 0
  // for every team (confirmed live on bootstrap-static during 2026/27
  // preseason) while the fixture's own FDR is already published. A real
  // strength int never reads 0 (FPL's scale runs ~1000-1400), so both fields
  // being exactly 0 is a reliable "not yet published" signal, not a real
  // reading — fall back to FDR_FALLBACK_VALUES rather than let
  // normaliseLinear floor this at 0 (reads as "impossibly easy" once
  // inverted in the composite). See config.js.
  const strengthDataMissing = oppThreat === 0 && oppResist === 0;
  const fdrFallback = FDR_FALLBACK_VALUES[fdrForTeam];
  const usedFdrFallback = strengthDataMissing && fdrFallback !== undefined;

  const strengthScore = usedFdrFallback
    ? fdrFallback
    : normaliseLinear(rawStrength, OPP_STRENGTH_MIN, OPP_STRENGTH_MAX);

  // Tenure can only ever pull a reading DOWN. The outer min() is what stops the
  // floor from lifting a club that FPL already rates below TENURE_FLOOR.
  const tenurePenalty = calcTenurePenalty(opponent);
  const value = tenurePenalty > 0
    ? Math.min(strengthScore, Math.max(TENURE_FLOOR, strengthScore - tenurePenalty))
    : strengthScore;

  return {
    value,
    // A promoted side's low reading, and the FDR fallback above, are both
    // known facts rather than data gaps — so this stays false and confidence
    // is untouched. Only genuinely missing inputs set estimated
    // (CONVENTIONS.md §9, FEATURE_ENGINE.md §8.3).
    estimated: false,
    rawStrength,
    strengthScore,
    tenurePenalty,
    tenureRatio: opponent?.plTenure?.ratio ?? 0,
    usedFdrFallback,
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
