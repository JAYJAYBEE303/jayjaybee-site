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
const SS_KEY_SEASON = 'gaffer-iq:season:v1';

const state = {
  season: null,         // see engine/normalise.js → normaliseSeason output
  playerSummaries: {},  // playerId → normalised PlayerSummary
  // Phase 3A — Understat (external xG). leagueXg is the league/EPL payload
  // (teamsData/datesData/playersData) shared by every engine call; teamXg
  // is a per-team lazy cache keyed by Understat slug.
  leagueXg: null,
  teamXg: {},
  activeHorizon: 'GW1',
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
function getTeamXg(teamSlug)          { return state.teamXg[teamSlug] ?? null; }
function getActiveHorizon()           { return state.activeHorizon; }
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

function setTeamXg(teamSlug, data) {
  state.teamXg[teamSlug] = data;
}

function setActiveHorizon(key) {
  if (state.activeHorizon === key) return;
  state.activeHorizon = key;
  emit('horizon:changed', key);
}

function setError(err) {
  // Clear season state before emitting — the store must never be left in a
  // half-initialised state where a stale session is still visible alongside
  // an active error. Player summaries are retained: they are lazily loaded
  // and will be re-fetched on demand after a successful reload.
  state.season = null;
  state.leagueXg = null;
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
  state.teamXg = {};
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
})();

export const store = {
  subscribe, emit,
  getSeason, getTeams, getTeam, getPlayers, getPlayer,
  getFixtures, getFixture, getPositions, getEvents,
  getCurrentGw, getNextGw, getPlayerSummary, getAllPlayerSummaries,
  getLeagueXg, getTeamXg,
  getActiveHorizon, getError, getLastRefreshAt, isFresh,
  setSeason, setPlayerSummary, setLeagueXg, setTeamXg,
  setActiveHorizon, setError, markDataReady,
  clearCache,
};
