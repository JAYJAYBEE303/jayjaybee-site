/**
 * tests/engine/projections.test.js
 * The projection adapter (docs/decision-engine-plan.md §2.2, Phase 2): per
 * player, per gameweek, the data contract the decision engine reads. Most
 * tests inject a neutral-fixture scorer so the expected points read straight
 * off the rates; the double-gameweek, summary and identity tests run the real
 * scorer on a synthetic league.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProjections } from '../../js/engine/projections.js';
import { buildScoreContext } from '../../js/engine/composite.js';
import { calcPlaytimeSecurity } from '../../js/engine/form.js';
import { channelPersonnelFactor } from '../../js/engine/channel.js';
import { DECISION_ENGINE } from '../../js/config.js';
import { syntheticSeason, rawPlayer } from './synthetic-season.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

const PLANNING_GW = 9;

/** Club 1 at home to clubs 2-4 in turn, one fixture a gameweek. */
function homeRun(from, to, played) {
  const run = [];
  for (let gw = from; gw <= to; gw++) run.push([gw, 1, 2 + (gw % 3), played]);
  return run;
}

/** Club 1 has played GW1-8 and plays every gameweek of the horizon, unless told otherwise. */
function league(players, fixtures = [...homeRun(1, 8, true), ...homeRun(9, 14, false)]) {
  const season = syntheticSeason({ playedGws: 8, fixtures, players });
  return { season, ctx: buildScoreContext(season) };
}

/**
 * The live table in js/snapshots.js's shape: one record per played gameweek.
 * `byPlayer` maps a player id to his [minutes, points] in GW fromGw, fromGw+1, ...
 */
function liveTable(byPlayer, fromGw = 1) {
  const length = Math.max(...Object.values(byPlayer).map(rows => rows.length));
  return Array.from({ length }, (_, i) => ({
    gw: fromGw + i,
    final: true,
    players: Object.entries(byPlayer)
      .filter(([, rows]) => rows[i])
      .map(([id, rows]) => {
        const [minutes, points] = rows[i];
        return { playerId: Number(id), minutes, points, starts: minutes > 0 ? 1 : 0 };
      }),
  }));
}

const played = (n, points = 6) => Array(n).fill([90, points]);
const missed = n => Array(n).fill([0, 0]);

/** A neutral fixture every gameweek: the fixture multiplier is exactly 1. */
const neutralScorer = () => ({ nextFixtureScore: { value: 50, estimated: false } });

function project(season, ctx, { gwTable = null, scorePlayerFn = neutralScorer } = {}) {
  return buildProjections(season.players, ctx,
    { planningGw: PLANNING_GW, horizonGws: 6, gwTable, scorePlayerFn });
}

// ─── Expected points: minutes counted once (P1) ──────────────────────────────

test('a player who appears in half the gameweeks at 6 points each projects 3.0, not 1.5', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 24, minutes: 360, starts: 4 })]);
  const table = liveTable({ 1: [[90, 6], [0, 0], [90, 6], [0, 0], [90, 6], [0, 0], [90, 6], [0, 0]] });
  const gw = project(season, ctx, { gwTable: table }).get(1).gws[0];
  assert.equal(gw.xpts, 3);
  assert.equal(gw.estimated, false);
});

test('without the live table, rates come from season totals over his club\'s matches, flagged estimated', () => {
  // 6 starts in club 1's 8 matches, 36 points: 4.5 a gameweek, i.e. the
  // per-gameweek average with no second minutes factor.
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 36, minutes: 540, starts: 6 })]);
  const gw = project(season, ctx).get(1).gws[0];
  assert.equal(gw.xpts, 4.5);
  assert.equal(gw.estimated, true);
});

test('without the live table, a match still to be played in a live gameweek is not counted against him', () => {
  // GW8 is under way and club 1 has not played yet: planning is for GW9, and
  // his totals hold the 7 matches played so far, all of which he started.
  const fixtures = [...homeRun(1, 7, true), ...homeRun(8, 14, false)];
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 42, minutes: 630, starts: 7 })], fixtures);
  assert.equal(project(season, ctx).get(1).gws[0].pZero, 0);
});

test('an ever-present starter has almost no chance of a blank at any price', () => {
  // The price-shrunk start rate gave a cheap ever-present starter a ~29% blank.
  const { season, ctx } = league([
    rawPlayer(1, 1, 'DEF', { now_cost: 40, total_points: 32, minutes: 720, starts: 8 }),
    rawPlayer(2, 1, 'MID', { now_cost: 130, total_points: 64, minutes: 720, starts: 8 }),
  ]);
  for (const gwTable of [liveTable({ 1: played(8, 4), 2: played(8, 8) }), null]) {
    const projections = project(season, ctx, { gwTable });
    for (const id of [1, 2]) assert.ok(projections.get(id).gws[0].pZero < 0.05);
  }
});

test('pStart and p60 come from his start rate and completion, flagged approximate', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 24, minutes: 240, starts: 4 })]);
  // Four starts of 60 minutes in eight gameweeks.
  const table = liveTable({ 1: [[60, 6], [0, 0], [60, 6], [0, 0], [60, 6], [0, 0], [60, 6], [0, 0]] });
  const gw = project(season, ctx, { gwTable: table }).get(1).gws[0];
  assert.equal(gw.pStart, 0.5);
  assert.ok(Math.abs(gw.p60 - 0.5 * (240 / (4 * 90))) < 1e-12);
  assert.equal(gw.p60Approx, true);
  assert.equal(gw.pP90, null);
});

// ─── Blanks and doubles ──────────────────────────────────────────────────────

test('a blank gameweek projects exactly 0, with no chance of minutes', () => {
  const fixtures = [...homeRun(1, 8, true), ...homeRun(9, 9, false), ...homeRun(11, 14, false)];
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 48, minutes: 720, starts: 8 })], fixtures);
  const gw10 = project(season, ctx, { gwTable: liveTable({ 1: played(8) }) }).get(1).gws[1];
  assert.deepEqual([gw10.gw, gw10.fixtures, gw10.xpts, gw10.pZero, gw10.xptsIfPlays], [10, 0, 0, 1, 0]);
});

test('a double against identical opponents projects exactly 1.9x a single', () => {
  // The real scorer, on a league where clubs 1-4 have no record, so every
  // fixture of club 1 scores the same: the double must not also carry DGW_UPLIFT.
  const season = syntheticSeason({ playedGws: 8,
    fixtures: [[9, 1, 4], [10, 1, 2], [10, 1, 3], ...homeRun(11, 14, false)],
    players: [rawPlayer(1, 1, 'MID', { total_points: 48, minutes: 720, starts: 8 })] });
  const projections = buildProjections(season.players, buildScoreContext(season),
    { planningGw: PLANNING_GW, horizonGws: 6, gwTable: null });
  const [single, double] = projections.get(1).gws;
  assert.ok(single.xpts > 0);
  assert.ok(Math.abs(double.xpts / single.xpts - 1.9) < 1e-9, `double/single = ${double.xpts / single.xpts}`);
});

test('a 50% doubt who is nailed when fit has a 50% chance of no minutes in a double', () => {
  // Availability is shared across both fixtures; selection is per fixture.
  const fixtures = [...homeRun(1, 8, true), [9, 1, 2], [9, 1, 3], ...homeRun(10, 14, false)];
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', {
    status: 'd', chance_of_playing_next_round: 50, total_points: 48, minutes: 720, starts: 8 })], fixtures);
  const gw = project(season, ctx, { gwTable: liveTable({ 1: played(8) }) }).get(1).gws[0];
  assert.equal(gw.fixtures, 2);
  assert.equal(gw.pZero, 0.5);
});

test('points from a past double count per fixture, not as one big appearance', () => {
  // 10 a match, and 19 in the GW5 double: 10 a fixture at the 1.9x count.
  const fixtures = [...homeRun(1, 4, true), [5, 1, 2, true], [5, 1, 3, true],
    ...homeRun(6, 8, true), ...homeRun(9, 14, false)];
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 89, minutes: 810, starts: 9 })], fixtures);
  const table = liveTable({ 1: [...played(4, 10), [180, 19], ...played(3, 10)] });
  const gw = project(season, ctx, { gwTable: table }).get(1).gws[0];
  assert.ok(Math.abs(gw.xpts - 10) < 1e-9, `xpts ${gw.xpts}`);
});

// ─── Availability over the horizon (P7) ──────────────────────────────────────

test('an injured nailed starter keeps a positive expected score if he plays', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', {
    status: 'i', chance_of_playing_next_round: 0, total_points: 36, minutes: 540, starts: 6 })]);
  const gw = project(season, ctx, { gwTable: liveTable({ 1: [...played(6), ...missed(2)] }) }).get(1).gws[0];
  assert.equal(gw.xpts, 0);
  assert.equal(gw.pZero, 1);
  assert.equal(gw.xptsIfPlays, 6);
});

test('a 25% flag this gameweek is not carried flat to GW+4', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'FWD', {
    status: 'd', chance_of_playing_next_round: 25, total_points: 48, minutes: 720, starts: 8 })]);
  const gws = project(season, ctx, { gwTable: liveTable({ 1: played(8) }) }).get(1).gws;
  const available = gws.map(g => 1 - g.pZero);   // he is nailed when fit
  assert.equal(available[0], 0.25);
  assert.equal(gws[0].availabilitySource, 'fpl');
  const carry = DECISION_ENGINE.absenceCarryOver.doubtful;
  assert.ok(Math.abs(available[3] - (1 - 0.75 * carry ** 3)) < 1e-12, `GW+4 ${available[3]}`);
  assert.equal(gws[3].availabilitySource, 'recovery');
  for (let k = 1; k < gws.length; k++) assert.ok(available[k] >= available[k - 1]);
});

test('each projection carries the availability it was built from, apart from rotation', () => {
  // The decision engine's dead-slot and hold rules need it: a player who is
  // often left out is not an injured one.
  const alternate = [[90, 6], [0, 0], [90, 6], [0, 0], [90, 6], [0, 0], [90, 6], [0, 0]];
  const { season, ctx } = league([
    rawPlayer(1, 1, 'MID', { status: 'd', chance_of_playing_next_round: 25, total_points: 24, minutes: 360, starts: 4 }),
    rawPlayer(2, 1, 'MID', { total_points: 24, minutes: 360, starts: 4 }),
  ]);
  const projections = project(season, ctx, { gwTable: liveTable({ 1: alternate, 2: alternate }) });
  const doubt = projections.get(1).gws;
  assert.equal(doubt[0].availability, 0.25);
  const carry = DECISION_ENGINE.absenceCarryOver.doubtful;
  assert.ok(Math.abs(doubt[3].availability - (1 - 0.75 * carry ** 3)) < 1e-12);
  const rotation = projections.get(2).gws[0];
  assert.equal(rotation.availability, 1);
  assert.equal(rotation.pZero, 0.5);
});

test('a flagged team-mate\'s chance recovers in his club\'s channel read as well', () => {
  // channel.js scales a club's attacking share by each attacker's chance of
  // playing, read from ctx.playersByTeamId - inside every fixture score.
  const { season, ctx: base } = league([
    rawPlayer(1, 1, 'FWD', { status: 'd', chance_of_playing_next_round: 25, total_points: 48, minutes: 720, starts: 8 }),
    rawPlayer(2, 1, 'FWD', { total_points: 40, minutes: 720, starts: 8 }),
  ]);
  const signature = { time: '720', xGChain: '6', xGBuildup: '1', xA: '1', npxG: '4' };
  const ctx = { ...base, understatPlayersByName: { 'player 1': signature, 'player 2': signature } };
  const roles = { 1: 'ST', 2: 'ST' };
  const boxThreatByGw = new Map();
  const spy = (player, horizon, ctxForGw) => {
    if (player.id === 2) {
      boxThreatByGw.set(ctxForGw.currentGw,
        channelPersonnelFactor(ctxForGw.playersByTeamId[1], roles, 'boxThreat', ctxForGw));
    }
    return neutralScorer();
  };
  project(season, ctx, { scorePlayerFn: spy });
  assert.ok(boxThreatByGw.get(PLANNING_GW) < 0.9, `GW+1 ${boxThreatByGw.get(PLANNING_GW)}`);
  assert.ok(boxThreatByGw.get(PLANNING_GW + 3) > 0.95, `GW+4 ${boxThreatByGw.get(PLANNING_GW + 3)}`);
});

test('a suspension clears after a gameweek; a player who has left never comes back', () => {
  const { season, ctx } = league([
    rawPlayer(1, 1, 'DEF', { status: 's', chance_of_playing_next_round: 0, total_points: 32, minutes: 720, starts: 8 }),
    rawPlayer(2, 1, 'DEF', { status: 'u', chance_of_playing_next_round: 0, total_points: 32, minutes: 720, starts: 8 }),
  ]);
  const projections = project(season, ctx, { gwTable: liveTable({ 1: played(8, 4), 2: played(8, 4) }) });
  assert.deepEqual(projections.get(1).gws.map(g => g.pZero), [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(projections.get(2).gws.map(g => g.pZero), [1, 1, 1, 1, 1, 1]);
});

// ─── Rates that an absence does not drag (P8) ────────────────────────────────

test('a nailed premium back from injury projects at GW+4 within 10% of his pre-injury rate', () => {
  // 10 a gameweek until he was hurt in GW7; flagged 75% now, so fit by GW+3.
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { now_cost: 125,
    status: 'd', chance_of_playing_next_round: 75, total_points: 60, minutes: 540, starts: 6 })]);
  const table = liveTable({ 1: [...played(6, 10), ...missed(2)] });
  const gw4 = project(season, ctx, { gwTable: table }).get(1).gws[3];
  assert.ok(gw4.xpts >= 9, `GW+4 xpts ${gw4.xpts}`);
});

test('an injury spell he has since played through does not drag his rate', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 36, minutes: 540, starts: 6 })]);
  const table = liveTable({ 1: [...played(3), ...missed(2), ...played(3)] });
  const gw = project(season, ctx, { gwTable: table }).get(1).gws[0];
  assert.equal(gw.pZero, 0);
  assert.equal(gw.xpts, 6);
});

test('a fit player left out of the last three gameweeks has those zeros counted', () => {
  // Not flagged, so the run is a dropping, not an injury.
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 30, minutes: 450, starts: 5 })]);
  const table = liveTable({ 1: [...played(5), ...missed(3)] });
  assert.equal(project(season, ctx, { gwTable: table }).get(1).gws[0].xpts, 3.75);
});

test('a single missed gameweek is not excused as an injury', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 42, minutes: 630, starts: 7 })]);
  const table = liveTable({ 1: [...played(4), ...missed(1), ...played(3)] });
  assert.equal(project(season, ctx, { gwTable: table }).get(1).gws[0].xpts, 6 * 7 / 8);
});

test('a gameweek his club did not play is not held against him', () => {
  const fixtures = [...homeRun(1, 3, true), ...homeRun(5, 8, true), ...homeRun(9, 14, false)];
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 42, minutes: 630, starts: 7 })], fixtures);
  const table = liveTable({ 1: [...played(3), [0, 0], ...played(4)] });
  assert.equal(project(season, ctx, { gwTable: table }).get(1).gws[0].pZero, 0);
});

test('with too few contention gameweeks his price prior stands in, flagged estimated', () => {
  const { season, ctx } = league([rawPlayer(1, 1, 'MID', { total_points: 12, minutes: 180, starts: 2 })]);
  const gw = project(season, ctx, { gwTable: liveTable({ 1: played(2) }, 7) }).get(1).gws[0];
  const prior = calcPlaytimeSecurity(season.playersById[1], ctx).prior;
  assert.ok(Math.abs((1 - gw.pZero) - prior) < 1e-12);
  assert.equal(gw.estimated, true);
});

// ─── Contract ────────────────────────────────────────────────────────────────

test('projections are identical whether or not an element-summary is loaded', () => {
  // P6: a loaded summary used to switch the estimator for that one player.
  const { season, ctx } = league([
    rawPlayer(1, 1, 'MID', { total_points: 36, minutes: 540, starts: 6 }),
    rawPlayer(2, 2, 'FWD', { total_points: 20, minutes: 300, starts: 3 }),
  ]);
  const history = Array.from({ length: 8 }, (_, i) => ({
    gw: i + 1, minutes: 90, points: 12, xG: 0.9, xA: 0.4, cleanSheet: false,
  }));
  const opts = { planningGw: PLANNING_GW, horizonGws: 6, gwTable: null };
  const withSummary = buildProjections(season.players,
    { ...ctx, playerSummariesById: { 1: { history, historyPast: [], upcoming: [] } } }, opts);
  assert.deepEqual(withSummary, buildProjections(season.players, ctx, opts));
});

test('xpts = (1 - pZero) x xptsIfPlays for every projection', () => {
  const fixtures = [...homeRun(1, 8, true), [9, 1, 2], [9, 1, 3], ...homeRun(11, 14, false), [10, 2, 3]];
  const { season, ctx } = league([
    rawPlayer(1, 1, 'MID', { total_points: 48, minutes: 720, starts: 8 }),
    rawPlayer(2, 1, 'FWD', { total_points: 24, minutes: 360, starts: 4 }),
    rawPlayer(3, 1, 'DEF', { status: 'd', chance_of_playing_next_round: 25, total_points: 20, minutes: 540, starts: 6 }),
    rawPlayer(4, 1, 'MID', { status: 'i', chance_of_playing_next_round: 0, total_points: 30, minutes: 450, starts: 5 }),
    rawPlayer(5, 2, 'GKP', { total_points: 0, minutes: 0, starts: 0 }),
    rawPlayer(6, 3, 'DEF', { status: 'u', chance_of_playing_next_round: 0, total_points: 10, minutes: 270, starts: 3 }),
  ], fixtures);
  const table = liveTable({
    1: played(8), 2: [[90, 6], [0, 0], [90, 6], [0, 0], [90, 6], [0, 0], [90, 6], [0, 0]],
    3: [...played(6, 3), ...missed(2)], 4: [...played(5), ...missed(3)], 5: missed(8),
  });
  for (const gwTable of [table, null]) {
    for (const scorePlayerFn of [undefined, neutralScorer]) {
      const projections = buildProjections(season.players, ctx,
        { planningGw: PLANNING_GW, horizonGws: 6, gwTable, scorePlayerFn });
      for (const { playerId, gws } of projections.values()) {
        for (const g of gws) {
          assert.ok(Math.abs(g.xpts - (1 - g.pZero) * g.xptsIfPlays) < 1e-12,
            `player ${playerId} GW${g.gw}: ${g.xpts} vs ${(1 - g.pZero) * g.xptsIfPlays}`);
          assert.ok(g.pZero >= 0 && g.pZero <= 1 && g.pStart <= 1 - g.pZero + 1e-12);
        }
      }
    }
  }
});
