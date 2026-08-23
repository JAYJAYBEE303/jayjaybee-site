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
import {
  BANDS, HORIZONS, WEIGHTS, FORM_WINDOW_GWS, CHANNEL_MATURITY_FULL_MATCHES,
} from '../config.js';
import { buildScoreContext, scoreFixture, scoreOverHorizon } from '../engine/composite.js';
import {
  calcIndividualDuels, calcCounterMatchupMirrored, duelsForPairing,
} from '../engine/counter.js';
import { invert, clamp } from '../util.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const METRIC_LABELS = {
  // Suffixed — the ONE row where a high number means a tougher opponent, not a
  // better fixture (see the label's title= tooltip and buildBreakdownRows()).
  baseDifficulty: 'Base FPL Difficulty',
  counterMatchup: 'Counter-Matchup',
  teamForm:       'Team Form',
  homeAway:       'Home/Away Split',
  history:        'H2H History',
  // styleClash:  'Style Clash',   // removed — see WEIGHTS in config.js.
  //   METRIC_ORDER derives from these keys, so dropping the label drops the row.
};

// Tiebreak for metrics on equal weight (teamForm and history are both 0.15).
// Read as "which is more worth reading first", and only ever consulted when
// WEIGHTS cannot separate two rows.
const METRIC_TIEBREAK = [
  'baseDifficulty', 'counterMatchup', 'teamForm', 'history', 'homeAway',
];

// Heaviest metric first. DERIVED from WEIGHTS rather than written out, so a
// reweighting in config.js reorders the card automatically — the previous
// hand-maintained list had already drifted (homeAway at 5% sat above styleClash
// at 10%, back when that metric existed), which is exactly the failure this
// removes.
const METRIC_ORDER = Object.keys(METRIC_LABELS).sort((a, b) =>
  (WEIGHTS[b] - WEIGHTS[a])
  || (METRIC_TIEBREAK.indexOf(a) - METRIC_TIEBREAK.indexOf(b)));

// Metrics whose weight ramps up with evidence, and the count each needs before
// it carries its full configured weight. The breakdown shows a "n/N" counter
// against these until they get there.
//
// The two units are NOT the same and the tooltips say so: teamForm's is an
// exact count of matches played, while counterMatchup's ramp is driven by a
// SHOT count (CHANNEL_MATURITY_FULL_SHOTS) that this expresses as its
// match-equivalent — a high-volume side arrives sooner than a low-volume one.
const MATURITY_THRESHOLDS = {
  teamForm:       FORM_WINDOW_GWS,
  counterMatchup: CHANNEL_MATURITY_FULL_MATCHES,
};

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
  // Channel tier (engine/channel.js). These are threat-profile axes rather
  // than position pairings, so they read as phases of play, not matchups.
  setPieceThreat: 'Set Pieces',
  wideTransition: 'Transition Speed',
  boxThreat:      'Box Occupation',
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
  setPieceDefence:   'Set-Piece Defence',
  transitionDefence: 'Transition Defence',
  boxDefence:        'Box Defence',
};

// ─── Module-level state ───────────────────────────────────────────────────────

let _nav      = null;   // .gw-nav container (from HTML)
let _grid     = null;   // .matchup-grid container (from HTML)
let _teamNav  = null;   // .team-nav container (from HTML) — mirrors _nav, one team at a time
let _selectedFixtureId = null;
let _navGroups = [];    // [{ gw, fixtures }] currently loaded into the navigator
let _navIndex  = 0;     // index into _navGroups the navigator is showing
let _teams     = [];    // all teams, alphabetical by name — _teamIndex steps through this
let _teamIndex = 0;     // index into _teams the team navigator is showing; wraps both ends
let _teamNavDescending = false; // true = off-season fallback (recent played, not upcoming)

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
    leagueXgHistory: store.getLeagueXgHistory(),
    teamXgBySlug: store.getAllTeamXg(),
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

// ─── Render: GW navigator ─────────────────────────────────────────────────────

/**
 * Load fixtures (grouped by GW) into the navigator and point it at whichever
 * group contains the currently selected fixture. Re-runs on every data refresh,
 * same trigger renderPicker used to have.
 * @param {Fixture[]} fixtures
 * @param {{ descending?: boolean }} [opts]  descending=true for off-season played list
 */
function renderNav(fixtures, { descending = false } = {}) {
  _navGroups = groupByGw(fixtures, { descending });
  const idx = _navGroups.findIndex(g => g.fixtures.some(f => f.id === _selectedFixtureId));
  _navIndex = idx >= 0 ? idx : 0;
  buildNavPanel();
}

/**
 * Build one <li class="gw-nav__fixture"> row — badge–shortname either side of
 * a centred dash, with composite .score-chip(s) flush at the row's outer
 * edges. Used by buildNavPanel (GW-grouped, side-by-side comparison of both
 * teams). buildTeamNavPanel has its own row builder (buildTeamFixtureRow,
 * below) — a team-nav row already fixes which team the list belongs to, so
 * repeating that team's own badge/name in every row would be redundant.
 * @param {Fixture} f
 * @param {object|null} ctx     from buildCtx() — passed through to navScoreChip
 * @returns {string}  '' if either side's team record is missing
 */
function buildFixtureRow(f, ctx) {
  const home = store.getTeam(f.homeTeamId);
  const away = store.getTeam(f.awayTeamId);
  if (!home || !away) return '';
  const selected = f.id === _selectedFixtureId ? ' is-selected' : '';

  // Each side's own CompositeScore.value/band (same values buildCard's
  // .score-pill shows) — reused here as .score-chip so the navigator gives
  // an at-a-glance read of both teams' fixtures without opening the card.
  const homeChip = navScoreChip(home, f, ctx);
  const awayChip = navScoreChip(away, f, ctx);

  return `
    <li class="gw-nav__fixture${selected}" data-fixture-id="${f.id}" tabindex="0"
        role="button" aria-pressed="${f.id === _selectedFixtureId}"
        aria-label="${esc(`${home.name} vs ${away.name}`)}">
      ${homeChip}
      <span class="gw-nav__team gw-nav__team--home">
        <img class="gw-nav__badge" src="${esc(home.badgeUrl)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="gw-nav__short">${esc(home.shortName)}</span>
      </span>
      <span class="gw-nav__dash" aria-hidden="true">–</span>
      <span class="gw-nav__team gw-nav__team--away">
        <span class="gw-nav__short">${esc(away.shortName)}</span>
        <img class="gw-nav__badge" src="${esc(away.badgeUrl)}" alt="" onerror="this.style.visibility='hidden'">
      </span>
      ${awayChip}
    </li>
  `.trim();
}

/**
 * Render the .gw-nav panel for the GW group at _navIndex: a prev/next header
 * (arrows hidden — not merely disabled — at the ends of the navigable list,
 * per the `hidden` attribute honoured globally in base.css) and one row per
 * fixture, badge–shortname either side of a centred dash. Rebuilt wholesale
 * on every nav interaction — cheap, mirrors buildCard's approach, and keeps
 * the selected-row highlight trivial to recompute.
 */
function buildNavPanel() {
  const group = _navGroups[_navIndex];
  if (!group) {
    _nav.innerHTML = '';
    return;
  }

  const isFirst = _navIndex === 0;
  const isLast  = _navIndex === _navGroups.length - 1;

  // One shared context for every row's composite score below — buildCtx()
  // rebuilds from the full store/season each call, so it must not run per row.
  const ctx = buildCtx();

  const rows = group.fixtures.map(f => buildFixtureRow(f, ctx)).join('');

  _nav.innerHTML = `
    <div class="gw-nav__header">
      <button class="gw-nav__arrow gw-nav__arrow--prev" type="button"
              aria-label="Previous gameweek"${isFirst ? ' hidden' : ''}>‹</button>
      <span class="gw-nav__title">Gameweek ${esc(String(group.gw))}</span>
      <button class="gw-nav__arrow gw-nav__arrow--next" type="button"
              aria-label="Next gameweek"${isLast ? ' hidden' : ''}>›</button>
    </div>
    <ul class="gw-nav__list">${rows}</ul>
  `;
}

/**
 * Build one .score-chip for a nav row: `team`'s own CompositeScore.value for
 * `fixture`, coloured by its band — same source (scoreFixture) and same
 * markup/classes buildCounterPairings' pairing chips use, just plugged into
 * the navigator instead of a breakdown row. Returns '' (renders nothing) if
 * ctx isn't ready yet, so a mid-load navigator still draws its rows.
 * @param {Team} team
 * @param {Fixture} fixture
 * @param {object|null} ctx  from buildCtx()
 */
function navScoreChip(team, fixture, ctx) {
  if (!ctx) return '';
  const score = scoreFixture(team, fixture, ctx);
  const estClass = score.provisional ? ' score-chip--estimated' : '';
  return `<span class="score-chip score-chip--${esc(score.band)}${estClass} gw-nav__score"
                title="${esc(`${team.name}'s Gaffer IQ score for this fixture`)}">${Math.round(score.value)}</span>`;
}

/** Step the navigator to the previous GW group, if any. */
function navPrev() {
  if (_navIndex <= 0) return;
  _navIndex -= 1;
  buildNavPanel();
}

/** Step the navigator to the next GW group, if any. */
function navNext() {
  if (_navIndex >= _navGroups.length - 1) return;
  _navIndex += 1;
  buildNavPanel();
}

/** Select a fixture from a navigator row click and re-render the matchup. */
function selectFixtureFromNav(fixtureId) {
  if (fixtureId === _selectedFixtureId) return;
  _selectedFixtureId = fixtureId;
  renderMatchup();
  buildNavPanel();
  buildTeamNavPanel();
}

/**
 * Delegated click handler for the .gw-nav panel (bound once in initMatchup —
 * the panel persists across renders, only its innerHTML is replaced).
 */
function onNavClick(e) {
  if (e.target.closest('.gw-nav__arrow--prev')) { navPrev(); return; }
  if (e.target.closest('.gw-nav__arrow--next')) { navNext(); return; }
  const row = e.target.closest('.gw-nav__fixture[data-fixture-id]');
  if (row) selectFixtureFromNav(Number(row.dataset.fixtureId));
}

/** Keyboard equivalent of onNavClick for the focusable fixture rows. */
function onNavKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.gw-nav__fixture[data-fixture-id]');
  if (!row) return;
  e.preventDefault();
  selectFixtureFromNav(Number(row.dataset.fixtureId));
}

// ─── Render: team navigator ───────────────────────────────────────────────────

// How many gameweeks of a team's fixture list to show at once — the full
// 38-game season read as one list; trimmed to a manageable upcoming window.
const TEAM_NAV_GW_LIMIT = 12;

/**
 * Load all teams (alphabetical by name) into the team navigator. Unlike
 * renderNav, this does NOT jump to whichever team owns the selected fixture —
 * per spec it always starts at the first team alphabetically, and only moves
 * when the user steps it. Re-runs on every data refresh (team list rarely
 * changes mid-season, but this stays correct if it ever does); _teamIndex is
 * deliberately left untouched so an in-progress browse survives a refresh.
 * @param {boolean} descending  true in the off-season fallback (onDataReady
 *   found no unplayed fixtures league-wide) — same flag renderNav receives,
 *   so buildTeamNavPanel can switch each team's own window the same way.
 */
function renderTeamNav(descending = false) {
  _teams = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
  _teamNavDescending = descending;
  if (_teamIndex >= _teams.length) _teamIndex = 0;
  buildTeamNavPanel();
}

/**
 * Build one <li class="gw-nav__fixture gw-nav__fixture--team"> row for the
 * team navigator: CompositeScore chip, opponent (badge+name), a single-letter
 * H/A venue indicator, then the GW label — left to right. The navigator's own
 * team is already fixed by the panel header above, so repeating its badge/
 * name on every row (as the GW nav's side-by-side buildFixtureRow does) would
 * just be the same redundant read twelve times over; only the opponent side
 * is shown here.
 * @param {Fixture} f
 * @param {object|null} ctx  from buildCtx() — passed through to navScoreChip
 * @param {Team} team        the navigator's own team — whichever side of `f`
 *   this is, home/away is read straight off f.homeTeamId (no derived flag).
 * @returns {string}  '' if either side's team record is missing
 */
function buildTeamFixtureRow(f, ctx, team) {
  const home = store.getTeam(f.homeTeamId);
  const away = store.getTeam(f.awayTeamId);
  if (!home || !away) return '';
  const isHome = f.homeTeamId === team.id;
  const opponent = isHome ? away : home;
  const selected = f.id === _selectedFixtureId ? ' is-selected' : '';

  // This team's own CompositeScore.value/band for the fixture — same chip,
  // same band colour scale as every other nav row (see navScoreChip).
  const chip = navScoreChip(team, f, ctx);

  // H/A letter reuses the app's existing green/red status tokens (band-great
  // / band-brutal — same pair .squad-import-status--success/error use in
  // components.css) rather than introducing new colours.
  const venueLetter = isHome ? 'H' : 'A';
  const venueClass = isHome ? 'gw-nav__venue--home' : 'gw-nav__venue--away';

  return `
    <li class="gw-nav__fixture gw-nav__fixture--team${selected}" data-fixture-id="${f.id}" tabindex="0"
        role="button" aria-pressed="${f.id === _selectedFixtureId}"
        aria-label="${esc(`${team.name} vs ${opponent.name}, ${isHome ? 'Home' : 'Away'}, Gameweek ${f.gw}`)}">
      ${chip}
      <span class="gw-nav__team gw-nav__team--away">
        <img class="gw-nav__badge" src="${esc(opponent.badgeUrl)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="gw-nav__short">${esc(opponent.shortName)}</span>
      </span>
      <span class="gw-nav__venue ${venueClass}" aria-hidden="true">${venueLetter}</span>
      <span class="gw-nav__dash" aria-hidden="true">GW ${esc(String(f.gw))}</span>
    </li>
  `.trim();
}

/**
 * Render the .team-nav panel for the team at _teamIndex: a prev/next header
 * (badge + full name, arrows always active — this list loops both ends, see
 * teamNavPrev/teamNavNext) and that team's next TEAM_NAV_GW_LIMIT upcoming
 * fixtures, earliest GW first (or, in the off-season fallback, its most
 * recent TEAM_NAV_GW_LIMIT played ones, latest first — mirrors renderNav's
 * own in-season/off-season split, just scoped to one team instead of the
 * whole league). Uses buildTeamFixtureRow — its own row markup, distinct from
 * the GW navigator's buildFixtureRow (see that function's doc for why).
 */
function buildTeamNavPanel() {
  if (!_teamNav) return;
  const team = _teams[_teamIndex];
  if (!team) {
    _teamNav.innerHTML = '';
    return;
  }

  const ctx = buildCtx();
  const teamFixtures = store.getFixtures()
    .filter(f => (f.homeTeamId === team.id || f.awayTeamId === team.id) && f.gw !== null);

  const fixtures = _teamNavDescending
    ? teamFixtures.filter(f => f.played)
        .sort((a, b) => b.gw - a.gw || (b.kickoff || '').localeCompare(a.kickoff || ''))
        .slice(0, TEAM_NAV_GW_LIMIT)
    : teamFixtures.filter(f => !f.played)
        .sort((a, b) => a.gw - b.gw || (a.kickoff || '').localeCompare(b.kickoff || ''))
        .slice(0, TEAM_NAV_GW_LIMIT);

  const rows = fixtures
    .map(f => buildTeamFixtureRow(f, ctx, team))
    .join('');

  _teamNav.innerHTML = `
    <div class="gw-nav__header">
      <button class="gw-nav__arrow gw-nav__arrow--prev" type="button"
              aria-label="Previous team">‹</button>
      <span class="gw-nav__title gw-nav__title--team">
        <img class="gw-nav__badge" src="${esc(team.badgeUrl)}" alt="" onerror="this.style.visibility='hidden'">
        ${esc(team.name)}
      </span>
      <button class="gw-nav__arrow gw-nav__arrow--next" type="button"
              aria-label="Next team">›</button>
    </div>
    <ul class="gw-nav__list">${rows}</ul>
  `;
}

/** Step the team navigator to the previous team, wrapping past the first. */
function teamNavPrev() {
  if (_teams.length === 0) return;
  _teamIndex = (_teamIndex - 1 + _teams.length) % _teams.length;
  buildTeamNavPanel();
}

/** Step the team navigator to the next team, wrapping past the last. */
function teamNavNext() {
  if (_teams.length === 0) return;
  _teamIndex = (_teamIndex + 1) % _teams.length;
  buildTeamNavPanel();
}

/**
 * Select a fixture from a team-nav row click. Behaves like selectFixtureFromNav
 * but additionally re-points the GW navigator at the clicked fixture's GW group
 * (mirrors onStripActivate) since, unlike a GW-nav click, the clicked fixture
 * here is very likely outside whatever GW group the left panel is currently
 * showing.
 */
function selectFixtureFromTeamNav(fixtureId) {
  if (fixtureId === _selectedFixtureId) return;
  _selectedFixtureId = fixtureId;
  const idx = _navGroups.findIndex(g => g.fixtures.some(f => f.id === fixtureId));
  if (idx >= 0) _navIndex = idx;
  renderMatchup();
  buildNavPanel();
  buildTeamNavPanel();
}

/**
 * Delegated click handler for the .team-nav panel (bound once in initMatchup —
 * the panel persists across renders, only its innerHTML is replaced).
 */
function onTeamNavClick(e) {
  if (e.target.closest('.gw-nav__arrow--prev')) { teamNavPrev(); return; }
  if (e.target.closest('.gw-nav__arrow--next')) { teamNavNext(); return; }
  const row = e.target.closest('.gw-nav__fixture[data-fixture-id]');
  if (row) selectFixtureFromTeamNav(Number(row.dataset.fixtureId));
}

/** Keyboard equivalent of onTeamNavClick for the focusable fixture rows. */
function onTeamNavKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.gw-nav__fixture[data-fixture-id]');
  if (!row) return;
  e.preventDefault();
  selectFixtureFromTeamNav(Number(row.dataset.fixtureId));
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
      <h2 class="matchup-card__team">
        <img class="matchup-card__badge" src="${esc(team.badgeUrl)}" alt=""
             onerror="this.style.display='none'">
        ${esc(team.name)}
      </h2>
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
 * Each row: label | bar (width = value%) | value | weight%. An estimated
 * metric (m.estimated) is flagged by the striped/muted bar and dimmed label
 * alone (breakdown-row--estimated / breakdown-row__bar--estimated) — no
 * separate "~" marker, per the no-symbol convention on this page.
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
/**
 * Tooltip for the Counter-Matchup breakdown row. Explains the attack/defence
 * blend and, while the channel profiles are still filling in, why the row is
 * carrying less than its configured 20%.
 *
 * @param {object} m  breakdown.counterMatchup
 * @returns {string}  plain text, escaped by the caller
 */
function counterMatchupTooltip(m) {
  if (typeof m.value !== 'number') {
    return 'No Understat shot data published for these teams yet, so this metric '
         + 'is not scoring and contributes nothing to the total. The rows below '
         + 'will fill in once matches have been played.';
  }
  const blend = `Blend of Attacking Counters (${Math.round(m.attackingValue)} — this team's `
    + `attack vs the opponent's defence) and Defending Counters (${Math.round(m.defendingValue)} `
    + `— this team's defence vs the opponent's attack). See the sections below for the `
    + `pairing-level detail.`;
  const maturity = m.maturity ?? 1;
  if (maturity >= 1) return blend;
  return `${blend} Built on ${Math.round(maturity * 100)}% of a full season's shot data, `
    + `so it currently carries ${Math.round((m.effectiveWeight ?? m.weight) * 100)}% of the `
    + `score rather than its full ${Math.round(m.weight * 100)}%.`;
}

/**
 * Progress toward a ramping metric's full weight, or null when there is none to
 * show — either the metric doesn't ramp, or it has already arrived.
 *
 * Derived from `maturity` rather than from a raw game count, so the counter and
 * the weight the engine actually applied can never disagree: both read the same
 * number.
 *
 * ROUNDS, and this matters. Flooring under-reported by up to a whole unit
 * across the entire range: a team one match in carries ~13 of the 120 shots
 * counterMatchup needs, which is 1.08 tenths of the window — floor made that
 * read "0/10" when a match had plainly been played. The clamp to `total - 1`
 * handles the other end, so a metric at 96% cannot round up to "10/10" and
 * claim a completeness it hasn't reached; that state is only ever reached by
 * `maturity >= 1`, which returns null and hides the counter entirely.
 *
 * @param {string} key
 * @param {object} m  the breakdown entry
 * @returns {{done: number, total: number}|null}
 */
function maturityProgress(key, m) {
  const total = MATURITY_THRESHOLDS[key];
  if (!total) return null;

  // A metric with no maturity field is binary and already at full weight
  // (metricMaturity, engine/composite.js) — nothing to count toward.
  const maturity = typeof m.maturity === 'number' ? clamp(0, 1, m.maturity) : 1;
  if (maturity >= 1) return null;

  return { done: Math.min(total - 1, Math.round(maturity * total)), total };
}

/** Tooltip for the maturity counter, in the unit that metric actually ramps on. */
function maturityTooltip(key, m, progress) {
  const applied = Math.round((m.effectiveWeight ?? m.weight) * 100);
  const full    = Math.round(m.weight * 100);
  const tail = `Carrying ${applied}% of the score so far rather than its full ${full}%; `
    + `the ${full}% on the right is what it builds to, not what it is applying now.`;

  return key === 'teamForm'
    ? `${progress.done} of the ${progress.total} matches this metric reads once the season is `
      + `under way. ${tail}`
    : `About ${progress.done} matches' worth of the shot data this metric needs. Two things make `
      + `that differ from matches played: it ramps on SHOTS, so a team that shoots a lot arrives `
      + `sooner, and it reads BOTH teams — it can only be as well-evidenced as whichever side has `
      + `published less, so a well-covered team still waits on its opponent. ${tail}`;
}

function buildBreakdownRows(breakdown, venue) {
  const rows = METRIC_ORDER.map(key => {
    const m        = breakdown[key];
    const hasValue = typeof m.value === 'number';
    const val      = hasValue ? Math.round(m.value) : null;
    // The weight shown is the metric's CONFIGURED maximum, and it is static —
    // it answers "how much can this row ever matter", which is a property of
    // the model and not of today's data. What a ramping metric is applying
    // right now is carried by the n/N counter beside the label instead, so the
    // two numbers say different things rather than one silently standing in
    // for the other.
    const pct      = Math.round(m.weight * 100);
    const progress = maturityProgress(key, m);
    const barBand  = !hasValue ? 'neutral'
      : key === 'baseDifficulty' ? bandFromValue(invert(m.value)) : bandFromValue(val);
    const rowClass   = m.estimated ? ' breakdown-row--estimated' : '';
    const barEstClass = m.estimated ? ' breakdown-row__bar--estimated' : '';
    const labelTitle = key === 'baseDifficulty'
      ? ' title="Shows the OPPONENT\'s strength — a high number means a tougher opponent for this team. The bar colour reflects how good this fixture is for this team, same as every other row."'
      : key === 'counterMatchup'
      ? ` title="${esc(counterMatchupTooltip(m))}"`
      : key === 'homeAway'
      ? ` title="${esc(homeAwayTooltip(m, venue))}"`
      : '';
    const label = key === 'homeAway'
      ? (venue === 'Home' ? 'Home Advantage' : 'Away Disadvantage')
      : METRIC_LABELS[key];

    // The counter cell is ALWAYS emitted, empty when the metric doesn't ramp or
    // has finished ramping: .breakdown-row is one grid and omitting a cell
    // would shift every later column left by one. An empty span collapses to
    // zero width and cancels its own gap (see .breakdown-row__maturity:empty).
    const counter = progress
      ? `<span class="breakdown-row__maturity" title="${esc(maturityTooltip(key, m, progress))}"
          >${progress.done}/${progress.total}</span>`
      : '<span class="breakdown-row__maturity"></span>';

    return `
      <div class="breakdown-row${rowClass}">
        <span class="breakdown-row__label"${labelTitle}>${esc(label)}</span>
        ${counter}
        <div class="breakdown-row__bar-wrap">
          <div class="breakdown-row__bar breakdown-row__bar--${barBand}${barEstClass}" style="width:${val ?? 0}%"></div>
        </div>
        <span class="breakdown-row__value">${val ?? '—'}</span>
        <span class="breakdown-row__weight">${pct}%</span>
      </div>
    `.trim();
  }).join('');

  // One grid wraps all six rows so the maturity column is a SHARED track — see
  // .breakdown-rows. Without the wrapper each row sizes its own, and the bars
  // step left and right depending on whether that row has a counter.
  return `<div class="breakdown-rows">${rows}</div>`;
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

// styleClash was removed from WEIGHTS (see config.js), so this tooltip has no
// row to attach to. Kept commented rather than deleted: restoring the metric
// means uncommenting this, its METRIC_LABELS entry and the branch in
// buildBreakdownRows.
// /**
//  * Tooltip for the Style Clash breakdown row. Names the rules that actually
//  * moved the number and in which direction, so a user can tell a genuine
//  * stylistic edge from a rounding artefact.
//  *
//  * @param {object} m  breakdown.styleClash
//  * @returns {string}  plain text; the caller escapes it.
//  */
// function styleClashTooltip(m) {
//   if (m.estimated) {
//     return 'Not enough style data for both teams — Understat pressing and '
//       + 'territory numbers are needed for this metric, so it sits at a neutral '
//       + '50 and does not affect the score.';
//   }
//
//   // Biggest movers first; anything under half a point is noise, not a story.
//   const movers = (m.terms || [])
//     .filter(t => Math.abs(t.contribution) >= 0.5)
//     .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
//     .map(t => {
//       const label = STYLE_RULE_LABELS[`${t.axisA}|${t.axisB}`] || `${t.axisA} vs ${t.axisB}`;
//       return `${t.contribution > 0 ? '+' : '−'} ${label}`;
//     });
//
//   const head = 'How these two teams play against each other, scored so the '
//     + 'home and away numbers always total 100.';
//   return movers.length
//     ? `${head} Main factors for this team: ${movers.join(', ')}.`
//     : `${head} No strong stylistic pull either way in this fixture.`;
// }

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
    // A channel-tier pairing has no value until Understat publishes, so the row
    // renders blank rather than as a rounded null (which reads as a real 0).
    const hasValue   = typeof p.value === 'number';
    const val        = hasValue ? Math.round(p.value) : null;
    const valDisplay = !hasValue ? '—' : (p.estimated ? 'N/A' : String(val));
    const chipBand   = (!hasValue || p.estimated) ? 'neutral' : bandFromValue(val);

    // Channel pairings describe SHARES of a team's own xG (0–1), not the 0–100
    // unit-form reads the retired position pairings carried. Rendering a share
    // through the form path printed "Atk NaN / Def NaN" on every channel row.
    const isChannel  = p.attackShare !== undefined;
    const asPct      = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
    const asScore    = (v) => (typeof v === 'number' ? String(Math.round(v)) : '—');
    const atkDisplay = isChannel ? asPct(p.attackShare)  : asScore(p.attackForm);
    const defDisplay = isChannel ? asPct(p.concedeShare) : asScore(p.defenceForm);
    const label      = esc(labels[key] ?? key);
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
  renderNav(fixtures, { descending });
  renderTeamNav(descending);
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
 * Sets the selected fixture and re-renders — the navigator is synced onto the
 * fixture's GW group only when that group is present (it may not be in
 * off-season mode).
 */
function onPlayerSelected({ fixtureId }) {
  if (!store.isFresh() || !fixtureId) return;
  _selectedFixtureId = fixtureId;
  const idx = _navGroups.findIndex(g => g.fixtures.some(f => f.id === fixtureId));
  if (idx >= 0) _navIndex = idx;
  buildNavPanel();
  buildTeamNavPanel();
  renderMatchup();
}

/**
 * Delegated click/keyboard handler for perGw strip cells, bound once on _grid
 * (which persists across renderMatchup() calls — only its innerHTML is
 * replaced) rather than per-cell, since cards are rebuilt on every render.
 * Reads data-fixture-id off the clicked cell, points the navigator at that
 * fixture's GW group, and re-renders — same jump-through renderPicker's
 * dispatched 'change' used to drive. Cells with no data-fixture-id (blank
 * GWs) are inert.
 */
function onStripActivate(e) {
  const cell = e.target.closest('.pgw-cell[data-fixture-id]');
  if (!cell || !_grid.contains(cell)) return;
  const fixtureId = Number(cell.dataset.fixtureId);
  if (!fixtureId) return;

  const idx = _navGroups.findIndex(g => g.fixtures.some(f => f.id === fixtureId));
  if (idx < 0) return;

  _navIndex = idx;
  selectFixtureFromNav(fixtureId);
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
  _nav       = root.querySelector('.gw-nav');
  _grid      = root.querySelector('.matchup-grid');
  _teamNav   = root.querySelector('.team-nav');

  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);
  store.subscribe('player:selected', onPlayerSelected);

  // Delegated on _nav (stable across renders) rather than per-row/button —
  // the header arrows and fixture rows are torn down and rebuilt on every
  // buildNavPanel() call.
  _nav.addEventListener('click',   onNavClick);
  _nav.addEventListener('keydown', onNavKeydown);

  // Same delegation pattern as _nav, for the team navigator.
  _teamNav.addEventListener('click',   onTeamNavClick);
  _teamNav.addEventListener('keydown', onTeamNavKeydown);

  // Delegated on _grid (stable across renders) rather than per-cell — the
  // perGw strip cells are torn down and rebuilt on every renderMatchup().
  _grid.addEventListener('click',   onStripActivate);
  _grid.addEventListener('keydown', onStripKeydown);

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
