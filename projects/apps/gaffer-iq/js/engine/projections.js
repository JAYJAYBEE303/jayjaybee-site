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
 * See docs/decision-engine-plan.md §2.2 and §5.1.
 */

import { DECISION_ENGINE, HORIZONS, MATCH_MINUTES, PERCENT, STATUS_PLAY_CHANCE } from '../config.js';
import { clamp } from '../util.js';
import { scorePlayer, calcExpectedPoints, fixtureCountFactor } from './composite.js';
import { calcPlaytimeSecurity } from './form.js';

/**
 * @typedef {object} GwProjection
 * @property {number}  gw
 * @property {number}  fixtures      0 = blank, 2 = double
 * @property {number}  xpts          expected points, minutes included, summed over fixtures
 * @property {number}  pStart        chance he starts at least once (brief: p_start)
 * @property {number}  pZero         chance of no minutes at all (brief: p_zero)
 * @property {number}  p60           pStart x completion (brief: p_60)
 * @property {boolean} p60Approx     true until Phase 4's minutes model
 * @property {number}  xptsIfPlays   expected points given he plays (brief: xpts_if_plays)
 * @property {number|null} pP90      upper-tail points, null until Phase 7
 * @property {boolean} estimated     his rates came from season totals or the price prior
 * @property {number}  availability  chance he is fit and permitted to play, 0-1 - apart
 *   from rotation, which pZero also carries (a fit squad player is available but may not play)
 * @property {'fpl'|'status'|'recovery'|'model'} availabilitySource
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
 * @returns {Map<number, {playerId: number, position: string, teamId: number,
 *   price: number, gws: GwProjection[]}>}
 */
export function buildProjections(players, ctx, {
  planningGw, horizonGws = DECISION_ENGINE.horizonGws, gwTable = null, scorePlayerFn = scorePlayer,
} = {}) {
  if (!Array.isArray(players) || !ctx || !Number.isInteger(planningGw)) {
    throw new TypeError('buildProjections: players, ctx and an integer planningGw are required');
  }

  const fixtureCounts = countFixtures(ctx.fixtures);         // scheduled: the horizon
  const playedCounts  = countFixtures(ctx.playedFixtures);   // played: his record
  const rowsByPlayer  = indexTable(gwTable, planningGw);
  const gws = Array.from({ length: horizonGws }, (_, k) => planningGw + k);
  const ctxByGw = gws.map((gw, k) => contextFor(ctx, gw, k));

  const projections = new Map();
  for (const player of players) {
    const rates = contentionRates(player, ctx, playedCounts.get(player.teamId), rowsByPlayer, planningGw);
    projections.set(player.id, {
      playerId: player.id,
      position: player.position,
      teamId:   player.teamId,
      price:    player.price,
      gws: gws.map((gw, k) => projectGw(player, gw, k, rates,
        fixtureCounts.get(player.teamId)?.get(gw) ?? 0, ctxByGw[k], scorePlayerFn)),
    });
  }
  return projections;
}

/** One gameweek of one player's projection (plan §2.2). */
function projectGw(player, gw, k, rates, fixtures, ctxForGw, scorePlayerFn) {
  const available = availability(player, k);
  const base = {
    gw, fixtures, pP90: null, p60Approx: true, estimated: rates.estimated,
    availability: available.value, availabilitySource: available.source,
  };
  if (fixtures === 0) {
    return { ...base, xpts: 0, pStart: 0, pZero: 1, p60: 0, xptsIfPlays: 0 };
  }

  // MODEL: the fixture multiplier and the fixture count from calcExpectedPoints,
  // so every projection in the app prices a fixture and a double the same way.
  // Fit and picked for every fixture, he scores ppa x fm x count(n) on average.
  const { nextFixtureScore } = scorePlayerFn(asOf(player, k), HORIZONS.GW1, ctxForGw);
  const xptsIfAvailable = calcExpectedPoints(
    { value: rates.appearRate * rates.ppa }, nextFixtureScore, { value: PERCENT }, fixtures).value;

  // Availability is shared by the fixtures of a double; selection is per fixture.
  const pPicked = 1 - (1 - rates.appearRate) ** fixtures;
  const pZero   = 1 - (available.value * pPicked);
  const pStart  = Math.min(1 - pZero, available.value * (1 - (1 - rates.startRate) ** fixtures));
  return {
    ...base,
    xpts:        available.value * xptsIfAvailable,
    pStart,
    pZero,
    p60:         pStart * rates.completion,
    // The a = 1 value, so an injured nailed starter keeps what he would score
    // on his return. 0 when he is never picked (then xpts is 0 as well).
    xptsIfPlays: pPicked > 0 ? xptsIfAvailable / pPicked : 0,
  };
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
 *            estimated: boolean}}  ppa: points per appearance, per fixture
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
    return { appearRate: prior, ppa, startRate: prior, completion, estimated: true };
  }
  return {
    appearRate: clamp(0, 1, appearances / span),
    ppa,
    startRate:  clamp(0, 1, starts / span),
    completion,
    estimated:  !rowsByPlayer,
  };
}

/**
 * The gameweeks of an absence that should not count against his rates: his
 * latest run of zero-minute gameweeks when it is still running and he is
 * flagged now, or when it lasted at least absenceMinRunGws, ended within
 * absenceLookbackGws of his latest gameweek and he has played since (P8). A
 * running zero run while he is fit is a dropping, and counts.
 *
 * @param {Array<{gw: number, minutes: number}>} history  ascending gameweeks
 * @param {boolean} flaggedNow
 * @returns {Set<number>}
 */
function excusedAbsence(history, flaggedNow) {
  let end = history.length - 1;
  while (end >= 0 && history[end].minutes > 0) end--;
  if (end < 0) return new Set();
  let start = end;
  while (start > 0 && history[start - 1].minutes === 0) start--;

  const run = history.slice(start, end + 1).map(h => h.gw);
  const running = end === history.length - 1;
  const excused = running
    ? flaggedNow
    : run.length >= DECISION_ENGINE.absenceMinRunGws
      && history.at(-1).gw - run.at(-1) <= DECISION_ENGINE.absenceLookbackGws;
  return excused ? new Set(run) : new Set();
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
