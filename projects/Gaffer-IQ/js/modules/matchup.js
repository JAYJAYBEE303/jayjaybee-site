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
import { BANDS, HORIZONS } from '../config.js';
import { buildScoreContext, scoreFixture, scoreOverHorizon } from '../engine/composite.js';
import { calcIndividualDuels, calcCounterMatchupMirrored } from '../engine/counter.js';
import { invert } from '../util.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const METRIC_LABELS = {
  // Suffixed — the ONE row where a high number means a tougher opponent, not a
  // better fixture (see the label's title= tooltip and buildBreakdownRows()).
  baseDifficulty: 'Base Difficulty (opponent strength)',
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

// Attacking pairing labels. Covers both the role-mode keys (stVsCb/wmVsFb/
// cmVsCbDm — Phase 3C, active whenever ICT data is available) and the
// element-fallback keys (fwdVsCb/wideMidVsFb/camVsCbMid — Phase 1, active
// when it isn't). Previously only the fallback keys were mapped, so the
// role-mode pairings (the common case) silently rendered raw camelCase keys.
const PAIRING_LABELS = {
  stVsCb:      'ST/SS vs CB',
  wmVsFb:      'Wide MID vs FB',
  cmVsCbDm:    'CM/SS vs CB+DM',
  fwdVsCb:     'FWD vs CB',
  wideMidVsFb: 'Wide MID vs FB',
  camVsCbMid:  'CAM vs CB+DM',
};

// Defending mirror of PAIRING_LABELS — same units, defender-first phrasing.
// Keys must match MIRRORED_PAIRING_KEYS in engine/counter.js.
const DEFENDING_PAIRING_LABELS = {
  cbVsSt:      'CB vs ST/SS',
  fbVsWm:      'FB vs Wide MID',
  cbDmVsCm:    'CB+DM vs CM/SS',
  cbVsFwd:     'CB vs FWD',
  fbVsWideMid: 'FB vs Wide MID',
  cbMidVsCam:  'CB+DM vs CAM',
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
 * Passes all cached player summaries so calcPlayerForm uses real per-GW data
 * for any player whose element-summary has been lazily loaded.
 */
function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    currentGw: store.getCurrentGw() ?? store.getNextGw() ?? 1,
  });
}

/** Upcoming (unplayed) fixtures with a real GW assigned, sorted by GW then kickoff. */
function getUpcomingFixtures() {
  return store.getFixtures().filter(f => !f.played && f.gw !== null);
}

/**
 * Off-season fallback: the most recent `limit` played fixtures, GW descending.
 * Used when no upcoming fixtures exist (e.g. between seasons).
 */
function getRecentPlayedFixtures(limit = 20) {
  return store.getFixtures()
    .filter(f => f.played && f.gw !== null)
    .sort((a, b) => b.gw - a.gw || (b.kickoff || '').localeCompare(a.kickoff || ''))
    .slice(0, limit);
}

/**
 * Group a fixture array by GW.
 * @param {Fixture[]} fixtures
 * @param {{ descending?: boolean }} [opts]  descending=true for off-season played list
 * @returns {{ gw: number, fixtures: Fixture[] }[]}
 */
function groupByGw(fixtures, { descending = false } = {}) {
  const map = new Map();
  for (const f of fixtures) {
    const list = map.get(f.gw) ?? [];
    list.push(f);
    map.set(f.gw, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => descending ? b - a : a - b)
    .map(([gw, fixturesInGw]) => ({ gw, fixtures: fixturesInGw }));
}

// ─── Render: fixture picker ───────────────────────────────────────────────────

/**
 * Populate the .matchup-controls bar with a labelled <select> containing
 * fixtures grouped by GW. Re-builds the picker on data refresh.
 * @param {Fixture[]} fixtures
 * @param {{ descending?: boolean }} [opts]
 */
function renderPicker(fixtures, { descending = false } = {}) {
  _controls.innerHTML = '';

  const label = document.createElement('label');
  label.className = 'fixture-picker__label';
  label.htmlFor = 'fixture-picker';
  label.textContent = 'Select fixture';

  const select = document.createElement('select');
  select.id = 'fixture-picker';
  select.className = 'fixture-picker';

  for (const { gw, fixtures: gwFixtures } of groupByGw(fixtures, { descending })) {
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
 * Each card shows the single-fixture breakdown plus the team's horizon aggregate
 * strip (perGw coloured cells) so the horizon switcher produces visible updates.
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

  const horizonKey = store.getActiveHorizon();
  const horizon    = HORIZONS[horizonKey] ?? HORIZONS.GW1;

  const homeScore        = scoreFixture(homeTeam, fixture, ctx);
  const awayScore        = scoreFixture(awayTeam, fixture, ctx);
  const homeHorizonScore = scoreOverHorizon(homeTeam, horizon, ctx);
  const awayHorizonScore = scoreOverHorizon(awayTeam, horizon, ctx);

  // Phase 4-2: per-team individual duels. Each call scores team A's attackers
  // against team B's likely defenders — asymmetric, mirrors calcCounterMatchup.
  // Returns [] when player summaries / ICT data aren't sufficient; buildCard
  // simply omits the section in that case.
  const homeDuels = calcIndividualDuels(homeTeam, awayTeam, ctx);
  const awayDuels = calcIndividualDuels(awayTeam, homeTeam, ctx);

  // Defending Counters: the SAME attack-vs-defence pairing as the other card's
  // Attacking Counters, re-read from the defending side (100 - value, by
  // construction — see calcCounterMatchupMirrored). Home's defence faced away's
  // attack, so home's mirror comes from awayScore's attacking pairings, and
  // vice versa.
  const homeDefending = calcCounterMatchupMirrored(awayScore.breakdown.counterMatchup);
  const awayDefending = calcCounterMatchupMirrored(homeScore.breakdown.counterMatchup);

  _grid.innerHTML = '';
  _grid.appendChild(
    buildCard(homeTeam, 'Home', homeScore, fixture.fplDifficulty.home, homeHorizonScore, horizon, homeDuels, homeDefending),
  );
  _grid.appendChild(
    buildCard(awayTeam, 'Away', awayScore, fixture.fplDifficulty.away, awayHorizonScore, horizon, awayDuels, awayDefending),
  );
}

/** Render a status message spanning the full grid width. */
function showStatus(msg) {
  _grid.innerHTML = `<p class="matchup-status">${esc(msg)}</p>`;
}

// ─── Build: perGw horizon strip ───────────────────────────────────────────────

/**
 * Build a row of coloured cells, one per scoreOverHorizon perGw entry.
 * Blank GWs render as '–' with a neutral colour; DGWs produce two adjacent cells.
 */
function buildPerGwStrip(perGw) {
  if (!perGw || perGw.length === 0) return '';
  const cells = perGw.map(entry => {
    const bandClass = entry.isBlank ? 'neutral' : entry.band;
    const label = entry.isBlank
      ? `GW${entry.gw} (blank)`
      : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}`;
    const display = entry.isBlank ? '–' : Math.round(entry.value);
    return `<div class="pgw-cell pgw-cell--${esc(bandClass)}" title="${esc(label)}">${esc(String(display))}</div>`;
  }).join('');
  return `<div class="pgw-strip">${cells}</div>`;
}

// ─── Build: matchup card ──────────────────────────────────────────────────────

/**
 * Build and return a <article> DOM node for one team's side of the matchup.
 * Shows: single-fixture CompositeScore breakdown + horizon aggregate strip
 * + (Phase 4-2) collapsible individual duels section when available.
 *
 * @param {Team}           team
 * @param {'Home'|'Away'}  venue
 * @param {CompositeScore} score         from scoreFixture — single fixture detail
 * @param {number}         fdr           official FPL difficulty rating 1–5
 * @param {object}         horizonScore  from scoreOverHorizon — multi-GW aggregate
 * @param {{label:string, gws:number}} horizon  active horizon config
 * @param {Array}          duels         from calcIndividualDuels — may be [] when
 *                                       summaries / ICT data aren't loaded
 * @param {{pairings: Object, estimated: boolean}} defending
 *   from calcCounterMatchupMirrored — this team's defence vs the opponent's
 *   attack, derived from the opponent's own attacking pairings.
 * @returns {HTMLElement}
 */
function buildCard(team, venue, score, fdr, horizonScore, horizon, duels, defending) {
  const card = document.createElement('article');
  card.className = `matchup-card matchup-card--${score.band}`;
  if (score.provisional) card.classList.add('matchup-card--provisional');

  const provisionalClass = score.provisional ? ' score-pill--estimated' : '';
  const confLowClass     = score.provisional ? ' confidence-indicator--low' : '';
  const confPct          = Math.round(score.confidence * 100);

  // Horizon section: show aggregate score + perGw strip when horizon > GW1.
  const showHorizonSection = horizonScore && horizon && horizon.gws > 1;
  const horizonBand        = horizonScore?.band ?? 'neutral';
  const horizonValue       = horizonScore ? Math.round(horizonScore.value) : '—';
  const horizonSection     = showHorizonSection
    ? `
    <div class="matchup-card__horizon">
      <h3 class="matchup-card__section-title">${esc(horizon.label)} Outlook</h3>
      <div class="horizon-summary">
        <span class="score-chip score-chip--${esc(horizonBand)} horizon-summary__score">${horizonValue}</span>
        <span class="horizon-summary__label">${esc(horizonBand)}</span>
      </div>
      ${buildPerGwStrip(horizonScore.perGw)}
    </div>
    `
    : '';

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
      ${buildBreakdownRows(score.breakdown, venue)}
    </div>

    <div class="matchup-card__counter">
      <h3 class="matchup-card__section-title">Attacking Counters</h3>
      ${buildCounterPairings(score.breakdown.counterMatchup.pairings, PAIRING_LABELS, 'attacking')}
    </div>

    <div class="matchup-card__counter">
      <h3 class="matchup-card__section-title">Defending Counters</h3>
      ${buildCounterPairings(defending.pairings, DEFENDING_PAIRING_LABELS, 'defending')}
    </div>

    ${buildIndividualDuels(duels)}

    ${horizonSection}
  `;

  return card;
}

// ─── Build: breakdown rows ────────────────────────────────────────────────────

/**
 * Build the six sub-metric breakdown rows as an HTML string.
 * Each row: label | bar (width = value%) | value | weight% | est?
 * Bar colour keys off the metric value's own band for at-a-glance diagnosis.
 *
 * baseDifficulty is a documented exception (FEATURE_ENGINE.md §1 rule 2, §2):
 * it is STORED as the opponent's strength — higher = HARDER for the team being
 * scored — because that is the number this row displays (e.g. "Man City: 80"
 * regardless of who they're facing). Every other row's stored value is already
 * higher = better for the team, so bandFromValue() colours it correctly as-is.
 * Applying that same higher-is-good banding to baseDifficulty's raw value would
 * colour a brutal fixture green — invert() before banding (display value is
 * untouched) so the colour means the same thing on every row: green = good for
 * this team, red = bad for this team.
 *
 * @param {object} breakdown  the CompositeScore.breakdown object
 * @param {'Home'|'Away'} venue  which side of the fixture this card is for
 */
function buildBreakdownRows(breakdown, venue) {
  return METRIC_ORDER.map(key => {
    const m       = breakdown[key];
    const val     = Math.round(m.value);
    const pct     = Math.round(m.weight * 100);
    const barBand = key === 'baseDifficulty' ? bandFromValue(invert(m.value)) : bandFromValue(val);
    const estMark = m.estimated
      ? '<span class="breakdown-row__est" title="Estimated — limited data">~</span>'
      : '';
    const rowClass   = m.estimated ? ' breakdown-row--estimated' : '';
    const barEstClass = m.estimated ? ' breakdown-row__bar--estimated' : '';
    const labelTitle = key === 'baseDifficulty'
      ? ' title="Shows the OPPONENT\'s strength — a high number means a tougher opponent for this team. The bar colour reflects how good this fixture is for this team, same as every other row."'
      : '';
    const label = key === 'homeAway'
      ? (venue === 'Home' ? 'Home Advantage' : 'Away Disadvantage')
      : METRIC_LABELS[key];

    return `
      <div class="breakdown-row${rowClass}">
        <span class="breakdown-row__label"${labelTitle}>${esc(label)}</span>
        <div class="breakdown-row__bar-wrap">
          <div class="breakdown-row__bar breakdown-row__bar--${barBand}${barEstClass}" style="width:${val}%"></div>
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
 * Build position-pairing rows for either the Attacking Counters section
 * (pairings from calcCounterMatchup) or the Defending Counters section
 * (pairings from calcCounterMatchupMirrored — same units, value = 100 - the
 * attacking pairing's, by construction, see engine/counter.js).
 * Attack/defence form values are null when no player summaries are loaded —
 * displayed as "—" and flagged estimated until Phase 2 lazy-loads summaries.
 *
 * @param {Object} pairings
 * @param {Object} labels       PAIRING_LABELS or DEFENDING_PAIRING_LABELS
 * @param {'attacking'|'defending'} perspective
 *   'attacking': detail line reads "Atk X / Def Y" (attacker's own card).
 *   'defending': detail line reads "Def X / Atk Y" — defender's form leads,
 *   since this section is framed as "my defence vs their attack".
 */
function buildCounterPairings(pairings, labels, perspective) {
  return Object.entries(pairings).map(([key, p]) => {
    const val        = Math.round(p.value);
    const chipBand   = bandFromValue(val);
    const atkDisplay = p.attackForm  !== null ? Math.round(p.attackForm)  : '—';
    const defDisplay = p.defenceForm !== null ? Math.round(p.defenceForm) : '—';
    const label      = esc(labels[key] ?? key);
    const estMark    = p.estimated
      ? '<span class="counter-pairing__est" title="Estimated — no player form loaded">~</span>'
      : '';
    const rowClass   = p.estimated ? ' counter-pairing--estimated' : '';
    const detail     = perspective === 'defending'
      ? `Def ${esc(String(defDisplay))} / Atk ${esc(String(atkDisplay))}`
      : `Atk ${esc(String(atkDisplay))} / Def ${esc(String(defDisplay))}`;

    return `
      <div class="counter-pairing${rowClass}">
        <span class="counter-pairing__label">${label}</span>
        <span class="score-chip score-chip--${chipBand} counter-pairing__score">${val}</span>
        <span class="counter-pairing__detail">${detail}</span>
        ${estMark}
      </div>
    `.trim();
  }).join('');
}

// ─── Build: individual duels (Phase 4-2) ─────────────────────────────────────

/**
 * Build a collapsible <details> block listing the top individual player-vs-player
 * duels. Supplementary to the position-group pairings above — both render, the
 * duels complement the aggregate read. Renders nothing when duels is empty
 * (no summaries / no ICT data classification) so the section gracefully
 * degrades to position-group only.
 */
function buildIndividualDuels(duels) {
  if (!duels || duels.length === 0) return '';

  const rows = duels.map(d => {
    const atkForm = Math.round(d.attacker.formValue);
    const defForm = Math.round(d.defender.formValue);
    const score   = Math.round(d.duelScore);
    return `
      <div class="individual-duel">
        <span class="individual-duel__attacker">
          ${esc(d.attacker.name)}
          <span class="individual-duel__form">${atkForm}</span>
        </span>
        <span class="individual-duel__vs">vs</span>
        <span class="individual-duel__defender">
          ${esc(d.defender.name)}
          <span class="individual-duel__form">${defForm}</span>
        </span>
        <span class="score-chip score-chip--${esc(d.band)} individual-duel__score">${score}</span>
      </div>
    `.trim();
  }).join('');

  return `
    <details class="matchup-card__duels">
      <summary class="matchup-card__duels-summary">Individual Duels (top ${duels.length})</summary>
      <div class="individual-duels">${rows}</div>
    </details>
  `;
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onDataReady() {
  let fixtures = getUpcomingFixtures();
  let descending = false;

  if (fixtures.length === 0) {
    // Off-season fallback: no unplayed fixtures exist, show recent played ones.
    fixtures = getRecentPlayedFixtures(20);
    descending = true;
  }

  if (fixtures.length === 0) {
    showStatus('No fixtures found.');
    return;
  }

  // Default to the first fixture in the list (nearest upcoming, or most recent played).
  if (!_selectedFixtureId || !store.getFixture(_selectedFixtureId)) {
    _selectedFixtureId = fixtures[0].id;
  }
  renderPicker(fixtures, { descending });
  renderMatchup();
}

function onHorizonChanged() {
  // Re-render with the new horizon: renderMatchup now calls scoreOverHorizon
  // so the horizon aggregate score and perGw strip update on every switch.
  if (store.isFresh() && _selectedFixtureId) {
    renderMatchup();
  }
}

/**
 * Handle a player:selected event emitted by the Ranker (and any future module)
 * when the user clicks a player row to drill into its matchup breakdown.
 * Sets the selected fixture and re-renders — the picker is synced only when
 * the relevant option is present (it may not be in off-season mode).
 */
function onPlayerSelected({ fixtureId }) {
  if (!store.isFresh() || !fixtureId) return;
  _selectedFixtureId = fixtureId;
  const picker = _controls?.querySelector('.fixture-picker');
  if (picker && picker.querySelector(`option[value="${fixtureId}"]`)) {
    picker.value = String(fixtureId);
  }
  renderMatchup();
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
  store.subscribe('player:selected', onPlayerSelected);

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
