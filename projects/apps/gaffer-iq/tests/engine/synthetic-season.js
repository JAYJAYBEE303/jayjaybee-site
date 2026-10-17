/**
 * tests/engine/synthetic-season.js
 * Test utility (not a test file): a small league built from FPL-shaped raw
 * payloads and passed through the real normaliseSeason, so tests can run the
 * real scorer on a real context.
 *
 * Every club is identical - same strengths, same fixture difficulty, no
 * top-flight history - so a fixture's score depends only on venue and on how
 * many fixtures a club plays. Clubs 5 and 6 play every finished round between
 * themselves: that gives the league elapsed gameweeks without giving clubs 1-4
 * any form, venue or head-to-head record that would make their fixtures differ.
 */

import { normaliseSeason } from '../../js/engine/normalise.js';

const CLUB_IDS = [1, 2, 3, 4, 5, 6];
const ELEMENT_TYPE = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };
const DAY_MS = 24 * 60 * 60 * 1000;

function rawClub(id) {
  return {
    id, code: id, name: `Club ${id}`, short_name: `C${id}`,
    strength: 3,
    strength_overall_home: 1150, strength_overall_away: 1150,
    strength_attack_home: 1150, strength_attack_away: 1150,
    strength_defence_home: 1150, strength_defence_away: 1150,
  };
}

/**
 * One bootstrap element. Defaults to a fit £6.0m player with no record.
 * @param {number} id
 * @param {number} club
 * @param {'GKP'|'DEF'|'MID'|'FWD'} position
 * @param {object} [overrides]  raw FPL fields, e.g. { total_points, minutes, starts }
 */
export function rawPlayer(id, club, position, overrides = {}) {
  return {
    id, team: club, element_type: ELEMENT_TYPE[position],
    web_name: `P${id}`, first_name: 'Player', second_name: String(id),
    now_cost: 60, status: 'a', chance_of_playing_next_round: null,
    total_points: 0, minutes: 0, starts: 0, selected_by_percent: '1.0',
    ...overrides,
  };
}

/**
 * @param {object} o
 * @param {number} o.playedGws   rounds already finished (clubs 5 v 6 in each)
 * @param {Array<[number, number, number, boolean?]>} o.fixtures  more fixtures as
 *   [gw, home, away, played] - unplayed unless the fourth element is true
 * @param {object[]} o.players   rawPlayer() records
 * @returns {object}  normaliseSeason output
 */
export function syntheticSeason({ playedGws, fixtures, players }) {
  const kickoff = gw => new Date(Date.UTC(2026, 7, 1) + gw * 7 * DAY_MS).toISOString();
  const rawFixtures = [];
  const add = (gw, home, away, played) => rawFixtures.push({
    id: rawFixtures.length + 1, event: gw, team_h: home, team_a: away,
    kickoff_time: kickoff(gw), started: played, finished: played, finished_provisional: played,
    team_h_score: played ? 1 : null, team_a_score: played ? 1 : null,
    team_h_difficulty: 3, team_a_difficulty: 3,
  });

  for (let gw = 1; gw <= playedGws; gw++) add(gw, gw % 2 ? 5 : 6, gw % 2 ? 6 : 5, true);
  for (const [gw, home, away, played = false] of fixtures) add(gw, home, away, played);

  const lastGw = Math.max(playedGws + 1, ...fixtures.map(([gw]) => gw));
  const events = [];
  for (let gw = 1; gw <= lastGw; gw++) {
    events.push({
      id: gw, deadline_time: kickoff(gw), finished: gw <= playedGws, data_checked: gw <= playedGws,
      is_current: gw === playedGws, is_next: gw === playedGws + 1, average_entry_score: 0,
    });
  }

  return normaliseSeason(
    { teams: CLUB_IDS.map(rawClub), elements: players, events, element_types: [] },
    rawFixtures,
  );
}
