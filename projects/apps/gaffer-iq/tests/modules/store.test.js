/**
 * tests/modules/store.test.js
 * Season freshness: a season restored from sessionStorage must not stand in for
 * live data forever. Node has no sessionStorage; the store's writes to it are
 * already guarded, so only the in-memory state is exercised here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../../js/store.js';
import { SEASON_MAX_AGE_MS } from '../../js/config.js';

test('isSeasonExpired is false for a season fetched within the maximum age', () => {
  store.setSeason({ players: [] });
  const fetchedAt = store.getLastRefreshAt();
  assert.equal(store.isSeasonExpired(fetchedAt + SEASON_MAX_AGE_MS - 1), false);
});

test('isSeasonExpired is true past the maximum age, so a reload refetches the season', () => {
  // Before this, a reload in the same tab reused prices, flags and transfer
  // counts from however long ago the tab first loaded them.
  store.setSeason({ players: [] });
  const fetchedAt = store.getLastRefreshAt();
  assert.equal(store.isSeasonExpired(fetchedAt + SEASON_MAX_AGE_MS + 1), true);
});

test('isFresh still reports a loaded season however old it is', t => {
  // Modules read isFresh() as "is there a season to render from": an age
  // limit here would switch the Ranker and Matchup off an hour into an open tab.
  store.setSeason({ players: [] });
  t.mock.timers.enable({ apis: ['Date'], now: store.getLastRefreshAt() + 10 * SEASON_MAX_AGE_MS });
  assert.equal(store.isFresh(), true);
});

test('isFresh rejects an empty store', () => {
  store.clearCache();
  assert.equal(store.isFresh(), false);
});
