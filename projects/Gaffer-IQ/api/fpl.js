/**
 * api/fpl.js
 * Layer: serverless (Node.js). CORS proxy for the FPL API.
 * Validates the requested path against a strict allowlist (anchored regex),
 * defensively normalises input, then fetches and forwards the JSON response
 * with CORS and per-endpoint Cache-Control headers. Contains no analytical logic.
 * See ARCHITECTURE.md §5 for the full specification and rationale.
 */

// ─── Allowlist ──────────────────────────────────────────────────────────────
// Every entry must match the incoming `path` exactly (anchored ^…$).
// `cache` is the Cache-Control header applied to a successful forward, tuned
// per endpoint per ARCHITECTURE.md §6 (static data caches longer, live never).
const ALLOWED_PATTERNS = [
  { name: 'bootstrap',     pattern: /^bootstrap-static\/$/,           cache: 'public, s-maxage=300, stale-while-revalidate=600'   },
  { name: 'fixtures',      pattern: /^fixtures\/$/,                   cache: 'public, s-maxage=600, stale-while-revalidate=3600'  },
  { name: 'fixturesByGw',  pattern: /^fixtures\/\?event=\d{1,2}$/,    cache: 'public, s-maxage=600, stale-while-revalidate=3600'  },
  { name: 'playerSummary', pattern: /^element-summary\/\d{1,4}\/$/,   cache: 'public, s-maxage=300, stale-while-revalidate=600'   },
  { name: 'live',          pattern: /^event\/\d{1,2}\/live\/$/,       cache: 'no-store, max-age=0'                                },
];

const FPL_BASE  = 'https://fantasy.premierleague.com/api/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function sendError(res, status, error, upstream = null) {
  res.status(status).json({ error, upstream });
}

export default async function handler(req, res) {
  // CORS — permissive for a personal tool; tighten to the deployment origin later.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');

  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Parse query without depending on Vercel-specific req.query helpers.
  // searchParams.get() URL-decodes the value automatically.
  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get('path');

  if (!path) {
    return sendError(res, 400, 'Missing path parameter');
  }

  // Defensive normalisation BEFORE the allowlist check (ARCHITECTURE.md §5
  // step 2). The proxy only ever builds `${FPL_BASE}${path}` — never a full
  // URL from input. These checks make sure `path` is a path fragment, not a
  // smuggled host or escape.
  if (
    path.includes('..') ||
    path.startsWith('/') ||
    path.startsWith('//') ||
    /^https?:/i.test(path) ||
    /\\/.test(path)
  ) {
    return sendError(res, 400, 'Invalid path');
  }

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
