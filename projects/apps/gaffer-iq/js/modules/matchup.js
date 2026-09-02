/**
 * js/modules/matchup.js
 * Layer: module. Owns the DOM for the Matchup Analyser view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders one fixture from both teams' perspectives — the full CompositeScore
 * breakdown, counter-matchup pairings, confidence, and official FPL FDR comparison.
 * No analytical logic lives here — all scoring delegated to engine/composite.js.
 * See ARCHITECTURE.md §10, FEATURE_ENGINE.md §11, ROADMAP.md Phase 1C.
 *
 * Subscriptions: data:ready, route:changed, player:selected
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import {
  HORIZONS, WEIGHTS, FORM_WINDOW_GWS, CHANNEL_MATURITY_FULL_MATCHES,
  H2H_MEETING_WINDOW, CHIP_RESET_AFTER_GW,
} from '../config.js';
import {
  buildScoreContext, scoreFixture, scoreOverHorizon, bandFromValue,
} from '../engine/composite.js';
import {
  calcIndividualDuels, calcCounterMatchupMirrored, duelsForPairing,
} from '../engine/counter.js';
import { groupPerGwSlots, pendingFixturesForTeam } from '../engine/fixtures.js';
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

// How many gameweeks the Outlook strip at the foot of each card covers.
//
// FIXED HERE rather than read from store.getActiveHorizon(), which the rest of
// the app plans against. Those are two different questions. The active horizon
// prices players in the Ranker and Planner, so its length is a scoring
// decision; this strip just shows a team's run of fixtures, where a longer
// window is only more to look at. Widening the shared horizon to reach 10
// weeks here would silently rescore every player in two other modules.
//
// The strip wraps (.pgw-strip is flex-wrap), so a card too narrow for ten
// slots on one line gets two lines rather than a clipped run.
const MATCHUP_OUTLOOK_HORIZON = HORIZONS.GW10;

// Metrics whose weight ramps up with evidence, and the matches each needs
// before it carries its full configured weight. The breakdown shows an "n/N"
// counter against these until they get there.
//
// Both are now a literal count of matches played, so both counters tick exactly
// once per match. counterMatchup's used to be a shot count expressed as a
// match-equivalent, which meant it could move by 0 or 2 in a week and needed a
// caveat to read correctly — see CHANNEL_MATURITY_FULL_MATCHES in config.js.
const MATURITY_THRESHOLDS = {
  teamForm:       FORM_WINDOW_GWS,
  counterMatchup: CHANNEL_MATURITY_FULL_MATCHES,
};

// Plain-English meaning of each breakdown metric, for the "i" popup beside its
// row. Says what the number describes about an actual match, and names the
// input it is read off — enough for a reader meeting the row for the first
// time to know what they are looking at, without restating the arithmetic.
//
// Every count in the copy is interpolated from config rather than written out:
// the two ramping metrics quote MATURITY_THRESHOLDS (which is why this is
// declared after it) and H2H quotes H2H_MEETING_WINDOW. Those numbers have
// been retuned before, and a sentence that repeats one by hand is a sentence
// that will eventually contradict the n/N counter on its own row.
const METRIC_MEANINGS = {
  baseDifficulty:
    "How strong this opponent is as a side, the way you'd size them up from "
    + 'the league table before kick-off. Fetched by FPL base difficulty value, '
    + 'used as a baseline.',
  counterMatchup:
    'Whether the way this team prefers to attack is the same way this '
    + 'particular opponent tends to concede, and vice-versa. Calculations '
    + 'shown with below attacking/defending counters, requires minimum '
    + `${MATURITY_THRESHOLDS.counterMatchup} games to reach full maturity.`,
  teamForm:
    'How well the team has actually been playing in its recent matches '
    + 'relative to the strength of the sides faced (e.g. W/A strong sides & '
    + 'L/A weak sides count more than W/A weak sides & L/A strong sides). '
    + `Requires minimum ${MATURITY_THRESHOLDS.teamForm} games to reach full `
    + 'maturity.',
  history:
    'Head to head history. Calculated by the percentage of the total possible '
    + `points won over the last ${H2H_MEETING_WINDOW} meetings.`,
  // One text for both venues: the sentence describes the DIFFERENCE between
  // the two sides' home/away records, which reads the same way from either
  // card. The popup's title still says "Home Advantage" or "Away
  // Disadvantage", so which side is being described stays clear.
  homeAway:
    "The home/away winrate difference compared with the opposite team's. This "
    + "metric is low weight as it's not a defining factor unless a matchup is "
    + 'relatively close.',
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
/**
 * The PHASE OF PLAY each channel axis describes, as a noun phrase that reads
 * naturally mid-sentence in the "i" panel's explanation.
 *
 * Keyed by both the attacking and the defending key for the same axis, mapping
 * to the SAME phrase: a set piece is a set piece whichever end you read it
 * from. Using the row's own label instead produced "of the xG this team
 * concedes comes through set-piece defence", which is circular — the phase is
 * set pieces, "defence" is the perspective, and the sentence already supplies
 * the perspective.
 */
const CHANNEL_PHASE_NOUN = {
  setPieceThreat:    'set pieces',
  wideTransition:    'fast transitions',
  boxThreat:         'chances inside the box',
  setPieceDefence:   'set pieces',
  transitionDefence: 'fast transitions',
  boxDefence:        'chances inside the box',
};

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
// Which team the team-nav list currently on screen belongs to, and how far it
// was scrolled. The panel is rebuilt wholesale on every render — a data
// refresh, a horizon change, any fixture selection — and now that the list is
// the full season it is genuinely scrollable, so without this a reader who
// scrolled to GW30 and clicked a fixture was thrown back to the top of the
// list by their own click. Restored only when the SAME team is being redrawn;
// stepping to a different team is a new list and starts at the top.
let _teamNavRenderedTeamId = null;
let _teamNavScrollTop = 0;
let _pendingRender = false;     // data changed while off screen — render on activation

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Is every input to `team`'s score for this fixture in yet?
 *
 * A CompositeScore blends counter-matchup, which cannot be computed until BOTH
 * teams' Understat payloads have landed in the boot-time prefetch — so a score
 * shown before then is provisional and will rewrite itself when they do. This
 * is the test behind every skeleton on this page: both sides of the fixture,
 * not just the card's own team, because the metric reads the pairing.
 *
 * @param {Fixture} fixture
 * @returns {boolean}
 */
function fixtureScoreSettled(fixture) {
  if (!fixture) return false;
  return store.isTeamScoreSettled(fixture.homeTeamId)
      && store.isTeamScoreSettled(fixture.awayTeamId);
}

/**
 * Is one scoreOverHorizon perGw entry's score final?
 *
 * The entry names its opponent only by short name, so the fixture behind it is
 * re-derived through findFixtureId — the same resolution the strip already
 * does to make its cells clickable. An entry whose fixture cannot be resolved
 * is treated as settled: there is no team pair to wait on, so a skeleton there
 * would never clear.
 *
 * @param {Team} team   the team the strip belongs to
 * @param {object} entry  one perGw entry
 * @returns {boolean}
 */
function perGwEntrySettled(team, entry) {
  const fixtureId = findFixtureId(team, entry);
  if (fixtureId === null) return true;
  return fixtureScoreSettled(store.getFixture(fixtureId));
}

/**
 * Skeleton stand-in for a .score-chip.
 *
 * Composed onto the real chip class and given placeholder digits rather than
 * built from scratch, so it occupies the settled chip's exact footprint and
 * the number drops in without shifting the row — see the SKELETON block in
 * components.css for the composition rules.
 * @param {string} extraClass  additional classes the real chip would carry
 *   (e.g. 'gw-nav__score'), so the placeholder sits in the same slot.
 */
function skeletonChip(extraClass = '') {
  const cls = extraClass ? ` ${extraClass}` : '';
  return `<span class="score-chip skeleton${cls}" aria-hidden="true"
                title="Still calculating — waiting on this fixture's counter-matchup data">00</span>`;
}

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
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
    currentGw: store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
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
  // Per FIXTURE, not per row: the counter-matchup component reads both sides,
  // so one team's payload still being in flight leaves BOTH chips on the row
  // provisional. Deciding this per chip would settle one side early and let it
  // move again when its opponent's payload landed.
  if (!fixtureScoreSettled(fixture)) return skeletonChip('gw-nav__score');
  const score = scoreFixture(team, fixture, ctx);
  const estClass = score.provisional ? ' score-chip--estimated' : '';
  return `<span class="score-chip score-chip--${esc(bandFromValue(score.value))}${estClass} gw-nav__score"
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

// The team navigator lists a team's ENTIRE remaining season, not a window.
//
// It used to stop at 12 gameweeks. That is past the point where the panel is
// useful for the thing it is for: a transfer or a chip is a bet on a run of
// fixtures, and a cap turns "what does the rest of the season look like for
// this team" into "what does it look like until the list happens to stop",
// with nothing on screen to say a cap is why. There is no cheap way for the
// reader to tell a team whose run ends at GW24 from one whose list was simply
// truncated there.
//
// The cost is length — up to 38 rows — which is handled by scrolling the list
// inside a fixed-height panel rather than by hiding rows (.gw-nav__list in
// components.css). A scrollbar states the list is longer than the viewport;
// a silent slice states nothing.

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
 * Do two gameweeks sit on opposite sides of the chip reset?
 *
 * Asked of ADJACENT ROWS rather than looked up per gameweek, which is what
 * makes it hold for a team with no fixture in GW19 or GW20: the hairline lands
 * between whichever two weeks actually straddle the boundary. It is also
 * direction-agnostic, so it works just as well on the off-season list, which
 * runs latest-first.
 *
 * @param {number} a  the previous row's gameweek
 * @param {number} b  this row's gameweek
 */
function crossesChipReset(a, b) {
  return (a <= CHIP_RESET_AFTER_GW) !== (b <= CHIP_RESET_AFTER_GW);
}

// The hairline itself. role="separator" rather than aria-hidden: the line
// carries meaning, so the label is the only way a screen reader gets it.
const CHIP_RESET_DIVIDER =
  `<li class="gw-nav__chip-reset" role="separator"`
  + ` aria-label="Chips reset after Gameweek ${CHIP_RESET_AFTER_GW}"`
  + ` title="FPL chips reset after Gameweek ${CHIP_RESET_AFTER_GW}"></li>`;

/**
 * Render the .team-nav panel for the team at _teamIndex: a prev/next header
 * (badge + full name, arrows always active — this list loops both ends, see
 * teamNavPrev/teamNavNext) and ALL of that team's remaining fixtures,
 * earliest GW first (or, in the off-season fallback, all of its played ones,
 * latest first — mirrors renderNav's own in-season/off-season split, just
 * scoped to one team instead of the whole league). Uncapped by design; the
 * list scrolls inside the panel instead. Uses buildTeamFixtureRow — its own
 * row markup, distinct from the GW navigator's buildFixtureRow (see that
 * function's doc for why).
 */
function buildTeamNavPanel() {
  if (!_teamNav) return;
  const team = _teams[_teamIndex];
  if (!team) {
    _teamNav.innerHTML = '';
    _teamNavRenderedTeamId = null;
    return;
  }

  // Read the outgoing list's scroll offset BEFORE the innerHTML below destroys
  // it. Only meaningful when the same team is being redrawn — see the
  // declarations of these two.
  const previousList = _teamNav.querySelector('.gw-nav__list');
  const sameTeam     = _teamNavRenderedTeamId === team.id;
  if (previousList && sameTeam) _teamNavScrollTop = previousList.scrollTop;
  else if (!sameTeam)           _teamNavScrollTop = 0;

  const ctx = buildCtx();
  const teamFixtures = store.getFixtures()
    .filter(f => (f.homeTeamId === team.id || f.awayTeamId === team.id) && f.gw !== null);

  const fixtures = _teamNavDescending
    ? teamFixtures.filter(f => f.played)
        .sort((a, b) => b.gw - a.gw || (b.kickoff || '').localeCompare(a.kickoff || ''))
    : teamFixtures.filter(f => !f.played)
        .sort((a, b) => a.gw - b.gw || (a.kickoff || '').localeCompare(b.kickoff || ''));

  // Built in a loop rather than .map().join('') so the chip-reset hairline can
  // be pushed BETWEEN two rows. prevGw tracks the last row actually rendered,
  // not the last fixture considered — buildTeamFixtureRow returns '' when a
  // team record is missing, and a divider hung off a row that never rendered
  // would land in the wrong place.
  const rows = [];
  let prevGw = null;
  for (const f of fixtures) {
    const row = buildTeamFixtureRow(f, ctx, team);
    if (!row) continue;
    if (prevGw !== null && crossesChipReset(prevGw, f.gw)) rows.push(CHIP_RESET_DIVIDER);
    rows.push(row);
    prevGw = f.gw;
  }

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
    <ul class="gw-nav__list gw-nav__list--scroll">${rows.join('')}</ul>
  `;

  _teamNavRenderedTeamId = team.id;
  const list = _teamNav.querySelector('.gw-nav__list');
  // Assigning a scrollTop past the new content's height is harmless — the
  // browser clamps it — so a list that shrank between renders simply lands at
  // its own bottom rather than needing a bounds check here.
  if (list && _teamNavScrollTop > 0) list.scrollTop = _teamNavScrollTop;
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
 * Each card shows the single-fixture breakdown plus the team's Outlook strip
 * (perGw coloured cells) over MATCHUP_OUTLOOK_HORIZON — the run of fixtures
 * ahead of that team, independent of the horizon the rest of the app scores on.
 * All scoring delegated to engine/composite.js — no metric logic here.
 */
function renderMatchup() {
  const ctx = buildCtx();
  if (!ctx || !_selectedFixtureId) {
    showLoading();
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

  const horizon = MATCHUP_OUTLOOK_HORIZON;

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
  // One flag for both cards: the counter-matchup metric is a pairing, so the
  // two sides settle together or not at all. Everything downstream of it — the
  // score pill, its confidence, the counter sections — is skeletoned until
  // then rather than printed and quietly rewritten.
  const settled = fixtureScoreSettled(fixture);

  _grid.innerHTML = '';
  _grid.appendChild(
    buildCard(homeTeam, 'Home', homeScore, fixture.fplDifficulty.home, homeHorizonScore, horizon, homeDuels, homeDefending, awayDuels, settled),
  );
  _grid.appendChild(
    buildCard(awayTeam, 'Away', awayScore, fixture.fplDifficulty.away, awayHorizonScore, horizon, awayDuels, awayDefending, homeDuels, settled),
  );
}

/** Render a status message spanning the full grid width. */
function showStatus(msg) {
  _grid.innerHTML = `<p class="matchup-status">${esc(msg)}</p>`;
}

/**
 * The pre-data state of the grid: two placeholder cards, one per team.
 *
 * Distinct from showStatus, which is for VERDICTS — "Fixture not found",
 * "No fixtures found" — that the reader should act on. A line of muted text
 * saying "Loading…" looked like one of those, and left the two-column layout
 * empty until the moment it filled. Placeholder cards say the same thing in
 * the shape the answer will arrive in.
 */
function showLoading() {
  const card = `
    <article class="matchup-card matchup-card--neutral" aria-busy="true">
      <div class="skeleton-lines">
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text"></span>
      </div>
    </article>`;
  _grid.innerHTML = card + card;
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
function buildPerGwStrip(team, perGw, pending = []) {
  const slots = groupPerGwSlots(perGw);
  if (slots.length === 0) return '';

  const slotHtml = slots.map(slot => {
    const cells = slot.fixtures.map(entry => {
      const bandClass  = entry.isBlank ? 'neutral' : bandFromValue(entry.value);
      const estClass   = (!entry.isBlank && entry.provisional) ? ' pgw-cell--estimated' : '';
      const blkClass   = entry.isBlank ? ' pgw-cell--blank' : '';
      const tbcClass   = entry.provisionalKickoff ? ' pgw-cell--tbc' : '';
      const fixtureId  = findFixtureId(team, entry);
      const clickClass = fixtureId !== null ? '' : ' pgw-cell--static';
      const idAttr      = fixtureId !== null ? ` data-fixture-id="${fixtureId}"` : '';
      const tabAttr     = fixtureId !== null ? ' tabindex="0"' : '';

      // A cell whose fixture is still waiting on either team's Understat
      // payload renders as a skeleton rather than a number that will change.
      // Judged per cell, not per strip, so the gameweeks that ARE final stay
      // readable while the rest fill in — and the reader can see exactly which
      // ones are still moving. Blanks are exempt: '∅' is a known fact about
      // the schedule, not a score, so nothing about it is pending.
      if (!entry.isBlank && fixtureId !== null && !fixtureScoreSettled(store.getFixture(fixtureId))) {
        // Keeps the row's click target and its GW label — only the VALUE is
        // withheld — so the strip stays navigable while it settles.
        return `<div class="pgw-cell skeleton${clickClass}"${idAttr}${tabAttr}`
          + ` title="${esc(`GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — still calculating`)}">`
          + `<span class="pgw-cell__score">00</span></div>`;
      }

      const label = entry.isBlank
        ? `GW${entry.gw} — blank (no fixture)`
        : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}`
          + `${entry.provisional ? ' (low confidence)' : ''}`
          + `${entry.provisionalKickoff ? ' — kickoff TBC' : ''}`;
      // '∅' rather than '–' — a dash reads as missing data, and a blank
      // gameweek is a known fact. Matches the Ranker's strip.
      const display  = entry.isBlank ? '∅' : Math.round(entry.value);
      const oppText  = entry.isBlank ? '–' : esc(String(entry.opponent ?? '').toUpperCase());
      const venText  = entry.isBlank ? '' : esc(entry.venue ?? '');
      return `<div class="pgw-cell pgw-cell--${esc(bandClass)}${estClass}${blkClass}${tbcClass}${clickClass}"${idAttr}${tabAttr} title="${esc(label)}">`
        + `<span class="pgw-cell__score">${esc(String(display))}</span>`
        + `<div class="pgw-cell__extra"><div class="pgw-cell__extra-inner">`
        + `<span class="pgw-cell__opponent">${oppText}</span>`
        + `<span class="pgw-cell__venue">${venText}</span>`
        + `</div></div>`
        + `</div>`;
    }).join('');

    const dblClass = slot.isDouble ? ' pgw-slot--double' : '';
    const dblMark  = slot.isDouble ? ' ··' : '';
    return `<div class="pgw-slot${dblClass}">`
      + `<div class="pgw-slot__cells">${cells}</div>`
      + `<div class="pgw-slot__label">${esc(String(slot.gw))}${dblMark}</div>`
      + `</div>`;
  }).join('');

  const pendingHtml = pending.length > 0
    ? `<div class="pgw-pending" title="${pending.length} postponed fixture${pending.length > 1 ? 's' : ''} awaiting a rearranged date">+${pending.length} TBD</div>`
    : '';

  // The .pgw-strip wrapper stays: components.css lays the strip out through it.
  // The slot wrappers do not break the delegated click handler — it matches on
  // closest('.pgw-cell[data-fixture-id]'), and the cells still carry both the
  // class and the attribute, so the extra nesting is transparent to it.
  return `<div class="pgw-strip">${slotHtml}${pendingHtml}</div>`;
}

// ─── Build: matchup card ──────────────────────────────────────────────────────

/**
 * Build and return a <article> DOM node for one team's side of the matchup.
 * Shows: single-fixture CompositeScore breakdown + horizon aggregate strip
 *
 * @param {Team}           team
 * @param {'Home'|'Away'}  venue
 * @param {CompositeScore} score         from scoreFixture — single fixture detail
 * @param {number}         fdr           official FPL difficulty rating 1–5
 * @param {object}         horizonScore  from scoreOverHorizon — multi-GW aggregate
 * @param {{label:string, gws:number}} horizon  the Outlook window
 *   (MATCHUP_OUTLOOK_HORIZON) — supplies both the section title and its length
 * @param {Array}          duels         from calcIndividualDuels — may be [] when
 *                                       summaries / ICT data aren't loaded
 * @param {{pairings: Object, estimated: boolean}} defending
 *   from calcCounterMatchupMirrored — this team's defence vs the opponent's
 *   attack, derived from the opponent's own attacking pairings.
 * @param {Array} oppDuels  the OPPONENT's calcIndividualDuels result. Supplies
 *   the named players behind the Defending Counters rows, since a defending
 *   pairing is the opponent's attack against this team's defence.
 * @param {boolean} settled  false while either team's Understat payload is
 *   still in flight, in which case every figure downstream of counter-matchup
 *   renders as a skeleton. NOT the same thing as `score.provisional`, which
 *   says the settled score rests on thin evidence — a permanent property of
 *   this week's data that the reader should act on. `settled` says the number
 *   is not finished arriving and is about to change on its own.
 * @returns {HTMLElement}
 */
function buildCard(team, venue, score, fdr, horizonScore, horizon, duels, defending, oppDuels, settled = true) {
  const card = document.createElement('article');
  // Band colour comes off the score, so an unsettled card would otherwise be
  // tinted by a number it is not yet showing — and would re-tint when the real
  // one landed. Neutral until settled: the card states its verdict once.
  card.className = `matchup-card matchup-card--${settled ? bandFromValue(score.value) : 'neutral'}`;
  if (settled && score.provisional) card.classList.add('matchup-card--provisional');
  if (!settled) card.setAttribute('aria-busy', 'true');

  const provisionalClass = (settled && score.provisional) ? ' score-pill--estimated' : '';
  const confLowClass     = (settled && score.provisional) ? ' confidence-indicator--low' : '';
  const confPct          = Math.round(score.confidence * 100);

  // Horizon section: show aggregate score + perGw strip when horizon > GW1.
  const showHorizonSection = horizonScore && horizon && horizon.gws > 1;
  // The aggregate reads EVERY gameweek in the window, so it is only final once
  // every opponent across that window has settled — a stricter test than this
  // card's own fixture, and the reason it is derived here rather than reusing
  // `settled`. The strip below makes the same judgement cell by cell, so a
  // reader can see which gameweeks are still landing.
  const horizonSettled = showHorizonSection
    && horizonScore.perGw.every(entry => entry.isBlank || perGwEntrySettled(team, entry));
  const horizonBand        = horizonSettled && horizonScore
    ? bandFromValue(horizonScore.value) : 'neutral';
  const horizonValue       = horizonScore ? Math.round(horizonScore.value) : '—';
  const horizonChip        = horizonSettled
    ? `<span class="score-chip score-chip--${esc(horizonBand)} horizon-summary__score">${horizonValue}</span>`
    : skeletonChip('horizon-summary__score');
  const horizonLabel       = horizonSettled
    ? `<span class="horizon-summary__label">${esc(horizonBand)}</span>`
    : '<span class="horizon-summary__label skeleton" aria-hidden="true">settling</span>';
  const horizonSection     = showHorizonSection
    ? `
    <div class="matchup-card__horizon">
      <h3 class="matchup-card__section-title">${esc(horizon.label)} Outlook</h3>
      <div class="horizon-summary">
        ${horizonChip}
        ${horizonLabel}
      </div>
      ${buildPerGwStrip(team, horizonScore.perGw, pendingFixturesForTeam(team.id, store.getSeason()))}
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
      ${settled ? `
      <div class="score-pill score-pill--${esc(bandFromValue(score.value))}${provisionalClass}">
        <span class="score-pill__value">${Math.round(score.value)}</span>
        <span class="score-pill__band">${esc(bandFromValue(score.value))}</span>
      </div>` : `
      <div class="score-pill skeleton" aria-hidden="true"
           title="Still calculating — waiting on this fixture's counter-matchup data">
        <span class="score-pill__value">00</span>
        <span class="score-pill__band">settling</span>
      </div>`}
      <div class="fdr-comparison">
        <span class="fdr-comparison__label">FPL Fixture Difficulty Rating</span>
        <span class="fdr-comparison__value" data-fdr="${esc(String(fdr))}">${esc(String(fdr))}</span>
        <span class="fdr-comparison__scale">/ 5</span>
      </div>
      <div class="confidence-indicator${confLowClass}">
        <span class="confidence-indicator__label">Confidence</span>
        ${settled
          ? `<span class="confidence-indicator__value">${confPct}%</span>`
          : '<span class="confidence-indicator__value skeleton" aria-hidden="true">00%</span>'}
      </div>
    </div>

    <div class="matchup-card__breakdown">
      <h3 class="matchup-card__section-title">Score Breakdown</h3>
      ${buildBreakdownRows(score.breakdown, venue, settled)}
    </div>

    <div class="matchup-card__counter">
      <h3 class="matchup-card__section-title">Attacking Counters</h3>
      ${buildCounterPairings(score.breakdown.counterMatchup.pairings, PAIRING_LABELS, 'attacking', duels, settled)}
    </div>

    <div class="matchup-card__counter">
      <h3 class="matchup-card__section-title">Defending Counters</h3>
      ${buildCounterPairings(defending.pairings, DEFENDING_PAIRING_LABELS, 'defending', oppDuels, settled)}
    </div>

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
 * Both ramps now count matches, so `maturity * total` lands on a whole number
 * and the rounding is exact rather than approximate. It is kept as `round`
 * rather than `floor` because floating-point division leaves values like
 * 0.8 * 5 = 4.000000000000001 and 3/5 * 5 = 2.9999999999999996 — floor turns
 * the second into 2. The clamp to `total - 1` guards the top: a metric at 96%
 * must not round up to "10/10" and claim a completeness it has not reached.
 * That display is unreachable anyway, since `maturity >= 1` hides the counter.
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
    : `${progress.done} of the ${progress.total} matches this metric needs for full confidence. `
      + `It reads BOTH teams, so this counts whichever side has played fewer — a team several `
      + `matches in still waits on a newly promoted opponent. ${tail}`;
}

/**
 * The "i" affordance at the right edge of a breakdown row, and the popup it
 * opens: a plain-English note saying what the metric describes about a real
 * match and where its number comes from.
 *
 * Built as a <details> for the same reason the counter pairings are — the open
 * state is the browser's, so nothing here has to track it — and, like them,
 * absolutely positioned rather than in flow: these rows are compact single
 * lines, and pushing them apart to reveal a sentence would move every number
 * the reader was comparing.
 *
 * The <summary> itself carries the button styling (rather than wrapping a span,
 * as .counter-pairing-info__btn does) so the affordance is the focusable
 * element and the popup can be opened from the keyboard. Closing it again is
 * wired by hand — closeMetricInfo for an outside click, onMetricInfoKeydown
 * for Escape; <details> has neither.
 *
 * @param {string} key            metric key
 * @param {'Home'|'Away'} venue   which side of the fixture this card is for
 * @returns {string} HTML — the button and its popup, or an empty grid cell for
 *   a metric with no explanation on file
 */
function buildMetricInfo(key, venue) {
  const text = METRIC_MEANINGS[key];
  // An unexplained metric still emits the cell — .breakdown-rows is one shared
  // grid, so a missing cell would pull every later row's columns out of phase.
  if (!text) return '<span class="breakdown-row__info"></span>';

  const label = key === 'homeAway'
    ? (venue === 'Home' ? 'Home Advantage' : 'Away Disadvantage')
    : METRIC_LABELS[key];

  return `
    <details class="breakdown-row__info">
      <summary class="breakdown-row__info-btn"
               title="What does ${esc(label)} mean?"
               aria-label="What does ${esc(label)} mean?">i</summary>
      <div class="breakdown-row__info-pop" role="note">
        <span class="breakdown-row__info-title">${esc(label)}</span>
        <p class="breakdown-row__info-text">${esc(text)}</p>
      </div>
    </details>
  `.trim();
}

/**
 * @param {object} breakdown  CompositeScore.breakdown
 * @param {'Home'|'Away'} venue
 * @param {boolean} settled   false while the Understat team payloads behind
 *   counter-matchup are still in flight. ONLY that row is skeletoned: every
 *   other metric here is computed from bootstrap/fixtures and the league-wide
 *   xG payload, all of which are in hand before data:ready fires, so they are
 *   already final and hiding them would say something untrue about them. The
 *   effect is that the card names which single input the score is waiting on
 *   instead of going blank as a whole.
 */
function buildBreakdownRows(breakdown, venue, settled = true) {
  const rows = METRIC_ORDER.map(key => {
    const m        = breakdown[key];
    const pending  = !settled && key === 'counterMatchup';
    const hasValue = !pending && typeof m.value === 'number';
    const val      = hasValue ? Math.round(m.value) : null;
    // The weight shown is the metric's CONFIGURED maximum, and it is static —
    // it answers "how much can this row ever matter", which is a property of
    // the model and not of today's data. What a ramping metric is applying
    // right now is carried by the n/N counter beside the label instead, so the
    // two numbers say different things rather than one silently standing in
    // for the other.
    const pct      = Math.round(m.weight * 100);
    // The n/N maturity counter is a read of how much evidence the metric has,
    // which is itself one of the things still arriving — so it is withheld
    // alongside the value rather than shown against a skeletoned bar.
    const progress = pending ? null : maturityProgress(key, m);
    const barBand  = !hasValue ? 'neutral'
      : key === 'baseDifficulty' ? bandFromValue(invert(m.value)) : bandFromValue(val);
    const rowClass   = (!pending && m.estimated) ? ' breakdown-row--estimated' : '';
    const barEstClass = (!pending && m.estimated) ? ' breakdown-row__bar--estimated' : '';
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

    // A pending row keeps its label, its weight and its place in the order —
    // only the bar and the number are withheld. The bar fills the whole track
    // as a skeleton rather than sitting at 0% width, because a zero-width bar
    // is itself a reading ("this metric scores nothing") and that is precisely
    // what is not yet known.
    const bar = pending
      ? '<div class="breakdown-row__bar skeleton" aria-hidden="true"></div>'
      : `<div class="breakdown-row__bar breakdown-row__bar--${barBand}${barEstClass}" style="width:${val ?? 0}%"></div>`;
    const value = pending
      ? '<span class="breakdown-row__value skeleton" aria-hidden="true">00</span>'
      : `<span class="breakdown-row__value">${val ?? '—'}</span>`;

    return `
      <div class="breakdown-row${rowClass}"${pending ? ' aria-busy="true"' : ''}>
        <span class="breakdown-row__label"${labelTitle}>${esc(label)}</span>
        ${counter}
        <div class="breakdown-row__bar-wrap">
          ${bar}
        </div>
        ${value}
        <span class="breakdown-row__weight">${pct}%</span>
        ${buildMetricInfo(key, venue)}
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
 * Each row carries a small "i" button at its right edge — a <details> whose
 * <summary> IS the button, opening an overlay popup exactly as the breakdown
 * metrics above do. It gives, in order: an explanation of what the score and
 * the two percentages actually mean (buildPairingExplainer), then the named
 * players behind that pairing via duelsForPairing() over the already-computed
 * calcIndividualDuels result — no new dependency. The popup overlays rather
 * than expanding in flow so opening one does not push the pairings below it
 * down the card, out from under the reader's eye.
 *
 * The explainer was added because the panel previously opened straight onto
 * the player list: it answered "who is involved" but never "what am I looking
 * at", leaving the score and its two percentages undocumented anywhere in the
 * UI. Note buildPairingExplainer is deliberately descriptive rather than
 * directional — see its doc block for why.
 *
 * @param {Object} pairings
 * @param {Object} labels       PAIRING_LABELS or DEFENDING_PAIRING_LABELS
 * @param {'attacking'|'defending'} perspective
 *   'attacking': detail line reads "Atk X / Def Y" (attacker's own card).
 *   'defending': detail line reads "Def X / Atk Y" — defender's form leads,
 *   since this section is framed as "my defence vs their attack".
 * @param {Array} duels  calcIndividualDuels result for the ATTACKING side of
 *   these pairings — own duels for 'attacking', the opponent's for 'defending'.
 * @param {boolean} settled  false while either team's Understat payload is
 *   still in flight. These rows ARE the counter-matchup metric, so every one of
 *   them is provisional until then — unlike the breakdown above, where only
 *   the single counter-matchup row is withheld. The labels and the "i" panels
 *   stay: what a pairing measures is fixed, only what it currently reads is not.
 */
function buildCounterPairings(pairings, labels, perspective, duels, settled = true) {
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
    const rowClass   = (settled && p.estimated) ? ' counter-pairing--estimated' : '';
    const detail     = perspective === 'defending'
      ? `Def ${esc(String(defDisplay))} / Atk ${esc(String(atkDisplay))}`
      : `Atk ${esc(String(atkDisplay))} / Def ${esc(String(defDisplay))}`;

    const scoreCell = settled
      ? `<span class="score-chip score-chip--${chipBand} counter-pairing__score">${esc(valDisplay)}</span>`
      : skeletonChip('counter-pairing__score');
    // The two shares are read straight off the same payload as the score, so
    // they are pending for exactly as long as it is.
    const detailCell = settled
      ? `<span class="counter-pairing__detail">${detail}</span>`
      : '<span class="counter-pairing__detail skeleton" aria-hidden="true">Atk 00% / Def 00%</span>';

    const infoLabel = `What does the ${labels[key] ?? key} pairing mean?`;

    return `
      <div class="counter-pairing-row"${settled ? '' : ' aria-busy="true"'}>
        <span class="counter-pairing${rowClass}">
          <span class="counter-pairing__label">${label}</span>
          ${scoreCell}
          ${detailCell}
        </span>
        <details class="counter-pairing-info">
          <summary class="counter-pairing-info__btn"
                   title="${esc(infoLabel)}"
                   aria-label="${esc(infoLabel)}">i</summary>
          <div class="counter-pairing-info__panel" role="note">
            ${buildPairingExplainer(p, key, perspective, isChannel, hasValue)}
            ${buildPairingPlayers(duels, key, perspective)}
          </div>
        </details>
      </div>
    `.trim();
  }).join('');
}

/**
 * Plain-language explanation of one counter pairing: what the score is, what
 * each of the two percentages measures, and how far into the season the read
 * is. Rendered at the top of the "i" panel, above the named players.
 *
 * WHY THIS EXISTS: the panel used to open straight onto the player list, so
 * the "i" answered "who is involved" but never "what am I looking at" — the
 * score and the two percentages beside it were undocumented anywhere in the
 * UI, which made them read as arbitrary.
 *
 * DELIBERATELY DESCRIPTIVE, NOT DIRECTIONAL. This says what each percentage
 * MEASURES and leaves it there; it does not tell the reader which way a high
 * score should be read. That is not an oversight. `calcChannelCounter` scores
 * an axis as `attackShare - concedeShare`, which rises as the opponent
 * concedes LESS through a channel — the reverse of the "my strength meets
 * their weakness" reading the model comment describes. Until that is settled,
 * an explanation asserting a direction would be documenting behaviour the
 * engine does not have. The two shares themselves are exactly what they say,
 * so those are safe to explain in full.
 *
 * @param {object} p            the pairing (channel tier: attackShare/concedeShare)
 * @param {string} key          pairing key, for CHANNEL_PHASE_NOUN
 * @param {'attacking'|'defending'} perspective
 * @param {boolean} isChannel   channel tier (shares) vs retired position tier
 * @param {boolean} hasValue    false when Understat has not published yet
 */
function buildPairingExplainer(p, key, perspective, isChannel, hasValue) {
  if (!hasValue) {
    return `<p class="counter-pairing-info__note">`
         + `No Understat data for this axis yet — the row fills in once the`
         + ` season's shot data covers it. It contributes nothing to the score`
         + ` until then.</p>`;
  }
  if (!isChannel) return '';   // retired position tier — no shares to explain

  // Whose share is whose depends on which section the row sits in: an
  // Attacking Counters row is this team attacking, a Defending Counters row is
  // this team defending against the opponent's attack.
  const atkPct = `${Math.round(p.attackShare * 100)}%`;
  const defPct = `${Math.round(p.concedeShare * 100)}%`;
  const phase  = esc(CHANNEL_PHASE_NOUN[key] ?? 'this phase of play');
  const rows = perspective === 'defending'
    ? [
        [`Def ${defPct}`, `of the xG <strong>this team concedes</strong> comes from ${phase}.`],
        [`Atk ${atkPct}`, `of the xG <strong>the opponent creates</strong> comes the same way.`],
      ]
    : [
        [`Atk ${atkPct}`, `of the xG <strong>this team creates</strong> comes from ${phase}.`],
        [`Def ${defPct}`, `of the xG <strong>the opponent concedes</strong> comes the same way.`],
      ];

  const personnelNote = (typeof p.personnel === 'number' && p.personnel !== 1)
    ? `<li><span class="counter-pairing-info__term">Availability</span>`
      + `<span>The attacking share is scaled to <strong>${Math.round(p.personnel * 100)}%</strong>`
      + ` to reflect who is actually fit for this fixture.</span></li>`
    : '';

  return `
    <div class="counter-pairing-info__explain">
      <p class="counter-pairing-info__note">
        Both figures are <strong>shares of a team's own xG</strong> —
        <em>expected goals</em>, which rates every shot from 0 to 1 by how likely
        it was to be scored, whether or not it went in. Shares, not volumes:
        they describe <em>how</em> a side scores and concedes, not how much.
      </p>
      <ul class="counter-pairing-info__terms">
        ${rows.map(([term, text]) =>
          `<li><span class="counter-pairing-info__term">${term}</span><span>${text}</span></li>`).join('')}
        ${personnelNote}
      </ul>
      <p class="counter-pairing-info__note">
        The <strong>score</strong> compares those two shares against the spread
        seen across the league on this axis. It is one input to Counter-Matchup,
        which carries ${Math.round(WEIGHTS.counterMatchup * 100)}% of the fixture
        score at full maturity — see the counter beside that row for how much of
        that it has earned so far.
      </p>
    </div>`.trim();
}

/**
 * List the named players behind one pairing, as .individual-duel rows.
 *
 * These panels are now the ONLY place duels are rendered. There used to be a
 * separate "Individual Duels" disclosure at the foot of each card listing the
 * same players again, detached from the pairing that produced them; it was
 * removed because a flat top-N list says nothing the reader can act on once
 * every pairing already names its own players in context.
 *
 * Renders NOTHING when there are no duels to show — see the note at the guard
 * below. Duels are empty whenever player summaries or ICT data haven't loaded
 * (pre-season, or before the user has browsed the Ranker), which is the common
 * case and a normal condition, not an error worth announcing.
 *
 * @param {Array} duels                 calcIndividualDuels result, attacking side
 * @param {string} pairingKey
 * @param {'attacking'|'defending'} perspective  controls which side leads the row
 */
function buildPairingPlayers(duels, pairingKey, perspective) {
  const matched = duelsForPairing(duels, pairingKey);

  // Nothing at all when there are no players to name. This used to render a
  // "not loaded yet — open some players in the Ranker" line, which appeared in
  // EVERY panel (duels need lazily-fetched player summaries, so the common case
  // is empty) and read as a warning about the score. It is not one: the pairing
  // score is computed from team-level shot data and does not use duels at all.
  // A permanent notice about an optional extra was pure noise, so the section
  // is simply absent until it has something to show.
  if (matched.length === 0) return '';

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
        <span class="score-chip score-chip--${esc(bandFromValue(d.duelScore))} individual-duel__score">${Math.round(d.duelScore)}</span>
      </div>
    `.trim();
  }).join('');
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

  // Selecting the fixture above is cheap and keeps the module's state correct
  // off screen; the three renders below are not. Defer them when hidden — see
  // store.js's activeModule note.
  if (store.getActiveModule() !== 'matchup') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;

  renderNav(fixtures, { descending });
  renderTeamNav(descending);
  renderMatchup();
}

/**
 * Flush a render deferred while off screen, once Matchup is shown.
 *
 * Re-enters onDataReady rather than repeating the render calls: the fixture
 * list and its `descending` flag are derived at the top of that function, and
 * duplicating that derivation here is how the two paths would drift apart.
 */
function onRouteChanged(module) {
  if (module !== 'matchup' || !_pendingRender) return;
  _pendingRender = false;
  onDataReady();
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

/** Both "i" popups on the matchup card: breakdown metrics and counter
 *  pairings. They share one dismissal model because they are one interaction —
 *  an overlay footnote anchored to a round "i" at a row's right edge. */
const INFO_POPUPS      = '.breakdown-row__info, .counter-pairing-info';
const INFO_POPUPS_OPEN = '.breakdown-row__info[open], .counter-pairing-info[open]';

/**
 * Close every open "i" popup except the one the click landed inside.
 *
 * Bound on the document rather than on _grid because the whole point is to
 * catch clicks that land ANYWHERE else — the page header, the navigator, the
 * body background. Clicks inside a popup are left alone so text can be
 * selected out of it; clicking the row's own "i" again is left to the browser,
 * which toggles that <details> shut on its own.
 *
 * This also enforces one-at-a-time: opening a second "i" closes the first,
 * since the first does not contain the click.
 *
 * @param {Event} e
 */
function closeMetricInfo(e) {
  const inside = e.target instanceof Element
    ? e.target.closest(INFO_POPUPS)
    : null;
  document.querySelectorAll(INFO_POPUPS_OPEN).forEach(d => {
    if (d !== inside) d.open = false;
  });
}

/** Escape closes an open popup — <details> has no native Escape. */
function onMetricInfoKeydown(e) {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll(INFO_POPUPS_OPEN);
  if (!open.length) return;
  // Focus is on the summary that opened it; leave it there so the reader keeps
  // their place in the row order rather than being dropped at the document top.
  open.forEach(d => { d.open = false; });
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
  store.subscribe('route:changed',   onRouteChanged);
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

  // Metric "i" popups dismiss on any outside click, so the listener has to sit
  // above the module's own DOM. Capture phase: a handler further down that
  // stops propagation (or a re-render that replaces the clicked node before the
  // event bubbles back up) would otherwise leave the popup stranded open.
  document.addEventListener('click',   closeMetricInfo, true);
  document.addEventListener('keydown', onMetricInfoKeydown);

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
