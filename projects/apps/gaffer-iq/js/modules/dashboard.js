/**
 * js/modules/dashboard.js
 * Layer: module. Owns the DOM for the GW Decision Dashboard view.
 * Side effects: DOM writes, sessionStorage reads/writes, network (live poll).
 * Reads from store; delegates all scoring to engine/composite.js exclusively.
 * No analytical logic lives here — scorePlayer(player, getHorizon(), ctx)
 * is the sole engine call, over the SAME global horizon the Planner reads.
 * Layout: design export FINAL - Dashboard.dc.html (styles css/dashboard.css) —
 * a command bar (gameweek, squad tally, search, import), the squad board /
 * team sheet, and Captain, Breakdown and Risks panels.
 * See ROADMAP.md Phase 2C.
 *
 * Live points (Phase 3C-5):
 *   - When the current GW is live (finished=false, dataChecked=true), the module
 *     fetches event/<gw>/live/ on load and every 60 s via setInterval.
 *   - Polling stops when the user navigates away from the dashboard (hashchange).
 *   - A failed live fetch shows the last known data with a "stale" indicator;
 *     the dashboard never crashes. ARCHITECTURE.md §6: live data is never cached.
 *
 * Subscriptions: data:ready, route:changed, squad:updated
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store }       from '../store.js';
import {
  HORIZONS, SQUAD_LIMITS, SQUAD_TOTAL,
  RANK_ELITE_COUNT_BY_POS, RANK_STRONG_COUNT_BY_POS, RANK_TOP_PERCENTILE, RANK_BOTTOM_PERCENTILE,
} from '../config.js';
import { buildScoreContext, scorePlayer, rankPlayers, attachRankTiers, bandFromValue } from '../engine/composite.js';
import { groupPerGwSlots }              from '../engine/fixtures.js';
import { pickStartingXI }               from '../engine/lineup.js';
import { fetchLivePoints }               from '../api.js';
import { fetchAndMapSquad, loadSavedTeamId, saveTeamId, resolveImportGw } from '../squadImport.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The window every score on this page is computed over.
 *
 * The global horizon, NOT the GW1 lock this module used to carry. A player's
 * chip appears on both this page and the Planner, and under two different
 * windows the same player read 81 here and 84 there — a difference with a real
 * reason behind it (this page answered "this week", the Planner "the next
 * five") that no one reading two chips could see, and which therefore read as
 * one of the two numbers being wrong.
 *
 * The cost is real and was accepted deliberately: the Starting XI and the
 * captain pick are now chosen on a multi-gameweek average, so a player who
 * BLANKS in the upcoming gameweek can still be picked to start it. Read
 * buildFixtureContextLabel's line in the Breakdown panel to see which fixtures
 * a given score actually covers.
 *
 * A function, not a const: it re-reads the store each call, so restoring the
 * horizon switcher needs no change here. Same shape as planner.js's getHorizon.
 */
function getHorizon() {
  return HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW5;
}

/**
 * minutesSecurity below this threshold → "Rotation Risk" flag.
 * Mirrors MIN_SEC_LEVELS[1].threshold in ranker.js (0.65 = "Likely" cutoff).
 */
const MIN_SEC_RISK = 0.65;

/** Live poll interval — 60 s per ROADMAP.md §2C / ARCHITECTURE.md §6. */
const LIVE_POLL_INTERVAL_MS = 60_000;

// ─── Display constants ───────────────────────────────────────────────────────

const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];
const POS_NAME  = { GKP: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };
const BAND_LABEL = {
  excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral',
  tough: 'Tough', brutal: 'Brutal', extreme: 'Extreme',
};
/** Rank tier as a short label — same wording and config counts as the Ranker's. */
const TIER_SHORT = {
  positionBest:     pos => `Best ${pos}`,
  positionElite:    pos => `Top ${RANK_ELITE_COUNT_BY_POS[pos]} ${pos}`,
  positionStrong:   pos => `Top ${RANK_STRONG_COUNT_BY_POS[pos]} ${pos}`,
  topPercentile:    () => `Top ${Math.round(RANK_TOP_PERCENTILE * 100)}%`,
  midPercentile:    () => `Middle ${Math.round((1 - RANK_TOP_PERCENTILE - RANK_BOTTOM_PERCENTILE) * 100)}%`,
  bottomPercentile: () => `Bottom ${Math.round(RANK_BOTTOM_PERCENTILE * 100)}%`,
};
const GW_STATE_LABEL = { live: 'Live', 'pre-deadline': 'Pre-deadline', finished: 'Finished', 'off-season': 'Off season' };
const VIEW_KEY = 'gq-dash-view';
/** Read per call, not at import: the unit tests import this module under Node. */
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ─── Module-level state ───────────────────────────────────────────────────────
//
// NOTE: the squad itself is NOT module-level state — it lives in store.js
// (store.getSquad()/setSquad()) so Dashboard and Planner share one source of
// truth. See afterSquadChange() and initDashboard()'s 'squad:updated' subscription.

// ─── Import state (Phase 4-1) ─────────────────────────────────────────────────

/** FPL team ID last used for a successful import, or null. */
let _importedTeamId = null;

/** Raw FPL entry object from last import (name, rank, etc.), or null. */
let _importedEntryInfo = null;

/** True while an import fetch is in flight — prevents concurrent imports. */
let _importInFlight = false;

/** Map<playerId, scorePlayer result> — rebuilt on data:ready + squad changes. */
let _scores = new Map();

/**
 * Map<playerId, rankTier|null> — EVERY player's standing against the full
 * pool (FEATURE_ENGINE.md §13), not just the squad. null until computed.
 * Deliberately NOT rebuilt on every squad edit: the ranking depends only on
 * ctx/horizon, not on squad membership, so recomputing it on every add/remove
 * would re-score ~700 players per click for no reason. Rebuilt once per
 * data:ready (see onDataReady) and reused across squad edits.
 */
let _rankTierByPlayerId = null;

/** Active position set for the search dropdown filter. */
let _searchPosSet = new Set(['GKP', 'DEF', 'MID', 'FWD']);

/** True once data:ready has fired at least once. */
let _dataReady = false;

/**
 * True once wireDom() has successfully cached DOM refs and attached listeners.
 * Guards against double-wiring if data:ready fires more than once.
 */
let _domWired = false;

// ─── Live points state (Phase 3C-5) ──────────────────────────────────────────

/**
 * Map<playerId, number> of live GW points, or null if not yet fetched.
 * Populated by the live poll; cleared on each data:ready so a new GW starts
 * fresh. ARCHITECTURE.md §6: live data is never cached across fetches.
 */
let _livePoints = null;

/**
 * True when the most recent live poll failed and _livePoints holds stale data.
 * The UI shows a "data may be delayed" note; the dashboard never crashes.
 */
let _liveStale  = false;

/** When the live points last refreshed successfully — shown in the GW meta. */
let _liveUpdatedAt = null;

/** setInterval handle while live polling is active; null otherwise. */
let _pollTimer  = null;

// ─── Presentation state ──────────────────────────────────────────────────────

let _view      = 'board';   // 'board' | 'sheet'
let _viewBusy  = false;
let _openId    = null;      // player shown in the Breakdown panel
let _sIdx      = 0;         // active search result
let _results   = [];        // search results as last rendered: [{ id, disabled }]
let _order     = [];        // J/K order: players as the current view lists them
let _animNext  = true;      // play entrances on the next settled render
let _capLast   = { id: null, ep: 0 };
let _raf       = 0;

// ─── DOM refs (populated in wireDom, called from onDataReady) ────────────────

let _root          = null;
let _cmd           = null;
let _searchInput   = null;
let _searchResults = null;
let _board         = null;
let _boardSec      = null;
let _cap           = null;
let _why           = null;
let _risk          = null;

// Import panel refs (Phase 4-1)
let _importBtn     = null;
let _importPanel   = null;
let _importIdInput = null;
let _importStatus  = null;
let _importInfo    = null;
/** The "Where do I find my Team ID?" row. Import and help share the slot
 *  under the command bar, so only one may be open. */
let _importHelp    = null;
let _helpBtn       = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/**
 * True when a scorePlayer result has at least one estimated sub-metric.
 * scorePlayer does not expose a single confidence number, so we check the
 * breakdown directly. Drives the dashed "estimated" chip treatment.
 */
function isScoreEstimated(score) {
  return Boolean(score?.breakdown?.form?.estimated || score?.breakdown?.counter?.estimated);
}

// ─── Score breakdown (Phase 6) ────────────────────────────────────────────────

/**
 * scorePlayer's breakdown is { form, fixture, counter } (FEATURE_ENGINE.md §10)
 * — a different shape from scoreFixture's { baseDifficulty, counterMatchup,
 * teamForm, homeAway, history } breakdown. ARCHITECTURE.md §8: every displayed
 * score must be explainable via its breakdown — the Breakdown panel and the
 * board's Form · Fix · Ctr bars render these three.
 */
const BREAKDOWN_ORDER  = ['form', 'fixture', 'counter'];
const BREAKDOWN_LABELS = { form: 'Form', fixture: 'Fixture', counter: 'Counter' };

/**
 * Build the "which fixture is this" context line for a breakdown panel.
 *
 * Names the NEAREST gameweek in the score's window — which may hold TWO
 * fixtures. This previously read perGw[0] and discarded the second, which is
 * precisely the information a user opens this line to check on a double: it is
 * the sanity check on the captaincy pick, and it was telling half the truth.
 *
 * Since the page came off its GW1 lock the window runs past that gameweek, so
 * the horizon's own label is appended: naming one fixture beside a number that
 * read five would be the same half-truth in a new place.
 *
 * @param {object} score  a scorePlayer result
 * @param {{label: string, gws: number}} [horizon]  the window `score` covers.
 *   Omitted (the unit tests' shape) means "describe the nearest gameweek only".
 * @returns {string}
 */
export function buildFixtureContextLabel(score, horizon = null) {
  const slot   = groupPerGwSlots(score?.perGw ?? [])[0];
  const window = (horizon && horizon.gws > 1) ? ` · ${horizon.label}` : '';
  if (!slot) return (horizon ?? getHorizon()).label;
  if (slot.isBlank) return `GW${slot.gw} — Blank${window}`;

  const fixtures = slot.fixtures
    .map(f => `${f.opponent ?? '?'} (${f.venue ?? '?'})`)
    .join(', ');
  const marker = slot.isDouble ? ' (double)' : '';
  return `GW${slot.gw}${marker} vs ${fixtures}${window}`;
}

function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
    teamXgBySlug: store.getAllTeamXg(),
    currentGw: store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
  });
}

// ─── GW state detection (Phase 3C-5) ─────────────────────────────────────────

/**
 * Returns the current GW's live state based on the normalised season events.
 * Requires data:ready to have fired; returns 'off-season' if no data.
 *
 * States:
 *   'live'         — GW in progress: isCurrent, not finished, data_checked (FPL
 *                    has processed at least one fixture's data).
 *   'pre-deadline' — GW upcoming: isCurrent, not finished, not yet data_checked.
 *   'finished'     — every match in the current GW has been played.
 *   'off-season'   — no current GW (between seasons or unrecognised state).
 *
 * See normalise.js → events[].dataChecked for how data_checked is exposed, and
 * events[].complete for why the finished test does not read `finished`.
 * @returns {'live'|'pre-deadline'|'finished'|'off-season'}
 */
function getGwState() {
  const currentGwId = store.getCurrentGw();
  if (!currentGwId) return 'off-season';
  const ev = store.getEvents().find(e => e.id === currentGwId);
  if (!ev) return 'off-season';
  // `complete`, not `finished`: FPL holds `finished` back until bonus is
  // confirmed, and until then a round whose last match ended yesterday reads
  // as neither finished nor data_checked — i.e. 'pre-deadline'.
  if (ev.complete) return 'finished';
  if (ev.dataChecked) return 'live';
  return 'pre-deadline';
}

// ─── Live polling (Phase 3C-5) ────────────────────────────────────────────────

/**
 * Fetch live points for the current GW and cache in _livePoints.
 * On failure: sets _liveStale=true and keeps the last known data.
 * Guards against fetching when not on the dashboard (stops the poll).
 */
async function fetchAndCacheLivePoints() {
  // Guard: stop polling silently if user has navigated away.
  const hash = window.location.hash.slice(1) || 'matchup';
  if (hash !== 'dashboard') {
    stopLivePoll();
    return;
  }

  const gw = store.getCurrentGw();
  if (!gw) return;

  try {
    const raw = await fetchLivePoints(gw);
    const map = new Map();
    for (const el of raw?.elements ?? []) {
      if (Number.isInteger(el.id) && typeof el.stats?.total_points === 'number') {
        map.set(el.id, el.stats.total_points);
      }
    }
    _livePoints = map;
    _liveStale  = false;
    _liveUpdatedAt = new Date();
  } catch (err) {
    // Non-fatal: preserve last known data and flag stale. CONVENTIONS.md §9.
    _liveStale = true;
    console.warn('[dashboard] Live points fetch failed — showing stale data:', err.message ?? err);
  }

  render();
}

/**
 * Start the live poll. No-op if already polling.
 * Immediately fires the first fetch, then repeats every LIVE_POLL_INTERVAL_MS.
 */
function startLivePoll() {
  if (_pollTimer !== null) return;
  fetchAndCacheLivePoints();
  _pollTimer = setInterval(fetchAndCacheLivePoints, LIVE_POLL_INTERVAL_MS);
}

/**
 * Stop the live poll. No-op if not polling.
 * Called on hashchange away from dashboard, on data:ready (reset), and on
 * GW state transition to finished/pre-deadline.
 */
function stopLivePoll() {
  if (_pollTimer === null) return;
  clearInterval(_pollTimer);
  _pollTimer = null;
}

/**
 * Evaluate whether live polling should be running given the current hash and
 * GW state. Start or stop accordingly.
 */
function reconcileLivePoll() {
  const hash = window.location.hash.slice(1) || 'matchup';
  if (hash === 'dashboard' && _dataReady && getGwState() === 'live') {
    startLivePoll();
  } else {
    stopLivePoll();
  }
}

// ─── Squad management ─────────────────────────────────────────────────────────
// Reads store.getSquad() directly rather than caching a local copy — the
// store is the only source of truth (CONVENTIONS.md §8), and afterSquadChange()
// (subscribed to 'squad:updated') is what re-renders after any mutation, from
// either this module or Planner.

function squadCountByPos(pos) {
  return store.getSquad().filter(id => store.getPlayer(id)?.position === pos).length;
}

function isInSquad(playerId) {
  return store.getSquad().includes(playerId);
}

/**
 * Returns true if the given player can legally be added to the squad
 * (squad not full, position slot available, not already present).
 */
function canAdd(player) {
  if (!player) return false;
  if (store.getSquad().length >= SQUAD_TOTAL) return false;
  if (isInSquad(player.id)) return false;
  if (squadCountByPos(player.position) >= SQUAD_LIMITS[player.position]) return false;
  return true;
}

function addPlayer(playerId) {
  const player = store.getPlayer(playerId);
  if (!player || !canAdd(player)) return;
  // afterSquadChange() runs via the 'squad:updated' subscription, not a direct
  // call here — the same path Planner's edits take, so both modules react
  // identically regardless of which one made the change.
  store.setSquad([...store.getSquad(), playerId]);
}

function removePlayer(playerId) {
  const squad = store.getSquad();
  const idx = squad.indexOf(playerId);
  if (idx < 0) return;
  const next = squad.slice();
  next.splice(idx, 1);
  store.setSquad(next);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score every player in the squad over the global horizon (see getHorizon).
 * Populates _scores. Silently skips players whose team is absent from ctx.
 */
function scoreSquad() {
  if (!_dataReady) return;
  const ctx = buildCtx();
  if (!ctx) return;
  _scores = new Map();
  for (const id of store.getSquad()) {
    const player = store.getPlayer(id);
    if (!player) continue;
    try {
      _scores.set(id, scorePlayer(player, getHorizon(), ctx));
    } catch (err) {
      console.warn('[dashboard] scorePlayer failed for player', id, err.message ?? err);
    }
  }
  ensureRankTiers(ctx);
}

/**
 * Rank tier (FEATURE_ENGINE.md §13) needs a player's standing against the
 * FULL player pool, not just the 15-man squad — "top 30 in the game" has to
 * mean the same thing here as on the Ranker/Planner. Computed once per data
 * load and cached (see _rankTierByPlayerId) — the ranking doesn't depend on
 * squad membership, so there's no reason to re-score ~700 players on every
 * add/remove click. Same per-load cost the Ranker already accepts as normal;
 * this module just doesn't pay it repeatedly.
 */
function ensureRankTiers(ctx) {
  if (_rankTierByPlayerId !== null) return;
  try {
    const ranked = attachRankTiers(rankPlayers(store.getPlayers(), getHorizon(), ctx));
    _rankTierByPlayerId = new Map(ranked.map(r => [r.player.id, r.rankTier]));
  } catch (err) {
    console.warn('[dashboard] full-pool rank computation failed', err?.message ?? err);
    _rankTierByPlayerId = new Map();
  }
}

// ─── Risk flags ───────────────────────────────────────────────────────────────

/**
 * Compute risk flag keys for a player + scorePlayer result pair.
 * @param {Player} player
 * @param {object} score  scorePlayer output
 * @returns {Array<'rotation'|'fixture'|'confidence'|'availability'>}
 */
function getRiskFlags(player, score) {
  const flags = [];
  const ms = score.breakdown?.form?.minutesSecurity ?? 0;
  if (ms < MIN_SEC_RISK)               flags.push('rotation');
  // Both bottom tiers, not just 'brutal': the seven-tier scale split the old
  // 0-25 band in two (21-35 brutal, 0-20 extreme), so testing 'brutal' alone
  // would silently stop flagging the very worst fixtures in the app.
  if (score.band === 'brutal' || score.band === 'extreme') flags.push('fixture');
  if (score.breakdown?.form?.estimated) flags.push('confidence');
  if (player.status !== 'available')    flags.push('availability');
  return flags;
}

const FLAG_LABELS = {
  rotation:     'Rotation Risk',
  fixture:      'Tough Fixture',
  confidence:   'Low Confidence',
  availability: 'Availability Doubt',
};

// ─── Decisions model ──────────────────────────────────────────────────────────

/**
 * Everything the page shows, worked out once per render from the store and
 * the engine results already in _scores. Selection only — every number here
 * is an engine output read as-is.
 *
 * phase:
 *   'loading'  — no data yet
 *   'partial'  — fewer than 15 players: no XI, no captain
 *   'settling' — the Understat prefetch hasn't settled. The captain, the XI and
 *                the bench are all a RANKING of the squad by a score that is
 *                still settling; rendering now would name a captain and then
 *                silently name a different one when the last payload landed,
 *                which is the one thing a recommendation panel must not do.
 *   'ready'
 */
function buildModel() {
  const squad = store.getSquad().filter(id => store.getPlayer(id));
  const settled = store.isTeamXgSettled();
  const entries = squad
    .map(id => ({ player: store.getPlayer(id), score: _scores.get(id) }))
    .filter(e => e.score);

  const phase = !_dataReady ? 'loading'
    : squad.length < SQUAD_TOTAL ? 'partial'
    : (!settled || entries.length < SQUAD_TOTAL) ? 'settling'
    : 'ready';

  const m = { squad, settled, phase, entries, xi: [], bench: [], captain: null, ladder: [], role: new Map(), formation: '' };
  if (phase !== 'ready') return m;

  const { xi, bench } = pickStartingXI(entries);

  // Captaincy picks the highest real points-scale projection (expectedPoints),
  // NOT the 0-100 composite `score.value` — that composite is a normalised
  // quality score meant for within-position comparisons and does not scale
  // with a position's actual scoring ceiling, so it can rank a merely-solid
  // defender above a genuinely higher-scoring midfielder/forward. See
  // calcExpectedPoints in engine/composite.js and FEATURE_ENGINE.md §10.2.
  const captainEntry = xi.reduce(
    (best, e) => (!best || e.score.expectedPoints.value > best.score.expectedPoints.value ? e : best),
    null,
  );

  m.xi = xi;
  m.bench = bench;
  m.captain = captainEntry;
  // The captaincy ladder: the XI by that same projection, best first.
  m.ladder = xi.slice().sort((a, b) => b.score.expectedPoints.value - a.score.expectedPoints.value);
  xi.forEach(e => m.role.set(e.player.id, e.player.id === captainEntry?.player.id ? 'C' : 'XI'));
  bench.forEach((e, i) => m.role.set(e.player.id, `B${i + 1}`));
  const n = pos => xi.filter(e => e.player.position === pos).length;
  m.formation = `${n('DEF')}-${n('MID')}-${n('FWD')}`;
  return m;
}

// ─── Build: HTML fragments ────────────────────────────────────────────────────

function chipHTML(band, text, { size = '', est = false, title = '' } = {}) {
  return `<span class="chip${size ? ` chip--${size}` : ''}${est ? ' is-est' : ''}"`
    + `${band ? ` data-band="${band}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
}

function pendingChipHTML(size = '') {
  return `<span class="chip${size ? ` chip--${size}` : ''} is-pending" aria-hidden="true"`
    + ` title="Still calculating — waiting on league-wide counter-matchup data">00</span>`;
}

function crestHTML(team, size = '') {
  return team?.badgeUrl
    ? `<img class="crest${size ? ` crest--${size}` : ''}" src="${esc(team.badgeUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : '';
}

function statusHTML(player) {
  if (player.status === 'available') return '';
  return `<span class="stat${player.status === 'doubtful' ? ' stat--d' : ''}" title="${esc(player.statusNote || player.status)}">!</span>`;
}

function tierShort(rankTier, pos) {
  return TIER_SHORT[rankTier]?.(pos) ?? '';
}

function price(player) {
  return (typeof player.price === 'number' && !isNaN(player.price)) ? `£${player.price.toFixed(1)}m` : '£?.?m';
}

/** The score chip, or its placeholder while the score is still settling. */
function scoreChipHTML(player, score, settled, size = '') {
  if (!score || !settled) return pendingChipHTML(size);
  const v = Math.round(score.value);
  const est = isScoreEstimated(score);
  const tier = tierShort(_rankTierByPlayerId?.get(player.id), player.position);
  return chipHTML(score.band, String(v), { size, est,
    title: `${v} ${BAND_LABEL[score.band] ?? ''}${tier ? ` · ${tier} in the game` : ''}${est ? ' · estimated — limited data' : ''}` });
}

/** The nearest gameweek's opponents, short: "MCI A + LIV H" / "Blank". */
function nextShort(score, full = false) {
  const slot = groupPerGwSlots(score?.perGw ?? [])[0];
  if (!slot) return '—';
  if (slot.isBlank) return 'Blank';
  const teamByShort = full ? new Map(store.getTeams().map(t => [t.shortName, t.name])) : null;
  return slot.fixtures
    .map(f => (full ? `${teamByShort.get(f.opponent) ?? f.opponent ?? '?'} (${f.venue ?? '?'})` : `${f.opponent ?? '?'} ${f.venue ?? ''}`))
    .join(full ? ', ' : ' + ');
}

/** One bar per breakdown component, the board's mini Form · Fix · Ctr. */
function ffcHTML(score, settled) {
  if (!score || !settled) return '<span class="ffc wd" aria-hidden="true"></span>';
  return `<span class="ffc wd">${BREAKDOWN_ORDER.map(k => {
    const c = score.breakdown?.[k];
    if (!c) return '<span></span>';
    const v = Math.round(c.value), band = bandFromValue(v);
    return `<span data-band="${band}" title="${BREAKDOWN_LABELS[k]} ${v} ${BAND_LABEL[band] ?? ''}, weight ${Math.round(c.weight * 100)}%${c.estimated ? ', estimated' : ''}">`
      + `<b>${c.estimated ? '~' : ''}${v}</b><span class="mbar" aria-hidden="true"><span class="${c.estimated ? 'is-est' : ''}" style="width:${v}%"></span></span></span>`;
  }).join('')}</span>`;
}

/** Per-gameweek fixture strip: one slot per GW, a double's two cells side by side. */
function stripHTML(score, settled) {
  if (!score || !settled) return '<span class="strip wd" aria-hidden="true"></span>';
  const slots = groupPerGwSlots(score.perGw);
  return `<span class="strip wd" role="list" aria-label="${esc(horizonRange())}">${slots.map(slot => {
    if (slot.isBlank) {
      return `<span role="listitem"><span class="cell cell--blank" title="GW${slot.gw} · Blank gameweek">–</span></span>`;
    }
    return `<span role="listitem">${slot.fixtures.map(f => {
      const v = Math.round(f.value);
      const title = `GW${slot.gw} · ${f.opponent ?? '?'} (${f.venue ?? '?'}) ${v} ${BAND_LABEL[f.band] ?? ''}`
        + `${slot.isDouble ? ' · double' : ''}${f.provisional ? ' · estimated' : ''}${f.provisionalKickoff ? ' · kickoff TBC' : ''}`;
      return `<span class="cell${f.provisional ? ' is-est' : ''}" data-band="${esc(f.band)}" title="${esc(title)}" aria-label="${esc(title)}">${v}</span>`;
    }).join('')}</span>`;
  }).join('')}</span>`;
}

/** Live points for one player: raw, ×2 for the captain (FPL doubles them). */
function liveOf(playerId, isCap) {
  if (!_livePoints) return null;
  const pts = _livePoints.get(playerId) ?? 0;
  return { pts, shown: isCap ? pts * 2 : pts,
    full: isCap ? `Live: ${pts}pts (×2 = ${pts * 2}pts)` : `Live: ${pts}pts` };
}

/** The gameweek window the scores cover, as "GW8–12". */
function horizonRange() {
  const h = getHorizon();
  const start = store.getUpcomingGw() ?? store.getCurrentGw() ?? 1;
  return h.gws > 1 ? `GW${start}–${start + h.gws - 1}` : `GW${start}`;
}

function boardCols(showLive) {
  return _boardSec?.classList.contains('is-wide')
    ? `40px minmax(120px,1.3fr) minmax(84px,.9fr) 40px 104px 150px 40px 36px${showLive ? ' 40px' : ''} 44px 28px`
    : '36px minmax(0,1fr) 40px 36px 28px';
}

// ─── Render: command bar ─────────────────────────────────────────────────────

function renderCmd() {
  if (!_root) return;
  const squad = store.getSquad();
  const tally = _root.querySelector('#db-tally');
  tally.title = `${squad.length} / ${SQUAD_TOTAL} players selected`;
  tally.querySelector('b').textContent = `SQUAD ${squad.length}/${SQUAD_TOTAL}`;
  tally.querySelector('.tally__bar > span').style.transform = `scaleX(${squad.length / SQUAD_TOTAL})`;

  const tag = _root.querySelector('#db-gw');
  const meta = _root.querySelector('#db-gw-meta');
  const stale = _root.querySelector('#db-stale');
  if (!_dataReady) {
    tag.textContent = 'GW';
    tag.dataset.state = '';
    meta.textContent = 'Loading…';
    stale.hidden = true;
    return;
  }
  // The badge is a fact about the gameweek, not a product of any score, so it
  // shows whenever data is ready.
  const state = getGwState();
  const gw = store.getCurrentGw();
  tag.dataset.state = state;
  tag.textContent = state === 'off-season' ? 'Off season' : `GW${gw} · ${GW_STATE_LABEL[state]}`;
  meta.textContent = gwMeta(state, gw);
  // Only show the stale note when we have some data but it failed to refresh.
  stale.hidden = !(state === 'live' && _liveStale && _livePoints !== null);
}

function gwMeta(state, gw) {
  const hm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (state === 'off-season') return 'No current gameweek';
  if (state === 'finished') {
    const n = store.getFixtures().filter(f => f.gw === gw).length;
    return `All ${n} matches played`;
  }
  if (state === 'live') {
    if (!_liveUpdatedAt) return 'Refreshes every 60s';
    return _liveStale ? `Last update ${hm(_liveUpdatedAt)} · retrying every 60s` : `Updated ${hm(_liveUpdatedAt)} · refreshes every 60s`;
  }
  const deadline = store.getEvents().find(e => e.id === gw)?.deadline;
  if (!deadline) return '';
  const d = new Date(deadline);
  return `Deadline ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${hm(d)}`;
}

// ─── Render: search results dropdown ─────────────────────────────────────────

function showResults() {
  if (!_searchResults) return;
  _searchResults.hidden = false;
  _searchInput?.setAttribute('aria-expanded', 'true');
}

function hideResults() {
  if (!_searchResults) return;
  _searchResults.hidden = true;
  _searchInput?.setAttribute('aria-expanded', 'false');
  _searchInput?.removeAttribute('aria-activedescendant');
}

function renderSearchResults() {
  if (!_searchResults || !_searchInput) return;

  const query = _searchInput.value.trim().toLowerCase();
  _results = [];

  if (query.length < 2) {
    _searchResults.innerHTML = '';
    hideResults();
    return;
  }

  const allPlayers = store.getPlayers();
  if (allPlayers.length === 0) {
    _searchResults.innerHTML = '<li class="empty">Player data not yet loaded — please wait a moment.</li>';
    showResults();
    return;
  }

  let results;
  try {
    results = allPlayers
      .filter(p => {
        if (!_searchPosSet.has(p.position)) return false;
        const name     = (p.name     ?? '').toLowerCase();
        const fullName = (p.fullName ?? '').toLowerCase();
        return name.includes(query) || fullName.includes(query);
      })
      .slice(0, 12);
  } catch (err) {
    console.error('[dashboard] renderSearchResults: filter threw —', err);
    hideResults();
    return;
  }

  if (results.length === 0) {
    _searchResults.innerHTML = '<li class="empty">No players found.</li>';
    showResults();
    return;
  }

  if (_sIdx >= results.length) _sIdx = 0;
  _searchResults.innerHTML = results.map((p, i) => {
    const team         = store.getTeam(p.teamId);
    const inSquad      = isInSquad(p.id);
    const posSlotsFull = squadCountByPos(p.position) >= SQUAD_LIMITS[p.position];
    const squadFull    = store.getSquad().length >= SQUAD_TOTAL;
    const disabled     = inSquad || posSlotsFull || squadFull;
    const reason       = inSquad      ? 'Already in squad'
                       : posSlotsFull ? `${p.position} slots full`
                       : squadFull    ? 'Squad full'
                       : '';
    _results.push({ id: p.id, disabled });
    return `<li id="db-opt-${p.id}" role="option" data-player-id="${p.id}" aria-selected="${i === _sIdx}" aria-disabled="${disabled}"`
      + ` title="${disabled ? esc(reason) : esc(p.fullName || p.name || '')}">`
      + `<span class="pos--${esc(p.position)}">${esc(p.position)}</span>`
      + `<span><b>${esc(p.name ?? '?')}</b><small>${team ? esc(team.shortName) : '—'} · ${esc(p.position ?? '?')} · ${price(p)}</small></span>`
      + `<span>${esc(reason)}</span></li>`;
  }).join('');
  _searchInput.setAttribute('aria-activedescendant', `db-opt-${results[_sIdx].id}`);
  showResults();
}

// ─── Render: board ───────────────────────────────────────────────────────────

function rowHTML(e, m, i, showLive) {
  const { player, score } = e;
  const team = store.getTeam(player.teamId);
  const ready = m.phase === 'ready';
  const role = ready ? m.role.get(player.id) : '';
  const roleTitle = !ready ? 'Waiting on scores' : role === 'C' ? 'Captain' : role === 'XI' ? 'Starting XI' : role ? `Bench ${role.slice(1)}` : '';
  const flags = score && m.settled ? getRiskFlags(player, score) : [];
  const flagText = flags.map(f => FLAG_LABELS[f]).join(' · ');
  const ms = score?.breakdown?.form?.minutesSecurity;
  const live = showLive ? liveOf(player.id, role === 'C') : null;
  const name = player.fullName || player.name;
  const nf = score && m.settled ? Math.round(score.nextFixtureScore.value) : null;
  const nfBand = nf != null ? bandFromValue(nf) : null;
  const aria = `${name}, ${team?.name ?? ''}, ${player.position}, ${price(player)}`
    + (score && m.settled ? `, score ${Math.round(score.value)} ${BAND_LABEL[score.band] ?? ''}` : ', still calculating')
    + (flags.length ? `, flags: ${flagText}` : '');

  return `<div class="row${_openId === player.id ? ' is-open' : ''}" data-row-id="${player.id}" style="--d:${Math.min(i, 20) * 16}ms">`
    + `<span class="role" data-role="${role.startsWith('B') ? 'B' : role}" title="${roleTitle}">${role || '·'}</span>`
    + `<button type="button" class="who" data-rowbtn aria-pressed="${_openId === player.id}" aria-label="${esc(aria)}. Show detail.">`
    + `<span><span class="ell">${esc(name)}</span>${statusHTML(player)}</span>`
    + `<span>${crestHTML(team)}${team ? esc(team.shortName) : '—'} · ${price(player)}</span></button>`
    + `<span class="nx wd">${nf != null ? chipHTML(nfBand, String(nf), { size: 'sm', est: score.nextFixtureScore.estimated,
        title: `Next fixture ${nf} ${BAND_LABEL[nfBand] ?? ''} — fixture + counter-matchup, excluding form` }) : pendingChipHTML('sm')}`
    + `<span class="ell">${esc(nextShort(score))}</span></span>`
    + scoreChipHTML(player, score, m.settled)
    + ffcHTML(score, m.settled)
    + stripHTML(score, m.settled)
    + `<span class="ms r wd${ms != null && ms < MIN_SEC_RISK ? ' is-low' : ''}" title="Minutes security">${ms != null ? `${Math.round(ms * 100)}%` : '–'}</span>`
    + `<span class="ep r" title="Predicted points for GW${store.getUpcomingGw() ?? ''}">${score && m.settled ? score.expectedPoints.value.toFixed(1) : '–'}</span>`
    + (showLive ? `<span class="live r wd${_liveStale ? ' is-stale' : ''}" title="${esc(live?.full ?? '')}">${live?.shown ?? ''}</span>` : '')
    + `<span class="flags wd" title="${esc(flagText)}" aria-label="${esc(flagText || 'No flags')}">${flags.length ? `⚠ ${flags.length}` : ''}</span>`
    + `<button type="button" class="rm" data-remove-id="${player.id}" aria-label="Remove ${esc(name)}">×</button>`
    + '</div>';
}

function boardHTML(m, showLive) {
  if (m.phase === 'loading') {
    return [62, 48, 70, 55, 66, 40, 58, 72, 50, 64].map(w => `<div class="sk-row" aria-hidden="true"><span class="sk" style="--w:${w}%"></span></div>`).join('')
      + '<p class="wait" role="status">Loading player data…</p>';
  }
  const cols = boardCols(showLive);
  let html = '';
  if (_boardSec.classList.contains('is-wide')) {
    html += `<div class="head" style="--cols:${cols}"><span>Role</span><span>Player</span><span>Next</span><span>Score</span>`
      + `<span>Form · Fix · Ctr</span><span>${horizonRange()}</span><span class="r">Mins</span><span class="r">Pred</span>`
      + `${showLive ? '<span class="r">Live</span>' : ''}<span>Flags</span><span></span></div>`;
  }
  if (m.squad.length === 0) {
    const remaining = SQUAD_TOTAL;
    html += `<div class="state" role="status"><b>No squad yet</b><span>Add ${remaining} more players to see GW recommendations. Search above, or import by Team ID.</span></div>`;
  }
  let i = 0;
  _order = [];
  html += POSITIONS.map(pos => {
    // Within a position, best first once scores have settled; until then the
    // squad's own order, so rows never reshuffle under the reader.
    const group = m.squad.map(id => ({ player: store.getPlayer(id), score: _scores.get(id) }))
      .filter(e => e.player.position === pos);
    if (m.settled) group.sort((a, b) => (b.score?.value ?? 0) - (a.score?.value ?? 0));
    const max = SQUAD_LIMITS[pos];
    group.forEach(e => _order.push(e.player.id));
    return `<div role="group" aria-label="${POS_NAME[pos]} ${group.length} of ${max}">`
      + `<div class="grp__hd"><b class="pos--${pos}">${pos}</b><span>${group.length} / ${max}</span></div>`
      + `<div style="--cols:${cols}">${group.map(e => rowHTML(e, m, i++, showLive)).join('')}</div>`
      + Array.from({ length: Math.max(0, max - group.length) }, () => `<div class="empty-slot" aria-label="Empty ${pos} slot">Empty slot</div>`).join('')
      + '</div>';
  }).join('');
  if (m.phase === 'settling') {
    html += '<p class="wait" role="status">Still calculating — waiting on league-wide counter-matchup data.</p>';
  }
  return html;
}

// ─── Render: team sheet ──────────────────────────────────────────────────────

function tokenHTML(e, m, showLive, delay) {
  const { player, score } = e;
  const team = store.getTeam(player.teamId);
  const isCap = m.role.get(player.id) === 'C';
  const flags = getRiskFlags(player, score);
  const live = showLive ? liveOf(player.id, isCap) : null;
  const svg = team?.badgeUrl ? String(team.badgeUrl).replace('/badges/70/', '/badges/').replace(/\.png$/, '.svg') : '';
  return `<button type="button" role="listitem" class="tok${isCap ? ' is-cap' : ''}${_openId === player.id ? ' is-open' : ''}" data-row-id="${player.id}"`
    + ` aria-pressed="${_openId === player.id}" aria-label="${esc(player.fullName || player.name)}${isCap ? ', captain' : ''}. Show detail." style="--d:${delay}ms">`
    + (svg ? `<span class="tok__mark" aria-hidden="true"><span style="background-image:url('${esc(svg)}')"></span></span>` : '')
    + (isCap ? '<span class="tok__c" aria-hidden="true">C</span>' : '')
    + (flags.length ? `<span class="tok__w" aria-hidden="true" title="${esc(flags.map(f => FLAG_LABELS[f]).join(' · '))}">⚠</span>` : '')
    + `<span class="tok__pos pos--${player.position}">${player.position}</span>`
    + `<span class="tok__name">${esc(player.name)}</span>`
    + `<span class="tok__sub">${team ? esc(team.shortName) : '—'} · v ${esc(nextShort(score))}</span>`
    + `<span class="tok__nums">${scoreChipHTML(player, score, true)}<span title="Predicted points">${score.expectedPoints.value.toFixed(1)}</span>`
    + `${live ? `<small class="${_liveStale ? 'live is-stale' : ''}" title="${esc(live.full)}">· ${live.pts} pts</small>` : ''}</span></button>`;
}

function sheetHTML(m, showLive) {
  if (m.phase !== 'ready') {
    const settling = m.phase === 'settling' || m.phase === 'loading';
    const left = SQUAD_TOTAL - m.squad.length;
    return `<div class="state" role="status"><b>${settling ? 'Still calculating' : `${m.squad.length} / ${SQUAD_TOTAL} players selected`}</b>`
      + `<span>${settling ? 'The XI is picked once every score has settled.' : `Add ${left} more player${left === 1 ? '' : 's'} to see GW recommendations.`}</span>`
      + '<button type="button" class="btn btn--sm" data-view="board">Show the board</button></div>';
  }
  const posOrder = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  const xi = m.xi.slice().sort((a, b) => posOrder[a.player.position] - posOrder[b.player.position] || b.score.value - a.score.value);
  _order = xi.map(e => e.player.id).concat(m.bench.map(e => e.player.id));
  const lines = POSITIONS.map((pos, li) => {
    const players = xi.filter(e => e.player.position === pos);
    return `<div class="line" role="group" aria-label="${POS_NAME[pos]}">${players.map((e, ti) => tokenHTML(e, m, showLive, 200 + li * 110 + ti * 45)).join('')}</div>`;
  }).join('');
  const bench = m.bench.map((e, i) => {
    const { player, score } = e;
    const team = store.getTeam(player.teamId);
    const flagged = getRiskFlags(player, score).length > 0;
    return `<li><button type="button" class="bn${_openId === player.id ? ' is-open' : ''}" data-row-id="${player.id}" aria-pressed="${_openId === player.id}"`
      + ` aria-label="Bench ${i + 1}: ${esc(player.fullName || player.name)}. Show detail." style="--d:${640 + i * 50}ms">`
      + `<span>${i + 1}</span><span><b>${esc(player.fullName || player.name)}${flagged ? ' <span class="warn">⚠</span>' : ''}</b>`
      + `<small><b class="pos--${player.position}">${player.position}</b>${crestHTML(team)}${team ? esc(team.shortName) : '—'} · v ${esc(nextShort(score))}</small></span>`
      + `${scoreChipHTML(player, score, true)}</button></li>`;
  }).join('');
  const line = d => `pathLength="1" style="--d:${d}ms"`;
  return '<div class="sheet">'
    + '<div class="pitch"><div class="pitch__lines" aria-hidden="true">'
    + '<svg viewBox="0 0 600 1000" preserveAspectRatio="none">'
    + `<rect x="1" y="1" width="598" height="998" ${line(0)}/><line x1="0" y1="500" x2="600" y2="500" ${line(140)}/>`
    + `<rect x="130" y="0" width="340" height="150" ${line(220)}/><rect x="225" y="0" width="150" height="50" ${line(300)}/>`
    + `<rect x="130" y="850" width="340" height="150" ${line(220)}/><rect x="225" y="950" width="150" height="50" ${line(300)}/>`
    + '</svg><span class="pitch__ring"></span></div>'
    + `<div class="lines" role="list" aria-label="Starting XI, ${m.formation}, goalkeeper at the top">${lines}</div></div>`
    + '<div class="bench"><span class="bench__t"><span class="lbl lbl--sm">Bench</span><b>Priority order</b></span>'
    + `<ol aria-label="Bench in priority order">${bench}</ol></div></div>`;
}

// ─── Render: aside ───────────────────────────────────────────────────────────

function captainHTML(m, showLive) {
  if (m.phase === 'partial') {
    const left = SQUAD_TOTAL - m.squad.length;
    return `<p role="status">Add ${left} more player${left === 1 ? '' : 's'} to see GW recommendations.</p>`;
  }
  if (m.phase !== 'ready' || !m.captain) {
    return '<div class="sk-stack" aria-hidden="true"><span class="sk" style="--w:70%"></span><span class="sk" style="--w:100%;height:10px"></span><span class="sk" style="--w:80%;height:10px"></span></div>';
  }
  const { player, score } = m.captain;
  const team = store.getTeam(player.teamId);
  const run = m.ladder[1];
  const gap = run ? score.expectedPoints.value - run.score.expectedPoints.value : 0;
  const edge = !run ? 'Only option in the XI' : gap < 0.05 ? `Level with ${run.player.name}` : `${gap.toFixed(1)} pts clear of ${run.player.name}`;
  const live = showLive ? liveOf(player.id, true) : null;
  const max = m.ladder[0]?.score.expectedPoints.value || 1;
  const ep = score.expectedPoints.value;
  return '<div class="cap"><div class="cap__l">'
    + `<span class="cap__name">${esc(player.name)}${statusHTML(player)}</span>`
    + `<span class="cap__sub">${crestHTML(team, 18)}${esc(team?.name ?? '')} · v ${esc(nextShort(score, true))}</span>`
    + `<span class="cap__edge"><span class="tag">Edge</span>${esc(edge)}</span>`
    + (live ? `<span class="cap__live${_liveStale ? ' live is-stale' : ''}">${esc(live.full)}</span>` : '')
    + '</div>'
    + `<div class="cap__r" data-band="${score.band}"><span class="lbl lbl--sm">Pred pts</span>`
    + `<span class="big" role="img" aria-label="Predicted ${ep.toFixed(1)} pts" data-ep="${ep}">`
    + `<span class="big__o" aria-hidden="true">${ep.toFixed(1)}</span><span aria-hidden="true">${ep.toFixed(1)}</span></span></div></div>`
    + '<ol class="ladder" aria-label="Captain options by predicted points">'
    + m.ladder.slice(0, 5).map((e, i) => `<li><span>${i + 1}</span><span>${crestHTML(store.getTeam(e.player.teamId))}<span class="ell">${esc(e.player.name)}</span></span>`
      + `<span class="lbar" aria-hidden="true"><span style="width:${Math.round(e.score.expectedPoints.value / max * 100)}%"></span></span>`
      + `<span>${e.score.expectedPoints.value.toFixed(1)}</span></li>`).join('')
    + '</ol>';
}

function whyHTML(m) {
  const id = _openId != null && m.squad.includes(_openId) ? _openId : null;
  if (id == null || m.phase === 'loading') return '<p>Select a player on the board.</p>';
  const player = store.getPlayer(id);
  const score = _scores.get(id);
  const team = store.getTeam(player.teamId);
  if (!score || !m.settled) return `<p>${esc(player.fullName || player.name)} — still calculating, waiting on league-wide counter-matchup data.</p>`;
  const role = m.phase === 'ready' ? m.role.get(id) : '';
  const roleTitle = !role ? '—' : role === 'C' ? 'Captain' : role === 'XI' ? 'Starting' : `Bench ${role.slice(1)}`;
  const flags = getRiskFlags(player, score);
  const ms = score.breakdown?.form?.minutesSecurity ?? 0;
  const tier = tierShort(_rankTierByPlayerId?.get(id), player.position);
  return '<div class="why">'
    + `<div class="why__top">${scoreChipHTML(player, score, true, 'lg')}${crestHTML(team, 24)}`
    + `<span><b>${esc(player.fullName || player.name)}</b><small>${BAND_LABEL[score.band] ?? ''}${tier ? ` · ${tier}` : ''}</small></span></div>`
    + `<span class="why__ctx">${esc(buildFixtureContextLabel(score, getHorizon()))}</span>`
    + BREAKDOWN_ORDER.map(k => {
      const c = score.breakdown?.[k];
      if (!c) return '';
      const v = Math.round(c.value), band = bandFromValue(v), w = Math.round(c.weight * 100);
      return `<div class="bd" role="group" data-band="${band}" aria-label="${BREAKDOWN_LABELS[k]} ${v} ${BAND_LABEL[band] ?? ''}, weight ${w}%${c.estimated ? ', estimated' : ''}">`
        + `<span>${BREAKDOWN_LABELS[k]}</span><span class="mbar" aria-hidden="true"><span class="${c.estimated ? 'is-est' : ''}" style="width:${v}%"></span></span>`
        + `<b title="${c.estimated ? 'Estimated — limited data' : ''}">${c.estimated ? '~' : ''}${v}</b><span>${w}%</span></div>`;
    }).join('')
    + '<div class="why__facts">'
    + `<span><span class="lbl lbl--sm">Pred</span><b>${score.expectedPoints.value.toFixed(1)} pts</b></span>`
    + `<span><span class="lbl lbl--sm">Mins</span><b>${Math.round(ms * 100)}%${ms < MIN_SEC_RISK ? ' · low' : ''}</b></span>`
    + `<span><span class="lbl lbl--sm">Role</span><b>${roleTitle}</b></span></div>`
    + (flags.length ? `<span class="why__flags"><span class="warn" aria-hidden="true">⚠ </span>${esc(flags.map(f => FLAG_LABELS[f]).join(' · '))}`
      + `${player.status !== 'available' && player.statusNote ? ` — ${esc(player.statusNote)}` : ''}</span>` : '')
    + '</div>';
}

function risksHTML(m) {
  if (m.phase === 'loading' || m.squad.length === 0) return '';
  if (!m.settled) return '<p>Waiting on scores.</p>';
  const by = {};
  for (const id of m.squad) {
    const score = _scores.get(id);
    if (!score) continue;
    for (const f of getRiskFlags(store.getPlayer(id), score)) (by[f] ??= []).push(id);
  }
  const keys = ['availability', 'rotation', 'confidence', 'fixture'].filter(f => by[f]);
  if (!keys.length) return '<p>No flags in this squad.</p>';
  return keys.map(f => `<div class="risk"><span><span class="warn" aria-hidden="true">⚠</span>${FLAG_LABELS[f]}<small>${by[f].length}</small></span>`
    + by[f].map(id => {
      const p = store.getPlayer(id), s = _scores.get(id);
      const note = f === 'availability' ? (p.statusNote || p.status)
        : f === 'rotation' ? `${Math.round((s.breakdown?.form?.minutesSecurity ?? 0) * 100)}% mins share`
        : f === 'confidence' ? 'Limited data'
        : `${Math.round(s.value)} ${BAND_LABEL[s.band] ?? ''}`;
      return `<button type="button" data-row-id="${id}"><span>${m.role.get(id) ?? '—'}</span>`
        + `<span>${crestHTML(store.getTeam(p.teamId))}<span class="ell">${esc(p.fullName || p.name)}</span></span><span>${esc(note)}</span></button>`;
    }).join('') + '</div>').join('');
}

// ─── Render ───────────────────────────────────────────────────────────────────

/**
 * Paint the whole page from the store and _scores.
 * @param {boolean} [animate]  play the entrances (a render the reader caused);
 *   the live poll and other data repaints pass nothing.
 */
function render(animate = false) {
  if (!_root) return;
  renderCmd();

  const m = buildModel();
  const showLive = _livePoints !== null && _dataReady;
  _boardSec.classList.toggle('is-wide', _boardSec.clientWidth === 0 || _boardSec.clientWidth >= 790);
  _boardSec.setAttribute('aria-busy', String(m.phase === 'loading' || m.phase === 'settling'));

  _root.querySelector('.seg--view').style.setProperty('--i', _view === 'sheet' ? 1 : 0);
  _root.querySelectorAll('.seg--view [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === _view)));
  _root.querySelector('#db-board-t').textContent = _view === 'sheet' ? 'Team sheet' : 'Squad board';
  _root.querySelector('#db-board-meta').textContent = m.squad.length
    ? `${m.squad.length} / ${SQUAD_TOTAL} players selected${m.formation ? ` · XI ${m.formation}` : ''}`
    : 'Empty';
  _root.querySelector('#db-note').textContent = `C = captain, XI = starting, B1–B4 = bench order. Score colour = band over ${getHorizon().label}; `
    + `dashed = estimated, ~ = limited data, hatched = blank GW. Pred = projected points for GW${store.getUpcomingGw() ?? store.getCurrentGw() ?? ''}.`;

  // Entrances play on reader-caused renders, and once when the first settled
  // board appears — never on a live-poll repaint.
  const anim = (animate || (_animNext && m.phase === 'ready')) && !reducedMotion();
  if (m.phase === 'ready') _animNext = false;
  _board.removeAttribute('data-anim');
  _board.innerHTML = _view === 'sheet' ? sheetHTML(m, showLive) : boardHTML(m, showLive);
  if (anim) { void _board.offsetWidth; _board.setAttribute('data-anim', ''); }

  _cap.innerHTML = captainHTML(m, showLive);
  _why.innerHTML = whyHTML(m);
  _root.querySelector('#db-why-hint').textContent = _order.length ? 'J / K to step' : '';
  const risks = risksHTML(m);
  _risk.innerHTML = risks;
  const flagCount = (risks.match(/data-row-id=/g) ?? []).length;
  _root.querySelector('#db-risk-meta').textContent = flagCount ? `${flagCount} flags` : '';

  countUpCaptain(m);
}

/** The captain's Pred pts numeral counts up when the pick or its figure changes. */
function countUpCaptain(m) {
  cancelAnimationFrame(_raf);
  const el = _cap.querySelector('[data-ep]');
  if (!el) return;
  const to = Number(el.dataset.ep);
  const id = m.captain?.player.id;
  const from = _capLast.id === id ? _capLast.ep : 0;
  _capLast = { id, ep: to };
  if (reducedMotion() || from === to) return;
  const t0 = performance.now();
  const tick = now => {
    const q = Math.min(1, Math.max(0, (now - t0 - 120) / 900));
    const v = from + (to - from) * (1 - (1 - q) ** 2);
    for (const s of el.children) s.textContent = v.toFixed(1);
    if (q < 1) _raf = requestAnimationFrame(tick);
  };
  for (const s of el.children) s.textContent = from.toFixed(1);
  _raf = requestAnimationFrame(tick);
}

function setView(v) {
  if (v === _view || _viewBusy) return;
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
  if (reducedMotion()) { _view = v; render(true); return; }
  _viewBusy = true;
  _root.querySelector('.seg--view').style.setProperty('--i', v === 'sheet' ? 1 : 0);
  _board.classList.add('is-leaving');
  setTimeout(() => {
    _board.classList.remove('is-leaving');
    _viewBusy = false;
    _view = v;
    render(true);
  }, 190);
}

function select(id) {
  _openId = _openId === id ? null : id;
  render();
}

// ─── After squad change ───────────────────────────────────────────────────────

function afterSquadChange() {
  if (_openId != null && !isInSquad(_openId)) _openId = null;
  scoreSquad();
  render();
  if (_searchInput) _searchInput.value = '';
  hideResults();
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onSearchInput() {
  _sIdx = 0;
  renderSearchResults();
}

function onSearchFocus() {
  if ((_searchInput?.value.trim().length ?? 0) >= 2) renderSearchResults();
}

function onSearchBlur() {
  setTimeout(hideResults, 150);
}

function onSearchKeydown(e) {
  const n = _results.length;
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); _sIdx = (_sIdx + 1) % n; renderSearchResults(); }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); _sIdx = (_sIdx - 1 + n) % n; renderSearchResults(); }
  else if (e.key === 'Enter' && n) {
    e.preventDefault();
    const r = _results[_sIdx];
    if (r && !r.disabled) addPlayer(r.id);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    hideResults();
    _searchInput?.blur();
  }
}

function onResultsMousedown(e) {
  const item = e.target.closest('[data-player-id]');
  if (!item) return;
  if (item.getAttribute('aria-disabled') === 'true') return;
  const id = Number(item.dataset.playerId);
  if (!id) return;
  e.preventDefault();
  addPlayer(id);
}

function onClick(e) {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-remove-id]'))) { e.stopPropagation(); removePlayer(Number(el.dataset.removeId)); return; }
  if ((el = t.closest('.cmd [data-pos]'))) {
    const pos = el.dataset.pos;
    if (_searchPosSet.has(pos)) {
      if (_searchPosSet.size > 1) _searchPosSet.delete(pos);
    } else {
      _searchPosSet.add(pos);
    }
    _root.querySelectorAll('.cmd [data-pos]').forEach(b => b.setAttribute('aria-pressed', String(_searchPosSet.has(b.dataset.pos))));
    _sIdx = 0;
    if (!_searchResults.hidden) renderSearchResults();
    return;
  }
  if ((el = t.closest('[data-view]'))) { setView(el.dataset.view); return; }
  if (t.closest('#db-import-btn')) { _importPanel.hidden ? openImportPanel() : closeImportPanel(); return; }
  if (t.closest('#db-help-btn')) { toggleHelp(); return; }
  if (t.closest('#db-imp-cancel')) { closeImportPanel(); _importBtn.focus(); return; }
  if (t.closest('#db-imp-go')) { handleImport(); return; }
  if ((el = t.closest('[data-row-id]'))) select(Number(el.dataset.rowId));
}

function onKeydown(e) {
  if (store.getActiveModule() !== 'dashboard') return;
  if (e.key === 'Escape') {
    if (!_importPanel.hidden || !_importHelp.hidden) { closeImportPanel(); closeHelp(); }
    else if (_openId != null) { _openId = null; render(); }
    return;
  }
  const tag = e.target?.tagName;
  if (e.metaKey || e.ctrlKey || e.altKey || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !_dataReady) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); _searchInput.focus(); }
  else if (k === 'i' || k === 'I') { e.preventDefault(); _importPanel.hidden ? openImportPanel() : closeImportPanel(); }
  else if (k === 't' || k === 'T') { e.preventDefault(); setView(_view === 'sheet' ? 'board' : 'sheet'); }
  else if ((k === 'j' || k === 'k') && _order.length) {
    e.preventDefault();
    const cur = _order.indexOf(_openId);
    const n = cur < 0 ? 0 : (cur + (k === 'j' ? 1 : -1) + _order.length) % _order.length;
    _openId = _order[n];
    render();
    const row = _board.querySelector(`[data-row-id="${_openId}"]`);
    (row?.tagName === 'BUTTON' ? row : row?.querySelector('[data-rowbtn]'))?.focus();
  }
}

/**
 * hashchange handler: start or stop the live poll based on the active view
 * and current GW state. Attached once in wireDom().
 */
function onHashChange() {
  reconcileLivePoll();
}

let _resizeRaf = 0;
function onResize() {
  cancelAnimationFrame(_resizeRaf);
  _resizeRaf = requestAnimationFrame(() => {
    if (store.getActiveModule() !== 'dashboard' || !_boardSec.clientWidth) return;
    if ((_boardSec.clientWidth >= 790) !== _boardSec.classList.contains('is-wide')) render();
  });
}

// ─── Squad import helpers (Phase 4-1) ────────────────────────────────────────

/**
 * Replace the current squad with the given player IDs, respecting slot limits.
 * IDs that exceed a position's slot limit (shouldn't happen with valid FPL picks,
 * but guard anyway) are silently dropped. Triggers a full re-score + re-render.
 * @param {number[]} playerIds
 */
function replaceSquad(playerIds) {
  const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const accepted = [];
  for (const id of playerIds) {
    const player = store.getPlayer(id);
    if (!player) continue;
    const pos = player.position;
    if (!SQUAD_LIMITS[pos]) continue;
    if (counts[pos] >= SQUAD_LIMITS[pos]) continue;
    counts[pos]++;
    accepted.push(id);
  }
  store.setSquad(accepted);
}

/**
 * Render the team name and overall rank from the last import's entryInfo.
 * Clears the info element when entryInfo is null.
 * @param {object|null} entryInfo  raw FPL entry object
 */
function renderImportInfo(entryInfo) {
  if (!_importInfo) return;
  if (!entryInfo) {
    _importInfo.textContent = '';
    return;
  }
  const teamName = entryInfo.name ?? '';
  const manager  = `${entryInfo.player_first_name ?? ''} ${entryInfo.player_last_name ?? ''}`.trim();
  const rank     = entryInfo.summary_overall_rank
    ? `Overall rank: ${Number(entryInfo.summary_overall_rank).toLocaleString()}`
    : '';
  const parts = [teamName, manager, rank].filter(Boolean);
  _importInfo.textContent = parts.join(' · ');
}

/**
 * Show a status message in the import panel.
 * @param {string} msg
 * @param {'idle'|'loading'|'success'|'error'} type
 */
function showImportStatus(msg, type) {
  if (!_importStatus) return;
  _importStatus.textContent = msg;
  _importStatus.dataset.type = type;
  _importStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const go = _root?.querySelector('#db-imp-go');
  if (go) {
    go.textContent = type === 'loading' ? 'Importing…' : 'Import';
    go.setAttribute('aria-busy', String(type === 'loading'));
  }
}

/**
 * Open the import panel.
 * Pre-fills the ID input from localStorage and clears any prior status.
 */
function openImportPanel() {
  if (!_importPanel) return;
  // The help row occupies the same slot — collapse it first.
  closeHelp();
  _importPanel.hidden = false;
  _importBtn?.setAttribute('aria-expanded', 'true');
  if (_importIdInput) {
    const saved = loadSavedTeamId();
    if (saved && !_importIdInput.value) _importIdInput.value = String(saved);
    _importIdInput.focus();
  }
  showImportStatus('', 'idle');
  renderImportInfo(_importedEntryInfo);
}

function closeImportPanel() {
  if (!_importPanel) return;
  _importPanel.hidden = true;
  _importBtn?.setAttribute('aria-expanded', 'false');
  showImportStatus('', 'idle');
}

function toggleHelp() {
  if (!_importHelp.hidden) { closeHelp(); return; }
  // Reciprocal of the guard in openImportPanel — opening help hides the form.
  closeImportPanel();
  _importHelp.hidden = false;
  _helpBtn.setAttribute('aria-expanded', 'true');
}

function closeHelp() {
  if (!_importHelp) return;
  _importHelp.hidden = true;
  _helpBtn?.setAttribute('aria-expanded', 'false');
}

/** Run the import: validate input, fetch, replace squad. */
async function handleImport() {
  if (_importInFlight) return;
  if (!_importIdInput) return;

  const raw = _importIdInput.value.trim();
  const teamId = parseInt(raw, 10);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    showImportStatus('Enter a valid FPL Team ID (numbers only).', 'error');
    return;
  }

  const gw = resolveImportGw();
  if (!gw) {
    showImportStatus('No completed gameweek to import from yet.', 'error');
    return;
  }

  _importInFlight = true;
  showImportStatus(`Importing GW${gw} squad…`, 'loading');

  try {
    const { playerIds, entryInfo, missingCount } = await fetchAndMapSquad(teamId, gw);

    if (playerIds.length === 0) {
      showImportStatus('No recognised players found — check the Team ID and try again.', 'error');
      return;
    }

    saveTeamId(teamId);
    _importedTeamId   = teamId;
    _importedEntryInfo = entryInfo;

    replaceSquad(playerIds);
    renderImportInfo(entryInfo);

    const warn = missingCount > 0 ? ` (${missingCount} player${missingCount === 1 ? '' : 's'} not recognised)` : '';
    showImportStatus(`Imported ${playerIds.length} players from GW${gw}.${warn}`, 'success');
  } catch (err) {
    const detail = err?.upstreamStatus === 404
      ? 'Team not found — check the ID. Private leagues may block access.'
      : (err?.message ?? String(err));
    showImportStatus(`Import failed: ${detail}`, 'error');
    console.warn('[dashboard] Squad import failed:', err);
  } finally {
    _importInFlight = false;
  }
}

/**
 * Cache all DOM refs and attach all event listeners. Called from
 * initDashboard() and again from onDataReady(); the _domWired guard
 * prevents double-wiring.
 */
function wireDom() {
  if (_domWired) return;

  _root          = document.querySelector('[data-module="dashboard"] .db');
  if (!_root) {
    console.warn('[dashboard] data-module="dashboard" section not found in DOM');
    return;
  }
  _cmd           = _root.querySelector('#db-cmd');
  _searchInput   = _root.querySelector('#db-search');
  _searchResults = _root.querySelector('#db-results');
  _board         = _root.querySelector('#db-board');
  _boardSec      = _root.querySelector('#db-board-sec');
  _cap           = _root.querySelector('#db-cap');
  _why           = _root.querySelector('#db-why');
  _risk          = _root.querySelector('#db-risk');
  _importBtn     = _root.querySelector('#db-import-btn');
  _importPanel   = _root.querySelector('#db-imp');
  _importIdInput = _root.querySelector('#db-imp-id');
  _importStatus  = _root.querySelector('#db-imp-st');
  _importInfo    = _root.querySelector('#db-imp-info');
  _importHelp    = _root.querySelector('#db-help');
  _helpBtn       = _root.querySelector('#db-help-btn');

  try { if (localStorage.getItem(VIEW_KEY) === 'sheet') _view = 'sheet'; } catch { /* per-viewer convenience only */ }

  // ── Search events ────────────────────────────────────────────────────────
  _searchInput.addEventListener('input',   onSearchInput);
  _searchInput.addEventListener('focus',   onSearchFocus);
  _searchInput.addEventListener('blur',    onSearchBlur);
  _searchInput.addEventListener('keydown', onSearchKeydown);
  _searchResults.addEventListener('mousedown', onResultsMousedown);

  // ── Everything else is delegated ─────────────────────────────────────────
  _root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
  _importIdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleImport();
    if (e.key === 'Escape') { e.stopPropagation(); closeImportPanel(); _importBtn.focus(); }
  });

  // The aside sticks under the command bar, which wraps at some widths —
  // track its real height rather than assuming one.
  new ResizeObserver(() => _root.style.setProperty('--db-cmd-h', `${_cmd.offsetHeight}px`)).observe(_cmd);

  // ── Live poll lifecycle — start/stop on navigation ───────────────────────
  window.addEventListener('hashchange', onHashChange);

  // ── Render the initial shell — squad is already hydrated by store.js ─────
  render();

  _domWired = true;
}

/**
 * Set when data changed while the Dashboard was off screen, so activation
 * knows it owes a re-score. See onRouteChanged.
 */
let _pendingRender = false;

function onDataReady() {
  wireDom();       // no-op after first call

  // Reset live state on each data:ready so a new GW always starts from scratch.
  stopLivePoll();
  _livePoints = null;
  _liveStale  = false;
  _liveUpdatedAt = null;

  // Force a fresh full-pool rank computation for the new data (see ensureRankTiers).
  _rankTierByPlayerId = null;

  _dataReady = true;

  // Everything above is bookkeeping: cheap, and it must stay eager so the
  // module's state stays truthful whether or not anyone is looking. Everything
  // below is the expensive half — scoreSquad() drives ensureRankTiers, a
  // full-pool ranking measured at ~920ms. Because data:ready fires once per
  // team-xG payload at boot, running that off screen cost ~18s of blocking work
  // on a tab that was not visible. Invalidate always, recompute lazily.
  if (store.getActiveModule() !== 'dashboard') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;

  scoreSquad();
  render();

  // Start live polling if we're already on the dashboard and the GW is live.
  reconcileLivePoll();
}

/**
 * Flush a render deferred while off screen, once the Dashboard is shown.
 *
 * reconcileLivePoll() is repeated here even though the module's own hashchange
 * handler also calls it: the deferred path above cleared _livePoints and
 * stopped the poll, and the two listeners fire in registration order, which
 * this module should not have to reason about. It is idempotent by design
 * (it reads the hash itself and no-ops off the dashboard), so calling it from
 * both places is safe and removes the ordering dependency.
 */
function onRouteChanged(module) {
  if (module !== 'dashboard') {
    closeImportPanel();
    closeHelp();
    return;
  }
  _animNext = true;
  if (!_pendingRender) { render(); return; }
  _pendingRender = false;
  scoreSquad();
  render();
  reconcileLivePoll();
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the GW Decision Dashboard module. Called once from main.js on
 * bootstrap, before loadInitialData(). Registers the data:ready subscription
 * so the module is ready to receive the event whenever the fetch completes.
 * main.js runs after the document is parsed, so wireDom() can run here and
 * the board shows its loading state before the first data:ready.
 *
 * Also subscribes to 'squad:updated' so a squad built or imported on the
 * Planner — or anywhere else — re-scores and re-renders here too, with no
 * rebuild step. afterSquadChange() itself no-ops safely via render()'s null
 * DOM-ref guard if this module hasn't wired yet.
 */
export function initDashboard() {
  store.subscribe('data:ready', onDataReady);
  store.subscribe('route:changed', onRouteChanged);
  store.subscribe('squad:updated', afterSquadChange);

  // Wire now so the loading state shows before the first data:ready.
  wireDom();

  // If the store is already hydrated from sessionStorage, data:ready won't
  // fire again — wire the DOM and render immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
