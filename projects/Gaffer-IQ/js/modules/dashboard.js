/**
 * js/modules/dashboard.js
 * Layer: module. Owns the DOM for the GW Decision Dashboard view.
 * Side effects: DOM writes, sessionStorage reads/writes. Reads from store;
 * delegates all scoring to engine/composite.js exclusively.
 * No analytical logic lives here — scorePlayer(player, HORIZONS.GW1, ctx)
 * is the sole engine call. Horizon is locked to GW1; the global horizon
 * switcher has no effect on this module. See ROADMAP.md Phase 2C.
 *
 * Subscriptions: data:ready
 */

import { store } from '../store.js';
import { HORIZONS } from '../config.js';
import { buildScoreContext, scorePlayer } from '../engine/composite.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** sessionStorage key for squad persistence (ARCHITECTURE.md §6). */
const SS_KEY = 'gafferiq_squad';

/** Dashboard is horizon-locked to GW1 — ignores the global horizon switcher. */
const HORIZON = HORIZONS.GW1;

/** Maximum players per position in a valid 15-man squad. */
const SQUAD_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

/** Total squad size: 2 + 5 + 5 + 3 = 15. */
const SQUAD_TOTAL = Object.values(SQUAD_LIMITS).reduce((s, n) => s + n, 0);

/**
 * minutesSecurity below this threshold → "Rotation Risk" flag.
 * Mirrors MIN_SEC_LEVELS[1].threshold in ranker.js (0.65 = "Likely" cutoff).
 */
const MIN_SEC_RISK = 0.65;

// ─── Module-level state ───────────────────────────────────────────────────────

/** Ordered array of player IDs currently in the squad (max SQUAD_TOTAL). */
let _squad = [];

/** Map<playerId, scorePlayer result> — rebuilt on data:ready + squad changes. */
let _scores = new Map();

/** Active position set for the search dropdown filter. */
let _searchPosSet = new Set(['GKP', 'DEF', 'MID', 'FWD']);

/** True once data:ready has fired at least once. */
let _dataReady = false;

/**
 * True once wireDom() has successfully cached DOM refs and attached listeners.
 * Guards against double-wiring if data:ready fires more than once.
 */
let _domWired = false;

// ─── DOM refs (populated in wireDom, called from onDataReady) ────────────────

let _root          = null;
let _searchInput   = null;
let _searchResults = null;
let _squadSlots    = null;
let _decisions     = null;
let _tally         = null;

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
 * breakdown directly. Used to add score-chip--estimated where appropriate.
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

// ─── Squad persistence ────────────────────────────────────────────────────────

function loadSquad() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _squad = parsed.filter(id => typeof id === 'number');
    }
  } catch { /* corrupt — ignore and start fresh */ }
}

function saveSquad() {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(_squad));
  } catch { /* quota exceeded — non-fatal */ }
}

// ─── Squad management ─────────────────────────────────────────────────────────

function squadCountByPos(pos) {
  return _squad.filter(id => store.getPlayer(id)?.position === pos).length;
}

function isInSquad(playerId) {
  return _squad.includes(playerId);
}

/**
 * Returns true if the given player can legally be added to the squad
 * (squad not full, position slot available, not already present).
 */
function canAdd(player) {
  if (!player) return false;
  if (_squad.length >= SQUAD_TOTAL) return false;
  if (isInSquad(player.id)) return false;
  if (squadCountByPos(player.position) >= SQUAD_LIMITS[player.position]) return false;
  return true;
}

function addPlayer(playerId) {
  const player = store.getPlayer(playerId);
  if (!player || !canAdd(player)) return;
  _squad.push(playerId);
  saveSquad();
  afterSquadChange();
}

function removePlayer(playerId) {
  const idx = _squad.indexOf(playerId);
  if (idx < 0) return;
  _squad.splice(idx, 1);
  saveSquad();
  afterSquadChange();
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score every player in the squad using HORIZONS.GW1 (locked).
 * Populates _scores. Silently skips players whose team is absent from ctx.
 */
function scoreSquad() {
  if (!_dataReady) return;
  const ctx = buildCtx();
  if (!ctx) return;
  _scores = new Map();
  for (const id of _squad) {
    const player = store.getPlayer(id);
    if (!player) continue;
    try {
      _scores.set(id, scorePlayer(player, HORIZON, ctx));
    } catch (err) {
      console.warn('[dashboard] scorePlayer failed for player', id, err.message ?? err);
    }
  }
}

// ─── Starting XI picker ───────────────────────────────────────────────────────

/**
 * Select the optimal valid starting XI from the scored squad.
 * Formation rules (ROADMAP.md Phase 2C):
 *   • Exactly  1 GKP
 *   • Minimum  3 DEF
 *   • Minimum  2 MID
 *   • Minimum  1 FWD
 *   • Exactly 11 players total
 *
 * Algorithm: fill minimums by score descending, then fill the remaining
 * 4 outfield slots from the leftover pool (sorted by score descending).
 * Bench is ordered: outfield-by-score-desc, bench GKP always last.
 *
 * @param {Array<{player: Player, score: object}>} scoredSquad  15 entries
 * @returns {{ xi: Array<{player,score}>, bench: Array<{player,score}> }}
 */
function pickStartingXI(scoredSquad) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const entry of scoredSquad) {
    const pos = entry.player.position;
    if (byPos[pos]) byPos[pos].push(entry);
  }
  // Sort each group descending by projected value.
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => b.score.value - a.score.value);
  }

  const xi = [];

  // 1 GKP starts; the second GKP goes to bench (always last position).
  xi.push(byPos.GKP[0]);
  const benchGkp = byPos.GKP[1] ?? null;

  // Fill position minimums from the top scorers in each group.
  const defMin = byPos.DEF.slice(0, 3);   // exactly 3
  const midMin = byPos.MID.slice(0, 2);   // exactly 2
  const fwdMin = byPos.FWD.slice(0, 1);   // exactly 1
  xi.push(...defMin, ...midMin, ...fwdMin);
  // xi.length = 1 + 3 + 2 + 1 = 7 — need 4 more from the outfield pool.

  // Build pool: remaining outfielders not already in XI.
  const pool = [
    ...byPos.DEF.slice(3),   // DEF[3–4] — up to 2
    ...byPos.MID.slice(2),   // MID[2–4] — up to 3
    ...byPos.FWD.slice(1),   // FWD[1–2] — up to 2
  ].sort((a, b) => b.score.value - a.score.value);
  // pool.length = 7; take top 4 into XI, remaining 3 to bench.

  xi.push(...pool.slice(0, 4));
  // xi.length = 11 ✓

  // Bench outfielders = pool remainder (already sorted desc by score).
  const benchOutfield = pool.slice(4);

  // Ordered bench: outfield-score-desc, GKP always last.
  const bench = benchGkp ? [...benchOutfield, benchGkp] : benchOutfield;

  return { xi, bench };
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
  if (score.band === 'brutal')          flags.push('fixture');
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

function buildFlagChips(flags) {
  return flags.map(f =>
    `<span class="dash-flag dash-flag--${esc(f)}">${esc(FLAG_LABELS[f] ?? f)}</span>`
  ).join('');
}

// ─── Search results visibility helpers ───────────────────────────────────────

/**
 * Show the results dropdown.
 * Uses a CSS class rather than the `hidden` attribute so there is no conflict
 * with the `[hidden] { display: none !important; }` rule in base.css.
 */
function showResults() {
  if (!_searchResults) return;
  _searchResults.classList.add('is-open');
}

/** Hide the results dropdown. */
function hideResults() {
  if (!_searchResults) return;
  _searchResults.classList.remove('is-open');
}

// ─── Render: search results dropdown ─────────────────────────────────────────

function renderSearchResults() {
  // Guard: DOM refs must be present. Warn once so the console makes it obvious.
  if (!_searchResults) {
    console.warn('[dashboard] renderSearchResults: _searchResults is null — check #dash-search-results in HTML');
    return;
  }
  if (!_searchInput) {
    console.warn('[dashboard] renderSearchResults: _searchInput is null — check #dash-search-input in HTML');
    return;
  }

  const query = _searchInput.value.trim().toLowerCase();

  if (query.length < 2) {
    _searchResults.innerHTML = '';
    hideResults();
    return;
  }

  // Read player list from the store at call time — store.getPlayers() may return
  // an empty array if called before data:ready, but since the event listener fires
  // only when the user types, data should already be loaded by then.
  const allPlayers = store.getPlayers();
  if (allPlayers.length === 0) {
    _searchResults.innerHTML =
      `<li class="dash-search-results__empty">Player data not yet loaded — please wait a moment.</li>`;
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
    _searchResults.innerHTML =
      `<li class="dash-search-results__empty">No players found.</li>`;
    showResults();
    return;
  }

  try {
    _searchResults.innerHTML = results.map(p => {
      const team         = store.getTeam(p.teamId);
      const inSquad      = isInSquad(p.id);
      const posSlotsFull = squadCountByPos(p.position) >= SQUAD_LIMITS[p.position];
      const squadFull    = _squad.length >= SQUAD_TOTAL;
      const disabled     = inSquad || posSlotsFull || squadFull;
      const reason       = inSquad      ? 'Already in squad'
                         : posSlotsFull ? `${p.position} slots full`
                         : squadFull    ? 'Squad full'
                         : '';
      const price = (typeof p.price === 'number' && !isNaN(p.price))
        ? p.price.toFixed(1) : '?.?';

      return `
        <li class="dash-search-results__item${disabled ? ' dash-search-results__item--disabled' : ''}"
            data-player-id="${p.id}"
            role="option"
            aria-disabled="${disabled}"
            title="${disabled ? esc(reason) : esc(p.fullName ?? p.name ?? '')}">
          <span class="dash-search-results__name">${esc(p.name ?? '?')}</span>
          <span class="dash-search-results__meta">${team ? esc(team.shortName) : '—'} · ${esc(p.position ?? '?')} · £${price}m</span>
        </li>
      `.trim();
    }).join('');
  } catch (err) {
    console.error('[dashboard] renderSearchResults: innerHTML build threw —', err);
    hideResults();
    return;
  }

  showResults();
}

// ─── Render: squad slots ──────────────────────────────────────────────────────

function renderSquadPanel() {
  if (_tally) {
    _tally.textContent = `${_squad.length} / ${SQUAD_TOTAL} players selected`;
  }

  if (!_squadSlots) return;

  const html = Object.entries(SQUAD_LIMITS).map(([pos, max]) => {
    // Players in this squad at this position (insertion order).
    const playersInPos = _squad
      .map(id => store.getPlayer(id))
      .filter(p => p?.position === pos);

    const slots = [];

    // Filled slots.
    for (const player of playersInPos) {
      const score = _scores.get(player.id);
      const team  = store.getTeam(player.teamId);
      const estClass = score && isScoreEstimated(score) ? ' score-chip--estimated' : '';
      const chip  = score
        ? `<span class="score-chip score-chip--${esc(score.band)}${estClass}">${Math.round(score.value)}</span>`
        : '';
      slots.push(`
        <div class="dash-squad-slot dash-squad-slot--filled">
          <span class="dash-squad-slot__name">${esc(player.name)}</span>
          <span class="dash-squad-slot__team">${team ? esc(team.shortName) : '—'}</span>
          ${chip}
          <button class="dash-squad-slot__remove"
                  data-remove-id="${player.id}"
                  type="button"
                  aria-label="Remove ${esc(player.name)}">×</button>
        </div>
      `.trim());
    }

    // Empty slots.
    const emptyCount = max - playersInPos.length;
    for (let i = 0; i < emptyCount; i++) {
      slots.push(`<div class="dash-squad-slot dash-squad-slot--empty">Empty slot</div>`);
    }

    return `
      <div class="dash-squad-group">
        <div class="dash-squad-group__header">
          <span>${esc(pos)}</span>
          <span>${playersInPos.length} / ${max}</span>
        </div>
        ${slots.join('')}
      </div>
    `.trim();
  }).join('');

  _squadSlots.innerHTML = html;
}

// ─── Render: decisions panel ──────────────────────────────────────────────────

function renderDecisions() {
  if (!_decisions) return;

  if (_squad.length < SQUAD_TOTAL) {
    const remaining = SQUAD_TOTAL - _squad.length;
    _decisions.innerHTML = `
      <p class="dash-decisions__hint">
        Add ${remaining} more player${remaining === 1 ? '' : 's'} to see GW recommendations.
      </p>
    `.trim();
    return;
  }

  if (!_dataReady) {
    _decisions.innerHTML = `<p class="dash-decisions__hint">Loading player data…</p>`;
    return;
  }

  // Build scored squad — filter out any player no longer in the store.
  const scoredSquad = _squad
    .map(id => ({ player: store.getPlayer(id), score: _scores.get(id) }))
    .filter(e => e.player && e.score);

  if (scoredSquad.length < SQUAD_TOTAL) {
    _decisions.innerHTML = `<p class="dash-decisions__hint">Computing scores…</p>`;
    return;
  }

  const { xi, bench } = pickStartingXI(scoredSquad);

  // Captain = highest scorer in the starting XI.
  const captainEntry = xi.reduce(
    (best, e) => (!best || e.score.value > best.score.value ? e : best),
    null,
  );
  const captainId = captainEntry?.player.id ?? null;

  _decisions.innerHTML = [
    renderCaptainBlock(captainEntry),
    renderXIBlock(xi, captainId),
    renderBenchBlock(bench),
  ].join('');
}

// ─── Render: captain block ────────────────────────────────────────────────────

function renderCaptainBlock(entry) {
  if (!entry) return '';
  const { player, score } = entry;
  const team = store.getTeam(player.teamId);
  const flags = getRiskFlags(player, score);
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';

  // Breakdown bars: raw sub-scores (0–100) for Form, Fixture, Counter.
  const bd   = score.breakdown ?? {};
  const bars = [
    { label: 'Form',    value: Math.round(bd.form?.value    ?? 0) },
    { label: 'Fixture', value: Math.round(bd.fixture?.value ?? 0) },
    { label: 'Counter', value: Math.round(bd.counter?.value ?? 0) },
  ].map(({ label, value }) => `
    <div class="dash-captain__breakdown-bar">
      <span class="dash-captain__breakdown-label">${esc(label)}</span>
      <div class="dash-captain__breakdown-track">
        <div class="dash-captain__breakdown-fill" style="width:${value}%"></div>
      </div>
      <span class="dash-captain__breakdown-value">${value}</span>
    </div>
  `.trim()).join('');

  const flagsHtml = flags.length
    ? `<div class="dash-player-row__flags" style="margin-top:var(--space-2)">${buildFlagChips(flags)}</div>`
    : '';

  return `
    <div class="dash-captain">
      <div class="dash-captain__header">
        <span class="dash-captain__badge" aria-label="Captain">C</span>
        <div>
          <div class="dash-captain__title">Captain Pick</div>
          <div class="dash-captain__name">
            ${esc(player.name)}${statusMark}${team ? `<span class="dash-captain__team">${esc(team.shortName)}</span>` : ''}
          </div>
        </div>
        <span class="score-chip score-chip--${esc(score.band)}${isScoreEstimated(score) ? ' score-chip--estimated' : ''}" style="margin-left:auto">${Math.round(score.value)}</span>
      </div>
      ${flagsHtml}
      <div class="dash-captain__breakdown">${bars}</div>
    </div>
  `.trim();
}

// ─── Render: player row (shared by XI and bench) ──────────────────────────────

function renderPlayerRow(entry, captainId) {
  const { player, score } = entry;
  const team      = store.getTeam(player.teamId);
  const isCaptain = player.id === captainId;
  const flags     = getRiskFlags(player, score);
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';

  return `
    <div class="dash-player-row${isCaptain ? ' dash-player-row--captain' : ''}">
      <span class="dash-player-row__pos-badge">
        <span class="ranker-pos-badge ranker-pos-badge--${player.position.toLowerCase()}">${esc(player.position)}</span>
      </span>
      <span class="dash-player-row__name">
        ${esc(player.name)}${statusMark}${isCaptain ? '<span class="dash-player-row__captain-mark">&nbsp;(C)</span>' : ''}
      </span>
      <span class="dash-player-row__team">${team ? esc(team.shortName) : '—'}</span>
      <span class="dash-player-row__score">
        <span class="score-chip score-chip--${esc(score.band)}${isScoreEstimated(score) ? ' score-chip--estimated' : ''}">${Math.round(score.value)}</span>
      </span>
      ${flags.length ? `<span class="dash-player-row__flags">${buildFlagChips(flags)}</span>` : ''}
    </div>
  `.trim();
}

// ─── Render: Starting XI block ────────────────────────────────────────────────

function renderXIBlock(xi, captainId) {
  // Display order: GKP → DEF → MID → FWD, each group score-desc.
  const posOrder = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  const sorted = xi.slice().sort((a, b) => {
    const pd = posOrder[a.player.position] - posOrder[b.player.position];
    return pd !== 0 ? pd : b.score.value - a.score.value;
  });

  return `
    <div class="dash-xi">
      <div class="dash-xi__header">
        <span>Starting XI</span>
        <span>Score</span>
      </div>
      ${sorted.map(e => renderPlayerRow(e, captainId)).join('')}
    </div>
  `.trim();
}

// ─── Render: Bench block ──────────────────────────────────────────────────────

function renderBenchBlock(bench) {
  if (!bench || bench.length === 0) return '';
  return `
    <div class="dash-bench">
      <div class="dash-bench__header">
        <span>Bench (priority order)</span>
        <span>Score</span>
      </div>
      ${bench.map(e => renderPlayerRow(e, null)).join('')}
    </div>
  `.trim();
}

// ─── After squad change ───────────────────────────────────────────────────────

/**
 * Common callback after any squad mutation. Re-scores, re-renders the squad
 * panel and decisions panel, and resets the search input.
 */
function afterSquadChange() {
  scoreSquad();
  renderSquadPanel();
  renderDecisions();
  // Clear search so the user isn't looking at stale results.
  if (_searchInput) _searchInput.value = '';
  hideResults();
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onSearchInput() {
  renderSearchResults();
}

function onSearchFocus() {
  // Re-render if there is already a qualifying query in the box.
  if ((_searchInput?.value.trim().length ?? 0) >= 2) renderSearchResults();
}

function onSearchBlur() {
  // Delay so a mousedown on a result item fires before the list hides.
  setTimeout(hideResults, 150);
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    hideResults();
    _searchInput?.blur();
  }
}

/**
 * mousedown (not click) on the results list: fires before the input's blur
 * event, so the dropdown remains visible long enough for the selection to land.
 */
function onResultsMousedown(e) {
  const item = e.target.closest('[data-player-id]');
  if (!item) return;
  if (item.classList.contains('dash-search-results__item--disabled')) return;
  const id = Number(item.dataset.playerId);
  if (!id) return;
  // Prevent blur so the dropdown doesn't hide before the click registers.
  e.preventDefault();
  addPlayer(id);
}

/** Click-delegation on the squad slots panel for remove buttons. */
function onSquadSlotsClick(e) {
  const btn = e.target.closest('[data-remove-id]');
  if (!btn) return;
  removePlayer(Number(btn.dataset.removeId));
}

/**
 * Cache all DOM refs and attach all event listeners. Called once from
 * onDataReady() — guaranteed to run after the browser has fully parsed the
 * document (module scripts are deferred, and data:ready only fires after the
 * fetch resolves). The _domWired guard prevents double-wiring if data:ready
 * fires more than once (e.g. after a manual refresh via __refresh()).
 */
function wireDom() {
  if (_domWired) return;

  // Use getElementById directly — does not depend on _root being non-null.
  _root          = document.querySelector('[data-module="dashboard"]');
  _searchInput   = document.getElementById('dash-search-input');
  _searchResults = document.getElementById('dash-search-results');
  _squadSlots    = document.getElementById('dash-squad-slots');
  _decisions     = document.getElementById('dash-decisions');
  _tally         = document.getElementById('dash-squad-tally');

  if (!_root) {
    console.warn('[dashboard] data-module="dashboard" section not found in DOM');
    return;
  }
  if (!_searchInput) {
    console.warn('[dashboard] #dash-search-input not found in DOM');
    return;
  }

  // ── Search events ────────────────────────────────────────────────────────
  _searchInput.addEventListener('input',   onSearchInput);
  _searchInput.addEventListener('focus',   onSearchFocus);
  _searchInput.addEventListener('blur',    onSearchBlur);
  _searchInput.addEventListener('keydown', onSearchKeydown);

  // ── Results dropdown — mousedown fires before the blur event ─────────────
  _searchResults?.addEventListener('mousedown', onResultsMousedown);

  // ── Position filter pills ────────────────────────────────────────────────
  _root.querySelectorAll('.dash-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      if (_searchPosSet.has(pos)) {
        // Keep at least one position active.
        if (_searchPosSet.size > 1) {
          _searchPosSet.delete(pos);
          btn.classList.remove('is-active');
        }
      } else {
        _searchPosSet.add(pos);
        btn.classList.add('is-active');
      }
      // Re-render the dropdown if it is currently visible.
      if (_searchResults?.classList.contains('is-open')) renderSearchResults();
    });
  });

  // ── Squad slots — click delegation for remove buttons ────────────────────
  _squadSlots?.addEventListener('click', onSquadSlotsClick);

  // ── Restore squad from sessionStorage and render the shell ───────────────
  loadSquad();
  renderSquadPanel();
  renderDecisions();

  _domWired = true;
  console.log('[dashboard] DOM wired — search input listener attached');
}

function onDataReady() {
  wireDom();          // no-op after first call
  _dataReady = true;
  scoreSquad();
  renderSquadPanel();
  renderDecisions();
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the GW Decision Dashboard module. Called once from main.js on
 * bootstrap, before loadInitialData(). Registers the data:ready subscription
 * so the module is ready to receive the event whenever the fetch completes.
 * All DOM wiring is deferred to wireDom(), called from onDataReady(), so that
 * getElementById calls are guaranteed to find live elements.
 */
export function initDashboard() {
  store.subscribe('data:ready', onDataReady);

  // If the store is already hydrated from sessionStorage, data:ready won't
  // fire again — wire the DOM and render immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
