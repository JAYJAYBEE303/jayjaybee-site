/**
 * api/fpl.js
 * Layer: serverless (Node.js). CORS proxy for read-only data sources.
 * Validates the requested path against a strict per-source allowlist (anchored
 * regex), defensively normalises input, then fetches and forwards the JSON
 * response with CORS and per-endpoint Cache-Control headers. Contains no
 * analytical logic.
 *
 * Two upstream sources:
 *   1. The official FPL API (default — no `source` param, or `source=fpl`).
 *   2. Understat (`source=understat`) — adds external xG / xGA data; the JSON
 *      lives inside <script> tags in HTML pages so the handler extracts it
 *      server-side with vanilla string/regex. Vanilla Node only, no npm deps.
 *
 * See ARCHITECTURE.md §5 (proxy spec) and §7 (external sources). Phase 3A
 * (ROADMAP.md) added the Understat upstream.
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

// ─── Understat allowlist (Phase 3A) ─────────────────────────────────────────
// Understat exposes no REST API — the data is embedded as JS string literals
// inside <script> tags on its HTML pages. We allowlist only the two page
// shapes we actually need; everything else is rejected. xG data refreshes
// roughly daily, so a 1h cache is plenty.
const ALLOWED_UNDERSTAT_PATTERNS = [
  // Full league page — embeds teamsData, datesData, playersData for all 20 PL clubs.
  { name: 'leagueEpl',  pattern: /^league\/EPL$/,             cache: 'public, max-age=3600' },
  // Single-team season page — e.g. team/Arsenal/2024. Slug uses underscores;
  // year is exactly four digits.
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

// ─── Understat upstream (Phase 3A) ──────────────────────────────────────────

async function handleUnderstat(res, path) {
  const match = ALLOWED_UNDERSTAT_PATTERNS.find(({ pattern }) => pattern.test(path));
  if (!match) {
    return sendError(res, 400, 'Path not in Understat allowlist');
  }

  let upstream;
  try {
    upstream = await fetch(`${UNDERSTAT_BASE}${path}`, {
      // Understat returns HTML — a realistic browser UA avoids the occasional
      // bot-detection 403. Accept text/html explicitly so we get the rendered
      // page rather than any JSON variant they might add later.
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return sendError(res, 502, `Understat fetch failed: ${err.message}`, null);
  }

  if (!upstream.ok) {
    return sendError(res, upstream.status, 'Understat upstream returned non-OK', upstream.status);
  }

  let html;
  try {
    html = await upstream.text();
  } catch (err) {
    return sendError(res, 502, `Understat returned no body: ${err.message}`, upstream.status);
  }

  let data;
  try {
    data = extractUnderstatData(html);
    if (!data || Object.keys(data).length === 0) {
      throw new Error('No JSON.parse blocks found in Understat HTML');
    }
  } catch (err) {
    // Structured error envelope per Phase 3A deliverable — distinct status so
    // the client can degrade gracefully without confusing it with a network 5xx.
    res.status(422).json({
      error: 'parse_failed',
      source: 'understat',
      detail: err.message,
    });
    return;
  }

  res.setHeader('Cache-Control', match.cache);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(data);
}

/**
 * Extracts every `var <name> = JSON.parse('<uri-encoded-json>');` assignment
 * from an Understat HTML page and returns them keyed by variable name. Pure
 * vanilla string/regex; no npm packages (proxy rule, ARCHITECTURE.md §5).
 *
 * The captured payload is URI-encoded JSON — `decodeURIComponent` + `JSON.parse`
 * is the round-trip. Individual variable decode failures are swallowed so a
 * single malformed block doesn't kill the whole response; the outer handler
 * still 422s if zero blocks parsed.
 */
function extractUnderstatData(html) {
  const re = /var\s+(\w+)\s*=\s*JSON\.parse\('([\s\S]+?)'\)/g;
  const out = {};
  let m;
  while ((m = re.exec(html)) !== null) {
    const varName = m[1];
    const encoded = m[2];
    try {
      out[varName] = JSON.parse(decodeURIComponent(encoded));
    } catch {
      // Skip individual decode failures — other variables may still parse.
    }
  }
  return out;
}
