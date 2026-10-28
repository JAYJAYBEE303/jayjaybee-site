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
 * The decision log lives here too (solver plan §4): what each card advised,
 * kept so the solver's calls can be audited against what happened.
 *
 * Adapter contract: { get(store, key), put(store, value), getAll(store),
 * getLast(store), delete(store, key) }, all async, over three object stores -
 * 'snapshots' keyed by capturedAt, 'gwTables' keyed by gw and 'decisions'
 * keyed by key (logDecision's).
 */

import { buildBootstrapSnapshot, normaliseLiveGw } from './engine/normalise.js';
import { moveSetKey } from './engine/decision.js';
import { SNAPSHOT_MIN_INTERVAL_MS } from './config.js';

const DB_NAME    = 'gafferiq-snapshots';
const DB_VERSION = 2;

/** The adapter used when IndexedDB is unavailable: keeps nothing, never throws. */
const NO_STORE = Object.freeze({
  get:     async () => null,
  put:     async () => {},
  getAll:  async () => [],
  getLast: async () => null,
  delete:  async () => {},
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
 * Log what a settled card advised. An entry is keyed by gameweek, mode, call,
 * move set and source (a wait of a move set is not a move of it, and a roll has
 * the empty set): seeing the same one again (its gain or robustness landing
 * after the card settled, or the next run reaching it again) updates the
 * figures, the time and what the engine would have done, in place; a new key
 * adds an entry. Past `max` entries
 * the oldest by `at` are dropped.
 *
 * @param {object} db  store adapter
 * @param {{ gw: number, at: number, mode: string, source: string, call: 'move'|'wait'|'roll',
 *   stopped: boolean, guard: 'trusted'|'resolved'|'engine', gap: number|null,
 *   moves: Array<{outId: number, inId: number}>, gain: number|null,
 *   robustness: number|null, engineFirst: Array<{outId: number, inId: number}>,
 *   agrees: boolean }} entry  stopped: the solve that made the card stopped at its limit (false for an engine card);
 *   guard: its plan was trusted at once, only after a longer re-solve, or the card is the engine's; gap: that plan's
 *   distance from its proven bound (null for an engine card)
 * @param {{ max: number }} limits  DECISION_ENGINE.solver.logMax
 */
export async function logDecision(db, entry, { max }) {
  const key = `${entry.gw}|${entry.mode}|${entry.call}|${moveSetKey(entry.moves)}|${entry.source}`;
  const held = await db.get('decisions', key);
  if (held) {
    // The engine's own move can change between runs without changing the key, so the entry describes the latest run.
    const { gain, robustness, at, engineFirst, agrees, stopped, guard, gap } = entry;
    await db.put('decisions', { ...held, gain, robustness, at, engineFirst, agrees, stopped, guard, gap });
    return;
  }
  await db.put('decisions', { ...entry, key });
  // The whole log is read to find the oldest, once per new entry: cheap at logMax, an index on `at` if that ever grows far.
  const all = await db.getAll('decisions');
  const surplus = all.sort((a, b) => a.at - b.at).slice(0, Math.max(0, all.length - max));
  for (const old of surplus) await db.delete('decisions', old.key);
}

/**
 * Everything archived, for the offline tools (Phase 4 minutes model, Phase 7
 * backtest) and the decision log.
 * @param {object} db  store adapter
 * @returns {Promise<{ snapshots: object[], gwTables: object[], decisions: object[] }>}
 */
export async function exportSnapshots(db) {
  return {
    snapshots: await db.getAll('snapshots'),
    gwTables: await db.getAll('gwTables'),
    decisions: await db.getAll('decisions'),
  };
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
      if (!idb.objectStoreNames.contains('decisions')) {
        idb.createObjectStore('decisions', { keyPath: 'key' });
      }
    };
    // An older tab still holding version 1 keeps the upgrade pending for as long as it is open: answer without the
    // archive rather than leave everything waiting on it hanging.
    request.onblocked = () => {
      console.warn('[snapshots] IndexedDB upgrade is blocked by another tab - snapshots are off');
      resolve(NO_STORE);
    };
    request.onsuccess = () => {
      // A newer tab upgrading the archive must not be kept waiting on this one.
      request.result.onversionchange = () => request.result.close();
      resolve(wrapIdb(request.result));
    };
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
    delete: (storeName, key) =>
      safely(() => run(storeName, 'readwrite', s => s.delete(key)).then(() => {}), undefined),
    getAll: storeName =>
      safely(() => run(storeName, 'readonly', s => s.getAll()), []),
    // The newest record: the first stop of a cursor walking keys backwards.
    getLast: storeName =>
      safely(() => run(storeName, 'readonly', s => s.openCursor(null, 'prev'))
        .then(cursor => cursor?.value ?? null), null),
  };
}
