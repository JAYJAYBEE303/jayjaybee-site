/**
 * api/fpl.js
 * Layer: serverless (Node.js). CORS proxy for read-only data sources.
 * Validates the requested path against a strict per-source allowlist (anchored
 * regex), defensively normalises input, then fetches and forwards the JSON
 * response with CORS and per-endpoint Cache-Control headers. Contains no
 * analytical logic (the {teams→teamsData, players→playersData, dates→datesData}
 * rename below is a naming adapter for the client's existing contract, not
 * analysis — see the Understat section for why it exists).
 *
 * Two upstream sources:
 *   1. The official FPL API (default — no `source` param, or `source=fpl`).
 *   2. Understat (`source=understat`) — adds external xG / xGA / pressing data.
 *
 * See ARCHITECTURE.md §5 (proxy spec) and §7 (external sources). Phase 3A
 * (ROADMAP.md) added the Understat upstream; Phase 3B (see Understat section
 * below) moved it from HTML-scraping to Understat's real JSON endpoints after
 * the scraped page structure went stale in production.
 */

// ─── FPL allowlist ──────────────────────────────────────────────────────────
// Every entry must match the incoming `path` exactly (anchored ^…$).
// `cache` is the Cache-Control header applied to a successful forward, tuned
// per endpoint per ARCHITECTURE.md §6 (static data caches longer, live never).
const ALLOWED_PATTERNS = [
  { name: 'bootstrap',     pattern: /^bootstrap-static\/$/,                           cache: 'public, s-maxage=300, stale-while-revalidate=600'   },
  { name: 'fixtures',      pattern: /^fixtures\/$/,                                   cache: 'public, s-maxage=600, stale-while-revalidate=3600'  },
  { name: 'fixturesByGw',  pattern: /^fixtures\/\?event=\d{1,2}$/,                    cache: 'public, s-maxage=600, stale-while-revalidate=3600'  },
  { name: 'playerSummary', pattern: /^element-summary\/\d{1,4}\/$/,                   cache: 'public, s-maxage=300, stale-while-revalidate=600'   },
  { name: 'live',          pattern: /^event\/\d{1,2}\/live\/$/,                       cache: 'no-store, max-age=0'                                },
  // Phase 4-1: FPL squad import — read-only entry endpoints (picks + entry info).
  // entryPicks: short-lived cache (60 s) — squad picks can change on deadline.
  // entryInfo: longer cache (5 min) — name/rank seldom change mid-session.
  { name: 'entryPicks',    pattern: /^entry\/\d{1,8}\/event\/\d{1,2}\/picks\/$/,      cache: 'public, s-maxage=60, stale-while-revalidate=120'    },
  { name: 'entryInfo',     pattern: /^entry\/\d{1,8}\/$/,                             cache: 'public, s-maxage=300, stale-while-revalidate=600'   },
  { name: 'me',            pattern: /^me\/$/,                                         cache: 'no-store, max-age=0'                                },
];

// ─── Understat allowlist (Phase 3A, endpoints fixed Phase 3B) ──────────────
// Understat exposes no PUBLIC REST API, but its own site fetches match data
// from internal JSON endpoints (getLeagueData / getTeamData) rather than
// embedding it in page HTML — confirmed live: the page HTML understat.com
// serves today has zero embedded JSON, and both endpoints 404 without an
// explicit season, so a season is REQUIRED on every path, no bare/implicit
// "current season" form. xG data refreshes roughly daily, so a 1h cache is
// plenty. Client-facing path stays `league/EPL/{season}` / `team/{slug}/
// {season}` — only the upstream URL this maps to (below) changed.
const ALLOWED_UNDERSTAT_PATTERNS = [
  // Full league — every PL club's match-by-match history for one season.
  { name: 'leagueEpl',  pattern: /^league\/EPL\/\d{4}$/,      cache: 'public, max-age=3600' },
  // Single-team season — e.g. team/Arsenal/2025. Slug uses underscores.
  { name: 'teamSeason', pattern: /^team\/[A-Za-z_]+\/\d{4}$/, cache: 'public, max-age=3600' },
];

const FPL_BASE        = 'https://fantasy.premierleague.com/api/';
const UNDERSTAT_BASE  = 'https://understat.com/';
const USER_AGENT      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function sendError(res, status, error, upstream = null) {
  res.status(status).json({ error, upstream });
}

export default async function handler(req, res) {
  // CORS — permissive for a personal tool; tighten to the deployment origin later.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  // Handle the OPTIONS preflight that browsers send before cross-origin fetches.
  // Must be answered before any allowlist validation or upstream work — the
  // browser will not send the real GET until this 204 comes back.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Parse query without depending on Vercel-specific req.query helpers.
  // searchParams.get() URL-decodes the value automatically.
  const url    = new URL(req.url, 'http://localhost');
  const source = url.searchParams.get('source');
  const path   = url.searchParams.get('path');

  if (!path) {
    return sendError(res, 400, 'Missing path parameter');
  }

  // Defensive normalisation BEFORE the allowlist check (ARCHITECTURE.md §5
  // step 2). The proxy only ever builds `${base}${path}` — never a full URL
  // from input. These checks make sure `path` is a path fragment, not a
  // smuggled host or escape. Applied uniformly to every upstream.
  if (
    path.includes('..') ||
    path.startsWith('/') ||
    path.startsWith('//') ||
    /^https?:/i.test(path) ||
    /\\/.test(path)
  ) {
    return sendError(res, 400, 'Invalid path');
  }

  if (source === 'understat') {
    return handleUnderstat(res, path);
  }

  return handleFpl(res, path);
}

// ─── FPL upstream ───────────────────────────────────────────────────────────

async function handleFpl(res, path) {
  const match = ALLOWED_PATTERNS.find(({ pattern }) => pattern.test(path));
  if (!match) {
    return sendError(res, 400, 'Path not in allowlist');
  }

  let upstream;
  try {
    upstream = await fetch(`${FPL_BASE}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } catch (err) {
    return sendError(res, 502, `Upstream fetch failed: ${err.message}`, null);
  }

  if (!upstream.ok) {
    return sendError(res, upstream.status, 'Upstream returned non-OK', upstream.status);
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return sendError(res, 502, `Upstream returned non-JSON: ${err.message}`, upstream.status);
  }

  res.setHeader('Cache-Control', match.cache);
  res.status(200).json(data);
}

// ─── Understat upstream (Phase 3A, rewritten Phase 3B) ─────────────────────
// The ORIGINAL Phase 3A design fetched Understat's page HTML and regex-scraped
// `var teamsData = JSON.parse('...')`-style inline blocks. That stopped
// working sometime after Phase 3A shipped — Understat's page HTML no longer
// embeds this data at all; it's fetched by the PAGE ITSELF via an internal
// XHR to a separate JSON endpoint. Confirmed live (2026-07-31) by loading
// both page shapes in a real browser and inspecting document.scripts (zero
// embedded JSON) versus the network log (a 200 OK `getLeagueData`/
// `getTeamData` XHR carrying the actual data) — this had been silently
// returning `parse_failed` on every call in production; Style Clash's
// Understat axes have never had real data as a result, independent of season.
//
// Two things the real endpoint requires that a plain fetch doesn't send by
// default, confirmed by testing without them first (plain GET → 404 even
// with a valid season):
//   1. `X-Requested-With: XMLHttpRequest` — Understat's server appears to
//      gate these endpoints to same-page XHR traffic only.
//   2. An explicit season in the path — there is no "current season" default;
//      the bare form 404s.
async function handleUnderstat(res, path) {
  const match = ALLOWED_UNDERSTAT_PATTERNS.find(({ pattern }) => pattern.test(path));
  if (!match) {
    return sendError(res, 400, 'Path not in Understat allowlist');
  }

  // path is already allowlist-validated above (league/EPL/{season} or
  // team/{slug}/{season}) — reshape to the real internal endpoint. Understat's
  // own convention: 'league/EPL/2025' -> 'getLeagueData/EPL/2025',
  // 'team/Arsenal/2025' -> 'getTeamData/Arsenal/2025'.
  const upstreamPath = path.startsWith('league/')
    ? path.replace(/^league\//, 'getLeagueData/')
    : path.replace(/^team\//, 'getTeamData/');

  let upstream;
  try {
    upstream = await fetch(`${UNDERSTAT_BASE}${upstreamPath}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        // Understat's bot-detection has previously been sensitive to a
        // missing Referer on direct/proxied requests — send the page a real
        // browser session for this data would have come from.
        Referer: `${UNDERSTAT_BASE}${path}`,
      },
    });
  } catch (err) {
    return sendError(res, 502, `Understat fetch failed: ${err.message}`, null);
  }

  if (!upstream.ok) {
    return sendError(res, upstream.status, 'Understat upstream returned non-OK', upstream.status);
  }

  let raw;
  try {
    raw = await upstream.json();
  } catch (err) {
    // Structured error envelope per Phase 3A deliverable — distinct status so
    // the client can degrade gracefully without confusing it with a network 5xx.
    res.status(422).json({
      error: 'parse_failed',
      source: 'understat',
      detail: `Understat returned non-JSON: ${err.message}`,
    });
    return;
  }

  res.setHeader('Cache-Control', match.cache);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(renameUnderstatKeys(raw));
}

/**
 * Understat's real endpoints return { teams, players, dates } (league) or
 * { statistics, players, dates } (team) — renamed here to the {teamsData,
 * playersData, datesData} shape the client (js/engine/style.js, form.js) has
 * always consumed, so the Phase 3A→3B upstream-schema migration is fully
 * contained to this proxy and no client code needed to change. `statistics`
 * (team endpoint only, no league equivalent) passes through unrenamed — the
 * client doesn't currently read it, kept only for forward compatibility.
 *
 * @param {object} raw
 * @returns {object}
 */
function renameUnderstatKeys(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };
  if ('teams'   in out) { out.teamsData   = out.teams;   delete out.teams; }
  if ('players' in out) { out.playersData = out.players; delete out.players; }
  if ('dates'   in out) { out.datesData   = out.dates;   delete out.dates; }
  return out;
}
