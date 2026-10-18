/**
 * js/modules/planner.js
 * Layer: module. Owns the DOM for the Transfer Planner view.
 * Side effects: DOM writes, localStorage reads/writes. Reads from store; every
 * recommendation comes from engine/decision.js (runDecisionEngine), fed by
 * engine/projections.js and engine/price-adapter.js, plus the Wildcard and
 * Free Hit hints of engine/chips.js. It renders the DecisionResult and nothing else - no
 * analysis lives here (ARCHITECTURE.md §12, docs/decision-engine-plan.md §5.3).
 * Layout, in reading order (plan §4.3): the settings bar (bank, free
 * transfers, squad, snapshot export), the live-round note, the chip plan, one
 * card per mode, the captain and XI, and the sell / hold table with lock
 * buttons. Lock and ban re-run the engine on cached projections and V values.
 *
 * Subscriptions: data:ready, route:changed, squad:updated, squadPicks:updated
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import {
  HORIZONS, SQUAD_LIMITS, SQUAD_TOTAL, SEASON_GWS, CHIP_IDS, CHIP_LABELS, CHIP_RESET_AFTER_GW,
  DECISION_ENGINE, GW_TABLES_WAIT_MS,
} from '../config.js';
import { buildScoreContext } from '../engine/composite.js';
import { scoreWildcardTiming, scoreFreeHitTiming } from '../engine/chips.js';
import { buildProjections } from '../engine/projections.js';
import { runDecisionEngine, createDecisionCache } from '../engine/decision.js';
import { priceSignals } from '../engine/price-adapter.js';
import { deriveFreeTransfers } from '../engine/ledger.js';
import {
  fetchAndMapSquad, loadSavedTeamId, saveTeamId, resolveImportGw, loadLedger,
} from '../squadImport.js';
import { exportSnapshots, downloadSnapshots } from '../snapshots.js';
import { toTenths, fromTenths } from '../util.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** localStorage key for your bank, free-transfer and chip overrides, kept next
 *  to the ledger (squadImport.js) they override. */
const SETTINGS_KEY = 'gafferiq_planner';

/** What the old planner kept; removed on sight. */
const RETIRED_KEYS = ['gafferiq_planner_run', 'gafferiq_chips_used'];

/** The bank box's ceiling, £m (its max attribute in index.html). */
const BANK_MAX = 100;

/** An hour, in ms: the engine is told the hours left to the deadline. */
const HOUR_MS = 60 * 60 * 1000;

/** One line under each mode card's title: what the mode is for. */
const MODE_BLURB = {
  now:       'The next gameweek only.',
  longterm:  'The next three gameweeks, evenly.',
  future:    'Leans on the gameweeks further out.',
  funds:     'Frees money for a better move, with little given up.',
  ceiling:   'Aims everything at the peak week.',
  structure: 'Fixes injuries and slots the bench can’t cover.',
};

const MINUTES_RISK = {
  low:    { text: 'Low risk',  title: 'Minutes risk: low - very likely to play' },
  medium: { text: 'Some risk', title: 'Minutes risk: medium - may not play' },
  high:   { text: 'High risk', title: 'Minutes risk: high - may well not play' },
  blank:  { text: 'Blank',     title: 'No fixture this gameweek' },
};

const FLAG_TEXT = {
  sell:        { text: 'Sell',      title: 'A mode’s move sells him' },
  hold:        { text: 'Hold',      title: 'Doubtful now, back inside the horizon: Structure keeps him' },
  protected:   { text: 'Protected', title: 'Worth too much in the peak week for the first four modes to sell' },
  pendingNews: { text: 'News',      title: 'Flagged doubtful - press conferences may change this' },
  priceFall:   { text: 'Falling',   title: 'His price is likely to fall soon, taking £0.1m off what he sells for' },
  priceRise:   { text: 'Rising',    title: 'His price is likely to rise soon, adding £0.1m to what he sells for' },
};

const SORT_LABEL = { name: 'player', sell: 'sell price', keep: 'keep value', out: 'out score' };
const POS_FULL = { GKP: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };
const POS_LINE = { GKP: 'Goalkeeper', DEF: 'Defence', MID: 'Midfield', FWD: 'Attack' };

/** Small counts spelled out, so prose never runs into the gameweek numbers
 *  beside it - "1 GW2 match" reads as one number. A gameweek holds at most ten
 *  fixtures; anything past that falls back to a digit. */
const NUMBER_WORDS = ['zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six',
                      'Seven', 'Eight', 'Nine', 'Ten'];

/** Read per call, not at import: keeps this module importable under Node. */
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ─── Module-level state ───────────────────────────────────────────────────────
//
// NOTE: the squad itself is NOT module-level state - it lives in store.js
// (store.getSquad()/setSquad()), shared with the Dashboard.

let _importInFlight = false;
let _dataReady = false;
let _domWired = false;
let _pendingRender = false;

/** Promise of the snapshot archive's adapter (main.js), for the export
 *  button and the per-gameweek minutes table. */
let _snapshotDb = null;
/** Settles once this visit's minutes tables are archived (main.js). */
let _gwTablesArchived = null;
/** Promise of the archived minutes tables, read once per data:ready. */
let _gwTables = null;
/** What the projections stand on: 'table' (per-GW minutes) or 'totals'. */
let _basis = null;

/** buildProjections output for every player, and the GW it was built for. */
let _projections = null;
let _projectionsGw = null;
/** Every player's price signal (engine/price-adapter.js), read once per data load. */
let _priceSignals = null;
/** V values kept between runs, so a lock, ban or setting re-runs fast. */
let _cache = createDecisionCache();
/** The last DecisionResult, or null. */
let _result = null;
/** Why there is no result: 'loading' | 'empty' | 'short' | 'over' | 'settling'
 *  | 'computing' | 'failed' | 'ready'. */
let _state = 'loading';
/** Bumped by every recompute; a projection build that finds it moved on drops its work. */
let _token = 0;

/** Wildcard and Free Hit hints (chips.js); Bench Boost and Triple Captain come
 *  with the DecisionResult. */
let _hints = { wildcard: null, freehit: null };

/** Your overrides as saved: { importedAt, planningGw, bankTenths,
 *  freeTransfers, chipPlan, used } (see resolveSettings). */
let _saved = null;

/** Players you won't sell, and players you won't buy. This visit only. */
let _locks = new Set();
let _bans = new Set();

let _tableMode = 'longterm';
let _openAlts = new Set();   // modes whose alternatives are expanded
let _sort = { key: 'out', desc: true };
let _animate = false;        // the next ready render plays the entrance
let _heroHtml = '';          // what the hero shows now

let _q = '';                 // squad drawer search
let _drawerOpen = false;
let _dialog = null;          // { title, body, ok, run }
let _dialogReturn = null;
let _toastTimer = 0;
let _undo = null;

// ─── DOM refs (populated in wireDom) ─────────────────────────────────────────

let _root   = null;
let _hero   = null;
let _body   = null;
let _drawer = null;
let _scrim  = null;

// Import refs. Two forms share handleImport - the empty-state hero and the
// squad drawer - so these point at whichever one was submitted.
let _importIdInput = null;
let _importStatus  = null;
let _importInfo    = null;

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * The plan's settings: what the last import says, unless you changed them.
 * Your bank and free transfers stand for the import and planning GW you set
 * them for, your chips-used marks for that import, your chip plan always
 * (the engine ignores weeks already gone).
 *
 * MODEL: no history before the planning GW means its first deadline is still
 * to come, when transfers are unlimited - the engine's 5 banked, where a
 * move costs nothing. No history at all (its fetch failed) is not that, and
 * starts from one.
 *
 * @param {LedgerRecord|null} ledger  squadImport.js loadLedger()
 * @param {object|null} saved
 * @param {number} planningGw
 * @returns {{ bankTenths: number, freeTransfers: number,
 *   chipPlan: Object<number, string>, used: Object<string, boolean[]> }}
 *   used: per chip, [first half, second half]
 */
export function resolveSettings(ledger, saved, planningGw) {
  const importedAt = ledger?.importedAt ?? null;
  // The ledger is this app's own record, but a malformed one (an old version,
  // a hand edit) must read as no import rather than stop the page.
  const h = ledger?.history;
  const history = Array.isArray(h?.gws) && Array.isArray(h.chips)
    && h.gws.every(g => Number.isInteger(g?.gw) && Number.isInteger(g?.transfers))
    && h.chips.every(c => typeof c?.chip === 'string' && Number.isInteger(c?.gw))
    ? h : null;
  const bankTenths = Number.isInteger(ledger?.bankTenths) && ledger.bankTenths >= 0 ? ledger.bankTenths : 0;
  const derivedFt = history
    ? (deriveFreeTransfers(history, planningGw) ?? DECISION_ENGINE.maxBankedFt)
    : 1;
  const derivedUsed = Object.fromEntries(CHIP_IDS.map(id => [id, [false, false]]));
  for (const { chip, gw } of history?.chips ?? []) {
    if (derivedUsed[chip]) derivedUsed[chip][halfOf(gw)] = true;
  }

  const sameImport = Boolean(saved) && saved.importedAt === importedAt;
  const sameGw = sameImport && saved.planningGw === planningGw;
  const used = sameImport && saved.used ? saved.used : derivedUsed;
  // A plan made later in the season than the planning GW belongs to the last
  // season; a week in a half where its chip is used can no longer be played.
  const lastSeason = Number.isInteger(saved?.planningGw) && saved.planningGw > planningGw;
  const chipPlan = lastSeason ? {} : Object.fromEntries(Object.entries(saved?.chipPlan ?? {})
    .filter(([gw, chip]) => !used[chip]?.[halfOf(Number(gw))]));
  return {
    bankTenths: sameGw && Number.isInteger(saved.bankTenths) ? saved.bankTenths : bankTenths,
    freeTransfers: sameGw && Number.isInteger(saved.freeTransfers) ? saved.freeTransfers : derivedFt,
    chipPlan,
    used,
  };
}

/** Chips used, as the engine's list: one entry per half, dated inside it. */
export function chipsUsedList(used) {
  return CHIP_IDS.flatMap(chip => (used[chip] ?? []).flatMap((isUsed, half) =>
    (isUsed ? [{ chip, gw: half === 0 ? 1 : CHIP_RESET_AFTER_GW + 1 }] : [])));
}

/**
 * The engine's squad: prices in tenths, the ledger's purchase price or null
 * (he then sells at his current price, flagged estimated).
 * @param {Player[]} players
 * @param {Object<number, number>} [purchasesTenths]
 */
export function decisionSquad(players, purchasesTenths) {
  const paid = id => (Number.isInteger(purchasesTenths?.[id]) ? purchasesTenths[id] : null);
  return players.map(p => ({
    playerId: p.id, name: p.name, position: p.position, teamId: p.teamId,
    priceTenths: toTenths(p.price), purchaseTenths: paid(p.id),
  }));
}

/**
 * The archived minutes tables, but only when they hold every finished GW
 * before the planning one: a partial table would make most players look out
 * of contention. null makes the projections use season totals, flagged.
 */
export function gwTableFor(tables, events, planningGw) {
  const needed = events.filter(e => e.complete && e.id < planningGw).map(e => e.id);
  const held = new Set((tables ?? []).map(t => t.gw));
  return needed.length > 0 && needed.every(gw => held.has(gw)) ? tables : null;
}

/** The sell / hold rows by one column, either way; no figure sorts last, ties by name. */
export function sortSellHold(rows, key, desc) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === y) return byName(a, b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return ((desc ? -cmp : cmp) || byName(a, b));
  });
}

function halfOf(gw) {
  return gw > CHIP_RESET_AFTER_GW ? 1 : 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function money(millions) {
  return `£${millions.toFixed(1)}m`;
}

/** Points to one decimal, signed; rounded first, so -0.04 reads +0.0, not −0.0. */
function pts(v) {
  const r = Math.round(v * 10) / 10;
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}`;
}

/** Points to one decimal, unsigned unless negative. */
function pt(v) {
  const r = Math.round(v * 10) / 10 || 0;
  return r < 0 ? `−${Math.abs(r).toFixed(1)}` : r.toFixed(1);
}

function nameOf(id) {
  return store.getPlayer(id)?.name ?? '?';
}

function crestHTML(team) {
  return team?.badgeUrl
    ? `<img class="crest" src="${esc(team.badgeUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : '';
}

/** GW12, GW12–16, or GW12, GW14 and GW15 - the weeks a set of weights counts. */
function gwSpan(gws) {
  if (gws.length === 0) return '';
  if (gws.length === 1) return `GW${gws[0]}`;
  if (gws.at(-1) - gws[0] === gws.length - 1) return `GW${gws[0]}–${gws.at(-1)}`;
  return `${gws.slice(0, -1).map(gw => `GW${gw}`).join(', ')} and GW${gws.at(-1)}`;
}

/** The GWs a mode's weights count (a planned Free Hit / Wildcard zeroes some). */
function countedGws(weights, planningGw) {
  return weights.map((w, k) => (w > 0 ? planningGw + k : null)).filter(gw => gw !== null);
}

function numberWord(n) {
  return NUMBER_WORDS[n] ?? String(n);
}

// ─── Timing ──────────────────────────────────────────────────────────────────

/**
 * Which gameweek this page is planning FOR, and how the round on the
 * scoreboard relates to it.
 *
 * MODEL: `season.currentGw` is FPL's `is_current`, which stays pointing at a
 * round from its deadline until the next one opens - so for most of a
 * weekend it names a gameweek whose deadline has GONE. Transfers cannot be
 * spent into a round that has kicked off, so once the current round has
 * started, the planning gameweek is the NEXT one.
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

  // `dataChecked` is FPL's data_checked - true once at least one fixture in the
  // round has been processed. Kept alongside the deadline comparison because
  // the deadline alone is a clock read, and a wrong client clock would
  // otherwise silently skip a gameweek. Either signal is enough.
  const deadlinePassed = ev.deadline ? Date.parse(ev.deadline) <= Date.now() : false;
  const started = Boolean(ev.complete || ev.dataChecked || deadlinePassed);

  // `complete` is full time by the fixtures. `ev.finished` waits for bonus
  // confirmation, so it would report a played-out round as still 'live'. See
  // normalise.js deriveEventCompletion.
  const phase = ev.complete ? 'finished' : started ? 'live' : 'pre-deadline';

  // Only meaningful while the round is under way: how many of its matches have
  // yet to be played, because each one still to come can move every number on
  // this page. Postponed fixtures carry gw === null and are excluded.
  const unplayed = phase === 'live'
    ? store.getFixtures().filter(f => f.gw === currentGw && !f.played).length
    : 0;

  const planningGw = started
    ? (nextGw ?? currentGw + 1)
    : currentGw;

  return { currentGw, planningGw, phase, unplayed };
}

/**
 * The note shown while a round is still being played: the plan is for the
 * next deadline, and the matches still to come will move its numbers.
 * Empty when nothing is in play.
 */
function timingNote(timing) {
  const { phase, currentGw, planningGw, unplayed } = timing;
  if (phase !== 'live' || currentGw == null || unplayed <= 0) return '';
  const caution = unplayed === 1
    ? ` One GW${currentGw} match is still to play, and its result will move `
      + 'these numbers - deciding now means deciding on incomplete information.'
    : ` ${numberWord(unplayed)} GW${currentGw} matches are still to play, and `
      + 'those results will move these numbers - deciding now means deciding on '
      + 'incomplete information.';
  return `This plan is for GW${planningGw}.${caution}`;
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
    // The planning gameweek, NOT the live one - see getPlanningTiming.
    currentGw: getPlanningTiming().planningGw ?? store.getNextGw() ?? 1,
  });
}

/** The GWs a chip can be planned for: the engine's projection horizon. */
function planGws(planningGw) {
  return Array.from({ length: DECISION_ENGINE.horizonGws }, (_, k) => planningGw + k)
    .filter(gw => gw <= SEASON_GWS);
}

// ─── Settings persistence ────────────────────────────────────────────────────

/** Your saved overrides, or null. Anything malformed is dropped, not trusted. */
function loadSaved() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch (err) {
    console.warn('[planner] saved settings unreadable - starting fresh:', err?.message ?? err);
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const chipPlan = {};
  for (const [gw, chip] of Object.entries(raw.chipPlan ?? {})) {
    if (Number.isInteger(Number(gw)) && CHIP_IDS.includes(chip)) chipPlan[gw] = chip;
  }
  const used = raw.used && CHIP_IDS.every(id => Array.isArray(raw.used[id]) && raw.used[id].length === 2)
    ? Object.fromEntries(CHIP_IDS.map(id => [id, raw.used[id].map(Boolean)]))
    : null;
  const tenths = v => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    importedAt: raw.importedAt ?? null,
    planningGw: raw.planningGw ?? null,
    bankTenths: tenths(raw.bankTenths),
    freeTransfers: Number.isInteger(raw.freeTransfers)
      && raw.freeTransfers >= 0 && raw.freeTransfers <= DECISION_ENGINE.maxBankedFt ? raw.freeTransfers : null,
    chipPlan,
    used,
  };
}

/** The settings in force now. */
function currentSettings() {
  return resolveSettings(loadLedger(), _saved, getPlanningTiming().planningGw);
}

/** Change some settings, save them for this import and planning GW, re-run. */
function changeSettings(patch) {
  _saved = {
    importedAt: loadLedger()?.importedAt ?? null,
    planningGw: getPlanningTiming().planningGw,
    ...currentSettings(),
    ...patch,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_saved));
  } catch (err) {
    console.warn('[planner] settings not saved - they last until you leave the page:', err?.message ?? err);
  }
  rerun();
}

// ─── Squad management ─────────────────────────────────────────────────────────
// Reads store.getSquad() directly rather than caching a local copy - the
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
  // call here - the same path the Dashboard's edits take.
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

// ─── The engine run ──────────────────────────────────────────────────────────

/** Why the plan can't be built yet, or null when it can. */
function blockedState() {
  if (!_dataReady) return 'loading';
  const n = store.getSquad().length;
  if (n === 0) return 'empty';
  if (n < SQUAD_TOTAL) return 'short';
  if ((getPlanningTiming().planningGw ?? SEASON_GWS + 1) > SEASON_GWS) return 'over';
  // Every projection is scored against the counter-matchup metric, so a plan
  // built now would reshuffle when the Understat prefetch lands (CONVENTIONS
  // §5.4): skeletons until then.
  if (!store.isTeamXgSettled()) return 'settling';
  return null;
}

/** Projections (if stale) and a run, then paint. The projection build is the
 *  slow part, so the skeletons paint first. */
function recompute() {
  const token = ++_token;
  _state = blockedState() ?? 'computing';
  if (_state !== 'computing') {
    _result = null;
    render();
    return;
  }
  const planningGw = getPlanningTiming().planningGw;
  if (_projections && _projectionsGw === planningGw) {
    runEngine();
    render();
    return;
  }
  _result = null;
  render();
  requestAnimationFrame(() => setTimeout(() => buildAndRun(token, planningGw), 0));
}

async function buildAndRun(token, planningGw) {
  const tables = await readGwTables();
  if (token !== _token) return;   // a later recompute owns the page now
  const ctx = buildCtx();
  try {
    if (!ctx) throw new Error('no scoring context');
    const gwTable = gwTableFor(tables, store.getEvents(), planningGw);
    _projections = buildProjections(store.getPlayers(), ctx, { planningGw, gwTable });
    _priceSignals = priceSignals(store.getPlayers());
    _projectionsGw = planningGw;
    _basis = gwTable ? 'table' : 'totals';
    _hints = wildcardAndFreeHitHints(ctx);
  } catch (err) {
    console.warn('[planner] projections failed:', err?.message ?? err);
    _state = 'failed';
    render();
    return;
  }
  runEngine();
  _animate = true;
  render();
}

/**
 * The archived minutes tables, read once per data:ready; [] when there are
 * none. Waits for this visit's archive top-up first, up to GW_TABLES_WAIT_MS,
 * so a first visit projects on this visit's tables, not a partial set.
 */
function readGwTables() {
  _gwTables ??= Promise.race([
    _gwTablesArchived ?? Promise.resolve(),
    new Promise(resolve => setTimeout(resolve, GW_TABLES_WAIT_MS)),
  ])
    .then(() => _snapshotDb ?? null)
    .then(db => db?.getAll('gwTables') ?? [])
    .catch(err => {
      console.warn('[planner] minutes tables unreadable - projections use season totals:', err?.message ?? err);
      return [];
    });
  return _gwTables;
}

function wildcardAndFreeHitHints(ctx) {
  const horizon = HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW5;
  const attempt = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      console.warn(`[planner] ${what} failed:`, err?.message ?? err);
      return null;
    }
  };
  return {
    wildcard: attempt('scoreWildcardTiming', () => scoreWildcardTiming(horizon, ctx)[0] ?? null),
    freehit:  attempt('scoreFreeHitTiming', () => scoreFreeHitTiming(horizon, ctx)),
  };
}

/** Run the engine on the cached projections. Sets _result and _state. */
function runEngine() {
  const { planningGw } = getPlanningTiming();
  const ledger = loadLedger();
  const settings = resolveSettings(ledger, _saved, planningGw);
  const players = store.getSquad().map(id => store.getPlayer(id)).filter(Boolean);
  try {
    _result = runDecisionEngine({
      planningGw,
      squad: decisionSquad(players, ledger?.purchasesTenths),
      bankTenths: settings.bankTenths,
      freeTransfers: settings.freeTransfers,
      chipPlan: settings.chipPlan,
      chipsUsed: chipsUsedList(settings.used),
      locks: _locks,
      bans: _bans,
      projections: _projections,
      candidates: store.getPlayers(),
      priceSignals: _priceSignals,
      hoursToDeadline: hoursToDeadline(planningGw),
    }, DECISION_ENGINE, _cache);
    _state = 'ready';
  } catch (err) {
    console.warn('[planner] decision engine failed:', err?.message ?? err);
    _result = null;
    _state = 'failed';
  }
}

/** Hours from now to a gameweek's deadline, or null when it is not known. */
function hoursToDeadline(gw) {
  const deadline = store.getEvents().find(e => e.id === gw)?.deadline;
  return deadline ? (Date.parse(deadline) - Date.now()) / HOUR_MS : null;
}

/** A setting, lock or ban changed: re-run on what is cached, or just repaint
 *  the controls while the plan is still being built. */
function rerun() {
  // A deadline that passed with the page open moves the planning GW past the
  // projections: start again rather than run on the wrong weeks.
  if (_projections && _projectionsGw !== getPlanningTiming().planningGw) return recompute();
  if (_state === 'ready' || _state === 'failed') {
    if (_projections) runEngine();
    render();
    return;
  }
  withFocus(() => { renderCmd(); renderChips(); });
}

/**
 * Re-render without losing the reader's place: the chip plan's controls and
 * the table's sort and mode buttons are rebuilt on every repaint, so focus
 * goes back to the rebuilt twin of whichever one had it (a "Plan GWn" button
 * that is gone hands it to its chip's week picker).
 */
function withFocus(paint) {
  const el = document.activeElement;
  const attr = el && _root.contains(el)
    ? ['data-chip-gw', 'data-chip-used', 'data-chip-use', 'data-sort', 'data-sh-mode'].find(a => el.hasAttribute(a))
    : null;
  const key = attr && `[${attr}="${el.getAttribute(attr)}"]${el.dataset.half ? `[data-half="${el.dataset.half}"]` : ''}`;
  const chip = el?.dataset?.chipUse;
  paint();
  if (!key) return;
  (_root.querySelector(key) ?? (chip ? _root.querySelector(`[data-chip-gw="${chip}"]`) : null))?.focus();
}

// ─── Render: hero ────────────────────────────────────────────────────────────

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
  if (_state === 'loading') {
    return '<div class="ld" role="status" aria-label="Loading FPL data"><span class="sk" aria-hidden="true"></span></div>';
  }
  if (_state === 'empty') {
    return '<div class="empty">'
      + `<span class="lbl">Nothing planned yet · 0 / ${SQUAD_TOTAL} players</span>`
      + '<h1>Add 15 players<br>to see your moves</h1>'
      + importFormHTML()
      + '<button type="button" class="link" data-open-squad>Or build it player by player →</button></div>';
  }
  if (_state === 'short') {
    return '<div class="empty" role="status">'
      + '<h2>Add 15 players to see your moves</h2>'
      + `<p class="muted">${squad.length} / ${SQUAD_TOTAL} players in your squad.</p>`
      + '<button type="button" class="btn" data-open-squad>Open squad</button></div>';
  }
  if (_state === 'over') {
    return '<div class="empty" role="status"><h2>The season is over</h2>'
      + '<p class="muted">There is no gameweek left to plan for.</p></div>';
  }
  const gw = getPlanningTiming().planningGw;
  return '<div class="head">'
    + '<span class="lbl">Transfer planner</span>'
    + `<h1>GW${gw} transfers</h1>`
    + '<p class="muted">One best move per mode, scored on your whole squad.</p></div>';
}

/** Repaints only on a change, so a Team ID being typed into the hero's
 *  import box survives the re-renders around it. */
function renderHero() {
  const html = heroHTML();
  if (html === _heroHtml) return;
  _heroHtml = html;
  _hero.innerHTML = html;
}

// ─── Render: settings bar ────────────────────────────────────────────────────

function renderCmd() {
  const { planningGw } = getPlanningTiming();
  const settings = currentSettings();
  _root.querySelector('#pl-cmd-t').textContent = `GW${planningGw}`;
  const bank = _root.querySelector('#pl-bank');
  if (document.activeElement !== bank) bank.value = fromTenths(settings.bankTenths).toFixed(1);
  _root.querySelector('#pl-ft-grp').setAttribute('aria-label', `Free transfers banked for GW${planningGw}`);
  _root.querySelectorAll('[data-ft]').forEach(b => {
    const on = Number(b.dataset.ft) === settings.freeTransfers;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  _root.querySelector('#pl-squad-btn').textContent = `Squad ${store.getSquad().length}/${SQUAD_TOTAL}`;
  const live = _root.querySelector('#pl-live');
  const note = timingNote(getPlanningTiming());
  live.hidden = !note;
  setText(live, note);
}

// ─── Render: chip plan ───────────────────────────────────────────────────────

function hintFor(chip) {
  return chip === 'wildcard' || chip === 'freehit' ? _hints[chip] : (_result?.chipHints?.[chip] ?? null);
}

function chipRowHTML(chip, settings, gws) {
  const label = CHIP_LABELS[chip];
  const used = settings.used[chip];
  const plannedGw = Number(Object.entries(settings.chipPlan).find(([, c]) => c === chip)?.[0] ?? NaN);
  const takenBy = gw => settings.chipPlan[gw] && settings.chipPlan[gw] !== chip;
  const options = gws.map(gw => {
    const off = used[halfOf(gw)] || takenBy(gw);
    return `<option value="${gw}"${gw === plannedGw ? ' selected' : ''}${off ? ' disabled' : ''}>GW${gw}${used[halfOf(gw)] ? ' · used' : takenBy(gw) ? ` · ${esc(CHIP_LABELS[settings.chipPlan[gw]])}` : ''}</option>`;
  }).join('');
  const halves = [`GW1–${CHIP_RESET_AFTER_GW}`, `GW${CHIP_RESET_AFTER_GW + 1}–${SEASON_GWS}`];

  const hint = hintFor(chip);
  let hintText;
  if (_state !== 'ready') hintText = '<span class="muted">Hint waiting on the plan.</span>';
  else if (!hint?.gw) hintText = `<span class="muted">${esc(hint?.reasoning ?? 'No week stands out.')}</span>`;
  else {
    const usable = gws.includes(hint.gw) && !used[halfOf(hint.gw)] && !takenBy(hint.gw);
    hintText = `<span><b>Hint GW${hint.gw}.</b> ${esc(hint.reasoning ?? '')}</span>`
      + (hint.gw === plannedGw ? ' <span class="muted">Planned.</span>'
        : usable ? ` <button type="button" class="link" data-chip-use="${chip}" data-gw="${hint.gw}" aria-label="Plan ${esc(label)} for GW${hint.gw}">Plan GW${hint.gw}</button>`
          : ' <span class="muted">Not plannable here.</span>');
  }

  return `<div class="cp" role="group" aria-labelledby="pl-cp-${chip}">`
    + `<b class="cp__name" id="pl-cp-${chip}">${esc(label)}</b>`
    + `<label class="cp__gw"><span class="sr">${esc(label)} week</span><select data-chip-gw="${chip}">`
    + `<option value=""${Number.isNaN(plannedGw) ? ' selected' : ''}>Not planned</option>${options}</select></label>`
    + `<span class="cp__used"><span class="lbl lbl--sm">Used</span>${halves.map((range, half) =>
      `<button type="button" class="tog tog--sm" data-chip-used="${chip}" data-half="${half}" aria-pressed="${used[half]}" aria-label="${esc(label)} used in ${range}">${range}</button>`).join('')}</span>`
    + `<p class="cp__hint">${hintText}</p></div>`;
}

function renderChips() {
  const settings = currentSettings();
  const gws = planGws(getPlanningTiming().planningGw);
  _root.querySelector('#pl-chips').innerHTML = CHIP_IDS.map(chip => chipRowHTML(chip, settings, gws)).join('');
}

// ─── Render: mode cards ──────────────────────────────────────────────────────

function riskHTML(risk) {
  const r = MINUTES_RISK[risk] ?? MINUTES_RISK.low;
  return `<span class="mr" data-risk="${esc(risk)}" title="${esc(r.title)}"><span class="sr">${esc(r.title)}</span><span aria-hidden="true">${esc(r.text)}</span></span>`;
}

function rollReason(mode, counted, settings) {
  if (counted.length === 0) return 'A planned Free Hit or Wildcard covers every gameweek this mode weighs.';
  if (settings.freeTransfers <= 0) {
    return `No move clears a ${DECISION_ENGINE.hitCost}-point hit and its ${DECISION_ENGINE.hitMargin}-point margin.`;
  }
  if (mode.rollValue <= 0) return 'No move adds points, even with a free transfer to spare.';
  return `No move beats rolling the free transfer, worth ${mode.rollValue.toFixed(1)} points.`;
}

function playerRowHTML(role, move, sellTenths, estimated) {
  const id = role === 'sell' ? move.outId : move.inId;
  const player = store.getPlayer(id);
  const team = store.getTeam(player?.teamId);
  const price = role === 'sell' ? fromTenths(sellTenths) : (player?.price ?? 0);
  const name = esc(player?.name ?? '?');
  const action = role === 'sell'
    ? `<button type="button" class="tog tog--sm" data-lock="${id}" aria-pressed="${_locks.has(id)}" aria-label="Don't sell ${name}">Don’t sell</button>`
    : `<button type="button" class="tog tog--sm" data-ban="${id}" aria-pressed="${_bans.has(id)}" aria-label="Don't buy ${name}">Don’t buy</button>`;
  return `<div class="mc__pl"><span class="lbl">${role === 'sell' ? 'Sell' : 'Buy'}</span>`
    + `<span class="mc__nm"><b class="ell">${name}</b><small>${esc(team?.shortName ?? '-')} · ${money(price)}`
    + `${estimated ? ' <abbr title="No purchase price on record: sold at his current price">est.</abbr>' : ''}</small></span>`
    + `${riskHTML(move.minutesRisk[role === 'sell' ? 'out' : 'in'])}${action}</div>`;
}

function modeCardHTML(mode, i, settings, planningGw) {
  const counted = countedGws(mode.weights, planningGw);
  const span = mode.modeId === 'ceiling'
    ? (mode.targetGw ? `Peak GW${mode.targetGw} · on expected points` : 'No peak week')
    : gwSpan(counted);
  const head = `<header class="mc__hd"><h3>${esc(mode.label)}</h3><span class="mc__span">${esc(span)}</span></header>`
    + `<p class="mc__blurb">${esc(MODE_BLURB[mode.modeId] ?? '')}</p>`;
  const delay = `style="--d:${Math.min(i, 6) * 50}ms"`;
  const root = mode.root;
  if (mode.call === 'roll' || !root) {
    return `<li class="mc" data-mode="${mode.modeId}" data-call="roll" tabindex="-1" ${delay}>${head}`
      + '<p class="mc__call">Roll</p>'
      + `<p class="mc__sum">${esc(rollReason(mode, counted, settings))}</p></li>`;
  }

  const seller = _result.players.find(p => p.playerId === root.outId);
  const perGw = counted.length > 1
    ? `<ol class="pgw" aria-label="Weighted gain by gameweek" title="Each week's gain times the mode's weight for it">${root.perGw.map((v, k) => {
      const gw = planningGw + k;
      if (!counted.includes(gw)) return '';
      const tentative = gw >= root.tentativeFromGw;
      return `<li${tentative ? ' class="is-tent" title="Tentative: projections, team news and prices can change before this week"' : ''}>`
        + `<span>GW${gw}</span><b class="num">${pts(v)}</b>${tentative ? '<span class="sr"> tentative</span>' : ''}</li>`;
    }).join('')}</ol>`
    : '';
  const why = [root.why.squad, root.why.funds, root.why.price, root.why.cost].filter(Boolean)
    .map(line => `<li>${esc(line)}</li>`).join('');
  const notes = (root.tags.includes('blankGwOneWeek') ? `<p class="mc__tag">Blank GW · one-week view</p>` : '')
    + (mode.waitForNews
      ? '<p class="mc__note">Wait for team news: a flagged player is in this move, the press conferences are still to come, and no price change is due before them.</p>'
      : root.tags.includes('pendingNews')
        ? '<p class="mc__note">Team news pending: a flagged player is in this move, so the press conferences may change it.</p>'
        : '');
  const alts = mode.alternatives.length
    ? `<details class="mc__alts" data-alts="${mode.modeId}"${_openAlts.has(mode.modeId) ? ' open' : ''}><summary>${mode.alternatives.length} alternative${mode.alternatives.length === 1 ? '' : 's'}</summary><ol>`
      + mode.alternatives.map(a => `<li><span>Sell <b>${esc(nameOf(a.outId))}</b> → buy <b>${esc(nameOf(a.inId))}</b></span>`
        + `<b class="num">${pts(a.outScore)}</b></li>`).join('')
      + '</ol></details>'
    : '';
  const robust = mode.robustness != null ? `<span class="mc__rb">Robust ${Math.round(mode.robustness * 100)}%</span>` : '';
  const players = `<div class="mc__mv">${playerRowHTML('sell', root, seller?.sellPriceTenths ?? toTenths(store.getPlayer(root.outId)?.price ?? 0),
    root.tags.includes('sellPriceEstimated'))}${playerRowHTML('buy', root)}</div>`;

  if (mode.call === 'wait') {
    const { gw, laterScore } = mode.deferral;
    return `<li class="mc" data-mode="${mode.modeId}" data-call="wait" tabindex="-1" ${delay}>${head}`
      + '<p class="mc__call">Wait</p>'
      + `<p class="mc__sum">Made for GW${gw} instead, this move still scores ${pts(laterScore)} against ${pts(root.outScore)} now: `
      + 'roll the free transfer and decide next week.</p>'
      + players + (root.why.price ? `<p class="mc__note">${esc(root.why.price)}</p>` : '') + '</li>';
  }

  return `<li class="mc" data-mode="${mode.modeId}" data-call="move" tabindex="-1" ${delay}>${head}`
    + players
    + `<p class="mc__ev"><b class="num">${pts(root.outScore)}</b><span>pts vs rolling</span>${robust}</p>`
    + perGw + `<ul class="mc__why">${why}</ul>` + notes + alts + '</li>';
}

function modesNote(settings, planningGw) {
  const chip = settings.chipPlan[planningGw];
  const notes = [];
  if (chip === 'wildcard') notes.push(`Wildcard planned for GW${planningGw}: rebuild the squad there - single moves don’t apply.`);
  if (chip === 'freehit') notes.push(`Free Hit planned for GW${planningGw}: these are permanent moves for GW${planningGw + 1} on - make them after it.`);
  if (_basis === 'totals') {
    notes.push('Minutes come from season totals: this device has not archived every finished gameweek yet, so the projections are estimates.');
  }
  return notes.join(' ');
}

/** Write a live region's text only when it changes, so it is not re-announced. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderModes() {
  const box = _root.querySelector('#pl-modes');
  const settings = currentSettings();
  const { planningGw } = getPlanningTiming();
  const note = _root.querySelector('#pl-modes-note');

  // Your locks and bans, each undone with one press.
  const choices = _root.querySelector('#pl-choices');
  const chips = (ids, attr, verb) => [...ids].map(id => `<button type="button" class="choice" ${attr}="${id}" aria-label="${verb} ${esc(nameOf(id))}">`
    + `${esc(nameOf(id))} <span aria-hidden="true">×</span></button>`).join('');
  choices.hidden = _locks.size + _bans.size === 0;
  choices.innerHTML = (_locks.size ? `<span class="lbl lbl--sm">Not selling</span>${chips(_locks, 'data-unlock', 'Allow selling')}` : '')
    + (_bans.size ? `<span class="lbl lbl--sm">Not buying</span>${chips(_bans, 'data-unban', 'Allow buying')}` : '');

  if (_state !== 'ready') {
    box.setAttribute('aria-busy', String(_state !== 'failed'));
    setText(note, _state === 'failed'
      ? 'Couldn’t build a plan - the console has the error. Reload once the data has finished loading.'
      : _state === 'settling'
        ? 'Counter-matchup data is still landing - moves are held back until it settles.'
        : 'Gathering each finished gameweek’s minutes, then scoring every legal transfer against your whole squad…');
    box.innerHTML = _state === 'failed' ? ''
      : `<ol class="mcs" aria-hidden="true">${Object.keys(DECISION_ENGINE.modes)
        .map(() => '<li class="mc mc--sk"><span class="sk"></span></li>').join('')}</ol>`;
    return;
  }
  box.setAttribute('aria-busy', 'false');
  setText(note, modesNote(settings, planningGw));
  box.innerHTML = `<ol class="mcs">${Object.values(_result.modes)
    .map((mode, i) => modeCardHTML(mode, i, settings, planningGw)).join('')}</ol>`;
}

// ─── Render: captain and XI ──────────────────────────────────────────────────

function renderXi() {
  const box = _root.querySelector('#pl-xi');
  if (_state !== 'ready') {
    box.setAttribute('aria-busy', String(_state !== 'failed'));
    box.innerHTML = _state === 'failed' ? '' : '<div class="xi--sk" aria-hidden="true"><span class="sk"></span><span class="sk"></span></div>';
    return;
  }
  box.setAttribute('aria-busy', 'false');
  const { xi, bench, captainId, viceId, captainGap, nextCaptainId } = _result.lineup;
  const arm = id => (id === captainId ? ' <abbr class="arm" title="Captain">C</abbr>'
    : id === viceId ? ' <abbr class="arm arm--v" title="Vice-captain">V</abbr>' : '');
  const person = id => {
    const p = store.getPlayer(id);
    return `${crestHTML(store.getTeam(p?.teamId))}<span class="ell">${esc(p?.name ?? '?')}</span>`;
  };
  const byPos = pos => xi.filter(id => store.getPlayer(id)?.position === pos);
  const shape = ['DEF', 'MID', 'FWD'].map(pos => byPos(pos).length).join('-');
  const lines = Object.keys(POS_LINE).map(pos =>
    `<li class="xi__ln"><span class="lbl lbl--sm">${POS_LINE[pos]}</span>`
    + `<ul>${byPos(pos).map(id => `<li>${person(id)}${arm(id)}</li>`).join('')}</ul></li>`).join('');
  const gap = captainId && nextCaptainId && Number.isFinite(captainGap)
    ? ` <b class="num">${pts(captainGap)}</b> clear of ${esc(nameOf(nextCaptainId))}, the next-best captain.`
    : '';
  const { planningGw } = getPlanningTiming();
  const chip = currentSettings().chipPlan[planningGw];
  const other = chip === 'freehit' || chip === 'wildcard'
    ? `<p class="sec__note">${esc(CHIP_LABELS[chip])} planned for GW${planningGw}: this is your current squad’s XI, not the ${esc(CHIP_LABELS[chip])} squad’s.</p>`
    : '';
  box.innerHTML = other + `<p class="xi__cap"><b>${esc(nameOf(captainId))}</b> captains${viceId ? `, <b>${esc(nameOf(viceId))}</b> vice` : ''}.${gap}</p>`
    + `<div class="xi__grid"><div><span class="lbl">XI · ${shape}</span><ul class="xi__lns">${lines}</ul></div>`
    + `<div><span class="lbl">Bench, in order</span><ol class="xi__bench">${bench.map(id => `<li>${person(id)}</li>`).join('')}</ol></div></div>`;
}

// ─── Render: sell / hold table ───────────────────────────────────────────────

function renderTableModes() {
  _root.querySelector('#pl-sh-mode').innerHTML = Object.entries(DECISION_ENGINE.modes).map(([id, m]) =>
    `<button type="button" role="radio" data-sh-mode="${id}" aria-checked="${id === _tableMode}" tabindex="${id === _tableMode ? 0 : -1}">${esc(m.label)}</button>`).join('');
}

function sortButton(key, label) {
  const on = _sort.key === key;
  const dir = _sort.desc ? 'high to low' : 'low to high';
  return `<button type="button" class="sb${on ? ' is-on' : ''}" data-sort="${key}" aria-label="Sort by ${SORT_LABEL[key]}${on ? `, ${dir}` : ''}">`
    + `${label}${on ? (_sort.desc ? ' ↓' : ' ↑') : ''}</button>`;
}

function renderTable() {
  renderTableModes();
  const box = _root.querySelector('#pl-sh');
  if (_state !== 'ready') {
    box.setAttribute('aria-busy', String(_state !== 'failed'));
    box.innerHTML = _state === 'failed' ? ''
      : `<div class="sh--sk" aria-hidden="true">${Array.from({ length: SQUAD_TOTAL }, () => '<span class="sk"></span>').join('')}</div>`;
    return;
  }
  box.setAttribute('aria-busy', 'false');
  const mode = _tableMode;
  const label = DECISION_ENGINE.modes[mode].label;
  const rows = sortSellHold(_result.players.map(p => ({
    id: p.playerId,
    name: nameOf(p.playerId),
    sell: p.sellPriceTenths,
    keep: p.keepValue[mode],
    out: p.outScore[mode],
    best: p.best[mode],
    flags: p.flags,
    lockValue: p.lockValue,
    priceSource: p.priceSource,
  })), _sort.key, _sort.desc);
  const ariaSort = key => (_sort.key === key ? ` aria-sort="${_sort.desc ? 'descending' : 'ascending'}"` : '');
  const targetGw = _result.modes.ceiling?.targetGw;

  const body = rows.map(r => {
    const p = store.getPlayer(r.id);
    const team = store.getTeam(p?.teamId);
    const est = r.flags.includes('sellPriceEstimated')
      ? ' <abbr title="No purchase price on record: sold at his current price">est.</abbr>' : '';
    const flags = ['sell', 'hold', 'protected', 'pendingNews', 'priceFall', 'priceRise'].filter(f => r.flags.includes(f)).map(f => {
      let title = f === 'protected' && Number.isFinite(r.lockValue) && targetGw
        ? `Worth ${r.lockValue.toFixed(1)} points in peak GW${targetGw}: the first four modes won’t sell him`
        : FLAG_TEXT[f].title;
      if ((f === 'priceFall' || f === 'priceRise') && r.priceSource === 'estimate') {
        title += ' (estimated from this week’s transfers)';
      }
      return `<span class="flag" data-flag="${f}" title="${esc(title)}">${FLAG_TEXT[f].text}</span>`;
    }).join('');
    const out = r.out === null ? '<span aria-hidden="true">–</span><span class="sr">no legal sale</span>' : pts(r.out);
    return `<tr${_locks.has(r.id) ? ' class="is-locked"' : ''}>`
      + `<th scope="row" class="l"><span class="pn">${crestHTML(team)}<b class="ell">${esc(r.name)}</b><small>${esc(p?.position ?? '')} · ${esc(team?.shortName ?? '-')}</small></span></th>`
      + `<td>${money(fromTenths(r.sell))}${est}</td>`
      + `<td>${pt(r.keep)}</td>`
      + `<td class="${r.out !== null && r.out > 0 ? 'is-pos' : ''}">${out}</td>`
      + `<td class="l">${r.best ? `→ ${esc(nameOf(r.best.inId))}` : '<span aria-hidden="true">–</span>'}</td>`
      + `<td class="l"><span class="flags">${flags}</span></td>`
      + `<td class="c"><button type="button" class="tog tog--sm" data-lock="${r.id}" aria-pressed="${_locks.has(r.id)}" aria-label="Lock ${esc(r.name)}" title="Don’t sell him in any mode">Lock</button></td></tr>`;
  }).join('');

  box.innerHTML = '<div class="tw" role="region" aria-labelledby="pl-sh-t" tabindex="0"><table>'
    + `<caption class="sr">Your ${SQUAD_TOTAL} players under ${esc(label)}, sorted by ${SORT_LABEL[_sort.key]}, ${_sort.desc ? 'high to low' : 'low to high'}.</caption>`
    + '<thead><tr>'
    + `<th scope="col" class="l"${ariaSort('name')}>${sortButton('name', 'Player')}</th>`
    + `<th scope="col"${ariaSort('sell')}>${sortButton('sell', 'Sell price')}</th>`
    + `<th scope="col"${ariaSort('keep')}>${sortButton('keep', 'Keep')}</th>`
    + `<th scope="col"${ariaSort('out')}>${sortButton('out', 'Out')}</th>`
    + '<th scope="col" class="l">Best sale</th><th scope="col" class="l">Flags</th>'
    + '<th scope="col" class="c">Lock</th></tr></thead>'
    + `<tbody>${body}</tbody></table></div>`;
}

// ─── Render: squad drawer ────────────────────────────────────────────────────

/**
 * Where the team the user actually SET differs from the engine's XI and
 * armband (DecisionResult.lineup), so one screen never shows two XIs. Empty
 * sets when there is no import or no plan yet - a hand-built squad has no
 * saved order to disagree with.
 *
 * @returns {{ benched: Set<number>, started: Set<number>, captainId: number|null,
 *             modelCaptainId: number|null }}
 *   benched: the engine starts them, the user has them on the bench
 *   started: the user starts them, the engine would bench them
 */
function calcSavedXiDiff() {
  const savedXi = store.getSavedXi();
  const lineup = _result?.lineup;
  if (savedXi.length === 0 || !lineup) {
    return { benched: new Set(), started: new Set(), captainId: null, modelCaptainId: null };
  }
  const projected = new Set(lineup.xi);
  const saved = new Set(savedXi);
  return {
    benched: new Set([...projected].filter(id => !saved.has(id))),
    started: new Set([...saved].filter(id => !projected.has(id))),
    captainId: store.getSquadPicks().find(p => p.isCaptain)?.playerId ?? null,
    modelCaptainId: lineup.captainId,
  };
}

function renderSearch() {
  const note = _root.querySelector('#pl-search-n');
  const list = _root.querySelector('#pl-results');
  const query = _q.trim().toLowerCase();
  _root.querySelector('#pl-add-grp').hidden = store.getSquad().length >= SQUAD_TOTAL;
  if (query.length < 2) { note.textContent = 'Type two letters to search.'; list.innerHTML = ''; return; }
  const allPlayers = store.getPlayers();
  if (!allPlayers.length) { note.textContent = 'Player data not yet loaded - please wait.'; list.innerHTML = ''; return; }

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
      + `<span>${crestHTML(team)}<span><b>${esc(p.name ?? '?')}</b> <small>${esc(p.position)} · ${esc(team?.name ?? '-')} · ${money(p.price ?? 0)}</small></span></span>`
      + `<span>${esc(reason || 'Add')}</span></button></li>`;
  }).join('');
}

function renderDrawer() {
  if (!_root || !_drawerOpen) return;
  const squad = store.getSquad();
  _root.querySelector('#pl-sq-count').textContent = `${squad.length} / ${SQUAD_TOTAL} players`;
  renderSearch();
  const diff = calcSavedXiDiff();
  _root.querySelector('#pl-squad').innerHTML = Object.entries(SQUAD_LIMITS).map(([pos, max]) => {
    const players = squad.map(id => store.getPlayer(id)).filter(p => p?.position === pos);
    return `<div class="sq-grp"><span class="lbl">${POS_FULL[pos]} · ${players.length} / ${max}</span>`
      + players.map(p => {
        const team = store.getTeam(p.teamId);
        const tags = (diff.benched.has(p.id) ? '<span class="diff" title="The plan starts him - you have him on your bench">bench</span>' : '')
          + (diff.started.has(p.id) ? '<span class="diff" title="You are starting him - the plan benches him">start</span>' : '')
          + (diff.captainId === p.id && diff.modelCaptainId !== p.id ? '<span class="diff" title="Your armband is here; the plan captains another player">C</span>' : '');
        return `<div class="sq"><span>${crestHTML(team)}<span><b>${esc(p.name)}</b> <small>${esc(team?.shortName ?? '-')} · ${money(p.price ?? 0)}</small>${tags}`
          + `${p.status !== 'available' ? ` <small class="warn">⚠ ${esc(p.statusNote || p.status)}</small>` : ''}</span></span>`
          + `<button type="button" class="icon icon--rm" data-rm-player="${p.id}" aria-label="Remove ${esc(p.name)} from squad">×</button></div>`;
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
  const back = _root.querySelector('#pl-squad-btn');
  (back.offsetParent ? back : _hero.querySelector('[data-open-squad]'))?.focus();
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

// ─── Full render ─────────────────────────────────────────────────────────────

function render() {
  if (!_root) return;
  withFocus(paintAll);
}

function paintAll() {
  renderHero();
  // The plan's sections show once there is a full squad to plan for; before
  // that the hero is the whole page.
  _body.hidden = !['settling', 'computing', 'ready', 'failed'].includes(_state);
  if (!_body.hidden) {
    renderCmd();
    renderChips();
    renderModes();
    renderXi();
    renderTable();
    _body.removeAttribute('data-anim');
    if (_animate && _state === 'ready' && !reducedMotion()) {
      void _body.offsetWidth;
      _body.setAttribute('data-anim', '');
    }
    if (_state === 'ready') _animate = false;
  }
  renderDrawer();
}

// ─── After squad change ───────────────────────────────────────────────────────

function afterSquadChange() {
  // Cheap bookkeeping stays unconditional - both Dashboard and Planner call
  // store.setSquad(), so this fires whichever module made the edit.
  _q = '';
  const search = _root?.querySelector('#pl-search');
  if (search) search.value = '';
  // A lock only means something on a player you own, a ban on one you don't.
  const owned = new Set(store.getSquad());
  _locks = new Set([..._locks].filter(id => owned.has(id)));
  _bans = new Set([..._bans].filter(id => !owned.has(id)));
  // Invalidate always, recompute lazily (CONVENTIONS.md §8).
  if (store.getActiveModule() !== 'planner') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  recompute();
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onBankChange(millions) {
  const value = Number.isFinite(millions) && millions > 0 ? Math.min(BANK_MAX, millions) : 0;
  changeSettings({ bankTenths: toTenths(value) });
}

/**
 * A lock or ban re-renders the control that was pressed. Put keyboard focus
 * back where the reader was: the same control if it is still there, else the
 * first control in its card, table or choices line, else the card itself
 * (a card that now rolls has no controls), else the cards' heading.
 */
function keepFocus(el, attr, act) {
  const card = el.closest('[data-mode]')?.dataset.mode;
  const scope = el.closest('#pl-sh') ? '#pl-sh' : card ? `#pl-modes [data-mode="${card}"]` : '#pl-choices';
  const same = `[${attr}="${el.getAttribute(attr)}"]`;
  act();
  const box = _root.querySelector(scope);
  (box?.querySelector(same) ?? box?.querySelector('button') ?? (card ? box : null)
    ?? _root.querySelector('#pl-modes-t'))?.focus();
}

function toggleLock(id) {
  const name = nameOf(id);
  const had = _locks.has(id);
  const flip = () => {
    if (_locks.has(id)) _locks.delete(id);
    else _locks.add(id);
    rerun();
  };
  flip();
  toast(had ? `${name} can be sold again` : `${name} won’t be sold`, flip);
}

function toggleBan(id) {
  const name = nameOf(id);
  const had = _bans.has(id);
  const flip = () => {
    if (_bans.has(id)) _bans.delete(id);
    else _bans.add(id);
    rerun();
  };
  flip();
  toast(had ? `${name} can be bought again` : `${name} won’t be bought`, flip);
}

function onClick(e) {
  const t = e.target;
  const hit = sel => t.closest(sel);
  let el;
  if (hit('[data-undo]')) {
    const u = _undo;
    _undo = null;
    u?.();
    _root.querySelector('#pl-toast').innerHTML = '';
    _root.querySelector('#pl-modes-t')?.focus();
    return;
  }
  if (hit('[data-dlg-cancel]') || t.id === 'pl-dlg-scrim') return closeDialog(false);
  if (hit('[data-dlg-ok]')) return closeDialog(true);
  if (hit('[data-open-squad]') || hit('#pl-squad-btn')) return openDrawer();
  if (hit('[data-close-squad]') || t === _scrim) return closeDrawer();
  if ((el = hit('[data-bank]'))) {
    return onBankChange(fromTenths(currentSettings().bankTenths + Number(el.dataset.bank)));
  }
  if ((el = hit('[data-ft]'))) return changeSettings({ freeTransfers: Number(el.dataset.ft) });
  if (hit('#pl-export')) {
    return void (_snapshotDb ?? Promise.resolve(null))
      .then(async db => {
        const held = db ? await exportSnapshots(db) : { snapshots: [], gwTables: [] };
        if (!held.snapshots.length && !held.gwTables.length) return toast('Nothing archived on this device yet');
        await downloadSnapshots(db);
        return toast('Snapshots exported');
      })
      .catch(err => { console.warn('[planner] snapshot export failed:', err?.message ?? err); toast('Couldn’t export snapshots'); });
  }
  if ((el = hit('[data-chip-used]'))) {
    const { chipUsed: chip, half } = el.dataset;
    const used = currentSettings().used;
    const next = { ...used, [chip]: used[chip].map((v, h) => (h === Number(half) ? !v : v)) };
    return changeSettings({ used: next });
  }
  if ((el = hit('[data-chip-use]'))) return planChip(el.dataset.chipUse, Number(el.dataset.gw));
  if ((el = hit('[data-lock]'))) return keepFocus(el, 'data-lock', () => toggleLock(Number(el.dataset.lock)));
  if ((el = hit('[data-unlock]'))) return keepFocus(el, 'data-unlock', () => toggleLock(Number(el.dataset.unlock)));
  if ((el = hit('[data-ban]'))) return keepFocus(el, 'data-ban', () => toggleBan(Number(el.dataset.ban)));
  if ((el = hit('[data-unban]'))) return keepFocus(el, 'data-unban', () => toggleBan(Number(el.dataset.unban)));
  if ((el = hit('[data-sh-mode]'))) { _tableMode = el.dataset.shMode; renderTable(); return focusChecked('#pl-sh-mode'); }
  if ((el = hit('[data-sort]'))) {
    const key = el.dataset.sort;
    _sort = { key, desc: _sort.key === key ? !_sort.desc : key !== 'name' };
    renderTable();
    return _root.querySelector(`[data-sort="${key}"]`)?.focus();
  }
  if ((el = hit('[data-add-player]'))) { addPlayer(Number(el.dataset.addPlayer)); return; }
  if ((el = hit('[data-rm-player]'))) {
    const p = store.getPlayer(Number(el.dataset.rmPlayer));
    if (!p) return;
    return ask({ title: `Remove ${p.name}?`, body: `${p.name} leaves your squad.`, ok: 'Remove',
      run: () => {
        _locks.delete(p.id);
        removePlayer(p.id);
        toast(`${p.name} removed`);
      } }, el);
  }
}

/** Plan a chip for a GW (or none), dropping it from any other GW. */
function planChip(chip, gw) {
  const plan = Object.fromEntries(Object.entries(currentSettings().chipPlan).filter(([, c]) => c !== chip));
  if (Number.isInteger(gw)) plan[gw] = chip;
  changeSettings({ chipPlan: plan });
}

function onChange(e) {
  const chip = e.target.dataset?.chipGw;
  if (chip) planChip(chip, e.target.value === '' ? null : Number(e.target.value));
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
  if (e.target.id === 'pl-bank') onBankChange(parseFloat(e.target.value));
}

function trapTab(e, box) {
  const f = [...box.querySelectorAll('button:not([disabled]), input')].filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function focusChecked(groupSel) {
  _root.querySelector(`${groupSel} [aria-checked="true"]`)?.focus();
}

/** Arrow keys move the choice in a radio group, as a native one would. */
function onRadioKey(e) {
  const radio = e.target.closest?.('[role="radio"]');
  const group = radio?.closest('[role="radiogroup"]');
  if (!group || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return false;
  e.preventDefault();
  const radios = [...group.querySelectorAll('[role="radio"]')];
  const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
  radios[(radios.indexOf(radio) + step + radios.length) % radios.length].click();
  focusChecked(`#${group.id}`);
  return true;
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
    return;
  }
  onRadioKey(e);
}

// ─── Squad import ────────────────────────────────────────────────────────────

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
  _importInfo.textContent = [teamName, manager, rank].filter(Boolean).join(' · ');
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
      showImportStatus('No recognised players found - check the Team ID and try again.', 'error');
      return;
    }

    saveTeamId(teamId);
    _animate = true;
    replaceSquad(playerIds);
    // Order matters: setSquad clears any previous picks, so this must follow it.
    store.setSquadPicks(picks);
    renderImportInfo(entryInfo);

    const warn = missingCount > 0 ? ` (${missingCount} player${missingCount === 1 ? '' : 's'} not recognised)` : '';
    showImportStatus(`Imported ${playerIds.length} players from GW${gw}.${warn}`, 'success');
    toast(`Imported ${entryInfo?.name ?? 'your team'} - ${playerIds.length} players`);
  } catch (err) {
    const detail = err?.upstreamStatus === 404
      ? 'Team not found - check the ID. Private leagues may block access.'
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

  _root = document.querySelector('[data-module="planner"] .pl');
  if (!_root) {
    console.warn('[planner] data-module="planner" section not found in DOM');
    return;
  }
  _hero   = _root.querySelector('#pl-hero');
  _body   = _root.querySelector('#pl-body');
  _drawer = _root.querySelector('#pl-drawer');
  _scrim  = _root.querySelector('#pl-scrim');

  _root.addEventListener('click', onClick);
  _root.addEventListener('change', onChange);
  // An expanded "alternatives" list stays expanded across re-runs. 'toggle'
  // does not bubble, hence the capture.
  _root.addEventListener('toggle', e => {
    const mode = e.target.dataset?.alts;
    if (!mode) return;
    if (e.target.open) _openAlts.add(mode);
    else _openAlts.delete(mode);
  }, true);
  _root.addEventListener('submit', onSubmit);
  _root.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);

  // The saved Team ID pre-fills the drawer's import box.
  const saved = loadSavedTeamId();
  if (saved) _root.querySelector('#pl-imp-id').value = String(saved);

  _saved = loadSaved();
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key);
  } catch (err) {
    console.warn('[planner] old planner storage not cleared:', err?.message ?? err);
  }

  render();
  _domWired = true;
}

// ─── Store event handlers ─────────────────────────────────────────────────────

function onDataReady() {
  wireDom();          // no-op after first call
  // New data: new projections, minutes tables, hints and V values - and any
  // projection build still in flight is now out of date.
  ++_token;
  _projections = null;
  _priceSignals = null;
  _gwTables = null;
  _hints = { wildcard: null, freehit: null };
  _cache = createDecisionCache();
  _dataReady = true;

  // Invalidate always, recompute lazily - see CONVENTIONS.md §8. data:ready
  // fires once per team-xG payload at boot.
  if (store.getActiveModule() !== 'planner') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  recompute();
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
  recompute();
}

/**
 * 'squadPicks:updated' fires when the pick order (slot + armband) changes
 * without the squad's MEMBERSHIP changing - the only thing that depends on
 * it is the squad drawer's saved-XI diff markers. Deliberately does NOT
 * re-run the engine: see the comment on store.js's setSquadPicks.
 */
function onSquadPicksChanged() {
  renderDrawer();
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the Transfer Planner module. Called once from main.js before
 * loadInitialData(). Registers store subscriptions so the module is ready
 * to receive events whenever the fetch completes. main.js runs after the
 * document is parsed, so wireDom() runs here and the loading state shows
 * before the first data:ready.
 *
 * @param {object} [opts]
 * @param {Promise<object>} [opts.snapshotDb]  the snapshot archive (js/snapshots.js):
 *   its minutes tables feed the projections, and the settings bar exports it
 * @param {Promise<void>} [opts.gwTablesArchived]  settles when this visit's
 *   minutes tables are archived; the projections wait for it (bounded)
 */
export function initPlanner({ snapshotDb = null, gwTablesArchived = null } = {}) {
  _snapshotDb = snapshotDb;
  _gwTablesArchived = gwTablesArchived;
  store.subscribe('data:ready',         onDataReady);
  store.subscribe('route:changed',      onRouteChanged);
  store.subscribe('squad:updated',      afterSquadChange);
  store.subscribe('squadPicks:updated', onSquadPicksChanged);

  wireDom();

  // If the store is already hydrated (sessionStorage), wire up immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
