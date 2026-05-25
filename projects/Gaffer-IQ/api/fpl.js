/**
 * api/fpl.js
 * Layer: serverless (Node.js). CORS proxy for the FPL API.
 * Validates the requested path against a strict allowlist, then fetches and
 * forwards the JSON response. Contains no analytical logic.
 * See ARCHITECTURE.md §5 for the full specification and allowlist rationale.
 */

const ALLOWED_PATTERNS = [
  /^bootstrap-static\/$/,
  /^fixtures\/$/,
  /^fixtures\/\?event=\d{1,2}$/,
  /^element-summary\/\d{1,4}\/$/,
  /^event\/\d{1,2}\/live\/$/,
];

const FPL_BASE = 'https://fantasy.premierleague.com/api/';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const raw = url.searchParams.get('path');

  if (!raw) {
    res.status(400).json({ error: 'Missing path parameter' });
    return;
  }

  let path;
  try {
    path = decodeURIComponent(raw);
  } catch {
    res.status(400).json({ error: 'Invalid path encoding' });
    return;
  }

  // Reject anything that looks like an escape attempt before pattern-matching.
  // The proxy only ever builds `${FPL_BASE}${path}` — never a full URL from input.
  if (
    path.includes('..') ||
    path.startsWith('/') ||
    /^https?:/.test(path) ||
    path.startsWith('//')
  ) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const allowed = ALLOWED_PATTERNS.some(re => re.test(path));
  if (!allowed) {
    res.status(400).json({ error: 'Path not in allowlist' });
    return;
  }

  try {
    const upstream = await fetch(`${FPL_BASE}${path}`, {
      headers: { 'User-Agent': 'Gaffer-IQ/0.1 (personal tool; contact via GitHub)' },
    });
    const data = await upstream.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Upstream fetch failed', detail: err.message });
  }
}
