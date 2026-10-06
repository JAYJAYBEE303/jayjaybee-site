/**
 * js/modules/planner.js
 * Layer: module. Owns the DOM for the Transfer Planner view.
 * Side effects: DOM writes, sessionStorage/localStorage reads/writes. Reads
 * from store; delegates all scoring to engine/composite.js exclusively via
 * scorePlayer(), and every recommendation to engine/transfers.js,
 * engine/strategy.js and engine/chips.js.
 * No analytical logic lives here — see FEATURE_ENGINE.md §10 and §11.
 * Layout: design export FINAL - Planner.dc.html (styles css/planner.css) —
 * the week's verdict as an Out → In tape, then "the run": moves and chips
 * staged into the next six gameweeks, checked by planner-run.js and saved on
 * this device, fed from a move tray that shows one lens board at a time.
 * See ROADMAP.md Phase 2D, ARCHITECTURE.md §10.
 *
 * Subscriptions: data:ready, horizon:changed, route:changed, squad:updated,
 *   squadPicks:updated
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import {
  HORIZONS, PRICE_BUY_NOW_CONFIDENCE, PRICE_BUY_NOW_SCORE_MIN,
  SQUAD_LIMITS, SQUAD_TOTAL, BENCH_SIZE, CHIP_IDS, CHIP_LABELS,
} from '../config.js';
import { buildScoreContext, scorePlayer, rankPlayers, attachRankTiers } from '../engine/composite.js';
import { calcPriceChangeRisk } from '../engine/prices.js';
import {
  scoreWildcardTiming, scoreFreeHitTiming,
  scoreBenchBoostTiming, scoreTripleCaptainTiming,
} from '../engine/chips.js';
import { fetchAndMapSquad, loadSavedTeamId, saveTeamId, resolveImportGw } from '../squadImport.js';
import { enumerateSwaps, calcSquadFlexibility } from '../engine/transfers.js';
import { buildVerdict } from '../engine/strategy.js';
import { pickStartingXI } from '../engine/lineup.js';
import {
  LANE_BOARDS, laneLabel, swapKey, CONFIDENCE_LABELS, LANE_DIRECTIONS, timingNote, emptyMessage,
} from './planner-boards.js';
import { evaluateRun, RUN_WEEKS } from './planner-run.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** localStorage key for chip-usage tracking (Phase 4-3). Persists across sessions
 *  because chip usage is a season-long decision the user makes once per chip. */
const CHIPS_USED_KEY = 'gafferiq_chips_used';

/** localStorage key for the saved run: its moves, chip weeks, bank, free
 *  transfers and hit setting. Written only by Save run. */
const RUN_KEY = 'gafferiq_planner_run';

// CHIP_IDS and CHIP_LABELS now live in config.js — shared with
// engine/strategy.js's chipWindow trigger message, so a raw id never
// leaks into rendered text on either surface.

/** Moves shown per lens in the tray. */
const TRAY_N = 8;

/** The lane value as a short tag beside a number on the verdict tape. */
const EDGE_UNIT = {
  now: 'next GW', longterm: 'over 5 GWs', future: 'over GWs 3–5',
  funds: 'pts per £m freed', ceiling: 'peak-week pts', structure: 'restored over 5 GWs',
};

const BAND_LABEL = {
  excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral',
  tough: 'Tough', brutal: 'Brutal', extreme: 'Extreme',
};
const POS_FULL = { GKP: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };

/** Read per call, not at import: keeps this module importable under Node. */
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const EASE = 'cubic-bezier(.2,.7,.2,1)';

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

/** Remaining transfer budget in £m (e.g. 2.5 = £2.5m). The run's bank. */
let _budget = 0;

/** 1 or 2 free transfers available going into the first week of the run. */
let _freeTransfers = 1;

/** If true, the run may take transfers beyond the free count (each a hit). */
let _allowExtraHit = false;

/** Map<playerId, scorePlayer result> — rebuilt on squad/horizon changes. */
let _scores = new Map();

/**
 * Map<playerId, rankTier|null> — every player's standing against the full
 * pool (FEATURE_ENGINE.md §13), keyed by whichever horizon last built it.
 * null until computed. Rebuilding this depends on horizon (a player's score,
 * and therefore rank, differs by horizon) but NOT on squad membership, so it
 * is invalidated on data:ready/horizon:changed only — not re-scored on every
 * add/remove, which would cost ~700 scorePlayer calls per click for no reason.
 */
let _rankTierByPlayerId = null;

/** Set<chipId> of chips the user has marked as already used this season. */
let _chipsUsed = new Set();

/** Cached candidate scores, one Map per scoring window (long / now1 / far —
 *  see engine/transfers.js). Cleared together on data or horizon change: a
 *  window-specific cache outliving its window would silently serve scores from
 *  the wrong number of gameweeks. */
let _scoreCaches = { long: new Map(), now1: new Map(), far: new Map() };

/** Last enumeration, reused when only budget or free transfers changed. */
let _swaps = [];

/** The verdict built from _swaps, or null. */
let _verdict = null;

/** Why there is no verdict: 'short' | 'settling' | 'noctx' | 'unscored' | 'ready'. */
let _boardState = 'short';

/**
 * Chip timing recommendations, computed by computeChipRecs() so buildVerdict()
 * can read them without recomputing chip timing itself. computeChipRecs() runs
 * before computeBoards() — without that ordering the very first verdict would
 * silently lose its chipWindow trigger, because this starts empty.
 */
let _chipRecs = {};

/** True once data:ready has fired at least once. */
let _dataReady = false;

/**
 * True once wireDom() has attached all listeners.
 * Guards against double-wiring if data:ready fires more than once.
 */
let _domWired = false;

// ─── The run (presentation state, saved on Save run) ─────────────────────────

/**
 * Moves staged into the run. Each carries the figures planner-run.js adds up,
 * snapshotted from the swap when it was added and refreshed from _swaps on
 * every render while that swap is still on the boards.
 * @type {Array<{id:string, outId:number, inId:number, gw:number, priceDiff:number,
 *               gain:number, inValue:number, inBand:string, inEst:boolean}>}
 */
let _moves = [];

/** Chip id → gameweek the reader put it in, or null for "not in this run".
 *  A chip with no entry sits in its recommended week when that falls inside
 *  the run. */
let _chipsAt = {};

let _savedSnap = '';        // what Save run last wrote, for the unsaved marker
let _target    = null;      // gameweek new moves go into
let _lens      = 'longterm';
let _q         = '';        // squad drawer search
let _drawerOpen = false;
let _dialog    = null;      // { title, body, ok, run }
let _dialogReturn = null;
let _toastTimer = 0;
let _undo      = null;
let _heroShown = false;     // the tape's entrance has played
let _weeksShown = false;

// ─── DOM refs (populated in wireDom) ─────────────────────────────────────────

let _root    = null;
let _hero    = null;
let _runWrap = null;
let _weeks   = null;
let _tray    = null;
let _drawer  = null;
let _scrim   = null;
let _cmd     = null;

// Import refs (Phase 4-1). Two forms share handleImport — the empty-state
// hero and the squad drawer — so these point at whichever one was submitted.
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
 * Drives the dashed "estimated" treatment on chips and numbers.
 */
function isScoreEstimated(score) {
  return Boolean(score?.breakdown?.form?.estimated || score?.breakdown?.counter?.estimated);
}

/**
 * Which gameweek this page is planning FOR, and how the round on the
 * scoreboard relates to it.
 *
 * MODEL: `season.currentGw` is FPL's `is_current`, which stays pointing at a
 * round from its deadline until the next one opens — so for most of a
 * weekend it names a gameweek whose deadline has GONE. A planner is a tool
 * for spending transfers, and transfers cannot be spent into a round that has
 * kicked off, so planning against currentGw once it is live produced advice
 * about a deadline the user could no longer meet ("Triple Captain looks
 * strongest in GW2, this gameweek" while GW2 was being played). Once the
 * current round has started, the planning gameweek is the NEXT one.
 *
 * Deliberately local to this module: the Dashboard and Matchup are reporting
 * on the live round and must keep using currentGw. Only the planner plans.
 *
 * @returns {{ currentGw: number|null, planningGw: number|null,
 *             phase: 'live'|'pre-deadline'|'finished'|'off-season',
 *             unplayed: number }}
 */
function getPlanningTiming() {
  const currentGw = store.getCurrentGw();
  const nextGw    = store.getNextGw();
  const ev        = currentGw == null
    ? null
    : store.getEvents().find(e => e.id === currentGw) ?? null;

  if (!ev) {
    return {
      currentGw, planningGw: nextGw ?? currentGw ?? 1,
      phase: 'off-season', unplayed: 0,
    };
  }

  // `dataChecked` is FPL's data_checked — true once at least one fixture in the
  // round has been processed. Kept alongside the deadline comparison because
  // the deadline alone is a clock read, and a wrong client clock would
  // otherwise silently skip a gameweek. Either signal is enough.
  const deadlinePassed = ev.deadline ? Date.parse(ev.deadline) <= Date.now() : false;
  const started = Boolean(ev.complete || ev.dataChecked || deadlinePassed);

  // `complete` is full time by the fixtures. `ev.finished` waits for bonus
  // confirmation, so it would report a played-out round as still 'live' — with
  // an unplayed count of zero, which is the state planner-boards.js's lead
  // sentence has to special-case away. See normalise.js deriveEventCompletion.
  const phase = ev.complete ? 'finished' : started ? 'live' : 'pre-deadline';

  // Only meaningful while the round is under way: how many of its matches have
  // yet to be played, because each one still to come can move every number on
  // this page. Postponed fixtures carry gw === null and are excluded by the
  // equality check, which is correct — they are not pending results for THIS
  // round.
  const unplayed = phase === 'live'
    ? store.getFixtures().filter(f => f.gw === currentGw && !f.played).length
    : 0;

  const planningGw = started
    ? (nextGw ?? currentGw + 1)
    : currentGw;

  return { currentGw, planningGw, phase, unplayed };
}

/** Build the engine scoring context from the current store state. */
function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
    teamXgBySlug: store.getAllTeamXg(),
    // The planning gameweek, NOT the live one — this is what moves every
    // fixture window on the page (and therefore the chip timings below) off a
    // round the user can no longer act on. See getPlanningTiming.
    currentGw: getPlanningTiming().planningGw ?? store.getNextGw() ?? 1,
  });
}

/** Resolve the active horizon object from the store. */
function getHorizon() {
  return HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW5;
}

/** The run's gameweeks: the planning gameweek and the five after it. */
function runGws() {
  const start = getPlanningTiming().planningGw ?? 1;
  return Array.from({ length: RUN_WEEKS }, (_, i) => start + i).filter(gw => gw <= 38);
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

// ─── Run persistence ─────────────────────────────────────────────────────────

function runSnapshot() {
  return JSON.stringify({
    moves: _moves.map(m => `${m.outId}-${m.inId}@${m.gw}`),
    chipsAt: _chipsAt, ft: _freeTransfers, hit: _allowExtraHit, bank: _budget,
  });
}

function isDirty() {
  return runSnapshot() !== _savedSnap;
}

function loadRun() {
  try {
    const saved = JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null');
    if (saved) {
      _moves = Array.isArray(saved.moves) ? saved.moves.filter(m => m && m.outId && m.inId && m.gw) : [];
      _chipsAt = saved.chipsAt && typeof saved.chipsAt === 'object' ? saved.chipsAt : {};
      _freeTransfers = saved.ft === 2 ? 2 : 1;
      _allowExtraHit = Boolean(saved.hit);
      _budget = Number.isFinite(saved.bank) && saved.bank >= 0 ? saved.bank : 0;
    }
  } catch { /* corrupt — start from an empty run */ }
  _savedSnap = runSnapshot();
}

function saveRun() {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify({
      moves: _moves, chipsAt: _chipsAt, ft: _freeTransfers, hit: _allowExtraHit, bank: _budget,
    }));
  } catch {
    toast('Couldn’t save — storage is blocked.');
    return;
  }
  _savedSnap = runSnapshot();
  const ev = evaluate();
  const gws = runGws();
  toast(ev.valid
    ? `Run saved, GW${gws[0]}–${gws[gws.length - 1]}.`
    : `Saved — ${ev.errors} problem${ev.errors > 1 ? 's' : ''} still to fix.`);
  renderCmd();
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
 * Re-enumerate swaps and build the verdict.
 * @param {boolean} rescore  false when only budget/free-transfers changed, in
 *                           which case the cached candidate scores are reused
 *                           — that is what keeps typing in the bank box fast.
 */
function computeBoards(rescore = true) {
  _verdict = null;

  if (store.getSquad().length < SQUAD_TOTAL) {
    _swaps = [];
    _boardState = 'short';
    return;
  }

  // Before enumerateSwaps, deliberately. Every swap is scored against the
  // counter-matchup metric, so running the enumeration now would produce a
  // ranked board that reorders itself when the Understat prefetch finishes —
  // and the enumeration is the most expensive thing this module does, so the
  // work would be thrown away as well as misleading. Placeholders until then;
  // the data:ready that follows the last settle brings us back here.
  if (!store.isTeamXgSettled()) {
    _swaps = [];
    _boardState = 'settling';
    return;
  }

  const ctx = buildCtx();
  if (!ctx) {
    _swaps = [];
    _boardState = 'noctx';
    return;
  }

  if (rescore) _scoreCaches = { long: new Map(), now1: new Map(), far: new Map() };

  try {
    _swaps = enumerateSwaps(store.getSquad(), store.getPlayers(), ctx, {
      horizon:            getHorizon(),
      budget:             _budget,
      freeTransfers:      _freeTransfers,
      caches:             _scoreCaches,
      rankTierByPlayerId: _rankTierByPlayerId,
    });
  } catch (err) {
    console.warn('[planner] enumerateSwaps failed:', err?.message ?? err);
    _swaps = [];
  }

  // FIX 6: an empty enumeration is ambiguous on its own — it is the correct,
  // honest result of "no legal transfer beats your budget", but it is ALSO
  // what a squad member failing to score produces (enumerateSwaps requires
  // every squad member to score before it enumerates anything; see its
  // `nearEntries.length < SQUAD_TOTAL` guard). buildVerdict([]) can't tell
  // these apart and always renders the "no legal transfers" roll verdict,
  // which would be a confident, wrong statement in the second case. _scores
  // is populated by this module's own per-player scoreSquad() over the same
  // squad/horizon/ctx just before this runs, so a squad member missing from
  // it is the simplest available signal that a scoring failure — not a
  // legitimately empty budget search — is why _swaps is empty.
  const squadScored = store.getSquad().every(id => _scores.has(id));
  if (_swaps.length === 0 && !squadScored) {
    _boardState = 'unscored';
    return;
  }

  const squadPlayers = store.getSquad().map(id => store.getPlayer(id)).filter(Boolean);
  _verdict = buildVerdict(_swaps, {
    flexibility:   calcSquadFlexibility(squadPlayers, _scores),
    freeTransfers: _freeTransfers,
    chipRecs:      _chipRecs,
  }, ctx);
  _boardState = 'ready';
}

/**
 * Price change note for a transfer-in player, or '' when there is no
 * meaningful signal.
 * @param {Player} player  the player being transferred in
 * @param {object} score   scorePlayer output for the inPlayer
 * @returns {string}  plain text
 */
function priceChangeNote(player, score) {
  const risk = calcPriceChangeRisk(player);
  if (risk.confidence === 0) return '';

  const pct  = Math.round(risk.confidence * 100);
  const isBuyNow = risk.direction === 'rise'
    && risk.confidence >= PRICE_BUY_NOW_CONFIDENCE
    && (score?.value ?? 0) >= PRICE_BUY_NOW_SCORE_MIN;
  const isFallWarning = risk.direction === 'fall' && risk.confidence >= 0.3;

  if (!isBuyNow && !isFallWarning && risk.direction !== 'rise') return '';
  if (isBuyNow) return `↑ Buy now — price likely to rise (${pct}% confidence)`;
  if (risk.direction === 'rise') return `↑ Price may rise soon (${pct}% confidence)`;
  return `↓ Price may fall — consider alternatives (${pct}% confidence)`;
}

// ─── Chip timing (Phase 4-3) ─────────────────────────────────────────────────

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
 * Compute all four chip recommendations into _chipRecs. Pure-engine calls; the
 * module only owns DOM. Always keeps the reasoning per ROADMAP rule "always
 * show the reasoning" — when a chip can't be scored (e.g. empty squad for
 * BB/TC) the fallback reasoning says why.
 */
function computeChipRecs() {
  // Every chip recommendation names a GAMEWEEK chosen by comparing scores
  // across the horizon, so all four would name one week now and a different
  // one when the prefetch finished. _chipRecs is deliberately left EMPTY
  // rather than filled with placeholders: buildVerdict reads it to fire its
  // chipWindow trigger, and a placeholder would be a recommendation it could
  // act on. computeBoards is gated on the same condition.
  if (!_dataReady || !store.isTeamXgSettled()) { _chipRecs = {}; return; }
  const ctx = buildCtx();
  if (!ctx) { _chipRecs = {}; return; }
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

  _chipRecs = {
    wildcard:      wcBest,
    freehit:       fhRec,
    benchboost:    bbRec ?? fallback.benchboost,
    triplecaptain: tcRec ?? fallback.triplecaptain,
  };
}

/** Which week each chip sits in for this run: the reader's choice, else its
 *  recommended week when that falls inside the run. Used chips sit out. */
function effectiveChips(gws) {
  const at = {};
  for (const id of CHIP_IDS) {
    if (_chipsUsed.has(id)) { at[id] = null; continue; }
    const chosen = id in _chipsAt ? _chipsAt[id] : (_chipRecs[id]?.gw ?? null);
    at[id] = chosen != null && gws.includes(chosen) ? chosen : null;
  }
  return at;
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** Swaps on the boards right now, by key. */
function swapMap() {
  return new Map(_swaps.map(s => [swapKey(s), s]));
}

/** A run move from a swap: the figures planner-run.js needs, snapshotted. */
function moveFrom(swap, gw) {
  return {
    id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    outId: swap.outId, inId: swap.inId, gw,
    priceDiff: swap.priceDiff,
    gain: swap.lanes.longterm.value,
    inValue: Math.round(swap.inScore?.value ?? 0),
    inBand: swap.inScore?.band ?? 'neutral',
    inEst: isScoreEstimated(swap.inScore),
  };
}

/** Refresh each move's snapshot from the boards while its swap is still on them. */
function refreshMoves() {
  const map = swapMap();
  for (const m of _moves) {
    const s = map.get(`${m.outId}-${m.inId}`);
    if (!s) continue;
    Object.assign(m, { priceDiff: s.priceDiff, gain: s.lanes.longterm.value,
      inValue: Math.round(s.inScore?.value ?? 0), inBand: s.inScore?.band ?? 'neutral', inEst: isScoreEstimated(s.inScore) });
  }
}

function evaluate() {
  const gws = runGws();
  const live = _moves.filter(m => gws.includes(m.gw));
  return evaluateRun(live, effectiveChips(gws), {
    gws, ft: _freeTransfers, hit: _allowExtraHit, bank: _budget, squad: store.getSquad(),
    teamOf: id => store.getPlayer(id)?.teamId ?? null,
    nameOf: id => store.getPlayer(id)?.name ?? '?',
    teamName: t => store.getTeam(t)?.name ?? 'one club',
  });
}

function moveLabel(m) {
  return `${store.getPlayer(m.outId)?.name ?? '?'} → ${store.getPlayer(m.inId)?.name ?? '?'}`;
}

function addMove(swap, gw, fromEl) {
  const flip = measureMoves(fromEl);
  const m = moveFrom(swap, gw);
  _moves = [..._moves, m];
  renderRunAndTray();
  playFlip(flip);
  toast(`${moveLabel(m)} in GW${gw}`);
}

function removeMove(m) {
  const flip = measureMoves();
  const prev = _moves;
  _moves = _moves.filter(x => x !== m);
  renderRunAndTray();
  playFlip(flip);
  toast(`Removed ${moveLabel(m)}`, () => {
    const f = measureMoves();
    _moves = prev;
    renderRunAndTray();
    playFlip(f);
  });
}

function shiftMove(m, d) {
  const gws = runGws();
  const gw = m.gw + d;
  if (!gws.includes(gw)) return;
  const flip = measureMoves();
  _moves = _moves.map(x => (x === m ? { ...x, gw } : x));
  renderRunAndTray();
  playFlip(flip);
}

function shiftChip(id, d) {
  const gws = runGws();
  const cur = effectiveChips(gws)[id];
  if (cur == null || !gws.includes(cur + d)) return;
  _chipsAt = { ..._chipsAt, [id]: cur + d };
  renderRunAndTray();
}

function clearRun() {
  const prev = { moves: _moves, chipsAt: _chipsAt };
  _moves = [];
  _chipsAt = {};
  renderRunAndTray();
  toast('Run cleared', () => { _moves = prev.moves; _chipsAt = prev.chipsAt; renderRunAndTray(); });
}

// ─── Render: verdict hero ────────────────────────────────────────────────────

function chipHTML(value, band, est, cls = '') {
  return `<span class="chip${cls}${est ? ' is-est' : ''}" data-band="${esc(band)}" title="${value} ${BAND_LABEL[band] ?? ''}${est ? ' · estimated' : ''}">${value}</span>`;
}

function pendingChip(cls = '') {
  return `<span class="chip${cls} is-pending" aria-hidden="true" title="Still calculating — waiting on league-wide counter-matchup data">00</span>`;
}

function crestHTML(team) {
  return team?.badgeUrl
    ? `<img class="crest" src="${esc(team.badgeUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : '';
}

function watermark(team) {
  if (!team?.badgeUrl) return '';
  const svg = String(team.badgeUrl).replace('/badges/70/', '/badges/').replace(/\.png$/, '.svg');
  return `<span class="mark" aria-hidden="true" style="background-image:url('${esc(svg)}')"></span>`;
}

function money(v) {
  return `${v < 0 ? '−' : ''}£${Math.abs(v).toFixed(1)}m`;
}

function signedMoney(v) {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}£${Math.abs(v).toFixed(1)}m`;
}

function pts(v) {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
}

function importFormHTML() {
  return `<form class="imp" data-imp-form>
      <label class="sr" for="pl-hero-imp">FPL Team ID</label>
      <input id="pl-hero-imp" type="text" inputmode="numeric" autocomplete="off" placeholder="FPL Team ID" aria-describedby="pl-hero-imp-st">
      <button type="submit" class="cta">Import</button>
    </form>
    <p class="imp-st" id="pl-hero-imp-st" role="status">Your Team ID is the number in your FPL points-page URL.</p>`;
}

function heroHTML() {
  const squad = store.getSquad();
  if (!_dataReady) {
    return '<div class="ld" aria-busy="true"><span class="sk"></span><span class="sk"></span><span class="sk"></span><p role="status">Loading FPL data…</p></div>';
  }
  if (squad.length === 0) {
    return '<div class="empty">'
      + `<span class="lbl">Nothing planned yet · 0 / ${SQUAD_TOTAL} players</span>`
      + '<h1>Add 15 players<br>to get a verdict</h1>'
      + importFormHTML()
      + '<button type="button" class="link" data-open-squad>Or build it player by player →</button></div>';
  }
  if (_boardState === 'short') {
    return '<div class="empty" role="status">'
      + '<h2>Add 15 players to get a verdict</h2>'
      + `<p class="muted">${squad.length} / ${SQUAD_TOTAL} players in your squad. The run below keeps any moves you’ve staged.</p>`
      + '<button type="button" class="btn" data-open-squad>Open squad</button></div>';
  }
  if (_boardState === 'settling') {
    return '<div class="ld" aria-busy="true"><span class="sk"></span><span class="sk"></span><span class="sk"></span>'
      + '<p role="status">Counter-matchup data is still settling — the verdict, the move tray and chip weeks are held back.</p></div>';
  }
  if (_boardState === 'unscored') {
    return '<div class="empty" role="status"><h2>No verdict this week</h2>'
      + '<p class="muted">Some of your squad could not be scored this week, so no honest verdict can be built — this is not '
      + 'the same as “no legal transfers”. Check the console for which player failed and try again once data has finished loading.</p></div>';
  }
  if (_boardState === 'noctx' || !_verdict) {
    return '<div class="empty" role="status"><h2>No data available yet</h2></div>';
  }

  const v = _verdict;
  const timing = getPlanningTiming();
  const conf = CONFIDENCE_LABELS[v.confidence] ?? v.confidence;
  const listedTriggers = v.triggers.filter(t => t.id !== v.promotedBy);
  const kicker = `<div class="kicker lbl"><span>Verdict · ${esc(conf)}</span>`
    + (v.lane === 'roll' ? '' : `<span>lane score <b class="${v.estimated ? 'is-est' : ''}" data-count="${Math.round(v.laneScore)}">${Math.round(v.laneScore)}</b></span>`)
    + (v.promotedBy ? '<span title="Promoted ahead of the arithmetic leader by a hard trigger">promoted</span>'
      : v.lane === 'roll' ? '' : `<span>+${Math.round(v.margin)} clear</span>`)
    + '</div>';
  const note = timingNote(timing);
  const tail = `<p class="reason">${esc(v.reasoning)}</p>`
    + (LANE_DIRECTIONS[v.lane] ? `<p class="direction">${esc(LANE_DIRECTIONS[v.lane])}</p>` : '')
    + (v.alternatives.length ? `<p class="alts">Close behind: ${v.alternatives.map(a => `${esc(a.label)} (${a.score.toFixed(0)})`).join(', ')}</p>` : '')
    + (listedTriggers.length ? `<div class="triggers">${listedTriggers.map(t => `<span><span class="warn" aria-hidden="true">⚠ </span>${esc(t.message)}</span>`).join('')}</div>` : '');

  const sw = v.bestSwap;
  if (v.lane === 'roll' || !sw) {
    return `<div class="tape-wrap">${kicker}${note ? `<p class="timing">${esc(note)}</p>` : ''}`
      + `<div class="roll"><span class="lbl">${esc(laneLabel(v.lane))}</span><h2>Roll the transfer</h2></div>${tail}</div>`;
  }

  const gw = runGws()[0];
  const O = sw.outPlayer, I = sw.inPlayer;
  const oTeam = store.getTeam(O.teamId), iTeam = store.getTeam(I.teamId);
  const oScore = Math.round(sw.outScore?.value ?? 0), iScore = Math.round(sw.inScore?.value ?? 0);
  const oBand = sw.outScore?.band ?? 'neutral', iBand = sw.inScore?.band ?? 'neutral';
  const iEst = isScoreEstimated(sw.inScore);
  const lane = sw.lanes[v.lane];
  const board = LANE_BOARDS.find(b => b.id === v.lane);
  const placed = _moves.find(m => m.outId === sw.outId && m.inId === sw.inId);
  return `<div class="tape-wrap">${kicker}${note ? `<p class="timing">${esc(note)}</p>` : ''}`
    + '<div class="tape">'
    + `<article class="side side--out" data-band="${esc(oBand)}" aria-label="Out: ${esc(O.name)}, ${oScore} ${BAND_LABEL[oBand] ?? ''}">${watermark(oTeam)}`
    + `<div class="side__info"><span class="lbl">Out · ${esc(oTeam?.name ?? '')} · ${money(O.price)}</span>`
    + `<h2 class="side__name">${esc(O.name)}</h2>`
    + (O.status !== 'available' ? `<span class="side__flag">⚠ ${esc(O.statusNote || O.status)}</span>` : '')
    + `</div><div class="side__num"><b data-count="${oScore}">${oScore}</b><span class="side__band">${BAND_LABEL[oBand] ?? ''}</span></div></article>`
    + `<div class="tape__mid"><span class="lbl">${esc(laneLabel(v.lane))}</span><span aria-hidden="true">→</span><span>GW${gw}</span></div>`
    + `<article class="side side--in" data-band="${esc(iBand)}" aria-label="In: ${esc(I.name)}, ${iScore} ${BAND_LABEL[iBand] ?? ''}" data-tape-in>${watermark(iTeam)}`
    + `<div class="side__num"><b data-count="${iScore}">${iScore}</b><span class="side__band">${BAND_LABEL[iBand] ?? ''}${iEst ? ' · est.' : ''}</span></div>`
    + `<div class="side__info"><span class="lbl">In · ${esc(iTeam?.name ?? '')} · ${money(I.price)} · ${signedMoney(sw.priceDiff)}</span>`
    + `<h2 class="side__name">${esc(I.name)}</h2>`
    + (lane ? `<span class="edge">${esc(board ? board.format(lane.value) : lane.value.toFixed(1))} ${esc(EDGE_UNIT[v.lane] ?? '')}</span>` : '')
    + '</div></article></div>'
    + tail
    + `<div class="tape-cta"><button type="button" class="cta" data-top-swap aria-pressed="${Boolean(placed)}">${placed ? `In GW${placed.gw} ✓` : `Put it in GW${gw}`}</button></div>`
    + '</div>';
}

function renderHero(animate) {
  if (!_hero) return;
  _hero.removeAttribute('data-anim');
  _hero.innerHTML = heroHTML();
  const hasTape = Boolean(_hero.querySelector('.tape, .empty'));
  if ((animate || (!_heroShown && hasTape)) && !reducedMotion()) {
    void _hero.offsetWidth;
    _hero.setAttribute('data-anim', '');
    countUp(_hero.querySelectorAll('[data-count]'));
  }
  if (_hero.querySelector('.tape')) _heroShown = true;
}

/** Numerals count up from zero, eased, staggered. */
function countUp(els) {
  if (reducedMotion()) return;
  [...els].forEach((el, i) => {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to)) return;
    const t0 = performance.now() + 140 + i * 60;
    el.textContent = '0';
    const tick = now => {
      if (!el.isConnected) return;
      const p = Math.min(1, Math.max(0, (now - t0) / 900));
      el.textContent = String(Math.round(to * (1 - (1 - p) ** 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ─── Render: run settings ────────────────────────────────────────────────────

function renderCmd() {
  if (!_root) return;
  const gws = runGws();
  _root.querySelector('#pl-run-range').textContent = gws.length ? `GW${gws[0]}–${gws[gws.length - 1]}` : '';
  const bank = _root.querySelector('#pl-bank');
  if (document.activeElement !== bank) bank.value = _budget.toFixed(1);
  _root.querySelector('#pl-ft-grp').setAttribute('aria-label', `Free transfers going into GW${gws[0] ?? ''}`);
  _root.querySelectorAll('[data-ft]').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.ft) === _freeTransfers)));
  const hit = _root.querySelector('#pl-hit');
  hit.setAttribute('aria-pressed', String(_allowExtraHit));
  hit.textContent = _allowExtraHit ? '−4 hits allowed' : 'Hits off';
  _root.querySelector('#pl-squad-btn').textContent = `Squad ${store.getSquad().length}/${SQUAD_TOTAL}`;
  const dirty = isDirty();
  const st = _root.querySelector('#pl-save-st');
  st.textContent = dirty ? 'Unsaved changes' : 'Saved';
  st.classList.toggle('is-dirty', dirty);
  _root.querySelector('#pl-save').disabled = !dirty;
}

// ─── Render: the run ─────────────────────────────────────────────────────────

function weekHTML(w, ev, gws, i) {
  const target = w.gw === _target;
  const bad = w.problems.length > 0;
  const remaining = Math.max(0, w.ftAvail - Math.min(w.used, w.ftAvail));
  const dots = Array.from({ length: Math.max(w.ftAvail, 1) }, (_, k) => `<i class="${k < remaining ? 'is-on' : ''}"></i>`).join('');
  const first = gws[0], last = gws[gws.length - 1];
  const chips = w.chips.map(id => `<span class="ctag${w.chips.length > 1 ? ' is-clash' : ''}">${esc(CHIP_LABELS[id])}`
    + `<button type="button" class="icon" data-chip-shift="${id}" data-d="-1" ${w.gw === first ? 'disabled' : ''} aria-label="Move ${esc(CHIP_LABELS[id])} to GW${w.gw - 1}">‹</button>`
    + `<button type="button" class="icon" data-chip-shift="${id}" data-d="1" ${w.gw === last ? 'disabled' : ''} aria-label="Move ${esc(CHIP_LABELS[id])} to GW${w.gw + 1}">›</button>`
    + `<button type="button" class="icon icon--rm" data-chip-out="${id}" aria-label="Take ${esc(CHIP_LABELS[id])} out of the run">×</button></span>`).join('');
  const moves = w.moves.map(m => {
    const o = store.getPlayer(m.outId)?.name ?? '?', n = store.getPlayer(m.inId)?.name ?? '?';
    return `<li class="mv${ev.badMoves.has(m.id) ? ' is-bad' : ''}" data-mid="${m.id}">`
      + `<span class="mv__names"><span class="ell">${esc(o)} →</span><span><span class="ell">${esc(n)}</span>${chipHTML(m.inValue, m.inBand, m.inEst, ' chip--sm')}</span></span>`
      + `<span class="mv__meta"><span>${signedMoney(m.priceDiff)} · ${pts(m.gain)}</span>`
      + `<button type="button" class="icon" data-move-shift="${m.id}" data-d="-1" ${m.gw === first ? 'disabled' : ''} aria-label="Move ${esc(o)} to ${esc(n)} to GW${m.gw - 1}">‹</button>`
      + `<button type="button" class="icon" data-move-shift="${m.id}" data-d="1" ${m.gw === last ? 'disabled' : ''} aria-label="Move ${esc(o)} to ${esc(n)} to GW${m.gw + 1}">›</button>`
      + `<button type="button" class="icon icon--rm" data-move-rm="${m.id}" aria-label="Remove ${esc(o)} to ${esc(n)}">×</button></span></li>`;
  }).join('');
  const empty = w.unlimited ? 'Chip week — unlimited transfers'
    : w.ftAvail >= 2 ? `Rolling — ${Math.min(5, w.ftAvail + 1)} free next week` : 'Roll the transfer';
  const aria = `GW${w.gw}: ${w.moves.length} move${w.moves.length === 1 ? '' : 's'}`
    + (w.chips.length ? `, ${w.chips.map(c => CHIP_LABELS[c]).join(', ')}` : '') + (bad ? ', has problems' : '');
  return `<div class="wk${target ? ' is-target' : ''}${bad ? ' is-bad' : ''}" role="listitem" data-wk="${w.gw}" aria-label="${esc(aria)}" style="--d:${200 + i * 55}ms">`
    + `<button type="button" class="wk__hd" data-target="${w.gw}" aria-pressed="${target}">`
    + `<span class="wk__gw">GW${w.gw}</span>`
    + `<span class="wk__ft"><span class="dots" aria-label="${w.ftAvail} free transfers, ${w.used} used">${dots}</span>`
    + `<small>${w.unlimited ? 'Unlimited — chip week' : `${w.ftAvail} free · ${w.used} used`}</small></span>`
    + `<span class="wk__tg">${target ? 'Adding here' : 'Select week'}</span></button>`
    + `<div class="wk__chips">${chips}</div>`
    + `<ol class="wk__moves">${moves || `<li class="wk__empty">${empty}</li>`}</ol>`
    + '<div class="wk__ft2">'
    + `<span><span class="muted">Gain / hits</span><span><b>${pts(w.gain)}</b> <span class="is-hit">${w.hitCost ? `−${w.hitCost}` : ''}</span></span></span>`
    + `<span><span class="muted">Bank after</span><b class="${w.bank < 0 ? 'is-neg' : ''}">${money(w.bank)}</b></span>`
    + w.problems.map(p => `<span class="wk__prob"><span aria-hidden="true">⚠ </span>${esc(p)}</span>`).join('')
    + '</div></div>';
}

function renderRun() {
  if (!_runWrap) return;
  const gws = runGws();
  if (_target == null || !gws.includes(_target)) _target = gws[0];
  refreshMoves();
  const ev = evaluate();

  _root.querySelector('#pl-totals').innerHTML =
    `<span><span class="lbl lbl--sm">Gain </span><b>${pts(ev.gain)}</b></span>`
    + `<span><span class="lbl lbl--sm">Hits </span><b class="${ev.hitCost ? 'is-hit' : ''}">${ev.hitCost ? `−${ev.hitCost}` : '0'}</b></span>`
    + `<span><span class="lbl lbl--sm">Net </span><b>${pts(ev.net)}</b></span>`;

  _weeks.innerHTML = ev.weeks.map((w, i) => weekHTML(w, ev, gws, i)).join('');
  if (!_weeksShown && !reducedMotion()) {
    _weeks.setAttribute('data-anim', '');
    _weeksShown = true;
  } else {
    _weeks.removeAttribute('data-anim');
  }

  // Issues that belong to no one week: the run as a whole, and moves the
  // boards no longer carry.
  const map = swapMap();
  const offBoard = _boardState === 'ready'
    ? _moves.filter(m => gws.includes(m.gw) && !map.has(`${m.outId}-${m.inId}`))
    : [];
  const stale = _moves.filter(m => m.gw < gws[0]);
  const list = ev.issues.filter(x => x.lvl === 'error').map(x => ({ e: true, text: x.text }))
    .concat(ev.issues.filter(x => x.lvl === 'warn').map(x => ({ e: false, text: x.text })))
    .concat(offBoard.map(m => ({ e: false, text: `${moveLabel(m)} isn’t on the boards any more — its figures are from when you added it.` })))
    .concat(stale.length ? [{ e: false, text: `${stale.length} move${stale.length === 1 ? ' is' : 's are'} for gameweeks that have passed — clear the run to drop ${stale.length === 1 ? 'it' : 'them'}.` }] : []);
  const issues = _root.querySelector('#pl-issues');
  issues.hidden = list.length === 0;
  issues.classList.toggle('is-error', list.some(x => x.e));
  issues.innerHTML = list.map(x => `<span><span class="${x.e ? 'e' : 'w'}" aria-hidden="true">${x.e ? '⚠' : '!'} </span>`
    + `<span class="sr">${x.e ? 'Problem' : 'Note'}: </span>${esc(x.text)}</span>`).join('');

  // Chips that aren't placed in any week of this run.
  const at = effectiveChips(gws);
  const settled = _dataReady && store.isTeamXgSettled();
  const unplaced = CHIP_IDS.filter(id => at[id] == null);
  const up = _root.querySelector('#pl-unplaced');
  up.hidden = unplaced.length === 0;
  up.innerHTML = '<span class="lbl lbl--sm">Chips not in this run</span>' + unplaced.map(id => {
    const used = _chipsUsed.has(id);
    const rec = _chipRecs[id];
    const recText = used ? 'used' : !settled ? 'week pending'
      : rec?.gw != null ? `best GW${rec.gw}${gws.includes(rec.gw) ? '' : ' · outside this run'}` : 'no week to recommend';
    return `<span class="cpill${used ? ' is-used' : ''}" title="${esc(rec?.reasoning ?? '')}"><b>${esc(CHIP_LABELS[id])}</b><span>${esc(recText)}</span>`
      + (used ? '' : `<button type="button" data-chip-place="${id}">Place in GW${_target}</button>`)
      + `<button type="button" data-chip-used="${id}" aria-pressed="${used}">${used ? 'Used ✓' : 'Mark used'}</button></span>`;
  }).join('');

  _root.querySelector('#pl-clear').hidden = _moves.length === 0 && Object.keys(_chipsAt).length === 0;
  renderCmd();
}

// ─── Render: move tray ───────────────────────────────────────────────────────

function renderTray(animate = false) {
  if (!_tray) return;
  const board = LANE_BOARDS.find(b => b.id === _lens) ?? LANE_BOARDS[1];
  _root.querySelector('#pl-tray-t').textContent = `Add to GW${_target ?? ''}`;
  _root.querySelector('#pl-lens').innerHTML = LANE_BOARDS.map(b =>
    `<button type="button" role="radio" data-lens="${b.id}" aria-checked="${b.id === board.id}" title="${esc(b.blurb)}">${esc(b.title)}</button>`).join('');
  _root.querySelector('#pl-unit').textContent = `Number = ${board.unit}`;

  let body;
  if (_boardState === 'short') body = `<p class="tray__empty">Add ${SQUAD_TOTAL} players to see moves.</p>`;
  else if (_boardState === 'settling' || !_dataReady) body = '<div class="cards cards--sk" aria-busy="true"><span class="sk"></span><span class="sk"></span><span class="sk"></span></div>';
  else if (_boardState === 'unscored') body = '<p class="tray__empty">No moves — some of your squad could not be scored. See the note above.</p>';
  else if (_boardState === 'noctx') body = '<p class="tray__empty">No data available yet.</p>';
  else {
    // An empty lens says so plainly. Padding it with the next-best generic
    // swap would be exactly the tunnel vision the lenses exist to remove.
    const ranked = _swaps
      .filter(s => s.lanes[board.id] && s.lanes[board.id].value > 0)
      .sort((a, b) => b.lanes[board.id].value - a.lanes[board.id].value)
      .slice(0, TRAY_N);
    body = `<p class="tray__blurb">${esc(board.blurb)}</p>`;
    body += ranked.length === 0
      ? `<p class="tray__empty">${esc(emptyMessage(board.id, _swaps))}</p>`
      : `<ul class="cards">${ranked.map((s, i) => {
        const lane = s.lanes[board.id];
        const key = swapKey(s);
        const placed = _moves.find(m => `${m.outId}-${m.inId}` === key);
        const flagged = s.flags?.outUnavailable;
        const note = priceChangeNote(s.inPlayer, s.inScore);
        return `<li class="card${placed ? ' is-placed' : ''}" data-sw="${esc(key)}" style="--d:${Math.min(i, 10) * 30}ms">`
          + `<span class="card__top"><span><span class="muted">${esc(s.outPlayer.name)} →</span> <b>${esc(s.inPlayer.name)}</b></span>`
          + `<span class="card__val${lane.estimated ? ' is-est' : ''}" title="${lane.estimated ? 'Some inputs behind this number are estimated' : esc(board.unit)}">${esc(board.format(lane.value))}</span></span>`
          + `<span class="card__why">${esc(lane.reasoning)}</span>`
          + (note ? `<span class="card__why" title="${esc(calcPriceChangeRisk(s.inPlayer).reasoning ?? '')}">${esc(note)}</span>` : '')
          + `<span class="card__ft"><span>${signedMoney(s.priceDiff)}${flagged ? ' · sells a flagged player' : ''}${s.flags?.inEntersXi ? ' · straight into your XI' : ''}</span>`
          + `<button type="button" class="tog" data-add="${esc(key)}" aria-pressed="${Boolean(placed)}"`
          + ` aria-label="${placed ? `Remove ${esc(s.outPlayer.name)} to ${esc(s.inPlayer.name)} from GW${placed.gw}` : `Add ${esc(s.outPlayer.name)} to ${esc(s.inPlayer.name)} to GW${_target}`}">`
          + `${placed ? `In GW${placed.gw} ✓` : `Add to GW${_target}`}</button></span></li>`;
      }).join('')}</ul>`;
  }
  _tray.removeAttribute('data-anim');
  _tray.innerHTML = body;
  if (animate && !reducedMotion()) { void _tray.offsetWidth; _tray.setAttribute('data-anim', ''); }
}

function renderRunAndTray() {
  renderRun();
  renderTray();
  // The tape's "Put it in GW" button mirrors whether its move is staged.
  const btn = _hero?.querySelector('[data-top-swap]');
  const sw = _verdict?.bestSwap;
  if (btn && sw) {
    const placed = _moves.find(m => m.outId === sw.outId && m.inId === sw.inId);
    btn.setAttribute('aria-pressed', String(Boolean(placed)));
    btn.textContent = placed ? `In GW${placed.gw} ✓` : `Put it in GW${runGws()[0]}`;
  }
}

// ─── Render: squad drawer ────────────────────────────────────────────────────

/**
 * Where the team the user actually SET differs from the team the model would
 * pick. Returns empty sets when no import has happened — a hand-built squad has
 * no saved order to disagree with, and inventing one would be a lie.
 *
 * A saved-XI player id that is no longer in the squad (replaceSquad() can drop
 * an imported player that exceeds SQUAD_LIMITS while the picks are stored
 * unconditionally) simply never matches a rendered player: it still lands in
 * `started` by set arithmetic, but renderDrawer() only ever tests
 * diff.started.has(player.id) against players it is actually rendering — i.e.
 * players still in the squad — so a phantom id produces no marker, no crash,
 * and does not double-count against a real player.
 *
 * @returns {{ benched: Set<number>, started: Set<number>, captainId: number|null,
 *             modelCaptainId: number|null }}
 *   benched: model starts them, the user has them on the bench
 *   started: the user starts them, the model would bench them
 */
function calcSavedXiDiff() {
  const savedXi = store.getSavedXi();
  if (savedXi.length === 0) {
    return { benched: new Set(), started: new Set(), captainId: null, modelCaptainId: null };
  }

  const scoredSquad = store.getSquad()
    .map(id => ({ player: store.getPlayer(id), score: _scores.get(id) }))
    .filter(e => e.player && e.score);
  const projectedIds = new Set(pickStartingXI(scoredSquad).xi.map(e => e.player.id));
  const savedSet = new Set(savedXi);

  const benched = new Set([...projectedIds].filter(id => !savedSet.has(id)));
  const started = new Set([...savedSet].filter(id => !projectedIds.has(id)));

  const captainId = store.getSquadPicks().find(p => p.isCaptain)?.playerId ?? null;
  let modelCaptainId = null;
  let bestEp = -Infinity;
  for (const id of projectedIds) {
    const ep = _scores.get(id)?.expectedPoints?.value ?? -Infinity;
    if (ep > bestEp) { bestEp = ep; modelCaptainId = id; }
  }

  return { benched, started, captainId, modelCaptainId };
}

function renderSearch() {
  if (!_root) return;
  const note = _root.querySelector('#pl-search-n');
  const list = _root.querySelector('#pl-results');
  const query = _q.trim().toLowerCase();
  _root.querySelector('#pl-add-grp').hidden = store.getSquad().length >= SQUAD_TOTAL;
  if (query.length < 2) { note.textContent = 'Type two letters to search.'; list.innerHTML = ''; return; }
  const allPlayers = store.getPlayers();
  if (!allPlayers.length) { note.textContent = 'Player data not yet loaded — please wait.'; list.innerHTML = ''; return; }

  const results = allPlayers.filter(p => {
    if (isInSquad(p.id)) return false;
    const name     = (p.name     ?? '').toLowerCase();
    const fullName = (p.fullName ?? '').toLowerCase();
    const club     = (store.getTeam(p.teamId)?.name ?? '').toLowerCase();
    return name.includes(query) || fullName.includes(query) || club.includes(query);
  }).slice(0, 12);

  note.textContent = results.length ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'No player matches.';
  list.innerHTML = results.map(p => {
    const team = store.getTeam(p.teamId);
    const posSlotsFull = squadCountByPos(p.position) >= SQUAD_LIMITS[p.position];
    const squadFull    = store.getSquad().length >= SQUAD_TOTAL;
    const reason       = squadFull ? 'Squad full' : posSlotsFull ? `${POS_FULL[p.position]} full` : '';
    return `<li><button type="button" data-add-player="${p.id}" ${reason ? 'disabled' : ''} title="${esc(reason || p.fullName || p.name || '')}">`
      + `<span>${crestHTML(team)}<span><b>${esc(p.name ?? '?')}</b> <small>${esc(p.position)} · ${esc(team?.name ?? '—')} · ${money(p.price ?? 0)}</small></span></span>`
      + `<span>${esc(reason || 'Add')}</span></button></li>`;
  }).join('');
}

function renderDrawer() {
  if (!_root || !_drawerOpen) return;
  const squad = store.getSquad();
  _root.querySelector('#pl-sq-count').textContent = `${squad.length} / ${SQUAD_TOTAL} players`;
  renderSearch();
  const diff = calcSavedXiDiff();
  const settled = store.isTeamXgSettled();
  _root.querySelector('#pl-squad').innerHTML = Object.entries(SQUAD_LIMITS).map(([pos, max]) => {
    const players = squad.map(id => store.getPlayer(id)).filter(p => p?.position === pos);
    return `<div class="sq-grp"><span class="lbl">${POS_FULL[pos]} · ${players.length} / ${max}</span>`
      + players.map(p => {
        const team = store.getTeam(p.teamId);
        const score = _scores.get(p.id);
        const chip = !score ? '<span></span>' : settled ? chipHTML(Math.round(score.value), score.band, isScoreEstimated(score)) : pendingChip();
        const tags = (diff.benched.has(p.id) ? '<span class="diff" title="The model would start him — you have him on your bench">bench</span>' : '')
          + (diff.started.has(p.id) ? '<span class="diff" title="You are starting him — the model would bench him">start</span>' : '')
          + (diff.captainId === p.id && diff.modelCaptainId !== p.id ? '<span class="diff" title="Your armband is here; the model prefers another player">C</span>' : '');
        return `<div class="sq"><span>${crestHTML(team)}<span><b>${esc(p.name)}</b> <small>${esc(team?.shortName ?? '—')} · ${money(p.price ?? 0)}</small>${tags}`
          + `${p.status !== 'available' ? ` <small class="warn">⚠ ${esc(p.statusNote || p.status)}</small>` : ''}</span></span>`
          + `${chip}<button type="button" class="icon icon--rm" data-rm-player="${p.id}" aria-label="Remove ${esc(p.name)} from squad">×</button></div>`;
      }).join('') + '</div>';
  }).join('');
}

function openDrawer() {
  _drawerOpen = true;
  _scrim.hidden = false;
  _drawer.hidden = false;
  renderDrawer();
  _drawer.querySelector('[data-close-squad]').focus();
}

function closeDrawer() {
  if (!_drawerOpen) return;
  _drawerOpen = false;
  _scrim.hidden = true;
  _drawer.hidden = true;
  (_root.querySelector('#pl-squad-btn').offsetParent ? _root.querySelector('#pl-squad-btn') : _hero.querySelector('[data-open-squad]'))?.focus();
}

// ─── Toast + confirm dialog ──────────────────────────────────────────────────

function toast(msg, undo = null) {
  clearTimeout(_toastTimer);
  _undo = undo;
  const el = _root?.querySelector('#pl-toast');
  if (!el) return;
  el.innerHTML = `<div>${esc(msg)}${undo ? '<button type="button" data-undo>Undo</button>' : ''}</div>`;
  _toastTimer = setTimeout(() => { el.innerHTML = ''; _undo = null; }, undo ? 6000 : 2800);
}

function ask(dialog, from) {
  _dialog = dialog;
  _dialogReturn = from ?? null;
  const d = _root.querySelector('#pl-dlg');
  d.querySelector('#pl-dlg-t').textContent = dialog.title;
  d.querySelector('#pl-dlg-b').textContent = dialog.body;
  d.querySelector('[data-dlg-ok]').textContent = dialog.ok;
  _root.querySelector('#pl-dlg-scrim').hidden = false;
  d.hidden = false;
  d.querySelector('[data-dlg-cancel]').focus();
}

function closeDialog(confirm) {
  const dlg = _dialog;
  _dialog = null;
  _root.querySelector('#pl-dlg').hidden = true;
  _root.querySelector('#pl-dlg-scrim').hidden = true;
  if (confirm) dlg?.run();
  if (_dialogReturn && document.contains(_dialogReturn)) _dialogReturn.focus();
}

// ─── Motion ──────────────────────────────────────────────────────────────────

/** Move card positions before a change; `fromEl` is where a new move came from. */
function measureMoves(fromEl = null) {
  if (reducedMotion() || !_weeks) return null;
  const rects = new Map();
  _weeks.querySelectorAll('[data-mid]').forEach(el => rects.set(el.dataset.mid, el.getBoundingClientRect()));
  return { rects, from: fromEl?.getBoundingClientRect() ?? null };
}

/** FLIP: kept moves glide to their new week; a new move flies in from where it was picked. */
function playFlip(fl) {
  if (!fl) return;
  _weeks.querySelectorAll('[data-mid]').forEach(el => {
    const o = fl.rects.get(el.dataset.mid);
    const r = el.getBoundingClientRect();
    if (o) {
      const dx = o.left - r.left, dy = o.top - r.top;
      if (Math.abs(dx) + Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 440, easing: EASE });
    } else if (fl.from) {
      const dx = fl.from.left - r.left, dy = fl.from.top - r.top;
      el.animate([{ transform: `translate(${dx}px,${dy}px)`, opacity: 0.25 }, { transform: 'none', opacity: 1 }], { duration: 560, easing: EASE });
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    }
  });
}

// ─── Full render ─────────────────────────────────────────────────────────────

function render(animate = false) {
  if (!_root) return;
  renderHero(animate);
  // An empty squad with nothing staged has no run to show — the hero's
  // import form is the whole page then.
  const showRun = _dataReady && (store.getSquad().length > 0 || _moves.length > 0);
  _runWrap.hidden = !showRun;
  if (showRun) {
    renderRun();
    renderTray(animate);
  }
  renderDrawer();
}

/** Score, time the chips, enumerate, then paint — in that order (see _chipRecs). */
function recomputeAndRender(rescore = true, animate = false) {
  scoreSquad();
  computeChipRecs();
  computeBoards(rescore);
  render(animate);
}

// ─── After squad change ───────────────────────────────────────────────────────

function afterSquadChange() {
  // Cheap bookkeeping stays unconditional — both Dashboard and Planner call
  // store.setSquad(), so this fires whichever module made the edit.
  _q = '';
  const search = _root?.querySelector('#pl-search');
  if (search) search.value = '';

  // Invalidate always, recompute lazily (CONVENTIONS.md §8), same split as
  // onDataReady: a squad edit made on the Dashboard while the Planner is
  // hidden must not pay for scoreSquad()'s rank computation or an uncached
  // enumerateSwaps() over ~626 players just to write into DOM nobody sees.
  // onRouteChanged flushes this once the Planner is actually shown.
  if (store.getActiveModule() !== 'planner') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  recomputeAndRender(true);
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onBankChange(value) {
  const val = parseFloat(value);
  _budget = isNaN(val) || val < 0 ? 0 : Math.round(val * 10) / 10;
  // No re-score: budget only changes which already-scored candidates are
  // affordable, so the cached candidate scores are reused (see computeBoards).
  computeBoards(false);
  renderHero(false);
  renderRunAndTray();
}

function onClick(e) {
  const t = e.target;
  const hit = sel => t.closest(sel);
  let el;
  if (hit('[data-undo]')) {
    const u = _undo;
    _undo = null;
    _root.querySelector('#pl-toast').innerHTML = '';
    u?.();
    return;
  }
  if (hit('[data-dlg-cancel]') || t.id === 'pl-dlg-scrim') return closeDialog(false);
  if (hit('[data-dlg-ok]')) return closeDialog(true);
  if (hit('[data-open-squad]') || hit('#pl-squad-btn')) return openDrawer();
  if (hit('[data-close-squad]') || t === _scrim) return closeDrawer();
  if ((el = hit('[data-bank]'))) return onBankChange(_budget + Number(el.dataset.bank) * 0.1);
  if ((el = hit('[data-ft]'))) {
    _freeTransfers = Number(el.dataset.ft) === 2 ? 2 : 1;
    computeBoards(false);
    renderHero(false);
    return renderRunAndTray();
  }
  if (hit('#pl-hit')) {
    _allowExtraHit = !_allowExtraHit;
    return renderRunAndTray();
  }
  if (hit('#pl-save')) return saveRun();
  if (hit('#pl-clear')) {
    return ask({ title: 'Clear the whole run?',
      body: `All ${_moves.length} move${_moves.length === 1 ? '' : 's'} are removed, and chips go back to their recommended weeks. Your saved run is kept until you save again.`,
      ok: 'Clear run', run: clearRun }, hit('#pl-clear'));
  }
  if ((el = hit('[data-target]'))) { _target = Number(el.dataset.target); return renderRunAndTray(); }
  if ((el = hit('[data-move-rm]'))) { const m = _moves.find(x => x.id === el.dataset.moveRm); return m && removeMove(m); }
  if ((el = hit('[data-move-shift]'))) { const m = _moves.find(x => x.id === el.dataset.moveShift); return m && shiftMove(m, Number(el.dataset.d)); }
  if ((el = hit('[data-chip-shift]'))) return shiftChip(el.dataset.chipShift, Number(el.dataset.d));
  if ((el = hit('[data-chip-out]'))) { _chipsAt = { ..._chipsAt, [el.dataset.chipOut]: null }; return renderRunAndTray(); }
  if ((el = hit('[data-chip-place]'))) {
    const id = el.dataset.chipPlace;
    _chipsAt = { ..._chipsAt, [id]: _target };
    renderRunAndTray();
    return toast(`${CHIP_LABELS[id]} in GW${_target}`);
  }
  if ((el = hit('[data-chip-used]'))) {
    const id = el.dataset.chipUsed;
    if (!CHIP_IDS.includes(id)) return;
    if (_chipsUsed.has(id)) _chipsUsed.delete(id);
    else                    _chipsUsed.add(id);
    saveChipsUsed();
    return renderRunAndTray();
  }
  if ((el = hit('[data-lens]'))) { _lens = el.dataset.lens; return renderTray(true); }
  if ((el = hit('[data-add]'))) {
    const key = el.dataset.add;
    const placed = _moves.find(m => `${m.outId}-${m.inId}` === key);
    if (placed) return removeMove(placed);
    const s = swapMap().get(key);
    return s && addMove(s, _target, el.closest('[data-sw]'));
  }
  if (hit('[data-top-swap]')) {
    const sw = _verdict?.bestSwap;
    if (!sw) return;
    const placed = _moves.find(m => m.outId === sw.outId && m.inId === sw.inId);
    return placed ? removeMove(placed) : addMove(sw, runGws()[0], hit('[data-top-swap]').closest('.tape-wrap')?.querySelector('[data-tape-in]'));
  }
  if ((el = hit('[data-add-player]'))) { addPlayer(Number(el.dataset.addPlayer)); return; }
  if ((el = hit('[data-rm-player]'))) {
    const p = store.getPlayer(Number(el.dataset.rmPlayer));
    if (!p) return;
    return ask({ title: `Remove ${p.name}?`, body: `${p.name} leaves your squad, and any moves selling him leave the run.`, ok: 'Remove',
      run: () => {
        _moves = _moves.filter(m => m.outId !== p.id);
        removePlayer(p.id);
        toast(`${p.name} removed`);
      } }, el);
  }
}

function onSubmit(e) {
  const form = e.target.closest('#pl-imp-form, [data-imp-form]');
  if (!form) return;
  e.preventDefault();
  if (form.id === 'pl-imp-form') {
    _importIdInput = _root.querySelector('#pl-imp-id');
    _importStatus  = _root.querySelector('#pl-imp-st');
    _importInfo    = _root.querySelector('#pl-imp-info');
  } else {
    _importIdInput = form.querySelector('input');
    _importStatus  = _root.querySelector('#pl-hero-imp-st');
    _importInfo    = null;
  }
  handleImport();
}

function onInput(e) {
  if (e.target.id === 'pl-search') { _q = e.target.value; renderSearch(); return; }
  if (e.target.id === 'pl-bank') onBankChange(e.target.value);
}

function trapTab(e, box) {
  const f = [...box.querySelectorAll('button:not([disabled]), input')].filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function onKeydown(e) {
  if (store.getActiveModule() !== 'planner') return;
  if (_dialog) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(false); }
    else if (e.key === 'Tab') trapTab(e, _root.querySelector('#pl-dlg'));
    return;
  }
  if (_drawerOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
    else if (e.key === 'Tab') trapTab(e, _drawer);
  }
}

function onBeforeUnload(e) {
  if (_domWired && isDirty()) { e.preventDefault(); e.returnValue = ''; }
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
  _importStatus.dataset.type = type;
  _importStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
  _importIdInput?.setAttribute('aria-invalid', String(type === 'error'));
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
    const { playerIds, picks, entryInfo, missingCount } = await fetchAndMapSquad(teamId, gw);

    if (playerIds.length === 0) {
      showImportStatus('No recognised players found — check the Team ID and try again.', 'error');
      return;
    }

    saveTeamId(teamId);
    _importedTeamId    = teamId;
    _importedEntryInfo = entryInfo;

    replaceSquad(playerIds);
    // Order matters: setSquad clears any previous picks, so this must follow it.
    store.setSquadPicks(picks);
    renderImportInfo(entryInfo);

    const warn = missingCount > 0 ? ` (${missingCount} player${missingCount === 1 ? '' : 's'} not recognised)` : '';
    showImportStatus(`Imported ${playerIds.length} players from GW${gw}.${warn}`, 'success');
    toast(`Imported ${entryInfo?.name ?? 'your team'} — ${playerIds.length} players`);
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
 * Cache all DOM refs and attach all event listeners. Called from initPlanner()
 * and again from onDataReady(); the _domWired guard prevents double-wiring.
 */
function wireDom() {
  if (_domWired) return;

  _root    = document.querySelector('[data-module="planner"] .pl');
  if (!_root) {
    console.warn('[planner] data-module="planner" section not found in DOM');
    return;
  }
  _hero    = _root.querySelector('#pl-hero');
  _runWrap = _root.querySelector('#pl-run-wrap');
  _weeks   = _root.querySelector('#pl-weeks');
  _tray    = _root.querySelector('#pl-tray');
  _drawer  = _root.querySelector('#pl-drawer');
  _scrim   = _root.querySelector('#pl-scrim');
  _cmd     = _root.querySelector('#pl-cmd');

  _root.addEventListener('click', onClick);
  _root.addEventListener('submit', onSubmit);
  _root.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);

  // The settings bar wraps at some widths — keep its real height for anything
  // that wants to sit under it.
  new ResizeObserver(() => _root.style.setProperty('--pl-cmd-h', `${_cmd.offsetHeight}px`)).observe(_cmd);

  // The saved Team ID pre-fills the drawer's import box.
  const saved = loadSavedTeamId();
  if (saved) _root.querySelector('#pl-imp-id').value = String(saved);

  loadChipsUsed();
  loadRun();

  render();
  _domWired = true;
}

// ─── Store event handlers ─────────────────────────────────────────────────────

/**
 * Set when data changed while the Planner was off screen, so activation knows
 * it owes a re-score. See onRouteChanged.
 */
let _pendingRender = false;

function onDataReady() {
  wireDom();          // no-op after first call
  // Force a fresh full-pool rank computation for the new data (see ensureRankTiers).
  _rankTierByPlayerId = null;
  _dataReady = true;

  // Invalidate always, recompute lazily — same split as Dashboard. The
  // bookkeeping above is cheap and must stay eager; scoreSquad() below drives
  // ensureRankTiers, a full-pool ranking measured at ~920ms. data:ready fires
  // once per team-xG payload at boot, so off-screen recomputes here were
  // roughly half the startup lag. See store.js's activeModule note.
  if (store.getActiveModule() !== 'planner') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  recomputeAndRender(true);
}

/** Flush a render deferred while off screen, once the Planner is shown. */
function onRouteChanged(module) {
  if (module !== 'planner') {
    closeDrawer();
    if (_dialog) closeDialog(false);
    return;
  }
  if (!_pendingRender) return;
  _pendingRender = false;
  recomputeAndRender(true);
}

/**
 * 'squadPicks:updated' fires when the pick order (slot + armband) changes
 * without the squad's MEMBERSHIP changing — the only thing that depends on
 * it is the squad drawer's saved-XI diff markers (calcSavedXiDiff, inside
 * renderDrawer). Deliberately does NOT run the rest of afterSquadChange:
 * re-scoring and re-enumerating swaps here would be the exact double cold
 * pass this event was split out of 'squad:updated' to avoid — see the
 * comment on store.js's setSquadPicks.
 */
function onSquadPicksChanged() {
  renderDrawer();
}

function onHorizonChanged() {
  if (!_dataReady) return;
  // Rank tiers depend on horizon (a player's score, and therefore rank,
  // differs by horizon) — force a fresh computation alongside the re-score.
  _rankTierByPlayerId = null;
  // Re-score squad against the new horizon and re-compute transfer
  // recommendations + chip timing (chips depend on the same fixture data).
  recomputeAndRender(true);
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the Transfer Planner module. Called once from main.js before
 * loadInitialData(). Registers store subscriptions so the module is ready
 * to receive events whenever the fetch completes. main.js runs after the
 * document is parsed, so wireDom() runs here and the loading state shows
 * before the first data:ready.
 *
 * Also subscribes to 'squad:updated' so a squad built or imported on the
 * Dashboard — or anywhere else — re-scores and re-renders here too, with no
 * rebuild step.
 */
export function initPlanner() {
  store.subscribe('data:ready',        onDataReady);
  store.subscribe('horizon:changed',   onHorizonChanged);
  store.subscribe('route:changed',     onRouteChanged);
  store.subscribe('squad:updated',     afterSquadChange);
  store.subscribe('squadPicks:updated', onSquadPicksChanged);

  wireDom();

  // If the store is already hydrated (sessionStorage), wire up immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
