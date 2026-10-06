/**
 * js/api.js
 * Layer: data access. The ONLY file in the app that calls fetch().
 * Calls the Vercel proxy (PROXY_BASE_URL?path=…) and returns parsed JSON.
 * Side effects: network I/O. No DOM, no store mutation.
 * Throws typed ApiError on any failure — callers translate to data:error events.
 * See ARCHITECTURE.md §5 (proxy) and §6 (fetch strategy), CONVENTIONS.md §9.
 */

import { UNDERSTAT_SEASON } from './config.js';

// Absolute URL of the Vercel proxy function.
// Using an absolute URL means the app can be embedded on any origin
// (e.g. jayjaybee.com) without the relative path resolving against the
// wrong host. Keep this in sync with the deployed Vercel project URL.
const PROXY_BASE_URL = 'https://gaffer-iq-josh-bailey.vercel.app/api/fpl';

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
  const url = `${PROXY_BASE_URL}?${qs.toString()}`;

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
 * Fetches Understat's full-league data for one PL season. The proxy calls
 * Understat's real getLeagueData endpoint server-side and renames its
 * {teams, players, dates} response to {teamsData, playersData, datesData}.
 *
 * @param {string} season  four-digit start-year, e.g. '2026' for 2026/27 —
 *   REQUIRED, Understat has no "current season" default (confirmed live).
 *   Use config.js UNDERSTAT_SEASON / UNDERSTAT_PREV_SEASON.
 * @returns {Promise<object>}  { teamsData: {...}, datesData: [...], playersData: [...] }
 * @throws {ApiError}  with message "Understat league xG unavailable for <season>: …"
 */
export async function fetchLeagueXg(season) {
  if (typeof season !== 'string' || !/^\d{4}$/.test(season)) {
    throw new ApiError(`Invalid Understat season: ${season}`, { path: 'understat-league' });
  }
  const path = `league/EPL/${season}`;
  try {
    return await callProxy(path, 'understat');
  } catch (err) {
    throw new ApiError(
      `Understat league xG unavailable for ${season}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path },
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

// ─── Understat match timeline (Fixtures tab) ─────────────────────────────────
// Two calls per match, because no single Understat response carries the whole
// picture:
//   match/{id}      HTML page — the server-rendered timeline. The ONLY source
//                   of a MINUTE for cards, and the only place events already
//                   appear in chronological order.
//   matchdata/{id}  JSON — shots, whose `player_assisted` is the ONLY link
//                   between a goal and the assist that set it up.
// The FPL API publishes neither: its per-fixture stats are unordered totals.
//
// The timeline is the backbone and the assists are a pure enrichment, so a
// failure of the JSON call degrades to goals without assists rather than
// losing the feed.

const MATCH_ID_RE = /^\d{1,8}$/;

/**
 * Fetch one Understat match page and parse its timeline.
 * @param {string|number} matchId  Understat match id (engine/channel.js →
 *   findUnderstatMatchId maps an FPL fixture to one)
 * @returns {Promise<MatchEvent[]>}  chronological events; [] if the page has
 *   no timeline (an unplayed match)
 * @throws {ApiError}  on network/proxy failure or unparseable markup
 */
export async function fetchMatchTimeline(matchId) {
  const id = String(matchId);
  if (!MATCH_ID_RE.test(id)) {
    throw new ApiError(`Invalid Understat match id: ${matchId}`, { path: `match/${id}` });
  }

  let body;
  try {
    body = await callProxy(`match/${id}`, 'understat');
  } catch (err) {
    throw new ApiError(
      `Understat match timeline unavailable for ${id}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `match/${id}` },
    );
  }

  if (typeof body?.html !== 'string') {
    throw new ApiError(`Understat match ${id} returned no markup`, { path: `match/${id}` });
  }

  return parseMatchTimeline(body.html);
}

/**
 * Fetch one Understat match's JSON (rosters + shots).
 * @param {string|number} matchId
 * @returns {Promise<object>}  { rosters, shots, tmpl }
 * @throws {ApiError}
 */
export async function fetchMatchData(matchId) {
  const id = String(matchId);
  if (!MATCH_ID_RE.test(id)) {
    throw new ApiError(`Invalid Understat match id: ${matchId}`, { path: `matchdata/${id}` });
  }
  try {
    return await callProxy(`matchdata/${id}`, 'understat');
  } catch (err) {
    throw new ApiError(
      `Understat match data unavailable for ${id}: ${err.message}`,
      { upstreamStatus: err.upstreamStatus ?? null, path: `matchdata/${id}` },
    );
  }
}

/**
 * @typedef {object} MatchEvent
 * @property {number} minute    match minute
 * @property {'home'|'away'} side  which team the event belongs to
 * @property {'goal'|'own_goal'|'yellow'|'red'|'sub'} type
 * @property {string} player    scorer, booked player, or the player coming OFF
 * @property {string|null} playerIn   for a substitution, the player coming on
 * @property {string|null} assist     for a goal, who set it up (from shots JSON)
 * @property {string|null} score      running scoreline at that moment, e.g. '1 - 0'
 */

/**
 * Parse Understat's server-rendered match timeline into structured events.
 *
 * WHY HERE: this is response translation, which is api.js's job. It cannot
 * live in engine/ — DOMParser is a browser API and everything under engine/ is
 * required to be pure and DOM-free (ARCHITECTURE.md §3 hard rule 2).
 *
 * Scraping markup is inherently more fragile than reading JSON, so every step
 * is defensive: an item that doesn't match the expected shape is skipped, and
 * a page with no recognisable timeline yields [] rather than throwing. The
 * caller treats the whole feed as an enrichment and falls back to the FPL
 * event grouping when it comes back empty.
 *
 * Understat's structure, as served:
 *   .timeline-item[.timeline-item-right]   one minute; -right = away team
 *     .timeline-time                       "64'"
 *     .timeline-row                        one event (two rows = two events
 *                                          in the same minute)
 *       a.timeline-player-name             player(s) — two for a substitution
 *       .timeline-match-score              "1 - 0", goals only
 *       i.fas[title]                       "Goal" | "Yellow card" | "Red card"
 *       .timeline-group[title]             "Substituted off" / "Substituted on"
 *                                          — note the sub title is on the GROUP,
 *                                          not on the <i>, which carries only
 *                                          .icon-sub
 *
 * @param {string} html  raw match-page markup
 * @returns {MatchEvent[]}  ordered by minute
 */
export function parseMatchTimeline(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }

  const items = doc.querySelectorAll('.timeline-block .timeline-item');
  const events = [];

  for (const item of items) {
    const minute = parseInt(item.querySelector('.timeline-time')?.textContent ?? '', 10);
    if (!Number.isFinite(minute)) continue;

    // Understat lays the home team's events left and the away team's right.
    const side = item.classList.contains('timeline-item-right') ? 'away' : 'home';

    for (const row of item.querySelectorAll('.timeline-row')) {
      const names = [...row.querySelectorAll('.timeline-player-name')].map(a => a.textContent.trim());
      if (!names.length) continue;

      // Understat hangs the descriptive title in two different places: on the
      // <i> for a goal or card, but on the wrapping .timeline-group for a
      // substitution. Read every title in the row rather than guessing, and
      // treat the sub icon's own class as a second, independent signal.
      const titles = [...row.querySelectorAll('[title]')]
        .map(el => (el.getAttribute('title') ?? '').toLowerCase());
      const hasSubIcon = Boolean(row.querySelector('.icon-sub'));
      const score = row.querySelector('.timeline-match-score')?.textContent.trim() ?? null;

      let type = null;
      if (titles.some(t => t.includes('own goal')))      type = 'own_goal';
      else if (titles.some(t => t.includes('goal')))     type = 'goal';
      else if (titles.some(t => t.includes('yellow')))   type = 'yellow';
      else if (titles.some(t => t.includes('red')))      type = 'red';
      else if (hasSubIcon || titles.some(t => t.includes('substitut'))) type = 'sub';
      if (!type) continue;

      events.push({
        minute,
        side,
        type,
        // For a substitution Understat prints the player going off first.
        player:   names[0],
        playerIn: type === 'sub' ? (names[1] ?? null) : null,
        assist:   null,   // filled by attachAssists() from the shots JSON
        score,
      });
    }
  }

  return events.sort((a, b) => a.minute - b.minute);
}

/**
 * Attach each goal's assister, matching the shots JSON to the timeline on
 * minute + scorer. Both come from Understat, so the names agree exactly and no
 * fuzzy matching is needed.
 *
 * Mutates and returns `events` — a goal whose shot cannot be found simply
 * keeps assist: null, which renders as a goal with no assister rather than as
 * an error.
 *
 * @param {MatchEvent[]} events   from parseMatchTimeline()
 * @param {object} matchData      from fetchMatchData()
 * @returns {MatchEvent[]}        the same array
 */
export function attachAssists(events, matchData) {
  const shots = [
    ...(matchData?.shots?.h ?? []),
    ...(matchData?.shots?.a ?? []),
  ].filter(s => s?.result === 'Goal' && s?.player_assisted);

  if (!shots.length) return events;

  for (const ev of events) {
    if (ev.type !== 'goal') continue;
    const shot = shots.find(s =>
      Number(s.minute) === ev.minute && s.player === ev.player);
    if (shot) ev.assist = shot.player_assisted;
  }

  return events;
}
