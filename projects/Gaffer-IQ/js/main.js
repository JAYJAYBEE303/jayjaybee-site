/**
 * js/main.js
 * Layer: entry point. Bootstrap only — kicks off the initial data load,
 * subscribes to store events, reads URL hash to pick the active view,
 * wires the nav and horizon switcher, and delegates all rendering to modules.
 * Contains no analytical logic and no per-module rendering.
 * See ARCHITECTURE.md §4 for the module loading strategy.
 */

import { HORIZONS } from './config.js';
import { store } from './store.js';
import {
  fetchBootstrap, fetchFixtures, fetchPlayerSummary,
  fetchLeagueXg, fetchTeamXg, ApiError,
} from './api.js';
import { normaliseSeason, normalisePlayerSummary } from './engine/normalise.js';
import { buildScoreContext, scoreFixture, scoreOverHorizon, scorePlayer, rankPlayers } from './engine/composite.js';
import { calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory } from './engine/fixtures.js';
import { calcTeamForm, calcPlayerForm } from './engine/form.js';
import { calcStyleProfile, calcStyleClash } from './engine/style.js';
import { calcCounterMatchup } from './engine/counter.js';

import { initMatchup }      from './modules/matchup.js';
import { initRanker }       from './modules/ranker.js';
import { initDashboard }    from './modules/dashboard.js';
import { initPlanner }      from './modules/planner.js';
import { initCalibration }  from './calibration.js';

// ─── Data loading ─────────────────────────────────────────────────────────────

/**
 * Fetches bootstrap + fixtures in parallel, normalises into the internal
 * model, and pushes into the store. Emits data:ready on success or
 * data:error on failure.
 *
 * If the store already holds a season (hydrated from sessionStorage) and
 * `force` is false, we just signal ready without re-hitting the API —
 * ARCHITECTURE.md §6 treats bootstrap/fixtures as fresh for the session.
 */
async function loadInitialData({ force = false } = {}) {
  if (!force && store.isFresh()) {
    store.markDataReady();
    return;
  }
  try {
    // Phase 3A: league-wide xG is one HTTP call and enriches the whole model,
    // so it loads alongside bootstrap/fixtures rather than lazily. Wrapped in
    // Promise.allSettled so an Understat outage doesn't break the FPL pipeline
    // — engine functions degrade to Phase 1 proxies when leagueXg is null.
    const [bootstrapRes, fixturesRes, leagueXgRes] = await Promise.allSettled([
      fetchBootstrap(),
      fetchFixtures(),
      fetchLeagueXg(),
    ]);

    if (bootstrapRes.status !== 'fulfilled') throw bootstrapRes.reason;
    if (fixturesRes.status  !== 'fulfilled') throw fixturesRes.reason;

    const season = normaliseSeason(bootstrapRes.value, fixturesRes.value);
    store.setSeason(season);

    if (leagueXgRes.status === 'fulfilled') {
      store.setLeagueXg(leagueXgRes.value);
    } else {
      // MODEL: Understat is supplementary — log and continue. style.js + form.js
      // fall back to Phase 1 proxies and flag estimated:true on the breakdown.
      console.warn('[Gaffer IQ] Understat league xG unavailable — falling back to FPL proxies.',
        leagueXgRes.reason?.message ?? leagueXgRes.reason);
    }

    store.markDataReady();
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : new ApiError(String(err?.message ?? err));
    store.setError(apiErr);
  }
}

// ─── Error banner ─────────────────────────────────────────────────────────────

const errorBanner = document.getElementById('app-error-banner');
const errorText   = document.getElementById('app-error-text');

store.subscribe('data:error', (err) => {
  console.error('[Gaffer IQ] data:error —', err);
  if (errorText)   errorText.textContent = `Failed to load FPL data: ${err.message || err}. `;
  if (errorBanner) errorBanner.hidden = false;
});

document.getElementById('app-error-retry')?.addEventListener('click', () => {
  if (errorBanner) errorBanner.hidden = true;
  store.clearCache();
  loadInitialData({ force: true });
});

// Dev visibility — confirms the pipeline works.
store.subscribe('data:ready', () => {
  const teams    = store.getTeams();
  const players  = store.getPlayers();
  const fixtures = store.getFixtures();
  console.log(
    `[Gaffer IQ] data:ready — ${teams.length} teams, ${players.length} players, ${fixtures.length} fixtures.`,
    { currentGw: store.getCurrentGw(), nextGw: store.getNextGw() },
  );
});

// ─── Horizon switcher ─────────────────────────────────────────────────────────

const horizonBtns = document.querySelectorAll('.horizon-switcher__btn');

// Set initial active state from store (store defaults to 'GW1', HTML marks GW1 active;
// this keeps them in sync if the store default ever changes).
const initialHorizon = store.getActiveHorizon();
horizonBtns.forEach(btn => {
  btn.classList.toggle('is-active', btn.dataset.horizon === initialHorizon);
});

horizonBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    store.setActiveHorizon(btn.dataset.horizon);
    horizonBtns.forEach(b => b.classList.toggle('is-active', b === btn));
  });
});

// ─── Hash-based routing ───────────────────────────────────────────────────────

const moduleSections = document.querySelectorAll('.module-view');
const navItems       = document.querySelectorAll('.module-nav__item');

function routeToHash() {
  // Strip the leading '#'; default to 'matchup' if hash is absent or unknown.
  const hash   = window.location.hash.slice(1) || 'matchup';
  const target = document.querySelector(`[data-module="${hash}"]`) ? hash : 'matchup';

  moduleSections.forEach(section => {
    section.classList.toggle('is-active', section.dataset.module === target);
  });
  navItems.forEach(link => {
    const module = link.getAttribute('href')?.slice(1);
    link.classList.toggle('is-active', module === target);
  });
}

window.addEventListener('hashchange', routeToHash);
routeToHash();

// ─── Module initialisation ────────────────────────────────────────────────────

// Modules register their store subscriptions here, before loadInitialData() is
// called, so they are in place when data:ready fires.
initMatchup();
initRanker();
initDashboard();
initPlanner();
initCalibration();

// ─── Lazy player-summary loader ───────────────────────────────────────────────

/**
 * Fetch a player summary on demand, cache it in the store, and return it.
 * Returns the cached summary immediately if already loaded. Never bulk-fetches.
 * See ARCHITECTURE.md §6 (lazy loading) and FEATURE_ENGINE.md §7.1.
 *
 * @param {number} playerId
 * @returns {Promise<PlayerSummary>}  normalised summary, cached in store
 */
async function loadPlayerSummary(playerId) {
  const cached = store.getPlayerSummary(playerId);
  if (cached) return cached;
  const raw     = await fetchPlayerSummary(playerId);
  const summary = normalisePlayerSummary(raw);
  store.setPlayerSummary(playerId, summary);
  return summary;
}

// ─── Dev affordances ─────────────────────────────────────────────────────────
// Expose store + engine on window for console exit-criterion verification.

window.__store    = store;
window.__horizons = HORIZONS;
window.__refresh  = () => { store.clearCache(); loadInitialData({ force: true }); };

window.__engine = {
  context(gwOverride) {
    const season = store.getSeason();
    if (!season) return null;
    return buildScoreContext(season, {
      playerSummariesById: store.getAllPlayerSummaries(),
      leagueXg: store.getLeagueXg(),
      currentGw: gwOverride ?? store.getCurrentGw() ?? store.getNextGw() ?? 1,
    });
  },
  scoreFixture,
  scoreOverHorizon,
  scorePlayer,
  rankPlayers,
  buildScoreContext,
  loadPlayerSummary,
  calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory,
  calcTeamForm, calcPlayerForm,
  calcStyleProfile, calcStyleClash,
  calcCounterMatchup,
};

// ─── Kick off ─────────────────────────────────────────────────────────────────

loadInitialData();
