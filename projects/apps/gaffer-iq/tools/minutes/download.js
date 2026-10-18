/**
 * tools/minutes/download.js
 * Fetches vaastav's per-fixture player data (merged_gw.csv,
 * github.com/vaastav/Fantasy-Premier-League) for every season in SPLITS into
 * tools/minutes/data/, which is gitignored: the data is never committed. A
 * season already there is kept.
 *
 *   node tools/minutes/download.js
 *
 * Behind an HTTPS proxy, Node 22's fetch also needs NODE_USE_ENV_PROXY=1.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';

import { SPLITS } from './lib.js';

const SOURCE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
const DATA = new URL('./data/', import.meta.url);

for (const season of Object.values(SPLITS).flat()) {
  const file = new URL(`${season}/merged_gw.csv`, DATA);
  if (await stat(file).then(() => true, () => false)) {
    console.log(`${season}: already downloaded`);
    continue;
  }
  const response = await fetch(`${SOURCE}/${season}/gws/merged_gw.csv`);
  if (!response.ok) throw new Error(`${season}: HTTP ${response.status}`);
  await mkdir(new URL(`${season}/`, DATA), { recursive: true });
  await writeFile(file, await response.text());
  console.log(`${season}: downloaded`);
}
