/**
 * js/modules/ranker.js
 * Layer: module. Owns the DOM for the Player Ranker view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders a sortable, filterable table of players ranked by projected value
 * over the active horizon. Lazy-loads player summaries on click — never
 * bulk-fetches all ~700 players. No analytical logic lives here; all scoring
 * delegated to engine/composite.js.
 * See ARCHITECTURE.md §10, FEATURE_ENGINE.md §11, ROADMAP.md Phase 2B.
 *
 * Subscriptions: data:ready, horizon:changed
 */

import { store } from '../store.js';
import { HORIZONS, RANKER_CHUNK_SIZE } from '../config.js';
import { buildScoreContext, scorePlayer } from '../engine/composite.js';
import { fetchPlayerSummary } from '../api.js';
import { normalisePlayerSummary } from '../engine/normalise.js';
import { calcPriceChangeRisk } from '../engine/prices.js';

// ─── Minutes-security display thresholds ─────────────────────────────────────
// Maps 0–1 minutesSecurity (from scorePlayer breakdown.form) onto a human
// label and band. Checked in order; first threshold met wins.

const MIN_SEC_LEVELS = [
  { threshold: 0.85, label: 'Nailed',   band: 'great' },
  { threshold: 0.65, label: 'Likely',   band: 'good' },
  { threshold: 0.40, label: 'Rotation', band: 'neutral' },
  { threshold: 0,    label: 'Risk',     band: 'tough' },
];

// ─── Module-level state ───────────────────────────────────────────────────────

let _thead              = null;
let _tbody              = null;
let _loading            = null;
let _teamSelect         = null;
let _priceSelect        = null;
let _vsToggle           = null;
let _priceChangeToggle  = null;

// Scored rows rebuilt on data:ready or horizon:changed; cached so filter and
// sort changes do not re-invoke the engine.
let _rows = [];

// Incremented on every new ranking run; each async chunk checks its captured
// value still matches before continuing, cancelling stale in-flight runs.
let _computeId = 0;

// Active filter / sort / display state.
let _activePosSet    = new Set(['GKP', 'DEF', 'MID', 'FWD']);
let _activePriceBand = 'all';
let _activeTeamId    = 'all';
let _sortBy          = 'value';    // 'value' | 'valueScore' | 'price'
let _sortDesc        = true;
let _showVs          = false;      // false = projected value; true = £/pt (valueScore)
let _showPriceChange = false;      // true = show price change indicator column

// In-flight lazy loads keyed by playerId so concurrent clicks on the same
// player share one Promise and never fire duplicate network requests.
const _pendingLoads = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * True when a scorePlayer result has at least one estimated sub-metric,
 * signalling that the projected score should render with the estimated treatment.
 * Uses the breakdown rather than a top-level confidence field because scorePlayer
 * does not currently compute a single confidence number.
 */
function isScoreEstimated(score) {
  return Boolean(score?.breakdown?.form?.estimated || score?.breakdown?.counter?.estimated);
}

function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    currentGw: store.getCurrentGw() ?? store.getNextGw() ?? 1,
  });
}

/** Return the label+band object for a 0–1 minutesSecurity value. */
function minSecLevel(ms) {
  const v = ms ?? 0;
  for (const level of MIN_SEC_LEVELS) {
    if (v >= level.threshold) return level;
  }
  return MIN_SEC_LEVELS[MIN_SEC_LEVELS.length - 1];
}

/** Price-band filter — returns true when `price` belongs to `band`. */
function priceInBand(price, band) {
  if (band === 'all')     return true;
  if (band === 'budget')  return price <= 5.0;
  if (band === 'mid')     return price > 5.0  && price <= 8.0;
  if (band === 'premium') return price > 8.0  && price <= 10.0;
  if (band === 'elite')   return price > 10.0;
  return true;
}

/** First upcoming unplayed fixture for `teamId`, GW ascending. */
function getNextFixtureForTeam(teamId) {
  return store.getFixtures()
    .filter(f => !f.played && f.gw !== null &&
                 (f.homeTeamId === teamId || f.awayTeamId === teamId))
    .sort((a, b) => a.gw - b.gw || (a.kickoff || '').localeCompare(b.kickoff || ''))[0]
    ?? null;
}

// ─── Build: scored rows ───────────────────────────────────────────────────────

/**
 * Score all players over `horizon` in chunks of RANKER_CHUNK_SIZE, yielding
 * back to the browser between chunks so the UI stays responsive. Shows a live
 * progress indicator while working. Any in-flight run whose `computeId` no
 * longer matches `_computeId` is silently abandoned — this happens when the
 * user changes the horizon or data refreshes mid-compute.
 *
 * Never renders partial results: `_rows` and `renderTable()` are only touched
 * after all chunks complete and the run is confirmed non-stale.
 */
async function rebuildRowsChunked() {
  const computeId = ++_computeId;

  // Show the progress banner and yield one macrotask tick before snapshotting
  // ctx. This matches the single-tick deferral the old synchronous rebuildRows
  // had via its outer setTimeout(0) wrapper. The yield lets any microtasks
  // queued alongside data:ready (e.g. leagueXg resolving, sessionStorage
  // hydration completing) settle into the store before we freeze ctx, preventing
  // false estimated flags from a stale snapshot.
  _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">Ranking players…</td></tr>`;
  if (_loading) _loading.classList.add('is-visible');
  await new Promise(resolve => setTimeout(resolve, 0));

  if (computeId !== _computeId) return;

  const ctx = buildCtx();
  if (!ctx) return;

  const horizonKey = store.getActiveHorizon();
  const horizon    = HORIZONS[horizonKey] ?? HORIZONS.GW1;
  const players    = store.getPlayers();
  const total      = players.length;
  const pending    = [];

  _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">Ranking players… (0 / ${total})</td></tr>`;

  for (let i = 0; i < total; i += RANKER_CHUNK_SIZE) {
    // Yield between chunks so the browser can paint progress and process input.
    await new Promise(resolve => setTimeout(resolve, 0));

    if (computeId !== _computeId) return;

    const end = Math.min(i + RANKER_CHUNK_SIZE, total);
    for (let j = i; j < end; j++) {
      const player = players[j];
      const score  = scorePlayer(player, horizon, ctx);
      pending.push({ player, team: store.getTeam(player.teamId), score });
    }

    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">Ranking players… (${end} / ${total})</td></tr>`;
  }

  // Final stale-check before committing — a horizon change could have fired
  // during the last chunk's execution.
  if (computeId !== _computeId) return;

  // Sort descending by value, matching rankPlayers ordering.
  pending.sort((a, b) => b.score.value - a.score.value);
  _rows = pending;

  if (_loading) _loading.classList.remove('is-visible');
  renderTable();
}

// ─── Filter and sort ──────────────────────────────────────────────────────────

function applyFilters(rows) {
  return rows.filter(({ player }) => {
    if (!_activePosSet.has(player.position))          return false;
    if (!priceInBand(player.price, _activePriceBand)) return false;
    if (_activeTeamId !== 'all' &&
        String(player.teamId) !== _activeTeamId)      return false;
    return true;
  });
}

function applySort(rows) {
  return rows.slice().sort((a, b) => {
    let av, bv;
    if (_sortBy === 'valueScore') { av = a.score.valueScore; bv = b.score.valueScore; }
    else if (_sortBy === 'price') { av = a.player.price;     bv = b.player.price; }
    else                          { av = a.score.value;      bv = b.score.value; }
    return _sortDesc ? (bv - av) : (av - bv);
  });
}

// ─── Build: HTML fragments ────────────────────────────────────────────────────

/**
 * Per-GW fixture strip for one player row. Reuses .pgw-cell + .pgw-cell--<band>
 * modifier classes from components.css so band colours are consistent across
 * all modules. Blank GWs show '–'; DGWs produce two adjacent cells.
 * See CONVENTIONS.md §5.2.
 */
function buildFixtureStrip(perGw) {
  if (!perGw || perGw.length === 0) {
    return '<span class="ranker-no-fixtures">—</span>';
  }
  const cells = perGw.map(entry => {
    const band    = entry.isBlank ? 'neutral' : entry.band;
    const tooltip = entry.isBlank
      ? `GW${entry.gw} (blank)`
      : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}${entry.provisional ? ' ~est' : ''}`;
    const label      = entry.isBlank ? '–' : (entry.opponent ?? '?');
    const estClass   = (!entry.isBlank && entry.provisional) ? ' pgw-cell--estimated' : '';
    return `<span class="pgw-cell pgw-cell--${esc(band)}${estClass}" title="${esc(tooltip)}">${esc(label)}</span>`;
  }).join('');
  return `<span class="ranker-fixtures">${cells}</span>`;
}

/**
 * Build a single <tr> HTML string for one player row.
 * minutesSecurity is read from score.breakdown.form (set by composite.js's
 * scorePlayer) to avoid a second calcPlayerForm call per row.
 */
function buildRow({ player, team, score }) {
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';
  const ms       = score.breakdown?.form?.minutesSecurity ?? 0;
  const lvl      = minSecLevel(ms);
  const dispVal  = _showVs
    ? score.valueScore.toFixed(2)
    : String(Math.round(score.value));
  const estClass = isScoreEstimated(score) ? ' score-chip--estimated' : '';

  return `
    <tr class="ranker-table__row" data-player-id="${player.id}"
        tabindex="0" role="button"
        aria-label="Analyse ${esc(player.name)} in Matchup Analyser">
      <td class="ranker-table__td ranker-table__td--name">
        ${esc(player.name)}${statusMark}
      </td>
      <td class="ranker-table__td ranker-table__td--team">
        ${team ? esc(team.shortName) : '—'}
      </td>
      <td class="ranker-table__td ranker-table__td--pos">
        <span class="ranker-pos-badge ranker-pos-badge--${player.position.toLowerCase()}">${esc(player.position)}</span>
      </td>
      <td class="ranker-table__td ranker-table__td--price">
        £${esc(player.price.toFixed(1))}
      </td>
      <td class="ranker-table__td ranker-table__td--value">
        <span class="score-chip score-chip--${esc(score.band)}${estClass}">${esc(dispVal)}</span>
      </td>
      <td class="ranker-table__td ranker-table__td--fixtures">
        ${buildFixtureStrip(score.perGw)}
      </td>
      <td class="ranker-table__td ranker-table__td--min">
        <span class="ranker-min-badge ranker-min-badge--${esc(lvl.band)}">${esc(lvl.label)}</span>
      </td>
      ${_showPriceChange ? buildPriceChangeCell(player) : ''}
    </tr>
  `.trim();
}

// ─── Price change helpers ─────────────────────────────────────────────────────

/** Dynamic column count: 7 base + 1 when the price change column is visible. */
function colCount() {
  return _showPriceChange ? 8 : 7;
}

/**
 * Build the price change <td> for one player row.
 * ↑ (green) = likely rise, ↓ (red) = likely fall, — = stable / no signal.
 * Confidence is shown on hover via the title attribute.
 * @param {Player} player
 * @returns {string} HTML <td> string
 */
function buildPriceChangeCell(player) {
  const risk = calcPriceChangeRisk(player);
  if (risk.direction === 'stable' || risk.confidence === 0) {
    return `<td class="ranker-table__td ranker-table__td--price-change">
      <span class="ranker-price-change ranker-price-change--stable" title="No price move predicted">—</span>
    </td>`.trim();
  }
  const isRise = risk.direction === 'rise';
  const pct    = Math.round(risk.confidence * 100);
  const arrow  = isRise ? '↑' : '↓';
  const mod    = isRise ? 'rise' : 'fall';
  const title  = `${isRise ? 'Likely rise' : 'Likely fall'} (${pct}% confidence) — ${esc(risk.reasoning)}`;
  return `<td class="ranker-table__td ranker-table__td--price-change">
    <span class="ranker-price-change ranker-price-change--${mod}" title="${title}">${arrow} ${pct}%</span>
  </td>`.trim();
}

// ─── Render ───────────────────────────────────────────────────────────────────

/** (Re-)render the <thead> row, including the active sort-column indicator. */
function renderThead() {
  const horizonKey = store.getActiveHorizon();
  const horizon    = HORIZONS[horizonKey] ?? HORIZONS.GW1;
  const sortCol    = _showVs ? 'valueScore' : 'value';
  const valueLabel = _showVs ? '£/pt' : 'Value';

  function thSortable(label, col) {
    const active = _sortBy === col;
    const icon   = active
      ? ` <span class="sort-icon" aria-hidden="true">${_sortDesc ? '↓' : '↑'}</span>`
      : '';
    return `<th class="ranker-table__th ranker-table__th--sortable${active ? ' is-sorted' : ''}" data-sort="${esc(col)}">${esc(label)}${icon}</th>`;
  }
  function thStatic(label, col) {
    return `<th class="ranker-table__th" data-col="${esc(col)}">${esc(label)}</th>`;
  }

  _thead.innerHTML = `
    <tr>
      ${thStatic('Player',      'name')}
      ${thStatic('Team',        'team')}
      ${thStatic('Pos',         'pos')}
      ${thSortable('Price',     'price')}
      ${thSortable(valueLabel,  sortCol)}
      ${thStatic(horizon.label, 'fixtures')}
      ${thStatic('Min',         'min')}
      ${_showPriceChange ? thStatic('£↑↓', 'price-change') : ''}
    </tr>
  `;
}

/**
 * Full table render: rebuilds thead (sort indicators) and tbody (filtered,
 * sorted rows). Engine results in `_rows` are not recomputed; this only
 * re-applies filter, sort, and display-mode state.
 */
function renderTable() {
  renderThead();

  if (_rows.length === 0) {
    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">No player data loaded.</td></tr>`;
    return;
  }

  const filtered = applyFilters(_rows);
  const sorted   = applySort(filtered);

  if (sorted.length === 0) {
    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">No players match the current filters.</td></tr>`;
    return;
  }

  _tbody.innerHTML = sorted.map(buildRow).join('');
}

// ─── Lazy loading ─────────────────────────────────────────────────────────────

/**
 * Ensure a player summary is in the store, fetching lazily if needed.
 * Only api.js calls fetch() (ARCHITECTURE.md §3 rule 1); this module
 * calls the exported fetchPlayerSummary function and caches the result.
 * Deduplicates concurrent requests via `_pendingLoads`.
 *
 * @param {number} playerId
 */
async function ensurePlayerSummary(playerId) {
  if (store.getPlayerSummary(playerId)) return;
  if (!_pendingLoads.has(playerId)) {
    const p = (async () => {
      const raw     = await fetchPlayerSummary(playerId);
      const summary = normalisePlayerSummary(raw);
      store.setPlayerSummary(playerId, summary);
    })();
    _pendingLoads.set(playerId, p);
  }
  try {
    await _pendingLoads.get(playerId);
  } finally {
    _pendingLoads.delete(playerId);
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * Handle a player row click. Shows loading state on the row while the
 * element-summary is fetched (first click only — subsequent clicks use the
 * cached summary). On completion emits player:selected so the Matchup
 * Analyser pre-selects the player's next fixture, then navigates there.
 */
async function onPlayerClick(playerId) {
  const player = store.getPlayer(playerId);
  if (!player) return;

  // Mark the clicked row as loading — visible feedback without changing the
  // global banner (which says "Computing rankings…" and would be misleading here).
  const tr = _tbody.querySelector(`[data-player-id="${playerId}"]`);
  if (tr) tr.classList.add('is-loading');

  try {
    await ensurePlayerSummary(playerId);
  } catch (err) {
    // Non-fatal: navigate anyway; matchup will render with estimated scores.
    console.warn('[ranker] player summary fetch failed:', err.message ?? err);
  } finally {
    if (tr) tr.classList.remove('is-loading');
  }

  const nextFixture = getNextFixtureForTeam(player.teamId);
  if (nextFixture) {
    store.emit('player:selected', { fixtureId: nextFixture.id });
  }
  window.location.hash = 'matchup';
}

function onDataReady() {
  populateTeamFilter();
  rebuildRowsChunked();
}

function onHorizonChanged() {
  if (!store.isFresh()) return;
  rebuildRowsChunked();
}

/** Fill the team <select> with all teams sorted alphabetically. */
function populateTeamFilter() {
  if (!_teamSelect) return;
  const current = _teamSelect.value;
  const teams   = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
  _teamSelect.innerHTML =
    '<option value="all">All teams</option>' +
    teams.map(t =>
      `<option value="${t.id}"${String(t.id) === current ? ' selected' : ''}>${esc(t.name)}</option>`
    ).join('');
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the Player Ranker module. Called once from main.js on bootstrap.
 * Caches DOM refs, wires all control event listeners, registers store
 * subscriptions, and triggers an immediate render if the store is already
 * hydrated from sessionStorage.
 */
export function initRanker() {
  const root          = document.querySelector('[data-module="ranker"]');
  _thead              = root.querySelector('#ranker-thead');
  _tbody              = root.querySelector('#ranker-tbody');
  _loading            = root.querySelector('#ranker-loading');
  _teamSelect         = root.querySelector('#ranker-team');
  _priceSelect        = root.querySelector('#ranker-price');
  _vsToggle           = root.querySelector('#ranker-vs-toggle');
  _priceChangeToggle  = root.querySelector('#ranker-price-change-toggle');

  // ── Position filter toggle buttons ──────────────────────────────────────
  root.querySelectorAll('.ranker-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      if (_activePosSet.has(pos)) {
        // Keep at least one position active so the table is never empty.
        if (_activePosSet.size > 1) {
          _activePosSet.delete(pos);
          btn.classList.remove('is-active');
        }
      } else {
        _activePosSet.add(pos);
        btn.classList.add('is-active');
      }
      renderTable();
    });
  });

  // ── Price and team filters ───────────────────────────────────────────────
  _priceSelect?.addEventListener('change', () => {
    _activePriceBand = _priceSelect.value;
    renderTable();
  });

  _teamSelect?.addEventListener('change', () => {
    _activeTeamId = _teamSelect.value;
    renderTable();
  });

  // ── Value / £pt display toggle ───────────────────────────────────────────
  _vsToggle?.addEventListener('click', () => {
    _showVs               = !_showVs;
    _vsToggle.textContent = _showVs ? 'Show Value' : 'Show £/pt';
    _vsToggle.setAttribute('aria-pressed', String(_showVs));
    // Keep sort column aligned with the currently displayed metric.
    if (_showVs  && _sortBy === 'value')      _sortBy = 'valueScore';
    if (!_showVs && _sortBy === 'valueScore') _sortBy = 'value';
    renderTable();
  });

  // ── Price change column toggle ────────────────────────────────────────────
  _priceChangeToggle?.addEventListener('click', () => {
    _showPriceChange = !_showPriceChange;
    _priceChangeToggle.textContent = _showPriceChange ? 'Hide Price Changes' : 'Price Changes';
    _priceChangeToggle.setAttribute('aria-pressed', String(_showPriceChange));
    renderTable();
  });

  // ── Header sort — event delegation on <thead> ────────────────────────────
  _thead.addEventListener('click', e => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (_sortBy === col) {
      _sortDesc = !_sortDesc;
    } else {
      _sortBy   = col;
      _sortDesc = true;
    }
    renderTable();
  });

  // ── Row click — event delegation on <tbody> ──────────────────────────────
  _tbody.addEventListener('click', e => {
    const tr = e.target.closest('[data-player-id]');
    if (tr && !tr.classList.contains('is-loading')) {
      onPlayerClick(Number(tr.dataset.playerId));
    }
  });

  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);

  // If the store already has data (hydrated from sessionStorage, or data:ready
  // fired before this module registered its subscription), render right now
  // rather than waiting for an event that won't fire again.
  // onDataReady() uses setTimeout(0) to yield a paint frame for data refreshes
  // triggered mid-session; here we skip that deferral and render synchronously
  // so the table appears immediately on first load.
  if (store.isFresh()) {
    populateTeamFilter();
    rebuildRowsChunked();
  }
}
