/**
 * js/engine/composite.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Combines every sub-metric into the composite matchup score (CompositeScore).
 * See FEATURE_ENGINE.md §8. This is the top of the engine call chain — modules
 * call scoreFixture, never the individual calc* functions, so every displayed
 * score travels with its breakdown for explainability (ARCHITECTURE.md §8).
 * Output: 0–100, higher = better fixture for the team being scored.
 *
 * Phase 1B implements scoreFixture only. scoreOverHorizon and scorePlayer
 * (FEATURE_ENGINE.md §9, §10) land in Phase 2A — see ROADMAP.md.
 */

import {
  WEIGHTS, BANDS, CONFIDENCE_FLOOR, LEAGUE_AVG_STRENGTH,
} from '../config.js';
import { clamp } from '../util.js';
import {
  calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory,
} from './fixtures.js';
import { calcTeamForm }      from './form.js';
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
