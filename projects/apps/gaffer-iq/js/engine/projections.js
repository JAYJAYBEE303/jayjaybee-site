/**
 * js/engine/projections.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * The projection adapter: per player, per gameweek of the decision horizon,
 * the data contract the decision engine reads (brief §3) - expected points
 * with minutes already in them, the chance of no minutes at all, and expected
 * points if he plays.
 *
 * Built forward from one basis for every player, never from scorePlayer's
 * window-level expectedPoints, so that:
 *  - there is one projection per GAMEWEEK (a blank is 0, a double 1.9x);
 *  - availability recovers over the horizon instead of carrying this week's
 *    flag flat - in his own figure and in his club's channel read (P7);
 *  - every player gets the same estimator whatever element-summaries happen
 *    to be loaded (P6);
 *  - an injury spell does not drag his rates once it is excused (P8);
 *  - xpts = (1 - pZero) x xptsIfPlays holds by algebra.
 * Only the fixture multiplier comes from the scorer, via nextFixtureScore.
 *
 * His chances of appearing, starting and playing 60 minutes come from the
 * fitted minutes model (engine/minutes.js) when the live table holds his
 * record; otherwise the v1 rates stand in. Availability is FPL's flag and its
 * recovery either way.
 *
 * See docs/decision-engine-plan.md §2.2, §5.1 and Phase 4.
 */

import { DECISION_ENGINE, FIXTURE_SCORE_EVEN, HORIZONS, MATCH_MINUTES, PERCENT, STATUS_PLAY_CHANCE } from '../config.js';
import { clamp, toTenths } from '../util.js';
import { scorePlayer, scoreFixture, calcExpectedPoints, fixtureCountFactor } from './composite.js';
import { calcPlaytimeSecurity } from './form.js';
import { excusedAbsence, minutesFeatures, selectionChances } from './minutes.js';
import { fixturePoints, playerRates } from './points.js';
import { fixtureGoals, teamRates, teamStrengths } from './team-goals.js';

/**
 * @typedef {object} GwProjection
 * @property {number}  gw
 * @property {number}  fixtures      0 = blank, 2 = double
 * @property {number}  xpts          expected points, minutes included, summed over fixtures
 * @property {number}  pStart        chance he starts at least once (brief: p_start)
 * @property {number}  pZero         chance of no minutes at all (brief: p_zero)
 * @property {number}  p60           chance he plays 60 minutes or more (brief: p_60)
 * @property {boolean} p60Approx     the v1 rates stood in: p60 is pStart x completion
 * @property {number}  xptsIfPlays   expected points given he plays (brief: xpts_if_plays)
 * @property {number|null} pP90      upper-tail points, null until Phase 7
 * @property {boolean} estimated     his chances came from season totals or the price prior
 * @property {number}  availability  chance he is fit and permitted to play, 0-1 - apart
 *   from rotation, which pZero also carries (a fit squad player is available but may not play)
 * @property {'fpl'|'status'|'recovery'} availabilitySource
 */

/**
 * Project every player over the decision horizon.
 *
 * @param {Player[]} players  the squad plus every candidate
 * @param {object} ctx        buildScoreContext output (its summaries are ignored)
 * @param {object} opts
 * @param {number} opts.planningGw                the first gameweek projected
 * @param {number} [opts.horizonGws]              DECISION_ENGINE.horizonGws by default
 * @param {object[]|null} [opts.gwTable]          the per-gameweek minutes/points
 *   records of js/snapshots.js ({ gw, players: [{ playerId, minutes, points, starts }] });
 *   null falls back to season totals, flagged estimated
 * @param {Function} [opts.scorePlayerFn]         scorePlayer, or a test's stand-in
 * @param {object|null} [opts.minutesModel]       DECISION_ENGINE.minutesModel by
 *   default; null runs the v1 rates
 * @returns {Map<number, {playerId: number, position: string, teamId: number,
 *   price: number, gws: GwProjection[]}>}
 */
export function buildProjections(players, ctx, {
  planningGw, horizonGws = DECISION_ENGINE.horizonGws, gwTable = null, scorePlayerFn = scorePlayer,
  minutesModel = DECISION_ENGINE.minutesModel, pointsModel = DECISION_ENGINE.pointsModel,
  scoreFixtureFn = scoreFixture,
} = {}) {
  if (!Array.isArray(players) || !ctx || !Number.isInteger(planningGw)) {
    throw new TypeError('buildProjections: players, ctx and an integer planningGw are required');
  }

  const fixtureCounts = countFixtures(ctx.fixtures);         // scheduled: the horizon
  const playedCounts  = countFixtures(ctx.playedFixtures);   // played: his record
  const rowsByPlayer  = indexTable(gwTable, planningGw);
  const gws = Array.from({ length: horizonGws }, (_, k) => planningGw + k);
  const ctxByGw = gws.map((gw, k) => contextFor(ctx, gw, k));
  const goals = pointsModel ? fixtureGoalsByTeam(players, ctx, gws, pointsModel, scoreFixtureFn) : null;

  const projections = new Map();
  for (const player of players) {
    const rates = contentionRates(player, ctx, playedCounts.get(player.teamId), rowsByPlayer, planningGw);
    const priceTenths = toTenths(player.price);
    const features = minutesModel && rates.record
      ? minutesFeatures(rates.record, { position: player.position, priceTenths })
      : null;
    const pointsRates = goals
      && playerRates(player.totals, goals.rates.get(player.teamId), { position: player.position, priceTenths }, pointsModel);
    projections.set(player.id, {
      playerId: player.id,
      position: player.position,
      teamId:   player.teamId,
      price:    player.price,
      gws: gws.map((gw, k) => projectGw(player, gw, k, rates,
        features && selectionChances(features, minutesModel, k),
        fixtureCounts.get(player.teamId)?.get(gw) ?? 0, ctxByGw[k], scorePlayerFn,
        goals && { rates: pointsRates, sides: goals.byTeam.get(player.teamId)?.get(gw) ?? [], model: pointsModel })),
    });
  }
  return projections;
}

/**
 * One gameweek of one player's projection (plan §2.2). `chances` are the
 * minutes model's per-fixture chances for this gameweek, or null for the v1
 * rates; `parts` is the points model's reading of his fixtures, or null for
 * the v1 basis.
 */
function projectGw(player, gw, k, rates, chances, fixtures, ctxForGw, scorePlayerFn, parts) {
  const available = availability(player, k);
  const appearRate = chances ? chances.appear : rates.appearRate;
  const startRate  = chances ? chances.start : rates.startRate;
  const base = {
    gw, fixtures, pP90: null, p60Approx: !chances, estimated: !chances && rates.estimated,
    availability: available.value, availabilitySource: available.source,
  };
  if (fixtures === 0) {
    return { ...base, xpts: 0, pStart: 0, pZero: 1, p60: 0, xptsIfPlays: 0 };
  }

  const xptsIfAvailable = parts
    ? partsPoints(parts, appearRate, chances ? chances.p60 : rates.startRate * rates.completion, fixtures)
    : v1Points(player, k, appearRate * rates.ppa, fixtures, ctxForGw, scorePlayerFn);

  // Availability is shared by the fixtures of a double; selection is per fixture.
  const pPicked = 1 - (1 - appearRate) ** fixtures;
  const pZero   = 1 - (available.value * pPicked);
  const pStart  = Math.min(1 - pZero, available.value * (1 - (1 - startRate) ** fixtures));
  return {
    ...base,
    xpts:        available.value * xptsIfAvailable,
    pStart,
    pZero,
    p60:         chances ? available.value * (1 - (1 - chances.p60) ** fixtures) : pStart * rates.completion,
    // The a = 1 value, so an injured nailed starter keeps what he would score
    // on his return. 0 when he is never picked (then xpts is 0 as well).
    xptsIfPlays: pPicked > 0 ? xptsIfAvailable / pPicked : 0,
  };
}

/**
 * Fit, his expected points from the v1 basis. MODEL: the fixture multiplier
 * and the fixture count from calcExpectedPoints, so every projection in the
 * app prices a fixture and a double the same way. Fit and picked for every
 * fixture, he scores ppa x fm x count(n) on average.
 */
function v1Points(player, k, basis, fixtures, ctxForGw, scorePlayerFn) {
  const { nextFixtureScore } = scorePlayerFn(asOf(player, k), HORIZONS.GW1, ctxForGw);
  return calcExpectedPoints({ value: basis }, nextFixtureScore, { value: PERCENT }, fixtures).value;
}

/**
 * Fit, his expected points from the points model: each fixture's parts
 * (engine/points.js) at his chance of 60 minutes once he is on, times his
 * chance of being picked, with a double's rotation haircut as in
 * calcExpectedPoints.
 */
function partsPoints({ rates, sides, model }, appearRate, p60Rate, fixtures) {
  if (!(appearRate > 0) || sides.length === 0) return 0;
  const p60 = clamp(0, 1, p60Rate / appearRate);
  const minutes = (p60 * model.minutesIfFull) + ((1 - p60) * model.minutesIfShort);
  const perGame = sides.reduce((sum, side) => sum + fixturePoints(rates, { ...side, p60, minutes }, model).total, 0);
  return appearRate * perGame * (fixtureCountFactor(fixtures) / fixtures);
}

/**
 * Each club's expected goals for and against in each of its fixtures over the
 * horizon (engine/team-goals.js), from every player's season totals and the
 * clubs' priors (model.teamPriors, by FPL club code; a club without one reads
 * as promoted). With model.fixtureRating.weight, each side's expected goals
 * also scale by exp(weight x (s - even) / even), s being the fixture engine's
 * 0-100 score for that side (scoreFixture), so a side it rates well expects
 * more goals and its opponent fewer.
 *
 * @returns {{rates: Map, byTeam: Map<number, Map<number, Array<{lambdaFor: number, lambdaAgainst: number}>>>}}
 */
function fixtureGoalsByTeam(players, ctx, gws, model, scoreFixtureFn) {
  const rates = teamRates(players);
  const priors = new Map();
  for (const team of Object.values(ctx.teamsById ?? {})) {
    if (!rates.has(team.id)) rates.set(team.id, { xgFor90: 0, xgAgainst90: 0, matches: 0 });
    const prior = model.teamPriors?.[team.code];
    if (prior) priors.set(team.id, prior);
  }
  const strengths = teamStrengths(rates, priors, model.teams);
  const horizon = new Set(gws);
  const byTeam = new Map();
  const add = (teamId, gw, side) => {
    const byGw = byTeam.get(teamId) ?? new Map();
    byGw.set(gw, [...(byGw.get(gw) ?? []), side]);
    byTeam.set(teamId, byGw);
  };
  const weight = model.fixtureRating?.weight ?? 0;
  const rated = (teamId, f, goals) => (weight
    ? goals * Math.exp(weight * ((scoreFixtureFn(ctx.teamsById[teamId], f, ctx).value - FIXTURE_SCORE_EVEN) / FIXTURE_SCORE_EVEN))
    : goals);
  for (const f of ctx.fixtures ?? []) {
    if (!horizon.has(f.gw)) continue;
    const plain = fixtureGoals(strengths, f.homeTeamId, f.awayTeamId, model.teams);
    const home = rated(f.homeTeamId, f, plain.home);
    const away = rated(f.awayTeamId, f, plain.away);
    add(f.homeTeamId, f.gw, { lambdaFor: home, lambdaAgainst: away });
    add(f.awayTeamId, f.gw, { lambdaFor: away, lambdaAgainst: home });
  }
  return { rates, byTeam };
}

/**
 * His chance of being available k gameweeks after the planning gameweek, 0-1.
 * k = 0 is FPL's chance_of_playing_next_round, else his status's default
 * (STATUS_PLAY_CHANCE). Later gameweeks recover by his status's carry-over,
 * never at this week's figure.
 *
 * @returns {{value: number, flagged: boolean, source: 'fpl'|'status'|'recovery'}}
 */
function availability(player, k) {
  const chance = player.chanceOfPlayingNext;
  const fromFpl = typeof chance === 'number' && Number.isFinite(chance);
  const now = clamp(0, 1,
    (fromFpl ? chance : (STATUS_PLAY_CHANCE[player.status] ?? STATUS_PLAY_CHANCE.available)) / PERCENT);
  const flagged = now < 1;
  if (k === 0 || !flagged) return { value: now, flagged, source: fromFpl ? 'fpl' : 'status' };

  const carry = DECISION_ENGINE.absenceCarryOver;
  return {
    value: 1 - ((1 - now) * (carry[player.status] ?? carry.doubtful) ** k),
    flagged,
    source: 'recovery',
  };
}

/** The player as he stands k gameweeks ahead: a flagged player carries his recovered chance. */
function asOf(player, k) {
  const { value, flagged } = availability(player, k);
  return flagged ? { ...player, chanceOfPlayingNext: value * PERCENT } : player;
}

/**
 * The scoring context for one gameweek of the horizon: a single-gameweek
 * window starting there, no element-summaries (P6), and every flagged
 * player's chance recovered for that gameweek (P7) - channel.js reads his
 * club-mates' chances from playersByTeamId inside every fixture score.
 * Nothing else in ctx is keyed to currentGw, so this leaks no future data.
 */
function contextFor(ctx, gw, k) {
  const playersByTeamId = {};
  for (const [teamId, list] of Object.entries(ctx.playersByTeamId ?? {})) {
    playersByTeamId[teamId] = list.map(p => asOf(p, k));
  }
  return { ...ctx, currentGw: gw, playerSummariesById: {}, playersByTeamId };
}

/**
 * His rates over the gameweeks he was in contention (plan §2.2): the elapsed
 * gameweeks his club played, less an excused absence (see excusedAbsence).
 * Unshrunk - a nailed starter's appearance rate is 1 at any price.
 *
 * Without the live table, season totals over his club's matches stand in,
 * flagged estimated. With fewer than minContentionGws gameweeks to go on, his
 * price prior (calcPlaytimeSecurity) stands in for the appearance and start
 * rates, flagged estimated.
 *
 * @returns {{appearRate: number, ppa: number, startRate: number, completion: number,
 *            estimated: boolean, record: import('./minutes.js').GwRecord[]|null}}
 *   ppa: points per appearance, per fixture; record: his contention gameweeks
 *   for the minutes model, null without the table
 */
function contentionRates(player, ctx, playedByGw, rowsByPlayer, planningGw) {
  const totals = player.totals ?? {};
  // Played matches only: in a live gameweek his club's remaining match is not
  // yet in his totals, so it must not count as one he missed.
  const playedGws = [...(playedByGw ?? new Map())].filter(([gw]) => gw < planningGw);

  let span;          // contention units: his club's matches, or gameweeks with the table
  let appearances;
  let points;        // per-fixture points over those appearances
  let starts;
  let minutes;
  let record = null;
  if (!rowsByPlayer) {
    span        = playedGws.reduce((sum, [, n]) => sum + n, 0);
    appearances = totals.starts ?? 0;
    points      = totals.points ?? 0;
    starts      = appearances;
    minutes     = totals.minutes ?? 0;
  } else {
    const rows = rowsByPlayer.get(player.id) ?? new Map();
    const seen = playedGws.filter(([gw]) => rows.has(gw)).sort(([a], [b]) => a - b);
    const excused = excusedAbsence(seen.map(([gw]) => ({ gw, minutes: rows.get(gw).minutes })),
      availability(player, 0).flagged);
    const inContention = seen.filter(([gw]) => !excused.has(gw));
    const contentionRows = inContention.map(([gw, n]) => ({ ...rows.get(gw), n }));
    const appeared = contentionRows.filter(r => r.minutes > 0);
    record = inContention.map(([gw, n]) =>
      ({ gw, fixtures: n, minutes: rows.get(gw).minutes, starts: rows.get(gw).starts }));

    span        = inContention.length;
    appearances = appeared.length;
    // MODEL: a past double's points are scaled back to one fixture by the same
    // count factor that scales a future double up, so neither is counted twice.
    points      = appeared.reduce((sum, r) => sum + (r.points / fixtureCountFactor(r.n)), 0);
    starts      = contentionRows.every(r => Number.isFinite(r.starts))
      ? contentionRows.reduce((sum, r) => sum + r.starts, 0)
      : (totals.starts ?? 0);
    minutes     = contentionRows.reduce((sum, r) => sum + r.minutes, 0);
  }

  const ppa = appearances > 0 ? points / appearances : 0;
  const completion = starts > 0 ? clamp(0, 1, minutes / (starts * MATCH_MINUTES)) : 0;
  if (span < DECISION_ENGINE.minContentionGws) {
    const { prior } = calcPlaytimeSecurity(player, ctx);
    return { appearRate: prior, ppa, startRate: prior, completion, estimated: true, record };
  }
  return {
    appearRate: clamp(0, 1, appearances / span),
    ppa,
    startRate:  clamp(0, 1, starts / span),
    completion,
    estimated:  !rowsByPlayer,
    record,
  };
}

/** Fixtures per club per gameweek: Map<teamId, Map<gw, count>>. */
function countFixtures(fixtures) {
  const counts = new Map();
  for (const f of fixtures ?? []) {
    if (f.gw === null || f.gw === undefined) continue;
    for (const teamId of [f.homeTeamId, f.awayTeamId]) {
      const byGw = counts.get(teamId) ?? new Map();
      byGw.set(f.gw, (byGw.get(f.gw) ?? 0) + 1);
      counts.set(teamId, byGw);
    }
  }
  return counts;
}

/**
 * The live table's rows before the planning gameweek, by player then
 * gameweek, or null when there is no table to read.
 * @returns {Map<number, Map<number, {minutes, points, starts}>>|null}
 */
function indexTable(gwTable, planningGw) {
  const records = (gwTable ?? []).filter(r => r.gw < planningGw);
  if (records.length === 0) return null;
  const rowsByPlayer = new Map();
  for (const record of records) {
    for (const row of record.players ?? []) {
      const rows = rowsByPlayer.get(row.playerId) ?? new Map();
      rows.set(record.gw, row);
      rowsByPlayer.set(row.playerId, rows);
    }
  }
  return rowsByPlayer;
}
