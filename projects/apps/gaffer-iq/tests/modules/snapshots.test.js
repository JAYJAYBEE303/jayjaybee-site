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
  captureSnapshot, captureGwTables, logDecision, exportSnapshots, openSnapshotDb,
} from '../../js/snapshots.js';
import { SNAPSHOT_MIN_INTERVAL_MS, DECISION_ENGINE } from '../../js/config.js';

/** Test utility: the adapter contract (get / put / getAll / getLast / delete), in memory. */
function memoryDb() {
  const stores = { snapshots: new Map(), gwTables: new Map(), decisions: new Map() };
  const keyOf = { snapshots: r => r.capturedAt, gwTables: r => r.gw, decisions: r => r.key };
  const sortedKeys = name => [...stores[name].keys()].sort((a, b) => a - b);
  return {
    get: async (name, key) => stores[name].get(key) ?? null,
    put: async (name, value) => { stores[name].set(keyOf[name](value), structuredClone(value)); },
    delete: async (name, key) => { stores[name].delete(key); },
    getAll: async name => (name === 'decisions' ? [...stores[name].values()] : sortedKeys(name).map(k => stores[name].get(k))),
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

// ─── the decision log ────────────────────────────────────────────────────────

const ENTRY = {
  gw: 8, at: 1000, mode: 'now', source: 'solver', call: 'move', stopped: false,
  moves: [{ outId: 5, inId: 9 }, { outId: 2, inId: 7 }],
  gain: 3.4, robustness: null,
  engineFirst: [{ outId: 5, inId: 9 }], agrees: false,
};

test('a settled card is logged with every field', async () => {
  const db = memoryDb();
  await logDecision(db, ENTRY, { max: DECISION_ENGINE.solver.logMax });
  const [held, ...rest] = await db.getAll('decisions');
  assert.equal(rest.length, 0);
  // Keyed by gameweek, mode, call, the move set (sales then buys, each sorted) and source.
  assert.deepEqual(held, { ...ENTRY, key: '8|now|move|2,5>7,9|solver' });
});

test('a figure landing later updates the same entry', async () => {
  const db = memoryDb();
  await logDecision(db, ENTRY, { max: DECISION_ENGINE.solver.logMax });
  const landed = { ...ENTRY, at: 2000, gain: 4.1, robustness: 0.7,
    // A different pairing of the same sales and buys is the same move set.
    moves: [{ outId: 5, inId: 7 }, { outId: 2, inId: 9 }] };
  await logDecision(db, landed, { max: DECISION_ENGINE.solver.logMax });
  const held = await db.getAll('decisions');
  assert.equal(held.length, 1);
  assert.equal(held[0].gain, 4.1);
  assert.equal(held[0].robustness, 0.7);
  assert.equal(held[0].at, 2000);
  // The rest of the entry is the first sighting's.
  assert.deepEqual(held[0].moves, ENTRY.moves);

  // Another source, mode or gameweek is another entry.
  await logDecision(db, { ...ENTRY, source: 'engine' }, { max: DECISION_ENGINE.solver.logMax });
  await logDecision(db, { ...ENTRY, mode: 'future' }, { max: DECISION_ENGINE.solver.logMax });
  await logDecision(db, { ...ENTRY, gw: 9 }, { max: DECISION_ENGINE.solver.logMax });
  assert.equal((await db.getAll('decisions')).length, 4);
});

test('a wait and a move of the same set are two entries, and a roll has an empty move set', async () => {
  const db = memoryDb();
  const max = DECISION_ENGINE.solver.logMax;
  await logDecision(db, ENTRY, { max });
  await logDecision(db, { ...ENTRY, call: 'wait' }, { max });
  await logDecision(db, { ...ENTRY, call: 'roll', moves: [], gain: null }, { max });
  // The same wait again is the same entry; a roll with the same key too.
  await logDecision(db, { ...ENTRY, call: 'wait', at: 3000 }, { max });
  await logDecision(db, { ...ENTRY, call: 'roll', moves: [], gain: null, at: 3000 }, { max });
  const held = await db.getAll('decisions');
  assert.deepEqual(held.map(e => e.key).sort(), ['8|now|move|2,5>7,9|solver', '8|now|roll||solver', '8|now|wait|2,5>7,9|solver']);
});

test('the log keeps at most logMax entries, oldest first out', async () => {
  const db = memoryDb();
  const max = 3;
  for (let i = 1; i <= max + 2; i++) {
    await logDecision(db, { ...ENTRY, gw: i, at: i * 1000 }, { max });
  }
  const held = await db.getAll('decisions');
  assert.deepEqual(held.map(e => e.gw).sort((a, b) => a - b), [3, 4, 5]);

  // An update never counts twice, and the oldest goes by `at`, not by arrival.
  await logDecision(db, { ...ENTRY, gw: 3, at: 9000, gain: 1 }, { max });
  await logDecision(db, { ...ENTRY, gw: 6, at: 500 }, { max });
  assert.deepEqual((await db.getAll('decisions')).map(e => e.gw).sort((a, b) => a - b), [3, 4, 5]);
});

test('a repeat key takes the new sighting\'s engineFirst and agrees as well, so an entry describes one run', async () => {
  const db = memoryDb();
  await logDecision(db, ENTRY, { max: DECISION_ENGINE.solver.logMax });
  // A bank tweak moves the engine's root onto the solver's pick: same key, a different story.
  const rerun = { ...ENTRY, at: 2000, engineFirst: ENTRY.moves, agrees: true, stopped: true };
  await logDecision(db, rerun, { max: DECISION_ENGINE.solver.logMax });
  const [held, ...rest] = await db.getAll('decisions');
  assert.equal(rest.length, 0);
  assert.equal(held.agrees, true);
  assert.equal(held.stopped, true, 'whether the solve stopped at its limit is of the latest run too');
  assert.deepEqual(held.engineFirst, ENTRY.moves);
});

test('the export includes the log', async () => {
  const db = memoryDb();
  await logDecision(db, ENTRY, { max: DECISION_ENGINE.solver.logMax });
  const exported = await exportSnapshots(db);
  assert.deepEqual(exported.decisions.map(e => e.key), ['8|now|move|2,5>7,9|solver']);
  assert.deepEqual(exported.snapshots, []);
  assert.deepEqual(exported.gwTables, []);
});

test('NO_STORE still never throws', async () => {
  const db = await openSnapshotDb();
  await logDecision(db, ENTRY, { max: DECISION_ENGINE.solver.logMax });
  assert.deepEqual(await db.getAll('decisions'), []);
  await db.delete('decisions', 'anything');
  assert.deepEqual((await exportSnapshots(db)).decisions, []);
});

/** Test utility: a stand-in indexedDB whose one open request the test drives by hand. */
function fakeIndexedDb(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const request = { result: { onversionchange: null, closed: false, close() { this.closed = true; } } };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => request } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else delete globalThis.indexedDB;
  });
  return request;
}

test('openSnapshotDb resolves to a store that keeps nothing when an older tab blocks the upgrade', async t => {
  // Without this the open stays pending for as long as the older tab is open, and everything waiting on the archive hangs.
  const warn = t.mock.method(console, 'warn', () => {});
  const request = fakeIndexedDb(t);
  const opening = openSnapshotDb();
  request.onblocked();
  const db = await opening;
  assert.deepEqual(await db.getAll('snapshots'), []);
  assert.equal(warn.mock.callCount(), 1);
});

test('an open archive closes when a newer tab upgrades it', async t => {
  const request = fakeIndexedDb(t);
  const opening = openSnapshotDb();
  request.onsuccess();
  await opening;
  assert.equal(request.result.closed, false);
  request.result.onversionchange();
  assert.equal(request.result.closed, true);
});

test('openSnapshotDb degrades to a store that keeps nothing when IndexedDB is unavailable', async () => {
  // Node has no indexedDB - the same situation as a browser that blocks it.
  // Capture must carry on quietly rather than break the data:ready path.
  const db = await openSnapshotDb();
  const record = await captureSnapshot(db, BOOTSTRAP, { fetchedAt: 1000, now: 1000 });
  assert.equal(record.fetchedAt, 1000);
  assert.deepEqual(await db.getAll('snapshots'), []);
});
