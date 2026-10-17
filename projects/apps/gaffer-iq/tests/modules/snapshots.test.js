/**
 * tests/modules/snapshots.test.js
 * The point-in-time archive (brief §3, decision engine Phase 1). The capture
 * logic runs against an in-memory store with the same contract as the
 * IndexedDB adapter, because Node has no IndexedDB; the real adapter's
 * fallback for exactly that case is tested at the end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureSnapshot, captureGwTables, exportSnapshots, openSnapshotDb,
} from '../../js/snapshots.js';
import { SNAPSHOT_MIN_INTERVAL_MS } from '../../js/config.js';

/** Test utility: the adapter contract (get / put / getAll / getLast), in memory. */
function memoryDb() {
  const stores = { snapshots: new Map(), gwTables: new Map() };
  const keyOf = { snapshots: r => r.capturedAt, gwTables: r => r.gw };
  const sortedKeys = name => [...stores[name].keys()].sort((a, b) => a - b);
  return {
    get: async (name, key) => stores[name].get(key) ?? null,
    put: async (name, value) => { stores[name].set(keyOf[name](value), structuredClone(value)); },
    getAll: async name => sortedKeys(name).map(k => stores[name].get(k)),
    getLast: async name => {
      const keys = sortedKeys(name);
      return keys.length ? stores[name].get(keys.at(-1)) : null;
    },
  };
}

const BOOTSTRAP = {
  elements: [{ id: 7, status: 'a', now_cost: 102, chance_of_playing_next_round: null }],
  events: [{ id: 8, deadline_time: '2026-10-17T17:30:00Z', finished: false,
    data_checked: false, is_current: false, is_next: true }],
};

// ─── captureSnapshot ─────────────────────────────────────────────────────────

test('captureSnapshot archives a freshly fetched payload', async () => {
  const db = memoryDb();
  const record = await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  const stored = await db.getAll('snapshots');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].fetchedAt, 1000);
  assert.equal(record.capturedAt, 1000);
});

test('captureSnapshot run twice across the minimum interval stores two distinct records', async () => {
  const db = memoryDb();
  await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  const later = 1000 + SNAPSHOT_MIN_INTERVAL_MS;
  await captureSnapshot(db, BOOTSTRAP, { fetchedAt: later, now: later });
  const stored = await db.getAll('snapshots');
  assert.deepEqual(stored.map(r => r.capturedAt), [1000, later]);
});

test('captureSnapshot does not archive the same fetched payload twice', async () => {
  // A cached payload re-read on a reload is not a new observation of the game.
  const db = memoryDb();
  await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  const result = await captureSnapshot(db, BOOTSTRAP,
    { fetchedAt: 1000, now: 1000 + 2 * SNAPSHOT_MIN_INTERVAL_MS });
  assert.equal(result, null);
  assert.equal((await db.getAll('snapshots')).length, 1);
});

test('captureSnapshot skips a fresh payload inside the minimum interval', async () => {
  const db = memoryDb();
  await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  const soon = 1000 + SNAPSHOT_MIN_INTERVAL_MS - 1;
  await captureSnapshot(db, BOOTSTRAP, { fetchedAt: soon, now: soon });
  assert.equal((await db.getAll('snapshots')).length, 1);
});

// ─── captureGwTables ─────────────────────────────────────────────────────────

const LIVE = { elements: [{ id: 7, stats: { minutes: 90, total_points: 6, starts: 1 }, explain: [] }] };
const EVENTS = [
  { id: 1, complete: true,  finished: true },   // played, bonus confirmed
  { id: 2, complete: true,  finished: false },  // played, bonus pending
  { id: 3, complete: false, finished: false },  // not played yet
];

test('captureGwTables fetches each played gameweek, and stops once its bonus is confirmed', async () => {
  const db = memoryDb();
  const calls = [];
  const fetchLive = async gw => { calls.push(gw); return LIVE; };

  await captureGwTables(db, EVENTS, fetchLive, 5000);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(await db.get('gwTables', 1), {
    gw: 1, capturedAt: 5000, final: true,
    players: [{ playerId: 7, minutes: 90, points: 6, starts: 1 }],
  });

  // Next visit: GW1 is final and stays as stored; GW2 is fetched again.
  calls.length = 0;
  await captureGwTables(db, EVENTS, fetchLive, 6000);
  assert.deepEqual(calls, [2]);
  assert.equal((await db.get('gwTables', 1)).capturedAt, 5000);
});

test('captureGwTables keeps going when one gameweek fails to load', async t => {
  t.mock.method(console, 'warn', () => {});
  const db = memoryDb();
  const fetchLive = async gw => {
    if (gw === 1) throw new Error('proxy 502');
    return LIVE;
  };
  await captureGwTables(db, EVENTS, fetchLive, 5000);
  assert.equal(await db.get('gwTables', 1), null);
  assert.equal((await db.get('gwTables', 2)).gw, 2);
});

// ─── export and the storage fallback ─────────────────────────────────────────

test('exportSnapshots returns every snapshot and gameweek table', async () => {
  const db = memoryDb();
  await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  await captureGwTables(db, EVENTS, async () => LIVE, 5000);
  const exported = await exportSnapshots(db);
  assert.deepEqual(exported.snapshots.map(r => r.capturedAt), [1000]);
  assert.deepEqual(exported.gwTables.map(r => r.gw), [1, 2]);
});

test('openSnapshotDb degrades to a store that keeps nothing when IndexedDB is unavailable', async () => {
  // Node has no indexedDB - the same situation as a browser that blocks it.
  // Capture must carry on quietly rather than break the data:ready path.
  const db = await openSnapshotDb();
  const record = await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  assert.equal(record.fetchedAt, 1000);
  assert.deepEqual(await db.getAll('snapshots'), []);
});
