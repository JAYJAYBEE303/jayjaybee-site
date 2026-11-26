/**
 * tests/modules/api.test.js
 * js/api.js fetchLeagueXg: finished seasons come from the static compat files
 * (data/understat-compat), the live season and any missing file from the proxy.
 * `fetch` is the only thing stubbed - it is the module's one external edge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLeagueXg, ApiError } from '../../js/api.js';
import * as config from '../../js/config.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Stub fetch with a queue of responses (or errors to throw); returns the URLs asked for. */
function stubFetch(t, ...responses) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return urls;
}

test('UNDERSTAT_COMPAT_SEASONS is the finished seasons the app loads', () => {
  assert.deepEqual(config.UNDERSTAT_COMPAT_SEASONS, ['2025', '2024', '2023', '2022', '2021']);
});

test('a compat season is read from the static file in one request', async (t) => {
  const urls = stubFetch(t, reply({ datesData: [] }));
  assert.deepEqual(await fetchLeagueXg('2025'), { datesData: [] });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /data\/understat-compat\/league-EPL-2025\.json$/);
});

test('the live season goes to the proxy, never the static folder', async (t) => {
  const urls = stubFetch(t, reply({ teamsData: {} }));
  await fetchLeagueXg('2026');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('source=understat') && urls[0].includes('league%2FEPL%2F2026'), urls[0]);
});

test('a missing static file falls through to the proxy', async (t) => {
  const urls = stubFetch(t, reply({}, 404), reply({ teamsData: { 1: {} } }));
  assert.deepEqual(await fetchLeagueXg('2024'), { teamsData: { 1: {} } });
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes('source=understat') && urls[1].includes('league%2FEPL%2F2024'), urls[1]);
});

test('a network error on the static file also falls through to the proxy', async (t) => {
  const urls = stubFetch(t, new TypeError('Failed to fetch'), reply({ datesData: [1] }));
  assert.deepEqual(await fetchLeagueXg('2023'), { datesData: [1] });
  assert.equal(urls.length, 2);
});

test('a proxy failure still rejects with ApiError', async (t) => {
  stubFetch(t, reply({ error: 'parse_failed' }, 422));
  await assert.rejects(fetchLeagueXg('2026'), err => err instanceof ApiError
    && /Understat league xG unavailable for 2026/.test(err.message));
});
