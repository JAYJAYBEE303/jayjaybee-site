/**
 * tests/tools/understat-compat.test.js
 * The Understat-shape league payloads rebuilt from vaastav results CSVs
 * (tools/understat-compat). Pure-function tests plus invariants on the
 * committed data files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLeagueCompat } from '../../tools/understat-compat/lib.js';

const TEAMS = 'id,name\n1,Arsenal\n2,Man City\n';
const FIXTURES =
  'event,finished,kickoff_time,team_h,team_h_score,team_a,team_a_score\n'
  + '1,True,2021-08-13T19:00:00Z,1,2,2,0\n'
  + '2,False,2021-08-20T14:00:00Z,2,,1,\n';

test('played fixture becomes an Understat-shaped datesData row', () => {
  const out = buildLeagueCompat(TEAMS, FIXTURES);
  assert.deepEqual(out.datesData, [{
    isResult: true,
    datetime: '2021-08-13 19:00:00',
    h: { title: 'Arsenal' },
    a: { title: 'Man City' },
    goals: { h: 2, a: 0 },
  }]);
});

test('unplayed rows are dropped, never read as 0-0', () => {
  const out = buildLeagueCompat(TEAMS, FIXTURES);
  assert.equal(out.datesData.length, 1);
  assert.equal(out.teamsData['1'].history.length, 1);
});

test('each club gets history from its own end', () => {
  const out = buildLeagueCompat(TEAMS, FIXTURES);
  assert.deepEqual(out.teamsData['1'], {
    id: '1', title: 'Arsenal',
    history: [{ date: '2021-08-13 19:00:00', h_a: 'h', scored: 2, missed: 0 }],
  });
  assert.deepEqual(out.teamsData['2'].history[0],
    { date: '2021-08-13 19:00:00', h_a: 'a', scored: 0, missed: 2 });
});

test('playersData is an empty array and no row carries an id', () => {
  const out = buildLeagueCompat(TEAMS, FIXTURES);
  assert.deepEqual(out.playersData, []);
  assert.ok(out.datesData.every(row => !('id' in row)));
});

test('history and datesData are sorted by datetime ascending', () => {
  const unsorted = FIXTURES + '3,True,2021-08-01T12:00:00Z,2,1,1,1\n';
  const out = buildLeagueCompat(TEAMS, unsorted);
  assert.deepEqual(out.datesData.map(r => r.datetime),
    ['2021-08-01 12:00:00', '2021-08-13 19:00:00']);
  assert.deepEqual(out.teamsData['1'].history.map(r => r.date),
    ['2021-08-01 12:00:00', '2021-08-13 19:00:00']);
});
