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
// "current season" form. Client-facing path stays `league/EPL/{season}` /
// `team/{slug}/{season}` — only the upstream URL this maps to (below) changed.
//
// Cache policy for the two season-scoped entries is computed per request by
// seasonCache() below rather than being a fixed string, because a finished
// season and the live one deserve very different answers.
const UNDERSTAT_FINISHED_SEASON_CACHE = 'public, max-age=31536000, s-maxage=31536000, immutable';
const UNDERSTAT_LIVE_SEASON_CACHE     = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400';

// Cache-Control for a season-scoped Understat path (league or team).
//
// A FINISHED season is immutable: the 2021/22 campaign will never gain another
// match. Those payloads were nonetheless being re-fetched every hour, forever,
// by every visitor — measured at ~2.6MB of the ~3.1MB an app boot pulls from
// Understat. They now cache for a year and, via s-maxage, at Vercel's edge, so
// the cost is paid once for everyone rather than once per browser per hour.
//
// The CURRENT season keeps the short window it always had (it gains a match
// every few days) but gains s-maxage + stale-while-revalidate so the edge
// absorbs the repeat traffic, matching the FPL entries above.
//
// Determined from the season in the PATH, never from anything the client sends
// — cacheability is the server's call, and a client-supplied hint here would be
// a cache-poisoning vector.
//
// KNOWN TRADE-OFF of `immutable`: if Understat ever serves a corrupt payload
// for a finished season, that response sticks for a year with no way to evict
// it — the URL carries no version, so there is nothing to bump. Accepted here
// because these seasons genuinely cannot change and the endpoint has been
// stable, but if it ever bites, the fix is a cache-busting query param on the
// client's request rather than shortening this window.
function seasonCache(path) {
  // Understat names a season by the calendar year it STARTED: "2026" is
  // 2026/27, running Aug 2026 → May 2027. Trailing 4 digits on every
  // season-scoped path this function serves.
  const year = Number(path.slice(-4));
  if (!Number.isFinite(year)) return UNDERSTAT_LIVE_SEASON_CACHE;

  // Derived from the date rather than a constant, deliberately: js/config.js
  // documents UNDERSTAT_SEASON as needing a manual bump every close season,
  // and a second hand-maintained copy of that fact over here would go stale
  // silently — as a wrong cache header, which is the hardest kind to notice.
  // July onwards is the new campaign, matching SEASON_BOUNDARY_MONTH.
  const now = new Date();
  const currentSeason = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

  // Strictly-less-than: the season that just ended is already months past its
  // last match by the July boundary, so it is safely final.
  return year < currentSeason ? UNDERSTAT_FINISHED_SEASON_CACHE : UNDERSTAT_LIVE_SEASON_CACHE;
}

const ALLOWED_UNDERSTAT_PATTERNS = [
  // Full league — every PL club's match-by-match history for one season.
  { name: 'leagueEpl',  pattern: /^league\/EPL\/\d{4}$/,      cacheFor: seasonCache },
  // Single-team season — e.g. team/Arsenal/2025. Slug uses underscores.
  { name: 'teamSeason', pattern: /^team\/[A-Za-z_]+\/\d{4}$/, cacheFor: seasonCache },
  // Single match — e.g. match/31180. Unlike the two endpoints above this is a
  // real HTML page, not a JSON endpoint: Understat SERVER-RENDERS the match
  // timeline (every goal, card and substitution with its minute) into the
  // markup, and publishes those minutes nowhere in JSON — getMatchData carries
  // goal minutes and rosters but only card COUNTS. A finished match never
  // changes, so this caches for a day rather than an hour.
  //
  // The proxy stays JSON-only from the client's point of view: it wraps the
  // markup as { html }. Parsing lives client-side in js/api.js.
  { name: 'matchPage', pattern: /^match\/\d{1,8}$/, cache: 'public, max-age=86400', html: true },
  // Same match as JSON — rosters (full lineups, positions, minutes played,
  // substitution linkage) and shots. Shots are the ONLY place an assist is
  // tied to the goal it set up (`player_assisted`); the HTML timeline above
  // names the scorer but never the assister. Fetched alongside the page.
  { name: 'matchData', pattern: /^matchdata\/\d{1,8}$/, cache: 'public, max-age=86400' },
];

const FPL_BASE        = 'https://fantasy.premierleague.com/api/';
const UNDERSTAT_BASE  = 'https://understat.com/';
const USER_AGENT      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * The Cache-Control header for a matched allowlist entry.
 *
 * Most entries carry a fixed `cache` string. Entries whose cacheability depends
 * on WHICH resource was asked for (the season-scoped Understat ones) carry a
 * `cacheFor(path)` function instead. Falling back to no-store rather than to a
 * permissive default means a future entry that declares neither fails closed:
 * an uncached response is a performance bug, a wrongly-cached one is a
 * correctness bug that outlives the deploy that caused it.
 */
function resolveCache(match, path) {
  if (typeof match.cacheFor === 'function') return match.cacheFor(path);
  return match.cache ?? 'no-store, max-age=0';
}

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

  res.setHeader('Cache-Control', resolveCache(match, path));
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
  // match/{id} is already a real page URL and takes no rewrite.
  const upstreamPath = path.startsWith('league/')
    ? path.replace(/^league\//, 'getLeagueData/')
    : path.startsWith('team/')
      ? path.replace(/^team\//, 'getTeamData/')
      : path.startsWith('matchdata/')
        ? path.replace(/^matchdata\//, 'getMatchData/')
        : path;

  const wantsHtml = Boolean(match.html);

  let upstream;
  try {
    upstream = await fetch(`${UNDERSTAT_BASE}${upstreamPath}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: wantsHtml ? 'text/html,application/xhtml+xml' : 'application/json',
        // Only the JSON endpoints are XHR endpoints; a page request that
        // claims to be XHR is exactly the shape bot-detection looks for.
        ...(wantsHtml ? {} : { 'X-Requested-With': 'XMLHttpRequest' }),
        // Understat's bot-detection has previously been sensitive to a
        // missing Referer on direct/proxied requests — send the page a real
        // browser session for this data would have come from.
        // Understat's bot-detection has previously been sensitive to a
        // missing/implausible Referer. matchdata/{id} is our own path name,
        // not a real page — point at the page the data is read from.
        Referer: `${UNDERSTAT_BASE}${path.replace(/^matchdata\//, 'match/')}`,
      },
    });
  } catch (err) {
    return sendError(res, 502, `Understat fetch failed: ${err.message}`, null);
  }

  if (!upstream.ok) {
    return sendError(res, upstream.status, 'Understat upstream returned non-OK', upstream.status);
  }

  if (wantsHtml) {
    let markup;
    try {
      markup = await upstream.text();
    } catch (err) {
      return sendError(res, 502, `Understat page read failed: ${err.message}`, null);
    }
    res.setHeader('Cache-Control', resolveCache(match, path));
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ html: markup });
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

  res.setHeader('Cache-Control', resolveCache(match, path));
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
