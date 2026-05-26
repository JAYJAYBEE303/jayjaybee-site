/**
 * js/calibration.js
 * Layer: module (DOM + localStorage). Developer tool for model calibration.
 * Persists per-GW composite score snapshots to localStorage and renders a
 * calibration history table accessible via #calibration.
 * Side effects: localStorage reads/writes, DOM.
 * See ROADMAP.md §Phase 3B and FEATURE_ENGINE.md §12 (tuning guidance).
 */

import { store } from './store.js';
import { buildScoreContext, scoreFixture } from './engine/composite.js';
import { BANDS } from './config.js';

// ─── localStorage key helpers ────────────────────────────────────────────────

const LS_PREFIX = 'gafferiq_calibration_gw';

function gwKey(gw) {
  return `${LS_PREFIX}${gw}`;
}

// ─── Snapshot persistence ────────────────────────────────────────────────────

/**
 * Build a snapshot of all scored GW-N fixtures and write it to localStorage.
 * Called once per app load, after data:ready.
 *
 * @param {number} gw  current gameweek number
 */
function saveSnapshot(gw) {
  const season = store.getSeason();
  if (!season) return;

  const ctx = buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    currentGw: gw,
  });

  const gwFixtures = season.fixtures.filter(f => f.gw === gw);
  if (!gwFixtures.length) return;

  const fixtures = gwFixtures.map(fixture => {
    const homeTeam = season.teamsById[fixture.homeTeamId];
    const awayTeam = season.teamsById[fixture.awayTeamId];

    let homeScore = null;
    let awayScore = null;
    try { homeScore = scoreFixture(fixture, homeTeam, ctx); } catch { /* estimated */ }
    try { awayScore = scoreFixture(fixture, awayTeam, ctx); } catch { /* estimated */ }

    return {
      fixtureId:       fixture.id,
      homeTeam:        homeTeam?.shortName ?? homeTeam?.name ?? String(fixture.homeTeamId),
      awayTeam:        awayTeam?.shortName ?? awayTeam?.name ?? String(fixture.awayTeamId),
      homePredBand:    homeScore?.band    ?? null,
      homePredValue:   homeScore?.value   ?? null,
      awayPredBand:    awayScore?.band    ?? null,
      awayPredValue:   awayScore?.value   ?? null,
      fplFdrHome:      fixture.fplDifficulty?.home ?? null,
      fplFdrAway:      fixture.fplDifficulty?.away ?? null,
      // filled when the fixture is played — allows calibration comparison
      result:          fixture.played && fixture.result
        ? { homeGoals: fixture.result.homeGoals, awayGoals: fixture.result.awayGoals }
        : null,
    };
  });

  const snapshot = {
    gw,
    savedAt: new Date().toISOString(),
    fixtures,
  };

  try {
    localStorage.setItem(gwKey(gw), JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[calibration] localStorage write failed:', err);
  }
}

// ─── Public data accessors ───────────────────────────────────────────────────

/**
 * Returns all saved GW calibration snapshots from localStorage,
 * parsed and sorted ascending by GW number.
 *
 * @returns {Array<{gw, savedAt, fixtures}>}
 */
export function getCalibrationHistory() {
  const snapshots = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LS_PREFIX)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed && typeof parsed.gw === 'number') {
        snapshots.push(parsed);
      }
    } catch { /* corrupt entry — skip */ }
  }
  snapshots.sort((a, b) => a.gw - b.gw);
  return snapshots;
}

/**
 * Wipes all gafferiq_calibration_* keys from localStorage.
 */
export function clearCalibrationHistory() {
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_PREFIX)) keysToRemove.push(key);
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
}

// ─── Accuracy helpers ────────────────────────────────────────────────────────

/**
 * Derive the outcome direction for one side from a result.
 * Returns 'win' | 'draw' | 'loss' from that side's perspective.
 *
 * @param {number} goalsFor
 * @param {number} goalsAgainst
 * @returns {'win'|'draw'|'loss'}
 */
function outcomeDirection(goalsFor, goalsAgainst) {
  if (goalsFor > goalsAgainst)  return 'win';
  if (goalsFor === goalsAgainst) return 'draw';
  return 'loss';
}

/**
 * Return whether a band prediction was correct given an actual outcome.
 * Bands 'great' / 'good' predict a win; 'tough' / 'brutal' predict a loss;
 * 'neutral' predicts a draw — a conservative but interpretable mapping.
 *
 * @param {string} band     predicted band string
 * @param {'win'|'draw'|'loss'} actual
 * @returns {boolean|null}  null when the match hasn't been played yet
 */
function isBandCorrect(band, actual) {
  if (!band || !actual) return null;
  if (band === 'great' || band === 'good')     return actual === 'win';
  if (band === 'neutral')                       return actual === 'draw';
  if (band === 'tough' || band === 'brutal')   return actual === 'loss';
  return null;
}

/**
 * Compute running accuracy across all snapshots: share of played fixtures
 * where the predicted band matched the actual outcome direction.
 *
 * @param {Array} snapshots  output of getCalibrationHistory()
 * @returns {{ correct: number, total: number, pct: number|null }}
 */
function calcAccuracy(snapshots) {
  let correct = 0;
  let total   = 0;
  for (const snap of snapshots) {
    for (const f of snap.fixtures) {
      if (!f.result) continue;
      const homeOutcome = outcomeDirection(f.result.homeGoals, f.result.awayGoals);
      const awayOutcome = outcomeDirection(f.result.awayGoals, f.result.homeGoals);
      if (f.homePredBand) {
        total++;
        if (isBandCorrect(f.homePredBand, homeOutcome)) correct++;
      }
      if (f.awayPredBand) {
        total++;
        if (isBandCorrect(f.awayPredBand, awayOutcome)) correct++;
      }
    }
  }
  return {
    correct,
    total,
    pct: total > 0 ? Math.round((correct / total) * 100) : null,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render the calibration view into <section data-module="calibration">.
 * Called on data:ready and whenever the user navigates to #calibration.
 */
function renderCalibration() {
  const section = document.querySelector('[data-module="calibration"]');
  if (!section) return;

  const snapshots = getCalibrationHistory();
  const accuracy  = calcAccuracy(snapshots);

  // ── Header row ──────────────────────────────────────────────────────────
  let html = '<div class="calib-header">';
  html += '<h2 class="calib-title">Model Calibration</h2>';
  html += '<div class="calib-actions">';

  if (snapshots.length > 0) {
    const pctLabel = accuracy.pct !== null
      ? `${accuracy.pct}% accuracy (${accuracy.correct}/${accuracy.total} played)`
      : 'No played fixtures yet';
    html += `<span class="calib-accuracy">${pctLabel}</span>`;
    html += '<button class="calib-btn calib-btn--export" id="calib-export" type="button">Export JSON</button>';
    html += '<button class="calib-btn calib-btn--clear"  id="calib-clear"  type="button">Clear history</button>';
  }

  html += '</div></div>';

  if (!snapshots.length) {
    html += '<p class="calib-empty">No calibration data saved yet. Data is recorded each time the app loads after data:ready fires.</p>';
    section.innerHTML = html;
    return;
  }

  // ── Table ────────────────────────────────────────────────────────────────
  html += '<div class="calib-table-wrap"><table class="calib-table">';
  html += '<thead><tr>';
  html += '<th>GW</th>';
  html += '<th>Saved</th>';
  html += '<th>Fixture</th>';
  html += '<th>Home band</th>';
  html += '<th>Away band</th>';
  html += '<th>FPL FDR (H/A)</th>';
  html += '<th>Result</th>';
  html += '<th>Home call</th>';
  html += '<th>Away call</th>';
  html += '</tr></thead>';
  html += '<tbody>';

  for (const snap of snapshots) {
    const savedDate = snap.savedAt
      ? new Date(snap.savedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';

    for (const f of snap.fixtures) {
      let resultStr = '—';
      let homeCallStr = '—';
      let awayCallStr = '—';
      let homeCallClass = '';
      let awayCallClass = '';

      if (f.result) {
        resultStr = `${f.result.homeGoals}–${f.result.awayGoals}`;
        const homeOutcome = outcomeDirection(f.result.homeGoals, f.result.awayGoals);
        const awayOutcome = outcomeDirection(f.result.awayGoals, f.result.homeGoals);

        const homeCorrect = isBandCorrect(f.homePredBand, homeOutcome);
        const awayCorrect = isBandCorrect(f.awayPredBand, awayOutcome);

        homeCallStr  = homeCorrect === true ? '✓' : homeCorrect === false ? '✗' : '—';
        awayCallStr  = awayCorrect === true ? '✓' : awayCorrect === false ? '✗' : '—';
        homeCallClass = homeCorrect === true ? 'calib-call--correct' : homeCorrect === false ? 'calib-call--wrong' : '';
        awayCallClass = awayCorrect === true ? 'calib-call--correct' : awayCorrect === false ? 'calib-call--wrong' : '';
      }

      const homeBandClass = f.homePredBand ? `score-pill score-pill--${f.homePredBand}` : '';
      const awayBandClass = f.awayPredBand ? `score-pill score-pill--${f.awayPredBand}` : '';

      html += '<tr>';
      html += `<td>${snap.gw}</td>`;
      html += `<td>${savedDate}</td>`;
      html += `<td class="calib-fixture">${f.homeTeam} vs ${f.awayTeam}</td>`;
      html += `<td>${f.homePredBand ? `<span class="${homeBandClass}">${f.homePredBand}</span>` : '—'}</td>`;
      html += `<td>${f.awayPredBand ? `<span class="${awayBandClass}">${f.awayPredBand}</span>` : '—'}</td>`;
      html += `<td>${f.fplFdrHome ?? '—'} / ${f.fplFdrAway ?? '—'}</td>`;
      html += `<td>${resultStr}</td>`;
      html += `<td class="${homeCallClass}">${homeCallStr}</td>`;
      html += `<td class="${awayCallClass}">${awayCallStr}</td>`;
      html += '</tr>';
    }
  }

  html += '</tbody></table></div>';
  section.innerHTML = html;

  // ── Button listeners (wired after innerHTML) ─────────────────────────────
  document.getElementById('calib-export')?.addEventListener('click', handleExport);
  document.getElementById('calib-clear')?.addEventListener('click', handleClear);
}

function handleExport() {
  const data = getCalibrationHistory();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `gafferiq-calibration-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleClear() {
  if (!confirm('Clear all calibration history from localStorage?')) return;
  clearCalibrationHistory();
  renderCalibration();
}

// ─── Module entry point ───────────────────────────────────────────────────────

/**
 * Initialise the calibration module. Called from main.js before loadInitialData().
 * Subscribes to data:ready to save a snapshot and (if the view is active) re-render.
 */
export function initCalibration() {
  store.subscribe('data:ready', () => {
    const gw = store.getCurrentGw() ?? store.getNextGw();
    if (typeof gw === 'number') {
      saveSnapshot(gw);
    }
    // Re-render only if the calibration view is currently visible.
    if (window.location.hash === '#calibration') {
      renderCalibration();
    }
  });

  // Render when the user navigates to #calibration (hash change).
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#calibration') {
      renderCalibration();
    }
  });

  // Render immediately if the page loads directly at #calibration.
  if (window.location.hash === '#calibration') {
    renderCalibration();
  }
}
