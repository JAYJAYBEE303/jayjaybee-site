/**
 * tools/understat-compat/build.js
 * Writes data/understat-compat/league-EPL-{year}.json for every finished season
 * the app loads (UNDERSTAT_PREV_SEASON + UNDERSTAT_HISTORY_SEASONS), from
 * vaastav's per-season FPL results (github.com/vaastav/Fantasy-Premier-League).
 * The output is committed: js/api.js fetchLeagueXg serves those seasons from it
 * instead of Understat. A finished season never changes, so run this again only
 * when the UNDERSTAT_* constants are bumped for a new season.
 *
 *   node tools/understat-compat/build.js
 *
 * Behind an HTTPS proxy, Node 22's fetch also needs NODE_USE_ENV_PROXY=1.
 * Always overwrites; the shape is documented in ./lib.js.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { UNDERSTAT_PREV_SEASON, UNDERSTAT_HISTORY_SEASONS } from '../../js/config.js';
import { buildLeagueCompat } from './lib.js';

const SOURCE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
const OUT = new URL('../../data/understat-compat/', import.meta.url);

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

await mkdir(OUT, { recursive: true });

for (const year of [UNDERSTAT_PREV_SEASON, ...UNDERSTAT_HISTORY_SEASONS]) {
  // Understat names a season by its start year; vaastav by '2021-22'.
  const label = `${year}-${String(Number(year) + 1).slice(2)}`;
  const [teams, fixtures] = await Promise.all([
    get(`${SOURCE}/${label}/teams.csv`),
    get(`${SOURCE}/${label}/fixtures.csv`),
  ]);
  const league = buildLeagueCompat(teams, fixtures);
  await writeFile(new URL(`league-EPL-${year}.json`, OUT), JSON.stringify(league));
  console.log(`${year}: ${league.datesData.length} results, ${Object.keys(league.teamsData).length} clubs`);
}
