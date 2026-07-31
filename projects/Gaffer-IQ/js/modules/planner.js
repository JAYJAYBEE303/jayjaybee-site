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
import { HORIZONS, PRICE_BUY_NOW_CONFIDENCE, PRICE_BUY_NOW_SCORE_MIN } from '../config.js';
import { buildScoreContext, scorePlayer, rankPlayers, attachRankTiers } from '../engine/composite.js';
import { calcPriceChangeRisk } from '../engine/prices.js';
import {
  scoreWildcardTiming, scoreFreeHitTiming,
  scoreBenchBoostTiming, scoreTripleCaptainTiming,
} from '../engine/chips.js';
import { fetchAndMapSquad, loadSavedTeamId, saveTeamId, resolveImportGw } from '../squadImport.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** localStorage key for chip-usage tracking (Phase 4-3). Persists across sessions
 *  because chip usage is a season-long decision the user makes once per chip. */
const CHIPS_USED_KEY = 'gafferiq_chips_used';

/** Canonical chip identifiers. Order = render order in the chips panel. */
const CHIP_IDS = ['wildcard', 'freehit', 'benchboost', 'triplecaptain'];

/** Human labels for chips, keyed by chip id. */
const CHIP_LABELS = {
  wildcard:      'Wildcard',
  freehit:       'Free Hit',
  benchboost:    'Bench Boost',
  triplecaptain: 'Triple Captain',
};

/** Number of squad players treated as bench for Bench Boost analysis.
 *  MODEL: 4 = 1 GK + 3 outfield bench in FPL. The planner picks the four
 *  lowest-projected squad members as a heuristic (no XI selection in scope). */
const BENCH_SIZE = 4;

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
//
// NOTE: the squad itself is NOT module-level state — it lives in store.js
// (store.getSquad()/setSquad()), shared with the Dashboard. See
// afterSquadChange() and initPlanner()'s 'squad:updated' subscription.

// ─── Import state (Phase 4-1) ─────────────────────────────────────────────────

/** FPL team ID last used for a successful import, or null. */
let _importedTeamId = null;

/** Raw FPL entry object from last import (name, rank, etc.), or null. */
let _importedEntryInfo = null;

/** True while an import fetch is in flight — prevents concurrent imports. */
let _importInFlight = false;

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

/**
 * Map<playerId, 'positionElite'|'positionStrong'|'bottomPercentile'|null> — every player's standing
 * against the full pool (FEATURE_ENGINE.md §13), keyed by whichever horizon
 * last built it. null until computed. Rebuilding this depends on horizon (a
 * player's score, and therefore rank, differs by horizon) but NOT on squad
 * membership, so it is invalidated on data:ready/horizon:changed only — not
 * re-scored on every add/remove, which would cost ~700 scorePlayer calls per
 * click for no reason.
 */
let _rankTierByPlayerId = null;

/** Set<chipId> of chips the user has marked as already used this season. */
let _chipsUsed = new Set();

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
let _chipsPanel      = null;

// Import panel refs (Phase 4-1)
let _importBtn     = null;
let _importPanel   = null;
let _importIdInput = null;
let _importStatus  = null;
let _importInfo    = null;

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
 * Used to apply score-chip--estimated and planner-delta--estimated.
 */
function isScoreEstimated(score) {
  return Boolean(score?.breakdown?.form?.estimated || score?.breakdown?.counter?.estimated);
}

/** rankTier (composite.js → calcRankTier) → the .score-chip--rank-* modifier
 *  suffix, or '' when the player isn't in any standout tier (keeps their
 *  existing band colour). Mirrors the identical helper in modules/ranker.js.
 *  See FEATURE_ENGINE.md §13. */
function rankTierClass(rankTier) {
  if (rankTier === 'positionElite')    return ' score-chip--rank-green';
  if (rankTier === 'positionStrong')   return ' score-chip--rank-light-green';
  if (rankTier === 'topPercentile')    return ' score-chip--rank-neutral';
  if (rankTier === 'bottomPercentile') return ' score-chip--rank-red';
  if (rankTier === 'midPercentile')    return ' score-chip--rank-yellow';
  return '';
}

/** Build the engine scoring context from the current store state. */
function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgPrev2: store.getLeagueXgPrev2(),
    currentGw: store.getCurrentGw() ?? store.getNextGw() ?? 1,
  });
}

/** Resolve the active horizon object from the store. */
function getHorizon() {
  return HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW1;
}

// ─── Chip-usage persistence (Phase 4-3) ──────────────────────────────────────

/**
 * Load chip-used state from localStorage. Survives page reloads — chip usage
 * is a season-long decision, not a session one. No FPL API endpoint reports
 * chip usage without auth, so this is manually toggled per ROADMAP Phase 4-3.
 */
function loadChipsUsed() {
  try {
    const raw = localStorage.getItem(CHIPS_USED_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _chipsUsed = new Set(parsed.filter(id => CHIP_IDS.includes(id)));
    }
  } catch { /* corrupt — ignore and start fresh */ }
}

function saveChipsUsed() {
  try {
    localStorage.setItem(CHIPS_USED_KEY, JSON.stringify([..._chipsUsed]));
  } catch { /* quota exceeded — non-fatal */ }
}

// ─── Squad management ─────────────────────────────────────────────────────────
// Reads store.getSquad() directly rather than caching a local copy — the
// store is the only source of truth (CONVENTIONS.md §8), and afterSquadChange()
// (subscribed to 'squad:updated') is what re-renders after any mutation, from
// either this module or the Dashboard.

function squadCountByPos(pos) {
  return store.getSquad().filter(id => store.getPlayer(id)?.position === pos).length;
}

function isInSquad(playerId) {
  return store.getSquad().includes(playerId);
}

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
  // call here — the same path the Dashboard's edits take, so both modules
  // react identically regardless of which one made the change.
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

/** Score every player in the squad over the active horizon. Populates _scores. */
function scoreSquad() {
  if (!_dataReady) return;
  const ctx = buildCtx();
  if (!ctx) return;
  const horizon = getHorizon();
  _scores = new Map();
  for (const id of store.getSquad()) {
    const player = store.getPlayer(id);
    if (!player) continue;
    try {
      _scores.set(id, scorePlayer(player, horizon, ctx));
    } catch (err) {
      console.warn('[planner] scorePlayer failed for player', id, err?.message ?? err);
    }
  }
  ensureRankTiers(ctx, horizon);
}

/**
 * Rank tier (FEATURE_ENGINE.md §13) needs a player's standing against the
 * FULL player pool, not just the squad or the swap candidates a single search
 * happens to touch — "top 30 in the game" has to mean the same thing here as
 * on the Ranker/Dashboard. Cached because it depends only on ctx/horizon, not
 * on squad membership: re-scoring ~700 players on every add/remove click
 * would be wasted work. _rankTierByPlayerId is invalidated by the caller
 * (onDataReady/onHorizonChanged) whenever the inputs it depends on change.
 */
function ensureRankTiers(ctx, horizon) {
  if (_rankTierByPlayerId !== null) return;
  try {
    const ranked = attachRankTiers(rankPlayers(store.getPlayers(), horizon, ctx));
    _rankTierByPlayerId = new Map(ranked.map(r => [r.player.id, r.rankTier]));
  } catch (err) {
    console.warn('[planner] full-pool rank computation failed', err?.message ?? err);
    _rankTierByPlayerId = new Map();
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
  if (!ctx || store.getSquad().length < SQUAD_TOTAL) return [];

  const horizon    = getHorizon();
  const allPlayers = store.getPlayers();
  const swaps      = [];

  for (const outId of store.getSquad()) {
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
      <span class="score-chip score-chip--${esc(score?.band ?? 'neutral')}${isScoreEstimated(score) ? ' score-chip--estimated' : ''}${rankTierClass(_rankTierByPlayerId?.get(player.id))}">${Math.round(score?.value ?? 0)}</span>
    </div>
  `.trim();
}

/**
 * Build a price change warning snippet for a transfer-in player.
 * Returns an empty string when there is no meaningful signal.
 * @param {Player} player  the player being transferred in
 * @param {object} score   scorePlayer output for the inPlayer
 * @returns {string}  HTML string (may be empty)
 */
function buildPriceChangeWarning(player, score) {
  const risk = calcPriceChangeRisk(player);
  if (risk.confidence === 0) return '';

  const pct  = Math.round(risk.confidence * 100);
  const isBuyNow = risk.direction === 'rise'
    && risk.confidence >= PRICE_BUY_NOW_CONFIDENCE
    && (score?.value ?? 0) >= PRICE_BUY_NOW_SCORE_MIN;
  const isFallWarning = risk.direction === 'fall' && risk.confidence >= 0.3;

  if (!isBuyNow && !isFallWarning && risk.direction !== 'rise') return '';

  if (isBuyNow) {
    return `<div class="planner-price-warning planner-price-warning--buy-now" title="${esc(risk.reasoning)}">
      ↑ Buy now — price likely to rise (${pct}% confidence)
    </div>`.trim();
  }
  if (risk.direction === 'rise') {
    return `<div class="planner-price-warning planner-price-warning--rise" title="${esc(risk.reasoning)}">
      ↑ Price may rise soon (${pct}% confidence)
    </div>`.trim();
  }
  // fall warning
  return `<div class="planner-price-warning planner-price-warning--fall" title="${esc(risk.reasoning)}">
    ↓ Price may fall — consider alternatives (${pct}% confidence)
  </div>`.trim();
}

/**
 * Render a single transfer recommendation card.
 * @param {SwapObj} swap
 * @returns {string}  HTML string
 */
function renderTransferCard(swap) {
  const { outPlayer, inPlayer, outScore, inScore, delta, priceDiff, isHit } = swap;
  const outTeam    = store.getTeam(outPlayer.teamId);
  const inTeam     = store.getTeam(inPlayer.teamId);
  const dSign      = delta >= 0 ? '+' : '';
  const cSign      = priceDiff >= 0 ? '+' : '';
  const remaining  = (_budget - priceDiff).toFixed(1);
  const deltaEst   = isScoreEstimated(inScore) || isScoreEstimated(outScore) ? ' planner-delta--estimated' : '';
  const hitBadge   = isHit
    ? `<span class="planner-hit-badge">HIT −${HIT_PENALTY}pts</span>`
    : '';
  const priceWarning = buildPriceChangeWarning(inPlayer, inScore);

  return `
    <div class="planner-transfer-card">
      <div class="planner-transfer-card__header">
        <span class="planner-delta planner-delta--${delta >= 0 ? 'gain' : 'loss'}${deltaEst}">${dSign}${delta.toFixed(1)}</span>
        <span class="planner-cost-diff">${cSign}£${Math.abs(priceDiff).toFixed(1)}m</span>
        <span class="planner-budget-remaining">£${remaining}m left</span>
        ${hitBadge}
      </div>
      <div class="planner-transfer-card__body">
        ${renderPlayerProjection(outPlayer, outScore, outTeam, 'out')}
        <div class="planner-transfer-card__arrow" aria-hidden="true">→</div>
        ${renderPlayerProjection(inPlayer, inScore, inTeam, 'in')}
      </div>
      ${priceWarning ? `<div class="planner-transfer-card__price-footer">${priceWarning}</div>` : ''}
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
  const dSign      = combinedDelta >= 0 ? '+' : '';
  const combCost   = swap1.priceDiff + swap2.priceDiff;
  const cSign      = combCost >= 0 ? '+' : '';
  const remaining  = (_budget - combCost).toFixed(1);
  const anyEst     = isScoreEstimated(swap1.inScore) || isScoreEstimated(swap1.outScore) ||
                     isScoreEstimated(swap2.inScore) || isScoreEstimated(swap2.outScore);
  const combEst    = anyEst ? ' planner-delta--estimated' : '';
  const s1Est      = (isScoreEstimated(swap1.inScore) || isScoreEstimated(swap1.outScore)) ? ' planner-delta--estimated' : '';
  const s2Est      = (isScoreEstimated(swap2.inScore) || isScoreEstimated(swap2.outScore)) ? ' planner-delta--estimated' : '';
  const hitBadge   = isHit
    ? `<span class="planner-hit-badge">HIT −${HIT_PENALTY}pts applied</span>`
    : '';

  return `
    <div class="planner-transfer-card planner-transfer-card--double">
      <div class="planner-transfer-card__header planner-transfer-card__header--double">
        <span class="planner-section-label">Combined</span>
        <span class="planner-delta planner-delta--${combinedDelta >= 0 ? 'gain' : 'loss'}${combEst}">${dSign}${combinedDelta.toFixed(1)}</span>
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
          <span class="planner-delta planner-delta--${swap1.delta >= 0 ? 'gain' : 'loss'} planner-delta--sm${s1Est}">
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
          <span class="planner-delta planner-delta--${swap2.delta >= 0 ? 'gain' : 'loss'} planner-delta--sm${s2Est}">
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
    const squadFull    = store.getSquad().length >= SQUAD_TOTAL;
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
  const squad = store.getSquad();
  if (_tally) {
    _tally.textContent = `${squad.length} / ${SQUAD_TOTAL} players selected`;
  }
  if (!_squadSlots) return;

  _squadSlots.innerHTML = Object.entries(SQUAD_LIMITS).map(([pos, max]) => {
    const playersInPos = squad
      .map(id => store.getPlayer(id))
      .filter(p => p?.position === pos);

    const slots = [
      ...playersInPos.map(player => {
        const score = _scores.get(player.id);
        const team  = store.getTeam(player.teamId);
        const chip  = score
          ? `<span class="score-chip score-chip--${esc(score.band)}${rankTierClass(_rankTierByPlayerId?.get(player.id))}">${Math.round(score.value)}</span>`
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

  if (store.getSquad().length < SQUAD_TOTAL) {
    const remaining = SQUAD_TOTAL - store.getSquad().length;
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

// ─── Render: chip planner (Phase 4-3) ────────────────────────────────────────

/**
 * Pick the four lowest-projected players from the current squad as the bench
 * proxy for Bench Boost analysis. MODEL: the planner doesn't model an XI/bench
 * split (out of scope), so we approximate by taking the players the engine
 * itself rates lowest over the active horizon. Returns [] when scores are
 * unavailable or the squad is empty.
 */
function pickBenchPlayerIds() {
  const squad = store.getSquad();
  if (squad.length === 0) return [];
  const ranked = squad
    .map(id => ({ id, value: _scores.get(id)?.value ?? 0 }))
    .sort((a, b) => a.value - b.value);
  return ranked.slice(0, BENCH_SIZE).map(r => r.id);
}

/**
 * Pick the highest-projected player in the current squad as the Triple Captain
 * candidate. Returns null when the squad is empty or no scores exist yet.
 *
 * Ranks by `expectedPoints` (real points-scale projection), NOT the 0-100
 * composite `score.value` — same reasoning as the dashboard captaincy pick:
 * the composite is a within-position quality score and doesn't scale with a
 * position's actual scoring ceiling. See calcExpectedPoints in
 * engine/composite.js and FEATURE_ENGINE.md §10.2.
 */
function pickTcCandidate() {
  let bestId = null;
  let bestVal = -Infinity;
  for (const id of store.getSquad()) {
    const v = _scores.get(id)?.expectedPoints?.value;
    if (typeof v === 'number' && v > bestVal) {
      bestVal = v;
      bestId  = id;
    }
  }
  return bestId == null ? null : store.getPlayer(bestId);
}

/**
 * Render a single chip card. The "Already used" toggle stays operable even on
 * used chips so the user can mark/unmark; the recommendation strikethroughs
 * and the card greys out via the --used modifier.
 */
function renderChipCard(chipId, rec) {
  const used    = _chipsUsed.has(chipId);
  const label   = CHIP_LABELS[chipId];
  const recText = rec?.gw != null ? `GW${rec.gw}` : '—';
  const why     = rec?.reasoning ?? 'Not enough data to recommend a GW yet.';
  const toggleLabel = used ? 'Used' : 'Mark used';

  return `
    <div class="planner-chip-card${used ? ' planner-chip-card--used' : ''}"
         data-chip-id="${esc(chipId)}">
      <div class="planner-chip-card__head">
        <span class="planner-chip-card__name">${esc(label)}</span>
        <span class="planner-chip-card__rec">${esc(recText)}</span>
      </div>
      <p class="planner-chip-card__why">${esc(why)}</p>
      <div class="planner-chip-card__foot">
        <button class="planner-chip-card__used-toggle"
                type="button"
                data-chip-toggle="${esc(chipId)}"
                aria-pressed="${used}">${esc(toggleLabel)}</button>
        <span class="planner-chip-card__hint">advisory — see rationale above</span>
      </div>
    </div>
  `.trim();
}

/**
 * Compute and render all four chip recommendations. Pure-engine calls; the
 * module only owns DOM. Always shows reasoning per ROADMAP rule "always show
 * the reasoning" — when a chip can't be scored (e.g. empty squad for BB/TC)
 * we still render the card with a hint, never hide it.
 */
function renderChipsPanel() {
  if (!_chipsPanel) return;

  if (!_dataReady) {
    _chipsPanel.innerHTML = `<p class="planner-hint">Loading FPL data…</p>`;
    return;
  }

  const ctx = buildCtx();
  if (!ctx) {
    _chipsPanel.innerHTML = `<p class="planner-hint">No data available yet.</p>`;
    return;
  }

  const horizon = getHorizon();

  // Wildcard and Free Hit are league-wide, evaluated regardless of squad.
  let wcBest = null;
  let fhRec  = null;
  try {
    const wcRanked = scoreWildcardTiming(horizon, ctx);
    wcBest = wcRanked[0] ?? null;
  } catch (err) {
    console.warn('[planner] scoreWildcardTiming failed:', err?.message ?? err);
  }
  try {
    fhRec = scoreFreeHitTiming(horizon, ctx);
  } catch (err) {
    console.warn('[planner] scoreFreeHitTiming failed:', err?.message ?? err);
  }

  // Bench Boost and Triple Captain depend on the user's squad.
  const benchIds = pickBenchPlayerIds();
  const tcPlayer = pickTcCandidate();

  let bbRec = null;
  let tcRec = null;
  if (benchIds.length > 0) {
    try {
      bbRec = scoreBenchBoostTiming(horizon, { ...ctx, benchPlayerIds: benchIds });
    } catch (err) {
      console.warn('[planner] scoreBenchBoostTiming failed:', err?.message ?? err);
    }
  }
  if (tcPlayer) {
    try {
      tcRec = scoreTripleCaptainTiming(tcPlayer, horizon, ctx);
    } catch (err) {
      console.warn('[planner] scoreTripleCaptainTiming failed:', err?.message ?? err);
    }
  }

  const fallback = {
    benchboost:    { reasoning: 'Add 15 players to your squad to evaluate Bench Boost timing.' },
    triplecaptain: { reasoning: 'Add players to your squad to evaluate Triple Captain timing.' },
  };

  const recs = {
    wildcard:      wcBest,
    freehit:       fhRec,
    benchboost:    bbRec ?? fallback.benchboost,
    triplecaptain: tcRec ?? fallback.triplecaptain,
  };

  const cards = CHIP_IDS.map(id => renderChipCard(id, recs[id])).join('');

  _chipsPanel.innerHTML = `
    <div class="planner-chips__hd">
      <span class="planner-chips__title">Chips</span>
      <span class="planner-chips__meta">advisory · ${esc(horizon.label)}</span>
    </div>
    <div class="planner-chips__grid">${cards}</div>
  `;
}

function onChipsClick(e) {
  const btn = e.target.closest('[data-chip-toggle]');
  if (!btn) return;
  const chipId = btn.dataset.chipToggle;
  if (!CHIP_IDS.includes(chipId)) return;
  if (_chipsUsed.has(chipId)) _chipsUsed.delete(chipId);
  else                        _chipsUsed.add(chipId);
  saveChipsUsed();
  renderChipsPanel();
}

// ─── After squad change ───────────────────────────────────────────────────────

function afterSquadChange() {
  scoreSquad();
  renderSquadPanel();
  renderRecommendations();
  renderChipsPanel();
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

// ─── Squad import helpers (Phase 4-1) ────────────────────────────────────────

/**
 * Replace the current squad with the given player IDs, respecting slot limits.
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

/** @param {object|null} entryInfo */
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

/** @param {string} msg @param {'idle'|'loading'|'success'|'error'} type */
function showImportStatus(msg, type) {
  if (!_importStatus) return;
  _importStatus.textContent = msg;
  _importStatus.className = `squad-import-status squad-import-status--${type}`;
}

function openImportPanel() {
  if (!_importPanel) return;
  _importPanel.hidden = false;
  _importBtn?.classList.add('is-open');
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
  _importBtn?.classList.remove('is-open');
  showImportStatus('', 'idle');
}

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
    _importedTeamId    = teamId;
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
    console.warn('[planner] Squad import failed:', err);
  } finally {
    _importInFlight = false;
  }
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
  _chipsPanel      = document.getElementById('planner-chips');

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

  // ── Chip-used toggles (Phase 4-3) — delegated click ──────────────────────
  _chipsPanel?.addEventListener('click', onChipsClick);
  loadChipsUsed();

  // ── Squad import (Phase 4-1) ─────────────────────────────────────────────
  _importBtn     = document.getElementById('planner-import-btn');
  _importPanel   = document.getElementById('planner-import-panel');
  _importIdInput = document.getElementById('planner-import-id');
  _importStatus  = document.getElementById('planner-import-status');
  _importInfo    = document.getElementById('planner-import-info');

  _importBtn?.addEventListener('click', openImportPanel);
  document.getElementById('planner-import-cancel')?.addEventListener('click', closeImportPanel);
  document.getElementById('planner-import-go')?.addEventListener('click', handleImport);
  _importIdInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleImport();
    if (e.key === 'Escape') closeImportPanel();
  });

  // ── Render the initial shell — squad is already hydrated by store.js ─────
  renderSquadPanel();
  renderRecommendations();

  _domWired = true;
  console.log('[planner] DOM wired');
}

// ─── Store event handlers ─────────────────────────────────────────────────────

function onDataReady() {
  wireDom();          // no-op after first call
  // Force a fresh full-pool rank computation for the new data (see ensureRankTiers).
  _rankTierByPlayerId = null;
  _dataReady = true;
  scoreSquad();
  renderSquadPanel();
  renderRecommendations();
  renderChipsPanel();
}

function onHorizonChanged() {
  if (!_dataReady) return;
  // Rank tiers depend on horizon (a player's score, and therefore rank,
  // differs by horizon) — force a fresh computation alongside the re-score.
  _rankTierByPlayerId = null;
  // Re-score squad against the new horizon and re-compute transfer
  // recommendations + chip timing (chips depend on the same fixture data).
  scoreSquad();
  renderSquadPanel();
  renderRecommendations();
  renderChipsPanel();
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the Transfer Planner module. Called once from main.js before
 * loadInitialData(). Registers store subscriptions so the module is ready
 * to receive events whenever the fetch completes. All DOM wiring is deferred
 * to wireDom(), called from onDataReady().
 *
 * Also subscribes to 'squad:updated' so a squad built or imported on the
 * Dashboard — or anywhere else — re-scores and re-renders here too, with no
 * rebuild step. afterSquadChange() itself no-ops safely via renderSquadPanel's/
 * renderRecommendations' null DOM-ref guards if this module hasn't wired yet.
 */
export function initPlanner() {
  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);
  store.subscribe('squad:updated',   afterSquadChange);

  // If the store is already hydrated (sessionStorage), wire up immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
