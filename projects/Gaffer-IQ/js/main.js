/**
 * js/main.js
 * Layer: entry point. Bootstrap only — kicks off the initial data load,
 * subscribes to store events, and (Phase 1C+) reads URL hash to pick the
 * active view and wires the nav and horizon switcher. Contains no
 * analytical logic and no per-module rendering — delegates to modules.
 * See ARCHITECTURE.md §4 for the module loading strategy.
 */

import { HORIZONS } from './config.js';
import { store } from './store.js';
import { fetchBootstrap, fetchFixtures, ApiError } from './api.js';
import { normaliseSeason } from './engine/normalise.js';
import { buildScoreContext, scoreFixture } from './engine/composite.js';
import { calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory } from './engine/fixtures.js';
import { calcTeamForm, calcPlayerForm } from './engine/form.js';
import { calcStyleProfile, calcStyleClash } from './engine/style.js';
import { calcCounterMatchup } from './engine/counter.js';

// TODO(phase-1c): import './modules/matchup.js';
// TODO(phase-2):  import './modules/ranker.js';
// TODO(phase-2):  import './modules/dashboard.js';
// TODO(phase-2):  import './modules/planner.js';

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
    const [rawBootstrap, rawFixtures] = await Promise.all([
      fetchBootstrap(),
      fetchFixtures(),
    ]);
    const season = normaliseSeason(rawBootstrap, rawFixtures);
    store.setSeason(season);
    store.markDataReady();
  } catch (err) {
    // Wrap unknown throwables so listeners always receive an ApiError.
    const apiErr = err instanceof ApiError ? err : new ApiError(String(err?.message ?? err));
    store.setError(apiErr);
  }
}

// Dev visibility — confirms the pipeline works without needing the UI.
// These logs are part of the Phase 1A bring-up; they'll quiet down once
// real modules render data from the store in Phase 1C.
store.subscribe('data:ready', () => {
  const teams    = store.getTeams();
  const players  = store.getPlayers();
  const fixtures = store.getFixtures();
  console.log(
    `[Gaffer IQ] data:ready — ${teams.length} teams, ${players.length} players, ${fixtures.length} fixtures.`,
    { currentGw: store.getCurrentGw(), nextGw: store.getNextGw() },
  );
});

store.subscribe('data:error', (err) => {
  console.error('[Gaffer IQ] data:error —', err);
});

// Phase 1A dev affordance: expose the store on window so the exit-criterion
// console check (`__store.getTeams()`, `__store.getPlayers()`, etc.) works
// directly in DevTools. Remove or gate behind a debug flag once modules
// in Phase 1C+ render from the store.
window.__store    = store;
window.__horizons = HORIZONS;
window.__refresh  = () => { store.clearCache(); loadInitialData({ force: true }); };

// Phase 1B dev affordance: expose the engine functions so the §12 sanity
// benchmark can be run from DevTools without manual ESM imports:
//   const ctx = __engine.context();
//   const f   = __store.getFixtures().find(x => !x.played);
//   __engine.scoreFixture(__store.getTeam(f.homeTeamId), f, ctx);
// Removed alongside __store once Phase 1C renders from the store directly.
window.__engine = {
  // Build a fresh context from the current season + cached player summaries.
  context() {
    const season = store.getSeason();
    if (!season) return null;
    return buildScoreContext(season, {
      playerSummariesById: {}, // populated lazily in Phase 2 via fetchPlayerSummary
      currentGw: store.getCurrentGw() ?? store.getNextGw() ?? 1,
    });
  },
  // Top-level entry — fixture composite score.
  scoreFixture,
  buildScoreContext,
  // Individual sub-metric helpers, handy for debugging odd composite values.
  calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory,
  calcTeamForm, calcPlayerForm,
  calcStyleProfile, calcStyleClash,
  calcCounterMatchup,
};

loadInitialData();
