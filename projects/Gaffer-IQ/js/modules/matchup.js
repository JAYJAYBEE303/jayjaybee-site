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
import {
  calcIndividualDuels, calcCounterMatchupMirrored, duelsForPairing,
} from '../engine/counter.js';
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
  'history',
  'homeAway',
  'styleClash',
];

// Attacking pairing labels. Covers both the role-mode keys (stVsCb/wmVsFb/
// cmVsCbDm — Phase 3C, active whenever ICT data is available) and the
// element-fallback keys (fwdVsCb/wideMidVsFb/camVsCbMid — Phase 1, active
// when it isn't). Previously only the fallback keys were mapped, so the
// role-mode pairings (the common case) silently rendered raw camelCase keys.
const PAIRING_LABELS = {
  stVsCb:      'ST vs CB',
  wmVsFb:      'Wingers vs Fullbacks',
  cmVsCbDm:    'CAM vs CDM',
  fwdVsCb:     'FWD vs CB',
  wideMidVsFb: 'Wide MID vs FB',
  camVsCbMid:  'CAM vs CB+DM',
};

// Defending mirror of PAIRING_LABELS — same units, defender-first phrasing.
// Keys must match MIRRORED_PAIRING_KEYS in engine/counter.js.
const DEFENDING_PAIRING_LABELS = {
  cbVsSt:      'CB vs ST',
  fbVsWm:      'Fullbacks vs Wingers',
  cbDmVsCm:    'CDM vs CAM',
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
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgPrev2: store.getLeagueXgPrev2(),
    leagueXgPrev3: store.getLeagueXgPrev3(),
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

  // Each card needs BOTH duel lists: its own for the Attacking Counters info
  // panels, and the opponent's for the Defending Counters ones — a defending
  // pairing is the opponent's attack, so its named players live in their list.
  _grid.innerHTML = '';
  _grid.appendChild(
    buildCard(homeTeam, 'Home', homeScore, fixture.fplDifficulty.home, homeHorizonScore, horizon, homeDuels, homeDefending, awayDuels),
  );
  _grid.appendChild(
    buildCard(awayTeam, 'Away', awayScore, fixture.fplDifficulty.away, awayHorizonScore, horizon, awayDuels, awayDefending, homeDuels),
  );
}

/** Render a status message spanning the full grid width. */
function showStatus(msg) {
  _grid.innerHTML = `<p class="matchup-status">${esc(msg)}</p>`;
}

// ─── Build: perGw horizon strip ───────────────────────────────────────────────

/**
 * Resolve the real fixture id behind one scoreOverHorizon perGw entry, so the
 * strip cell can be clicked through to the full Matchup Analyser breakdown.
 * scoreOverHorizon (engine/composite.js) doesn't carry a fixture id on perGw
 * entries — only gw/opponent shortName/venue — so it's re-derived here from
 * the store rather than touching the engine. Matches on gw + venue + opponent
 * shortName, which is sufficient to disambiguate DGW's two same-gw fixtures
 * (a team can't face the same opponent twice in one gw).
 * @param {Team} team
 * @param {object} entry  one non-blank perGw entry
 * @returns {number|null}
 */
function findFixtureId(team, entry) {
  if (entry.isBlank || !entry.opponent) return null;
  const isHome = entry.venue === 'H';
  const match = store.getFixtures().find(f => {
    if (f.gw !== entry.gw) return false;
    const teamId = isHome ? f.homeTeamId : f.awayTeamId;
    const oppId  = isHome ? f.awayTeamId : f.homeTeamId;
    if (teamId !== team.id) return false;
    return store.getTeam(oppId)?.shortName === entry.opponent;
  });
  return match ? match.id : null;
}

/**
 * Build a row of coloured cells, one per scoreOverHorizon perGw entry.
 * Blank GWs render as '–' with a neutral colour; DGWs produce two adjacent cells.
 * Low-confidence GWs (entry.provisional, same CONFIDENCE_FLOOR-gated flag the
 * top score pill uses — score-pill--estimated) get the same dashed-border
 * treatment here, via pgw-cell--estimated (already used by ranker.js's strip,
 * just not previously wired up on this page).
 *
 * Each non-blank cell also carries the opponent short name + venue as hidden
 * child elements (revealed on hover purely via CSS — see .pgw-cell__extra in
 * components.css) and a data-fixture-id used by the delegated click handler
 * in initMatchup() to jump the fixture picker straight to that matchup.
 * @param {Team} team  the team this strip belongs to — needed to resolve
 *   each entry's fixture id via findFixtureId().
 * @param {Array} perGw
 */
function buildPerGwStrip(team, perGw) {
  if (!perGw || perGw.length === 0) return '';
  const cells = perGw.map(entry => {
    const bandClass  = entry.isBlank ? 'neutral' : entry.band;
    const estClass   = (!entry.isBlank && entry.provisional) ? ' pgw-cell--estimated' : '';
    const fixtureId  = findFixtureId(team, entry);
    const clickClass = fixtureId !== null ? '' : ' pgw-cell--static';
    const idAttr      = fixtureId !== null ? ` data-fixture-id="${fixtureId}"` : '';
    const tabAttr     = fixtureId !== null ? ' tabindex="0"' : '';
    const label = entry.isBlank
      ? `GW${entry.gw} (blank)`
      : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}${entry.provisional ? ' (low confidence)' : ''}`;
    const display  = entry.isBlank ? '–' : Math.round(entry.value);
    const oppText  = entry.isBlank ? '–' : esc(String(entry.opponent ?? '').toUpperCase());
    const venText  = entry.isBlank ? '' : esc(entry.venue ?? '');
    return `<div class="pgw-cell pgw-cell--${esc(bandClass)}${estClass}${clickClass}"${idAttr}${tabAttr} title="${esc(label)}">`
      + `<span class="pgw-cell__score">${esc(String(display))}</span>`
      + `<div class="pgw-cell__extra"><div class="pgw-cell__extra-inner">`
      + `<span class="pgw-cell__opponent">${oppText}</span>`
      + `<span class="pgw-cell__venue">${venText}</span>`
      + `</div></div>`
      + `</div>`;
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
 * @param {Array} oppDuels  the OPPONENT's calcIndividualDuels result. Supplies
 *   the named players behind the Defending Counters rows, since a defending
 *   pairing is the opponent's attack against this team's defence.
 * @returns {HTMLElement}
 */
function buildCard(team, venue, score, fdr, horizonScore, horizon, duels, defending, oppDuels) {
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
      ${buildPerGwStrip(team, horizonScore.perGw)}
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
        <span class="fdr-comparison__label">FPL Fixture Difficulty Rating</span>
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
      ${buildCounterPairings(score.breakdown.counterMatchup.pairings, PAIRING_LABELS, 'attacking', duels)}
    </div>

    <div class="matchup-card__counter">
      <h3 class="matchup-card__section-title">Defending Counters</h3>
      ${buildCounterPairings(defending.pairings, DEFENDING_PAIRING_LABELS, 'defending', oppDuels)}
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
      : key === 'counterMatchup'
      ? ` title="${esc(`Blend of Attacking Counters (${Math.round(m.attackingValue)} — this team's attack vs the opponent's defence) and Defending Counters (${Math.round(m.defendingValue)} — this team's defence vs the opponent's attack). See the sections below for the pairing-level detail.`)}"`
      : key === 'styleClash'
      ? ` title="${esc(styleClashTooltip(m))}"`
      : key === 'homeAway'
      ? ` title="${esc(homeAwayTooltip(m, venue))}"`
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

/**
 * Tooltip for the Home Advantage / Away Disadvantage breakdown row. Names the
 * actual PPG split behind the number, since the displayed value is now a
 * fixture-level effect (both teams' venue sensitivity combined) rather than a
 * standalone read of this team alone — see engine/fixtures.js calcVenueEffect.
 *
 * @param {object} m       breakdown.homeAway
 * @param {'Home'|'Away'} venue
 * @returns {string}       plain text; the caller escapes it.
 */
function homeAwayTooltip(m, venue) {
  if (m.estimated) {
    return 'Not enough games at one or both venues this season for either team '
      + 'to read a reliable home/away split, so this sits at a neutral 50 and '
      + 'does not affect the score.';
  }
  const own = venue === 'Home'
    ? `This team: ${m.homePPG.toFixed(2)} PPG at home vs ${m.awayPPG.toFixed(2)} PPG away.`
    : `This team: ${m.awayPPG.toFixed(2)} PPG away vs ${m.homePPG.toFixed(2)} PPG at home.`;
  return `${own} Combined with the opponent's own split, whichever team shows the bigger `
    + `home/away gap swings this row — home always gets a boost, away always a matching `
    + `penalty, sized by how much venue has mattered for these two teams this season.`;
}

// Plain-English name for each style rule, keyed by the rule's two axes. Kept
// beside the renderer rather than in config.js for the same reason
// PAIRING_LABELS lives here: config holds the model, the module holds the
// wording. A rule with no entry falls back to its raw axis names, so adding a
// STYLE_RULE without touching this map degrades to something readable rather
// than rendering "undefined".
const STYLE_RULE_LABELS = {
  'pressIntensity|buildUpControl':          'press vs their build-up',
  'transitionDirectness|pressIntensity':    'directness vs their press height',
  'territorialThreat|defensiveCompactness': 'territory vs their compactness',
};

/**
 * Tooltip for the Style Clash breakdown row. Names the rules that actually
 * moved the number and in which direction, so a user can tell a genuine
 * stylistic edge from a rounding artefact.
 *
 * @param {object} m  breakdown.styleClash
 * @returns {string}  plain text; the caller escapes it.
 */
function styleClashTooltip(m) {
  if (m.estimated) {
    return 'Not enough style data for both teams — Understat pressing and '
      + 'territory numbers are needed for this metric, so it sits at a neutral '
      + '50 and does not affect the score.';
  }

  // Biggest movers first; anything under half a point is noise, not a story.
  const movers = (m.terms || [])
    .filter(t => Math.abs(t.contribution) >= 0.5)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .map(t => {
      const label = STYLE_RULE_LABELS[`${t.axisA}|${t.axisB}`] || `${t.axisA} vs ${t.axisB}`;
      return `${t.contribution > 0 ? '+' : '−'} ${label}`;
    });

  const head = 'How these two teams play against each other, scored so the '
    + 'home and away numbers always total 100.';
  return movers.length
    ? `${head} Main factors for this team: ${movers.join(', ')}.`
    : `${head} No strong stylistic pull either way in this fixture.`;
}

// ─── Build: counter-matchup pairings ─────────────────────────────────────────

/**
 * Build position-pairing rows for either the Attacking Counters section
 * (pairings from calcCounterMatchup) or the Defending Counters section
 * (pairings from calcCounterMatchupMirrored — same units, value = 100 - the
 * attacking pairing's, by construction, see engine/counter.js).
 * Attack/defence form values are null when no player summaries are loaded —
 * displayed as "—" and flagged estimated until Phase 2 lazy-loads summaries.
 * p.estimated is true only when the fallback path fired (attackForm or
 * defenceForm was null for this pairing) — so the score itself is a coarse
 * team-strength proxy, not a real player-form read. Shown as "N/A" rather
 * than the fallback number, so it doesn't read as a genuine calculated score.
 *
 * Each row is wrapped in a <details> whose summary carries a small "i" button;
 * opening it lists the actual named players behind that pairing's score, via
 * duelsForPairing() over the already-computed calcIndividualDuels result. Same
 * disclosure pattern as the Individual Duels section below — no new interaction
 * model, no new dependency.
 *
 * @param {Object} pairings
 * @param {Object} labels       PAIRING_LABELS or DEFENDING_PAIRING_LABELS
 * @param {'attacking'|'defending'} perspective
 *   'attacking': detail line reads "Atk X / Def Y" (attacker's own card).
 *   'defending': detail line reads "Def X / Atk Y" — defender's form leads,
 *   since this section is framed as "my defence vs their attack".
 * @param {Array} duels  calcIndividualDuels result for the ATTACKING side of
 *   these pairings — own duels for 'attacking', the opponent's for 'defending'.
 */
function buildCounterPairings(pairings, labels, perspective, duels) {
  return Object.entries(pairings).map(([key, p]) => {
    const val        = Math.round(p.value);
    const valDisplay = p.estimated ? 'N/A' : String(val);
    const chipBand   = p.estimated ? 'neutral' : bandFromValue(val);
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
      <details class="counter-pairing-info">
        <summary class="counter-pairing-info__summary">
          <span class="counter-pairing${rowClass}">
            <span class="counter-pairing__label">${label}</span>
            <span class="score-chip score-chip--${chipBand} counter-pairing__score">${esc(valDisplay)}</span>
            <span class="counter-pairing__detail">${detail}</span>
            ${estMark}
          </span>
          <span class="counter-pairing-info__btn" aria-hidden="true"
                title="Show the players behind this pairing">i</span>
        </summary>
        <div class="counter-pairing-info__panel">
          ${buildPairingPlayers(duels, key, perspective)}
        </div>
      </details>
    `.trim();
  }).join('');
}

/**
 * List the named players behind one pairing, newest-style rows reusing the
 * existing .individual-duel classes so the panel matches the Individual Duels
 * section visually.
 *
 * Renders an explicit no-data state rather than blank: duels are empty whenever
 * player summaries or ICT data haven't loaded (pre-season, or before the user
 * has browsed the Ranker), which is a normal condition, not an error.
 *
 * @param {Array} duels                 calcIndividualDuels result, attacking side
 * @param {string} pairingKey
 * @param {'attacking'|'defending'} perspective  controls which side leads the row
 */
function buildPairingPlayers(duels, pairingKey, perspective) {
  const matched = duelsForPairing(duels, pairingKey);

  if (matched.length === 0) {
    return `<p class="counter-pairing-info__empty">No player data available —`
         + ` open some players in the Ranker to load their form, then revisit.</p>`;
  }

  return matched.map(d => {
    const atkForm = Math.round(d.attacker.formValue);
    const defForm = Math.round(d.defender.formValue);
    // Defending sections lead with the defender, matching the score row above it.
    const first  = perspective === 'defending' ? d.defender : d.attacker;
    const second = perspective === 'defending' ? d.attacker : d.defender;
    const firstForm  = perspective === 'defending' ? defForm : atkForm;
    const secondForm = perspective === 'defending' ? atkForm : defForm;

    return `
      <div class="individual-duel">
        <span class="individual-duel__attacker">
          ${esc(first.name)}
          <span class="individual-duel__role">${esc(first.role)}</span>
          <span class="individual-duel__form">${firstForm}</span>
        </span>
        <span class="individual-duel__vs">vs</span>
        <span class="individual-duel__defender">
          ${esc(second.name)}
          <span class="individual-duel__role">${esc(second.role)}</span>
          <span class="individual-duel__form">${secondForm}</span>
        </span>
        <span class="score-chip score-chip--${esc(d.band)} individual-duel__score">${Math.round(d.duelScore)}</span>
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

/**
 * Delegated click/keyboard handler for perGw strip cells, bound once on _grid
 * (which persists across renderMatchup() calls — only its innerHTML is
 * replaced) rather than per-cell, since cards are rebuilt on every render.
 * Reads data-fixture-id off the clicked cell, sets that fixture as the
 * picker's value, and dispatches 'change' — the same event renderPicker()
 * already listens for — so the full matchup re-renders for that fixture.
 * Cells with no data-fixture-id (blank GWs) are inert.
 */
function onStripActivate(e) {
  const cell = e.target.closest('.pgw-cell[data-fixture-id]');
  if (!cell || !_grid.contains(cell)) return;
  const fixtureId = cell.dataset.fixtureId;
  if (!fixtureId) return;

  const picker = _controls?.querySelector('.fixture-picker');
  const option = picker?.querySelector(`option[value="${fixtureId}"]`);
  if (!picker || !option) return;

  picker.value = fixtureId;
  picker.dispatchEvent(new Event('change'));
}

function onStripKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!e.target.closest('.pgw-cell[data-fixture-id]')) return;
  e.preventDefault();
  onStripActivate(e);
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

  // Delegated on _grid (stable across renders) rather than per-cell — the
  // perGw strip cells are torn down and rebuilt on every renderMatchup().
  _grid.addEventListener('click',   onStripActivate);
  _grid.addEventListener('keydown', onStripKeydown);

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
