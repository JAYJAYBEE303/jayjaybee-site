/**
 * js/squadImport.js
 * Layer: module utility. Shared squad-import logic used by dashboard.js and
 * planner.js. Read-only - never writes to the FPL account, never touches
 * credentials. Team ID and the purchase-price ledger are persisted in
 * localStorage only, never in a URL param.
 *
 * Exports:
 *   loadSavedTeamId()     → number|null
 *   saveTeamId(id)        → void
 *   loadLedger()          → LedgerRecord|null  (the last import's ledger)
 *   resolveImportGw()     → number|null  (the GW whose picks to import)
 *   fetchAndMapSquad(teamId, gw, fetchers?) → Promise<ImportResult>
 *
 * See ROADMAP.md Phase 4-1 and docs/decision-engine-plan.md Phase 1.
 */

import { store } from './store.js';
import {
  fetchSquadPicks, fetchEntryInfo, fetchEntryTransfers, fetchEntryHistory, fetchPlayerSummary,
} from './api.js';
import {
  normaliseEntryPicks, normaliseEntryTransfers, normaliseEntryHistory, normalisePlayerSummary,
} from './engine/normalise.js';
import { buildPurchaseLedger } from './engine/ledger.js';
import { toTenths } from './util.js';

/** localStorage key for the persisted FPL team ID. */
const LS_KEY = 'gafferiq_fpl_team_id';

/** localStorage key for the last import's ledger (see LedgerRecord). */
const LS_LEDGER_KEY = 'gafferiq_ledger';

/** The real network calls; tests pass stand-ins with the same signatures. */
const DEFAULT_FETCHERS = {
  picks:     fetchSquadPicks,
  info:      fetchEntryInfo,
  transfers: fetchEntryTransfers,
  history:   fetchEntryHistory,
  summary:   fetchPlayerSummary,
};

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Read the saved FPL team ID from localStorage.
 * @returns {number|null}  parsed integer, or null if not set / invalid
 */
export function loadSavedTeamId() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Persist an FPL team ID to localStorage for next session.
 * @param {number} teamId
 */
export function saveTeamId(teamId) {
  try {
    localStorage.setItem(LS_KEY, String(teamId));
  } catch { /* quota exceeded or private-mode restriction - non-fatal */ }
}

/**
 * @typedef {object} LedgerRecord
 * @property {number}      teamId
 * @property {number}      importedAt       epoch ms
 * @property {number}      squadGw          gameweek whose squad was imported
 * @property {number|null} bankTenths       money in the bank, tenths of a million
 * @property {Object<number, number>} purchasesTenths  playerId -> price paid, in
 *   tenths; a player missing here has no known price (callers use his current
 *   price, flagged estimated)
 * @property {object|null} history          normaliseEntryHistory output, from which
 *   the free-transfer count is replayed for whichever gameweek is being planned
 */

/**
 * The ledger saved by the last import, keyed by player id so it applies to the
 * shared squad however that squad was later edited.
 * @returns {LedgerRecord|null}
 */
export function loadLedger() {
  try {
    const raw = localStorage.getItem(LS_LEDGER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLedger(record) {
  try {
    localStorage.setItem(LS_LEDGER_KEY, JSON.stringify(record));
  } catch (err) {
    console.warn('[squadImport] ledger not saved - purchase prices will not survive a reload:',
      err?.message ?? err);
  }
}

// ─── GW resolution ───────────────────────────────────────────────────────────

/**
 * Determine which GW to import picks from.
 * During a live or completed GW: use currentGw.
 * Pre-season or between GWs (nextGw > 1): use nextGw − 1 (last completed).
 * Returns null when there is no sensible GW to import from (e.g. GW1 not yet played).
 *
 * @returns {number|null}
 */
export function resolveImportGw() {
  const current = store.getCurrentGw();
  if (current) return current;
  const next = store.getNextGw();
  if (next && next > 1) return next - 1;
  return null;
}

// ─── Core import ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ImportResult
 * @property {number[]}     playerIds    Ordered FPL player IDs from the picks (15 entries).
 * @property {Array<{playerId: number, slot: number|null, isCaptain: boolean,
 *   isViceCaptain: boolean}>} picks      Pick order, slot (1-11 XI, 12-15 bench)
 *   and armband, in the order FPL sent them.
 * @property {object|null}  entryInfo    Raw FPL entry object (name, team name, rank) or null.
 * @property {number}       missingCount Players in picks not found in the local store.
 * @property {number}       squadGw      The gameweek whose squad this is: `gw`, or the
 *   week before it when `gw` is a Free Hit week.
 * @property {number|null}  bankTenths   Money in the bank for that squad.
 * @property {Object<number, number>} purchasesTenths  See LedgerRecord.
 * @property {object|null}  history      See LedgerRecord.
 */

/**
 * Fetch the manager's squad for `gw`, map it onto the local player store, and
 * build the purchase-price ledger behind every sell price. The ledger is also
 * saved, so it survives a reload and applies whichever tab imported the squad.
 *
 * Rules:
 *  - The picks are required; failure throws and the caller shows an error.
 *  - In a Free Hit week the picks are a one-week squad that reverts, so the real
 *    squad, picks and bank are read from the week before.
 *  - Entry info, the transfer list and the history are supplementary: each
 *    failure is logged and the import carries on. Without the transfer list no
 *    purchase price is known (prices then fall back, flagged, downstream).
 *  - Players not found in the local store are skipped; missingCount reports how
 *    many were skipped so the caller can warn the user.
 *  - The picks array is returned in the order FPL sends it (GKP → DEF → MID → FWD).
 *
 * @param {number} teamId
 * @param {number} gw
 * @param {object} [fetchers]  { picks, info, transfers, history, summary }
 * @returns {Promise<ImportResult>}
 * @throws {ApiError}  if the picks fetch fails (private team, wrong ID, network)
 */
export async function fetchAndMapSquad(teamId, gw, fetchers = DEFAULT_FETCHERS) {
  const [picksRes, entryRes, transfersRes, historyRes] = await Promise.allSettled([
    fetchers.picks(teamId, gw),
    fetchers.info(teamId),
    fetchers.transfers(teamId),
    fetchers.history(teamId),
  ]);

  // Picks are required - propagate the error to the caller.
  if (picksRes.status !== 'fulfilled') {
    throw picksRes.reason;
  }

  let squadGw = gw;
  let entryPicks = normaliseEntryPicks(picksRes.value);
  if (entryPicks.activeChip === 'freehit' && gw > 1) {
    squadGw = gw - 1;
    entryPicks = normaliseEntryPicks(await fetchers.picks(teamId, squadGw));
  }

  const entryInfo = settledValue(entryRes, 'entry name/rank');
  const rawTransfers = settledValue(transfersRes, 'transfer list (purchase prices)');
  const rawHistory = settledValue(historyRes, 'gameweek history (free transfers)');
  const history = rawHistory ? normaliseEntryHistory(rawHistory) : null;

  // Map each pick's player to a local store player. Picks already arrive sorted
  // by position; preserve that order. Slot 1–11 is the XI, 12–15 the bench in
  // priority order - kept because the Planner compares the team you actually set
  // against the one the model would pick.
  const playerIds = [];
  const picks     = [];
  let missingCount = 0;

  for (const pick of entryPicks.picks) {
    if (!Number.isInteger(pick.playerId)) continue;
    if (!store.getPlayer(pick.playerId)) {
      missingCount++;
      continue;
    }
    playerIds.push(pick.playerId);
    picks.push(pick);
  }

  const purchasesTenths = rawTransfers
    ? await priceSquad(playerIds, normaliseEntryTransfers(rawTransfers), history, fetchers.summary)
    : {};

  saveLedger({
    teamId, importedAt: Date.now(), squadGw,
    bankTenths: entryPicks.bankTenths, purchasesTenths, history,
  });

  return {
    playerIds, picks, entryInfo, missingCount,
    squadGw, bankTenths: entryPicks.bankTenths, purchasesTenths, history,
  };
}

/** A settled supplementary fetch's value, or null with a logged reason. */
function settledValue(result, what) {
  if (result.status === 'fulfilled') return result.value;
  console.warn(`[squadImport] ${what} unavailable:`, result.reason?.message ?? result.reason);
  return null;
}

/**
 * Purchase price of every squad member, in tenths. Bought players cost what
 * their latest purchase cost; players owned since the squad was built cost
 * their price in the squad's first gameweek.
 *
 * @returns {Promise<Object<number, number>>}  playerId -> tenths
 */
async function priceSquad(playerIds, transfers, history, fetchSummary) {
  const bought = new Set(transfers.map(t => t.inId));
  const originals = playerIds.filter(id => !bought.has(id));
  const firstGw = history?.gws.length ? Math.min(...history.gws.map(g => g.gw)) : null;
  const initialPrices = new Map();

  if (firstGw === 1) {
    // MODEL: FPL prices do not move before the GW1 deadline, so a squad built
    // for GW1 paid each player's start-of-season price: today's price less the
    // season's change (costChangeStart is in tenths).
    for (const id of originals) {
      const player = store.getPlayer(id);
      if (player) initialPrices.set(id, toTenths(player.price) - (player.costChangeStart ?? 0));
    }
  } else if (firstGw !== null && originals.length > 0) {
    // A later start: what each player cost in the squad's first gameweek, from
    // his element-summary. At most 15 requests, on an explicit import only.
    const results = await Promise.allSettled(originals.map(id => fetchSummary(id)));
    results.forEach((result, i) => {
      const summary = settledValue(result, `player ${originals[i]} price history`);
      const row = summary && normalisePlayerSummary(summary).history
        .find(h => h.gw === firstGw && h.priceTenths !== null);
      if (row) initialPrices.set(originals[i], row.priceTenths);
    });
  }

  const ledger = buildPurchaseLedger(transfers, playerIds, id => initialPrices.get(id) ?? null);
  return Object.fromEntries(ledger);
}
