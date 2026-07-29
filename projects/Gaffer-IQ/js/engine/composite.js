/**
 * js/engine/composite.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Combines every sub-metric into the composite matchup score (CompositeScore),
 * and aggregates across horizon windows (scoreOverHorizon) and per player
 * (scorePlayer). See FEATURE_ENGINE.md §8, §9, §10.
 * Output: 0–100, higher = better fixture/run/player form. Direction: higher = better.
 */

import {
  WEIGHTS, BANDS, CONFIDENCE_FLOOR, LEAGUE_AVG_STRENGTH,
  HORIZON_DECAY, AGG_METHOD, W_MEAN, W_MIN, BLANK_GW_VALUE,
  PROJ_FORM, PROJ_FIXTURE, PROJ_COUNTER,
} from '../config.js';
import { clamp, invert } from '../util.js';
import {
  calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory,
} from './fixtures.js';
import { calcTeamForm, calcPlayerForm, buildUnderstatPlayerLookup } from './form.js';
import { calcStyleClash, buildXgProfilesByTeamId } from './style.js';
import { calcCounterMatchup } from './counter.js';

/**
 * Build the assembly context every engine function consumes. Pure — derives
 * indices and aggregates from a Season plus an optional summary map, never
 * mutates either input.
 *
 * @param {Season} season   output of normaliseSeason
 * @param {object} [opts]
 * @param {object} [opts.playerSummariesById]  playerId → PlayerSummary (may be partial)
 * @param {object} [opts.leagueXg]             Understat league/EPL payload (Phase 3A); null when unavailable
 * @param {number} [opts.currentGw]            override; defaults to season.currentGw, then nextGw, then 1
 * @returns {object} ctx consumed by calcBase/HomeAway/Form/Style/Counter/FixtureHistory.
 *
 *   ctx shape:
 *     teamsById:           Object<teamId, Team>           (passthrough)
 *     playersByTeamId:     Object<teamId, Player[]>       (derived)
 *     fixtures:            Fixture[]                       (passthrough, sorted)
 *     playedFixtures:      Fixture[]                       (derived: f.played && f.result)
 *     playerSummariesById: Object<playerId, PlayerSummary> (passthrough, possibly {})
 *     leagueXg:            object | null                   (passthrough — Phase 3A)
 *     currentGw:           number
 *     leagueAvgStrength:   number  (mean of team.strength.overall across the league)
 */
export function buildScoreContext(season, opts = {}) {
  if (!season || !season.teamsById) {
    throw new TypeError('buildScoreContext: season (from normaliseSeason) is required');
  }

  const playedFixtures = (season.fixtures || []).filter(f => f.played && f.result);

  const playersByTeamId = {};
  for (const p of (season.players || [])) {
    (playersByTeamId[p.teamId] ||= []).push(p);
  }

  const overallStrengths = Object.values(season.teamsById)
    .map(t => t.strength?.overall ?? 0)
    .filter(v => v > 0);
  const leagueAvgStrength = overallStrengths.length
    ? overallStrengths.reduce((a, b) => a + b, 0) / overallStrengths.length
    : LEAGUE_AVG_STRENGTH;

  // Phase 3A: precompute the league-wide xG-based style profile lookup once
  // so calcStyleProfile doesn't repeat min-max normalisation per fixture. Pure
  // — returns null when Understat data is unavailable, in which case style.js
  // falls back to its Phase 1 proxies.
  const leagueXg = opts.leagueXg ?? null;
  const xgProfilesByTeamId = leagueXg
    ? buildXgProfilesByTeamId(leagueXg, season.teamsById)
    : null;
  // Phase 3A: build the Understat playersData lookup once per ctx so
  // calcPlayerForm gets an O(1) name match instead of an O(N) scan per player.
  const understatPlayersByName = leagueXg
    ? buildUnderstatPlayerLookup(leagueXg)
    : null;

  return {
    teamsById:           season.teamsById,
    playersByTeamId,
    fixtures:            season.fixtures || [],
    playedFixtures,
    playerSummariesById: opts.playerSummariesById || {},
    // Phase 3A — Understat league payload (null when fetch failed or not yet
    // loaded). style.js and form.js consult it for real xG inputs and fall
    // back to FPL-derived proxies when absent.
    leagueXg,
    xgProfilesByTeamId,
    understatPlayersByName,
    currentGw:           opts.currentGw ?? season.currentGw ?? season.nextGw ?? 1,
    leagueAvgStrength,
  };
}

/**
 * Map a 0–100 value onto its band string. Thresholds come from config (BANDS);
 * never inline a literal here — CSS modifier classes (.score-pill--great etc.)
 * key off this string, so the colour mapping stays single-sourced.
 */
function bandFromValue(value) {
  if (value >= BANDS.great)   return 'great';
  if (value >= BANDS.good)    return 'good';
  if (value >= BANDS.neutral) return 'neutral';
  if (value >= BANDS.tough)   return 'tough';
  return 'brutal';
}

/**
 * Score a single fixture from ONE team's perspective. Every sub-metric is
 * computed at 0–100 (higher = better for `team`), then weighted-summed with
 * `WEIGHTS` from config.js. Estimated sub-metrics pass through at their
 * fallback (typically 50) and lower the composite's confidence rather than
 * being dropped — dropping silently re-weights the rest (FEATURE_ENGINE.md §8.3).
 *
 * Asymmetric: scoreFixture(home, fixture, ctx) and scoreFixture(away, fixture, ctx)
 * are not complementary — venue, form, and counter-matchup all read differently
 * for each side.
 *
 * @param {Team} team       team whose perspective we score from
 * @param {Fixture} fixture
 * @param {object} ctx      output of buildScoreContext
 * @returns {CompositeScore}
 *   value: 0–100, higher = easier/better fixture for `team`. Direction: higher = better.
 *   band: 'great' | 'good' | 'neutral' | 'tough' | 'brutal' (see BANDS in config).
 *   confidence: 0–1; weighted share of non-estimated sub-metrics.
 *   provisional: true when confidence < CONFIDENCE_FLOOR — UI hatches/greys the score.
 *   breakdown: per sub-metric { value, weight, estimated, ...extras }.
 *   See ARCHITECTURE.md §8 and FEATURE_ENGINE.md §8 for the contract.
 */
export function scoreFixture(team, fixture, ctx) {
  if (!team || !fixture) {
    throw new TypeError('scoreFixture: both team and fixture are required');
  }
  if (!ctx || !ctx.teamsById) {
    throw new TypeError('scoreFixture: ctx (from buildScoreContext) is required');
  }
  const isHome = fixture.homeTeamId === team.id;
  const isAway = fixture.awayTeamId === team.id;
  if (!isHome && !isAway) {
    throw new TypeError(
      `scoreFixture: team ${team.id} is not in fixture ${fixture.id} ` +
      `(home=${fixture.homeTeamId}, away=${fixture.awayTeamId})`,
    );
  }
  const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
  const opponent = ctx.teamsById[opponentId];
  if (!opponent) {
    throw new TypeError(`scoreFixture: opponent team ${opponentId} missing from ctx`);
  }

  const base    = calcBaseDifficulty(team, opponent, isHome);
  const venue   = calcHomeAwaySplit(team, isHome, ctx);
  const form    = calcTeamForm(team, ctx);
  const counter = calcCounterMatchup(team, opponent, ctx);
  const style   = calcStyleClash(team, opponent, ctx);
  const history = calcFixtureHistory(team.id, opponentId, ctx);

  // Weighted blend — every sub-metric is already 0–100, higher = better for `team`.
  // WEIGHTS sums to 1.00 (config.js / FEATURE_ENGINE.md §8.1), so no re-normalisation.
  //
  // baseDifficulty is the ONE exception to the higher-is-better rule: it is
  // stored as the opponent's strength (higher = harder) because the UI shows it
  // that way, so it is inverted here before weighting. Removing this invert()
  // would make facing Man City *raise* a team's score. See FEATURE_ENGINE.md §2.
  const value = clamp(0, 100,
      (WEIGHTS.baseDifficulty * invert(base.value))
    + (WEIGHTS.counterMatchup * counter.value)
    + (WEIGHTS.teamForm       * form.value)
    + (WEIGHTS.homeAway       * venue.value)
    + (WEIGHTS.styleClash     * style.value)
    + (WEIGHTS.history        * history.value),
  );

  // MODEL: confidence = weighted share of non-estimated sub-metrics. Estimated
  // metrics still contribute their (fallback) value to `value` so the weights
  // continue to sum to 1; they only lower confidence here. See §8.3.
  const confidence =
      (base.estimated    ? 0 : WEIGHTS.baseDifficulty)
    + (counter.estimated ? 0 : WEIGHTS.counterMatchup)
    + (form.estimated    ? 0 : WEIGHTS.teamForm)
    + (venue.estimated   ? 0 : WEIGHTS.homeAway)
    + (style.estimated   ? 0 : WEIGHTS.styleClash)
    + (history.estimated ? 0 : WEIGHTS.history);

  return {
    value,
    band:         bandFromValue(value),
    confidence,
    provisional:  confidence < CONFIDENCE_FLOOR,
    breakdown: {
      baseDifficulty: {
        // Reported as stored — the opponent's strength, higher = harder. The
        // composite above consumes invert(base.value); the UI wants this one.
        value:     base.value,
        weight:    WEIGHTS.baseDifficulty,
        estimated: base.estimated,
        strengthScore: base.strengthScore,   // before any tenure deduction
        tenurePenalty: base.tenurePenalty,   // points deducted for thin PL history
        tenureRatio:   base.tenureRatio,     // 0–1, opponent's recency-weighted tenure
      },
      counterMatchup: {
        value:     counter.value,
        weight:    WEIGHTS.counterMatchup,
        estimated: counter.estimated,
        pairings:  counter.pairings,
      },
      teamForm: {
        value:     form.value,
        weight:    WEIGHTS.teamForm,
        estimated: form.estimated,
        trend:     form.trend,
        games:     form.games,
      },
      homeAway: {
        value:        venue.value,
        weight:       WEIGHTS.homeAway,
        estimated:    venue.estimated,
        gamesAtVenue: venue.gamesAtVenue,
      },
      styleClash: {
        value:      style.value,
        weight:     WEIGHTS.styleClash,
        estimated:  style.estimated,
        profileA:   style.profileA,
        profileB:   style.profileB,
        clashDelta: style.clashDelta,
      },
      history: {
        value:      history.value,
        weight:     WEIGHTS.history,
        estimated:  history.estimated,
        meetings:   history.meetings,
        pointsForA: history.pointsForA,
      },
    },
  };
}

// ─── §9  Horizon aggregation ──────────────────────────────────────────────────

/**
 * Internal: collect fixtures for `team` whose GW falls in `gwSet`.
 * Returns Map<gw, Fixture[]>. Double GWs produce two entries under the same key.
 */
function fixturesForTeamInWindow(team, gwSet, ctx) {
  const byGw = new Map();
  for (const f of ctx.fixtures) {
    if (f.gw === null) continue;
    if (!gwSet.has(f.gw)) continue;
    if (f.homeTeamId !== team.id && f.awayTeamId !== team.id) continue;
    const list = byGw.get(f.gw) ?? [];
    list.push(f);
    byGw.set(f.gw, list);
  }
  return byGw;
}

/**
 * Internal: position-specific counter-matchup edge for a player, aggregated
 * over the horizon window with the same GW-distance decay as scoreOverHorizon.
 * Blank GWs contribute BLANK_GW_VALUE so the weighting stays consistent.
 *
 *  FWD     → fwdVsCb pairing (striker vs centre-backs)
 *  MID     → mean(wideMidVsFb, camVsCbMid)
 *  DEF/GKP → 100 − opponent's counter score (how well this defence resists)
 *
 * See FEATURE_ENGINE.md §10 (playerCounterEdge).
 */
function calcPlayerCounterEdge(player, gwWindow, teamFixturesByGw, ctx) {
  const team = ctx.teamsById[player.teamId];
  if (!team) return { value: 50, estimated: true };

  let wSum   = 0;
  let wTotal = 0;
  let anyEstimated = false;

  for (let i = 0; i < gwWindow.length; i++) {
    const gw       = gwWindow[i];
    const w        = Math.pow(HORIZON_DECAY, i);
    const fixtures = teamFixturesByGw.get(gw) ?? [];

    if (fixtures.length === 0) {
      // MODEL: blank GW counts the same penalty as in scoreOverHorizon.
      wSum   += BLANK_GW_VALUE * w;
      wTotal += w;
      continue;
    }

    for (const f of fixtures) {
      const isHome   = f.homeTeamId === team.id;
      const oppId    = isHome ? f.awayTeamId : f.homeTeamId;
      const opponent = ctx.teamsById[oppId];
      if (!opponent) { wSum += 50 * w; wTotal += w; continue; }

      let edgeValue;
      let estimated = false;

      if (player.position === 'FWD') {
        const cm  = calcCounterMatchup(team, opponent, ctx);
        edgeValue = cm.pairings.fwdVsCb?.value ?? 50;
        estimated = cm.pairings.fwdVsCb?.estimated ?? true;
      } else if (player.position === 'MID') {
        const cm  = calcCounterMatchup(team, opponent, ctx);
        const wm  = cm.pairings.wideMidVsFb?.value ?? 50;
        const cam = cm.pairings.camVsCbMid?.value  ?? 50;
        edgeValue = (wm + cam) / 2;
        estimated = (cm.pairings.wideMidVsFb?.estimated ?? true)
                 || (cm.pairings.camVsCbMid?.estimated  ?? true);
      } else {
        // DEF/GKP: invert opponent's attack score — higher = their attack is weak vs this defence.
        // MODEL: a defender's counter edge is determined by how poorly the opponent attacks.
        const oppCm = calcCounterMatchup(opponent, team, ctx);
        edgeValue   = 100 - oppCm.value;
        estimated   = oppCm.estimated;
      }

      if (estimated) anyEstimated = true;
      wSum   += edgeValue * w;
      wTotal += w;
    }
  }

  return {
    value:     wTotal === 0 ? 50 : clamp(0, 100, wSum / wTotal),
    estimated: anyEstimated || wTotal === 0,
  };
}

/**
 * Aggregate a team's composite scores across a horizon window.
 * Handles blank GWs (no fixture → BLANK_GW_VALUE, never silently skipped) and
 * double GWs (both fixtures scored and included, naturally boosting the score).
 * Applies HORIZON_DECAY weighting and AGG_METHOD blending from config.
 *
 * Pure: no DOM, no fetch, no store mutation — all inputs are parameters.
 *
 * @param {Team}   team
 * @param {{label: string, gws: number}} horizon  e.g. HORIZONS.GW3
 * @param {object} ctx   output of buildScoreContext
 * @returns {object}  CompositeScore shape + perGw strip
 *   value: 0–100, higher = better fixture run for `team`. Direction: higher = better.
 *   perGw: [{gw, value, band, opponent, venue, isBlank}] one entry per scored slot;
 *     DGWs produce two entries for the same gw, blanks one with isBlank: true.
 *   See FEATURE_ENGINE.md §9.
 */
export function scoreOverHorizon(team, horizon, ctx) {
  if (!team || !horizon || !ctx || !ctx.teamsById) {
    throw new TypeError('scoreOverHorizon: team, horizon, and ctx are required');
  }

  const numGws   = horizon.gws;
  const startGw  = ctx.currentGw;
  const gwWindow = Array.from({ length: numGws }, (_, i) => startGw + i);
  const gwSet    = new Set(gwWindow);

  const teamFixturesByGw = fixturesForTeamInWindow(team, gwSet, ctx);

  const entries = [];  // { gwOffset, value, fixtureScore | null }
  const perGw   = [];  // public per-GW strip array

  for (let i = 0; i < gwWindow.length; i++) {
    const gw       = gwWindow[i];
    const gwOffset = i;  // 0 = nearest, matches HORIZON_DECAY exponent
    const fixtures = teamFixturesByGw.get(gw) ?? [];

    if (fixtures.length === 0) {
      // MODEL: blank GW — BLANK_GW_VALUE (40) reflects zero return for assets;
      // mildly bad rather than neutral, never silently skipped. FEATURE_ENGINE.md §9.
      entries.push({ gwOffset, value: BLANK_GW_VALUE, fixtureScore: null });
      perGw.push({
        gw, value: BLANK_GW_VALUE, band: bandFromValue(BLANK_GW_VALUE),
        opponent: null, venue: null, isBlank: true,
      });
    } else {
      for (const f of fixtures) {
        const score  = scoreFixture(team, f, ctx);
        const isHome = f.homeTeamId === team.id;
        const oppId  = isHome ? f.awayTeamId : f.homeTeamId;
        const opp    = ctx.teamsById[oppId];
        entries.push({ gwOffset, value: score.value, fixtureScore: score });
        perGw.push({
          gw,
          value:       score.value,
          band:        score.band,
          opponent:    opp?.shortName ?? null,
          venue:       isHome ? 'H' : 'A',
          isBlank:     false,
          provisional: score.provisional,
        });
      }
    }
  }

  if (entries.length === 0) {
    return {
      value: 50, band: bandFromValue(50), confidence: 1, provisional: false, perGw: [],
      breakdown: { aggregateMean: 50, aggregateMin: 50, aggMethod: AGG_METHOD, numGws, numBlanks: 0 },
    };
  }

  // Weighted mean with GW-distance decay; nearer GWs have more weight.
  let wSum   = 0;
  let wTotal = 0;
  let minVal = 100;

  for (const e of entries) {
    const w = Math.pow(HORIZON_DECAY, e.gwOffset);
    wSum   += e.value * w;
    wTotal += w;
    if (e.value < minVal) minVal = e.value;
  }

  const aggregateMean = wTotal === 0 ? 50 : wSum / wTotal;
  const aggregateMin  = minVal;

  let rawValue;
  if (AGG_METHOD === 'mean') {
    rawValue = aggregateMean;
  } else if (AGG_METHOD === 'min') {
    rawValue = aggregateMin;
  } else {
    // 'blend' (default): rewards a good run but punishes a single brutal fixture.
    // W_MIN * aggregateMin surfaces fixture traps hiding in a green sequence.
    rawValue = (W_MEAN * aggregateMean) + (W_MIN * aggregateMin);
  }

  const value = clamp(0, 100, rawValue);

  const scoredEntries = entries.filter(e => e.fixtureScore !== null);
  const avgConfidence = scoredEntries.length === 0 ? 0.5
    : scoredEntries.reduce((s, e) => s + (e.fixtureScore.confidence ?? 0), 0) / scoredEntries.length;
  const numBlanks = entries.length - scoredEntries.length;

  return {
    value,
    band:        bandFromValue(value),
    confidence:  avgConfidence,
    provisional: avgConfidence < CONFIDENCE_FLOOR,
    perGw,
    breakdown: {
      aggregateMean,
      aggregateMin,
      aggMethod:  AGG_METHOD,
      numGws,
      numBlanks,
    },
  };
}

// ─── §10  Player projection ───────────────────────────────────────────────────

/**
 * Average FPL points per gameweek this season. Prefers real per-GW history
 * (already lazily loaded via a player-summary fetch — never bulk-fetched, see
 * ARCHITECTURE.md §3 rule 7): FPL's history payload has one entry per elapsed
 * gameweek regardless of whether the player featured (0 minutes/0 points for
 * a blank week), so totalPoints / history.length is already a true weekly
 * average. Falls back to season totals ÷ elapsed gameweeks when no summary
 * is loaded, flagged estimated.
 *
 * MODEL: the fallback divides by gameweeks ELAPSED THIS SEASON
 * (ctx.playedFixtures, deduplicated by gw), not by games the player actually
 * appeared in. A player who scored 10 points in GW1 and then missed GW2-4
 * averages 10/4 = 2.5, not 10/1 = 10 — a non-playing week counts as a
 * (correctly zero-contributing) week, exactly like the real per-GW-history
 * branch above already does. Dividing by games played instead would make
 * fringe/rotation players who had one big week look like elite performers.
 *
 * Pure: depends only on `player` and ctx (playerSummariesById, playedFixtures
 * — both already part of every ctx built by buildScoreContext) — no new
 * network access.
 *
 * @param {Player} player
 * @param {object} ctx
 * @returns {{value: number, estimated: boolean}}
 *   value: average points per GW. estimated: true when derived from season
 *   totals rather than real per-GW history.
 */
export function calcAvgPointsPerGw(player, ctx) {
  const summary = ctx.playerSummariesById?.[player.id];
  const history  = summary?.history;
  if (history && history.length > 0) {
    const totalPoints = history.reduce((s, g) => s + (g.points || 0), 0);
    return { value: totalPoints / history.length, estimated: false };
  }

  const points      = player.totals?.points ?? 0;
  const elapsedGws  = new Set((ctx.playedFixtures || []).map(f => f.gw)).size;
  if (elapsedGws <= 0) return { value: 0, estimated: true };
  return { value: points / elapsedGws, estimated: true };
}

/**
 * Player projection over a horizon: blends player form, team fixture quality,
 * and position-specific counter-matchup edge. See FEATURE_ENGINE.md §10.
 *
 * @param {Player}  player
 * @param {{label: string, gws: number}} horizon
 * @param {object}  ctx   output of buildScoreContext
 * @returns {{ value: number, band: string, perGw: Array, breakdown: object,
 *             valueScore: number, avgPointsPerGw: {value:number, estimated:boolean},
 *             costPerPoint: number|null, nextFixtureScore: {value:number, estimated:boolean} }}
 *   value: 0–100, higher = better projected value. Direction: higher = better.
 *   valueScore: value / price — points-per-million proxy for budget-aware ranking.
 *   costPerPoint: price / avgPointsPerGw — money spent per point, the INVERSE
 *   ratio direction from valueScore. Never merge these: valueScore answers
 *   "how much projected score do I get per pound", costPerPoint answers "how
 *   much does each point actually cost". null when avgPointsPerGw is 0 (never
 *   NaN/Infinity — a player with no scoring record has no meaningful cost).
 *   nextFixtureScore: 0–100 blend of just fixture + counter (excludes form),
 *   answering "how favourable is this player's next fixture", derived from the
 *   SAME horizonResult/counterEdge already computed below — not a new metric.
 *   See FEATURE_ENGINE.md §10.
 */
export function scorePlayer(player, horizon, ctx) {
  if (!player || !horizon || !ctx) {
    throw new TypeError('scorePlayer: player, horizon, and ctx are required');
  }

  const team = ctx.teamsById[player.teamId];
  if (!team) {
    const avgPointsPerGw = calcAvgPointsPerGw(player, ctx);
    return {
      value: 50, band: bandFromValue(50), perGw: [],
      breakdown: {
        form:    { value: 50, weight: PROJ_FORM,    estimated: true },
        fixture: { value: 50, weight: PROJ_FIXTURE, estimated: true },
        counter: { value: 50, weight: PROJ_COUNTER, estimated: true },
      },
      valueScore: player.price > 0 ? 50 / player.price : 0,
      avgPointsPerGw,
      costPerPoint: (player.price > 0 && avgPointsPerGw.value > 0)
        ? player.price / avgPointsPerGw.value : null,
      nextFixtureScore: { value: 50, estimated: true },
    };
  }

  const formResult    = calcPlayerForm(player, ctx);
  const horizonResult = scoreOverHorizon(team, horizon, ctx);

  // Re-derive the same window used by scoreOverHorizon so the counter edge is consistent.
  const numGws   = horizon.gws;
  const startGw  = ctx.currentGw;
  const gwWindow = Array.from({ length: numGws }, (_, i) => startGw + i);
  const gwSet    = new Set(gwWindow);
  const teamFixturesByGw = fixturesForTeamInWindow(team, gwSet, ctx);

  const counterEdge    = calcPlayerCounterEdge(player, gwWindow, teamFixturesByGw, ctx);
  const avgPointsPerGw = calcAvgPointsPerGw(player, ctx);

  const value = clamp(0, 100,
    (PROJ_FORM    * formResult.value)
  + (PROJ_FIXTURE * horizonResult.value)
  + (PROJ_COUNTER * counterEdge.value),
  );

  return {
    value,
    band:  bandFromValue(value),
    perGw: horizonResult.perGw,
    breakdown: {
      form: {
        value:           formResult.value,
        weight:          PROJ_FORM,
        estimated:       formResult.estimated,
        // minutesSecurity exposed here so callers (e.g. ranker) do not need to
        // re-call calcPlayerForm — avoids doubling the work per player row.
        minutesSecurity: formResult.minutesSecurity ?? null,
      },
      fixture: { value: horizonResult.value, weight: PROJ_FIXTURE, estimated: false },
      counter: { value: counterEdge.value,   weight: PROJ_COUNTER, estimated: counterEdge.estimated },
    },
    valueScore: player.price > 0 ? value / player.price : 0,
    avgPointsPerGw,
    costPerPoint: (player.price > 0 && avgPointsPerGw.value > 0)
      ? player.price / avgPointsPerGw.value : null,
    // Fixture + counter only (excludes form) — "is his NEXT FIXTURE good",
    // not "is he in form". Re-normalised over just these two weights since
    // PROJ_FORM is dropped from the blend. Reuses horizonResult/counterEdge
    // computed above; not a new independent calculation.
    nextFixtureScore: {
      value: clamp(0, 100,
        ((PROJ_FIXTURE * horizonResult.value) + (PROJ_COUNTER * counterEdge.value))
        / (PROJ_FIXTURE + PROJ_COUNTER)),
      estimated: counterEdge.estimated,
    },
  };
}

// ─── rankPlayers ──────────────────────────────────────────────────────────────

/**
 * Score every player over a horizon and return them sorted by projected value
 * descending. Pure — no DOM, no network, no store access.
 * Consumed by modules/ranker.js as the primary entry point for bulk scoring.
 *
 * @param {Player[]} players
 * @param {{label: string, gws: number}} horizon
 * @param {object} ctx  output of buildScoreContext
 * @returns {{ player: Player, score: object }[]}  sorted descending by score.value
 */
export function rankPlayers(players, horizon, ctx) {
  if (!Array.isArray(players) || !horizon || !ctx) {
    throw new TypeError('rankPlayers: players, horizon, and ctx are required');
  }
  return players
    .map(p => ({ player: p, score: scorePlayer(p, horizon, ctx) }))
    .sort((a, b) => b.score.value - a.score.value);
}
