/**
 * js/engine/form.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes team form (recent, opponent-adjusted) and player form (per-90 returns,
 * minutes security, underlying numbers overlay). See FEATURE_ENGINE.md §5 and §7.1.
 * All outputs: 0–100, higher = better form for the team/player in question.
 */

import {
  FORM_WINDOW_GWS, RECENCY_DECAY, W_FORM_PERFORMANCE, LEAGUE_AVG_STRENGTH,
  PLAYER_FORM_GWS, W_RETURNS, W_MINUTES, W_UNDERLYING, AVAIL_PENALTY,
  PLAYER_PER90_ANCHORS, PLAYER_XG_ANCHORS,
  PLAYTIME_PRIOR_GWS, PLAYTIME_W_START, PLAYTIME_W_MINUTES,
  PLAYTIME_W_COMPLETION, PLAYTIME_W_CROWDING, PLAYTIME_CROWDING_FULL,
  PLAYTIME_BANDS, PLAYTIME_PRIOR_MIN, PLAYTIME_PRIOR_MAX,
  STATUS_PLAY_CHANCE,
} from '../config.js';
import { clamp, normaliseLinear, safeDiv } from '../util.js';
import { canonicalClubKey } from './normalise.js';

// ─── §5  Team form ────────────────────────────────────────────────────────────

/**
 * Internal: one-pass index of this season's match xG, keyed by the ordered
 * "home club|away club" name pair, so buildResultsByTeam can attach xG to
 * each result with an O(1) lookup instead of scanning datesData per fixture.
 * The distinction matters at scale: 380 played fixtures against 380 dates
 * rows is 380 lookups this way, not up to 380×380 — see the boot-performance
 * note in ARCHITECTURE.md for what an unnoticed per-fixture scan costs here.
 *
 * MODEL: matched by NAME via canonicalClubKey, never by either feed's numeric
 * team id — FPL's and Understat's ids are unrelated (same convention as
 * h2h.js / channel.js). Keyed on the ordered pair alone, with no date
 * tiebreak: within one season a given pairing plays at a given venue at most
 * once, so the pair is already unique. Only ctx.leagueXg (current season) is
 * consulted — calcTeamForm's window can never reach further back than a
 * season has been running, so there is nothing earlier seasons could answer.
 *
 * @param {object} leagueXg  Understat league payload, or null/absent (Understat
 *   down, or not yet loaded — non-fatal; every result simply falls back to
 *   actual goal difference in rawTeamForm below).
 * @returns {Map<string, {xgH: number, xgA: number}>}
 */
function buildXgIndex(leagueXg) {
  const map = new Map();
  const dates = leagueXg?.datesData;
  if (!Array.isArray(dates)) return map;
  for (const d of dates) {
    if (!d?.isResult || !d?.h?.title || !d?.a?.title) continue;
    const xgH = Number(d.xG?.h);
    const xgA = Number(d.xG?.a);
    if (!Number.isFinite(xgH) || !Number.isFinite(xgA)) continue;
    map.set(`${canonicalClubKey(d.h.title)}|${canonicalClubKey(d.a.title)}`, { xgH, xgA });
  }
  return map;
}

/**
 * Internal: for every team, the chronological list of their played results,
 * each enriched with the opponent's overall strength prior so calcTeamForm
 * can opponent-adjust without re-reading the fixtures array, and with that
 * match's xG from both ends where Understat has it (null/null otherwise —
 * rawTeamForm falls back to actual goal difference per match, not as an
 * all-or-nothing switch for the whole team).
 *
 * @param {object} ctx  { playedFixtures, teamsById, leagueXg? }
 * @returns {Object<number, Array<{gw, isHome, gf, ga, xgFor, xgAgainst,
 *            points, oppId, oppStrength}>>}
 */
function buildResultsByTeam(ctx) {
  const out = {};
  const xgIndex = buildXgIndex(ctx.leagueXg);
  const sorted = (ctx.playedFixtures || [])
    .slice()
    .sort((a, b) => (a.gw ?? 0) - (b.gw ?? 0));
  for (const f of sorted) {
    if (!f.result) continue;
    const home = ctx.teamsById?.[f.homeTeamId];
    const away = ctx.teamsById?.[f.awayTeamId];
    const hg = f.result.homeGoals;
    const ag = f.result.awayGoals;
    const xg = (home && away)
      ? xgIndex.get(`${canonicalClubKey(home.name)}|${canonicalClubKey(away.name)}`)
      : undefined;
    (out[f.homeTeamId] ||= []).push({
      gw: f.gw, isHome: true,
      gf: hg, ga: ag,
      xgFor: xg?.xgH ?? null, xgAgainst: xg?.xgA ?? null,
      points: hg > ag ? 3 : hg === ag ? 1 : 0,
      oppId: f.awayTeamId,
      oppStrength: away?.strength?.overall ?? LEAGUE_AVG_STRENGTH,
    });
    (out[f.awayTeamId] ||= []).push({
      gw: f.gw, isHome: false,
      gf: ag, ga: hg,
      xgFor: xg?.xgA ?? null, xgAgainst: xg?.xgH ?? null,
      points: ag > hg ? 3 : hg === ag ? 1 : 0,
      oppId: f.homeTeamId,
      oppStrength: home?.strength?.overall ?? LEAGUE_AVG_STRENGTH,
    });
  }
  return out;
}

/**
 * Internal: the un-normalised form value for one team, blending
 * opponent-adjusted, recency-weighted points with an underlying-performance
 * overlay (xG-difference where Understat has the match, else actual goal
 * difference for that one match). Returns null when the team has no played
 * fixtures.
 */
function rawTeamForm(results, leagueAvgStrength) {
  if (!results || results.length === 0) return null;
  const window = results.slice(-FORM_WINDOW_GWS);
  let weightedPts  = 0;
  let weightedPerf = 0;
  let totalW = 0;
  for (let i = 0; i < window.length; i++) {
    // gwsAgo: 0 for the most recent match in the window, increasing toward older entries.
    const gwsAgo = window.length - 1 - i;
    const recency = Math.pow(RECENCY_DECAY, gwsAgo);
    const r = window[i];
    const oppAdj = safeDiv(r.oppStrength, leagueAvgStrength, 1);
    weightedPts += r.points * oppAdj * recency;

    const perf = (r.xgFor != null && r.xgAgainst != null)
      ? (r.xgFor - r.xgAgainst)
      : (r.gf - r.ga);

    // Opponent-adjustment is SYMMETRIC here, unlike the points line above.
    // Points floor at 0, so oppAdj only ever amplifies credit for beating a
    // strong side — a loss is 0 regardless of opponent, the sign case never
    // arises. perf can go negative, and applying the SAME multiplier would
    // invert the intended read: oppAdj>1 for a strong opponent would make a
    // bad loss to a title contender look worse than the identical margin lost
    // to a relegation side, when the opposite is the more honest signal —
    // losing badly to a weak side says more about a team's own quality. So a
    // bad performance (perf < 0) is scaled by the RECIPROCAL instead: pulled
    // further negative against a weak opponent, pulled toward zero against a
    // strong one.
    const perfAdj = perf >= 0 ? (perf * oppAdj) : safeDiv(perf, oppAdj, perf);

    weightedPerf += perfAdj * recency;
    totalW       += recency;
  }
  if (totalW === 0) return null;
  const meanPts  = weightedPts  / totalW;
  const meanPerf = weightedPerf / totalW;
  // MODEL: results dominate; the performance overlay is a sharper-than-results
  // signal at W_FORM_PERFORMANCE.
  return ((1 - W_FORM_PERFORMANCE) * meanPts) + (W_FORM_PERFORMANCE * meanPerf);
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
 * MODEL: the 20% overlay term (W_FORM_PERFORMANCE, config.js) blends xG
 * rather than actual goal difference wherever Understat has the match —
 * results are noisy over a 5-game window (a single deflection or red card
 * can dominate it), and xG is the standard industry answer to exactly that:
 * a less noisy read on performance than the scoreline alone. Falls back to
 * actual goal difference per match, not for the whole team, when Understat
 * lacks that one fixture or is unavailable entirely. See buildXgIndex above.
 *
 * @param {Team} team
 * @param {object} ctx  { teamsById, playedFixtures, leagueXg?, leagueAvgStrength? }
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

  // MODEL: without per-GW data we proxy minutesSecurity by season minutes over
  // the minutes that have actually BEEN AVAILABLE so far — elapsed gameweeks,
  // not the full 38. Dividing by SEASON_GWS * 90 (as this did) meant an
  // ever-present player scored 90/3420 = 0.03 after GW1 and only 0.53 by GW20,
  // so essentially the entire pool read as a rotation risk for most of the
  // season, and the W_MINUTES term below dragged every form score down with
  // it. ctx.elapsedGws is derived from the data itself (composite.js) rather
  // than from a gameweek counter, so it stays correct through blanks and
  // doubles. Still crude — flagged estimated below.
  const elapsedGws = Math.max(1, ctx?.elapsedGws ?? 1);
  const minutesSecurity = clamp(0, 1, safeDiv(minutes, elapsedGws * 90, 0));

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

// ─── §7.3b  Playtime security ─────────────────────────────────────────────────

/**
 * Map a 0–1 playtime security value onto its display band.
 * Single source of truth for the label — the Ranker's Playtime column renders
 * it and its filter pills match on it, so neither can drift from the other.
 *
 * @param {number} value  0–1
 * @returns {{threshold: number, label: string, band: string}}
 */
export function playtimeBand(value) {
  const v = Number.isFinite(value) ? value : 0;
  for (const level of PLAYTIME_BANDS) {
    if (v >= level.threshold) return level;
  }
  return PLAYTIME_BANDS[PLAYTIME_BANDS.length - 1];
}

/**
 * How safe is this player's place in the starting XI?
 *
 * Answers the forward-looking question the Ranker's Playtime column asks,
 * which the single backward ratio in calcPlayerForm never could. Built from
 * pool-wide data only (bootstrap totals + squad composition), never from
 * element-summary history — that is lazily fetched, so a model needing it
 * would have nothing to work with for almost every row the Ranker draws.
 *
 * Four inputs, combined as three positive terms and one penalty:
 *
 *   startRate   starts ÷ elapsed GWs. The binary that matters most in FPL.
 *   minShare    minutes ÷ minutes available. Catches the nailed-on starter who
 *               is nonetheless hooked on 60 every week — start rate alone
 *               scores him identically to a player finishing matches.
 *   completion  minutes ÷ (starts × 90). Small tiebreaker; being subbed late
 *               is ordinary squad management, not insecurity.
 *   crowding    bodies ÷ slots in this club's group at this position. Scaled
 *               by (1 − minShare) so it barely touches a player already
 *               commanding his slot, and bites hardest on the genuinely
 *               rotated. This is what separates a nailed starter at a
 *               squad-heavy club from his rotating team-mate: the crowding
 *               number is identical for both, because it describes the club's
 *               position group rather than the player.
 *
 * MODEL: both rate terms are shrunk toward a price-derived prior worth
 * PLAYTIME_PRIOR_GWS gameweeks of evidence. This is what makes GW1 behave —
 * with one match played, a raw start rate is either 0.0 or 1.0 and neither is
 * believable, so early on the prior dominates and by roughly GW10 the observed
 * record has fully taken over. Price is the only pool-wide forward-looking
 * role signal FPL exposes before a ball is kicked.
 *
 * Availability multiplies the result rather than capping it: an injured player
 * with a cast-iron place is still a zero for the gameweek in front of him, and
 * a doubtful one is genuinely half a player.
 *
 * @param {Player} player
 * @param {object} ctx  needs { elapsedGws, playtimeByPlayerId } from buildScoreContext
 * @returns {{value: number, band: string, label: string, estimated: boolean,
 *            startRate: number, minutesShare: number, completion: number,
 *            crowding: number, prior: number, availability: number,
 *            availabilitySource: 'fpl'|'status'}}
 *   value: 0–1, higher = more secure a starter. Direction: higher = better.
 *   See FEATURE_ENGINE.md §7.3b.
 */
export function calcPlaytimeSecurity(player, ctx) {
  const elapsedGws = Math.max(1, ctx?.elapsedGws ?? 1);
  const entry      = ctx?.playtimeByPlayerId?.[player?.id] ?? null;

  const minutes = player?.totals?.minutes ?? 0;
  const starts  = player?.totals?.starts  ?? 0;

  // Price-derived expected role. Falls back to the midpoint of the prior range
  // when the pool context is missing, rather than to zero — an unknown player
  // is an average one, not a certain non-starter.
  const prior = entry?.prior ?? ((PLAYTIME_PRIOR_MIN + PLAYTIME_PRIOR_MAX) / 2);

  // Shrunk toward the prior, in units of gameweeks and of 90-minute blocks
  // respectively. Both denominators carry the same PLAYTIME_PRIOR_GWS of
  // synthetic evidence, so the two terms stay on the same footing.
  const startRate = clamp(0, 1, safeDiv(
    starts + (PLAYTIME_PRIOR_GWS * prior),
    elapsedGws + PLAYTIME_PRIOR_GWS, 0));

  const minutesShare = clamp(0, 1, safeDiv(
    minutes + (PLAYTIME_PRIOR_GWS * 90 * prior),
    (elapsedGws + PLAYTIME_PRIOR_GWS) * 90, 0));

  // Minutes per start. A player with no starts yet has nothing to say here, so
  // he inherits the prior rather than scoring zero and being punished twice
  // for the same absence.
  const completion = starts > 0
    ? clamp(0, 1, safeDiv(minutes, starts * 90, 0))
    : prior;

  const crowding = entry?.crowding ?? 1;
  // Only the excess over one slot per body counts as pressure.
  const crowdingExcess = clamp(0, 1,
    safeDiv(crowding - 1, PLAYTIME_CROWDING_FULL - 1, 0));
  const crowdingRisk = crowdingExcess * (1 - minutesShare);

  const base =
      (PLAYTIME_W_START      * startRate)
    + (PLAYTIME_W_MINUTES    * minutesShare)
    + (PLAYTIME_W_COMPLETION * completion);

  const fplChance    = player?.chanceOfPlayingNext;
  const hasFplChance = typeof fplChance === 'number' && Number.isFinite(fplChance);
  const availability = hasFplChance
    ? clamp(0, 100, fplChance)
    : (STATUS_PLAY_CHANCE[player?.status] ?? STATUS_PLAY_CHANCE.available);

  const value = clamp(0, 1,
    (base - (PLAYTIME_W_CROWDING * crowdingRisk)) * (availability / 100));

  const level = playtimeBand(value);

  return {
    value,
    band:  level.band,
    label: level.label,
    // Honest about its own confidence: while the prior still outweighs the
    // observed record, this figure is a projection rather than a measurement.
    estimated: elapsedGws < PLAYTIME_PRIOR_GWS,
    startRate,
    minutesShare,
    completion,
    crowding,
    prior,
    availability,
    availabilitySource: hasFplChance ? 'fpl' : 'status',
  };
}
