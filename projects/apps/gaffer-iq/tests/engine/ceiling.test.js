/**
 * tests/engine/ceiling.test.js
 * Ceiling's upper tail (js/engine/ceiling.js, plan Phase 7b): Monte Carlo
 * draws of a gameweek's points from the points model's own parts, teammates
 * sharing their team's goals, and a fielded squad's score quantile over them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawGameweek, squadQuantile, quantile } from '../../js/engine/ceiling.js';
import { buildProjections } from '../../js/engine/projections.js';
import { buildScoreContext } from '../../js/engine/composite.js';
import { DECISION_ENGINE } from '../../js/config.js';
import { syntheticSeason, rawPlayer } from './synthetic-season.js';

const PLANNING_GW = 9;
const DRAWS = { draws: 40000, seed: 1 };

/** Club 1 at home to clubs 2-4 in turn, one fixture a gameweek. */
function homeRun(from, to, played) {
  const run = [];
  for (let gw = from; gw <= to; gw++) run.push([gw, 1, 2 + (gw % 3), played]);
  return run;
}

/** Every player on the pitch for every one of the eight gameweeks played: 90 minutes, or `minutes[id]` week by week. */
function liveTable(ids, minutes = {}) {
  return Array.from({ length: 8 }, (_, i) => ({
    gw: i + 1, final: true, players: ids.map(playerId => {
      const m = minutes[playerId]?.[i] ?? 90;
      return { playerId, minutes: m, points: 6, starts: m >= 60 ? 1 : 0 };
    }),
  }));
}

const ZERO_BONUS = { base: 0, goal: 0, assist: 0, cleanSheet: 0 };
const POINTS_MODEL = {
  goalsPerXg: 1, assistsPerXa: 1.2, minutesIfFull: 90, minutesIfShort: 30, defconDispersion: 20,
  bonus: { GKP: ZERO_BONUS, DEF: ZERO_BONUS, MID: ZERO_BONUS, FWD: ZERO_BONUS },
  priors: Object.fromEntries(['GKP', 'DEF', 'MID', 'FWD'].map(p => [p, {
    goalShare: [p === 'FWD' ? 0.3 : 0.05, 0], assistShare: [0.08, 0], defconPer90: [p === 'DEF' ? 9 : 5, 0],
    savesPerXga: 2, yellowsPer90: 0.1, redsPer90: 0.01,
  }])),
  priorWeight: { share: 1, per90: 1, saves: 1 },
  teams: { leagueXg: 1.4, priorMatches: 2, homeAdvantage: 1.1, promoted: { attack: 1, defence: 1 } },
  teamPriors: {},
};

// Striker 1, midfielder 2 and keeper 3 at club 1; defender 4 at club 2, GW9's visitors; a doubt, midfielder 5 at club 1;
// defender 6 at club 1, a part-timer (full matches and 20-minute ones), so his clean sheet needs his 60 minutes.
const PLAYERS = [
  rawPlayer(1, 1, 'FWD', { minutes: 720, starts: 8, expected_goals: '4.0', expected_assists: '1.0', expected_goals_conceded: '8.0' }),
  rawPlayer(2, 1, 'MID', { minutes: 720, starts: 8, expected_goals: '1.5', expected_assists: '2.0', expected_goals_conceded: '8.0' }),
  rawPlayer(3, 1, 'GKP', { minutes: 720, starts: 8, saves: 20, expected_goals_conceded: '8.0' }),
  rawPlayer(4, 2, 'DEF', { minutes: 720, starts: 8, expected_goals_conceded: '10.0', defensive_contribution: 70 }),
  rawPlayer(5, 1, 'MID', { minutes: 720, starts: 8, expected_goals: '1.0', chance_of_playing_next_round: 50, status: 'd' }),
  rawPlayer(6, 1, 'DEF', { minutes: 440, starts: 4, expected_goals_conceded: '4.0' }),
];
const PART_TIMER = { 6: [90, 20, 90, 20, 90, 20, 90, 20] };

function projectionsFor(pointsModel, fixtures = [...homeRun(1, 8, true), ...homeRun(9, 14, false)]) {
  const season = syntheticSeason({ playedGws: 8, fixtures, players: PLAYERS });
  return buildProjections(season.players, buildScoreContext(season),
    { planningGw: PLANNING_GW, horizonGws: 6, gwTable: liveTable([1, 2, 3, 4, 5, 6], PART_TIMER), minutesModel: null, pointsModel });
}

const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
function corr(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// ─── Draws ───────────────────────────────────────────────────────────────────

test('each player\'s draws average his projected points, whatever the model', () => {
  for (const model of [POINTS_MODEL, DECISION_ENGINE.pointsModel]) {
    const projections = projectionsFor(model);
    const { points } = drawGameweek(projections, PLANNING_GW, [1, 2, 3, 4, 5, 6], DRAWS);
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const xpts = projections.get(id).gws[0].xpts;
      const drawn = mean([...points.get(id)]);
      assert.ok(Math.abs(drawn - xpts) < 0.03 * xpts + 0.02, `player ${id}: drawn ${drawn} v projected ${xpts}`);
    }
  }
});

test('a player whose bonus record runs below his returns draws his projected points too (shipped model)', () => {
  // Fourteen goals, six assists and no bonus: his bonus residual is far below zero, so a week without returns would floor at 0 if
  // each draw's bonus were floored; the mean model floors only the mean.
  const stingy = rawPlayer(7, 1, 'FWD', { minutes: 720, starts: 8, goals_scored: 14, assists: 6, bonus: 0, expected_goals: '5.0',
    expected_goals_conceded: '8.0' });
  const season = syntheticSeason({ playedGws: 8, fixtures: [...homeRun(1, 8, true), ...homeRun(9, 14, false)],
    players: [...PLAYERS, stingy] });
  const projections = buildProjections(season.players, buildScoreContext(season), { planningGw: PLANNING_GW, horizonGws: 6,
    gwTable: liveTable([1, 2, 3, 4, 5, 6, 7], PART_TIMER), minutesModel: null, pointsModel: DECISION_ENGINE.pointsModel });
  const xpts = projections.get(7).gws[0].xpts;
  const drawn = mean([...drawGameweek(projections, PLANNING_GW, [7], DRAWS).points.get(7)]);
  assert.ok(Math.abs(drawn - xpts) < 0.01 * xpts + 0.02, `drawn ${drawn} v projected ${xpts}`);
});

test('a double\'s draws average its projected points, the rotation haircut included', () => {
  const fixtures = [...homeRun(1, 8, true), [9, 1, 2], [9, 3, 1], ...homeRun(10, 14, false)];
  const projections = projectionsFor(POINTS_MODEL, fixtures);
  const { points } = drawGameweek(projections, PLANNING_GW, [1, 4], DRAWS);
  for (const id of [1, 4]) {
    const xpts = projections.get(id).gws[0].xpts;
    assert.ok(Math.abs(mean([...points.get(id)]) - xpts) < 0.03 * xpts + 0.02, `player ${id}`);
  }
});

test('a doubt is drawn without minutes as often as his chance of none', () => {
  const projections = projectionsFor(POINTS_MODEL);
  const { played } = drawGameweek(projections, PLANNING_GW, [5], DRAWS);
  const none = [...played.get(5)].filter(p => !p).length / DRAWS.draws;
  assert.ok(Math.abs(none - projections.get(5).gws[0].pZero) < 0.01, `${none} v ${projections.get(5).gws[0].pZero}`);
});

test('teammates share their team\'s goals; an opponent\'s defender loses by them', () => {
  const { points } = drawGameweek(projectionsFor(POINTS_MODEL), PLANNING_GW, [1, 2, 4], DRAWS);
  const [striker, mid, defender] = [1, 2, 4].map(id => [...points.get(id)]);
  assert.ok(corr(striker, mid) > 0.05, `striker and midfielder ${corr(striker, mid)}`);
  assert.ok(corr(striker, defender) < -0.05, `striker and their defender ${corr(striker, defender)}`);
});

test('the same seed draws the same points for a player, whoever else is drawn; another seed differs', () => {
  const projections = projectionsFor(POINTS_MODEL);
  const opts = { draws: 500, seed: 7 };
  const alone = drawGameweek(projections, PLANNING_GW, [1], opts).points.get(1);
  assert.deepEqual(drawGameweek(projections, PLANNING_GW, [4, 1, 2], opts).points.get(1), alone);
  assert.notDeepEqual(drawGameweek(projections, PLANNING_GW, [1], { ...opts, seed: 8 }).points.get(1), alone);
});

test('without the points model there is nothing to draw from', () => {
  assert.equal(drawGameweek(projectionsFor(null), PLANNING_GW, [1, 2], DRAWS), null);
});

// ─── A fielded squad's quantile ──────────────────────────────────────────────

test('a squad\'s quantile is over its fielded score each draw: subs for an absent starter, the armband to the vice', () => {
  // 1 GKP; 2-4 DEF; 5-8 MID; 9-11 FWD. Bench 12 (DEF), 13 (MID), 14 (FWD), keeper 15.
  const positions = new Map([[1, 'GKP'], [2, 'DEF'], [3, 'DEF'], [4, 'DEF'], [5, 'MID'], [6, 'MID'], [7, 'MID'], [8, 'MID'],
    [9, 'FWD'], [10, 'FWD'], [11, 'FWD'], [12, 'DEF'], [13, 'MID'], [14, 'FWD'], [15, 'GKP']]);
  const lineup = { xi: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], bench: [12, 13, 14, 15], captainId: 9, viceId: 5 };
  // Four draws. Everyone scores 2 and plays, except: draw 1, captain 9 scores 10; draw 2, defender 2
  // does not play and bench defender 12 scores 6; draw 3, captain 9 does not play and the vice scores 7;
  // draw 4, neither captain nor vice plays (and both bench outfielders who could cover them did).
  const special = [{ 9: [10, 1] }, { 2: [0, 0], 12: [6, 1] }, { 9: [0, 0], 5: [7, 1] }, { 9: [0, 0], 5: [0, 0] }];
  const points = new Map();
  const played = new Map();
  for (const id of positions.keys()) {
    points.set(id, Float64Array.from(special, d => d[id]?.[0] ?? 2));
    played.set(id, Uint8Array.from(special, d => d[id]?.[1] ?? 1));
  }
  const sample = { points, played };
  // Draw 1: 10 x 2 + 20 = 40; draw 2: 20 + 6 + 2 = 28; draw 3: 9 x 2 + 7 + 2 (bench 12 for 9) + 7 = 34;
  // draw 4: 9 x 2 + 2 + 2 (bench 12 and 13 on), no armband = 22.
  assert.equal(squadQuantile(lineup, positions, sample, 0), 22);
  assert.equal(squadQuantile(lineup, positions, sample, 1), 40);
  assert.equal(squadQuantile(lineup, positions, sample, 0.5), 28);
  assert.equal(squadQuantile(lineup, positions, sample, 0.75), 34);
});

test('quantile reads the sorted values, nearest rank', () => {
  assert.equal(quantile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(quantile([5, 1, 3, 2, 4], 0.9), 5);
  assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
});
