/**
 * js/modules/matchup.js
 * Layer: module. Owns the DOM for the Matchup Analyser view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders one fixture from both teams' perspectives — the full CompositeScore
 * breakdown, counter-matchup pairings, confidence, and official FPL FDR comparison.
 * No analytical logic lives here — all scoring delegated to engine/composite.js.
 * See ARCHITECTURE.md §10, FEATURE_ENGINE.md §11, ROADMAP.md Phase 1C.
 *
 * Subscriptions: data:ready, horizon:changed
 */

import { store } from '../store.js';
import { BANDS } from '../config.js';
import { buildScoreContext, scoreFixture } from '../engine/composite.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const METRIC_LABELS = {
  baseDifficulty: 'Base Difficulty',
  counterMatchup: 'Counter-Matchup',
  teamForm:       'Team Form',
  homeAway:       'Home/Away Split',
  styleClash:     'Style Clash',
  history:        'H2H History',
};

// Ordered so the highest-weight metrics appear first (matches config WEIGHTS order).
const METRIC_ORDER = [
  'baseDifficulty',
  'counterMatchup',
  'teamForm',
  'homeAway',
  'styleClash',
  'history',
];

const PAIRING_LABELS = {
  fwdVsCb:     'FWD vs CB',
  wideMidVsFb: 'Wide MID vs FB',
  camVsCbMid:  'CAM vs CB+DM',
};

// ─── Module-level state ───────────────────────────────────────────────────────

let _controls = null;   // .matchup-controls container (from HTML)
let _grid     = null;   // .matchup-grid container (from HTML)
let _selectedFixtureId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Map a 0–100 value to a band string, reading thresholds from config so this
 * render helper stays in sync with the engine. Not analytical — display only.
 */
function bandFromValue(v) {
  if (v >= BANDS.great)   return 'great';
  if (v >= BANDS.good)    return 'good';
  if (v >= BANDS.neutral) return 'neutral';
  if (v >= BANDS.tough)   return 'tough';
  return 'brutal';
}

/**
 * Build a fresh score context from the current store state.
 * Phase 1: player summaries empty — counter-matchup uses strength-prior fallback.
 * TODO(phase-2): pass playerSummariesById from store for full player form data.
 */
function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: {},
    currentGw: store.getCurrentGw() ?? store.getNextGw() ?? 1,
  });
}

/** Upcoming (unplayed) fixtures with a real GW assigned, sorted by GW then kickoff. */
function getUpcomingFixtures() {
  return store.getFixtures().filter(f => !f.played && f.gw !== null);
}

/**
 * Group a fixture array by GW. Returns [{ gw, fixtures }, …] sorted ascending.
 */
function groupByGw(fixtures) {
  const map = new Map();
  for (const f of fixtures) {
    const list = map.get(f.gw) ?? [];
    list.push(f);
    map.set(f.gw, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([gw, fixturesInGw]) => ({ gw, fixtures: fixturesInGw }));
}

// ─── Render: fixture picker ───────────────────────────────────────────────────

/**
 * Populate the .matchup-controls bar with a labelled <select> containing all
 * upcoming fixtures grouped by GW. Re-builds the picker on data refresh so the
 * list always reflects the live fixture schedule.
 */
function renderPicker(upcoming) {
  _controls.innerHTML = '';

  const label = document.createElement('label');
  label.className = 'fixture-picker__label';
  label.htmlFor = 'fixture-picker';
  label.textContent = 'Select fixture';

  const select = document.createElement('select');
  select.id = 'fixture-picker';
  select.className = 'fixture-picker';

  for (const { gw, fixtures: gwFixtures } of groupByGw(upcoming)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `Gameweek ${gw}`;
    for (const f of gwFixtures) {
      const home = store.getTeam(f.homeTeamId);
      const away = store.getTeam(f.awayTeamId);
      if (!home || !away) continue;
      const opt = document.createElement('option');
      opt.value = String(f.id);
      opt.textContent = `${home.shortName} vs ${away.shortName}`;
      if (f.id === _selectedFixtureId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    if (optgroup.children.length > 0) select.appendChild(optgroup);
  }

  select.addEventListener('change', () => {
    _selectedFixtureId = Number(select.value);
    renderMatchup();
  });

  _controls.appendChild(label);
  _controls.appendChild(select);
}

// ─── Render: matchup cards ────────────────────────────────────────────────────

/**
 * Score the selected fixture for both teams and render two side-by-side cards.
 * All scoring delegated to engine/composite.js — no metric logic here.
 */
function renderMatchup() {
  const ctx = buildCtx();
  if (!ctx || !_selectedFixtureId) {
    showStatus('Loading…');
    return;
  }

  const fixture = store.getFixture(_selectedFixtureId);
  if (!fixture) {
    showStatus('Fixture not found.');
    return;
  }

  const homeTeam = store.getTeam(fixture.homeTeamId);
  const awayTeam = store.getTeam(fixture.awayTeamId);
  if (!homeTeam || !awayTeam) {
    showStatus('Team data unavailable.');
    return;
  }

  const homeScore = scoreFixture(homeTeam, fixture, ctx);
  const awayScore = scoreFixture(awayTeam, fixture, ctx);

  _grid.innerHTML = '';
  _grid.appendChild(
    buildCard(homeTeam, 'Home', homeScore, fixture.fplDifficulty.home),
  );
  _grid.appendChild(
    buildCard(awayTeam, 'Away', awayScore, fixture.fplDifficulty.away),
  );
}

/** Render a status message spanning the full grid width. */
function showStatus(msg) {
  _grid.innerHTML = `<p class="matchup-status">${esc(msg)}</p>`;
}

// ─── Build: matchup card ──────────────────────────────────────────────────────

/**
 * Build and return a <article> DOM node for one team's side of the matchup.
 * Receives a CompositeScore (from scoreFixture) and the official FPL FDR (1–5).
 *
 * @param {Team}           team
 * @param {'Home'|'Away'}  venue
 * @param {CompositeScore} score
 * @param {number}         fdr   official FPL difficulty rating 1–5
 * @returns {HTMLElement}
 */
function buildCard(team, venue, score, fdr) {
  const card = document.createElement('article');
  card.className = `matchup-card matchup-card--${score.band}`;
  if (score.provisional) card.classList.add('matchup-card--provisional');

  const provisionalClass = score.provisional ? ' score-pill--provisional' : '';
  const confLowClass     = score.provisional ? ' confidence-indicator--low' : '';
  const confPct          = Math.round(score.confidence * 100);

  card.innerHTML = `
    <header class="matchup-card__header">
      <h2 class="matchup-card__team">${esc(team.name)}</h2>
      <span class="matchup-card__venue">${esc(venue)}</span>
    </header>

    <div class="matchup-card__score-row">
      <div class="score-pill score-pill--${esc(score.band)}${provisionalClass}">
        <span class="score-pill__value">${Math.round(score.value)}</span>
        <span class="score-pill__band">${esc(score.band)}</span>
      </div>
      <div class="fdr-comparison">
        <span class="fdr-comparison__label">FPL FDR</span>
        <span class="fdr-comparison__value" data-fdr="${esc(String(fdr))}">${esc(String(fdr))}</span>
        <span class="fdr-comparison__scale">/ 5</span>
      </div>
      <div class="confidence-indicator${confLowClass}">
        <span class="confidence-indicator__label">Confidence</span>
        <span class="confidence-indicator__value">${confPct}%</span>
      </div>
    </div>

    <div class="matchup-card__breakdown">
      <h3 class="matchup-card__section-title">Score Breakdown</h3>
      ${buildBreakdownRows(score.breakdown)}
    </div>

    <div class="matchup-card__counter">
      <h3 class="matchup-card__section-title">Counter-Matchup Pairings</h3>
      ${buildCounterPairings(score.breakdown.counterMatchup.pairings)}
    </div>
  `;

  return card;
}

// ─── Build: breakdown rows ────────────────────────────────────────────────────

/**
 * Build the six sub-metric breakdown rows as an HTML string.
 * Each row: label | bar (width = value%) | value | weight% | est?
 * Bar colour keys off the metric value's own band for at-a-glance diagnosis.
 */
function buildBreakdownRows(breakdown) {
  return METRIC_ORDER.map(key => {
    const m       = breakdown[key];
    const val     = Math.round(m.value);
    const pct     = Math.round(m.weight * 100);
    const barBand = bandFromValue(val);
    const estMark = m.estimated
      ? '<span class="breakdown-row__est" title="Estimated — limited data">~</span>'
      : '';
    const rowClass = m.estimated ? ' breakdown-row--estimated' : '';

    return `
      <div class="breakdown-row${rowClass}">
        <span class="breakdown-row__label">${esc(METRIC_LABELS[key])}</span>
        <div class="breakdown-row__bar-wrap">
          <div class="breakdown-row__bar breakdown-row__bar--${barBand}" style="width:${val}%"></div>
        </div>
        <span class="breakdown-row__value">${val}</span>
        <span class="breakdown-row__weight">${pct}%</span>
        ${estMark}
      </div>
    `.trim();
  }).join('');
}

// ─── Build: counter-matchup pairings ─────────────────────────────────────────

/**
 * Build the three position-pairing rows (FWD vs CB, Wide MID vs FB, CAM vs CB+DM).
 * Attack/defence form values are null when no player summaries are loaded —
 * displayed as "—" and flagged estimated until Phase 2 lazy-loads summaries.
 */
function buildCounterPairings(pairings) {
  return Object.entries(pairings).map(([key, p]) => {
    const val        = Math.round(p.value);
    const chipBand   = bandFromValue(val);
    const atkDisplay = p.attackForm  !== null ? Math.round(p.attackForm)  : '—';
    const defDisplay = p.defenceForm !== null ? Math.round(p.defenceForm) : '—';
    const label      = esc(PAIRING_LABELS[key] ?? key);
    const estMark    = p.estimated
      ? '<span class="counter-pairing__est" title="Estimated — no player form loaded">~</span>'
      : '';
    const rowClass   = p.estimated ? ' counter-pairing--estimated' : '';

    return `
      <div class="counter-pairing${rowClass}">
        <span class="counter-pairing__label">${label}</span>
        <span class="score-chip score-chip--${chipBand} counter-pairing__score">${val}</span>
        <span class="counter-pairing__detail">Atk ${esc(String(atkDisplay))} / Def ${esc(String(defDisplay))}</span>
        ${estMark}
      </div>
    `.trim();
  }).join('');
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onDataReady() {
  const upcoming = getUpcomingFixtures();
  if (upcoming.length === 0) {
    showStatus('No upcoming fixtures found.');
    return;
  }
  // Default to the first upcoming fixture if none selected yet or stale id.
  if (!_selectedFixtureId || !store.getFixture(_selectedFixtureId)) {
    _selectedFixtureId = upcoming[0].id;
  }
  renderPicker(upcoming);
  renderMatchup();
}

function onHorizonChanged() {
  // Phase 1: scoreFixture doesn't use the horizon — single fixture always shown.
  // Re-render so the UI reacts to the event; Phase 2A swaps in scoreOverHorizon.
  // TODO(phase-2): replace renderMatchup() with a horizon-aware aggregate call.
  if (store.isFresh() && _selectedFixtureId) {
    renderMatchup();
  }
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the matchup module. Called once from main.js on bootstrap.
 * Caches DOM references, registers store subscriptions, and triggers an
 * immediate render if the season is already in memory (hydrated from cache).
 */
export function initMatchup() {
  const root = document.querySelector('[data-module="matchup"]');
  _controls  = root.querySelector('.matchup-controls');
  _grid      = root.querySelector('.matchup-grid');

  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
