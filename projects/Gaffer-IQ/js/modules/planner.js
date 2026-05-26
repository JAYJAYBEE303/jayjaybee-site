/**
 * js/modules/planner.js
 * Layer: module. Owns the DOM for the Transfer Planner view.
 * Side effects: DOM writes, sessionStorage reads/writes. Reads from store;
 * delegates all scoring to engine/composite.js exclusively via scorePlayer().
 * No analytical logic lives here — see FEATURE_ENGINE.md §10 and §11.
 * See ROADMAP.md Phase 2D, ARCHITECTURE.md §10.
 *
 * Subscriptions: data:ready, horizon:changed
 */

import { store } from '../store.js';
import { HORIZONS } from '../config.js';
import { buildScoreContext, scorePlayer } from '../engine/composite.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** sessionStorage key for squad persistence. */
const SS_KEY = 'gafferiq_squad_planner';

/** Maximum players per position in a valid 15-man squad. */
const SQUAD_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

/** Total squad size: 2 + 5 + 5 + 3 = 15. */
const SQUAD_TOTAL = Object.values(SQUAD_LIMITS).reduce((s, n) => s + n, 0);

/** Points deducted per hit transfer. */
const HIT_PENALTY = 4;

/** Max single-transfer recommendations to render. */
const TOP_N = 8;

/** Max pool size fed into the O(n²) 2-transfer combo search. */
const COMBO_POOL = 60;

// ─── Module-level state ───────────────────────────────────────────────────────

/** Ordered array of player IDs (max SQUAD_TOTAL). */
let _squad = [];

/** Remaining transfer budget in £m (e.g. 2.5 = £2.5m). */
let _budget = 0;

/** 1 or 2 free transfers available this GW. */
let _freeTransfers = 1;

/**
 * If true, model transfers beyond the free count (each costing −4 pts).
 * Controls whether the 2-transfer combo is shown when freeTransfers === 1.
 */
let _allowExtraHit = false;

/** Map<playerId, scorePlayer result> — rebuilt on squad/horizon changes. */
let _scores = new Map();

/** Active position set for the search dropdown filter. */
let _searchPosSet = new Set(['GKP', 'DEF', 'MID', 'FWD']);

/** True once data:ready has fired at least once. */
let _dataReady = false;

/**
 * True once wireDom() has attached all listeners.
 * Guards against double-wiring if data:ready fires more than once.
 */
let _domWired = false;

// ─── DOM refs (populated in wireDom) ─────────────────────────────────────────

let _root            = null;
let _searchInput     = null;
let _searchResults   = null;
let _squadSlots      = null;
let _tally           = null;
let _budgetInput     = null;
let _hitToggle       = null;
let _recommendations = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/** Build the engine scoring context from the current store state. */
function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    currentGw: store.getCurrentGw() ?? store.getNextGw() ?? 1,
  });
}

/** Resolve the active horizon object from the store. */
function getHorizon() {
  return HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW1;
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

/** Score every player in the squad over the active horizon. Populates _scores. */
function scoreSquad() {
  if (!_dataReady) return;
  const ctx = buildCtx();
  if (!ctx) return;
  const horizon = getHorizon();
  _scores = new Map();
  for (const id of _squad) {
    const player = store.getPlayer(id);
    if (!player) continue;
    try {
      _scores.set(id, scorePlayer(player, horizon, ctx));
    } catch (err) {
      console.warn('[planner] scorePlayer failed for player', id, err?.message ?? err);
    }
  }
}

// ─── Transfer computation ─────────────────────────────────────────────────────

/**
 * Compute all valid single-transfer swaps within the current budget.
 * Single transfers always use one free transfer — no hit applies.
 * @param {object} ctx  score context from buildCtx()
 * @returns {Array<SwapObj>}  sorted by delta descending
 */
function computeSingleSwaps(ctx) {
  if (!ctx || _squad.length < SQUAD_TOTAL) return [];

  const horizon    = getHorizon();
  const allPlayers = store.getPlayers();
  const swaps      = [];

  for (const outId of _squad) {
    const outPlayer = store.getPlayer(outId);
    const outScore  = _scores.get(outId);
    if (!outPlayer || !outScore) continue;

    // Candidates: same position, not currently in squad.
    const candidates = allPlayers.filter(p =>
      p.position === outPlayer.position && !isInSquad(p.id)
    );

    for (const inPlayer of candidates) {
      const priceDiff = (inPlayer.price ?? 0) - (outPlayer.price ?? 0);
      // Budget constraint: net spend must not exceed available budget.
      if (priceDiff > _budget) continue;

      let inScore;
      try {
        inScore = scorePlayer(inPlayer, horizon, ctx);
      } catch {
        continue;
      }

      swaps.push({
        outId,
        inId:      inPlayer.id,
        outPlayer,
        inPlayer,
        outScore,
        inScore,
        // Raw delta — hit penalty not applied here; single transfers are free.
        delta:     inScore.value - outScore.value,
        priceDiff,
        isHit:     false,
      });
    }
  }

  swaps.sort((a, b) => b.delta - a.delta);
  return swaps;
}

/**
 * Find the best 2-transfer combination from the top-COMBO_POOL singles.
 *
 * When freeTransfers === 1, the second transfer costs a hit (HIT_PENALTY
 * deducted from combinedDelta). When freeTransfers === 2, both are free.
 * Only called when _allowExtraHit is true or freeTransfers === 2.
 *
 * @param {Array<SwapObj>} singles  output of computeSingleSwaps(), sorted desc
 * @returns {{ swap1, swap2, combinedDelta, isHit } | null}
 */
function computeBestTwoSwap(singles) {
  if (!_allowExtraHit && _freeTransfers < 2) return null;
  if (singles.length < 2) return null;

  const pool    = singles.slice(0, COMBO_POOL);
  // MODEL: one hit is applied to the pair when only 1 FT is available.
  const hitCost = _freeTransfers === 1 ? HIT_PENALTY : 0;

  let best = null;
  let bestDelta = -Infinity;

  for (let i = 0; i < pool.length - 1; i++) {
    const s1 = pool[i];
    for (let j = i + 1; j < pool.length; j++) {
      const s2 = pool[j];

      // Structural validity: can't transfer the same player out twice,
      // bring in the same player twice, or swap someone in who is being swapped out.
      if (s1.outId === s2.outId) continue;
      if (s1.inId  === s2.inId)  continue;
      if (s1.inId  === s2.outId) continue;
      if (s2.inId  === s1.outId) continue;

      // Combined budget: net of both priceDiffs must not exceed budget.
      if (s1.priceDiff + s2.priceDiff > _budget) continue;

      const combinedDelta = s1.delta + s2.delta - hitCost;
      if (combinedDelta > bestDelta) {
        bestDelta = combinedDelta;
        best = { swap1: s1, swap2: s2, combinedDelta, isHit: hitCost > 0 };
      }
    }
  }

  return best;
}

// ─── Search results visibility helpers ───────────────────────────────────────

function showResults() {
  _searchResults?.classList.add('is-open');
}

function hideResults() {
  _searchResults?.classList.remove('is-open');
}

// ─── Render helpers ───────────────────────────────────────────────────────────

/**
 * Render a player's projected score as a mini card with breakdown bars.
 * Shows: name, team, position, price, composite score chip, Form/Fixture/Counter bars.
 * @param {Player}  player
 * @param {object}  score   scorePlayer output
 * @param {Team}    team
 * @param {'out'|'in'} direction
 */
function renderPlayerProjection(player, score, team, direction) {
  const bd      = score?.breakdown ?? {};
  const form    = Math.round(bd.form?.value    ?? 0);
  const fix     = Math.round(bd.fixture?.value ?? 0);
  const counter = Math.round(bd.counter?.value ?? 0);
  const price   = typeof player.price === 'number' ? player.price.toFixed(1) : '?.?';
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';

  return `
    <div class="planner-player planner-player--${esc(direction)}">
      <span class="planner-player__dir planner-player__dir--${esc(direction)}" aria-label="${direction === 'out' ? 'Transfer out' : 'Transfer in'}">${direction === 'out' ? 'OUT' : 'IN'}</span>
      <div class="planner-player__info">
        <div class="planner-player__name">
          ${esc(player.name)}${statusMark}
          <span class="planner-player__team-inline">${team ? esc(team.shortName) : '—'}</span>
          <span class="ranker-pos-badge ranker-pos-badge--${player.position.toLowerCase()}">${esc(player.position)}</span>
          <span class="planner-player__price">£${price}m</span>
        </div>
        <div class="planner-breakdown">
          <div class="planner-breakdown__bar">
            <span class="planner-breakdown__lbl">Form</span>
            <div class="planner-breakdown__track">
              <div class="planner-breakdown__fill" style="width:${form}%"></div>
            </div>
            <span class="planner-breakdown__val">${form}</span>
          </div>
          <div class="planner-breakdown__bar">
            <span class="planner-breakdown__lbl">Fixture</span>
            <div class="planner-breakdown__track">
              <div class="planner-breakdown__fill" style="width:${fix}%"></div>
            </div>
            <span class="planner-breakdown__val">${fix}</span>
          </div>
          <div class="planner-breakdown__bar">
            <span class="planner-breakdown__lbl">Counter</span>
            <div class="planner-breakdown__track">
              <div class="planner-breakdown__fill" style="width:${counter}%"></div>
            </div>
            <span class="planner-breakdown__val">${counter}</span>
          </div>
        </div>
      </div>
      <span class="score-chip score-chip--${esc(score?.band ?? 'neutral')}">${Math.round(score?.value ?? 0)}</span>
    </div>
  `.trim();
}

/**
 * Render a single transfer recommendation card.
 * @param {SwapObj} swap
 * @returns {string}  HTML string
 */
function renderTransferCard(swap) {
  const { outPlayer, inPlayer, outScore, inScore, delta, priceDiff, isHit } = swap;
  const outTeam   = store.getTeam(outPlayer.teamId);
  const inTeam    = store.getTeam(inPlayer.teamId);
  const dSign     = delta >= 0 ? '+' : '';
  const cSign     = priceDiff >= 0 ? '+' : '';
  const remaining = (_budget - priceDiff).toFixed(1);
  const hitBadge  = isHit
    ? `<span class="planner-hit-badge">HIT −${HIT_PENALTY}pts</span>`
    : '';

  return `
    <div class="planner-transfer-card">
      <div class="planner-transfer-card__header">
        <span class="planner-delta planner-delta--${delta >= 0 ? 'gain' : 'loss'}">${dSign}${delta.toFixed(1)}</span>
        <span class="planner-cost-diff">${cSign}£${Math.abs(priceDiff).toFixed(1)}m</span>
        <span class="planner-budget-remaining">£${remaining}m left</span>
        ${hitBadge}
      </div>
      <div class="planner-transfer-card__body">
        ${renderPlayerProjection(outPlayer, outScore, outTeam, 'out')}
        <div class="planner-transfer-card__arrow" aria-hidden="true">→</div>
        ${renderPlayerProjection(inPlayer, inScore, inTeam, 'in')}
      </div>
    </div>
  `.trim();
}

/**
 * Render the best 2-transfer combination card.
 * Shows a summary header plus both swaps, each with full player projections.
 * @param {{ swap1, swap2, combinedDelta, isHit }} twoSwap
 * @returns {string}  HTML string
 */
function renderTwoSwapCard(twoSwap) {
  const { swap1, swap2, combinedDelta, isHit } = twoSwap;
  const dSign     = combinedDelta >= 0 ? '+' : '';
  const combCost  = swap1.priceDiff + swap2.priceDiff;
  const cSign     = combCost >= 0 ? '+' : '';
  const remaining = (_budget - combCost).toFixed(1);
  const hitBadge  = isHit
    ? `<span class="planner-hit-badge">HIT −${HIT_PENALTY}pts applied</span>`
    : '';

  return `
    <div class="planner-transfer-card planner-transfer-card--double">
      <div class="planner-transfer-card__header planner-transfer-card__header--double">
        <span class="planner-section-label">Combined</span>
        <span class="planner-delta planner-delta--${combinedDelta >= 0 ? 'gain' : 'loss'}">${dSign}${combinedDelta.toFixed(1)}</span>
        <span class="planner-cost-diff">${cSign}£${Math.abs(combCost).toFixed(1)}m</span>
        <span class="planner-budget-remaining">£${remaining}m left</span>
        ${hitBadge}
      </div>
      <div class="planner-transfer-card__double-swaps">
        <div class="planner-transfer-card__swap-label">Swap 1</div>
        <div class="planner-transfer-card__body">
          ${renderPlayerProjection(swap1.outPlayer, swap1.outScore, store.getTeam(swap1.outPlayer.teamId), 'out')}
          <div class="planner-transfer-card__arrow" aria-hidden="true">→</div>
          ${renderPlayerProjection(swap1.inPlayer, swap1.inScore, store.getTeam(swap1.inPlayer.teamId), 'in')}
        </div>
        <div class="planner-transfer-card__swap-meta">
          <span class="planner-delta planner-delta--${swap1.delta >= 0 ? 'gain' : 'loss'} planner-delta--sm">
            ${swap1.delta >= 0 ? '+' : ''}${swap1.delta.toFixed(1)}
          </span>
          <span class="planner-cost-diff planner-cost-diff--sm">
            ${swap1.priceDiff >= 0 ? '+' : ''}£${Math.abs(swap1.priceDiff).toFixed(1)}m
          </span>
        </div>
        <hr class="planner-transfer-card__divider">
        <div class="planner-transfer-card__swap-label">Swap 2</div>
        <div class="planner-transfer-card__body">
          ${renderPlayerProjection(swap2.outPlayer, swap2.outScore, store.getTeam(swap2.outPlayer.teamId), 'out')}
          <div class="planner-transfer-card__arrow" aria-hidden="true">→</div>
          ${renderPlayerProjection(swap2.inPlayer, swap2.inScore, store.getTeam(swap2.inPlayer.teamId), 'in')}
        </div>
        <div class="planner-transfer-card__swap-meta">
          <span class="planner-delta planner-delta--${swap2.delta >= 0 ? 'gain' : 'loss'} planner-delta--sm">
            ${swap2.delta >= 0 ? '+' : ''}${swap2.delta.toFixed(1)}
          </span>
          <span class="planner-cost-diff planner-cost-diff--sm">
            ${swap2.priceDiff >= 0 ? '+' : ''}£${Math.abs(swap2.priceDiff).toFixed(1)}m
          </span>
        </div>
      </div>
    </div>
  `.trim();
}

// ─── Render: search results dropdown ─────────────────────────────────────────

function renderSearchResults() {
  if (!_searchResults || !_searchInput) return;

  const query = _searchInput.value.trim().toLowerCase();
  if (query.length < 2) {
    _searchResults.innerHTML = '';
    hideResults();
    return;
  }

  const allPlayers = store.getPlayers();
  if (!allPlayers.length) {
    _searchResults.innerHTML =
      `<li class="dash-search-results__empty">Player data not yet loaded — please wait.</li>`;
    showResults();
    return;
  }

  const results = allPlayers.filter(p => {
    if (!_searchPosSet.has(p.position)) return false;
    const name     = (p.name     ?? '').toLowerCase();
    const fullName = (p.fullName ?? '').toLowerCase();
    return name.includes(query) || fullName.includes(query);
  }).slice(0, 12);

  if (!results.length) {
    _searchResults.innerHTML =
      `<li class="dash-search-results__empty">No players found.</li>`;
    showResults();
    return;
  }

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
    const price = typeof p.price === 'number' ? p.price.toFixed(1) : '?.?';

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

  showResults();
}

// ─── Render: squad slots ──────────────────────────────────────────────────────

function renderSquadPanel() {
  if (_tally) {
    _tally.textContent = `${_squad.length} / ${SQUAD_TOTAL} players selected`;
  }
  if (!_squadSlots) return;

  _squadSlots.innerHTML = Object.entries(SQUAD_LIMITS).map(([pos, max]) => {
    const playersInPos = _squad
      .map(id => store.getPlayer(id))
      .filter(p => p?.position === pos);

    const slots = [
      ...playersInPos.map(player => {
        const score = _scores.get(player.id);
        const team  = store.getTeam(player.teamId);
        const chip  = score
          ? `<span class="score-chip score-chip--${esc(score.band)}">${Math.round(score.value)}</span>`
          : '';
        return `
          <div class="dash-squad-slot dash-squad-slot--filled">
            <span class="dash-squad-slot__name">${esc(player.name)}</span>
            <span class="dash-squad-slot__team">${team ? esc(team.shortName) : '—'}</span>
            ${chip}
            <button class="dash-squad-slot__remove"
                    data-remove-id="${player.id}"
                    type="button"
                    aria-label="Remove ${esc(player.name)}">×</button>
          </div>
        `.trim();
      }),
      ...Array.from({ length: max - playersInPos.length }, () =>
        `<div class="dash-squad-slot dash-squad-slot--empty">Empty slot</div>`
      ),
    ];

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
}

// ─── Render: transfer recommendations ────────────────────────────────────────

function renderRecommendations() {
  if (!_recommendations) return;

  if (_squad.length < SQUAD_TOTAL) {
    const remaining = SQUAD_TOTAL - _squad.length;
    _recommendations.innerHTML = `
      <p class="planner-hint">
        Add ${remaining} more player${remaining === 1 ? '' : 's'} to see transfer recommendations.
      </p>
    `.trim();
    return;
  }

  if (!_dataReady) {
    _recommendations.innerHTML = `<p class="planner-hint">Loading player data…</p>`;
    return;
  }

  const ctx = buildCtx();
  if (!ctx) {
    _recommendations.innerHTML = `<p class="planner-hint">No data available yet.</p>`;
    return;
  }

  const horizon    = getHorizon();
  const singles    = computeSingleSwaps(ctx);
  const twoSwap    = computeBestTwoSwap(singles);
  const topSingles = singles.slice(0, TOP_N);

  const parts = [];

  // ── Single transfers ──────────────────────────────────────────────────────
  const singlesMeta = topSingles.length > 0
    ? `Top ${topSingles.length} of ${singles.length} · ${esc(horizon.label)}`
    : `None found · ${esc(horizon.label)}`;

  parts.push(`
    <div class="planner-section">
      <div class="planner-section__hd">
        <span class="planner-section__title">Single Transfers</span>
        <span class="planner-section__meta">${singlesMeta}</span>
      </div>
      ${topSingles.length === 0
        ? `<p class="planner-hint">No single-transfer options within budget £${_budget.toFixed(1)}m.</p>`
        : topSingles.map(s => renderTransferCard(s)).join('')
      }
    </div>
  `.trim());

  // ── Best 2-transfer combo ─────────────────────────────────────────────────
  const showCombo  = _freeTransfers === 2 || _allowExtraHit;
  const comboMeta  = _freeTransfers === 1 && _allowExtraHit
    ? `<span class="planner-hit-badge">includes 1 hit</span>`
    : '';

  parts.push(`
    <div class="planner-section">
      <div class="planner-section__hd">
        <span class="planner-section__title">Best 2-Transfer Combo</span>
        ${comboMeta}
      </div>
      ${!showCombo
        ? `<p class="planner-hint">Enable the hit toggle or set free transfers to 2 to see double-swap recommendations.</p>`
        : !twoSwap
          ? `<p class="planner-hint">No valid 2-transfer combination found within budget £${_budget.toFixed(1)}m.</p>`
          : renderTwoSwapCard(twoSwap)
      }
    </div>
  `.trim());

  _recommendations.innerHTML = parts.join('');
}

// ─── After squad change ───────────────────────────────────────────────────────

function afterSquadChange() {
  scoreSquad();
  renderSquadPanel();
  renderRecommendations();
  if (_searchInput) _searchInput.value = '';
  hideResults();
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onSearchInput()  { renderSearchResults(); }
function onSearchFocus()  { if ((_searchInput?.value.trim().length ?? 0) >= 2) renderSearchResults(); }
function onSearchBlur()   { setTimeout(hideResults, 150); }

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    hideResults();
    _searchInput?.blur();
  }
}

/** mousedown fires before blur — keeps dropdown open long enough to register. */
function onResultsMousedown(e) {
  const item = e.target.closest('[data-player-id]');
  if (!item) return;
  if (item.classList.contains('dash-search-results__item--disabled')) return;
  const id = Number(item.dataset.playerId);
  if (!id) return;
  e.preventDefault();
  addPlayer(id);
}

function onSquadSlotsClick(e) {
  const btn = e.target.closest('[data-remove-id]');
  if (!btn) return;
  removePlayer(Number(btn.dataset.removeId));
}

function onBudgetChange() {
  const val = parseFloat(_budgetInput?.value ?? '0');
  _budget = isNaN(val) || val < 0 ? 0 : val;
  renderRecommendations();
}

/** Click on a free-transfer count button (1 or 2). */
function onFtClick(e) {
  const btn = e.target.closest('[data-ft]');
  if (!btn) return;
  const ft = Number(btn.dataset.ft);
  if (ft !== 1 && ft !== 2) return;
  _freeTransfers = ft;
  _root?.querySelectorAll('.planner-ft-btn').forEach(b => {
    b.classList.toggle('is-active', Number(b.dataset.ft) === ft);
  });
  renderRecommendations();
}

function onHitToggle() {
  _allowExtraHit = !_allowExtraHit;
  if (_hitToggle) {
    _hitToggle.setAttribute('aria-pressed', String(_allowExtraHit));
    _hitToggle.textContent = _allowExtraHit ? 'On' : 'Off';
    _hitToggle.classList.toggle('is-active', _allowExtraHit);
  }
  renderRecommendations();
}

/**
 * Cache all DOM refs and attach all event listeners. Called once from
 * onDataReady() — guaranteed to run after the browser has fully parsed the
 * document. The _domWired guard prevents double-wiring on repeated data:ready.
 */
function wireDom() {
  if (_domWired) return;

  _root            = document.querySelector('[data-module="planner"]');
  _searchInput     = document.getElementById('planner-search-input');
  _searchResults   = document.getElementById('planner-search-results');
  _squadSlots      = document.getElementById('planner-squad-slots');
  _tally           = document.getElementById('planner-squad-tally');
  _budgetInput     = document.getElementById('planner-budget');
  _hitToggle       = document.getElementById('planner-hit-toggle');
  _recommendations = document.getElementById('planner-recommendations');

  if (!_root) {
    console.warn('[planner] data-module="planner" section not found in DOM');
    return;
  }

  // ── Search events ─────────────────────────────────────────────────────────
  _searchInput?.addEventListener('input',   onSearchInput);
  _searchInput?.addEventListener('focus',   onSearchFocus);
  _searchInput?.addEventListener('blur',    onSearchBlur);
  _searchInput?.addEventListener('keydown', onSearchKeydown);

  // ── Results dropdown — mousedown fires before blur ────────────────────────
  _searchResults?.addEventListener('mousedown', onResultsMousedown);

  // ── Position filter pills ─────────────────────────────────────────────────
  _root.querySelectorAll('.planner-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      if (_searchPosSet.has(pos)) {
        if (_searchPosSet.size > 1) {
          _searchPosSet.delete(pos);
          btn.classList.remove('is-active');
        }
      } else {
        _searchPosSet.add(pos);
        btn.classList.add('is-active');
      }
      if (_searchResults?.classList.contains('is-open')) renderSearchResults();
    });
  });

  // ── Squad slots — click delegation for remove buttons ────────────────────
  _squadSlots?.addEventListener('click', onSquadSlotsClick);

  // ── Budget input ──────────────────────────────────────────────────────────
  _budgetInput?.addEventListener('input',  onBudgetChange);
  _budgetInput?.addEventListener('change', onBudgetChange);

  // ── Free transfer count toggle ────────────────────────────────────────────
  _root.querySelector('.planner-ft-btns')?.addEventListener('click', onFtClick);

  // ── Hit toggle ────────────────────────────────────────────────────────────
  _hitToggle?.addEventListener('click', onHitToggle);

  // ── Restore from sessionStorage and render the initial shell ─────────────
  loadSquad();
  renderSquadPanel();
  renderRecommendations();

  _domWired = true;
  console.log('[planner] DOM wired');
}

// ─── Store event handlers ─────────────────────────────────────────────────────

function onDataReady() {
  wireDom();          // no-op after first call
  _dataReady = true;
  scoreSquad();
  renderSquadPanel();
  renderRecommendations();
}

function onHorizonChanged() {
  if (!_dataReady) return;
  // Re-score squad against the new horizon and re-compute transfer recommendations.
  scoreSquad();
  renderSquadPanel();
  renderRecommendations();
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the Transfer Planner module. Called once from main.js before
 * loadInitialData(). Registers store subscriptions so the module is ready
 * to receive events whenever the fetch completes. All DOM wiring is deferred
 * to wireDom(), called from onDataReady().
 */
export function initPlanner() {
  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);

  // If the store is already hydrated (sessionStorage), wire up immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
