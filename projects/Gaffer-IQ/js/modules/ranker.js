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
import {
  HORIZONS, RANKER_CHUNK_SIZE, PRICE_FILTER_MIN, PRICE_FILTER_MAX, PRICE_FILTER_STEP, BANDS,
  RANK_ELITE_COUNT_BY_POS, RANK_STRONG_COUNT_BY_POS,
} from '../config.js';
import { buildScoreContext, scorePlayer, attachRankTiers } from '../engine/composite.js';
import { fetchPlayerSummary } from '../api.js';
import { normalisePlayerSummary } from '../engine/normalise.js';
import { calcPriceChangeRisk } from '../engine/prices.js';

// ─── Minutes-security display thresholds ─────────────────────────────────────
// Maps 0–1 minutesSecurity (from scorePlayer breakdown.form) onto a human
// label and band. Checked in order; first threshold met wins.

const MIN_SEC_LEVELS = [
  { threshold: 0.85, label: 'Guaranteed', band: 'great' },
  { threshold: 0.65, label: 'Likely',     band: 'good' },
  { threshold: 0.40, label: 'Rotation',   band: 'neutral' },
  { threshold: 0,    label: 'Risk',       band: 'tough' },
];

// ─── Module-level state ───────────────────────────────────────────────────────

let _thead              = null;
let _tbody              = null;
let _loading            = null;
let _teamSelect         = null;
let _priceSelect        = null;

// Scored rows rebuilt on data:ready or horizon:changed; cached so filter and
// sort changes do not re-invoke the engine.
let _rows = [];

// Incremented on every new ranking run; each async chunk checks its captured
// value still matches before continuing, cancelling stale in-flight runs.
let _computeId = 0;

// Active filter / sort / display state.
let _activePosSet    = new Set(['GKP', 'DEF', 'MID', 'FWD']);
let _activePriceBand = 'all';      // 'all' | numeric-string maximum price threshold
let _activeTeamId    = 'all';
let _activeMinSecSet = new Set(MIN_SEC_LEVELS.map(l => l.label)); // all levels active by default
let _sortBy          = 'value';    // 'value' | 'costPerPoint' | 'price' | 'minutesSecurity' | 'name' | 'team' | 'avgPointsPerGw' | 'nextFixtureScore'
let _sortDesc        = true;

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

/**
 * Map a 0–100 value to a band string, reading thresholds from config so this
 * render helper stays in sync with the engine. Not analytical — display only.
 * Mirrors the identical helper in modules/matchup.js (CONVENTIONS.md §5.2).
 */
function bandFromValue(v) {
  if (v >= BANDS.great)   return 'great';
  if (v >= BANDS.good)    return 'good';
  if (v >= BANDS.neutral) return 'neutral';
  if (v >= BANDS.tough)   return 'tough';
  return 'brutal';
}

/** rankTier (composite.js → calcRankTier) → the .score-chip--rank-* modifier
 *  suffix, or '' when the player isn't in any standout tier (keeps their
 *  existing band colour). See FEATURE_ENGINE.md §13. */
function rankTierClass(rankTier) {
  if (rankTier === 'positionElite')    return ' score-chip--rank-green';
  if (rankTier === 'positionStrong')   return ' score-chip--rank-light-green';
  if (rankTier === 'bottomPercentile') return ' score-chip--rank-red';
  return '';
}

/** Human label for a position, used only in the rank-tier tooltip below. */
const POSITION_LABELS = { GKP: 'goalkeepers', DEF: 'defenders', MID: 'midfielders', FWD: 'forwards' };

/**
 * Tooltip text for a rank-tier chip. positionElite/positionStrong's counts
 * are PER-POSITION (RANK_ELITE_COUNT_BY_POS/RANK_STRONG_COUNT_BY_POS), so the
 * text must read the player's own position rather than a single fixed string
 * — built from the live config constants, not hardcoded numbers, so this
 * never goes stale if either table is retuned.
 */
function rankTierTitle(rankTier, position) {
  const posLabel = POSITION_LABELS[position] ?? 'players';
  if (rankTier === 'positionElite')  return `Top ${RANK_ELITE_COUNT_BY_POS[position]} ${posLabel} in the game`;
  if (rankTier === 'positionStrong') return `Top ${RANK_STRONG_COUNT_BY_POS[position]} ${posLabel} in the game`;
  if (rankTier === 'bottomPercentile') return 'Bottom half of players in the game';
  return '';
}

/** Return the label+band object for a 0–1 minutesSecurity value. */
function minSecLevel(ms) {
  const v = ms ?? 0;
  for (const level of MIN_SEC_LEVELS) {
    if (v >= level.threshold) return level;
  }
  return MIN_SEC_LEVELS[MIN_SEC_LEVELS.length - 1];
}

/**
 * Price filter — `band` is either 'all' (unrestricted — includes players both
 * below PRICE_FILTER_MIN and above PRICE_FILTER_MAX) or a numeric-string
 * maximum-price threshold, e.g. '9.0' meaning "£9.0m and below".
 */
function priceInBand(price, band) {
  if (band === 'all') return true;
  return price <= parseFloat(band);
}

/**
 * Populate the price <select> with 'All Prices' plus a generated run of
 * maximum-price thresholds from PRICE_FILTER_MIN to PRICE_FILTER_MAX in
 * PRICE_FILTER_STEP increments (config-driven — see config.js §11).
 */
function populatePriceFilter() {
  if (!_priceSelect) return;
  const options = ['<option value="all">All Prices</option>'];
  // Round to 1dp to avoid floating-point drift (4.0 + 0.5 + 0.5 + ... ).
  const steps = Math.round((PRICE_FILTER_MAX - PRICE_FILTER_MIN) / PRICE_FILTER_STEP);
  for (let i = 0; i <= steps; i++) {
    const price = Math.round((PRICE_FILTER_MIN + i * PRICE_FILTER_STEP) * 10) / 10;
    options.push(`<option value="${price}">£${price.toFixed(1)}m and below</option>`);
  }
  _priceSelect.innerHTML = options.join('');
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
  // Rank tier (FEATURE_ENGINE.md §13) is computed against the FULL unfiltered
  // pool, before applyFilters() ever runs — "top 30 in the game" must mean the
  // same thing regardless of which position/price/team pills are active, and
  // must match what Dashboard/Planner (which have no filters at all) compute
  // for the same players.
  _rows = attachRankTiers(pending);

  if (_loading) _loading.classList.remove('is-visible');
  renderTable();
}

// ─── Filter and sort ──────────────────────────────────────────────────────────

function applyFilters(rows) {
  return rows.filter(({ player, score }) => {
    if (!_activePosSet.has(player.position))          return false;
    if (!priceInBand(player.price, _activePriceBand)) return false;
    if (_activeTeamId !== 'all' &&
        String(player.teamId) !== _activeTeamId)      return false;
    const ms = score.breakdown?.form?.minutesSecurity ?? 0;
    if (!_activeMinSecSet.has(minSecLevel(ms).label)) return false;
    return true;
  });
}

/**
 * Rank every row in `rows` by nextFixtureScore (descending), independent of
 * whatever column the table is currently sorted by — "next-fixture rank" is a
 * standing among the CURRENTLY-FILTERED players, not the whole ~700-player
 * pool, since that's the set the user is actually choosing among.
 * @returns {Map<number, number>} playerId → 1-based rank
 */
function buildNextFixtureRanks(rows) {
  const ranked = rows.slice()
    .sort((a, b) => b.score.nextFixtureScore.value - a.score.nextFixtureScore.value);
  const rankById = new Map();
  ranked.forEach((row, i) => rankById.set(row.player.id, i + 1));
  return rankById;
}

function applySort(rows) {
  return rows.slice().sort((a, b) => {
    // costPerPoint can be null (no scoring record) — nulls always sort last,
    // regardless of sort direction, rather than comparing as 0.
    if (_sortBy === 'costPerPoint') {
      const av = a.score.costPerPoint, bv = b.score.costPerPoint;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return _sortDesc ? (bv - av) : (av - bv);
    }
    // String columns use localeCompare, not subtraction. Same descending-first
    // convention as every numeric column, for consistency (first click = 'Z'
    // first) — the sort-arrow indicator shows the direction either way.
    if (_sortBy === 'name' || _sortBy === 'team') {
      const av = _sortBy === 'name' ? a.player.name : (a.team?.name ?? '');
      const bv = _sortBy === 'name' ? b.player.name : (b.team?.name ?? '');
      const cmp = av.localeCompare(bv);
      return _sortDesc ? -cmp : cmp;
    }
    let av, bv;
    if (_sortBy === 'price') {
      av = a.player.price; bv = b.player.price;
    } else if (_sortBy === 'minutesSecurity') {
      av = a.score.breakdown?.form?.minutesSecurity ?? 0;
      bv = b.score.breakdown?.form?.minutesSecurity ?? 0;
    } else if (_sortBy === 'avgPointsPerGw') {
      av = a.score.avgPointsPerGw.value; bv = b.score.avgPointsPerGw.value;
    } else if (_sortBy === 'nextFixtureScore') {
      av = a.score.nextFixtureScore.value; bv = b.score.nextFixtureScore.value;
    } else {
      av = a.score.value; bv = b.score.value;
    }
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
 *
 * @param {{player: Player, team: Team, score: object, rankTier: string|null}} row
 *   rankTier from attachRankTiers, computed against the FULL pool (FEATURE_ENGINE.md §13)
 * @param {Map<number, number>} nextFixtureRankById  from buildNextFixtureRanks
 */
function buildRow({ player, team, score, rankTier }, nextFixtureRankById) {
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';
  const ms       = score.breakdown?.form?.minutesSecurity ?? 0;
  const lvl      = minSecLevel(ms);
  const estClass = isScoreEstimated(score) ? ' score-chip--estimated' : '';

  // avgPointsPerGw.source === 'lastSeason' is the temporary pre-season
  // fallback (FEATURE_ENGINE.md §10.1) — distinct tooltip so it reads as
  // "last season's number", not the ordinary "thin current-season data" case.
  const avgPts = score.avgPointsPerGw;
  const avgPtsTitle = avgPts.source === 'lastSeason'
    ? `Estimated — no current-season data yet, showing ${esc(avgPts.seasonName ?? 'last season')}'s average instead`
    : 'Estimated — season totals ÷ estimated games played, no per-GW history loaded yet';
  const avgPtsEstMark = avgPts.estimated
    ? `<span class="ranker-est-mark" title="${avgPtsTitle}">~</span>`
    : '';

  // Cost/Pt is DERIVED from avgPointsPerGw (price ÷ avgPointsPerGw.value) —
  // when that input is estimated (including via the pre-season fallback
  // above), flag the derived figure too, for the same explainability reason.
  const costPerPointDisplay = score.costPerPoint !== null
    ? `£${esc(score.costPerPoint.toFixed(2))}m${avgPts.estimated
        ? `<span class="ranker-est-mark" title="Derived from an estimated Avg Pts/GW — ${avgPtsTitle}">~</span>`
        : ''}`
    : '<span class="ranker-no-fixtures">—</span>';

  const nfScore    = score.nextFixtureScore;
  const nfRank     = nextFixtureRankById?.get(player.id);
  const nfBand     = bandFromValue(Math.round(nfScore.value));
  const nfEstClass = nfScore.estimated ? ' score-chip--estimated' : '';

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
        £${esc(player.price.toFixed(1))}m
      </td>
      <td class="ranker-table__td ranker-table__td--value">
        <span class="score-chip score-chip--${esc(score.band)}${estClass}${rankTierClass(rankTier)}"
              title="${rankTier ? esc(rankTierTitle(rankTier, player.position)) : ''}">${Math.round(score.value)}</span>
      </td>
      <td class="ranker-table__td ranker-table__td--cost-per-point">
        ${costPerPointDisplay}
      </td>
      <td class="ranker-table__td ranker-table__td--avg-pts">
        ${score.avgPointsPerGw.value.toFixed(1)}${avgPtsEstMark}
      </td>
      <td class="ranker-table__td ranker-table__td--next-fixture"
          title="Fixture + counter-matchup favourability, excluding form">
        <span class="score-chip score-chip--${esc(nfBand)}${nfEstClass}">${Math.round(nfScore.value)}</span>
        ${nfRank ? `<span class="ranker-rank-tag">#${nfRank}</span>` : ''}
      </td>
      <td class="ranker-table__td ranker-table__td--fixtures">
        ${buildFixtureStrip(score.perGw)}
      </td>
      <td class="ranker-table__td ranker-table__td--min">
        <span class="ranker-min-badge ranker-min-badge--${esc(lvl.band)}">${esc(lvl.label)}</span>
      </td>
      ${buildPriceChangeCell(player)}
    </tr>
  `.trim();
}

// ─── Price change helpers ─────────────────────────────────────────────────────

/**
 * Fixed column count: Player, Team, Pos, Price, Value, Cost/Pt, Avg Pts,
 * Next Fixture, Fixtures, Playtime, Price Change — always all 11, no toggle.
 */
function colCount() {
  return 11;
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
      ${thSortable('Player',    'name')}
      ${thSortable('Team',      'team')}
      ${thStatic('Pos',         'pos')}
      ${thSortable('Price',     'price')}
      ${thSortable('Value',     'value')}
      ${thSortable('Cost/Pt',   'costPerPoint')}
      ${thSortable('Avg Pts/GW', 'avgPointsPerGw')}
      ${thSortable('Next Fixture', 'nextFixtureScore')}
      ${thStatic(horizon.label, 'fixtures')}
      ${thSortable('Playtime',  'minutesSecurity')}
      ${thStatic('£↑↓',         'price-change')}
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

  if (filtered.length === 0) {
    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">No players match the current filters.</td></tr>`;
    return;
  }

  // Ranked among the filtered set, independent of the active sort column.
  const nextFixtureRankById = buildNextFixtureRanks(filtered);
  const sorted = applySort(filtered);

  _tbody.innerHTML = sorted.map(row => buildRow(row, nextFixtureRankById)).join('');
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

  populatePriceFilter();

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

  // ── Minutes-security filter toggle buttons (mirrors position buttons) ───
  root.querySelectorAll('.ranker-minsec-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = btn.dataset.minsec;
      if (_activeMinSecSet.has(lvl)) {
        // Keep at least one level active so the table is never empty.
        if (_activeMinSecSet.size > 1) {
          _activeMinSecSet.delete(lvl);
          btn.classList.remove('is-active');
        }
      } else {
        _activeMinSecSet.add(lvl);
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
