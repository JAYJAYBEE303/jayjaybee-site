/**
 * tools/backtest/history.js
 * The point-in-time season the offline tools replay (docs/decision-engine-plan.md,
 * Phase 6b, and later Phase 7): vaastav's CSVs (github.com/vaastav/Fantasy-Premier-League,
 * fetched by download.js into the gitignored data/ folder) read and typed, and
 * every figure a planning gameweek sees taken from before it - his totals from
 * earlier gameweeks only, his club and price as they stood at it.
 *
 * vaastav's players_raw.csv and teams.csv hold end-of-season values (totals,
 * prices, strengths), so nothing here reads them but a club's id, name and code.
 * Its fixtures.csv is the season's final schedule: a fixture postponed and
 * moved into a double sits in its final gameweek from the start, so every
 * planning gameweek sees the season's blanks and doubles. Harmless when every
 * model replayed sees the same schedule (Phase 6b); the decision backtest
 * (Phase 7) asks for the schedule as it stood (scheduleAt).
 */

import { readFile } from 'node:fs/promises';

import { parseCsv } from '../minutes/lib.js';

export const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];

// vaastav writes keepers as GK; anything else (2024-25's assistant managers, AM) is not a player.
const POSITIONS = { GK: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD' };

// merged_gw.csv column -> the per-fixture figure it holds.
const COUNTS = {
  minutes: 'minutes', starts: 'starts', points: 'total_points', goals: 'goals_scored', assists: 'assists',
  cleanSheets: 'clean_sheets', goalsConceded: 'goals_conceded', saves: 'saves', bonus: 'bonus',
  yellows: 'yellow_cards', reds: 'red_cards', ownGoals: 'own_goals', penSaved: 'penalties_saved',
  penMissed: 'penalties_missed', xg: 'expected_goals', xa: 'expected_assists', xgc: 'expected_goals_conceded',
  defcon: 'defensive_contribution',
};

const number = value => (value === undefined || value === '' || value === 'None' ? 0 : Number(value));

// teams.csv's club ratings, as bootstrap-static names them.
const STRENGTHS = ['strength', 'strength_overall_home', 'strength_overall_away', 'strength_attack_home',
  'strength_attack_away', 'strength_defence_home', 'strength_defence_away'];
// Without hindsight every club and fixture reads as FPL's middle rating.
const NEUTRAL_DIFFICULTY = 3;
const NEUTRAL_STRENGTH = { strength: 3, rating: 1150 };
const ELEMENT_TYPE = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };
// A gameweek's deadline, ahead of its first kickoff.
const DEADLINE_LEAD_MS = 90 * 60 * 1000;

/**
 * One season from its CSV texts.
 * @param {{teams: string, fixtures: string, mergedGw: string}} csv
 * @returns {{teams: object[], fixtures: object[], rows: object[]}}  rows one per player per fixture
 */
export function parseSeason({ teams, fixtures, mergedGw }) {
  const clubs = parseCsv(teams).map(t => ({
    id: Number(t.id), name: t.name, shortName: t.short_name, code: Number(t.code),
    // End-of-season values: read only by rawSeasonAt with hindsight.
    strengths: Object.fromEntries(STRENGTHS.filter(k => t[k] !== undefined).map(k => [k, Number(t[k])])),
  }));
  const idByName = new Map(clubs.map(t => [t.name, t.id]));
  const games = parseCsv(fixtures)
    .filter(f => f.event !== '' && f.event !== 'None')
    .map(f => ({
      id: Number(f.id), gw: Number(f.event), kickoff: f.kickoff_time, home: Number(f.team_h), away: Number(f.team_a),
      homeGoals: number(f.team_h_score), awayGoals: number(f.team_a_score),
      // End-of-season FDR: read only by rawSeasonAt with hindsight.
      homeDifficulty: number(f.team_h_difficulty), awayDifficulty: number(f.team_a_difficulty),
    }))
    .sort((a, b) => a.gw - b.gw || a.kickoff.localeCompare(b.kickoff));
  const rows = [];
  for (const r of parseCsv(mergedGw)) {
    const position = POSITIONS[r.position];
    if (!position) continue;
    const row = {
      element: Number(r.element), name: r.name, position, teamId: idByName.get(r.team),
      opponentId: Number(r.opponent_team), home: r.was_home === 'True', fixture: Number(r.fixture),
      gw: Number(r.GW ?? r.round), priceTenths: Number(r.value), fplXp: number(r.xP),
      // Managers who owned him at that GW's deadline: not a total, so kept out of COUNTS.
      selected: number(r.selected),
    };
    for (const [key, column] of Object.entries(COUNTS)) row[key] = number(r[column]);
    rows.push(row);
  }
  rows.sort((a, b) => a.gw - b.gw || a.fixture - b.fixture);
  return { teams: clubs, fixtures: games, rows };
}

/** One season of tools/backtest/data. */
export async function loadSeason(name, dir = new URL('./data/', import.meta.url)) {
  const read = file => readFile(new URL(`${name}/${file}`, dir), 'utf8');
  const [teams, fixtures, mergedGw] = await Promise.all([read('teams.csv'), read('fixtures.csv'), read('merged_gw.csv')]);
  return { name, ...parseSeason({ teams, fixtures, mergedGw }) };
}

/**
 * Each player's season totals before a planning gameweek, with his club and
 * price as they stood at it (his row at it, else his latest before). A player
 * with no row at or before it was not in the game yet, and is left out.
 *
 * @returns {Map<number, object>}  by element: position, teamId, priceTenths,
 *   appearances and every COUNTS total
 */
export function totalsBefore(season, gw) {
  const totals = new Map();
  for (const r of season.rows) {
    if (r.gw > gw) continue;
    let t = totals.get(r.element);
    if (!t) {
      t = { element: r.element, name: r.name, appearances: 0, ...Object.fromEntries(Object.keys(COUNTS).map(k => [k, 0])) };
      totals.set(r.element, t);
    }
    // Rows run in gameweek order, so the last one at or before gw is where he stands.
    Object.assign(t, { position: r.position, teamId: r.teamId, priceTenths: r.priceTenths });
    if (r.gw === gw) continue;
    for (const key of Object.keys(COUNTS)) t[key] += r[key];
    if (r.minutes > 0) t.appearances++;
  }
  return totals;
}

/** The minutes tables before a planning gameweek, in js/snapshots.js's shape (a double summed). */
export function gwTablesBefore(season, gw) {
  const byGw = new Map();
  for (const r of season.rows) {
    if (r.gw >= gw) continue;
    const players = byGw.get(r.gw) ?? new Map();
    const p = players.get(r.element) ?? { playerId: r.element, minutes: 0, points: 0, starts: 0 };
    p.minutes += r.minutes;
    p.points += r.points;
    p.starts += r.starts;
    players.set(r.element, p);
    byGw.set(r.gw, players);
  }
  return [...byGw].sort(([a], [b]) => a - b).map(([g, players]) => ({ gw: g, players: [...players.values()] }));
}

/** What each player scored in each gameweek (a double summed): Map<element, Map<gw, points>>. */
export function actualPoints(season) {
  const actual = new Map();
  for (const r of season.rows) {
    const byGw = actual.get(r.element) ?? new Map();
    byGw.set(r.gw, (byGw.get(r.gw) ?? 0) + r.points);
    actual.set(r.element, byGw);
  }
  return actual;
}

/** The fixtures of gameweeks from..to, in order. */
export function fixturesIn(season, from, to) {
  return season.fixtures.filter(f => f.gw >= from && f.gw <= to);
}

/**
 * Each fixture's gameweek as the schedule stood before a planning gameweek's
 * deadline. FPL numbers a season's fixtures in their original order, a
 * gameweek's worth at a time (vaastav's seasons bear it out: every fixture out
 * of its original gameweek is a known postponement or move), so a fixture's
 * original gameweek is its place in id order. It sits there until its new
 * gameweek arrives, or until that gameweek passes without it, after which it
 * has no date (null, as FPL shows a postponement) until the new one arrives.
 * That knows less than a manager did: planned blanks and doubles were
 * announced weeks ahead, which the final schedule (rawSeasonAt's default)
 * overstates.
 *
 * @returns {Map<number, number|null>}  fixture id -> gameweek, in id order
 */
export function scheduleAt(season, gw) {
  const perGw = season.teams.length / 2;
  const byId = [...season.fixtures].sort((a, b) => a.id - b.id);
  return new Map(byId.map((f, rank) => {
    const original = Math.floor(rank / perGw) + 1;
    if (gw >= f.gw) return [f.id, f.gw];
    return [f.id, gw > original ? null : original];
  }));
}

/**
 * The season as FPL would have served it before a planning gameweek's
 * deadline: bootstrap-static and fixtures/ JSON, for normaliseSeason. Results
 * only for earlier gameweeks; every player's totals from before it, at his
 * club and price then; everyone available (no history of flags exists).
 * vaastav keeps only end-of-season difficulty ratings and club strengths, so
 * without `hindsight` every fixture and club reads neutral; with it they are
 * the season's final values, which flatter whatever reads them. The schedule
 * is the season's final one unless `schedule` is 'asItStood' (scheduleAt); a
 * fixture shown in its original gameweek keeps its final kickoff time.
 *
 * @returns {{bootstrap: object, fixtures: object[]}}
 */
export function rawSeasonAt(season, gw, { hindsight = false, schedule = 'final' } = {}) {
  if (schedule !== 'final' && schedule !== 'asItStood') throw new Error(`rawSeasonAt: unknown schedule ${schedule}`);
  const gwOf = schedule === 'asItStood' ? scheduleAt(season, gw) : new Map(season.fixtures.map(f => [f.id, f.gw]));
  const teams = season.teams.map(t => ({
    id: t.id, name: t.name, short_name: t.shortName, code: t.code,
    ...Object.fromEntries(STRENGTHS.map(k => [k, hindsight && t.strengths[k] !== undefined
      ? t.strengths[k]
      : (k === 'strength' ? NEUTRAL_STRENGTH.strength : NEUTRAL_STRENGTH.rating)])),
  }));
  const elements = [...totalsBefore(season, gw).values()].map(t => ({
    id: t.element, web_name: t.name, first_name: t.name, second_name: '', team: t.teamId,
    element_type: ELEMENT_TYPE[t.position], now_cost: t.priceTenths, status: 'a',
    chance_of_playing_next_round: null, news: '', selected_by_percent: '0', form: '0',
    total_points: t.points, minutes: t.minutes, starts: t.starts, goals_scored: t.goals, assists: t.assists,
    expected_goals: String(t.xg), expected_assists: String(t.xa), expected_goals_conceded: String(t.xgc),
    clean_sheets: t.cleanSheets, goals_conceded: t.goalsConceded, saves: t.saves, bonus: t.bonus,
    defensive_contribution: t.defcon, yellow_cards: t.yellows, red_cards: t.reds,
    influence: '0', creativity: '0', threat: '0',
  }));
  const firstKickoff = new Map();
  for (const f of season.fixtures) if (!firstKickoff.has(f.gw)) firstKickoff.set(f.gw, f.kickoff);
  const events = [...firstKickoff].sort(([a], [b]) => a - b).map(([id, kickoff]) => ({
    id, deadline_time: new Date(Date.parse(kickoff) - DEADLINE_LEAD_MS).toISOString(),
    finished: id < gw, data_checked: id < gw, is_current: id === gw - 1, is_next: id === gw, average_entry_score: 0,
  }));
  const fixtures = season.fixtures.map(f => {
    const event = gwOf.get(f.id);
    const played = event !== null && event < gw;
    return {
      id: f.id, event, kickoff_time: f.kickoff, provisional_start_time: false,
      team_h: f.home, team_a: f.away, started: played, finished: played, finished_provisional: played,
      team_h_score: played ? f.homeGoals : null, team_a_score: played ? f.awayGoals : null,
      team_h_difficulty: hindsight ? f.homeDifficulty : NEUTRAL_DIFFICULTY,
      team_a_difficulty: hindsight ? f.awayDifficulty : NEUTRAL_DIFFICULTY,
    };
  });
  return { bootstrap: { teams, elements, events, element_types: [] }, fixtures };
}
