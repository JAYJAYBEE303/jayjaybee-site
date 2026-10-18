/**
 * tools/backtest/download.js
 * Fetches vaastav's per-season FPL data (github.com/vaastav/Fantasy-Premier-League)
 * for every season in SEASONS into tools/backtest/data/, which is gitignored:
 * the data is never committed. A file already there is kept.
 *
 *   node tools/backtest/download.js
 *
 * Behind an HTTPS proxy, Node 22's fetch also needs NODE_USE_ENV_PROXY=1.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';

import { SEASONS } from './history.js';

const SOURCE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
const DATA = new URL('./data/', import.meta.url);
const FILES = ['gws/merged_gw.csv', 'fixtures.csv', 'teams.csv', 'players_raw.csv'];

for (const season of SEASONS) {
  for (const path of FILES) {
    const file = new URL(`${season}/${path.split('/').pop()}`, DATA);
    if (await stat(file).then(() => true, () => false)) {
      console.log(`${season} ${path}: already downloaded`);
      continue;
    }
    const response = await fetch(`${SOURCE}/${season}/${path}`);
    if (!response.ok) throw new Error(`${season} ${path}: HTTP ${response.status}`);
    await mkdir(new URL(`${season}/`, DATA), { recursive: true });
    await writeFile(file, await response.text());
    console.log(`${season} ${path}: downloaded`);
  }
}
