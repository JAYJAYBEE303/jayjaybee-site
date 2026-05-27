/**
 * js/api.js
 * Layer: data access. The ONLY file in the app that calls fetch().
 * Calls the Vercel proxy (/api/fpl?path=…) and returns parsed JSON.
 * Side effects: network I/O. No DOM, no store mutation.
 * Throws typed ApiError on any failure — callers translate to data:error events.
 * See ARCHITECTURE.md §5 (proxy) and §6 (fetch strategy), CONVENTIONS.md §9.
 */

import { PROXY_BASE, UNDERSTAT_SEASON } from './config.js';

/**
 * Typed error for any failure originating in the data layer.
 * `upstreamStatus` is the FPL API's status when available; null on network failure
 * or when the failure occurred before reaching the upstream (e.g. client-side validation).
 */
export class ApiError extends Error {
  constructor(message, { upstreamStatus = null, path = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.upstreamStatus = upstreamStatus;
    this.path = path;
  }
}

/**
 * Calls the proxy with the given path fragment and returns parsed JSON.
 * @param {string} path     e.g. 'bootstrap-static/', 'element-summary/123/', 'league/EPL'
 * @param {string} [source] proxy upstream identifier — omit for the default FPL API,
 *                          'understat' to hit the Understat allowlist (Phase 3A).
 * @returns {Promise<object>}  the upstream JSON
 * @throws {ApiError}  on network, proxy, or upstream failure
 */
async function callProxy(path, source) {
  const qs = new URLSearchParams({ path });
  if (source) qs.set('source', source);
  const url = `${PROXY_BASE}?${qs.toString()}`;

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new ApiError(`Network failure reaching proxy for ${path}: ${err.message}`, {
      upstreamStatus: null,
      path,
    });
  }

  // The proxy returns a JSON envelope on both success and error paths.
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      `Proxy returned non-JSON for ${path} (HTTP ${response.status})`,
      { upstreamStatus: response.status, path },
    );
  }

  if (!response.ok) {
    const detail = body?.error ?? response.statusText;
    const upstream = body?.upstream ?? response.status;
    throw new ApiError(
      `Proxy ${response.status} — ${detail}`,
      { upstreamStatus: upstream, path },
    );
  }

  return body;
}

// ─── FPL endpoints ────────────────────────────────────────────────────────────

/**
 * Fetches the FPL bootstrap-static payload (teams, players, events, types).
 * @returns {Promise<object>}  raw bootstrap-static JSON
 * @throws {ApiError}  with message "Failed to load bootstrap data: …"
 */
export async function fetchBootstrap() {
  try {
    return await callProxy('bootstrap-static/');
  } catch (err) {
    throw new ApiError(
      `Failed to load bootstrap data: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: 'bootstrap-static/' },
    );
  }
}

/**
 * Fetches the season's full fixture list.
 * @returns {Promise<object[]>}  raw fixtures array
 * @throws {ApiError}  with message "Failed to load fixtures: …"
 */
export async function fetchFixtures() {
  try {
    return await callProxy('fixtures/');
  } catch (err) {
    throw new ApiError(
      `Failed to load fixtures: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: 'fixtures/' },
    );
  }
}

/**
 * Fetches a single player's per-GW history and upcoming fixtures.
 * Called lazily — never bulk-fetch all ~700 players' summaries (ARCHITECTURE.md §6).
 * @param {number} playerId  FPL element id (positive integer, 1–4 digits)
 * @returns {Promise<object>}  raw element-summary JSON
 * @throws {ApiError}  with message "Failed to load player <id> data: …"
 */
export async function fetchPlayerSummary(playerId) {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new ApiError(`Invalid playerId: ${playerId}`, { path: 'element-summary' });
  }
  try {
    return await callProxy(`element-summary/${playerId}/`);
  } catch (err) {
    throw new ApiError(
      `Failed to load player ${playerId} data: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `element-summary/${playerId}/` },
    );
  }
}

/**
 * Fetches live GW points for every FPL player in the given gameweek.
 * NEVER cached — always re-fetched. The dashboard polls this every 60 s
 * while the GW is in progress. See ARCHITECTURE.md §6 and ROADMAP.md §2C.
 * @param {number} gw  gameweek number (1–38)
 * @returns {Promise<object>}  raw event/live response: { elements: [{ id, stats, explain }] }
 * @throws {ApiError}  with message "Failed to load live points for GW<gw>: …"
 */
export async function fetchLivePoints(gw) {
  if (!Number.isInteger(gw) || gw < 1 || gw > 38) {
    throw new ApiError(`Invalid GW number for live points: ${gw}`, {
      path: `event/${gw}/live/`,
    });
  }
  try {
    return await callProxy(`event/${gw}/live/`);
  } catch (err) {
    throw new ApiError(
      `Failed to load live points for GW${gw}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `event/${gw}/live/` },
    );
  }
}

// ─── Phase 4-1 — FPL squad import (read-only) ────────────────────────────────
// Never write to the FPL account; never handle credentials. Team ID comes from
// the caller (stored in localStorage by squadImport.js). Errors are translated
// to ApiError — callers show a clear message and fall back to manual entry.

/**
 * Fetches an FPL manager's GW squad picks (15 players + captain/vc + subs).
 * @param {number} teamId  FPL manager ID (positive integer up to 8 digits)
 * @param {number} gw      gameweek number (1–38)
 * @returns {Promise<object>}  raw entry/picks JSON: { picks, active_chip, … }
 * @throws {ApiError}  with message "Failed to load squad picks for team <id> GW<gw>: …"
 */
export async function fetchSquadPicks(teamId, gw) {
  if (!Number.isInteger(teamId) || teamId <= 0 || teamId > 99_999_999) {
    throw new ApiError(`Invalid teamId: ${teamId}`, { path: 'entry-picks' });
  }
  if (!Number.isInteger(gw) || gw < 1 || gw > 38) {
    throw new ApiError(`Invalid GW number for squad picks: ${gw}`, { path: 'entry-picks' });
  }
  try {
    return await callProxy(`entry/${teamId}/event/${gw}/picks/`);
  } catch (err) {
    throw new ApiError(
      `Failed to load squad picks for team ${teamId} GW${gw}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `entry/${teamId}/event/${gw}/picks/` },
    );
  }
}

/**
 * Fetches basic info for an FPL manager entry (name, overall rank, team name).
 * @param {number} teamId  FPL manager ID (positive integer up to 8 digits)
 * @returns {Promise<object>}  raw entry JSON: { name, player_first_name, … }
 * @throws {ApiError}  with message "Failed to load entry info for team <id>: …"
 */
export async function fetchEntryInfo(teamId) {
  if (!Number.isInteger(teamId) || teamId <= 0 || teamId > 99_999_999) {
    throw new ApiError(`Invalid teamId: ${teamId}`, { path: 'entry-info' });
  }
  try {
    return await callProxy(`entry/${teamId}/`);
  } catch (err) {
    throw new ApiError(
      `Failed to load entry info for team ${teamId}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `entry/${teamId}/` },
    );
  }
}

// ─── Phase 3A — Understat (external xG) ──────────────────────────────────────
// Failures here are NON-FATAL — callers use Promise.allSettled and continue
// with FPL-only data when these fail. See main.js loadInitialData() and
// ROADMAP.md §3A. Do not call store.setError() for Understat failures.

/**
 * Fetches the Understat league page for the EPL. The proxy extracts the
 * embedded JSON blocks (typically `teamsData`, `datesData`, `playersData`)
 * and returns them keyed by variable name.
 *
 * @returns {Promise<object>}  e.g. { teamsData: {...}, datesData: [...], playersData: [...] }
 * @throws {ApiError}  with message "Understat league xG unavailable: …"
 */
export async function fetchLeagueXg() {
  try {
    return await callProxy('league/EPL', 'understat');
  } catch (err) {
    throw new ApiError(
      `Understat league xG unavailable: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: 'league/EPL' },
    );
  }
}

/**
 * Fetches a single team's Understat season page (per-match xG / xGA / shots).
 * @param {string} teamSlug  Understat URL slug (e.g. 'Arsenal', 'Manchester_City')
 * @returns {Promise<object>}  embedded JSON blocks for that team's season
 * @throws {ApiError}  with message "Understat team xG unavailable for <slug>: …"
 */
export async function fetchTeamXg(teamSlug) {
  if (typeof teamSlug !== 'string' || !/^[A-Za-z_]+$/.test(teamSlug)) {
    throw new ApiError(`Invalid Understat teamSlug: ${teamSlug}`, { path: 'understat-team' });
  }
  try {
    return await callProxy(`team/${teamSlug}/${UNDERSTAT_SEASON}`, 'understat');
  } catch (err) {
    throw new ApiError(
      `Understat team xG unavailable for ${teamSlug}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `team/${teamSlug}/${UNDERSTAT_SEASON}` },
    );
  }
}
