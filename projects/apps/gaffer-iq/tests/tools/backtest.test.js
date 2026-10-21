/**
 * tests/tools/backtest.test.js
 * The point-in-time season the offline tools replay (tools/backtest/history.js,
 * plan Phase 6b): vaastav's CSVs read and typed, and every figure a planning
 * gameweek sees taken from before it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSeason, totalsBefore, gwTablesBefore, actualPoints, fixturesIn, rawSeasonAt, scheduleAt,
} from '../../tools/backtest/history.js';
import { normaliseSeason } from '../../js/engine/normalise.js';

const TEAMS = 'id,name,short_name,code\n1,Arsenal,ARS,3\n2,Chelsea,CHE,8\n';
const FIXTURES = 'id,event,kickoff_time,team_h,team_a,team_h_score,team_a_score,finished\n'
  + '10,1,2025-08-16T14:00:00Z,1,2,2,0,True\n'
  + '20,2,2025-08-23T14:00:00Z,2,1,1,1,True\n'
  + '30,3,2025-08-30T14:00:00Z,1,2,0,3,True\n'
  + '31,3,2025-09-02T19:00:00Z,2,1,1,0,True\n';
const HEADER = 'name,position,team,element,fixture,opponent_team,was_home,GW,minutes,starts,total_points,goals_scored,'
  + 'assists,clean_sheets,goals_conceded,saves,bonus,yellow_cards,red_cards,own_goals,penalties_saved,penalties_missed,'
  + 'expected_goals,expected_assists,expected_goals_conceded,defensive_contribution,value,xP';
// A striker who scores in GW1, moves club before GW3 (where his new club plays twice); an AM row that is not a player.
const ROWS = [
  'Striker,FWD,Arsenal,7,10,2,True,1,90,1,9,1,1,0,0,0,3,0,0,0,0,0,0.8,0.3,0.4,2,75,5.1',
  'Striker,FWD,Arsenal,7,20,2,False,2,80,1,2,0,0,0,1,0,0,1,0,0,0,0,0.4,0.1,1.1,1,76,4.0',
  'Striker,FWD,Chelsea,7,30,1,False,3,30,0,1,0,0,0,0,0,0,0,0,0,0,0,0.1,0.0,0.0,0,74,3.2',
  'Striker,FWD,Chelsea,7,31,1,True,3,90,1,6,1,0,0,0,0,1,0,0,0,0,0,0.6,0.0,0.2,3,74,3.2',
  'Keeper,GK,Chelsea,9,10,1,False,1,90,1,1,0,0,0,2,4,0,0,0,0,0,0,0,0,1.9,0,45,2.0',
  'Coach,AM,Chelsea,99,10,1,False,1,0,0,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,10,0',
];
const season = () => parseSeason({ teams: TEAMS, fixtures: FIXTURES, mergedGw: [HEADER, ...ROWS].join('\n') });

test('rows are typed: clubs by id, keepers as GKP, and anything that is not a player dropped', () => {
  const s = season();
  assert.equal(s.rows.length, 5);
  const first = s.rows[0];
  assert.deepEqual([first.teamId, first.opponentId, first.home, first.gw, first.priceTenths, first.xg],
    [1, 2, true, 1, 75, 0.8]);
  assert.equal(s.rows.find(r => r.element === 9).position, 'GKP');
  assert.deepEqual(s.teams.map(t => [t.id, t.code]), [[1, 3], [2, 8]]);
  assert.deepEqual(s.fixtures.find(f => f.id === 30), { id: 30, gw: 3, kickoff: '2025-08-30T14:00:00Z', home: 1, away: 2,
    homeGoals: 0, awayGoals: 3, homeDifficulty: 0, awayDifficulty: 0 });
});

test('his totals before a planning GW hold nothing from it or later; his club and price are his at it', () => {
  const at3 = totalsBefore(season(), 3).get(7);
  assert.equal(at3.minutes, 170);
  assert.equal(at3.goals, 1);
  assert.equal(at3.points, 11);
  assert.ok(Math.abs(at3.xg - 1.2) < 1e-12);
  assert.ok(Math.abs(at3.xgc - 1.5) < 1e-12);
  assert.equal(at3.yellows, 1);
  assert.equal(at3.appearances, 2);
  assert.deepEqual([at3.teamId, at3.priceTenths], [2, 74]);
  // At GW1 there is no record yet, but he has a club and a price.
  const at1 = totalsBefore(season(), 1).get(7);
  assert.deepEqual([at1.minutes, at1.points, at1.teamId, at1.priceTenths], [0, 0, 1, 75]);
  // Past the season his last club and price stand.
  assert.deepEqual([totalsBefore(season(), 39).get(7).teamId, totalsBefore(season(), 39).get(7).minutes], [2, 290]);
});

test('the minutes tables before a planning GW are the snapshots\' shape, a double summed', () => {
  const tables = gwTablesBefore(season(), 4);
  assert.deepEqual(tables.map(t => t.gw), [1, 2, 3]);
  assert.deepEqual(tables[2].players.find(p => p.playerId === 7), { playerId: 7, minutes: 120, points: 7, starts: 1 });
  assert.deepEqual(gwTablesBefore(season(), 2).map(t => t.gw), [1]);
});

test('actual points per player per GW, a double summed, and the fixtures of a window', () => {
  const actual = actualPoints(season());
  assert.equal(actual.get(7).get(3), 7);
  assert.equal(actual.get(9).get(1), 1);
  assert.deepEqual(fixturesIn(season(), 2, 3).map(f => f.id), [20, 30, 31]);
});

// ─── The season as FPL would have served it at a planning GW ─────────────────

test('rawSeasonAt serves the season as it stood: results before the planning GW only, totals from before it', () => {
  const { bootstrap, fixtures } = rawSeasonAt(season(), 3);
  const s = normaliseSeason(bootstrap, fixtures);
  assert.deepEqual(s.fixtures.filter(f => f.played).map(f => f.id), [10, 20]);
  assert.deepEqual(s.fixtures.find(f => f.id === 30).result, null);
  assert.deepEqual(s.fixtures.find(f => f.id === 10).result, { homeGoals: 2, awayGoals: 0 });
  assert.equal(s.upcomingGw, 3);
  const striker = s.playersById[7];
  assert.deepEqual([striker.teamId, striker.price, striker.position, striker.status, striker.chanceOfPlayingNext],
    [2, 7.4, 'FWD', 'available', null]);
  assert.deepEqual([striker.totals.minutes, striker.totals.points, striker.totals.goals, striker.totals.yellowCards],
    [170, 11, 1, 1]);
  assert.ok(Math.abs(striker.totals.xG - 1.2) < 1e-12 && Math.abs(striker.totals.xGC - 1.5) < 1e-12);
  // No end-of-season ratings unless asked for: every club and fixture reads neutral.
  assert.deepEqual(new Set(s.fixtures.map(f => `${f.fplDifficulty.home}/${f.fplDifficulty.away}`)), new Set(['3/3']));
  assert.deepEqual(new Set(s.teams.map(t => t.strength.overall)), new Set([3]));
});

test('with hindsight, rawSeasonAt uses vaastav\'s end-of-season difficulty ratings and club strengths', () => {
  const fixturesCsv = FIXTURES.replace('finished\n', 'finished,team_h_difficulty,team_a_difficulty\n')
    .replace(/True\n/g, 'True,2,4\n');
  const teamsCsv = 'id,name,short_name,code,strength\n1,Arsenal,ARS,3,5\n2,Chelsea,CHE,8,4\n';
  const s = parseSeason({ teams: teamsCsv, fixtures: fixturesCsv, mergedGw: [HEADER, ...ROWS].join('\n') });
  const raw = rawSeasonAt(s, 3, { hindsight: true });
  assert.deepEqual([raw.fixtures[0].team_h_difficulty, raw.fixtures[0].team_a_difficulty], [2, 4]);
  assert.deepEqual(raw.bootstrap.teams.map(team => team.strength), [5, 4]);
});

// ─── The schedule as it stood (Phase 7) ──────────────────────────────────────

test('a fixture sits in its original GW (from its id order) until that GW passes without it or its new GW arrives', () => {
  // Two clubs, so one fixture a GW: ids 10, 20, 30, 31 were GWs 1-4, and 31 was brought forward into GW3.
  const s = season();
  assert.deepEqual([...scheduleAt(s, 2)], [[10, 1], [20, 2], [30, 3], [31, 4]]);
  assert.deepEqual(scheduleAt(s, 3).get(31), 3);
  // Id 2 was GW2's, postponed into GW3: GW2 blanks only once it has come.
  const postponed = parseSeason({
    teams: TEAMS,
    fixtures: 'id,event,kickoff_time,team_h,team_a,team_h_score,team_a_score\n'
      + '1,1,2025-08-16T14:00:00Z,1,2,1,0\n2,3,2025-08-26T19:00:00Z,2,1,0,0\n3,3,2025-08-30T14:00:00Z,1,2,2,2\n',
    mergedGw: [HEADER, ...ROWS].join('\n'),
  });
  assert.deepEqual([scheduleAt(postponed, 2).get(2), scheduleAt(postponed, 3).get(2), scheduleAt(postponed, 4).get(2)], [2, 3, 3]);
  // Postponed from GW2 to GW4: between the two it has no date (its new one was not yet known).
  const gap = parseSeason({
    teams: TEAMS,
    fixtures: 'id,event,kickoff_time,team_h,team_a,team_h_score,team_a_score\n'
      + '1,1,2025-08-16T14:00:00Z,1,2,1,0\n2,4,2025-09-16T19:00:00Z,2,1,0,0\n'
      + '3,3,2025-08-30T14:00:00Z,1,2,2,2\n4,4,2025-09-13T14:00:00Z,2,1,1,1\n',
    mergedGw: [HEADER, ...ROWS].join('\n'),
  });
  assert.deepEqual([2, 3, 4, 5].map(t => scheduleAt(gap, t).get(2)), [2, null, 4, 4]);
  const undated = rawSeasonAt(gap, 3, { schedule: 'asItStood' }).fixtures.find(f => f.id === 2);
  assert.deepEqual([undated.event, undated.finished, undated.team_h_score], [null, false, null]);
});

test('rawSeasonAt serves the schedule as it stood when asked, and the final one by default', () => {
  const s = season();
  const at = (gw, schedule) => rawSeasonAt(s, gw, { schedule }).fixtures.find(f => f.id === 31);
  assert.deepEqual([at(2, 'asItStood').event, at(2).event, at(3, 'asItStood').event], [4, 3, 3]);
  const moved = rawSeasonAt(s, 4, { schedule: 'asItStood' }).fixtures.find(f => f.id === 31);
  assert.deepEqual([moved.event, moved.finished, moved.team_h_score], [3, true, 1]);
  assert.throws(() => rawSeasonAt(s, 2, { schedule: 'later' }), /schedule/);
});

test('each row keeps how many managers owned him at that GW', () => {
  const header = `${HEADER},selected`;
  const s = parseSeason({ teams: TEAMS, fixtures: FIXTURES, mergedGw: [header, `${ROWS[0]},123456`].join('\n') });
  assert.equal(s.rows[0].selected, 123456);
  assert.equal(season().rows[0].selected, 0);
});
