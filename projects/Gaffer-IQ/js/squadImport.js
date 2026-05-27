/**
 * js/squadImport.js
 * Layer: module utility. Shared squad-import logic used by dashboard.js and
 * planner.js. Read-only — never writes to the FPL account, never touches
 * credentials. Team ID is persisted in localStorage only, never in a URL param.
 *
 * Exports:
 *   loadSavedTeamId()     → number|null
 *   saveTeamId(id)        → void
 *   resolveImportGw()     → number|null  (the GW whose picks to import)
 *   fetchAndMapSquad(teamId, gw) → Promise<ImportResult>
 *
 * See ROADMAP.md Phase 4-1.
 */

import { store }                      from './store.js';
import { fetchSquadPicks, fetchEntryInfo } from './api.js';

/** localStorage key for the persisted FPL team ID. */
const LS_KEY = 'gafferiq_fpl_team_id';

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
  } catch { /* quota exceeded or private-mode restriction — non-fatal */ }
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
 * @property {object|null}  entryInfo    Raw FPL entry object (name, team name, rank) or null.
 * @property {number}       missingCount Players in picks not found in the local store.
 */

/**
 * Fetch squad picks for the given team + GW, validate them, map each pick's
 * element id to a local store player, and return the ordered player ID array.
 *
 * Rules:
 *  - fetchSquadPicks is required; failure throws and the caller shows an error.
 *  - fetchEntryInfo is supplementary; failure sets entryInfo=null (non-fatal).
 *  - Players not found in the local store are skipped; missingCount reports how
 *    many were skipped so the caller can warn the user.
 *  - The picks array is returned in the order FPL sends it (GKP → DEF → MID → FWD).
 *
 * @param {number} teamId
 * @param {number} gw
 * @returns {Promise<ImportResult>}
 * @throws {ApiError}  if the picks fetch fails (private team, wrong ID, network)
 */
export async function fetchAndMapSquad(teamId, gw) {
  const [picksRes, entryRes] = await Promise.allSettled([
    fetchSquadPicks(teamId, gw),
    fetchEntryInfo(teamId),
  ]);

  // Picks are required — propagate the error to the caller.
  if (picksRes.status !== 'fulfilled') {
    throw picksRes.reason;
  }

  const rawPicks = picksRes.value?.picks ?? [];
  const entryInfo = entryRes.status === 'fulfilled' ? entryRes.value : null;

  if (entryRes.status !== 'fulfilled') {
    console.warn('[squadImport] fetchEntryInfo failed — entry name/rank unavailable:',
      entryRes.reason?.message ?? entryRes.reason);
  }

  // Map each pick's element (FPL player ID) to a local store player.
  // Picks already arrive sorted by position; preserve that order.
  const playerIds = [];
  let missingCount = 0;

  for (const pick of rawPicks) {
    const id = pick?.element;
    if (!Number.isInteger(id)) continue;
    const player = store.getPlayer(id);
    if (!player) {
      missingCount++;
      continue;
    }
    playerIds.push(id);
  }

  return { playerIds, entryInfo, missingCount };
}
