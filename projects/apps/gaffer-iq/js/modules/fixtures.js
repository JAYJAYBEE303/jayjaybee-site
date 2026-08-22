/**
 * js/modules/fixtures.js
 * Layer: module. Owns the DOM for the Fixtures view.
 * Side effects: DOM writes only. Reads nothing from the store yet.
 *
 * STATUS: STRUCTURAL BLUEPRINT. Every value this module renders is a
 * placeholder — no fixture, team, event, lineup or H2H data is read from the
 * store, and no engine function is called. What IS real: the three-mode
 * navigation, the pickers, the pane switching, and the cross-links between
 * modes. The intent is to agree the shape of the view before wiring data.
 *
 * When data is wired, the ONLY functions that should change are the three
 * render*Pane() builders below (plus their row helpers) — every seam is
 * marked `DATA SEAM:`. The layer rules still apply: this file may read the
 * store and call engine/ functions, but must never compute a metric itself
 * (ARCHITECTURE.md §3 hard rule 3, §10).
 *
 * Three modes, switched by .fx-modes__btn:
 *   gameweek  — this GW's fixtures: kickoff times, results, and a per-fixture
 *               disclosure holding match events, both lineups, and an H2H peek.
 *   team      — one team's recent results and upcoming fixtures.
 *   h2h       — full head-to-head history for one pairing.
 *
 * Subscriptions: none yet. See onDataReady() for where 'data:ready' goes.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MODES = ['gameweek', 'team', 'h2h'];

// Blueprint volumes — how many placeholder rows each block draws. Deliberately
// realistic (10 fixtures in a GW, 11 + 4 in a squad, 8 past meetings) so the
// layout is stress-tested at the size it will actually run at.
const SKEL = {
  dayGroups:   3,
  perDay:      [3, 4, 3],
  lineupXi:    11,
  lineupBench: 4,
  eventsHome:  3,
  eventsAway:  2,
  teamRows:    6,
  h2hMeetings: 8,
  trendPips:   6,
};

// Day headings for the gameweek pane's grouping. Real kickoffs group by
// calendar date; these stand in for that grouping so the visual rhythm of a
// split gameweek is visible.
const SKEL_DAYS = ['Friday', 'Saturday', 'Sunday'];

// Status chips a fixture row can carry. Drives both the legend and the
// placeholder rows, so the two can never drift apart.
const STATUS_CHIPS = [
  { key: 'ft',       label: 'FT',   hint: 'Played — final score shown' },
  { key: 'live',     label: 'LIVE', hint: 'In progress — score updates' },
  { key: 'upcoming', label: 'KO',   hint: 'Upcoming — kickoff time shown' },
];

// Stand-in team names for the pickers. DATA SEAM: replaced by
// store.getTeams() sorted by name, with team.id as the option value.
const SKEL_TEAMS = ['Team A', 'Team B', 'Team C', 'Team D', 'Team E', 'Team F'];

// Summary tiles above a team's results/fixtures split.
const TEAM_STATS = ['P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'];

// Event glyphs, in the order they would typically appear in a match feed.
const EVENT_TYPES = [
  { icon: '⚽',    label: 'Goal' },
  { icon: 'Ⓐ',    label: 'Assist' },
  { icon: '\u{1f7e8}', label: 'Yellow card' },
  { icon: '\u{1f7e5}', label: 'Red card' },
  { icon: '⇄',    label: 'Substitution' },
];

const H2H_COLUMNS = ['Date', 'Season', 'Venue', 'Home', 'Score', 'Away', 'Notes'];

// ─── Module-level state ───────────────────────────────────────────────────────

let _root      = null;   // [data-module="fixtures"] section
let _panesWrap = null;   // .fx-panes — stable click-delegation target
let _panes     = {};     // mode key -> .fx-pane element
let _pickers   = {};     // mode key -> .fx-picker element
let _modeBtns  = [];     // .fx-modes__btn nodes
let _mode      = 'gameweek';

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
 * A blank bar standing in for a value that is not wired yet. Width is passed
 * in `ch` so the bar occupies roughly the space the real string will — the
 * only inline style in this module, and one CONVENTIONS.md §5.3 explicitly
 * allows (a computed bar width).
 * @param {number} chars    approximate character width of the eventual value
 * @param {string} [extra]  optional extra class
 */
function ph(chars, extra = '') {
  return `<span class="fx-ph ${esc(extra)}" style="width:${Number(chars)}ch" aria-hidden="true"></span>`;
}

/** Repeat a builder n times and join — the blueprint's whole rendering idiom. */
function times(n, fn) {
  let out = '';
  for (let i = 0; i < n; i++) out += fn(i);
  return out;
}

// ─── Gameweek pane ────────────────────────────────────────────────────────────

/**
 * One team's side of a fixture row: crest slot + name.
 * DATA SEAM: crest becomes the team badge, name becomes team.shortName.
 */
function skelSide(side) {
  return `
    <span class="fx-side fx-side--${side}">
      <span class="fx-crest" aria-hidden="true"></span>
      <span class="fx-side__name">${ph(9)}</span>
    </span>`;
}

/** One line in a match-event feed. DATA SEAM: the fixture's event stream. */
function skelEvent(i) {
  const type = EVENT_TYPES[i % EVENT_TYPES.length];
  return `
    <li class="fx-event">
      <span class="fx-event__min">${ph(3)}</span>
      <span class="fx-event__icon" aria-hidden="true">${type.icon}</span>
      <span class="fx-event__type">${esc(type.label)}</span>
      <span class="fx-event__player">${ph(11)}</span>
    </li>`;
}

/** One player line in a lineup list. DATA SEAM: the fixture's lineup + bench. */
function skelLineupRow() {
  return `
    <li class="fx-lineup__row">
      <span class="fx-lineup__num">${ph(2)}</span>
      <span class="fx-lineup__name">${ph(12)}</span>
      <span class="fx-lineup__pos">${ph(3)}</span>
    </li>`;
}

/** One team's lineup column inside a fixture's detail disclosure. */
function skelLineup(side) {
  return `
    <div class="fx-lineup fx-lineup--${side}">
      <p class="fx-lineup__head">
        <span class="fx-lineup__team">${ph(9)}</span>
        <span class="fx-lineup__formation">${ph(5)}</span>
      </p>
      <ol class="fx-lineup__list">${times(SKEL.lineupXi, skelLineupRow)}</ol>
      <p class="fx-lineup__subhead">Bench</p>
      <ul class="fx-lineup__list fx-lineup__list--bench">${times(SKEL.lineupBench, skelLineupRow)}</ul>
    </div>`;
}

/** Win/draw/loss pips — the compact form strip, reused by both other panes. */
function skelPips(n) {
  const cycle = ['w', 'd', 'l'];
  return `<span class="fx-pips">${
    times(n, i => `<span class="fx-pip fx-pip--${cycle[i % 3]}" aria-hidden="true"></span>`)
  }</span>`;
}

/**
 * The expandable half of a fixture row: events, both lineups, and an H2H peek
 * that deep-links into the h2h mode. Native <details> — no JS toggle needed,
 * the same affordance as the Team ID help disclosure in index.html.
 */
function skelFixtureDetail() {
  return `
    <div class="fx-detail">

      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Match events</h4>
        <div class="fx-detail__cols">
          <ul class="fx-events">${times(SKEL.eventsHome, skelEvent)}</ul>
          <ul class="fx-events fx-events--away">${times(SKEL.eventsAway, skelEvent)}</ul>
        </div>
        <p class="fx-detail__note">Goals, assists, cards and substitutions. Home column left.</p>
      </section>

      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Lineups</h4>
        <div class="fx-detail__cols">
          ${skelLineup('home')}
          ${skelLineup('away')}
        </div>
        <p class="fx-detail__note">Starting XI then bench, with shirt number and position.</p>
      </section>

      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Head-to-head</h4>
        <div class="fx-h2h-mini">
          <span class="fx-h2h-mini__tally">${ph(2)}<em>wins</em></span>
          <span class="fx-h2h-mini__tally">${ph(2)}<em>draws</em></span>
          <span class="fx-h2h-mini__tally">${ph(2)}<em>wins</em></span>
          <span class="fx-h2h-mini__trend">Last ${SKEL.trendPips}${skelPips(SKEL.trendPips)}</span>
        </div>
        <button class="fx-link-btn" type="button" data-fx-open-h2h>Open full head-to-head →</button>
      </section>

    </div>`;
}

/** One fixture row: status, both sides, score-or-kickoff, and the disclosure. */
function skelFixture(i) {
  const status     = STATUS_CHIPS[i % STATUS_CHIPS.length];
  const isUpcoming = status.key === 'upcoming';
  const centre     = isUpcoming
    ? ph(5, 'fx-ph--time')
    : `${ph(1)}<em>–</em>${ph(1)}`;

  return `
    <li class="fx-item">
      <details class="fx-fixture">
        <summary class="fx-fixture__summary">
          <span class="fx-status fx-status--${status.key}" title="${esc(status.hint)}">${esc(status.label)}</span>
          ${skelSide('home')}
          <span class="fx-fixture__centre">
            <span class="fx-fixture__score">${centre}</span>
            <span class="fx-fixture__ko">${ph(11)}</span>
          </span>
          ${skelSide('away')}
          <span class="fx-fixture__venue">${ph(10)}</span>
          <span class="fx-fixture__chev" aria-hidden="true">▾</span>
        </summary>
        ${skelFixtureDetail()}
      </details>
    </li>`;
}

/**
 * DATA SEAM: the gameweek pane. Reads store.getFixtures() for the selected GW,
 * groups by kickoff date, and renders one .fx-item per fixture.
 */
function renderGameweekPane() {
  const legend = STATUS_CHIPS.map(c => `
    <span class="fx-legend__item">
      <span class="fx-status fx-status--${c.key}">${esc(c.label)}</span>${esc(c.hint)}
    </span>`).join('');

  _panes.gameweek.innerHTML = `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title">Gameweek ${ph(2)}</h2>
        <p class="fx-pane__sub">
          <span>Deadline ${ph(14)}</span>
          <span>${ph(16)}</span>
          <span>${ph(2)} fixtures</span>
        </p>
      </div>
      <div class="fx-legend">${legend}</div>
    </header>

    ${times(SKEL.dayGroups, d => `
      <section class="fx-daygroup">
        <h3 class="fx-daygroup__title">
          <span class="fx-daygroup__day">${esc(SKEL_DAYS[d] ?? 'Day')}</span>
          <span class="fx-daygroup__date">${ph(12)}</span>
        </h3>
        <ul class="fx-list">${times(SKEL.perDay[d] ?? 3, skelFixture)}</ul>
      </section>`)}
  `;
}

// ─── Team pane ────────────────────────────────────────────────────────────────

/**
 * One compact row in a team's results/fixtures column.
 * @param {boolean} played  past rows show a score, future rows a kickoff time
 */
function skelTeamRow(played) {
  return `
    <li class="fx-row">
      <span class="fx-row__date">${ph(11)}</span>
      <span class="fx-venue" aria-hidden="true">${ph(1)}</span>
      <span class="fx-row__opp"><span class="fx-crest fx-crest--sm" aria-hidden="true"></span>${ph(9)}</span>
      <span class="fx-row__value">${played ? `${ph(1)}<em>–</em>${ph(1)}` : ph(5)}</span>
      <span class="fx-row__tag">${ph(3)}</span>
    </li>`;
}

/**
 * DATA SEAM: the team pane. Reads the selected team's fixture list, splits on
 * fixture.played, and renders the two columns plus the season summary tiles.
 */
function renderTeamPane() {
  _panes.team.innerHTML = `
    <header class="fx-pane__head fx-pane__head--team">
      <div class="fx-teamhead">
        <span class="fx-crest fx-crest--lg" aria-hidden="true"></span>
        <div class="fx-teamhead__text">
          <h2 class="fx-pane__title" id="fx-team-name">No team selected</h2>
          <p class="fx-pane__sub">
            <span>Position ${ph(3)}</span>
            <span>Form ${skelPips(5)}</span>
            <span>Next ${ph(9)}</span>
          </p>
        </div>
      </div>
      <ul class="fx-stat-row">
        ${TEAM_STATS.map(s => `
          <li class="fx-stat">
            <span class="fx-stat__label">${esc(s)}</span>
            <span class="fx-stat__value">${ph(2)}</span>
          </li>`).join('')}
      </ul>
    </header>

    <div class="fx-two-col">
      <section class="fx-col">
        <h3 class="fx-col__title">Results <span class="fx-col__count">most recent first</span></h3>
        <ul class="fx-list fx-list--compact">${times(SKEL.teamRows, () => skelTeamRow(true))}</ul>
      </section>
      <section class="fx-col">
        <h3 class="fx-col__title">Upcoming <span class="fx-col__count">next ${SKEL.teamRows}</span></h3>
        <ul class="fx-list fx-list--compact">${times(SKEL.teamRows, () => skelTeamRow(false))}</ul>
      </section>
    </div>

    <p class="fx-detail__note">
      Row reads: date · home/away · opponent · score or kickoff · difficulty tag.
      Selecting a row will open that fixture back in the Gameweek view.
    </p>
  `;
}

// ─── Head-to-head pane ────────────────────────────────────────────────────────

/**
 * DATA SEAM: the h2h pane. Reads every recorded meeting between the two
 * selected teams — engine/fixtures.js already keeps a cross-season H2H window
 * for calcFixtureHistory, which is the natural source — and renders the
 * tallies, the trend strip, and the meetings table.
 */
function renderH2hPane() {
  _panes.h2h.innerHTML = `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title" id="fx-h2h-title">Pick two teams</h2>
        <p class="fx-pane__sub">
          <span>${ph(2)} meetings</span>
          <span>Across ${ph(2)} seasons</span>
          <span>Last met ${ph(11)}</span>
        </p>
      </div>
    </header>

    <div class="fx-h2h-summary">
      <div class="fx-h2h-tile fx-h2h-tile--a">
        <span class="fx-h2h-tile__value">${ph(2)}</span>
        <span class="fx-h2h-tile__label" data-fx-slot="h2h-a">Team A wins</span>
      </div>
      <div class="fx-h2h-tile fx-h2h-tile--d">
        <span class="fx-h2h-tile__value">${ph(2)}</span>
        <span class="fx-h2h-tile__label">Draws</span>
      </div>
      <div class="fx-h2h-tile fx-h2h-tile--b">
        <span class="fx-h2h-tile__value">${ph(2)}</span>
        <span class="fx-h2h-tile__label" data-fx-slot="h2h-b">Team B wins</span>
      </div>
      <div class="fx-h2h-tile">
        <span class="fx-h2h-tile__value">${ph(5)}</span>
        <span class="fx-h2h-tile__label">Goals (aggregate)</span>
      </div>
      <div class="fx-h2h-tile">
        <span class="fx-h2h-tile__value">${ph(4)}</span>
        <span class="fx-h2h-tile__label">Avg goals / game</span>
      </div>
    </div>

    <div class="fx-h2h-trend">
      <span class="fx-h2h-trend__label">Last ${SKEL.trendPips} meetings</span>
      ${skelPips(SKEL.trendPips)}
      <span class="fx-h2h-trend__note">read from Team A's perspective</span>
    </div>

    <div class="fx-table-wrap">
      <table class="fx-table">
        <thead>
          <tr>${H2H_COLUMNS.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${times(SKEL.h2hMeetings, () => `
            <tr>
              <td>${ph(11)}</td>
              <td>${ph(7)}</td>
              <td>${ph(6)}</td>
              <td>${ph(9)}</td>
              <td class="fx-table__score">${ph(1)}<em>–</em>${ph(1)}</td>
              <td>${ph(9)}</td>
              <td>${ph(10)}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>
  `;
}

// ─── Pickers ──────────────────────────────────────────────────────────────────

/**
 * Fill the three team <select>s.
 * DATA SEAM: swap SKEL_TEAMS for store.getTeams(), using team.id as the option
 * value and team.name as the label.
 */
function populateTeamSelects() {
  const options = SKEL_TEAMS
    .map((name, i) => `<option value="${i}">${esc(name)}</option>`)
    .join('');

  const placeholders = [
    ['fx-team-select', 'Select a team…'],
    ['fx-h2h-a',       'Team A…'],
    ['fx-h2h-b',       'Team B…'],
  ];

  for (const [id, placeholder] of placeholders) {
    const sel = _root.querySelector(`#${id}`);
    if (sel) sel.innerHTML = `<option value="">${esc(placeholder)}</option>${options}`;
  }
}

/** Echo the team picker's selection into the team pane's header. */
function syncTeamHeading() {
  const sel  = _root.querySelector('#fx-team-select');
  const name = _root.querySelector('#fx-team-name');
  if (!sel || !name) return;
  name.textContent = sel.value === ''
    ? 'No team selected'
    : sel.options[sel.selectedIndex].textContent;
}

/** Echo both h2h selections into the h2h pane's title and its tile labels. */
function syncH2hHeading() {
  const a     = _root.querySelector('#fx-h2h-a');
  const b     = _root.querySelector('#fx-h2h-b');
  const title = _root.querySelector('#fx-h2h-title');
  if (!a || !b || !title) return;

  const nameA = a.value === '' ? '' : a.options[a.selectedIndex].textContent;
  const nameB = b.value === '' ? '' : b.options[b.selectedIndex].textContent;

  title.textContent = (nameA && nameB) ? `${nameA} vs ${nameB}` : 'Pick two teams';

  const labelA = _root.querySelector('[data-fx-slot="h2h-a"]');
  const labelB = _root.querySelector('[data-fx-slot="h2h-b"]');
  if (labelA) labelA.textContent = `${nameA || 'Team A'} wins`;
  if (labelB) labelB.textContent = `${nameB || 'Team B'} wins`;
}

// ─── Mode switching ───────────────────────────────────────────────────────────

/**
 * Show one mode's pane and its matching picker, hide the other two.
 * @param {'gameweek'|'team'|'h2h'} mode
 */
function setMode(mode) {
  if (!MODES.includes(mode)) return;
  _mode = mode;

  for (const key of MODES) {
    _panes[key]?.classList.toggle('is-active', key === mode);
    // `hidden` wins over any display rule — see the [hidden] rule in base.css.
    if (_pickers[key]) _pickers[key].hidden = key !== mode;
  }

  _modeBtns.forEach(btn => {
    const active = btn.dataset.fxMode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onModeClick(e) {
  const btn = e.target.closest('.fx-modes__btn');
  if (btn) setMode(btn.dataset.fxMode);
}

/**
 * Delegated on _panesWrap (stable across renders) rather than per-button — the
 * "Open full head-to-head" buttons are rebuilt on every renderGameweekPane().
 * DATA SEAM: this is also where the clicked fixture's two team ids get pushed
 * into the h2h selects before the mode switch.
 */
function onPanesClick(e) {
  if (e.target.closest('[data-fx-open-h2h]')) setMode('h2h');
}

/**
 * GW stepper. DATA SEAM: move the selected GW by ±1, or back to
 * store.getCurrentGw() for data-fx-gw="now", then re-render the gameweek pane.
 */
function onGwStep(e) {
  const btn = e.target.closest('[data-fx-gw]');
  if (!btn) return;
  // No-op while the pane is a blueprint — there is no GW state to move yet.
}

function onSwapClick() {
  const a = _root.querySelector('#fx-h2h-a');
  const b = _root.querySelector('#fx-h2h-b');
  if (!a || !b) return;
  [a.value, b.value] = [b.value, a.value];
  syncH2hHeading();
}

/**
 * DATA SEAM: not subscribed yet. When the panes read real data this becomes
 * the 'data:ready' handler — populate the selects from store.getTeams(), set
 * the selected GW from store.getCurrentGw(), and re-render the active pane.
 */
function onDataReady() { /* intentionally empty while this view is a blueprint */ }

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initFixtures() {
  _root = document.querySelector('[data-module="fixtures"]');
  if (!_root) return;

  _panesWrap = _root.querySelector('.fx-panes');
  _modeBtns  = Array.from(_root.querySelectorAll('.fx-modes__btn'));

  for (const key of MODES) {
    _panes[key]   = _root.querySelector(`[data-fx-pane="${key}"]`);
    _pickers[key] = _root.querySelector(`[data-fx-picker="${key}"]`);
  }

  populateTeamSelects();

  // Built once — there is no data to re-render against yet.
  renderGameweekPane();
  renderTeamPane();
  renderH2hPane();

  _root.querySelector('.fx-modes')?.addEventListener('click', onModeClick);
  _root.querySelector('.fx-controls')?.addEventListener('click', onGwStep);
  _panesWrap?.addEventListener('click', onPanesClick);

  _root.querySelector('#fx-team-select')?.addEventListener('change', syncTeamHeading);
  _root.querySelector('#fx-h2h-a')?.addEventListener('change', syncH2hHeading);
  _root.querySelector('#fx-h2h-b')?.addEventListener('change', syncH2hHeading);
  _root.querySelector('#fx-h2h-swap')?.addEventListener('click', onSwapClick);

  setMode('gameweek');
}
