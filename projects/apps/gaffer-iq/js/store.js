/**
 * js/store.js
 * Layer: state. In-memory cache mirrored to sessionStorage, app-wide pub/sub.
 * Side effects: state mutation, sessionStorage reads/writes, event emission.
 * The only mutable shared state in the app — modules communicate through
 * store events, never directly with each other.
 * See ARCHITECTURE.md §6 (caching) and CONVENTIONS.md §8 (event naming).
 */

// Bump the version suffix when the normalised model shape changes — old
// cached payloads will then be ignored rather than feeding stale data through.
const SS_KEY_SEASON = 'gaffer-iq:season:v3';

// Shared squad key — the ONE place the user's 15-man squad is persisted.
// Reuses the Dashboard's pre-existing key so an already-saved squad survives
// this change unchanged; the Planner's old separate 'gafferiq_squad_planner'
// key is now unused and simply ages out of sessionStorage.
const SS_KEY_SQUAD = 'gafferiq_squad';

const state = {
  season: null,         // see engine/normalise.js → normaliseSeason output
  playerSummaries: {},  // playerId → normalised PlayerSummary
  // Phase 3A — Understat (external xG). leagueXg is the CURRENT season's
  // league/EPL payload (teamsData/datesData/playersData) shared by every
  // engine call; teamXg is a per-team lazy cache keyed by Understat slug.
  leagueXg: null,
  // Phase 3B — last season's leagueXg payload, same shape, fetched alongside
  // the current season purely so calcHomeAwaySplit's rolling 38-game window
  // (engine/fixtures.js) has real matches to draw on before the current
  // season has enough of its own — see VENUE_ROLLING_GAMES, config.js.
  // Nothing else in the engine reads this; Style Clash/calcStyleProfile stay
  // on the current season only.
  leagueXgPrev: null,
  // Older leagueXg payloads (UNDERSTAT_HISTORY_SEASONS, config.js), fetched
  // purely to deepen the head-to-head record — engine/h2h.js and, through its
  // shared collector, calcFixtureHistory's cross-season window. Nothing else in
  // the engine reads these. An ARRAY, newest first, so adding a season to the
  // window is a config edit rather than another named slot here; entries that
  // failed to fetch are simply absent, never null.
  leagueXgHistory: [],
  teamXg: {},
  // Fixtures tab — raw `event/{gw}/live/` payloads keyed by GW. This is the
  // ONLY source of per-fixture match events (scorers, assists, cards) and of
  // who actually featured; bootstrap/fixtures carry neither. Memory-only and
  // never mirrored to sessionStorage: the endpoint is explicitly no-store
  // (see the allowlist in api/fpl.js) because a live GW changes by the minute.
  live: {},
  // Fixtures tab — Understat match detail keyed by FIXTURE id (not by Understat
  // match id, so the consumer never has to re-derive the mapping). Each entry
  // is { events, lineups }: the chronological feed and both teams' teamsheets,
  // which arrive together from the same pair of upstream calls. Memory-only,
  // like `live`: a finished match never changes, so there is nothing to gain
  // from persisting it across a session.
  matchDetail: {},
  // Planning horizon. Fixed at GW6 since the switcher was removed from the
  // nav — every module reads this, nothing writes it any more. setActiveHorizon
  // and the horizon:changed event are kept so a future control can restore the
  // behaviour without re-plumbing five modules.
  activeHorizon: 'GW6',
  // Which module is on screen ('matchup' | 'fixtures' | 'ranker' | 'dashboard'
  // | 'planner'). Written only by main.js's router, which owns the hash; read
  // by every module to skip work it would only throw away.
  //
  // WHY THIS IS STORE STATE rather than each module reading location.hash
  // itself: data:ready is a global broadcast and every module re-renders on
  // it, so at boot the 21 emits (1 + one per team-xG payload) each cost a full
  // application-wide rescore — ~2.4s, of which ~1.8s was two full-pool
  // rankPlayers runs for tabs nobody was looking at. Modules now consult this
  // and defer. Routing is app state, so it belongs here rather than being
  // re-derived from the DOM in five places.
  activeModule: 'matchup',
  // The user's squad: an ordered array of player IDs (max 15), shared by every
  // module that reads/edits it (Dashboard, Planner). Previously each module
  // kept its own private copy with its own sessionStorage key — this is now
  // the single source of truth. See CONVENTIONS.md §8.
  squad: [],
  lastError: null,
  lastRefreshAt: null,
};

// event name → array of callbacks
const subscribers = {};

// ─── Pub/sub ─────────────────────────────────────────────────────────────────

function emit(event, payload) {
  const list = subscribers[event];
  if (!list) return;
  // Iterate a snapshot so a callback may safely unsubscribe itself.
  for (const cb of list.slice()) {
    try { cb(payload); }
    catch (err) { console.error(`[store] subscriber for ${event} threw:`, err); }
  }
}

function subscribe(event, cb) {
  const list = subscribers[event] || (subscribers[event] = []);
  list.push(cb);
  return function unsubscribe() {
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  };
}

// ─── Getters (pure reads) ────────────────────────────────────────────────────

function getSeason()                  { return state.season; }
function getTeams()                   { return state.season?.teams ?? []; }
function getTeam(teamId)              { return state.season?.teamsById?.[teamId] ?? null; }
function getPlayers()                 { return state.season?.players ?? []; }
function getPlayer(playerId)          { return state.season?.playersById?.[playerId] ?? null; }
function getFixtures()                { return state.season?.fixtures ?? []; }
function getFixture(fixtureId)        { return state.season?.fixturesById?.[fixtureId] ?? null; }
function getPositions()               { return state.season?.positions ?? []; }
function getEvents()                  { return state.season?.events ?? []; }
function getCurrentGw()               { return state.season?.currentGw ?? null; }
function getNextGw()                  { return state.season?.nextGw ?? null; }
function getPlayerSummary(playerId)   { return state.playerSummaries[playerId] ?? null; }
function getAllPlayerSummaries()       { return state.playerSummaries; }
function getLeagueXg()                { return state.leagueXg; }
function getLeagueXgPrev()            { return state.leagueXgPrev; }
function getLeagueXgHistory()         { return state.leagueXgHistory; }
function getTeamXg(teamSlug)          { return state.teamXg[teamSlug] ?? null; }
function getLive(gw)                  { return state.live[gw] ?? null; }
function getMatchDetail(fixtureId)    { return state.matchDetail[fixtureId] ?? null; }
function getAllTeamXg()               { return { ...state.teamXg }; }
function getActiveHorizon()           { return state.activeHorizon; }
function getActiveModule()            { return state.activeModule; }
function getSquad()                   { return state.squad; }
function getError()                   { return state.lastError; }
function getLastRefreshAt()           { return state.lastRefreshAt; }
function isFresh()                    { return state.season !== null; }

// ─── Setters (mutations + persistence) ───────────────────────────────────────

function setSeason(season) {
  state.season = season;
  state.lastRefreshAt = Date.now();
  state.lastError = null;
  try {
    sessionStorage.setItem(
      SS_KEY_SEASON,
      JSON.stringify({ at: state.lastRefreshAt, data: season }),
    );
  } catch { /* quota exceeded or disabled — non-fatal */ }
}

function setPlayerSummary(playerId, summary) {
  state.playerSummaries[playerId] = summary;
}

function setLeagueXg(data) {
  state.leagueXg = data;
}

function setLeagueXgPrev(data) {
  state.leagueXgPrev = data;
}

/**
 * Replace the older-seasons payload list. Callers pass only what actually
 * loaded — a season whose fetch failed is left out rather than held as a null,
 * so consumers can spread the array without filtering.
 * @param {object[]} list  newest first
 */
function setLeagueXgHistory(list) {
  state.leagueXgHistory = Array.isArray(list) ? list.filter(Boolean) : [];
}

function setTeamXg(teamSlug, data) {
  state.teamXg[teamSlug] = data;
}

/**
 * Cache one gameweek's raw live payload. Emits so any open view re-renders
 * the moment it lands, the same contract as the other async enrichments.
 * @param {number} gw
 * @param {object} data  raw `event/{gw}/live/` JSON
 */
function setLive(gw, data) {
  state.live[gw] = data;
  emit('live:updated', gw);
}

/**
 * Cache one fixture's Understat match detail. Events and lineups land together,
 * so they are stored together and announced once — two emits would mean two
 * full re-renders of the same pane for one logical arrival.
 * @param {number} fixtureId
 * @param {{events: object[], lineups: object|null}} detail
 */
function setMatchDetail(fixtureId, detail) {
  state.matchDetail[fixtureId] = detail;
  emit('match:updated', fixtureId);
}

function setActiveHorizon(key) {
  if (state.activeHorizon === key) return;
  state.activeHorizon = key;
  emit('horizon:changed', key);
}

/**
 * Record which module is on screen. Called by main.js's router on every
 * hashchange and once at boot.
 *
 * Emits 'route:changed' with the new module key AFTER updating state, so a
 * subscriber that wakes on it already reads the new value from
 * getActiveModule(). Modules that deferred a render while hidden use this as
 * their cue to flush — see the _dirty pattern in each module's onDataReady.
 *
 * Fires only on an actual change, so re-selecting the current tab is free.
 */
function setActiveModule(key) {
  if (state.activeModule === key) return;
  state.activeModule = key;
  emit('route:changed', key);
}

/**
 * Replace the whole squad and persist it. The single mutation point for squad
 * state — Dashboard and Planner both call this (never touching sessionStorage
 * or a local array themselves), so a squad built or edited in either module is
 * immediately visible, correctly, in the other via 'squad:updated'.
 * @param {number[]} playerIds  ordered player IDs (position-limit validation
 *   stays with the calling module, same as before — this is a state primitive,
 *   not a rules engine).
 */
function setSquad(playerIds) {
  state.squad = Array.isArray(playerIds) ? playerIds.slice() : [];
  try {
    sessionStorage.setItem(SS_KEY_SQUAD, JSON.stringify(state.squad));
  } catch { /* quota exceeded or disabled — non-fatal */ }
  emit('squad:updated', state.squad);
}

function setError(err) {
  // Clear season state before emitting — the store must never be left in a
  // half-initialised state where a stale session is still visible alongside
  // an active error. Player summaries are retained: they are lazily loaded
  // and will be re-fetched on demand after a successful reload.
  state.season = null;
  state.leagueXg = null;
  state.leagueXgPrev = null;
  state.leagueXgHistory = [];
  state.live = {};
  state.matchDetail = {};
  state.lastRefreshAt = null;
  try { sessionStorage.removeItem(SS_KEY_SEASON); } catch { /* non-fatal */ }
  state.lastError = err;
  emit('data:error', err);
}

function markDataReady() {
  emit('data:ready');
}

function clearCache() {
  state.season = null;
  state.playerSummaries = {};
  state.leagueXg = null;
  state.leagueXgPrev = null;
  state.leagueXgHistory = [];
  state.teamXg = {};
  state.live = {};
  state.matchDetail = {};
  state.lastRefreshAt = null;
  state.lastError = null;
  try { sessionStorage.removeItem(SS_KEY_SEASON); } catch { /* non-fatal */ }
}

// ─── Hydration ────────────────────────────────────────────────────────────────
// On module load, restore the season from sessionStorage if present so a
// reload within the same tab skips the network round-trip. The decision to
// re-fetch vs use the cache is made by main.js using isFresh().
(function hydrate() {
  try {
    const raw = sessionStorage.getItem(SS_KEY_SEASON);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.data) {
      state.season = parsed.data;
      state.lastRefreshAt = parsed.at ?? null;
    }
  } catch { /* corrupt or absent — ignore and re-fetch */ }

  // Squad hydrates independently of season freshness — it's the user's own
  // list, not derived from the fetched data, so it survives a reload even
  // when the season cache above is stale/absent.
  try {
    const rawSquad = sessionStorage.getItem(SS_KEY_SQUAD);
    if (!rawSquad) return;
    const parsedSquad = JSON.parse(rawSquad);
    if (Array.isArray(parsedSquad)) {
      state.squad = parsedSquad.filter(id => typeof id === 'number');
    }
  } catch { /* corrupt or absent — ignore and start fresh */ }
})();

export const store = {
  subscribe, emit,
  getSeason, getTeams, getTeam, getPlayers, getPlayer,
  getFixtures, getFixture, getPositions, getEvents,
  getCurrentGw, getNextGw, getPlayerSummary, getAllPlayerSummaries,
  getLeagueXg, getLeagueXgPrev, getLeagueXgHistory, getTeamXg, getAllTeamXg,
  getLive, getMatchDetail,
  getActiveHorizon, getActiveModule, getSquad, getError, getLastRefreshAt, isFresh,
  setSeason, setPlayerSummary, setLeagueXg, setLeagueXgPrev, setLeagueXgHistory, setTeamXg,
  setLive, setMatchDetail,
  setActiveHorizon, setActiveModule, setSquad, setError, markDataReady,
  clearCache,
};
