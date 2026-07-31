/**
 * js/main.js
 * Layer: entry point. Bootstrap only — kicks off the initial data load,
 * subscribes to store events, reads URL hash to pick the active view,
 * wires the nav and horizon switcher, and delegates all rendering to modules.
 * Contains no analytical logic and no per-module rendering.
 * See ARCHITECTURE.md §4 for the module loading strategy.
 */

import {
  HORIZONS, WEIGHTS,
  PROJ_FORM, PROJ_FIXTURE, PROJ_COUNTER, PROJ_MINUTES,
} from './config.js';
import { store } from './store.js';
import {
  fetchBootstrap, fetchFixtures, fetchPlayerSummary,
  fetchLeagueXg, fetchTeamXg, ApiError,
} from './api.js';
import { normaliseSeason, normalisePlayerSummary } from './engine/normalise.js';
import { buildScoreContext, scoreFixture, scoreOverHorizon, scorePlayer, rankPlayers } from './engine/composite.js';
import { calcBaseDifficulty, calcHomeAwaySplit, calcVenueEffect, calcFixtureHistory } from './engine/fixtures.js';
import { calcTeamForm, calcPlayerForm, calcPlayingLikelihood } from './engine/form.js';
import { calcStyleProfile, calcStyleClash } from './engine/style.js';
import {
  calcCounterMatchup, calcIndividualDuels, duelsForPairing,
} from './engine/counter.js';

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
      // MODEL: Understat is supplementary — log and continue with FPL-only data.
      // style.js + form.js fall back to Phase 1 proxies and flag estimated:true
      // on the breakdown. A failed Understat fetch must never block the main load.
      // ROADMAP.md §3A — this path is intentionally non-fatal; no store.setError().
      console.warn('[Gaffer IQ] Understat league xG unavailable — falling back to FPL proxies.',
        leagueXgRes.reason?.message ?? leagueXgRes.reason);
    }

    store.markDataReady();
  } catch (err) {
    // store.setError() clears season state before emitting — the store is left
    // cleanly empty, not partially populated (CONVENTIONS.md §9, store.js §setError).
    const apiErr = err instanceof ApiError ? err : new ApiError(String(err?.message ?? err));
    store.setError(apiErr);
  }
}

// ─── Error banner ─────────────────────────────────────────────────────────────

const errorBanner = document.getElementById('app-error-banner');
const errorText   = document.getElementById('app-error-text');

store.subscribe('data:error', (err) => {
  // err is a full ApiError — show its message directly. The message already
  // includes the endpoint name and upstream status (e.g. "Failed to load
  // bootstrap data: Proxy 403 — FPL API rate limited"). CONVENTIONS.md §9.
  console.error('[Gaffer IQ] data:error —', err);
  if (errorText)   errorText.textContent = err.message || String(err);
  if (errorBanner) errorBanner.hidden = false;
});

// Hide the banner after a successful retry so the UI resets cleanly.
store.subscribe('data:ready', () => {
  if (errorBanner) errorBanner.hidden = true;
});

document.getElementById('app-error-retry')?.addEventListener('click', () => {
  // Re-trigger the full data fetch sequence. clearCache() first so force:true
  // starts from a clean slate, not a stale sessionStorage snapshot.
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
  calcBaseDifficulty, calcHomeAwaySplit, calcVenueEffect, calcFixtureHistory,
  calcTeamForm, calcPlayerForm, calcPlayingLikelihood,
  calcStyleProfile, calcStyleClash,
  calcCounterMatchup,
  calcIndividualDuels, duelsForPairing,
};

/**
 * Console-runnable model checks, exposed alongside window.__engine for the same
 * reason: GAFFER_IQ_TESTING_ROADMAP.md's verification steps are run by hand in
 * the browser (F12), which is the only place the engine has real data to chew on.
 *
 * Each returns a plain object and logs a readable table. Run window.__verify.all()
 * after any config.js weight change — see GAFFER_IQ_TESTING_ROADMAP.md.
 */
window.__verify = {
  /** Both weight tables must sum to exactly 1.00 (FEATURE_ENGINE.md §8.1, §10). */
  weights() {
    const EPS = 1e-9;
    const fixtureSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    const projSum    = PROJ_FORM + PROJ_FIXTURE + PROJ_COUNTER + PROJ_MINUTES;
    const rows = [
      { table: 'WEIGHTS (scoreFixture)', sum: fixtureSum, pass: Math.abs(fixtureSum - 1) < EPS },
      { table: 'PROJ_* (scorePlayer)',   sum: projSum,    pass: Math.abs(projSum - 1) < EPS },
    ];
    console.table(rows);
    const pass = rows.every(r => r.pass);
    console.log(pass ? '✅ weight sums OK' : '❌ WEIGHT SUM BROKEN — fix config.js');
    return { pass, rows };
  },

  /**
   * Playing-likelihood impact across the whole player pool: how many players
   * move, and the biggest movers. Compares the live four-term score against the
   * three-term score it would have had before PROJ_MINUTES existed.
   */
  playingLikelihood(limit = 10) {
    const ctx = window.__engine.context();
    if (!ctx) { console.warn('No data loaded yet.'); return null; }
    const horizon = HORIZONS.GW1;
    const rows = [];
    for (const p of store.getPlayers()) {
      let s;
      try { s = scorePlayer(p, horizon, ctx); } catch { continue; }
      const b = s.breakdown;
      if (!b.minutes) continue;
      // Re-normalise the three original terms to sum to 1 so the comparison is
      // like-for-like rather than just smaller because a weight was removed.
      const oldW = PROJ_FORM + PROJ_FIXTURE + PROJ_COUNTER;
      const before =
        ((PROJ_FORM * b.form.value) + (PROJ_FIXTURE * b.fixture.value)
         + (PROJ_COUNTER * b.counter.value)) / oldW;
      rows.push({
        player: p.name,
        playing: Math.round(b.minutes.value),
        before: Math.round(before * 10) / 10,
        after: Math.round(s.value * 10) / 10,
        delta: Math.round((s.value - before) * 10) / 10,
      });
    }
    rows.sort((a, b) => a.delta - b.delta);
    console.log(`Scored ${rows.length} players. Biggest DOWNGRADES (unlikely starters):`);
    console.table(rows.slice(0, limit));
    console.log('Biggest UPGRADES (nailed starters):');
    console.table(rows.slice(-limit).reverse());
    const moved = rows.filter(r => Math.abs(r.delta) >= 1).length;
    console.log(`${moved} of ${rows.length} players moved by ≥1 point.`);
    return rows;
  },

  /** Stacking penalty actually firing on real fixtures (FEATURE_ENGINE.md §8.6). */
  stacking(limit = 10) {
    const ctx = window.__engine.context();
    if (!ctx) { console.warn('No data loaded yet.'); return null; }
    const rows = [];
    for (const f of ctx.fixtures) {
      for (const teamId of [f.homeTeamId, f.awayTeamId]) {
        const team = ctx.teamsById[teamId];
        if (!team) continue;
        let s;
        try { s = scoreFixture(team, f, ctx); } catch { continue; }
        if (!s.stacking) continue;
        rows.push({
          gw: f.gw,
          team: team.shortName,
          linear: Math.round(s.stacking.linearValue * 10) / 10,
          penalty: Math.round(s.stacking.penalty * 10) / 10,
          final: Math.round(s.value * 10) / 10,
          badMetrics: s.stacking.countUnfavourable,
          band: s.band,
        });
      }
    }
    rows.sort((a, b) => b.penalty - a.penalty);
    console.log('Fixtures where secondary metrics stack up most:');
    console.table(rows.slice(0, limit));
    const firing = rows.filter(r => r.penalty > 0.5).length;
    console.log(`${firing} of ${rows.length} team-fixtures took a penalty > 0.5 pts.`);
    return rows;
  },

  /**
   * §8.7 zero-sum check: for every unplayed fixture, score both sides and
   * assert value(home) + value(away) === 100 (within floating-point epsilon).
   * Also reports the biggest genuine mismatches (by |edge|) so you can eyeball
   * that lopsided splits still happen — zero-sum is a relationship, not a
   * flattening toward 50/50.
   */
  zeroSum(limit = 10) {
    const ctx = window.__engine.context();
    if (!ctx) { console.warn('No data loaded yet.'); return null; }
    const EPS = 1e-6;
    const rows = [];
    let worst = 0;
    for (const f of ctx.fixtures) {
      const home = ctx.teamsById[f.homeTeamId];
      const away = ctx.teamsById[f.awayTeamId];
      if (!home || !away) continue;
      let h, a;
      try {
        h = scoreFixture(home, f, ctx);
        a = scoreFixture(away, f, ctx);
      } catch { continue; }
      const sum = h.value + a.value;
      const deviation = Math.abs(sum - 100);
      worst = Math.max(worst, deviation);
      rows.push({
        gw: f.gw,
        home: home.shortName, homeValue: Math.round(h.value * 10) / 10,
        away: away.shortName, awayValue: Math.round(a.value * 10) / 10,
        sum: Math.round(sum * 100) / 100,
        edge: Math.round(Math.abs(h.relative.edge) * 10) / 10,
      });
    }
    const pass = worst < EPS;
    console.log(`Checked ${rows.length} fixtures. `
      + `Worst |sum-100| observed: ${worst.toExponential(2)} `
      + `(${pass ? 'PASS — zero-sum holds' : 'FAIL — investigate'}).`);
    rows.sort((a, b) => b.edge - a.edge);
    console.log(`Biggest edges (genuine mismatches — should be lopsided, still sum to 100):`);
    console.table(rows.slice(0, limit));
    return { pass, worstDeviation: worst, rows };
  },

  /** Named players behind each counter-matchup pairing, for one fixture. */
  pairingPlayers(fixtureId) {
    const ctx = window.__engine.context();
    const f = fixtureId ? store.getFixture(fixtureId) : ctx?.fixtures?.[0];
    if (!ctx || !f) { console.warn('No fixture available.'); return null; }
    const home = ctx.teamsById[f.homeTeamId];
    const away = ctx.teamsById[f.awayTeamId];
    const duels = calcIndividualDuels(home, away, ctx);
    const pairings = scoreFixture(home, f, ctx).breakdown.counterMatchup.pairings;
    const out = {};
    for (const key of Object.keys(pairings)) {
      out[key] = duelsForPairing(duels, key)
        .map(d => `${d.attacker.name} (${d.attacker.role}) vs `
                + `${d.defender.name} (${d.defender.role}) → ${Math.round(d.duelScore)}`);
    }
    console.log(`${home.shortName} attacking pairings vs ${away.shortName}:`);
    console.log(out);
    return out;
  },

  all() {
    const w = this.weights();
    const z = this.zeroSum(5);
    this.stacking(5);
    this.playingLikelihood(5);
    this.pairingPlayers();
    return w.pass && (z?.pass ?? true);
  },
};

// ─── Kick off ─────────────────────────────────────────────────────────────────

loadInitialData();
