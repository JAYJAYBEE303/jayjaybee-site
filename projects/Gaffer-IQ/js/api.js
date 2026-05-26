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
    throw new ApiError(`Network failure calling ${path}: ${err.message}`, {
      upstreamStatus: null,
      path,
    });
  }

  // The proxy returns a JSON envelope on both success and error paths.
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`Non-JSON response from proxy for ${path}`, {
      upstreamStatus: response.status,
      path,
    });
  }

  if (!response.ok) {
    const detail = body?.error ?? response.statusText;
    throw new ApiError(`Proxy ${response.status} for ${path}: ${detail}`, {
      upstreamStatus: body?.upstream ?? response.status,
      path,
    });
  }

  return body;
}

/**
 * Fetches the FPL bootstrap-static payload (teams, players, events, types).
 * @returns {Promise<object>}  raw bootstrap-static JSON
 */
export async function fetchBootstrap() {
  return callProxy('bootstrap-static/');
}

/**
 * Fetches the season's full fixture list.
 * @returns {Promise<object[]>}  raw fixtures array
 */
export async function fetchFixtures() {
  return callProxy('fixtures/');
}

/**
 * Fetches a single player's per-GW history and upcoming fixtures.
 * Called lazily — never bulk-fetch all ~700 players' summaries (ARCHITECTURE.md §6).
 * @param {number} playerId  FPL element id (positive integer, 1–4 digits)
 * @returns {Promise<object>}  raw element-summary JSON
 */
export async function fetchPlayerSummary(playerId) {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new ApiError(`Invalid playerId: ${playerId}`, { path: 'element-summary' });
  }
  return callProxy(`element-summary/${playerId}/`);
}

// ─── Phase 3A — Understat (external xG) ──────────────────────────────────────

/**
 * Fetches the Understat league page for the EPL. The proxy extracts the
 * embedded JSON blocks (typically `teamsData`, `datesData`, `playersData`)
 * and returns them keyed by variable name.
 *
 * @returns {Promise<object>}  e.g. { teamsData: {...}, datesData: [...], playersData: [...] }
 */
export async function fetchLeagueXg() {
  return callProxy('league/EPL', 'understat');
}

/**
 * Fetches a single team's Understat season page (per-match xG / xGA / shots).
 * @param {string} teamSlug  Understat URL slug (e.g. 'Arsenal', 'Manchester_City')
 * @returns {Promise<object>}  embedded JSON blocks for that team's season
 */
export async function fetchTeamXg(teamSlug) {
  if (typeof teamSlug !== 'string' || !/^[A-Za-z_]+$/.test(teamSlug)) {
    throw new ApiError(`Invalid Understat teamSlug: ${teamSlug}`, { path: 'understat-team' });
  }
  return callProxy(`team/${teamSlug}/${UNDERSTAT_SEASON}`, 'understat');
}
