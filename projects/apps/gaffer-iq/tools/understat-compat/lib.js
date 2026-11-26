/**
 * tools/understat-compat/lib.js
 * Pure: vaastav's per-season FPL `teams.csv` + `fixtures.csv` become a league
 * payload in the shape js/api.js returns for Understat's league/EPL/{season}
 * AFTER api/fpl.js renameUnderstatKeys - { teamsData, playersData, datesData } -
 * so every existing consumer (engine/h2h.js, engine/fixtures.js) reads it
 * unchanged. Results only: there is no xG, PPDA, chain or id in the source, and
 * none is invented. In particular no row carries an `id`: engine/channel.js
 * findUnderstatMatchId skips id-less rows, so an FPL fixture id can never be
 * mistaken for an Understat match id.
 *
 * See docs/superpowers/specs/2026-11-26-understat-compat-layer-design.md.
 */

import { parseCsv } from '../minutes/lib.js';

/** '2021-08-13T19:00:00Z' -> '2021-08-13 19:00:00' (Understat: UTC, no zone suffix). */
function toUnderstatDatetime(iso) {
  return iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
}

/**
 * @param {string} teamsCsv     vaastav data/{season}/teams.csv text
 * @param {string} fixturesCsv  vaastav data/{season}/fixtures.csv text
 * @returns {{
 *   teamsData: Object<string, {id: string, title: string,
 *     history: {date: string, h_a: 'h'|'a', scored: number, missed: number}[]}>,
 *   playersData: [],
 *   datesData: {isResult: true, datetime: string, h: {title: string},
 *     a: {title: string}, goals: {h: number, a: number}}[]
 * }}
 */
export function buildLeagueCompat(teamsCsv, fixturesCsv) {
  const teamsData = {};
  for (const t of parseCsv(teamsCsv)) {
    teamsData[t.id] = { id: t.id, title: t.name, history: [] };
  }

  // Played = finished with a score on both sides. A postponed or future row has
  // empty scores and must never be read as 0-0.
  const played = parseCsv(fixturesCsv)
    .filter(f => f.finished === 'True' && f.team_h_score !== '' && f.team_a_score !== '')
    .map(f => ({
      datetime: toUnderstatDatetime(f.kickoff_time),
      home: f.team_h, away: f.team_a,
      hg: Number(f.team_h_score), ag: Number(f.team_a_score),
    }))
    .sort((x, y) => x.datetime.localeCompare(y.datetime));

  const datesData = [];
  for (const m of played) {
    datesData.push({
      isResult: true,
      datetime: m.datetime,
      h: { title: teamsData[m.home].title },
      a: { title: teamsData[m.away].title },
      goals: { h: m.hg, a: m.ag },
    });
    teamsData[m.home].history.push({ date: m.datetime, h_a: 'h', scored: m.hg, missed: m.ag });
    teamsData[m.away].history.push({ date: m.datetime, h_a: 'a', scored: m.ag, missed: m.hg });
  }

  return { teamsData, playersData: [], datesData };
}
