/**
 * js/modules/ranker.js
 * Layer: module. Owns the DOM for the Player Ranker view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders a sortable, filterable list of players ranked by projected value
 * over the active horizon, headed by a Top pick / Head to head / Fixture run
 * section (design export FINAL - Ranker.dc.html; styles css/ranker.css).
 * Lazy-loads player summaries on click. The "Avg Pts/GW source" switch is the
 * one exception to "never bulk-fetch": an explicit click on "Last season"
 * triggers a chunked, staggered load of every player's summary
 * (FEATURE_ENGINE.md §10.1) — deliberate and user-triggered, never automatic.
 * No analytical logic lives here; all scoring delegated to engine/composite.js.
 * See ARCHITECTURE.md §10, FEATURE_ENGINE.md §11, ROADMAP.md Phase 2B.
 *
 * Subscriptions: data:ready, horizon:changed, route:changed
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import {
  HORIZONS, RANKER_CHUNK_SIZE, SUMMARY_FETCH_CHUNK_SIZE,
  PRICE_FILTER_MIN, PRICE_FILTER_MAX, PRICE_FILTER_STEP,
  RANK_ELITE_COUNT_BY_POS, RANK_STRONG_COUNT_BY_POS,
  RANK_TOP_PERCENTILE, RANK_BOTTOM_PERCENTILE,
} from '../config.js';
import {
  buildScoreContext, scorePlayer, attachRankTiers, calcLastSeasonAvgPointsPerGw,
  bandFromValue, rankTierMapBy,
} from '../engine/composite.js';
import { fetchPlayerSummary } from '../api.js';
import { normalisePlayerSummary } from '../engine/normalise.js';
import { calcSeasonPriceChange } from '../engine/prices.js';
import { groupPerGwSlots, pendingFixturesForTeam } from '../engine/fixtures.js';
import { playtimeBand } from '../engine/form.js';

// ─── Playtime display ────────────────────────────────────────────────────────
// Playtime labels/bands live in config.js (PLAYTIME_BANDS) and are applied by
// engine/form.js's playtimeBand(), so the column, the filter pills and the
// engine can never disagree about where 'Likely' stops and 'Rotation' starts.

// ─── Display constants ───────────────────────────────────────────────────────

/** Rows per page of the list; "Show more" adds another page. */
const PAGE_SIZE = 40;

const POSITIONS  = ['GKP', 'DEF', 'MID', 'FWD'];
const PLAYTIMES  = ['Nailed', 'Likely', 'Rotation', 'Risk'];
const VIEWS      = ['pick', 'h2h', 'run'];
const VIEW_LABEL = { pick: 'Top pick', h2h: 'Head to head', run: 'Best fixture run' };

/** "Ranked by" options, in menu order. Keys are applySort's _sortBy values. */
const SORTS = [
  ['value', 'Value'], ['nextFixtureScore', 'Next fixture'], ['avgPointsPerGw', 'Avg pts/GW'],
  ['costPerPoint', 'Cost/pt'], ['totalPoints', 'Total pts'], ['fplForm', 'Form'],
  ['price', 'Price'], ['priceChange', 'Price change'], ['transfersInEvent', 'Transfers in'],
  ['transfersOutEvent', 'Transfers out'], ['playtime', 'Playtime'], ['name', 'Player'], ['team', 'Team'],
];
const SORT_LABEL = Object.fromEntries(SORTS);

/** How each sortable figure reads as a big numeral. name/team have none — the
 *  Top pick then shows Value. */
const FMT = {
  value: {}, nextFixtureScore: {}, totalPoints: {},
  avgPointsPerGw: { dec: 1 }, fplForm: { dec: 1 },
  costPerPoint: { dec: 2, prefix: '£', suffix: 'm' },
  price: { dec: 1, prefix: '£', suffix: 'm' }, priceChange: { dec: 1, prefix: '£', suffix: 'm' },
  transfersInEvent: { dec: 1, suffix: 'k', div: 1000 }, transfersOutEvent: { dec: 1, suffix: 'k', div: 1000 },
  playtime: { suffix: '%', mul: 100 },
};

/** Rank tier → the band hue that paints it (css/ranker.css). */
const TIER_BAND = {
  positionBest: 'excellent', positionElite: 'great', positionStrong: 'good',
  topPercentile: 'neutral', midPercentile: 'amber', bottomPercentile: 'brutal',
};
const BAND_LABEL = {
  excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral',
  tough: 'Tough', brutal: 'Brutal', extreme: 'Extreme',
};
const POS_PLURAL = { GKP: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };

const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(.2,.7,.2,1)';

// ─── Module-level state ───────────────────────────────────────────────────────

let _root      = null;   // .rk
let _cmd       = null;   // #rk-cmd
let _top       = null;   // #rk-top — Top pick / Head to head / Fixture run
let _topSec    = null;
let _head      = null;   // #rk-head — the wide list's column header
let _list      = null;   // #rk-rows
let _more      = null;
let _msg       = null;
let _drawer    = null;
let _scrim     = null;
let _info      = null;   // #rk-info popover
let _sortSelect  = null;
let _teamSelect  = null;
let _priceSelect = null;

// 'current' | 'lastSeason' — explicit, user-toggled Avg Pts/GW source
// (FEATURE_ENGINE.md §10.1). Never switches itself; the switch is the only
// way this changes.
let _avgPtsMode = 'current';

// Incremented on every "Last Season" toggle-on; the in-flight chunked bulk
// loader checks its captured value still matches before continuing each
// chunk, so switching back to "This Season" (or toggling on again) cancels
// the previous run rather than racing it.
let _summaryLoadRunId = 0;

// True while a last-season bulk load is running — the drawer and list header
// show its progress until it finishes or is cancelled.
let _lsActive = false;

// Scored rows rebuilt on data:ready or horizon:changed; cached so filter and
// sort changes do not re-invoke the engine.
let _rows = [];

// Incremented on every new ranking run; each async chunk checks its captured
// value still matches before continuing, cancelling stale in-flight runs.
let _computeId = 0;

// { done, total } while a ranking run is in progress, else null.
let _progress = null;

// Active filter / sort / display state.
// Empty set = no filter on that axis (every position / every playtime level
// shows) — selecting a pill narrows to just the selected ones, rather than
// the old "all selected by default" scheme where narrowing to one position
// meant deselecting the other three.
let _activePosSet    = new Set();
let _activePriceBand = 'all';      // 'all' | numeric-string maximum price threshold
let _activeTeamId    = 'all';
let _activeMinSecSet = new Set();
let _sortBy          = 'value';    // 'value' | 'costPerPoint' | 'price' | 'playtime' | 'name' | 'team'
                                   //   | 'avgPointsPerGw' | 'totalPoints' | 'fplForm' | 'nextFixtureScore'
                                   //   | 'priceChange' | 'transfersInEvent' | 'transfersOutEvent'
let _sortDesc        = true;

// Presentation-only state.
let _view       = 'pick';          // top section
let _viewBusy   = false;           // view switch fading out
let _shown      = PAGE_SIZE;       // rows on screen
let _hidden     = new Set();       // hidden column groups: outlook | price | points | transfers
let _cmpA       = null;            // head-to-head picks (player ids); null = #1 / #2
let _cmpB       = null;
let _infoKey    = null;            // open "i" popover
let _infoReturn = null;
let _filtersOpen = false;
let _listWide   = true;            // grid rows (wide) or cards (narrow)
let _listShown  = false;           // first reveal of real rows has played
let _lastLayout = '';              // list layout signature — FLIP only within one layout
let _raf        = 0;
const _cuLast   = new Map();       // big numeral slot → value it last showed

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
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
    teamXgBySlug: store.getAllTeamXg(),
    currentGw: store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
  });
}

/**
 * What the Player column shows.
 *
 * FPL's `web_name` is a surname or a nickname — "Szoboszlai", "Gakpo" — which
 * is compact but ambiguous across a 700-player pool. `fullName` is first_name
 * and second_name joined by normalise.js.
 *
 * `||` rather than `??`: normalise.js builds fullName by trimming a template
 * string, so a player FPL published neither part for arrives as '' rather than
 * null, and `??` would let that empty string through to the cell.
 *
 * @param {Player} player
 * @returns {string}
 */
function displayName(player) {
  return player.fullName || player.name;
}

/** Human label for a position, used only in the rank-tier tooltip below. */
const POSITION_LABELS = { GKP: 'goalkeepers', DEF: 'defenders', MID: 'midfielders', FWD: 'forwards' };

/**
 * Tooltip text for a rank-tier chip. positionElite/positionStrong's counts
 * are PER-POSITION (RANK_ELITE_COUNT_BY_POS/RANK_STRONG_COUNT_BY_POS), so the
 * text must read the player's own position rather than a single fixed string
 * — built from the live config constants, not hardcoded numbers, so this
 * never goes stale if either table is retuned. topPercentile/bottomPercentile
 * are POOL-WIDE (not per-position — see calcRankTier's JSDoc), so their text
 * doesn't mention a position; midPercentile's implied width (100% minus the
 * other two) is likewise derived from config, not a hardcoded "35%".
 *
 * `metric` names WHICH column's ranking this is. Three columns now carry these
 * chips and each is ranked on its own number, so a tooltip that only said "top
 * 5 defenders in the game" would be the same sentence under three different
 * colourings — and wrong for two of them.
 */
function rankTierTitle(rankTier, position, metric = 'rating') {
  const posLabel = POSITION_LABELS[position] ?? 'players';
  if (rankTier === 'positionBest')   return `Best ${metric} of all ${posLabel} in the game`;
  if (rankTier === 'positionElite')  return `Top ${RANK_ELITE_COUNT_BY_POS[position]} ${posLabel} in the game by ${metric}`;
  if (rankTier === 'positionStrong') return `Top ${RANK_STRONG_COUNT_BY_POS[position]} ${posLabel} in the game by ${metric}`;
  if (rankTier === 'topPercentile')    return `Top ${Math.round(RANK_TOP_PERCENTILE * 100)}% of players in the game by ${metric}`;
  if (rankTier === 'bottomPercentile') return `Bottom ${Math.round(RANK_BOTTOM_PERCENTILE * 100)}% of players in the game by ${metric}`;
  if (rankTier === 'midPercentile') {
    const midPct = Math.round((1 - RANK_TOP_PERCENTILE - RANK_BOTTOM_PERCENTILE) * 100);
    return `Middle ${midPct}% of players in the game by ${metric}`;
  }
  return '';
}

/** The same tier as a short label for the Top pick / head-to-head slab. */
function rankTierShort(rankTier, position) {
  const midPct = Math.round((1 - RANK_TOP_PERCENTILE - RANK_BOTTOM_PERCENTILE) * 100);
  return {
    positionBest:     `Best ${position}`,
    positionElite:    `Top ${RANK_ELITE_COUNT_BY_POS[position]} ${position}`,
    positionStrong:   `Top ${RANK_STRONG_COUNT_BY_POS[position]} ${position}`,
    topPercentile:    `Top ${Math.round(RANK_TOP_PERCENTILE * 100)}%`,
    midPercentile:    `Middle ${midPct}%`,
    bottomPercentile: `Bottom ${Math.round(RANK_BOTTOM_PERCENTILE * 100)}%`,
  }[rankTier] ?? '';
}

/**
 * Hover text for the Playtime badge. The column shows one word; the model has
 * four inputs, and which of them is dragging a player down is exactly what the
 * user needs to know — "Rotation because his club plays seven midfielders" is
 * a different decision from "Rotation because he is carrying a knock".
 *
 * @param {object} pt  breakdown.playtime from scorePlayer (§7.3b)
 * @returns {string}   plain text, inserted as a title attribute
 */
function playtimeTitle(pt) {
  const pct = v => `${Math.round((v ?? 0) * 100)}%`;
  const parts = [
    `Starts ${pct(pt.startRate)} of games`,
    `${pct(pt.minutesShare)} of available minutes`,
  ];
  // Only mention crowding when there is actually something to say about it.
  if ((pt.crowding ?? 1) > 1.35) {
    parts.push(`squad is rotating ${pt.crowding.toFixed(1)} players per slot in this position`);
  }
  if ((pt.availability ?? 100) < 100) {
    parts.push(`${Math.round(pt.availability)}% chance of playing`);
  }
  if (pt.estimated) {
    parts.push('early season — still weighted toward the price-implied role');
  }
  return parts.join(' · ');
}

/**
 * Playtime read for one scored row. Prefers the §7.3b squad-context model that
 * scorePlayer attaches; falls back to banding the raw form ratio only if a
 * caller somehow supplies a score from before that existed.
 */
function playtimeOf(score) {
  return score?.breakdown?.playtime
    ?? playtimeBand(score?.breakdown?.form?.minutesSecurity ?? 0);
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
 * Populate the price <select> with 'All prices' plus a generated run of
 * maximum-price thresholds from PRICE_FILTER_MIN to PRICE_FILTER_MAX in
 * PRICE_FILTER_STEP increments (config-driven — see config.js §11).
 */
function populatePriceFilter() {
  if (!_priceSelect) return;
  const options = ['<option value="all">All prices</option>'];
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

/**
 * The gameweek window the scores cover, as "GW8–12" — the same window
 * scorePlayer reads (buildCtx's currentGw + the active horizon's length).
 */
function horizonRange() {
  const horizon = HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW1;
  const start = store.getUpcomingGw() ?? store.getCurrentGw() ?? 1;
  return horizon.gws > 1 ? `GW${start}–${start + horizon.gws - 1}` : `GW${start}`;
}

// ─── Build: scored rows ───────────────────────────────────────────────────────

/**
 * Score all players over `horizon` in chunks of RANKER_CHUNK_SIZE, yielding
 * back to the browser between chunks so the UI stays responsive. Shows a live
 * progress indicator while working. Any in-flight run whose `computeId` no
 * longer matches `_computeId` is silently abandoned — this happens when the
 * user changes the horizon or data refreshes mid-compute.
 *
 * Never renders partial results: `_rows` and `render()` are only touched
 * after all chunks complete and the run is confirmed non-stale.
 */
async function rebuildRowsChunked() {
  const computeId = ++_computeId;

  // Every score in this table blends counter-matchup, which needs the whole
  // league's Understat payloads — the pool spans all 20 teams, so unlike the
  // Matchup Analyser there is no smaller set to wait on. Until the prefetch
  // settles, rank nothing and show placeholders.
  //
  // WHY THE WHOLE LIST AND NOT JUST THE SCORES. This list is SORTED by the
  // number that is still settling. Withholding the scores alone would leave
  // every other figure readable but in an order that reshuffles itself the
  // moment the last Understat payload lands — a row the reader was about to
  // click moves out from under them.
  //
  // This is also the cheaper path, not just the more honest one: data:ready
  // fires several times through the prefetch, and each full-pool rank costs
  // ~920ms of blocking work whose result was going to be superseded anyway.
  // The last settle schedules one more data:ready (main.js), which is what
  // brings us back here to do the single ranking run that counts.
  if (!store.isTeamXgSettled()) {
    _rows = [];
    _progress = null;
    render();
    return;
  }

  // Show the progress state and yield one macrotask tick before snapshotting
  // ctx. This matches the single-tick deferral the old synchronous rebuildRows
  // had via its outer setTimeout(0) wrapper. The yield lets any microtasks
  // queued alongside data:ready (e.g. leagueXg resolving, sessionStorage
  // hydration completing) settle into the store before we freeze ctx, preventing
  // false estimated flags from a stale snapshot.
  _progress = { done: 0, total: null };
  render();
  await new Promise(resolve => setTimeout(resolve, 0));

  if (computeId !== _computeId) return;

  const ctx = buildCtx();
  if (!ctx) { _progress = null; return; }

  const horizonKey = store.getActiveHorizon();
  const horizon    = HORIZONS[horizonKey] ?? HORIZONS.GW1;
  const players    = store.getPlayers();
  const total      = players.length;
  const pending    = [];

  _progress = { done: 0, total };
  renderProgress();

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

    _progress = { done: end, total };
    renderProgress();
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

  _progress = null;
  render(true);
}

// ─── Filter and sort ──────────────────────────────────────────────────────────

/**
 * One row against the active filters. `skip` leaves one axis out — the
 * position and playtime pills show how many players each would add given
 * every OTHER filter, so their counts never read zero just because that
 * axis is narrowed elsewhere.
 */
function passes({ player, score }, skip = null) {
  // Empty set = axis not filtered (see _activePosSet's declaration) — only
  // a non-empty set narrows the list down to its members.
  if (skip !== 'pos' && _activePosSet.size > 0 &&
      !_activePosSet.has(player.position))            return false;
  if (!priceInBand(player.price, _activePriceBand))   return false;
  if (_activeTeamId !== 'all' &&
      String(player.teamId) !== _activeTeamId)        return false;
  if (skip !== 'pt' && _activeMinSecSet.size > 0 &&
      !_activeMinSecSet.has(playtimeOf(score).label)) return false;
  return true;
}

function applyFilters(rows) {
  return rows.filter(row => passes(row));
}

/**
 * Rank every row in `rows` by nextFixtureScore (descending), independent of
 * whatever column the list is currently sorted by — "next-fixture rank" is a
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

/**
 * @param {Array} rows
 * @param {Map<number,{avg:number|null,cost:number|null}>} [lastSeasonByPlayerId]
 *   from buildLastSeasonLookup — present only when _avgPtsMode==='lastSeason'.
 *   When present, sorting by 'avgPointsPerGw'/'costPerPoint' follows the
 *   DISPLAYED (last-season) values instead of the current-season ones, so the
 *   sort arrow never contradicts what's actually on screen.
 */
function applySort(rows, lastSeasonByPlayerId = null) {
  return rows.slice().sort((a, b) => {
    // costPerPoint can be null (no scoring record, or — in 'lastSeason' mode —
    // no past-season data / not loaded yet) — nulls always sort last,
    // regardless of sort direction, rather than comparing as 0.
    if (_sortBy === 'costPerPoint') {
      const av = lastSeasonByPlayerId
        ? lastSeasonByPlayerId.get(a.player.id)?.cost ?? null
        : a.score.costPerPoint;
      const bv = lastSeasonByPlayerId
        ? lastSeasonByPlayerId.get(b.player.id)?.cost ?? null
        : b.score.costPerPoint;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return _sortDesc ? (bv - av) : (av - bv);
    }
    // Same null-sorts-last treatment as costPerPoint above, for the same
    // reason: in 'lastSeason' mode a player may have no past-season data yet.
    if (_sortBy === 'avgPointsPerGw' && lastSeasonByPlayerId) {
      const av = lastSeasonByPlayerId.get(a.player.id)?.avg ?? null;
      const bv = lastSeasonByPlayerId.get(b.player.id)?.avg ?? null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return _sortDesc ? (bv - av) : (av - bv);
    }
    // String columns use localeCompare, not subtraction. Same descending-first
    // convention as every numeric column, for consistency (first click = 'Z'
    // first) — the sort-arrow indicator shows the direction either way.
    if (_sortBy === 'name' || _sortBy === 'team') {
      const av = _sortBy === 'name' ? displayName(a.player) : (a.team?.name ?? '');
      const bv = _sortBy === 'name' ? displayName(b.player) : (b.team?.name ?? '');
      const cmp = av.localeCompare(bv);
      return _sortDesc ? -cmp : cmp;
    }
    let av, bv;
    if (_sortBy === 'price') {
      av = a.player.price; bv = b.player.price;
    } else if (_sortBy === 'playtime') {
      av = playtimeOf(a.score).value ?? 0;
      bv = playtimeOf(b.score).value ?? 0;
    } else if (_sortBy === 'totalPoints') {
      av = a.player.totals?.points ?? 0;
      bv = b.player.totals?.points ?? 0;
    } else if (_sortBy === 'fplForm') {
      av = a.player.fplForm ?? 0;
      bv = b.player.fplForm ?? 0;
    } else if (_sortBy === 'priceChange') {
      // Sorted on the RAW tenths, not calcSeasonPriceChange's millions: the
      // divide by 10 is monotonic, so the ordering is identical and this skips
      // ~7,000 object allocations per sort. Signed, so descending puts the
      // season's biggest risers on top and the biggest fallers at the bottom.
      av = a.player.costChangeStart ?? 0;
      bv = b.player.costChangeStart ?? 0;
    } else if (_sortBy === 'transfersInEvent') {
      av = a.player.transfersInEvent ?? 0;
      bv = b.player.transfersInEvent ?? 0;
    } else if (_sortBy === 'transfersOutEvent') {
      av = a.player.transfersOutEvent ?? 0;
      bv = b.player.transfersOutEvent ?? 0;
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

/**
 * Precompute each player's 'lastSeason' avg/cost ONCE per render (not once
 * per sort comparison, and not once per row) — cheap lookups thereafter for
 * both applySort and the row builders. Only built while _avgPtsMode==='lastSeason'.
 * @param {Array} rows
 * @param {object} ctx
 * @returns {Map<number, {avg:number|null, cost:number|null, seasonName:string|null, loaded:boolean}>}
 */
function buildLastSeasonLookup(rows, ctx) {
  const map = new Map();
  for (const { player } of rows) {
    const loaded = Boolean(ctx.playerSummariesById?.[player.id]);
    const lastSeason = calcLastSeasonAvgPointsPerGw(player, ctx);
    const cost = (lastSeason && player.price > 0 && lastSeason.value > 0)
      ? player.price / lastSeason.value : null;
    map.set(player.id, {
      avg:        lastSeason?.value ?? null,
      cost,
      seasonName: lastSeason?.seasonName ?? null,
      loaded,
    });
  }
  return map;
}

/**
 * The figure a sort key ranks a row by, as displayed — last season's when the
 * source switch says so. Read by the Top pick numeral and the head to head.
 */
function metricOf({ player, score }, key, ls) {
  switch (key) {
    case 'nextFixtureScore':  return score.nextFixtureScore.value;
    case 'avgPointsPerGw':    return ls ? ls.get(player.id)?.avg ?? null : score.avgPointsPerGw.value;
    case 'costPerPoint':      return ls ? ls.get(player.id)?.cost ?? null : score.costPerPoint;
    case 'price':             return player.price;
    case 'priceChange':       return calcSeasonPriceChange(player).value;
    case 'totalPoints':       return player.totals?.points ?? 0;
    case 'fplForm':           return player.fplForm ?? 0;
    case 'transfersInEvent':  return player.transfersInEvent ?? 0;
    case 'transfersOutEvent': return player.transfersOutEvent ?? 0;
    case 'playtime':          return playtimeOf(score).value ?? 0;
    default:                  return score.value;
  }
}

/** `v` (in the metric's own unit) as its big-numeral text. */
function fmtMetric(v, key, intOnly = false) {
  if (v == null) return '–';
  const f = FMT[key] ?? {};
  const x = v * (f.mul ?? 1) / (f.div ?? 1);
  const body = f.dec && !intOnly ? Math.abs(x).toFixed(f.dec) : String(Math.round(Math.abs(x)));
  return `${x < 0 ? '-' : ''}${f.prefix ?? ''}${body}${f.suffix ?? ''}`;
}

/**
 * Thousands-separated integer for the transfer figures — 45231 → "45,231".
 * Deliberately NOT the "45.2k" shortening engine/prices.js uses in its
 * reasoning strings: this is read as a magnitude to compare across rows.
 * @param {number} n
 * @returns {string}
 */
function fmtCount(n) {
  return Number(n ?? 0).toLocaleString('en-GB');
}

// ─── Build: HTML fragments ────────────────────────────────────────────────────

function chipHTML(band, text, { size = '', est = false, title = '' } = {}) {
  return `<span class="chip${size ? ` chip--${size}` : ''}${est ? ' is-est' : ''}"`
    + `${band ? ` data-band="${band}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
}

/** A figure with no tier — still loading, or no record. */
function plainHTML(text, title = '') {
  return `<span class="chip chip--plain chip--sm muted"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
}

function crestHTML(team, size = 20) {
  if (!team) return '';
  return `<span class="crest crest--${size}" aria-hidden="true">`
    + (team.badgeUrl ? `<img src="${esc(team.badgeUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '')
    + `${esc(team.shortName)}</span>`;
}

function badgeHTML(team) {
  return team?.badgeUrl
    ? `<img class="badge16" src="${esc(team.badgeUrl)}" alt="" width="16" height="16" loading="lazy" decoding="async">`
    : '';
}

/** The same badge as SVG, for an oversized watermark where the 70px PNG would blur. */
function watermark(team, right = false) {
  if (!team?.badgeUrl) return '';
  const svg = String(team.badgeUrl).replace('/badges/70/', '/badges/').replace(/\.png$/, '.svg');
  return `<span class="mark${right ? ' mark--r' : ''}" aria-hidden="true" style="background-image:url('${esc(svg)}')"></span>`;
}

function statusHTML(player) {
  if (player.status === 'available') return '';
  return `<span class="stat-dot${player.status === 'doubtful' ? ' stat-dot--d' : ''}"`
    + ` title="${esc(player.statusNote || player.status)}">!</span>`;
}

/**
 * Season price change. ↑ (green) = risen since the season opened, ↓ (red) =
 * fallen, no arrow (muted) = unmoved. This is banked FACT, not the
 * transfer-flow forecast that calcPriceChangeRisk produces — that prediction
 * was removed from the Ranker; the Transfer Planner still carries it.
 */
function priceChangeHTML(player) {
  const change = calcSeasonPriceChange(player);
  // Flat is a real reading, not missing data — it shows "£0.0m" muted rather
  // than a dash, so an unmoved player is visibly distinct from missing data.
  if (change.direction === 'flat') {
    return `<span class="pc" title="Unchanged since the start of the season">£0.0m</span>`;
  }
  const isRise = change.direction === 'rise';
  const amount = `£${Math.abs(change.value).toFixed(1)}m`;
  return `<span class="pc pc--${isRise ? 'rise' : 'fall'}" title="${isRise ? 'Risen' : 'Fallen'} ${amount} since the start of the season">`
    + `${isRise ? '↑' : '↓'} ${amount}</span>`;
}

function playtimeHTML(score) {
  const pt = playtimeOf(score);
  return `<span class="pt${pt.estimated ? ' is-est' : ''}" data-band="${esc(pt.band)}" title="${esc(playtimeTitle(pt))}">${esc(pt.label)}</span>`;
}

/**
 * Per-GW fixture strip, rendered as one slot per GAMEWEEK.
 *
 * Each slot holds zero (blank), one, or two (double) fixture cells, so a 6-GW
 * horizon always shows six slots. Postponed fixtures have no gameweek at all,
 * so they trail the strip as a pill rather than sitting inside it.
 * See FEATURE_ENGINE.md §9.1.
 *
 * @param {Array} perGw   from scoreOverHorizon
 * @param {Array} pending from pendingFixturesForTeam — postponed, no gameweek
 * @param {{small?:boolean, values?:boolean}} [o]  values: print each fixture's
 *   score under its opponent (the Fixture run view)
 */
function stripHTML(perGw, pending = [], o = {}) {
  const slots = groupPerGwSlots(perGw);
  if (slots.length === 0) return '<span class="muted">—</span>';

  const said = [];
  const slotHtml = slots.map(slot => {
    const cells = slot.fixtures.map(entry => {
      // '∅' rather than '–': a dash is what missing data looks like, and a
      // blank gameweek is a known fact, not an absence of one.
      if (entry.isBlank) {
        said.push(`GW${entry.gw} blank`);
        return `<span class="cell cell--blank" title="GW${entry.gw} — blank (no fixture)">∅</span>`;
      }
      const v = Math.round(entry.value);
      const title = `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${v} ${BAND_LABEL[entry.band] ?? ''}`
        + `${entry.provisional ? ', estimated' : ''}${entry.provisionalKickoff ? ', kickoff TBC' : ''}`;
      said.push(title);
      return `<span class="cell${entry.provisional ? ' is-est' : ''}${entry.provisionalKickoff ? ' is-tbc' : ''}"`
        + ` data-band="${esc(entry.band)}" title="${esc(title)}">${esc(entry.opponent ?? '?')}`
        + `${o.values ? `<small>${v}</small>` : ''}</span>`;
    }).join('');
    return `<span class="slot${slot.isDouble ? ' slot--dbl' : ''}"><span class="slot__c">${cells}</span>`
      + `<span class="slot__l">${slot.gw}${slot.isDouble ? ' ··' : ''}</span></span>`;
  }).join('');

  const pend = pending.length > 0
    ? `<span class="pend" title="${pending.length} postponed fixture${pending.length > 1 ? 's' : ''} awaiting a rearranged date">+${pending.length} TBD</span>`
    : '';
  const cls = o.small ? ' strip--sm' : o.values ? ' strip--val' : '';
  return `<span class="sr">Fixtures: ${esc(said.join('; '))}${pending.length ? `; ${pending.length} postponed` : ''}</span>`
    + `<span class="strip${cls}" aria-hidden="true">${slotHtml}${pend}</span>`;
}

/** Next fixture as [slot entry] — first gameweek that is not a blank. */
function nextEntry(score) {
  return groupPerGwSlots(score.perGw).find(s => !s.isBlank)?.fixtures[0] ?? null;
}

// ─── Row view ─────────────────────────────────────────────────────────────────

/**
 * Everything a rendered player needs, built once per render for the rows on
 * screen (and the handful the top section shows), never for the whole pool.
 *
 * @param {{player, team, score, rankTier}} row  rankTier from attachRankTiers,
 *   computed against the FULL pool (FEATURE_ENGINE.md §13)
 * @param {number} rank  1-based position in the current sort
 * @param {object} c  per-render context: nfRank, ls (last-season lookup or
 *   null), ranks ({avg, cost} per-metric rank-tier maps), pendingCtx
 */
function viewOf(row, rank, c) {
  const { player, team, score, rankTier } = row;
  const est = isScoreEstimated(score);

  // Avg Pts/GW and Cost/Pt each get their OWN per-position ranking, on their
  // own number — not the Value tier repeated across the row.
  let avg, cost;
  if (c.ls) {
    // 'lastSeason' mode (FEATURE_ENGINE.md §10.1) — three distinct states per
    // player, not just loaded/unloaded: still loading (bulk fetch in flight),
    // loaded but no past-season record at all (a definitive "—", not an
    // estimate), or loaded with a real last-season figure (always flagged ~,
    // since by definition it isn't this season's number).
    const ls = c.ls.get(player.id);
    if (!ls?.loaded) {
      avg = cost = plainHTML('…', 'Loading last season’s data…');
    } else if (ls.avg === null) {
      avg = cost = plainHTML('—', 'No past-season data for this player');
    } else {
      const season = ls.seasonName ?? 'last season';
      const at = c.ranks.avg.get(player.id), ct = c.ranks.cost.get(player.id);
      avg = chipHTML(TIER_BAND[at], `${ls.avg.toFixed(1)}~`, { size: 'sm',
        title: `${rankTierTitle(at, player.position, `Avg Pts/GW (${season})`)} — ${season}'s average, not this season's` });
      cost = ls.cost !== null
        ? chipHTML(TIER_BAND[ct], `£${ls.cost.toFixed(2)}m~`, { size: 'sm',
            title: `${rankTierTitle(ct, player.position, `Cost/Pt (${season})`)} — derived from ${season}'s average` })
        : plainHTML('—', 'No past-season data for this player');
    }
  } else {
    const a = score.avgPointsPerGw;
    const at = c.ranks.avg.get(player.id), ct = c.ranks.cost.get(player.id);
    const estNote = ' · Estimated — season totals ÷ estimated games played, no per-GW history loaded yet';
    avg = chipHTML(TIER_BAND[at], `${a.value.toFixed(1)}${a.estimated ? '~' : ''}`, { size: 'sm',
      title: rankTierTitle(at, player.position, 'Avg Pts/GW') + (a.estimated ? estNote : '') });
    // Cost/Pt is DERIVED from avgPointsPerGw (price ÷ avgPointsPerGw.value) —
    // when that input is estimated, flag the derived figure too.
    cost = score.costPerPoint !== null
      ? chipHTML(TIER_BAND[ct], `£${score.costPerPoint.toFixed(2)}m${a.estimated ? '~' : ''}`, { size: 'sm',
          title: rankTierTitle(ct, player.position, 'Cost/Pt') + (a.estimated ? ' · Derived from an estimated Avg Pts/GW' : '') })
      : plainHTML('—');
  }

  const valueBand = TIER_BAND[rankTier] ?? score.band;
  const nfBand = bandFromValue(Math.round(score.nextFixtureScore.value));
  const nfEst = score.nextFixtureScore.estimated;
  const name = displayName(player);

  return {
    row, rank, player, team, score, name, est, avg, cost, rankTier, valueBand, nfBand,
    id: player.id,
    aria: `${name}, ${team?.name ?? ''} ${player.position}${player.statusNote ? ` — ${player.statusNote}` : ''}. Value ${Math.round(score.value)}. Open in Matchup Analyser`,
    value: (size = '') => chipHTML(valueBand, String(Math.round(score.value)), { size, est,
      title: rankTierTitle(rankTier, player.position, 'rating') + (est ? ' · Estimated — early data' : '') }),
    nf: (size = '') => chipHTML(nfBand, String(Math.round(score.nextFixtureScore.value)), { size, est: nfEst,
      title: `Fixture + counter-matchup favourability, excluding form — ${BAND_LABEL[nfBand]}${nfEst ? ', estimated' : ''}` }),
    nfRank: c.nfRank.get(player.id),
    strip: o => stripHTML(score.perGw, pendingFixturesForTeam(player.teamId, c.pendingCtx), o),
  };
}

function nameBtnHTML(v) {
  return `<button type="button" class="nm" data-rowbtn aria-label="Rank ${v.rank}. ${esc(v.aria)}" title="${esc(v.name)}">`
    + `<span>${esc(v.name)}</span>${statusHTML(v.player)}</button>`;
}

function metaHTML(v) {
  return `<span class="meta">${badgeHTML(v.team)}${esc(v.team?.shortName ?? '—')}`
    + `<span class="pos pos--${v.player.position}">${v.player.position}</span></span>`;
}

function vsHTML(v, pair) {
  const [A, B] = pair;
  const side = A?.player.id === v.id ? 'L' : B?.player.id === v.id ? 'R' : null;
  return `<button type="button" class="vs" data-vs="${v.id}" aria-pressed="${side ? 'true' : 'false'}"`
    + ` aria-label="${side ? `${esc(v.name)} is in the head to head` : `Compare ${esc(v.name)} head to head`}">${side ?? 'vs'}</button>`;
}

/** List column widths, in order — the grid template and the "fits?" test. */
function columnWidths() {
  return [36, 140, 104, 80]
    .concat(_hidden.has('outlook') ? [] : [_view === 'run' ? 200 : 176, 76])
    .concat(_hidden.has('price') ? [] : [72, 72])
    .concat(_hidden.has('points') ? [] : [60, 40, 44])
    .concat(_hidden.has('transfers') ? [] : [80])
    .concat(_view === 'h2h' ? [48] : []);
}

function rowHTML(v, i, pair, anim) {
  const p = v.player, d = anim ? ` style="--d:${Math.min(i, 30) * 18}ms"` : '';
  const barD = 80 + Math.min(i, 30) * 18;
  const valueCell = `<div class="val" data-band="${v.valueBand}">${v.value()}`
    + `<span class="bar"><span style="width:${Math.round(v.score.value)}%;--d:${barD}ms"></span></span></div>`;
  const nf = `<span class="nf">${v.nf()}<small title="Rank among the players shown">#${v.nfRank}</small></span>`;
  const price = `<div class="pr"><span>£${p.price.toFixed(1)}m</span>${priceChangeHTML(p)}</div>`;
  const tx = `<div class="tx"><span title="Transfers in this gameweek">↑ ${fmtCount(p.transfersInEvent)}</span>`
    + `<span title="Transfers out this gameweek">↓ ${fmtCount(p.transfersOutEvent)}</span></div>`;
  const vs = _view === 'h2h' ? vsHTML(v, pair) : '';

  if (_listWide) {
    return `<li class="row" data-k="${v.id}" data-player-id="${v.id}"${d}>`
      + `<span class="row__rank${v.rank <= 3 ? ' is-top' : ''}" aria-hidden="true">${v.rank}</span>`
      + `<div class="who">${nameBtnHTML(v)}${metaHTML(v)}</div>`
      + valueCell + nf
      + (_hidden.has('outlook') ? '' : `<div class="fx">${v.strip({ values: _view === 'run' })}</div>${playtimeHTML(v.score)}`)
      + (_hidden.has('price') ? '' : `${price}<span>${v.cost}</span>`)
      + (_hidden.has('points') ? '' : `<span>${v.avg}</span><span class="num">${p.totals?.points ?? 0}</span><span class="num">${(p.fplForm ?? 0).toFixed(1)}</span>`)
      + (_hidden.has('transfers') ? '' : tx)
      + vs + '</li>';
  }
  const stat = (label, body) => `<div><span class="lbl lbl--sm">${label}</span>${body}</div>`;
  return `<li class="card" data-k="${v.id}" data-player-id="${v.id}"${d}>`
    + `<div class="card__top${vs ? ' has-vs' : ''}"><span aria-hidden="true">${v.rank}</span>`
    + `<div class="who">${nameBtnHTML(v)}${metaHTML(v)}</div>${v.value('lg')}${vs}</div>`
    + `<div class="card__row"><div class="fx">${v.strip({ values: _view === 'run' })}</div>${playtimeHTML(v.score)}`
    + `<span class="nf"><span class="lbl lbl--sm">Next</span>${v.nf('sm')}</span></div>`
    + `<div class="card__stats">`
    + stat('Price', `<span class="num">£${p.price.toFixed(1)}m ${priceChangeHTML(p)}</span>`)
    + stat('£/pt', v.cost) + stat('Avg', v.avg)
    + stat('Pts', `<span class="num">${p.totals?.points ?? 0}</span>`)
    + stat('Form', `<span class="num">${(p.fplForm ?? 0).toFixed(1)}</span>`)
    + stat('In / out', `<span class="tx">${fmtCount(p.transfersInEvent)} / ${fmtCount(p.transfersOutEvent)}</span>`)
    + `</div></li>`;
}

function infoBtnHTML(key, lg = false) {
  return `<button type="button" class="ib${lg ? ' ib--lg' : ''}" data-info="${key}"`
    + ` aria-expanded="${_infoKey === key}" aria-label="About ${esc(INFO()[key].t)}">i</button>`;
}

function headHTML() {
  const sb = (col, label) => {
    const on = _sortBy === col;
    const dir = _sortDesc ? 'high to low' : 'low to high';
    return `<button type="button" class="sb${on ? ' is-on' : ''}" data-sort="${col}"`
      + ` aria-label="Sort by ${esc(SORT_LABEL[col])}${on ? `, ${dir}` : ''}">${label}${on ? (_sortDesc ? ' ↓' : ' ↑') : ''}</button>`;
  };
  // Cost/Pt and Avg Pts/GW both switch source with the toggle (FEATURE_ENGINE.md
  // §10.1) — marked here so the meaning is clear scrolled away from the drawer.
  const ls = _avgPtsMode === 'lastSeason' ? '~' : '';
  const cell = (inner, cls = '') => `<div${cls ? ` class="${cls}"` : ''}>${inner}</div>`;
  return `<div class="head" style="--cols:${gridCols()}">`
    + cell('<span class="lbl">#</span>')
    + cell(`${sb('name', 'Player')}<span class="dotsep" aria-hidden="true">·</span>${sb('team', 'Team')}`)
    + cell(sb('value', 'Value') + infoBtnHTML('value'))
    + cell(sb('nextFixtureScore', 'Next') + infoBtnHTML('nextFixtureScore'))
    + (_hidden.has('outlook') ? '' : cell(`<span class="lbl">${horizonRange()}</span>${infoBtnHTML('fixtures')}`)
      + cell(sb('playtime', 'Mins') + infoBtnHTML('playtime')))
    + (_hidden.has('price') ? '' : cell(sb('price', '£') + sb('priceChange', '±') + infoBtnHTML('price'))
      + cell(sb('costPerPoint', `£/pt${ls}`) + infoBtnHTML('costPerPoint')))
    + (_hidden.has('points') ? '' : cell(sb('avgPointsPerGw', `Avg${ls}`) + infoBtnHTML('avgPointsPerGw'))
      + cell(sb('totalPoints', 'Pts')) + cell(sb('fplForm', 'Form') + infoBtnHTML('fplForm')))
    + (_hidden.has('transfers') ? '' : cell(sb('transfersInEvent', 'In') + sb('transfersOutEvent', 'Out') + infoBtnHTML('transfersInEvent')))
    + (_view === 'h2h' ? cell('<span class="lbl">vs</span>', 'vs-h') : '')
    + '</div>';
}

function gridCols() {
  return columnWidths().map((w, i) => (i === 1 ? 'minmax(140px,1fr)' : `${w}px`)).join(' ');
}

/** Copy for the "i" popovers — the gameweek window is live, so it's built per call. */
function INFO() {
  const R = horizonRange();
  return {
    value:             { k: 'Rating', t: 'Value', b: `Projected FPL value over ${R} — form, fixtures and minutes folded into one 0–100 number. The colour is his rank against the whole game, not the number: gold is the best in his position.` },
    nextFixtureScore:  { k: 'Rating', t: 'Next fixture', b: 'Fixture plus counter-matchup favourability for his next game, excluding form, on the 0–100 band scale. #n is its rank among the players shown.' },
    fixtures:          { k: 'Outlook', t: R, b: 'One cell per gameweek, coloured on the band scale. Dashed = estimated, hatched = blank gameweek, a grouped pair = double gameweek, amber dot = kickoff TBC.' },
    playtime:          { k: 'Outlook', t: 'Playtime', b: 'Will he play — start rate, share of minutes, squad crowding and availability. Hover the pill for his numbers.' },
    price:             { k: 'Price', t: 'Price & change', b: 'Current price, and how far it has moved since the season opened. Banked fact, not a forecast.' },
    costPerPoint:      { k: 'Price', t: 'Cost per point', b: 'Price ÷ average points per gameweek. Lower is better, so the cheapest points in the game are gold.' },
    avgPointsPerGw:    { k: 'Points', t: 'Avg pts / GW', b: 'Season points ÷ games played. Filters can switch this to last season — loaded player by player, marked ~.' },
    fplForm:           { k: 'Points', t: 'Form', b: 'FPL’s own form figure — points per match over the last 30 days.' },
    transfersInEvent:  { k: 'Market', t: 'Transfers', b: 'Managers moving him in and out this gameweek.' },
  };
}

/** Big Anton numeral; the outline layer takes the enclosing [data-band] hue. */
function bigHTML(v, key, label, slot, delay = 0, outline = true) {
  const txt = fmtMetric(v, key);
  return `<span class="big" role="img" aria-label="${esc(label)}" data-cu="${v ?? ''}" data-key="${key}" data-slot="${slot}" data-delay="${delay}">`
    + (outline ? `<span class="big__o" aria-hidden="true">${txt}</span>` : '')
    + `<span class="big__f" aria-hidden="true">${txt}</span></span>`;
}

// ─── Top section ──────────────────────────────────────────────────────────────

function loadingHTML() {
  const settling = !_progress;
  const title = settling ? 'Waiting on the full league'
    : _progress.total ? `Ranking players… (${_progress.done} / ${_progress.total})` : 'Ranking players…';
  const pct = _progress?.total ? Math.round(_progress.done / _progress.total * 100) : 0;
  return `<div class="ld" aria-hidden="true"><div class="ld__l"><span class="sk"></span><span class="sk"></span><span class="sk"></span></div><span class="sk ld__n"></span></div>`
    + `<div class="prog" role="status"><span class="lbl">${settling ? 'Loading' : 'Computing'}</span>`
    + `<span class="prog__t">${title}</span><span class="prog__bar"><span style="transform:scaleX(${pct / 100})"></span></span></div>`;
}

function stateHTML(title, body, clear = false) {
  return `<div class="state" role="status"><h2>${title}</h2><p>${body}</p>`
    + (clear ? '<button type="button" class="btn" data-clear>Clear filters</button>' : '') + '</div>';
}

function pickHTML(views, c) {
  const metric = FMT[_sortBy] ? _sortBy : 'value';
  const label = SORT_LABEL[metric];
  const num = v => metricOf(v.row, metric, c.ls);
  const gap = (a, b) => fmtMetric(Math.abs(a - b), metric);
  const [lead, second] = views;
  const p = lead.player, nx = nextEntry(lead.score);
  const oppName = nx?.opponent ? (c.teamByShort.get(nx.opponent)?.name ?? nx.opponent) : null;
  const leadNum = num(lead);
  const edge = !second ? 'Only player shown'
    : leadNum === num(second) ? `Level with ${esc(second.name)}`
    : `Ahead of ${esc(second.player.name)} by ${gap(leadNum, num(second))}`;

  const leadHTML = `<article class="lead" data-band="${lead.valueBand}" aria-label="Top pick: ${esc(lead.aria)}">`
    + watermark(lead.team)
    + `<div class="lead__info"><span class="lbl">Top pick · ${esc(label)} · ${horizonRange()}</span>`
    + `<h2 class="lead__name">${esc(lead.name)}</h2>`
    + `<div class="lead__sub"><b>${esc(lead.team?.name ?? '')}</b><span class="posbox pos pos--${p.position}">${p.position}</span>`
    + `<span class="num">£${p.price.toFixed(1)}m</span>${priceChangeHTML(p)}${statusHTML(p)}</div>`
    + `<div class="lead__edge"><span class="tag">Edge</span><span>${edge}</span></div>`
    + `<div class="lead__next"><span class="lbl">Next</span>${lead.nf()}`
    + (nx ? `<span>GW${nx.gw} · ${esc(oppName)} (${nx.venue === 'H' ? 'Home' : 'Away'})</span><span aria-hidden="true">·</span>` : '')
    + `<div class="fx">${lead.strip()}</div></div></div>`
    + `<div class="lead__num"><span class="lbl">${esc(label)}</span>`
    + bigHTML(leadNum, metric, `${label} ${fmtMetric(leadNum, metric)}`, 'lead', 120)
    + `<span class="lead__tier"><span class="slab"></span><span class="tier">${esc(rankTierShort(lead.rankTier, p.position))} · ${BAND_LABEL[lead.score.band] ?? ''}</span>${infoBtnHTML('value', true)}</span>`
    + `</div></article>`;

  const chasers = views.slice(1, 3).map((v, i) => {
    const n = num(v);
    return `<article class="chase" data-player-id="${v.id}" tabindex="0" role="button" aria-label="Rank ${i + 2}. ${esc(v.aria)}" style="--d:${120 + i * 90}ms">`
      + `<span class="chase__rank">${i + 2}</span>`
      + `<div class="chase__txt"><span class="chase__name">${esc(v.name)}</span>`
      + `<span class="chase__meta">${crestHTML(v.team)}<span>${esc(v.team?.name ?? '')} · ${v.player.position} · £${v.player.price.toFixed(1)}m</span></span>`
      + `<span class="chase__meta">${leadNum != null && n != null ? `${gap(leadNum, n)} behind` : ''}</span></div>`
      + `<span data-band="${v.valueBand}">${bigHTML(n, metric, `${label} ${fmtMetric(n, metric)}`, `chase${i}`, 200 + i * 120, false)}</span>`
      + `</article>`;
  }).join('');

  return leadHTML + `<div class="chasers">${chasers}</div>`;
}

function h2hHTML(A, B, c) {
  const lsMode = Boolean(c.ls);
  const M = [
    ['value', 'Value', {}, 1], ['nextFixtureScore', 'Next fixture', {}, 1],
    ['avgPointsPerGw', lsMode ? 'Avg pts (last season)' : 'Avg pts/GW', { dec: 1 }, 1], ['fplForm', 'Form', { dec: 1 }, 1],
    ['totalPoints', 'Total pts', {}, 1], ['costPerPoint', '£ per point', { dec: 2, prefix: '£' }, -1],
    ['playtime', 'Playtime', { suffix: '%', mul: 100 }, 1], ['transfersInEvent', 'Transfers in', { dec: 1, suffix: 'k', div: 1000 }, 1],
  ];
  const fmt = (x, o) => (x == null ? '—'
    : `${o.prefix ?? ''}${o.dec ? (x * (o.mul ?? 1) / (o.div ?? 1)).toFixed(o.dec) : Math.round(x * (o.mul ?? 1) / (o.div ?? 1))}${o.suffix ?? ''}`);
  // Bars are scaled to the best figure in the whole pool, so their length
  // says where each player sits in the game, not just against the other.
  const pct = (k, x, dir) => {
    if (x == null) return 0;
    if (dir < 0) return Math.min(100, c.max.costMin / x * 100);
    return Math.min(100, x / (k === 'playtime' ? 1 : c.max[k]) * 100);
  };
  const side = (v, right, edge) => `<article class="side${right ? ' side--r' : ''}${edge ? ' is-edge' : ''}" data-band="${v.valueBand}"`
    + ` data-player-id="${v.id}" tabindex="0" role="button" aria-label="${right ? 'Right' : 'Left'}: ${esc(v.aria)}" style="--d:${right ? 90 : 0}ms">`
    + watermark(v.team, right)
    + `<div class="side__info"><span class="lbl">#${v.rank} · ${v.player.position} · ${esc(v.team?.shortName ?? '')}</span>`
    + `<h2 class="side__name">${esc(v.name)}</h2>`
    + `<div class="side__sub">${esc(v.team?.name ?? '')}<span class="num">£${v.player.price.toFixed(1)}m</span>${statusHTML(v.player)}</div>`
    + (edge ? `<span class="tag${right ? ' tag--r' : ''}">Edge</span>` : '') + '</div>'
    + `<div class="side__score">${bigHTML(v.score.value, 'value', `Value ${Math.round(v.score.value)}`, right ? 'hhR' : 'hhL', 120)}`
    + `<span class="side__tier"><span class="slab"></span><span class="tier">${esc(rankTierShort(v.rankTier, v.player.position))}</span></span></div>`
    + '</article>';

  if (!B) {
    return `<div class="hh">${side(A, false, false)}<p class="muted">Only one player matches — widen the filters to compare.</p></div>`;
  }

  let winsA = 0, winsB = 0;
  const lines = M.map(([k, label, o, dir], i) => {
    const a = metricOf(A.row, k, c.ls), b = metricOf(B.row, k, c.ls);
    const aw = a != null && b != null && (dir > 0 ? a > b : a < b);
    const bw = a != null && b != null && (dir > 0 ? b > a : b < a);
    if (aw) winsA++;
    if (bw) winsB++;
    const d = `--d:${280 + i * 55}ms`;
    const said = `${label}: ${A.name} ${fmt(a, o)}, ${B.name} ${fmt(b, o)}${aw ? `. ${A.name} ahead` : bw ? `. ${B.name} ahead` : '. Level'}`;
    return `<div class="hl"><span class="sr">${esc(said)}</span>`
      + `<span class="hl__v${aw ? ' is-win' : ''}" aria-hidden="true">${fmt(a, o)}</span>`
      + `<span class="hl__bar hl__bar--l" aria-hidden="true"><span class="${aw ? 'is-win' : ''}" style="width:${pct(k, a, dir)}%;${d}"></span></span>`
      + `<span class="hl__k${_sortBy === k ? ' is-sorted' : ''}" aria-hidden="true">${label}`
      + `${dir < 0 ? '<small>lower = better</small>' : ''}${_sortBy === k ? '<span class="dot">● ranked by</span>' : ''}</span>`
      + `<span class="hl__bar" aria-hidden="true"><span class="${bw ? 'is-win' : ''}" style="width:${pct(k, b, dir)}%;${d}"></span></span>`
      + `<span class="hl__v${bw ? ' is-win' : ''}" aria-hidden="true">${fmt(b, o)}</span></div>`;
  }).join('');
  const lead = winsA === winsB ? null : winsA > winsB ? A : B;
  const swap = cls => `<button type="button" class="sq${cls}" data-swap aria-label="Swap sides">⇄</button>`;

  return `<div class="hh">`
    + `<div class="hh__pair">${side(A, false, lead === A)}`
    + `<div class="hh__mid"><span class="lbl">${horizonRange()}</span><span class="hh__v">v</span>${swap('')}</div>`
    + `${side(B, true, lead === B)}</div>`
    + `<div class="hh__lines" aria-label="Head to head: ${esc(A.name)} v ${esc(B.name)}">${lines}</div>`
    + `<div class="hh__sum"><b>${lead ? `${esc(lead.player.name)} wins ${Math.max(winsA, winsB)} of ${M.length}` : 'Dead level'}</b>`
    + `<span>Pick anyone below with <b>vs</b> to put him on the right.</span>${swap(' hh__swap--sm')}`
    + (_cmpA != null || _cmpB != null ? '<button type="button" class="btn" data-reset-h2h>Back to #1 v #2</button>' : '')
    + `</div></div>`;
}

/**
 * Best fixture run among the players shown. A club's run is its
 * breakdown.fixture.value — scoreOverHorizon's own score for that club over
 * the window, identical for every player at the club — read as-is.
 */
function runHTML(views) {
  const byTeam = new Map();
  for (const v of views) {
    const t = byTeam.get(v.player.teamId)
      ?? { team: v.team, run: Math.round(v.score.breakdown.fixture.value), perGw: v.score.perGw, views: [] };
    t.views.push(v);
    byTeam.set(v.player.teamId, t);
  }
  const teams = [...byTeam.values()].sort((a, b) => b.run - a.run);
  const top = teams[0], rest = teams.slice(1, 5);
  const runBand = bandFromValue(top.run);
  const R = horizonRange();

  const tile = (slot, i) => {
    const d = `--d:${140 + i * 70}ms`;
    if (slot.isBlank) {
      return `<div class="tile tile--blank" role="listitem" aria-label="GW${slot.gw} — blank (no fixture)" style="${d}">`
        + `<span class="tile__gw">GW${slot.gw}</span><span class="tile__big">Blank</span><span class="muted">No fixture</span></div>`;
    }
    const half = e => {
      const v = Math.round(e.value);
      const title = `GW${e.gw} ${e.opponent ?? ''} (${e.venue ?? ''}) — ${v} ${BAND_LABEL[e.band] ?? ''}${e.provisional ? ', estimated' : ''}${e.provisionalKickoff ? ', kickoff TBC' : ''}`;
      return { title, html: `<div class="half${e.provisional ? ' is-est' : ''}${e.provisionalKickoff ? ' is-tbc' : ''}" data-band="${e.band}" title="${esc(title)}">`
        + `<span class="half__opp"><b>${esc(e.opponent ?? '?')}</b><span>${e.venue ?? ''}</span></span>`
        + `<span class="half__v">${v}<span>${BAND_LABEL[e.band] ?? ''}</span></span></div>` };
    };
    const halves = slot.fixtures.map(half);
    if (slot.isDouble) {
      return `<div class="tile tile--dbl" role="listitem" aria-label="GW${slot.gw} double: ${esc(halves.map(h => h.title).join('; '))}" style="${d}">`
        + `<span class="tile__gw">GW${slot.gw} · DOUBLE</span><div class="dbl">${halves.map(h => h.html).join('')}</div></div>`;
    }
    const e = slot.fixtures[0];
    return `<div class="tile${e.provisional ? ' is-est' : ''}" data-band="${e.band}" role="listitem" aria-label="${esc(halves[0].title)}" style="${d}">`
      + `<span class="tile__gw">GW${slot.gw}</span>${halves[0].html}${e.provisional ? '<span class="tile__est">EST</span>' : ''}</div>`;
  };
  const slots = groupPerGwSlots(top.perGw);

  const owners = top.views.slice(0, 3).map(v => `<button type="button" class="own" data-rowbtn data-player-id="${v.id}" aria-label="${esc(v.aria)}">`
    + `<span><b>${esc(v.name)}</b><small>${v.player.position} · £${v.player.price.toFixed(1)}m · #${v.rank}</small></span>${v.value()}</button>`).join('');

  const runRow = (t, i) => `<div class="runrow" style="--d:${300 + i * 60}ms"><span>${i + 2}</span>`
    + `<div class="runrow__t"><span class="runrow__n">${crestHTML(t.team, 22)}${esc(t.team?.name ?? '')}`
    + `<small>${t.views.length} shown · best ${esc(t.views[0].player.name)}</small></span>`
    + `${stripHTML(t.perGw, [], { small: true })}</div>`
    + `<span data-band="${bandFromValue(t.run)}">${bigHTML(t.run, 'value', `Run score ${t.run}`, `run${i}`, 260 + i * 80, false)}</span></div>`;

  return `<div class="run">`
    + `<article class="run__card" aria-label="Best run: ${esc(top.team?.name ?? '')}, ${top.run}">${watermark(top.team)}`
    + `<div class="run__head"><div class="run__info"><span class="lbl">Best fixture run · ${R} · among players shown</span>`
    + `<h2 class="run__name">${esc(top.team?.name ?? '')}</h2>`
    + `<div class="run__edge"><span class="tag">Edge</span><span>${rest[0] ? `${top.run - rest[0].run} clear of ${esc(rest[0].team?.name ?? '')}` : 'Only team shown'}</span></div></div>`
    + `<div class="run__score" data-band="${runBand}"><span class="lbl">Run score</span>${bigHTML(top.run, 'value', `Run score ${top.run}`, 'run', 120)}`
    + `<span><span class="slab"></span><span class="tier">${BAND_LABEL[runBand]}</span></span></div></div>`
    + `<div class="tiles" role="list" aria-label="${esc(top.team?.name ?? '')} ${R}" style="--n:${slots.length}">${slots.map(tile).join('')}</div>`
    + `<div class="own-grp"><span class="lbl">Own the run</span><div class="owners">${owners}</div></div></article>`
    + `<aside class="runs" aria-label="Next best runs"><header><span class="lbl">Chasing</span><h3>Next best runs</h3></header>`
    + (rest.length ? rest.map(runRow).join('') : '<p>One team in view.</p>')
    + `<p>Run score = the club’s Gaffer IQ fixture score over ${R}, nearer gameweeks weighted more.</p></aside></div>`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

/** Update the progress readout in place — one ranking chunk at a time. */
function renderProgress() {
  const t = _top?.querySelector('.prog__t');
  if (!t || !_progress) { render(); return; }
  const { done, total } = _progress;
  t.textContent = total ? `Ranking players… (${done} / ${total})` : 'Ranking players…';
  _top.querySelector('.prog .lbl').textContent = 'Computing';
  _top.querySelector('.prog__bar > span').style.transform = `scaleX(${total ? done / total : 0})`;
}

/** Replay `el`'s [data-anim] entrances. */
function replay(el, on) {
  el.removeAttribute('data-anim');
  if (!on) return;
  void el.offsetWidth;
  el.setAttribute('data-anim', '');
}

/**
 * Full render: top section, list and controls. Engine results in `_rows` are
 * not recomputed; this only re-applies filter, sort, and display state.
 *
 * @param {boolean} animate  true for a render the reader caused (entrances,
 *   count-ups, rows gliding to their new places); false for a data repaint,
 *   which must never replay motion under them.
 */
function render(animate = false) {
  if (!_list) return;
  if (_list.clientWidth) _listWide = measureListWide();
  const busy = Boolean(_progress) || (_rows.length === 0 && !store.isTeamXgSettled());
  _topSec.setAttribute('aria-busy', String(busy));
  _list.setAttribute('aria-busy', String(busy));

  if (busy || _rows.length === 0) {
    // Two different empty states wearing the same shape. "No player data" is a
    // verdict; an unsettled prefetch is a wait, and saying the former during
    // the latter tells the reader the data failed when it is simply late.
    _top.className = `top__in wrap${busy ? ' is-split' : ''}`;
    _top.innerHTML = busy ? loadingHTML() : stateHTML('No player data', 'No player data loaded.');
    _head.innerHTML = '';
    _list.innerHTML = busy
      ? Array.from({ length: 8 }, (_, i) => `<li class="sk-row" aria-hidden="true"><span class="sk" style="--w:${60 + (i * 37) % 35}%"></span></li>`).join('')
      : '';
    _more.hidden = true;
    _listShown = false;
    syncControls(null);
    return;
  }

  const filtered = applyFilters(_rows);

  // Only built in 'lastSeason' mode. buildCtx() is safe to call unconditionally
  // here — _rows is only ever populated after rebuildRowsChunked has already
  // built (and required a non-null) ctx once, so the season is guaranteed loaded.
  //
  // Built over _rows, not `filtered`: the rank tiers below are computed from it,
  // and they follow the same full-pool rule as the Value column — "best forward
  // for Cost/Pt" has to mean the same thing whichever filter pills are active.
  const ls = _avgPtsMode === 'lastSeason' ? buildLastSeasonLookup(_rows, buildCtx()) : null;

  syncControls(filtered, ls);

  if (filtered.length === 0) {
    _top.className = 'top__in wrap';
    _top.innerHTML = stateHTML('No one fits', 'No players match the current filters.', true);
    _head.innerHTML = '';
    _list.innerHTML = '';
    _more.hidden = true;
    return;
  }

  // Avg Pts/GW and Cost/Pt each get their OWN per-position ranking, on their
  // own number. Both read whichever season the toggle is showing, so the
  // colours always describe the figures actually on screen. Recomputed per
  // render rather than cached because the inputs move underneath them:
  // last-season averages land row by row as the bulk load streams in.
  const ranks = {
    avg: rankTierMapBy(_rows, ({ player, score }) => (ls
      ? ls.get(player.id)?.avg ?? null
      : score.avgPointsPerGw.value)),
    // Ascending: Cost/Pt is £ per point, so the CHEAPEST points in the game are
    // the top of this column.
    cost: rankTierMapBy(_rows, ({ player, score }) => (ls
      ? ls.get(player.id)?.cost ?? null
      : score.costPerPoint), { ascending: true }),
  };

  const sorted = applySort(filtered, ls);
  const c = {
    // Ranked among the filtered set, independent of the active sort column.
    nfRank: buildNextFixtureRanks(filtered),
    ls, ranks,
    // Read once per render, not once per row — the pending-fixture index is the
    // same for every row.
    pendingCtx: store.getSeason(),
    teamByShort: new Map(store.getTeams().map(t => [t.shortName, t])),
  };

  // View models for what is on screen: the page of rows, plus whatever the top
  // section reaches past it (the head-to-head picks, a club's run owners).
  const viewCache = new Map();
  const view = i => {
    if (!viewCache.has(i)) viewCache.set(i, viewOf(sorted[i], i + 1, c));
    return viewCache.get(i);
  };

  // ── Top section ──
  _top.className = `top__in wrap${_view === 'pick' ? ' is-pick' : ''}`;
  if (_view === 'pick') {
    _top.innerHTML = pickHTML([0, 1, 2].filter(i => i < sorted.length).map(view), c);
  } else if (_view === 'h2h') {
    c.max = poolMax(ls);
    const [A, B] = pairFromSorted(sorted, view);
    _top.innerHTML = h2hHTML(A, B, c);
  } else {
    _top.innerHTML = runHTML(sorted.map((_, i) => view(i)));
  }
  replay(_top, animate);

  // ── List ──
  const pair = _view === 'h2h' ? pairFromSorted(sorted, view) : [];
  const page = sorted.slice(0, _shown).map((_, i) => view(i));
  const layout = `${_listWide}|${gridCols()}`;
  const flip = animate && _listShown && layout === _lastLayout && !RM.matches ? measureRows() : null;
  const reveal = animate && !_listShown;

  _head.innerHTML = _listWide ? headHTML() : '';
  _list.style.setProperty('--cols', gridCols());
  _list.innerHTML = page.map((v, i) => rowHTML(v, i, pair, reveal)).join('');
  replay(_list, reveal);
  _listShown = true;
  _lastLayout = layout;
  if (flip) playFlip(flip);

  const left = sorted.length - page.length;
  _more.hidden = left <= 0;
  _more.textContent = `Show ${Math.min(PAGE_SIZE, left)} more · ${left} left`;

  fitLead();
  countUp(animate);
}

/** Pool-wide bests the head-to-head bars are scaled against. */
function poolMax(ls) {
  const m = { value: 0, nextFixtureScore: 0, avgPointsPerGw: 0, fplForm: 0, totalPoints: 0, transfersInEvent: 0, costMin: Infinity };
  for (const row of _rows) {
    m.value = Math.max(m.value, row.score.value);
    m.nextFixtureScore = Math.max(m.nextFixtureScore, row.score.nextFixtureScore.value);
    m.avgPointsPerGw = Math.max(m.avgPointsPerGw, metricOf(row, 'avgPointsPerGw', ls) ?? 0);
    m.fplForm = Math.max(m.fplForm, row.player.fplForm ?? 0);
    m.totalPoints = Math.max(m.totalPoints, row.player.totals?.points ?? 0);
    m.transfersInEvent = Math.max(m.transfersInEvent, row.player.transfersInEvent ?? 0);
    const cost = metricOf(row, 'costPerPoint', ls);
    if (cost != null) m.costMin = Math.min(m.costMin, cost);
  }
  for (const k of Object.keys(m)) if (!m[k] || !Number.isFinite(m[k])) m[k] = 1;
  return m;
}

/** Head-to-head pair from the sorted list: the reader's picks, else #1 v #2. */
function pairFromSorted(sorted, view) {
  const at = id => (id == null ? -1 : sorted.findIndex(r => r.player.id === id));
  let a = at(_cmpA);
  if (a < 0) a = 0;
  let b = at(_cmpB);
  if (b < 0 || b === a) b = a === 0 ? 1 : 0;
  return [view(a), b < sorted.length ? view(b) : null];
}

/** Controls that mirror state: segments, counts, drawer, list header. */
function syncControls(filtered, ls = null) {
  if (!_root) return;
  const vi = VIEWS.indexOf(_view);
  _root.querySelector('.seg--view').style.setProperty('--i', vi);
  _root.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === _view)));
  _topSec.setAttribute('aria-label', VIEW_LABEL[_view]);

  if (_sortSelect.value !== _sortBy) _sortSelect.value = _sortBy;
  const dir = _root.querySelector('#rk-dir');
  dir.textContent = _sortDesc ? '↓' : '↑';
  dir.title = _sortDesc ? 'High to low' : 'Low to high';
  dir.setAttribute('aria-label', `Sort direction: ${_sortDesc ? 'high to low' : 'low to high'}. Activate to reverse.`);

  const count = (skip, match) => (filtered ? String(_rows.filter(r => passes(r, skip) && match(r)).length) : '');
  _root.querySelector('[data-pos="all"]').setAttribute('aria-pressed', String(_activePosSet.size === 0));
  POSITIONS.forEach(pos => {
    const b = _root.querySelector(`[data-pos="${pos}"]`);
    b.setAttribute('aria-pressed', String(_activePosSet.has(pos)));
    b.querySelector('.n').textContent = count('pos', r => r.player.position === pos);
  });
  PLAYTIMES.forEach(pt => {
    const b = _root.querySelector(`[data-pt="${pt}"]`);
    b.setAttribute('aria-pressed', String(_activeMinSecSet.has(pt)));
    b.querySelector('.n').textContent = count('pt', r => playtimeOf(r.score).label === pt);
  });
  _root.querySelectorAll('[data-src]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.src === _avgPtsMode)));
  _root.querySelectorAll('[data-cols]').forEach(b => b.setAttribute('aria-pressed', String(!_hidden.has(b.dataset.cols))));

  const tokens = _activePosSet.size + _activeMinSecSet.size + (_activePriceBand !== 'all') + (_activeTeamId !== 'all');
  const fbtn = _root.querySelector('#rk-filters-btn');
  fbtn.classList.toggle('is-on', tokens > 0);
  fbtn.querySelector('.fbtn__n').hidden = tokens === 0;
  fbtn.querySelector('.fbtn__n').textContent = String(tokens);
  _root.querySelector('.cmd [data-clear]').hidden = tokens === 0;
  _root.querySelector('.dr__ft [data-clear]').setAttribute('aria-disabled', String(tokens === 0));

  const N = _rows.length || store.getPlayers().length;
  const countText = filtered
    ? (filtered.length === N ? `${N} players` : `${filtered.length} of ${N} players`)
    : `Ranking ${N} players`;
  let lsText = 'Current-season averages';
  if (_avgPtsMode === 'lastSeason') {
    const summaries = store.getAllPlayerSummaries() ?? {};
    const loaded = store.getPlayers().filter(p => summaries[p.id]).length;
    const season = ls ? [...ls.values()].find(x => x.seasonName)?.seasonName : null;
    lsText = _lsActive ? `Loading last season… ${loaded} / ${store.getPlayers().length}`
      : `${season ?? 'Last-season'} averages, marked ~`;
  }
  _root.querySelector('#rk-list-t').textContent = _activePosSet.size === 1 ? POS_PLURAL[[..._activePosSet][0]]
    : _activePosSet.size ? [..._activePosSet].join(' · ') : 'All players';
  _root.querySelector('#rk-meta').textContent =
    `${countText} · Sorted by ${SORT_LABEL[_sortBy]}, ${_sortDesc ? 'high to low' : 'low to high'} · ${lsText}`;
  _root.querySelector('#rk-ls').textContent = lsText;
  _root.querySelector('#rk-dr-count').textContent = countText;
}

// ─── Motion ───────────────────────────────────────────────────────────────────

/** Row tops before a re-sort/filter, keyed by player id. */
function measureRows() {
  const m = new Map();
  _list.querySelectorAll(':scope > li[data-k]').forEach(el => m.set(el.dataset.k, el.getBoundingClientRect().top));
  return m;
}

/**
 * FLIP: kept rows glide from their old slot, new rows rise in staggered.
 * Transform/opacity only; never runs under prefers-reduced-motion.
 */
function playFlip(old) {
  const vh = window.innerHeight;
  let enter = 0;
  [..._list.querySelectorAll(':scope > li[data-k]')].forEach((el, idx) => {
    const r = el.getBoundingClientRect();
    const vis = r.bottom > 0 && r.top < vh;
    const top = old.get(el.dataset.k);
    if (top !== undefined) {
      const dy = top - r.top;
      if (Math.abs(dy) > 0.5 && (vis || (top < vh && top + r.height > 0))) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
          { duration: 540, delay: Math.min(idx, 24) * 12, easing: EASE, fill: 'backwards' });
      }
    } else if (vis) {
      el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
        { duration: 420, delay: 170 + Math.min(enter++, 20) * 26, easing: EASE, fill: 'backwards' });
    }
  });
}

/**
 * Big numerals count from the value their slot last showed (0 the first
 * time), power2.out, only on renders the reader caused. Mid-count from a big
 * score down to a small decimal one (88 → 8.8) holds whole numbers until it
 * drops under 10, so the readout never grows wider than either end.
 */
function countUp(animate) {
  cancelAnimationFrame(_raf);
  const items = [..._top.querySelectorAll('[data-cu]')].map(el => {
    const to = el.dataset.cu === '' ? null : Number(el.dataset.cu);
    const slot = el.dataset.slot;
    const from = _cuLast.get(slot) ?? 0;
    _cuLast.set(slot, to);
    return { el, to, from, key: el.dataset.key, delay: Number(el.dataset.delay) };
  }).filter(x => animate && !RM.matches && x.to != null && x.from !== x.to);
  if (!items.length) return;

  const set = (x, v) => {
    const intOnly = Math.abs(v) >= 10 && Math.abs(x.to) < 10 && v !== x.to;
    const txt = fmtMetric(v, x.key, intOnly);
    for (const s of x.el.children) s.textContent = txt;
  };
  items.forEach(x => set(x, x.from));
  const t0 = performance.now();
  const tick = now => {
    let live = false;
    for (const x of items) {
      const q = Math.min(1, Math.max(0, (now - t0 - x.delay) / 900));
      const k = 1 - (1 - q) * (1 - q);
      set(x, q >= 1 ? x.to : x.from + (x.to - x.from) * k);
      if (q < 1) live = true;
    }
    if (live) _raf = requestAnimationFrame(tick);
  };
  _raf = requestAnimationFrame(tick);
}

/**
 * The Top pick numeral has a fixed column so the header never reflows as the
 * list re-ranks; a long readout (£4.71m) shrinks to fit it instead.
 */
function fitLead() {
  const col = _top.querySelector('.lead__num');
  const el = col?.querySelector('.big');
  if (!el) return;
  el.style.removeProperty('font-size');
  const need = el.getBoundingClientRect().width * 1.12 + 8;   // covers the offset outline layer
  const fit = Math.min(1, col.clientWidth / need);
  if (fit < 1) el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * fit}px`;
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

/**
 * Fetch every player's element-summary in chunks of SUMMARY_FETCH_CHUNK_SIZE,
 * yielding between chunks — mirrors rebuildRowsChunked's chunk/yield pattern,
 * reusing the same `ensurePlayerSummary` lazy-loader the row-click path uses
 * (so a player already loaded via a click is not re-fetched). Re-renders after
 * every chunk so rows fill in progressively instead of all at once at the end.
 *
 * This IS an explicit bulk fetch of all ~700 players — but triggered only by
 * the user clicking "Last season" on the Avg Pts/GW source switch, not
 * automatically on load, which is what ARCHITECTURE.md's no-bulk-fetch rule
 * actually targets. See FEATURE_ENGINE.md §10.1.
 *
 * Guarded by _summaryLoadRunId: if the user switches back to 'current' (or
 * re-triggers 'lastSeason') mid-load, the stale run's captured id no longer
 * matches _summaryLoadRunId and the loop quietly stops after its current chunk.
 */
async function loadAllSummariesChunked() {
  const runId   = ++_summaryLoadRunId;
  const players = store.getPlayers();
  _lsActive = true;

  for (let i = 0; i < players.length; i += SUMMARY_FETCH_CHUNK_SIZE) {
    if (runId !== _summaryLoadRunId) return;

    const chunk = players.slice(i, i + SUMMARY_FETCH_CHUNK_SIZE);
    await Promise.all(chunk.map(p =>
      ensurePlayerSummary(p.id).catch(err => {
        console.warn('[ranker] summary fetch failed:', p.id, err.message ?? err);
      })
    ));

    if (runId !== _summaryLoadRunId) return;
    render();

    // Yield so the browser can paint the progressive render and process input.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (runId === _summaryLoadRunId) {
    _lsActive = false;
    render();
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * Open a player. Shows loading state on everything showing that player while
 * the element-summary is fetched (first click only — subsequent clicks use the
 * cached summary). On completion emits player:selected so the Matchup
 * Analyser pre-selects the player's next fixture, then navigates there.
 */
async function onPlayerClick(playerId) {
  const player = store.getPlayer(playerId);
  if (!player) return;

  const els = _root.querySelectorAll(`[data-player-id="${playerId}"]`);
  els.forEach(el => el.classList.add('is-opening'));

  try {
    await ensurePlayerSummary(playerId);
  } catch (err) {
    // Non-fatal: navigate anyway; matchup will render with estimated scores.
    console.warn('[ranker] player summary fetch failed:', err.message ?? err);
  } finally {
    els.forEach(el => el.classList.remove('is-opening'));
  }

  const nextFixture = getNextFixtureForTeam(player.teamId);
  if (nextFixture) {
    store.emit('player:selected', { fixtureId: nextFixture.id });
  }
  window.location.hash = 'matchup';
}

/**
 * Avg Pts/GW source switch (FEATURE_ENGINE.md §10.1). Switching to
 * 'lastSeason' re-renders immediately (showing the loading placeholder for
 * every row) then kicks off the chunked bulk load. Switching back to
 * 'current' just bumps _summaryLoadRunId to cancel any in-flight load and
 * re-renders — no fetch needed, current-season data is already in `_rows`.
 */
function setSource(src) {
  if (src === _avgPtsMode) return;
  if (src === 'lastSeason') {
    _avgPtsMode = 'lastSeason';
    _lsActive = true;
    render();
    loadAllSummariesChunked();
  } else {
    _avgPtsMode = 'current';
    _summaryLoadRunId++;
    _lsActive = false;
    render();
  }
}

/** A filter changed: back to the first page, rows glide to their new places. */
function refilter() {
  _shown = PAGE_SIZE;
  render(true);
}

function toggleIn(set, value) {
  if (set.has(value)) set.delete(value); else set.add(value);
  refilter();
}

function clearFilters() {
  _activePosSet.clear();
  _activeMinSecSet.clear();
  _activePriceBand = 'all';
  _activeTeamId = 'all';
  _priceSelect.value = 'all';
  _teamSelect.value = 'all';
  refilter();
}

function setSort(col, desc) {
  _sortBy = col;
  _sortDesc = desc;
  render(true);
}

function setView(v) {
  if (v === _view || _viewBusy) return;
  if (RM.matches || !_top.firstElementChild) { _view = v; render(true); return; }
  _viewBusy = true;
  // Indicator moves now; the section fades out, then the new view enters.
  _root.querySelector('.seg--view').style.setProperty('--i', VIEWS.indexOf(v));
  const out = _top.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }],
    { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  out.onfinish = () => {
    _viewBusy = false;
    _view = v;
    render(true);
    out.cancel();
  };
}

function openFilters() {
  _filtersOpen = true;
  _scrim.hidden = false;
  _drawer.hidden = false;
  _root.querySelector('#rk-filters-btn').setAttribute('aria-expanded', 'true');
  _drawer.querySelector('[data-close-filters]').focus();
}

function closeFilters() {
  if (!_filtersOpen) return;
  _filtersOpen = false;
  _scrim.hidden = true;
  _drawer.hidden = true;
  const btn = _root.querySelector('#rk-filters-btn');
  btn.setAttribute('aria-expanded', 'false');
  btn.focus();
}

function openInfo(key, btn) {
  if (_infoKey === key) { closeInfo(); return; }
  const it = INFO()[key];
  _infoKey = key;
  _infoReturn = key;
  _root.querySelectorAll('[data-info]').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.info === key)));
  _info.innerHTML = `<span class="lbl">${esc(it.k)}</span><h3 id="rk-info-t">${esc(it.t)}</h3><p>${esc(it.b)}</p>`
    + '<button type="button" class="btn" data-info-close>Close <kbd>ESC</kbd></button>';
  const r = btn.getBoundingClientRect();
  const x = Math.max(12, Math.min(r.left + r.width / 2 - 170, window.innerWidth - 352));
  const y = r.bottom + 230 > window.innerHeight ? Math.max(12, r.top - 230) : r.bottom + 10;
  _info.style.left = `${x}px`;
  _info.style.top = `${y}px`;
  _info.hidden = false;
  _info.querySelector('[data-info-close]').focus();
}

function closeInfo() {
  if (!_infoKey) return;
  _infoKey = null;
  _info.hidden = true;
  _root.querySelectorAll('[data-info]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  _root.querySelector(`[data-info="${_infoReturn}"]`)?.focus();
}

function onClick(e) {
  const t = e.target;
  const hit = sel => t.closest(sel);
  let el;
  if ((el = hit('[data-info-close]'))) return closeInfo();
  if ((el = hit('[data-info]'))) { e.stopPropagation(); return openInfo(el.dataset.info, el); }
  if ((el = hit('[data-view]'))) return setView(el.dataset.view);
  if ((el = hit('[data-pos]'))) {
    if (el.dataset.pos === 'all') { _activePosSet.clear(); return refilter(); }
    return toggleIn(_activePosSet, el.dataset.pos);
  }
  if ((el = hit('[data-pt]'))) return toggleIn(_activeMinSecSet, el.dataset.pt);
  if ((el = hit('[data-src]'))) return setSource(el.dataset.src);
  if (hit('#rk-dir')) return setSort(_sortBy, !_sortDesc);
  if (hit('#rk-filters-btn')) return _filtersOpen ? closeFilters() : openFilters();
  if (hit('[data-close-filters]') || t === _scrim) return closeFilters();
  if ((el = hit('[data-clear]'))) return el.getAttribute('aria-disabled') === 'true' ? null : clearFilters();
  if ((el = hit('[data-cols]'))) {
    const k = el.dataset.cols;
    if (_hidden.has(k)) _hidden.delete(k); else _hidden.add(k);
    return render(true);
  }
  // Header sort: same column flips direction, a new one starts high to low.
  if ((el = hit('[data-sort]'))) return setSort(el.dataset.sort, _sortBy === el.dataset.sort ? !_sortDesc : true);
  if (hit('[data-swap]')) return swapPair();
  if (hit('[data-reset-h2h]')) { _cmpA = _cmpB = null; _msg.textContent = ''; return render(true); }
  if (hit('#rk-more')) { _shown += PAGE_SIZE; return render(true); }
  if ((el = hit('[data-vs]'))) {
    if (el.getAttribute('aria-pressed') === 'true') return;
    const A = _top.querySelector('.side:not(.side--r)');
    _cmpA = A ? Number(A.dataset.playerId) : null;
    _cmpB = Number(el.dataset.vs);
    const nameOf = id => displayName(store.getPlayer(id) ?? { name: '' });
    _msg.textContent = `Head to head: ${_cmpA != null ? nameOf(_cmpA) : ''} v ${nameOf(_cmpB)}`;
    render(true);
    window.scrollTo({ top: 0, behavior: RM.matches ? 'auto' : 'smooth' });
    return;
  }
  if ((el = hit('[data-player-id]')) && !el.classList.contains('is-opening')) {
    onPlayerClick(Number(el.dataset.playerId));
  }
}

function swapPair() {
  const [a, b] = [..._top.querySelectorAll('.side')].map(el => Number(el.dataset.playerId));
  if (b == null) return;
  _cmpA = b;
  _cmpB = a;
  render(true);
}

function onChange(e) {
  if (e.target === _sortSelect) {
    // From the menu, names and clubs read A–Z; every figure starts high to low.
    const col = _sortSelect.value;
    return setSort(col, !(col === 'name' || col === 'team'));
  }
  if (e.target === _priceSelect) { _activePriceBand = _priceSelect.value; return refilter(); }
  if (e.target === _teamSelect) { _activeTeamId = _teamSelect.value; return refilter(); }
}

/** Arrow/Home/End between players' name buttons; J/K do the same from anywhere. */
function moveFocus(e, step) {
  const list = [..._root.querySelectorAll('[data-rowbtn]')];
  if (!list.length) return;
  const i = list.indexOf(document.activeElement);
  const j = step === 'home' ? 0 : step === 'end' ? list.length - 1
    : i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + step));
  list[j].focus();
  e.preventDefault();
}

function onKeydown(e) {
  if (store.getActiveModule() !== 'ranker') return;
  const k = e.key;

  if (_infoKey) {
    if (k === 'Escape') { e.preventDefault(); closeInfo(); return; }
    if (k === 'Tab') { e.preventDefault(); _info.querySelector('[data-info-close]').focus(); return; }
  }
  if (_filtersOpen) {
    if (k === 'Escape') { e.preventDefault(); closeFilters(); return; }
    if (k === 'Tab') {
      const f = [..._drawer.querySelectorAll('button, select')];
      const first = f[0], last = f[f.length - 1];
      if (!_drawer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  const tag = e.target?.tagName;
  if (e.metaKey || e.ctrlKey || e.altKey || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  // Cards in the top section act as buttons.
  if ((k === 'Enter' || k === ' ') && e.target?.matches?.('.rk [role=button][data-player-id]')) {
    e.preventDefault();
    e.target.click();
    return;
  }
  if (e.target?.matches?.('[data-rowbtn]')) {
    if (k === 'ArrowDown') return moveFocus(e, 1);
    if (k === 'ArrowUp') return moveFocus(e, -1);
    if (k === 'Home') return moveFocus(e, 'home');
    if (k === 'End') return moveFocus(e, 'end');
  }
  if (_filtersOpen || _infoKey || _rows.length === 0) return;
  if (k === 'j') return moveFocus(e, 1);
  if (k === 'k') return moveFocus(e, -1);
  if ('1234'.includes(k) && k.length === 1) { e.preventDefault(); toggleIn(_activePosSet, POSITIONS[Number(k) - 1]); return; }
  if (k === 'f' || k === 'F') { e.preventDefault(); openFilters(); return; }
  if (k === 'v' || k === 'V') { e.preventDefault(); setView(VIEWS[(VIEWS.indexOf(_view) + 1) % VIEWS.length]); return; }
  if (k === 'l') { setSource(_avgPtsMode === 'current' ? 'lastSeason' : 'current'); return; }
  if (k === 'x') clearFilters();
}

/** Card or grid rows depending on whether every column fits the list. */
function measureListWide() {
  const need = columnWidths().reduce((a, b) => a + b, 0) + (columnWidths().length - 1) * 10 + 16;
  return _list.clientWidth >= need;
}

let _resizeRaf = 0;
function onResize() {
  cancelAnimationFrame(_resizeRaf);
  _resizeRaf = requestAnimationFrame(() => {
    if (store.getActiveModule() !== 'ranker' || !_list.clientWidth) return;
    const wide = measureListWide();
    if (wide !== _listWide) { _listWide = wide; render(); }
    else fitLead();
  });
}

/**
 * Set when data changed while the Ranker was off screen, so activation knows
 * it owes a rebuild. See onRouteChanged.
 */
let _pendingRebuild = false;

function onDataReady() {
  // Cheap enough to keep eager, and it leaves the filter correct for whenever
  // the tab is next opened.
  populateTeamFilter();

  // Ranking the full pool is by far the most expensive thing this module does
  // (~920ms for 604 players, measured). data:ready fires once per team-xG
  // payload at boot, so doing this off screen burned seconds ranking a list
  // nobody was looking at. Defer to activation — store.js's activeModule note
  // has the full measurement.
  if (store.getActiveModule() !== 'ranker') {
    _pendingRebuild = true;
    return;
  }
  _pendingRebuild = false;
  rebuildRowsChunked();
}

/** Flush a rebuild deferred while off screen, once the Ranker is shown. */
function onRouteChanged(module) {
  if (module !== 'ranker') {
    closeFilters();
    closeInfo();
    return;
  }
  if (_pendingRebuild) {
    _pendingRebuild = false;
    rebuildRowsChunked();
  } else if (measureListWide() !== _listWide) {
    // The list's width is only measurable once the section is on screen.
    render();
  }
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
  const section = document.querySelector('[data-module="ranker"]');
  _root        = section.querySelector('.rk');
  _cmd         = _root.querySelector('#rk-cmd');
  _top         = _root.querySelector('#rk-top');
  _topSec      = _root.querySelector('#rk-top-sec');
  _head        = _root.querySelector('#rk-head');
  _list        = _root.querySelector('#rk-rows');
  _more        = _root.querySelector('#rk-more');
  _msg         = _root.querySelector('#rk-msg');
  _drawer      = _root.querySelector('#rk-drawer');
  _scrim       = _root.querySelector('#rk-scrim');
  _info        = _root.querySelector('#rk-info');
  _sortSelect  = _root.querySelector('#rk-sort');
  _teamSelect  = _root.querySelector('#rk-team');
  _priceSelect = _root.querySelector('#rk-price');

  _sortSelect.innerHTML = SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  populatePriceFilter();

  _root.addEventListener('click', onClick);
  _root.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);

  // The list header sticks under the command bar, which wraps onto two rows
  // at some widths — track its real height rather than assuming one.
  new ResizeObserver(() => {
    _root.style.setProperty('--rk-cmd-h', `${_cmd.offsetHeight}px`);
  }).observe(_cmd);

  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);
  store.subscribe('route:changed',   onRouteChanged);

  render();

  // If the store already has data (hydrated from sessionStorage, or data:ready
  // fired before this module registered its subscription), render right now
  // rather than waiting for an event that won't fire again. Routed through
  // onDataReady so the off-screen guard applies here too — on a cold load of
  // any other tab this now marks the rebuild pending instead of running it.
  if (store.isFresh()) onDataReady();
}
