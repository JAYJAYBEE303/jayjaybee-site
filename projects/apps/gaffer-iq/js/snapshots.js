/**
 * js/snapshots.js
 * Layer: module. Side effects: IndexedDB reads/writes, and a file download in
 * downloadSnapshots. No fetch: the live-points fetcher is passed in.
 *
 * The point-in-time archive the decision engine's backtest and minutes model
 * depend on (brief §3, plan Phase 1): a record of the bootstrap payload each
 * time a fresh one is fetched, and one table per played gameweek of who played
 * and what they scored. Injury flags, prices and transfer flow can never be
 * recovered after the fact, so whatever is not captured here is lost for good.
 *
 * Captured in the browser on each visit (plan Q1), kept in IndexedDB - a day's
 * record is ~100 KB, which would fill localStorage within weeks. Storage may be
 * missing or blocked (private windows, Node); every adapter call then quietly
 * does nothing and capture never throws into data:ready.
 *
 * The record builders are pure (engine/normalise.js); everything here takes
 * the store adapter as an argument, so tests run against an in-memory one.
 *
 * Adapter contract: { get(store, key), put(store, value), getAll(store),
 * getLast(store) }, all async, over two object stores - 'snapshots' keyed by
 * capturedAt and 'gwTables' keyed by gw.
 */

import { buildBootstrapSnapshot, normaliseLiveGw } from './engine/normalise.js';
import { SNAPSHOT_MIN_INTERVAL_MS } from './config.js';

const DB_NAME    = 'gafferiq-snapshots';
const DB_VERSION = 1;

/** The adapter used when IndexedDB is unavailable: keeps nothing, never throws. */
const NO_STORE = Object.freeze({
  get:     async () => null,
  put:     async () => {},
  getAll:  async () => [],
  getLast: async () => null,
});

/**
 * Archive a freshly fetched bootstrap payload, unless it is the payload last
 * archived (a cached copy re-read on reload is not a new observation) or the
 * last record is younger than SNAPSHOT_MIN_INTERVAL_MS.
 *
 * @param {object} db            store adapter
 * @param {object} rawBootstrap  bootstrap-static/ response
 * @param {{ fetchedAt: number, now: number }} times  epoch ms
 * @returns {Promise<object|null>}  the record written, or null when skipped
 */
export async function captureSnapshot(db, rawBootstrap, { fetchedAt, now }) {
  const last = await db.getLast('snapshots');
  if (last && (last.fetchedAt === fetchedAt || now - last.capturedAt < SNAPSHOT_MIN_INTERVAL_MS)) {
    return null;
  }
  const record = buildBootstrapSnapshot(rawBootstrap, { capturedAt: now, fetchedAt });
  await db.put('snapshots', record);
  return record;
}

/**
 * Store a minutes/points table for every played gameweek not yet held in its
 * final form. A gameweek is final once FPL has confirmed its bonus (the raw
 * `finished` flag); until then it is fetched again on later visits. One
 * request per gameweek, fetched one at a time - light on the upstream.
 *
 * @param {object} db  store adapter
 * @param {Array<{id: number, complete: boolean, finished: boolean}>} events
 *   normalised events (engine/normalise.js)
 * @param {(gw: number) => Promise<object>} fetchLive  raw event/{gw}/live/ fetcher
 * @param {number} now  epoch ms
 * @returns {Promise<number>}  how many gameweeks were fetched
 */
export async function captureGwTables(db, events, fetchLive, now) {
  let fetched = 0;
  for (const event of events ?? []) {
    if (!event.complete) continue;
    const stored = await db.get('gwTables', event.id);
    if (stored?.final) continue;

    let raw;
    try {
      raw = await fetchLive(event.id);
    } catch (err) {
      // Not fatal: the gameweek is simply tried again on the next visit.
      console.warn(`[snapshots] GW${event.id} live table unavailable:`, err?.message ?? err);
      continue;
    }
    await db.put('gwTables', {
      gw: event.id,
      capturedAt: now,
      final: Boolean(event.finished),
      players: normaliseLiveGw(raw),
    });
    fetched++;
  }
  return fetched;
}

/**
 * Everything archived, for the offline tools (Phase 4 minutes model, Phase 7
 * backtest).
 * @param {object} db  store adapter
 * @returns {Promise<{ snapshots: object[], gwTables: object[] }>}
 */
export async function exportSnapshots(db) {
  return { snapshots: await db.getAll('snapshots'), gwTables: await db.getAll('gwTables') };
}

/**
 * Download the whole archive as one JSON file.
 * @param {object} db  store adapter
 */
export async function downloadSnapshots(db) {
  const data = await exportSnapshots(db);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `gafferiq-snapshots-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Open the archive. Resolves to the IndexedDB adapter, or to NO_STORE when
 * IndexedDB is missing or refuses to open - never rejects.
 * @returns {Promise<object>}  store adapter
 */
export function openSnapshotDb() {
  return new Promise(resolve => {
    let request;
    try {
      request = globalThis.indexedDB?.open(DB_NAME, DB_VERSION);
    } catch (err) {
      console.warn('[snapshots] IndexedDB unavailable - snapshots are off:', err?.message ?? err);
      resolve(NO_STORE);
      return;
    }
    if (!request) { resolve(NO_STORE); return; }

    request.onupgradeneeded = () => {
      const idb = request.result;
      if (!idb.objectStoreNames.contains('snapshots')) {
        idb.createObjectStore('snapshots', { keyPath: 'capturedAt' });
      }
      if (!idb.objectStoreNames.contains('gwTables')) {
        idb.createObjectStore('gwTables', { keyPath: 'gw' });
      }
    };
    request.onsuccess = () => resolve(wrapIdb(request.result));
    request.onerror = () => {
      console.warn('[snapshots] IndexedDB refused to open - snapshots are off:', request.error);
      resolve(NO_STORE);
    };
  });
}

/** The adapter over an open IndexedDB database. Every call resolves; failures log. */
function wrapIdb(idb) {
  // A write resolves on transaction COMPLETE, not on request success: a write
  // that later aborts (quota exceeded) must not be reported as stored.
  const run = (storeName, mode, makeRequest) => new Promise((resolve, reject) => {
    const tx  = idb.transaction(storeName, mode);
    const req = makeRequest(tx.objectStore(storeName));
    if (mode === 'readwrite') {
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? req.error);
    } else {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }
  });
  const safely = (work, fallback) => {
    try {
      return work().catch(err => {
        console.warn('[snapshots] IndexedDB call failed:', err?.message ?? err);
        return fallback;
      });
    } catch (err) {
      console.warn('[snapshots] IndexedDB call failed:', err?.message ?? err);
      return Promise.resolve(fallback);
    }
  };

  return {
    get: (storeName, key) =>
      safely(() => run(storeName, 'readonly', s => s.get(key)).then(v => v ?? null), null),
    put: (storeName, value) =>
      safely(() => run(storeName, 'readwrite', s => s.put(value)).then(() => {}), undefined),
    getAll: storeName =>
      safely(() => run(storeName, 'readonly', s => s.getAll()), []),
    // The newest record: the first stop of a cursor walking keys backwards.
    getLast: storeName =>
      safely(() => run(storeName, 'readonly', s => s.openCursor(null, 'prev'))
        .then(cursor => cursor?.value ?? null), null),
  };
}
