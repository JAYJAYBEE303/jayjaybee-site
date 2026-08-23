/**
 * js/engine/form.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes team form (recent, opponent-adjusted) and player form (per-90 returns,
 * minutes security, underlying numbers overlay). See FEATURE_ENGINE.md §5 and §7.1.
 * All outputs: 0–100, higher = better form for the team/player in question.
 */

import {
  FORM_WINDOW_GWS, RECENCY_DECAY, W_FORM_GD, LEAGUE_AVG_STRENGTH,
  PLAYER_FORM_GWS, W_RETURNS, W_MINUTES, W_UNDERLYING, AVAIL_PENALTY,
  PLAYER_PER90_ANCHORS, PLAYER_XG_ANCHORS, SEASON_GWS,
  STATUS_PLAY_CHANCE,
} from '../config.js';
import { clamp, normaliseLinear, safeDiv } from '../util.js';

// ─── §5  Team form ────────────────────────────────────────────────────────────

/**
 * Internal: for every team, the chronological list of their played results,
 * each enriched with the opponent's overall strength prior so calcTeamForm
 * can opponent-adjust without re-reading the fixtures array.
 *
 * @param {object} ctx  { playedFixtures, teamsById }
 * @returns {Object<number, Array<{gw, isHome, gf, ga, points, oppId, oppStrength}>>}
 */
function buildResultsByTeam(ctx) {
  const out = {};
  const sorted = (ctx.playedFixtures || [])
    .slice()
    .sort((a, b) => (a.gw ?? 0) - (b.gw ?? 0));
  for (const f of sorted) {
    if (!f.result) continue;
    const home = ctx.teamsById?.[f.homeTeamId];
    const away = ctx.teamsById?.[f.awayTeamId];
    const hg = f.result.homeGoals;
    const ag = f.result.awayGoals;
    (out[f.homeTeamId] ||= []).push({
      gw: f.gw, isHome: true,
      gf: hg, ga: ag,
      points: hg > ag ? 3 : hg === ag ? 1 : 0,
      oppId: f.awayTeamId,
      oppStrength: away?.strength?.overall ?? LEAGUE_AVG_STRENGTH,
    });
    (out[f.awayTeamId] ||= []).push({
      gw: f.gw, isHome: false,
      gf: ag, ga: hg,
      points: ag > hg ? 3 : hg === ag ? 1 : 0,
      oppId: f.homeTeamId,
      oppStrength: home?.strength?.overall ?? LEAGUE_AVG_STRENGTH,
    });
  }
  return out;
}

/**
 * Internal: the un-normalised form value for one team, blending
 * opponent-adjusted, recency-weighted points with a goal-difference overlay.
 * Returns null when the team has no played fixtures.
 */
function rawTeamForm(results, leagueAvgStrength) {
  if (!results || results.length === 0) return null;
  const window = results.slice(-FORM_WINDOW_GWS);
  let weightedPts = 0;
  let weightedGd  = 0;
  let totalW = 0;
  for (let i = 0; i < window.length; i++) {
    // gwsAgo: 0 for the most recent match in the window, increasing toward older entries.
    const gwsAgo = window.length - 1 - i;
    const recency = Math.pow(RECENCY_DECAY, gwsAgo);
    const r = window[i];
    const oppAdj = safeDiv(r.oppStrength, leagueAvgStrength, 1);
    weightedPts += r.points * oppAdj * recency;
    weightedGd  += (r.gf - r.ga) * recency;
    totalW      += recency;
  }
  if (totalW === 0) return null;
  const meanPts = weightedPts / totalW;
  const meanGd  = weightedGd  / totalW;
  // MODEL: results dominate; GD is a sharper-than-results overlay at W_FORM_GD.
  return ((1 - W_FORM_GD) * meanPts) + (W_FORM_GD * meanGd);
}

/**
 * Internal: simple linear slope of points across the form window, used as a
 * tiebreaker/UI arrow only (NOT folded into the composite). Positive = improving.
 */
function formTrend(results) {
  if (!results || results.length < 2) return 0;
  const window = results.slice(-FORM_WINDOW_GWS);
  const n = window.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = window[i].points;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = (n * sumXX) - (sumX * sumX);
  if (denom === 0) return 0;
  return ((n * sumXY) - (sumX * sumY)) / denom;
}

/**
 * Recent-trajectory team form, opponent-quality adjusted. Looks back
 * FORM_WINDOW_GWS played fixtures with exponential recency decay (RECENCY_DECAY).
 * League-relative normalisation: each team's raw form is bounded by the spread
 * observed across every team that has played at least once.
 *
 * MODEL (revised): a thin window is a RAMP, not a gate. This used to flag
 * `estimated: true` below half the window, which engine/composite.js reads as
 * "discard entirely" — so a team's first two matches counted for nothing and
 * the third suddenly counted for all 15%. Form is the metric most worth having
 * early, and that cliff was exactly backwards. `maturity` now scales the weight
 * continuously (1 game = 1/5 of the window = 3% of the composite rather than
 * 15%), so an early reading applies immediately at a strength matched to how
 * little is behind it. Same mechanism engine/channel.js already uses for the
 * counter-matchup; see metricMaturity in engine/composite.js.
 *
 * `estimated` is now reserved for its literal meaning: no games at all.
 *
 * @param {Team} team
 * @param {object} ctx  { teamsById, playedFixtures, leagueAvgStrength? }
 * @returns {{value: number, trend: number, estimated: boolean, games: number,
 *            maturity: number}}
 *   value: 0–100, higher = better recent form for `team`. Direction: higher = better.
 *   trend: signed slope of points across the window; UI-only, not in the composite.
 *   maturity: 0–1, share of FORM_WINDOW_GWS actually played.
 *   See FEATURE_ENGINE.md §5.
 */
export function calcTeamForm(team, ctx) {
  const resultsByTeam = buildResultsByTeam(ctx);
  const results = resultsByTeam[team.id] || [];

  if (results.length === 0) {
    // MODEL: no games played → neutral fallback, flagged estimated. This is the
    // ONLY estimated case now; anything from one game up rides the ramp below.
    return { value: 50, trend: 0, estimated: true, games: 0, maturity: 0 };
  }

  const leagueAvgStrength = ctx.leagueAvgStrength || LEAGUE_AVG_STRENGTH;
  const raw = rawTeamForm(results, leagueAvgStrength);

  // Build the league's distribution so this metric is league-relative.
  const rawByTeam = [];
  for (const t of Object.values(ctx.teamsById)) {
    const r = rawTeamForm(resultsByTeam[t.id], leagueAvgStrength);
    if (r !== null) rawByTeam.push(r);
  }
  let min = rawByTeam[0] ?? raw;
  let max = rawByTeam[0] ?? raw;
  for (const v of rawByTeam) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    value: normaliseLinear(raw, min, max),
    trend: formTrend(results),
    // There ARE games, so this is a real reading, not a fallback — how much of
    // one is what `maturity` says. See the MODEL note in the doc block.
    estimated: false,
    games: results.length,
    maturity: clamp(0, 1, results.length / FORM_WINDOW_GWS),
  };
}

// ─── §7.1  Player form ────────────────────────────────────────────────────────

/**
 * Internal: read the right per-90 / underlying anchors for a player's mode.
 * MODEL: defenders/keepers earn primarily through clean sheets + saves, so
 * their typical per-90 points distribution sits lower than outfielders forward
 * of them. Phase 3 replaces these anchors with position-relative league percentiles.
 */
function anchorsFor(mode) {
  return {
    per90: PLAYER_PER90_ANCHORS[mode],
    xg:    PLAYER_XG_ANCHORS[mode],
  };
}

/**
 * Build the Understat playersData lookup keyed by lowercased full name.
 * Pure helper invoked once per ctx by buildScoreContext so calcPlayerForm
 * never pays an O(N) scan per player. Returns null when Understat is absent.
 *
 * MODEL: name-based matching is best-effort — Understat names usually match
 * FPL `fullName` exactly for EPL regulars, but accents, suffixes (Jr.) and
 * cup/loan moves can mismatch. Any miss simply falls back to the FPL overlay.
 */
export function buildUnderstatPlayerLookup(leagueXg) {
  if (!leagueXg || !Array.isArray(leagueXg.playersData)) return null;
  const map = {};
  for (const p of leagueXg.playersData) {
    if (!p || !p.player_name) continue;
    const key = p.player_name.toLowerCase().trim();
    if (key && !(key in map)) map[key] = p;   // first occurrence wins
  }
  return Object.keys(map).length === 0 ? null : map;
}

/**
 * Internal: per-90 (xG + xA) for a player from Understat, or null when no
 * lookup is loaded or the player isn't matched.
 */
function understatXgPer90(player, ctx) {
  const lookup = ctx.understatPlayersByName;
  if (!lookup) return null;
  const key = (player.fullName || '').toLowerCase().trim();
  if (!key) return null;
  const up = lookup[key];
  if (!up) return null;
  const upMin = parseFloat(up.time);
  if (!(upMin > 0)) return null;
  const upXg = parseFloat(up.xG) || 0;
  const upXa = parseFloat(up.xA) || 0;
  return (upXg + upXa) / (upMin / 90);
}

/**
 * Internal fallback: when no element-summary history is loaded for this
 * player, score off season totals so the ranker still has something to sort.
 * Flagged estimated so confidence drops everywhere this player is consumed.
 *
 * Phase 3A: even in this fallback we use Understat's season per-90 xG when
 * available — it's strictly better than the neutral-50 placeholder we used
 * before. `xgEstimated` still tracks the underlying-numbers provenance.
 */
function fallbackPlayerForm(player, mode, ctx) {
  const minutes = player.totals.minutes || 0;
  const points  = player.totals.points  || 0;
  const per90 = safeDiv(points, minutes / 90, 0);

  const { per90: per90A, xg: xgA } = anchorsFor(mode);
  const per90Norm = normaliseLinear(per90, per90A.min, per90A.max);

  // MODEL: without per-GW data we proxy minutesSecurity by season minutes / a
  // full season's max (SEASON_GWS * 90). Crude — flagged estimated below.
  const minutesSecurity = clamp(0, 1, safeDiv(minutes, SEASON_GWS * 90, 0));

  const upXg = understatXgPer90(player, ctx);
  let xgOverlay;
  let xgNorm;
  let xgSource;
  let xgEstimated;
  if (upXg !== null) {
    // MODEL: using Understat xG — season per-90 underlying. Sharper than the
    // FPL totals fallback even before any element-summary loads.
    xgOverlay = upXg;
    xgNorm = normaliseLinear(upXg, xgA.min, xgA.max);
    xgSource = 'understat';
    xgEstimated = false;
  } else {
    // MODEL: using FPL proxy (no Understat data) — no per-GW history and no
    // Understat overlay either, so the underlying term contributes neutral 50
    // to avoid silently re-weighting the rest.
    xgOverlay = 0;
    xgNorm = 50;
    xgSource = 'fpl';
    xgEstimated = true;
  }

  let value =
      (W_RETURNS    * per90Norm)
    + (W_MINUTES    * minutesSecurity * 100)
    + (W_UNDERLYING * xgNorm);

  if (player.status !== 'available') value *= AVAIL_PENALTY;

  return {
    value: clamp(0, 100, value),
    per90,
    minutesSecurity,
    xgOverlay,
    xgSource,
    xgEstimated,
  };
}

/**
 * Player form blended from per-90 actual returns, minutes security, and an
 * (xG + xA) underlying-numbers overlay. Switches read-mode for defenders
 * and keepers (see `mode` below). Availability penalty applied when the
 * player isn't flagged as `available` in the FPL data.
 *
 * Phase 3A: when ctx.understatPlayersByName has a match the xG overlay is
 * driven by Understat's season per-90 (xG + xA), strictly improving on the
 * FPL element-summary numbers. Otherwise we fall back to FPL-exposed xG and
 * flag `xgEstimated: true` in the breakdown.
 *
 * @param {Player} player
 * @param {object} ctx  must contain { playerSummariesById: object }
 * @returns {{value: number, per90: number, minutesSecurity: number,
 *            xgOverlay: number, xgSource: 'understat'|'fpl', xgEstimated: boolean,
 *            estimated: boolean, mode: 'attack'|'defence'}}
 *   value: 0–100, higher = better player form. Direction: higher = better.
 *   See FEATURE_ENGINE.md §7.1.
 */
export function calcPlayerForm(player, ctx) {
  // MODEL: position dictates the read. Defenders/keepers score primarily through
  // clean sheets and saves; outfielders forward of them through attacking returns.
  // counter.js uses this dual-mode read to value defensive units correctly.
  const mode = (player.position === 'DEF' || player.position === 'GKP') ? 'defence' : 'attack';

  const summary = ctx.playerSummariesById?.[player.id];
  const history = summary?.history;

  if (!history || history.length === 0) {
    // No per-GW history loaded → fall back to season totals. Flagged estimated
    // so every downstream score that depends on this player loses confidence.
    return { ...fallbackPlayerForm(player, mode, ctx), estimated: true, mode };
  }

  const window = history.slice(-PLAYER_FORM_GWS);
  const games   = window.length;
  const minutes = window.reduce((s, g) => s + (g.minutes || 0), 0);
  const points  = window.reduce((s, g) => s + (g.points  || 0), 0);
  const xgSum   = window.reduce((s, g) => s + (g.xG || 0) + (g.xA || 0), 0);

  if (minutes === 0) {
    // Player on the pitch for zero minutes across the window — treat as the
    // season fallback. Flagged estimated.
    return { ...fallbackPlayerForm(player, mode, ctx), estimated: true, mode };
  }

  const per90Pts  = safeDiv(points, minutes / 90, 0);
  const minutesSecurity = clamp(0, 1, safeDiv(minutes, 90 * games, 0));

  const { per90: per90A, xg: xgA } = anchorsFor(mode);
  const per90Norm = normaliseLinear(per90Pts, per90A.min, per90A.max);

  // Phase 3A: prefer Understat's season per-90 (xG + xA) when available; fall
  // back to the FPL element-summary window otherwise.
  const upXg = understatXgPer90(player, ctx);
  let xgOverlay;
  let xgSource;
  let xgEstimated;
  if (upXg !== null) {
    // MODEL: using Understat xG — supplements the FPL window with the season
    // underlying read. Same formula (W_UNDERLYING term), better input.
    xgOverlay = upXg;
    xgSource = 'understat';
    xgEstimated = false;
  } else {
    // MODEL: using FPL proxy (no Understat data) — FPL-exposed element-summary
    // xG/xA over the same window. Flag estimated:true on the breakdown.
    xgOverlay = safeDiv(xgSum, minutes / 90, 0);
    xgSource = 'fpl';
    xgEstimated = true;
  }
  const xgNorm = normaliseLinear(xgOverlay, xgA.min, xgA.max);

  let value =
      (W_RETURNS    * per90Norm)
    + (W_MINUTES    * minutesSecurity * 100)
    + (W_UNDERLYING * xgNorm);

  // MODEL: an unavailable player is near-useless in FPL regardless of form;
  // multiply by AVAIL_PENALTY rather than zeroing so the ranker can still
  // surface borderline cases without burying them entirely.
  if (player.status !== 'available') value *= AVAIL_PENALTY;

  return {
    value: clamp(0, 100, value),
    per90: per90Pts,
    minutesSecurity,
    xgOverlay,
    xgSource,
    xgEstimated,
    estimated: false,
    mode,
  };
}

// ─── §7.3  Playing likelihood ─────────────────────────────────────────────────

/**
 * How likely this player is to actually be on the pitch next gameweek.
 *
 * MODEL: two independent necessary conditions, combined with min() rather than a
 * weighted blend, because either one alone can rule a player out:
 *   startShare   — backward evidence. Has he been starting? (minutesSecurity)
 *   availability — forward evidence. Is he fit and permitted to play?
 * A nailed starter who is injured cannot play (min → ~0). A fully fit squad
 * player still will not start (min → his low start share). Averaging the two
 * would wrongly rescue both cases, which is exactly the failure the Ranker
 * showed: fringe players carrying high scores they could not deliver on.
 *
 * MODEL: availability prefers FPL's own chance_of_playing_next_round, which is a
 * real percentage FPL sets from press-conference news — a genuine forward-looking
 * signal, not a proxy. It is null for the majority of players (FPL populates it
 * only when there IS news), so a null falls back to STATUS_PLAY_CHANCE keyed on
 * the player's status. Null therefore means "no news", not "no data".
 *
 * @param {Player} player
 * @param {{minutesSecurity: number, estimated: boolean}} formResult
 *   an already-computed calcPlayerForm result — passed in rather than recomputed
 *   so callers that already hold one (scorePlayer, chips.js) don't double the work.
 * @returns {{value: number, estimated: boolean, startShare: number,
 *            availability: number, availabilitySource: 'fpl'|'status'}}
 *   value: 0–100, higher = more likely to play. Direction: higher = better.
 *   See FEATURE_ENGINE.md §7.3.
 */
export function calcPlayingLikelihood(player, formResult) {
  const startShare = clamp(0, 100, (formResult?.minutesSecurity ?? 0) * 100);

  const fplChance = player?.chanceOfPlayingNext;
  const hasFplChance = typeof fplChance === 'number' && Number.isFinite(fplChance);
  const availability = hasFplChance
    ? clamp(0, 100, fplChance)
    : (STATUS_PLAY_CHANCE[player?.status] ?? STATUS_PLAY_CHANCE.available);

  return {
    value: Math.min(startShare, availability),
    // Inherits form's estimated flag: without per-GW history, minutesSecurity is
    // the crude season-minutes proxy, so startShare is only as good as that.
    estimated: Boolean(formResult?.estimated),
    startShare,
    availability,
    availabilitySource: hasFplChance ? 'fpl' : 'status',
  };
}
