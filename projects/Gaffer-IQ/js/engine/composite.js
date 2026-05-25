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
import { clamp } from '../util.js';
import {
  calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory,
} from './fixtures.js';
import { calcTeamForm, calcPlayerForm } from './form.js';
import { calcStyleClash }    from './style.js';
import { calcCounterMatchup } from './counter.js';

/**
 * Build the assembly context every engine function consumes. Pure — derives
 * indices and aggregates from a Season plus an optional summary map, never
 * mutates either input.
 *
 * @param {Season} season   output of normaliseSeason
 * @param {object} [opts]
 * @param {object} [opts.playerSummariesById]  playerId → PlayerSummary (may be partial)
 * @param {number} [opts.currentGw]            override; defaults to season.currentGw, then nextGw, then 1
 * @returns {object} ctx consumed by calcBase/HomeAway/Form/Style/Counter/FixtureHistory.
 *
 *   ctx shape:
 *     teamsById:           Object<teamId, Team>           (passthrough)
 *     playersByTeamId:     Object<teamId, Player[]>       (derived)
 *     fixtures:            Fixture[]                       (passthrough, sorted)
 *     playedFixtures:      Fixture[]                       (derived: f.played && f.result)
 *     playerSummariesById: Object<playerId, PlayerSummary> (passthrough, possibly {})
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

  return {
    teamsById:           season.teamsById,
    playersByTeamId,
    fixtures:            season.fixtures || [],
    playedFixtures,
    playerSummariesById: opts.playerSummariesById || {},
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
  const value = clamp(0, 100,
      (WEIGHTS.baseDifficulty * base.value)
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
        value:     base.value,
        weight:    WEIGHTS.baseDifficulty,
        estimated: base.estimated,
        attackEdge:  base.attackEdge,
        defenceEdge: base.defenceEdge,
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
          value:    score.value,
          band:     score.band,
          opponent: opp?.shortName ?? null,
          venue:    isHome ? 'H' : 'A',
          isBlank:  false,
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
 * Player projection over a horizon: blends player form, team fixture quality,
 * and position-specific counter-matchup edge. See FEATURE_ENGINE.md §10.
 *
 * @param {Player}  player
 * @param {{label: string, gws: number}} horizon
 * @param {object}  ctx   output of buildScoreContext
 * @returns {{ value: number, band: string, perGw: Array, breakdown: object, valueScore: number }}
 *   value: 0–100, higher = better projected value. Direction: higher = better.
 *   valueScore: value / price — points-per-million proxy for budget-aware ranking.
 *   See FEATURE_ENGINE.md §10.
 */
export function scorePlayer(player, horizon, ctx) {
  if (!player || !horizon || !ctx) {
    throw new TypeError('scorePlayer: player, horizon, and ctx are required');
  }

  const team = ctx.teamsById[player.teamId];
  if (!team) {
    return {
      value: 50, band: bandFromValue(50), perGw: [],
      breakdown: {
        form:    { value: 50, weight: PROJ_FORM,    estimated: true },
        fixture: { value: 50, weight: PROJ_FIXTURE, estimated: true },
        counter: { value: 50, weight: PROJ_COUNTER, estimated: true },
      },
      valueScore: player.price > 0 ? 50 / player.price : 0,
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

  const counterEdge = calcPlayerCounterEdge(player, gwWindow, teamFixturesByGw, ctx);

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
