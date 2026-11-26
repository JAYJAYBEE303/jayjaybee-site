/**
 * tests/engine/fpl-league.test.js
 * engine/fpl-league.js: the FPL-derived stand-in for the live season's
 * Understat league payload, and the consumers that must accept it unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFplLeaguePayload } from '../../js/engine/fpl-league.js';
import { buildScoreContext } from '../../js/engine/composite.js';
import { collectUnderstatMeetings } from '../../js/engine/h2h.js';
import { buildRollingVenueStatsByTeamId } from '../../js/engine/fixtures.js';
import { calcPlayerForm } from '../../js/engine/form.js';
import { syntheticSeason, rawPlayer } from './synthetic-season.js';

// Clubs 5 and 6 play every finished round; gw1's home side is club 5, gw2's is 6.
const PLAYERS = [
  rawPlayer(1, 1, 'MID', { minutes: 900, starts: 10, expected_goals: '3.0', expected_assists: '1.5' }),
  rawPlayer(2, 1, 'DEF', { minutes: 0 }),
];
const seasonWith = (extra = {}) =>
  syntheticSeason({ playedGws: 3, fixtures: [[4, 1, 2]], players: PLAYERS, ...extra });

test('only played fixtures become results', () => {
  const season = seasonWith();
  // A match in progress carries a running score but is not a result.
  season.fixtures.push({ ...season.fixtures[0], id: 999, played: false, started: true });
  assert.equal(buildFplLeaguePayload(season).datesData.length, 3);
});

test('payload is flagged synthetic and no row carries an id', () => {
  const out = buildFplLeaguePayload(seasonWith());
  assert.equal(out.synthetic, true);
  assert.ok(out.datesData.every(row => row.isResult === true && !('id' in row)));
});

test("history is built from each club's own end", () => {
  const out = buildFplLeaguePayload(seasonWith());
  assert.equal(out.teamsData['5'].title, 'Club 5');
  assert.equal(out.teamsData['5'].history[0].h_a, 'h');
  assert.equal(out.teamsData['6'].history[0].h_a, 'a');
  assert.deepEqual(out.teamsData['1'].history, []);
});

test('datetime is zone-less UTC', () => {
  const out = buildFplLeaguePayload(seasonWith());
  assert.match(out.datesData[0].datetime, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(out.datesData[0].datetime, '2026-08-08 00:00:00');
});

test('playersData only carries players with minutes', () => {
  const out = buildFplLeaguePayload(seasonWith());
  assert.deepEqual(out.playersData,
    [{ player_name: 'Player 1', time: 900, xG: 3, xA: 1.5 }]);
});

test('an empty season yields empty arrays and a usable context', () => {
  const season = syntheticSeason({ playedGws: 0, fixtures: [[1, 1, 2]], players: [] });
  const out = buildFplLeaguePayload(season);
  assert.deepEqual(out.datesData, []);
  assert.deepEqual(out.playersData, []);
  assert.ok(Object.values(out.teamsData).every(t => t.history.length === 0));
  assert.doesNotThrow(() => buildScoreContext(season, { leagueXg: out }));
});

test('existing consumers accept it unchanged', () => {
  const season = seasonWith();
  const leagueXg = buildFplLeaguePayload(season);

  const meetings = collectUnderstatMeetings(5, 6, { teamsById: season.teamsById, leagueXg });
  assert.equal(meetings.length, 3);

  const venue = buildRollingVenueStatsByTeamId(leagueXg, null, season.teamsById)[5];
  assert.equal(venue.homeGames, 2);
  assert.equal(venue.awayGames, 1);

  const ctx = buildScoreContext(season, { leagueXg });
  const form = calcPlayerForm(season.playersById[1], ctx);
  assert.equal(form.xgSource, 'understat');
  assert.equal(form.xgEstimated, false);
});
