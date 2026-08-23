/**
 * js/modules/fixtures.js
 * Layer: module. Owns the DOM for the Fixtures view.
 * Side effects: DOM writes; one lazy call to api.js's fetchLivePoints().
 * Reads from store; calls engine/standings.js. No analytical logic lives here
 * — the league table is accumulated by engine/standings.js, not by this file
 * (ARCHITECTURE.md §3 hard rule 2).
 *
 * Four modes, switched by .fx-modes__btn:
 *   gameweek  — LIVE DATA. One GW's fixtures grouped by kickoff day: status,
 *               crests, score or kickoff time, and a per-fixture disclosure
 *               holding match events and who featured (from event/{gw}/live/).
 *   table     — LIVE DATA. The league table, accumulated from played fixtures,
 *               with an Overall/Home/Away split and European/relegation zones.
 *   team      — STILL A BLUEPRINT. Placeholder rows only.
 *   h2h       — STILL A BLUEPRINT. Placeholder rows only.
 *
 * The match-events feed comes from UNDERSTAT, not FPL. FPL publishes only
 * unordered per-fixture totals — no minute for anything, and no link between a
 * goal and its assist — so a chronological feed cannot be built from it.
 * Understat's match page carries a server-rendered timeline (every goal, card
 * and substitution with its minute) and its shots JSON ties each goal to its
 * assister. Both are fetched lazily when a fixture is opened, and the feed
 * degrades to the FPL grouping if either is unavailable.
 *
 * The teamsheet comes from the same place: Understat's match rosters carry
 * position and substitution linkage, so the panel shows a real starting XI
 * with a derived formation. FPL has no teamsheet at all. Understat lists only
 * players who APPEARED, so the second list is the substitutes used, never a
 * full bench — unused subs exist in neither feed.
 *
 * Subscriptions: data:ready, live:updated, match:updated
 */

import { store } from '../store.js';
import { LEAGUE_FORM_WINDOW } from '../config.js';
import { fetchLivePoints, fetchMatchTimeline, fetchMatchData, attachAssists } from '../api.js';
import { calcLeagueTable, attachNextFixtures, addMovement } from '../engine/standings.js';
import { findUnderstatMatchId } from '../engine/channel.js';
import { normaliseMatchLineups } from '../engine/normalise.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODES = ['gameweek', 'table', 'team', 'h2h'];

const FIRST_GW = 1;
const LAST_GW  = 38;

// Status chips a fixture row can carry. Drives both the legend and the rows,
// so the two can never drift apart.
const STATUS_CHIPS = [
  { key: 'ft',       label: 'FT',   hint: 'Full time — final score' },
  { key: 'live',     label: 'LIVE', hint: 'Kicked off, not yet finished' },
  { key: 'upcoming', label: 'KO',   hint: 'Upcoming — kickoff time shown' },
];

// Per-fixture stat identifiers worth showing as a match event, in feed order.
// Keys are FPL's own `explain[].stats[].identifier` values. Anything not
// listed here (minutes, bonus, bps, saves, clean sheets…) is scoring detail
// rather than a match event and belongs in the Ranker, not here.
const EVENT_IDENTIFIERS = [
  { id: 'goals_scored',     icon: '⚽', label: 'Goal' },
  { id: 'own_goals',        icon: '⚽', label: 'Own goal' },
  { id: 'assists',          icon: 'Ⓐ', label: 'Assist' },
  { id: 'penalties_saved',  icon: '✋', label: 'Penalty saved' },
  { id: 'penalties_missed', icon: '✖', label: 'Penalty missed' },
  { id: 'yellow_cards',     icon: '\u{1f7e8}', label: 'Yellow card' },
  { id: 'red_cards',        icon: '\u{1f7e5}', label: 'Red card' },
];

// Understat timeline event types -> glyph + label.
const TIMELINE_ICONS = {
  goal:     { icon: '\u26bd',     label: 'Goal' },
  own_goal: { icon: '\u26bd',     label: 'Own goal' },
  yellow:   { icon: '\u{1f7e8}',  label: 'Yellow card' },
  red:      { icon: '\u{1f7e5}',  label: 'Red card' },
  sub:      { icon: '\u21c4',     label: 'Substitution' },
};

// Reading order for a team's featured players.
const POS_ORDER = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

// League table columns, left to right. `num` cells are right-aligned mono.
const LEAGUE_COLUMNS = [
  { key: 'pos',  label: '#',    num: true  },
  { key: 'move', label: '',     num: false },
  { key: 'team', label: 'Team', num: false },
  { key: 'pl',   label: 'Pl',   num: true  },
  { key: 'w',    label: 'W',    num: true  },
  { key: 'd',    label: 'D',    num: true  },
  { key: 'l',    label: 'L',    num: true  },
  { key: 'gf',   label: 'GF',   num: true  },
  { key: 'ga',   label: 'GA',   num: true  },
  { key: 'gd',   label: 'GD',   num: true  },
  { key: 'pts',  label: 'Pts',  num: true  },
  { key: 'form', label: 'Form', num: false },
  { key: 'next', label: 'Next', num: false },
];

// Qualification / relegation zones, as inclusive position ranges. The legend
// and the per-row stripes both derive from this one list, so they cannot drift
// apart. Positions outside every range carry no zone.
const LEAGUE_ZONES = [
  { key: 'ucl',  label: 'Champions League',  from: 1,  to: 4  },
  { key: 'uel',  label: 'Europa League',     from: 5,  to: 5  },
  { key: 'uecl', label: 'Conference League', from: 6,  to: 6  },
  { key: 'rel',  label: 'Relegation',        from: 18, to: 20 },
];

// ─── Blueprint volumes (team + h2h panes only) ───────────────────────────────
// The two panes still awaiting data draw this many placeholder rows.

const SKEL = { teamRows: 6, h2hMeetings: 8, trendPips: 6 };

const TEAM_STATS  = ['P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'];
const H2H_COLUMNS = ['Date', 'Season', 'Venue', 'Home', 'Score', 'Away', 'Notes'];

// Stand-in team names for the two blueprint pickers. DATA SEAM: replaced by
// store.getTeams() when those panes are wired.
const SKEL_TEAMS = ['Team A', 'Team B', 'Team C', 'Team D', 'Team E', 'Team F'];

// ─── Module-level state ───────────────────────────────────────────────────────

let _root      = null;   // [data-module="fixtures"] section
let _panesWrap = null;   // .fx-panes — stable click-delegation target
let _panes     = {};     // mode key -> .fx-pane element
let _pickers   = {};     // mode key -> .fx-picker element
let _modeBtns  = [];     // .fx-modes__btn nodes
let _mode      = 'gameweek';

let _gw    = null;         // gameweek the gameweek pane is showing
let _scope = 'overall';    // league table venue split

// Fixture ids whose <details> is open, so a re-render (live data landing,
// GW step) doesn't collapse what the user just opened.
let _openFixtures = new Set();

// GWs whose live payload is already in flight, so re-renders mid-fetch can't
// fire a duplicate request. Mirrors main.js's _teamXgRequested.
const _liveRequested = new Set();

// GWs whose live fetch failed. Rendered as a message instead of retrying in a
// loop — a dead upstream must not turn into a request storm.
const _liveFailed = new Set();

// Same pair of guards for the Understat timeline, keyed by fixture id.
const _timelineRequested = new Set();
const _timelineFailed    = new Set();

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
 * A blank bar standing in for a value the team/h2h panes don't have yet.
 * Width is in `ch` so the bar occupies roughly the space its eventual string
 * will — the only inline style in this module, and one CONVENTIONS.md §5.3
 * explicitly allows (a computed bar width).
 */
function ph(chars, extra = '') {
  return `<span class="fx-ph ${esc(extra)}" style="width:${Number(chars)}ch" aria-hidden="true"></span>`;
}

/** Repeat a builder n times and join. */
function times(n, fn) {
  let out = '';
  for (let i = 0; i < n; i++) out += fn(i);
  return out;
}

/**
 * A team crest. Real badge when the team is known (team.badgeUrl is
 * precomputed in normalise.js), otherwise the empty ring the blueprint used.
 * onerror hides a missing badge rather than showing a broken-image icon —
 * same treatment as matchup.js's .gw-nav__badge.
 */
function crest(team, extra = '') {
  const cls = `fx-crest ${extra}`.trim();
  if (!team?.badgeUrl) return `<span class="${esc(cls)}" aria-hidden="true"></span>`;
  return `<img class="${esc(cls)}" src="${esc(team.badgeUrl)}" alt=""`
       + ` onerror="this.style.visibility='hidden'">`;
}

// ─── Date formatting ─────────────────────────────────────────────────────────
// Kickoffs arrive as ISO strings in UTC and are rendered in the viewer's local
// zone — deliberate: a personal tool should show the time you'd actually watch
// the match at. All formatting is display-only and stays in this module.

function toDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "15:00" */
function fmtTime(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'TBC';
}

/** "Saturday" */
function fmtWeekday(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { weekday: 'long' }) : 'Date TBC';
}

/** "16 August 2026" */
function fmtDateLong(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}

/** "16 Aug" */
function fmtDateShort(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'TBC';
}

/** "Fri 15 Aug, 18:30" */
function fmtDateTime(iso) {
  const d = toDate(iso);
  if (!d) return 'TBC';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
       + ', ' + fmtTime(iso);
}

/** Local calendar day, used only as a grouping key. Null kickoffs group last. */
function dayKey(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) : 'tbc';
}

// ─── Shared render pieces ─────────────────────────────────────────────────────

/**
 * Win/draw/loss pips.
 * @param {string[]} form  ['W','D','L',…] oldest → newest
 */
function pips(form) {
  if (!form?.length) return '<span class="fx-pips fx-pips--empty">—</span>';
  return `<span class="fx-pips">${form.map(r =>
    `<span class="fx-pip fx-pip--${r.toLowerCase()}" title="${esc(r)}"></span>`
  ).join('')}</span>`;
}

/** Placeholder pips, for the two panes still on the blueprint. */
function skelPips(n) {
  const cycle = ['w', 'd', 'l'];
  return `<span class="fx-pips">${
    times(n, i => `<span class="fx-pip fx-pip--${cycle[i % 3]}" aria-hidden="true"></span>`)
  }</span>`;
}

/** A short "nothing to show" block, styled like the rest of the pane. */
function emptyState(message) {
  return `<p class="fx-empty">${esc(message)}</p>`;
}

// ─── Gameweek pane ────────────────────────────────────────────────────────────

/**
 * @returns {'ft'|'live'|'upcoming'}  which status chip a fixture carries.
 *   `started` is set at kickoff and `finished` (→ played) at full time, so
 *   started && !played is exactly "in progress" — no clock arithmetic needed.
 */
function statusOf(fixture) {
  if (fixture.played)  return 'ft';
  if (fixture.started) return 'live';
  return 'upcoming';
}

// Result box shown beside each team once a fixture is complete.
const OUTCOMES = {
  W: { key: 'w', label: 'Won' },
  D: { key: 'd', label: 'Drawn' },
  L: { key: 'l', label: 'Lost' },
};

/**
 * Each side's outcome, or nulls while the fixture has no final score.
 * Deliberately gated on `played` rather than on `result` alone: `result` now
 * carries the RUNNING score of a live match (normalise.js), and a team leading
 * at half time has not won anything yet.
 * @returns {{home: 'W'|'D'|'L'|null, away: 'W'|'D'|'L'|null}}
 */
function outcomesFor(fixture) {
  if (!fixture.played || !fixture.result) return { home: null, away: null };
  const { homeGoals, awayGoals } = fixture.result;
  if (homeGoals > awayGoals) return { home: 'W', away: 'L' };
  if (homeGoals < awayGoals) return { home: 'L', away: 'W' };
  return { home: 'D', away: 'D' };
}

/**
 * One team's side of a fixture row. The result box sits on the inside edge of
 * each side, so the two mirror each other around the scoreline — .fx-side--away
 * is row-reverse, so the same DOM order renders mirrored on the right.
 */
function sideHtml(team, side, outcome) {
  const box = outcome
    ? `<span class="fx-result fx-result--${OUTCOMES[outcome].key}"
             title="${esc(OUTCOMES[outcome].label)}"
             aria-label="${esc(OUTCOMES[outcome].label)}">${outcome}</span>`
    : '';
  return `
    <span class="fx-side fx-side--${side}">
      ${crest(team)}
      <span class="fx-side__name" title="${esc(team?.name ?? '')}">${esc(team?.shortName ?? '???')}</span>
      ${box}
    </span>`;
}

/**
 * Index one gameweek's live payload down to a single fixture.
 *
 * FPL reports a player's stats for the GW as a whole in `stats`, and splits
 * them per fixture in `explain` — so in a double gameweek only `explain`
 * attributes correctly, which is why that is what this reads.
 *
 * @param {object} live      raw event/{gw}/live/ payload
 * @param {object} fixture   the fixture to extract
 * @returns {{events: {home: object[], away: object[]},
 *            featured: {home: object[], away: object[]}}}
 */
function indexFixtureLive(live, fixture) {
  const events   = { home: [], away: [] };
  const featured = { home: [], away: [] };

  for (const el of live?.elements ?? []) {
    const slice = el.explain?.find(x => x.fixture === fixture.id);
    if (!slice) continue;

    const player = store.getPlayer(el.id);
    if (!player) continue;

    const side = player.teamId === fixture.homeTeamId ? 'home'
               : player.teamId === fixture.awayTeamId ? 'away'
               : null;
    if (!side) continue;

    // explain[].stats only carries identifiers that scored (or cost) points,
    // so a missing identifier means "none", not "unknown".
    const values = {};
    for (const s of slice.stats ?? []) values[s.identifier] = s.value;

    const minutes = values.minutes ?? 0;
    if (minutes > 0) featured[side].push({ player, minutes });

    for (const kind of EVENT_IDENTIFIERS) {
      const count = values[kind.id] ?? 0;
      if (count > 0) events[side].push({ player, kind, count });
    }
  }

  for (const side of ['home', 'away']) {
    featured[side].sort((a, b) =>
      (POS_ORDER[a.player.position] ?? 9) - (POS_ORDER[b.player.position] ?? 9)
      || b.minutes - a.minutes
      || a.player.name.localeCompare(b.player.name));

    events[side].sort((a, b) =>
      EVENT_IDENTIFIERS.indexOf(a.kind) - EVENT_IDENTIFIERS.indexOf(b.kind)
      || a.player.name.localeCompare(b.player.name));
  }

  return { events, featured };
}

/** One line in a match-event feed. */
function eventHtml({ player, kind, count }) {
  return `
    <li class="fx-event">
      <span class="fx-event__icon" aria-hidden="true">${kind.icon}</span>
      <span class="fx-event__player">${esc(player.name)}</span>
      ${count > 1 ? `<span class="fx-event__count">×${count}</span>` : ''}
      <span class="fx-event__type">${esc(kind.label)}</span>
    </li>`;
}

/** One team's column of players who featured. */
function featuredHtml(list, team) {
  if (!list.length) return `<div class="fx-lineup">${emptyState('No appearances recorded.')}</div>`;
  return `
    <div class="fx-lineup">
      <p class="fx-lineup__head">
        <span class="fx-lineup__team">${esc(team?.shortName ?? '')}</span>
        <span class="fx-lineup__formation">${list.length} played</span>
      </p>
      <ul class="fx-lineup__list">
        ${list.map(({ player, minutes }) => `
          <li class="fx-lineup__row">
            <span class="fx-lineup__num">${minutes}'</span>
            <span class="fx-lineup__name">${esc(player.name)}</span>
            <span class="fx-lineup__pos">${esc(player.position)}</span>
          </li>`).join('')}
      </ul>
    </div>`;
}

/**
 * One line of the chronological match feed.
 *
 * A goal carries its assister on the SAME line: the two are one moment, and
 * Understat's shots JSON is what makes the pairing possible at all (FPL only
 * reports that someone assisted, never whose goal).
 */
function timelineEventHtml(ev) {
  const kind = TIMELINE_ICONS[ev.type] ?? TIMELINE_ICONS.goal;

  const body = ev.type === 'sub'
    ? `<span class="fx-tl__player fx-tl__player--off">${esc(ev.player)}</span>
       <span class="fx-tl__arrow" aria-hidden="true">\u2192</span>
       <span class="fx-tl__player fx-tl__player--on">${esc(ev.playerIn ?? '')}</span>`
    : `<span class="fx-tl__player">${esc(ev.player)}</span>
       ${ev.assist ? `<span class="fx-tl__assist">assist ${esc(ev.assist)}</span>` : ''}
       ${ev.score ? `<span class="fx-tl__score">${esc(ev.score)}</span>` : ''}`;

  // Home events sit left of the centre spine, away events right of it, with the
  // minute in the middle. The markup is IDENTICAL for both sides — CSS mirrors
  // the home row so its glyph ends up nearest the spine, the same technique
  // .fx-side--away uses on the fixture row. Which side an event belongs to is
  // then carried by position, so the old H/A column is gone; the label stays
  // for anyone not reading the layout.
  return `
    <li class="fx-tl__item fx-tl__item--${ev.side}">
      <span class="fx-tl__event">
        <span class="fx-tl__icon" title="${esc(kind.label)}" aria-hidden="true">${kind.icon}</span>
        <span class="fx-tl__body">${body}</span>
      </span>
      <span class="fx-tl__minute">${ev.minute}'</span>
      <span class="fx-visually-hidden">${esc(ev.side === 'home' ? 'home team' : 'away team')}</span>
    </li>`;
}

/**
 * The chronological match feed, when Understat has one. Returns null when it
 * doesn't, so the caller can fall back to the FPL event grouping rather than
 * showing an empty block.
 */
function timelineHtml(fixture) {
  const events = store.getMatchDetail(fixture.id)?.events;
  if (!events?.length) return null;

  return `
    <section class="fx-detail__block">
      <h4 class="fx-detail__title">Match events</h4>
      <ul class="fx-tl">${events.map(timelineEventHtml).join('')}</ul>
      <p class="fx-detail__note">
        In order of minute, home team left of the centre line and away team
        right of it. Timings and goal/assist pairings come from Understat —
        FPL publishes neither.
      </p>
    </section>`;
}

/**
 * Per-player marks on a lineup row: what he did, in the order a matchday
 * programme would list it. Repeats collapse to a count (a brace reads
 * "GOAL x2" rather than two identical badges).
 */
function lineupMarksHtml(p) {
  const marks = [];
  if (p.goals)    marks.push({ cls: 'goal',   glyph: '\u26bd', n: p.goals,    label: 'Goal' });
  if (p.ownGoals) marks.push({ cls: 'own',    glyph: '\u26bd', n: p.ownGoals, label: 'Own goal' });
  if (p.assists)  marks.push({ cls: 'assist', glyph: '\u24b6', n: p.assists,  label: 'Assist' });
  if (p.yellow)   marks.push({ cls: 'yellow', glyph: '\u{1f7e8}', n: 1, label: 'Yellow card' });
  if (p.red)      marks.push({ cls: 'red',    glyph: '\u{1f7e5}', n: 1, label: 'Red card' });

  return marks.map(m =>
    `<span class="fx-xi__mark fx-xi__mark--${m.cls}" title="${esc(m.label)}">${m.glyph}${
      m.n > 1 ? `<span class="fx-xi__markn">${m.n}</span>` : ''}</span>`).join('');
}

/** One player row in the XI or the substitutes list. */
function lineupRowHtml(p, isSub) {
  // A starter who was replaced, and a substitute who came on, each carry the
  // minute it happened — the same number, read from opposite ends.
  const swap = isSub
    ? (p.cameOnFor ? `<span class="fx-xi__swap fx-xi__swap--on">${p.onAt}' for ${esc(p.cameOnFor)}</span>` : '')
    : (p.replacedBy ? `<span class="fx-xi__swap fx-xi__swap--off">${p.minutes}' \u2192 ${esc(p.replacedBy)}</span>` : '');

  return `
    <li class="fx-xi__row">
      <span class="fx-xi__pos">${esc(isSub ? 'SUB' : p.position)}</span>
      <span class="fx-xi__name">${esc(p.name)}</span>
      <span class="fx-xi__marks">${lineupMarksHtml(p)}</span>
      ${swap}
      <span class="fx-xi__mins">${p.minutes}'</span>
    </li>`;
}

/** One team's teamsheet: formation, starting XI, then the substitutes used. */
function lineupColumnHtml(side, team) {
  return `
    <div class="fx-xi">
      <p class="fx-xi__head">
        <span class="fx-xi__team">${esc(team?.shortName ?? '')}</span>
        ${side.formation ? `<span class="fx-xi__formation">${esc(side.formation)}</span>` : ''}
      </p>
      <ol class="fx-xi__list">${side.starters.map(p => lineupRowHtml(p, false)).join('')}</ol>
      ${side.subs.length ? `
        <p class="fx-xi__subhead">Substitutes used</p>
        <ul class="fx-xi__list fx-xi__list--subs">${side.subs.map(p => lineupRowHtml(p, true)).join('')}</ul>`
        : ''}
    </div>`;
}

/**
 * The teamsheet block, when Understat has rosters for this match. Returns null
 * otherwise so the caller falls back to FPL's appearance list.
 */
function lineupsHtml(fixture, home, away) {
  const lineups = store.getMatchDetail(fixture.id)?.lineups;
  if (!lineups?.home?.starters?.length || !lineups?.away?.starters?.length) return null;

  return `
    <section class="fx-detail__block">
      <h4 class="fx-detail__title">Lineups</h4>
      <div class="fx-detail__cols">
        ${lineupColumnHtml(lineups.home, home)}
        ${lineupColumnHtml(lineups.away, away)}
      </div>
      <p class="fx-detail__note">
        Starting XI in position order, with the formation derived from those
        positions. Understat lists only players who appeared, so the second
        list is the substitutes USED — unused subs are published nowhere.
      </p>
    </section>`;
}

/**
 * The expandable half of a fixture row. Content depends on what exists yet:
 * an upcoming fixture has nothing to report, a played one needs the GW's live
 * payload, which is fetched lazily when the disclosure is first opened.
 */
function fixtureDetailHtml(fixture, home, away) {
  const status = statusOf(fixture);

  if (status === 'upcoming') {
    return `<div class="fx-detail">${emptyState(
      `Not played yet — kicks off ${fmtDateTime(fixture.kickoff)}.`)}</div>`;
  }

  if (_liveFailed.has(fixture.gw)) {
    return `<div class="fx-detail">${emptyState(
      'Match data unavailable — the live endpoint could not be reached. Reload to retry.')}</div>`;
  }

  const live = store.getLive(fixture.gw);
  if (!live) {
    return `<div class="fx-detail">${emptyState('Loading match data…')}</div>`;
  }

  const { events, featured } = indexFixtureLive(live, fixture);
  const anyEvents = events.home.length || events.away.length;

  // Understat's chronological feed is the one we want. It only exists once
  // both its calls have landed, so until then (or if they fail) fall back to
  // FPL's grouped totals rather than showing nothing.
  const timeline = timelineHtml(fixture);

  const eventsBlock = timeline ?? `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Match events</h4>
        ${anyEvents ? `
          <div class="fx-detail__cols">
            <ul class="fx-events">${events.home.map(eventHtml).join('')}</ul>
            <ul class="fx-events fx-events--away">${events.away.map(eventHtml).join('')}</ul>
          </div>` : emptyState('No goals, assists or cards recorded.')}
        <p class="fx-detail__note">
          ${_timelineFailed.has(fixture.id)
            ? 'Understat\u2019s timeline could not be loaded, so these are FPL\u2019s per-match totals: grouped by type, without minutes.'
            : 'Loading the minute-by-minute feed\u2026 showing FPL\u2019s per-match totals meanwhile.'}${fixture.played && !fixture.bonusConfirmed
            ? ' Bonus points for this match are still provisional.' : ''}
        </p>
      </section>`;

  return `
    <div class="fx-detail">

      ${eventsBlock}

      ${lineupsHtml(fixture, home, away) ?? `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Who featured</h4>
        <div class="fx-detail__cols">
          ${featuredHtml(featured.home, home)}
          ${featuredHtml(featured.away, away)}
        </div>
        <p class="fx-detail__note">
          Every player with minutes, longest first within each position \u2014 FPL
          publishes no teamsheet. The real XI comes from Understat and is not
          available for this match.
        </p>
      </section>`}

      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Head-to-head</h4>
        <div class="fx-h2h-mini">
          <span class="fx-h2h-mini__tally">${ph(2)}<em>wins</em></span>
          <span class="fx-h2h-mini__tally">${ph(2)}<em>draws</em></span>
          <span class="fx-h2h-mini__tally">${ph(2)}<em>wins</em></span>
          <span class="fx-h2h-mini__trend">Last ${SKEL.trendPips}${skelPips(SKEL.trendPips)}</span>
        </div>
        <button class="fx-link-btn" type="button" data-fx-open-h2h>Open full head-to-head →</button>
        <p class="fx-detail__note">Still a blueprint — wired with the Head-to-head tab.</p>
      </section>

    </div>`;
}

/** One fixture row: status, both sides, score or kickoff, and the disclosure. */
function fixtureHtml(fixture) {
  const home   = store.getTeam(fixture.homeTeamId);
  const away   = store.getTeam(fixture.awayTeamId);
  const status = statusOf(fixture);
  const chip   = STATUS_CHIPS.find(c => c.key === status);

  // A score is shown as soon as FPL publishes one, so a match in progress
  // carries its running score; the LIVE chip beside it is what says the score
  // is not final. Only a fixture yet to kick off falls back to its time.
  const centre = fixture.result
    ? `<span class="fx-fixture__score">${fixture.result.homeGoals}<em>–</em>${fixture.result.awayGoals}</span>`
    : `<span class="fx-fixture__score fx-fixture__score--time">${esc(fmtTime(fixture.kickoff))}</span>`;

  const outcome = outcomesFor(fixture);

  return `
    <li class="fx-item">
      <details class="fx-fixture" data-fixture-id="${fixture.id}"${_openFixtures.has(fixture.id) ? ' open' : ''}>
        <summary class="fx-fixture__summary">
          <span class="fx-status fx-status--${status}" title="${esc(chip.hint)}">${esc(chip.label)}</span>
          ${sideHtml(home, 'home', outcome.home)}
          <span class="fx-fixture__centre">
            ${centre}
            <span class="fx-fixture__ko">${esc(fmtDateShort(fixture.kickoff))}</span>
          </span>
          ${sideHtml(away, 'away', outcome.away)}
          <span class="fx-fixture__chev" aria-hidden="true">▾</span>
        </summary>
        ${fixtureDetailHtml(fixture, home, away)}
      </details>
    </li>`;
}

/** Group a GW's fixtures by local kickoff day, preserving fixture order. */
function groupByDay(fixtures) {
  const groups = [];
  const byKey  = new Map();
  for (const f of fixtures) {
    const key = dayKey(f.kickoff);
    if (!byKey.has(key)) {
      const group = { key, kickoff: f.kickoff, fixtures: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).fixtures.push(f);
  }
  return groups;
}

function renderGameweekPane() {
  if (!_panes.gameweek) return;

  if (!store.getSeason()) {
    _panes.gameweek.innerHTML = emptyState('Loading FPL data…');
    return;
  }

  const gw       = _gw;
  const event    = store.getEvents().find(e => e.id === gw) ?? null;
  const fixtures = store.getFixtures().filter(f => f.gw === gw);
  const groups   = groupByDay(fixtures);

  const legend = STATUS_CHIPS.map(c => `
    <span class="fx-legend__item">
      <span class="fx-status fx-status--${c.key}">${esc(c.label)}</span>${esc(c.hint)}
    </span>`).join('');

  const first = fixtures[0]?.kickoff;
  const last  = fixtures[fixtures.length - 1]?.kickoff;
  const span  = first && last && dayKey(first) !== dayKey(last)
    ? `${fmtDateShort(first)} – ${fmtDateShort(last)}`
    : fmtDateLong(first);

  const tag = event?.isCurrent ? '<span class="fx-tag fx-tag--now">Current</span>'
            : event?.isNext    ? '<span class="fx-tag">Next</span>'
            : '';

  _panes.gameweek.innerHTML = `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title">Gameweek ${gw} ${tag}</h2>
        <p class="fx-pane__sub">
          ${event ? `<span>Deadline ${esc(fmtDateTime(event.deadline))}</span>` : ''}
          ${span ? `<span>${esc(span)}</span>` : ''}
          <span>${fixtures.length} ${fixtures.length === 1 ? 'fixture' : 'fixtures'}</span>
        </p>
      </div>
      <div class="fx-legend">${legend}</div>
    </header>

    ${fixtures.length ? groups.map(g => `
      <section class="fx-daygroup">
        <h3 class="fx-daygroup__title">
          <span class="fx-daygroup__day">${esc(fmtWeekday(g.kickoff))}</span>
          <span class="fx-daygroup__date">${esc(fmtDateLong(g.kickoff))}</span>
        </h3>
        <ul class="fx-list">${g.fixtures.map(fixtureHtml).join('')}</ul>
      </section>`).join('')
      : emptyState(`No fixtures scheduled for gameweek ${gw}.`)}
  `;

  syncGwPicker(gw);
}

/** Keep the stepper label and its bounds in step with the selected GW. */
function syncGwPicker(gw) {
  const label = _root.querySelector('#fx-gw-label');
  if (label) label.textContent = `Gameweek ${gw}`;

  const prev = _root.querySelector('[data-fx-gw="prev"]');
  const next = _root.querySelector('[data-fx-gw="next"]');
  if (prev) prev.disabled = gw <= FIRST_GW;
  if (next) next.disabled = gw >= LAST_GW;

  const now = _root.querySelector('[data-fx-gw="now"]');
  if (now) now.disabled = gw === (store.getCurrentGw() ?? store.getNextGw());
}

// ─── Live payload (match events + appearances) ────────────────────────────────

/**
 * Fetch and cache one GW's live payload, once. Fire-and-forget: the pane
 * re-renders off the store's 'live:updated' event when it lands.
 *
 * Failures are swallowed to a console warning and a per-GW flag, never
 * store.setError() — match detail is an ENRICHMENT of the fixture list, so a
 * dead live endpoint must not blank the tab. Same policy as the Understat
 * fetches in main.js (ROADMAP §3A, CONVENTIONS.md §9).
 */
function ensureLive(gw) {
  if (!Number.isInteger(gw)) return;
  if (store.getLive(gw) || _liveRequested.has(gw) || _liveFailed.has(gw)) return;

  _liveRequested.add(gw);
  fetchLivePoints(gw)
    .then(raw => store.setLive(gw, raw))
    .catch(err => {
      _liveFailed.add(gw);
      console.warn(`[fixtures] live data unavailable for GW${gw}: ${err.message ?? err}`);
      if (_mode === 'gameweek') renderGameweekPane();
    });
}

/**
 * Fetch, parse and cache one fixture's Understat match timeline, once.
 *
 * Two upstream calls: the match page for the chronological feed (the only
 * source of a minute for cards) and the match JSON for goal→assist pairing.
 * The page is the backbone and the JSON a pure enrichment, so a failure of the
 * second still yields a full timeline, just without assists.
 *
 * Fire-and-forget; the pane re-renders off 'match:updated'. Failures are
 * swallowed to a console warning and a per-fixture flag, never
 * store.setError() — this is an ENRICHMENT of a feed that already renders from
 * FPL data. Same policy as the Understat fetches in main.js (CONVENTIONS.md §9).
 */
function ensureTimeline(fixture) {
  if (!fixture || _timelineRequested.has(fixture.id) || _timelineFailed.has(fixture.id)) return;
  if (store.getMatchDetail(fixture.id)) return;

  // The fixture→match mapping is derived from Understat's league payload, which
  // arrives asynchronously at boot. Opening a fixture before it lands is a
  // "not yet", NOT a failure — flagging it here would permanently deny this
  // fixture a timeline for the rest of the session.
  const leagueXg = store.getLeagueXg();
  if (!leagueXg) return;

  const matchId = findUnderstatMatchId(fixture, leagueXg, store.getSeason()?.teamsById);
  if (!matchId) {
    // League data IS loaded and still no match — Understat genuinely has no
    // record of this fixture. Flag it so the FPL fallback renders its final
    // wording instead of a permanent "loading".
    _timelineFailed.add(fixture.id);
    console.warn(`[fixtures] no Understat match found for fixture ${fixture.id}`);
    return;
  }

  _timelineRequested.add(fixture.id);

  fetchMatchTimeline(matchId)
    .then(async (events) => {
      if (!events.length) { _timelineFailed.add(fixture.id); return; }

      // One extra call gives BOTH the goal→assist pairing and the teamsheets.
      // Optional: without it the feed still renders, just without assists and
      // with the FPL appearance list in place of a lineup.
      let lineups = null;
      try {
        const matchData = await fetchMatchData(matchId);
        attachAssists(events, matchData);
        lineups = normaliseMatchLineups(matchData);
      } catch (err) {
        console.warn(`[fixtures] match data unavailable for match ${matchId}: ${err.message ?? err}`);
      }

      store.setMatchDetail(fixture.id, { events, lineups });
    })
    .catch((err) => {
      _timelineFailed.add(fixture.id);
      console.warn(`[fixtures] Understat timeline unavailable for fixture ${fixture.id}: ${err.message ?? err}`);
      if (_mode === 'gameweek') renderGameweekPane();
    });
}

// ─── League table pane ────────────────────────────────────────────────────────

/**
 * @param {number} pos  1-based league position
 * @returns {string}    zone key, or '' for the positions that belong to none.
 */
function zoneFor(pos) {
  return LEAGUE_ZONES.find(z => pos >= z.from && pos <= z.to)?.key ?? '';
}

/** ▲ / – / ▼ for a team's movement since the previous gameweek. */
function movementHtml(movement) {
  if (movement > 0) return `<span class="fx-league__move fx-league__move--up" title="Up ${movement}">▲</span>`;
  if (movement < 0) return `<span class="fx-league__move fx-league__move--down" title="Down ${-movement}">▼</span>`;
  return '<span class="fx-league__move fx-league__move--flat" title="No change">–</span>';
}

/** The Next column: opponent crest, short name, venue and official FDR. */
function nextFixtureHtml(next) {
  if (!next) return '<span class="fx-league__none">—</span>';
  return `${crest(next.opponent, 'fx-crest--sm')}`
       + `<span title="${esc(next.opponent?.name ?? '')}">${esc(next.opponent?.shortName ?? '???')}</span>`
       + `<span class="fx-venue">(${next.isHome ? 'H' : 'A'})</span>`
       + (next.difficulty
           ? `<span class="fx-row__tag fx-fdr--${next.difficulty}" title="Official FPL difficulty">${next.difficulty}</span>`
           : '');
}

function leagueRowHtml(row) {
  const zone = zoneFor(row.position);
  return `
    <tr class="fx-league__row${zone ? ` fx-league__row--${zone}` : ''}">
      <td class="fx-league__pos">${row.position}</td>
      <td>${movementHtml(row.movement)}</td>
      <td class="fx-league__team">
        ${crest(row.team, 'fx-crest--sm')}
        <button class="fx-link-btn" type="button" data-fx-open-team
                data-team-id="${row.teamId}">${esc(row.team.name)}</button>
      </td>
      <td class="fx-league__num">${row.played}</td>
      <td class="fx-league__num">${row.won}</td>
      <td class="fx-league__num">${row.drawn}</td>
      <td class="fx-league__num">${row.lost}</td>
      <td class="fx-league__num">${row.goalsFor}</td>
      <td class="fx-league__num">${row.goalsAgainst}</td>
      <td class="fx-league__num">${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td>
      <td class="fx-league__num fx-league__pts">${row.points}</td>
      <td class="fx-league__form">${pips(row.form)}</td>
      <td class="fx-league__next">${nextFixtureHtml(row.nextFixture)}</td>
    </tr>`;
}

function renderTablePane() {
  if (!_panes.table) return;

  const season = store.getSeason();
  if (!season) {
    _panes.table.innerHTML = emptyState('Loading FPL data…');
    return;
  }

  const fixtures = store.getFixtures();
  const teams    = store.getTeams();
  const played   = fixtures.filter(f => f.played && f.result);

  // "Completed gameweeks" is the highest GW that has any finished fixture —
  // the movement baseline is the table as it stood one GW earlier.
  const lastGw = played.reduce((max, f) => (f.gw !== null && f.gw > max ? f.gw : max), 0);

  const rows = attachNextFixtures(
    addMovement(
      calcLeagueTable(fixtures, teams, { venue: _scope }),
      calcLeagueTable(fixtures, teams, { venue: _scope, upToGw: Math.max(lastGw - 1, 0) }),
    ),
    fixtures,
    season.teamsById,
  );

  const legend = LEAGUE_ZONES.map(z => `
    <span class="fx-legend__item">
      <span class="fx-zone-key fx-zone-key--${z.key}" aria-hidden="true"></span>${esc(z.label)}
    </span>`).join('');

  const lastKickoff = played.reduce(
    (latest, f) => (f.kickoff && (!latest || f.kickoff > latest) ? f.kickoff : latest), null);

  const scopeNote = _scope === 'overall'
    ? 'All fixtures.'
    : `${_scope === 'home' ? 'Home' : 'Away'} fixtures only — positions are for this split, not the real table.`;

  _panes.table.innerHTML = `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title">League table</h2>
        <p class="fx-pane__sub">
          <span>After ${lastGw} ${lastGw === 1 ? 'gameweek' : 'gameweeks'}</span>
          ${lastKickoff ? `<span>Latest result ${esc(fmtDateShort(lastKickoff))}</span>` : ''}
          <span>${esc(scopeNote)}</span>
        </p>
      </div>
      <div class="fx-legend">${legend}</div>
    </header>

    ${played.length ? `
      <div class="fx-table-wrap">
        <table class="fx-table fx-league">
          <thead>
            <tr>
              ${LEAGUE_COLUMNS.map(c =>
                `<th scope="col"${c.num ? ' class="fx-league__num"' : ''}>${esc(c.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rows.map(leagueRowHtml).join('')}</tbody>
        </table>
      </div>

      <p class="fx-detail__note">
        Accumulated from finished fixtures — FPL publishes no standings endpoint.
        Ordering is points, then goal difference, then goals scored; clubs level
        on all three are shown alphabetically rather than split by head-to-head.
        Form is the last ${LEAGUE_FORM_WINDOW} results, most recent last. Next shows the official
        FPL 1–5 difficulty, not the Gaffer IQ score.
      </p>`
      : emptyState('No fixtures have been played yet this season.')}
  `;
}

// ─── Team pane (blueprint) ────────────────────────────────────────────────────

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

/** DATA SEAM: the selected team's fixture list, split on fixture.played. */
function renderTeamPane() {
  if (!_panes.team) return;
  _panes.team.innerHTML = `
    <p class="fx-blueprint-note fx-blueprint-note--inline">
      <strong>Blueprint.</strong> This view is still placeholders — Gameweek and
      Table are the live ones.
    </p>

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
  `;
}

// ─── Head-to-head pane (blueprint) ────────────────────────────────────────────

/** DATA SEAM: every recorded meeting between the two selected teams. */
function renderH2hPane() {
  if (!_panes.h2h) return;
  _panes.h2h.innerHTML = `
    <p class="fx-blueprint-note fx-blueprint-note--inline">
      <strong>Blueprint.</strong> This view is still placeholders — Gameweek and
      Table are the live ones.
    </p>

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

/** DATA SEAM: swap SKEL_TEAMS for store.getTeams() with the two panes below. */
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

function syncTeamHeading() {
  const sel  = _root.querySelector('#fx-team-select');
  const name = _root.querySelector('#fx-team-name');
  if (!sel || !name) return;
  name.textContent = sel.value === ''
    ? 'No team selected'
    : sel.options[sel.selectedIndex].textContent;
}

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
 * Delegated on _panesWrap (stable across renders) rather than per-element —
 * every row and disclosure is rebuilt on each render.
 */
function onPanesClick(e) {
  if (e.target.closest('[data-fx-open-h2h]'))  { setMode('h2h');  return; }
  if (e.target.closest('[data-fx-open-team]')) { setMode('team'); }
}

/**
 * Opening a fixture is what triggers its GW's live fetch — the payload is
 * needed by nothing else, so nothing pays for it until a user asks.
 */
function onPanesToggle(e) {
  const details = e.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('fx-fixture')) return;

  const id = Number(details.dataset.fixtureId);
  if (details.open) _openFixtures.add(id); else _openFixtures.delete(id);

  const fixture = store.getFixture(id);
  if (details.open && fixture && statusOf(fixture) !== 'upcoming') {
    ensureLive(fixture.gw);
    ensureTimeline(fixture);
  }
}

function onGwStep(e) {
  const btn = e.target.closest('[data-fx-gw]');
  if (!btn || btn.disabled) return;

  const home = store.getCurrentGw() ?? store.getNextGw() ?? FIRST_GW;
  const next = btn.dataset.fxGw === 'prev' ? _gw - 1
             : btn.dataset.fxGw === 'next' ? _gw + 1
             : home;

  const clamped = Math.min(LAST_GW, Math.max(FIRST_GW, next));
  if (clamped === _gw) return;

  _gw = clamped;
  _openFixtures.clear();   // ids don't carry across gameweeks
  renderGameweekPane();
}

function onSwapClick() {
  const a = _root.querySelector('#fx-h2h-a');
  const b = _root.querySelector('#fx-h2h-b');
  if (!a || !b) return;
  [a.value, b.value] = [b.value, a.value];
  syncH2hHeading();
}

function onScopeClick(e) {
  const btn = e.target.closest('.fx-scope__btn');
  if (!btn) return;

  _root.querySelectorAll('.fx-scope__btn').forEach(b => {
    const active = b === btn;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  _scope = btn.dataset.fxScope;
  renderTablePane();
}

/**
 * Season data has landed (or been re-emitted as an enrichment arrives). Pick
 * the opening gameweek the first time only, so a re-emit can't yank the user
 * back from a GW they stepped to.
 */
function onDataReady() {
  if (_gw === null) _gw = store.getCurrentGw() ?? store.getNextGw() ?? FIRST_GW;
  renderGameweekPane();
  renderTablePane();
}

/** A GW's live payload landed — only the gameweek pane reads it. */
function onLiveUpdated() {
  renderGameweekPane();
}

/** One fixture's Understat match detail landed (events + lineups). */
function onMatchUpdated() {
  renderGameweekPane();
}

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

  // The two blueprint panes have no data to wait on — build them once.
  renderTeamPane();
  renderH2hPane();

  store.subscribe('data:ready',   onDataReady);
  store.subscribe('live:updated', onLiveUpdated);
  store.subscribe('match:updated', onMatchUpdated);

  _root.querySelector('.fx-modes')?.addEventListener('click', onModeClick);
  _root.querySelector('.fx-controls')?.addEventListener('click', onGwStep);
  _root.querySelector('.fx-scope')?.addEventListener('click', onScopeClick);

  _panesWrap?.addEventListener('click', onPanesClick);
  // `toggle` doesn't bubble, so delegation needs the capture phase.
  _panesWrap?.addEventListener('toggle', onPanesToggle, true);

  _root.querySelector('#fx-team-select')?.addEventListener('change', syncTeamHeading);
  _root.querySelector('#fx-h2h-a')?.addEventListener('change', syncH2hHeading);
  _root.querySelector('#fx-h2h-b')?.addEventListener('change', syncH2hHeading);
  _root.querySelector('#fx-h2h-swap')?.addEventListener('click', onSwapClick);

  setMode('gameweek');

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
