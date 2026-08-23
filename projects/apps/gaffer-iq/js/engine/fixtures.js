/**
 * js/engine/fixtures.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes fixture-level metrics: base difficulty, home/away split performance,
 * and fixture history (head-to-head). See FEATURE_ENGINE.md §2–§4.
 * All outputs: 0–100. Higher = easier/better for the team being scored, EXCEPT
 * calcBaseDifficulty, which is stored higher = HARDER — see its own doc block
 * and FEATURE_ENGINE.md §1 rule 2 / §2 for why.
 *
 * Phase 3B: calcHomeAwaySplit's venue split prefers a rolling cross-season
 * window built from Understat match history (buildRollingVenueStatsByTeamId)
 * over the current-season-only FPL-fixtures reading, when available — see
 * that function's doc and FEATURE_ENGINE.md §3.1.
 */

import {
  W_OPP_ATTACK, W_OPP_DEFENCE, OPP_STRENGTH_MIN, OPP_STRENGTH_MAX,
  FDR_FALLBACK_VALUES,
  TENURE_MAX_PENALTY, TENURE_FLOOR, TENURE_CURVE,
  MIN_VENUE_GAMES, VENUE_ROLLING_GAMES, W_VENUE_EFFECT,
  N_H2H,
} from '../config.js';
import { clamp, normaliseLinear } from '../util.js';
import { canonicalClubKey } from './normalise.js';
import { collectUnderstatMeetings } from './h2h.js';

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
 * Internal: aggregate every team's home & away points-per-game from this
 * season's played fixtures into a flat per-team venue-stats record. Pure
 * helper; takes the played subset to avoid re-filtering on every call.
 *
 * @param {Fixture[]} playedFixtures
 * @returns {Object<number, {homePPG, awayPPG, homeGames, awayGames}>}
 */
function buildVenueStats(playedFixtures) {
  const init = () => ({ homeGames: 0, awayGames: 0, homePts: 0, awayPts: 0 });
  const accum = {};
  for (const f of playedFixtures) {
    if (!f.result) continue;
    const home = (accum[f.homeTeamId] ||= init());
    const away = (accum[f.awayTeamId] ||= init());
    const hg = f.result.homeGoals;
    const ag = f.result.awayGoals;
    home.homeGames += 1;
    home.homePts   += hg > ag ? 3 : hg === ag ? 1 : 0;
    away.awayGames += 1;
    away.awayPts   += ag > hg ? 3 : hg === ag ? 1 : 0;
  }
  const out = {};
  for (const [teamId, s] of Object.entries(accum)) {
    out[teamId] = {
      homeGames: s.homeGames,
      awayGames: s.awayGames,
      homePPG:   s.homeGames ? s.homePts / s.homeGames : 0,
      awayPPG:   s.awayGames ? s.awayPts / s.awayGames : 0,
    };
  }
  return out;
}

/**
 * Whether `stats` clears MIN_VENUE_GAMES at BOTH venues — venue sensitivity is
 * a comparison of home vs away form, so a thin sample on either side makes the
 * comparison meaningless, not just one half of it.
 * @param {object|undefined} stats
 * @returns {boolean}
 */
function hasUsableVenueSplit(stats) {
  return !!stats && stats.homeGames >= MIN_VENUE_GAMES && stats.awayGames >= MIN_VENUE_GAMES;
}

/**
 * Builds each team's rolling VENUE_ROLLING_GAMES-match (default 38 — one full
 * PL season) home/away split from real Understat match history, spanning the
 * current season and, once that runs out, last season's tail — so the window
 * reads as roughly "a full season" all year round instead of resetting to
 * nothing every August. Pure helper consumed once by buildScoreContext, same
 * precompute-once idiom as buildXgProfilesByTeamId (engine/style.js).
 *
 * MODEL: matched by NAME (canonicalClubKey), never FPL's numeric team.id —
 * same reasoning as buildXgProfilesByTeamId and buildPlTenure
 * (engine/normalise.js): ids are REASSIGNED every season as clubs are
 * promoted/relegated, so an id join silently drifts wrong the next close
 * season with no error to catch it. Small duplication of the "index Understat
 * teams by canonical key" step against buildXgProfilesByTeamId's own version —
 * kept separate because this one merges TWO seasons' entries per team before
 * indexing, which that one never needs to.
 *
 * MODEL: a team's current- and prior-season Understat records arrive as two
 * separate objects (Understat keys a "team" by team+season, not by club
 * alone) — merged into one match list per club before the window is cut.
 * `scored`/`missed` are already this team's own goals for/against per Understat
 * match (not home/away goals — h_a only marks venue), so points-per-match
 * follows directly: scored>missed→3, equal→1, else→0.
 *
 * @param {object|null} leagueXg      current season's Understat payload
 * @param {object|null} leagueXgPrev  last season's Understat payload
 * @param {object} teamsById          FPL team id → Team
 * @returns {Object<number,{homePPG:number,awayPPG:number,homeGames:number,awayGames:number}>}
 *   Keyed by FPL team id. A team absent here (no Understat match to its name —
 *   a genuine newcomer, or an Understat outage) simply has no entry; the
 *   caller falls back to the current-season FPL-fixtures path for it.
 */
export function buildRollingVenueStatsByTeamId(leagueXg, leagueXgPrev, teamsById) {
  const understatTeams = [
    ...(leagueXg?.teamsData     ? Object.values(leagueXg.teamsData)     : []),
    ...(leagueXgPrev?.teamsData ? Object.values(leagueXgPrev.teamsData) : []),
  ];
  if (understatTeams.length === 0) return {};

  const historyByKey = {};
  for (const t of understatTeams) {
    if (!t || !t.title || !Array.isArray(t.history)) continue;
    (historyByKey[canonicalClubKey(t.title)] ||= []).push(...t.history);
  }

  const out = {};
  for (const team of Object.values(teamsById)) {
    let merged = null;
    for (const raw of [team.name, team.shortName]) {
      if (!raw) continue;
      const hit = historyByKey[canonicalClubKey(raw)];
      if (hit) { merged = hit; break; }
    }
    if (!merged || merged.length === 0) continue;

    // Understat dates are 'YYYY-MM-DD HH:mm:ss' — directly Date-parseable.
    // Chronological ascending, then keep only the most recent window.
    const sorted = merged.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const window = sorted.slice(-VENUE_ROLLING_GAMES);

    let homeGames = 0, awayGames = 0, homePts = 0, awayPts = 0;
    for (const m of window) {
      const scored = Number(m.scored);
      const missed = Number(m.missed);
      if (!Number.isFinite(scored) || !Number.isFinite(missed)) continue;
      const pts = scored > missed ? 3 : scored === missed ? 1 : 0;
      if (m.h_a === 'h')      { homeGames += 1; homePts += pts; }
      else if (m.h_a === 'a') { awayGames += 1; awayPts += pts; }
    }

    out[team.id] = {
      homeGames, awayGames,
      homePPG: homeGames ? homePts / homeGames : 0,
      awayPPG: awayGames ? awayPts / awayGames : 0,
    };
  }
  return out;
}

/**
 * Resolves one team's venue stats: the Understat rolling window when it
 * clears MIN_VENUE_GAMES at both venues, else the current-season FPL-fixtures
 * fallback (same shape either way — {homePPG, awayPPG, homeGames, awayGames}
 * — so calcHomeAwaySplit never needs to know which source it got).
 * @param {number} teamId
 * @param {object} rollingByTeamId  buildRollingVenueStatsByTeamId output
 * @param {object} fplByTeamId      buildVenueStats output
 * @returns {object|undefined}
 */
function resolveVenueStats(teamId, rollingByTeamId, fplByTeamId) {
  const rolling = rollingByTeamId[teamId];
  return hasUsableVenueSplit(rolling) ? rolling : fplByTeamId[teamId];
}

/**
 * Venue-sensitivity profile for `team`: how much its home form diverges from
 * its away form. Prefers a rolling VENUE_ROLLING_GAMES-match window sourced
 * from real Understat match history (spans last season's tail once this
 * season runs low — see buildRollingVenueStatsByTeamId), falling back to the
 * current-season-only FPL-fixtures path (buildVenueStats) for any team it
 * doesn't cover — a genuine newcomer to the top flight, or an Understat
 * outage. This is a standalone read of ONE team, not a fixture read of two —
 * see calcVenueEffect below for the fixture-level combination.
 *
 * MODEL: rawSplit = homePPG − awayPPG, SIGNED — a team can be stronger away
 * (negative) as easily as at home. `value` (baseSensitivity) is the
 * league-relative normalisation of |rawSplit|: it answers "how much does
 * venue matter for this team", not "which way". Direction is preserved
 * separately as `sign` for transparency, but calcVenueEffect deliberately
 * ignores it (see that function's doc) — the fixture-level effect is
 * magnitude-only by design, so `sign` is diagnostic, not consumed downstream.
 *
 * MODEL: below MIN_VENUE_GAMES at EITHER venue (true of both sources tried) →
 * neutral 50, value only — NOT flagged estimated. Deliberately the one
 * exception to this engine's usual thin-sample guard (calcTeamForm,
 * calcFixtureHistory both DO flag estimated below their thresholds): home
 * advantage is treated as a standing structural fact about football, not a
 * per-team read that can be "missing" — a team with no usable split just
 * reads as no additional edge over the baseline (neutral 50) rather than
 * "unreliable, discard". composite.js's confidence renormalisation (§8.3)
 * would otherwise silently drop this metric out of the score entirely for
 * every promoted side, which is the behaviour being deliberately avoided.
 *
 * MODEL: the league-relative normalisation pool below mixes teams resolved
 * from either source — a genuine simplification. Both sources report the same
 * unit (points-per-game delta), just over different sample depths (up to 38
 * cross-season Understat games vs whatever's been played of the current FPL
 * season), so a team on the thinner fallback reads slightly noisier against
 * the pool, not wrongly-scaled.
 *
 * @param {Team} team
 * @param {object} ctx  must contain { playedFixtures: Fixture[], teamsById: object,
 *   rollingVenueStatsByTeamId?: object } — the last is precomputed by
 *   buildScoreContext; absent/empty ctx.rollingVenueStatsByTeamId degrades
 *   this to exactly its pre-Phase-3B behaviour (FPL fixtures only).
 * @returns {{value: number, estimated: boolean, homePPG: number, awayPPG: number,
 *            rawSplit: number, sign: -1|0|1, homeGames: number, awayGames: number}}
 *   value: 0–100 (baseSensitivity), higher = bigger home/away gap in EITHER
 *   direction. See FEATURE_ENGINE.md §3.
 */
export function calcHomeAwaySplit(team, ctx) {
  const rollingByTeamId = ctx.rollingVenueStatsByTeamId || {};
  const fplByTeamId = buildVenueStats(ctx.playedFixtures || []);
  const stats = resolveVenueStats(team.id, rollingByTeamId, fplByTeamId);
  const homeGames = stats?.homeGames ?? 0;
  const awayGames = stats?.awayGames ?? 0;

  if (!hasUsableVenueSplit(stats)) {
    // estimated:false is deliberate here — see the MODEL note above.
    return {
      value: 50, estimated: false,
      homePPG: stats?.homePPG ?? 0, awayPPG: stats?.awayPPG ?? 0,
      rawSplit: 0, sign: 0,
      homeGames, awayGames,
    };
  }

  const { homePPG, awayPPG } = stats;
  const rawSplit = homePPG - awayPPG;

  // League-relative: normalise this team's |rawSplit| against the spread of
  // |rawSplit| across every OTHER team that also clears the threshold at both
  // venues (whichever source each resolves from — see MODEL note above).
  // team's own magnitude is always included (it passed the guard above), so
  // this list is never empty.
  const magnitudes = [];
  for (const t of Object.values(ctx.teamsById)) {
    const s = resolveVenueStats(t.id, rollingByTeamId, fplByTeamId);
    if (hasUsableVenueSplit(s)) magnitudes.push(Math.abs(s.homePPG - s.awayPPG));
  }
  let min = magnitudes[0];
  let max = magnitudes[0];
  for (const v of magnitudes) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    value: normaliseLinear(Math.abs(rawSplit), min, max),
    estimated: false,
    homePPG, awayPPG, rawSplit,
    sign: Math.sign(rawSplit),
    homeGames, awayGames,
  };
}

/**
 * Fixture-level venue effect: combines BOTH teams' standalone venue
 * sensitivity (calcHomeAwaySplit) into a symmetric home boost / away penalty.
 *
 * MODEL: combinedMagnitude is a plain average of the two teams' baseSensitivity
 * regardless of whether their signs agree — a team with a huge split paired
 * with a perfectly neutral opponent (0) still produces a real, non-zero
 * effect. This is a deliberate reading: "how much does venue matter in THIS
 * fixture" is answered by either side being sensitive to venue, not by both.
 *
 * MODEL (confirmed simplification, stated explicitly per the brief driving
 * this function): each team's own `sign` is IGNORED when sizing the
 * boost/penalty. A team that is actually stronger away than home still
 * contributes its full magnitude to the HOME side's boost, exactly as a
 * traditionally home-strong team would. This is magnitude-only by design —
 * the model is "large home/away splits amplify the standard structural home
 * advantage", not "which way does each team's split point". `sign` remains
 * on each team's profile (homeBase.sign / awayBase.sign) for transparency and
 * future refinement, but calcVenueEffect does not read it.
 *
 * @param {Team} homeTeam
 * @param {Team} awayTeam
 * @param {object} ctx
 * @returns {{homeBoost: number, awayPenalty: number, combinedMagnitude: number,
 *            estimated: boolean, homeBase: object, awayBase: object}}
 *   homeBoost: points to ADD to the home side's neutral 50 (>= 0).
 *   awayPenalty: points to ADD to the away side's neutral 50 (<= 0) —
 *   always exactly −homeBoost, so the two sides' venue.value totals mirror
 *   the same neutral-50 gap on both cards. See FEATURE_ENGINE.md §3.
 */
export function calcVenueEffect(homeTeam, awayTeam, ctx) {
  const homeBase = calcHomeAwaySplit(homeTeam, ctx);
  const awayBase = calcHomeAwaySplit(awayTeam, ctx);

  const combinedMagnitude = (homeBase.value + awayBase.value) / 2;
  const homeBoost = combinedMagnitude * W_VENUE_EFFECT;

  return {
    homeBoost,
    awayPenalty: -homeBoost,
    combinedMagnitude,
    // Always false — calcHomeAwaySplit never flags estimated (see its MODEL
    // note); a thin sample on either side just reads as neutral 50 for that
    // side, not "discard the whole fixture-level effect". Kept as an OR over
    // both sides (rather than a hardcoded false) so this stays correct
    // automatically if calcHomeAwaySplit's policy ever changes.
    estimated: homeBase.estimated || awayBase.estimated,
    homeBase,
    awayBase,
  };
}

// ─── §4  Fixture history (head-to-head) ──────────────────────────────────────

/**
 * Cross-season meetings between teamA and teamB, drawn from Understat's
 * datesData across ctx.leagueXg/leagueXgPrev/leagueXgPrev2/leagueXgPrev3.
 *
 * Delegates to engine/h2h.js, which owns the collection and the name-matching
 * (by canonicalClubKey, never by Understat's numeric ids — see that module).
 * The Head-to-head VIEW needs each meeting's date, season, venue and both
 * scorelines; this scorer needs only A's end of the result, so it narrows the
 * shared record down here rather than the two keeping separate collectors.
 *
 * @returns {{date: string, goalsForA: number, goalsAgainstA: number}[]}
 *   Sorted oldest → newest. Empty when either team can't be name-matched, or
 *   no meeting between them appears in the fetched seasons (thin overlap,
 *   promoted side, or an Understat outage).
 */
function buildCrossSeasonH2hMeetings(teamAId, teamBId, ctx) {
  return collectUnderstatMeetings(teamAId, teamBId, ctx)
    .map(m => ({ date: m.date, goalsForA: m.goalsForA, goalsAgainstA: m.goalsAgainstA }));
}

/**
 * This-season-only fallback, sourced from ctx.playedFixtures (FPL fixtures) —
 * used only when buildCrossSeasonH2hMeetings finds nothing, e.g. a promoted
 * side Understat can't name-match yet. season.fixtures is already
 * chronologically sorted (composite.js buildScoreContext doc), so no
 * re-sorting is needed here.
 *
 * @returns {{date: undefined, goalsForA: number, goalsAgainstA: number}[]}
 */
function buildFplH2hMeetings(teamAId, teamBId, ctx) {
  const played = ctx.playedFixtures || [];
  return played
    .filter(f => {
      const isPair =
        (f.homeTeamId === teamAId && f.awayTeamId === teamBId) ||
        (f.homeTeamId === teamBId && f.awayTeamId === teamAId);
      if (!isPair) return false;
      const hg = f.result?.homeGoals;
      const ag = f.result?.awayGoals;
      return Number.isFinite(hg) && Number.isFinite(ag);
    })
    .map(f => {
      const aWasHome = f.homeTeamId === teamAId;
      return {
        goalsForA:     aWasHome ? f.result.homeGoals : f.result.awayGoals,
        goalsAgainstA: aWasHome ? f.result.awayGoals : f.result.homeGoals,
      };
    });
}

/**
 * Head-to-head nudge: how A has fared against B in their recent meetings,
 * expressed as the % of available league points A actually took across those
 * meetings (win=3, draw=1, loss=0, out of 3 per game) — NOT a mirrored/zero-
 * sum split like calcStyleClash or calcVenueEffect. Two unevenly-matched
 * sides' H2H values do not need to sum to 100: e.g. across 10 meetings where
 * A won once and the other 9 were draws, A took 12/30 points (40) and B took
 * 9/30 (30) — both numbers independently true, nothing to balance.
 *
 * MODEL: draws from real cross-season Understat fixture lists (up to N_H2H
 * meetings, config.js) via buildCrossSeasonH2hMeetings, falling back to
 * this-season-only FPL fixtures when Understat has no name match for either
 * team (promoted side, outage). historyPast in element-summary is per-player
 * and noisy to aggregate to club level, so it's not used here. The weight on
 * this metric is deliberately tiny (§8.1) — football H2H is weakly
 * predictive even with real data.
 *
 * @param {number} teamAId
 * @param {number} teamBId
 * @param {object} ctx  must contain { teamsById, leagueXg, leagueXgPrev,
 *   leagueXgPrev2, leagueXgPrev3, playedFixtures }
 * @returns {{value: number, estimated: boolean, meetings: number, pointsForA: number}}
 *   value: 0–100, the % of available league points A took across the counted
 *   meetings. Direction: higher = better for `teamA`.
 *   See FEATURE_ENGINE.md §4.
 */
export function calcFixtureHistory(teamAId, teamBId, ctx) {
  let meetings = buildCrossSeasonH2hMeetings(teamAId, teamBId, ctx).slice(-N_H2H);
  if (meetings.length === 0) {
    meetings = buildFplH2hMeetings(teamAId, teamBId, ctx).slice(-N_H2H);
  }

  if (meetings.length < 2) {
    // MODEL: < 2 meetings (promoted side, mid-season first leg, or genuinely
    // thin cross-season overlap) → neutral 50, flagged so confidence drops
    // rather than the result quietly pretending we know something. This is
    // also the ONLY gate on whether H2H contributes to composite confidence
    // (composite.js §8.3 zeroes WEIGHTS.history's share whenever estimated).
    return { value: 50, estimated: true, meetings: meetings.length, pointsForA: 0 };
  }

  let pointsForA = 0;
  for (const m of meetings) {
    if (m.goalsForA > m.goalsAgainstA)      pointsForA += 3;
    else if (m.goalsForA === m.goalsAgainstA) pointsForA += 1;
  }
  const ratio = pointsForA / (3 * meetings.length);
  return {
    value: clamp(0, 100, ratio * 100),
    estimated: false,
    meetings: meetings.length,
    pointsForA,
  };
}
