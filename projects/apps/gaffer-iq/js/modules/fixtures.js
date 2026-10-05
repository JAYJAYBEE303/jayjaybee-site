/**
 * js/modules/fixtures.js
 * Layer: module. Owns the DOM for the Fixtures view.
 * Side effects: DOM writes; one lazy call to api.js's fetchLivePoints().
 * Reads from store; calls engine/standings.js, engine/h2h.js and
 * engine/composite.js. No analytical logic lives here — the league table is
 * accumulated by engine/standings.js, the head-to-head record by
 * engine/h2h.js and every Gaffer IQ score by composite.scoreFixture, not by
 * this file (ARCHITECTURE.md §3 hard rule 2).
 *
 * Layout and motion are the design export's FINAL - Fixtures.dc.html, styled
 * by css/fixtures.css. Four modes, switched by the .mode tabs — all four run
 * on live data:
 *   gameweek  — "Matchday": one GW as a clock — a 38-bar season ruler, the
 *               fixtures as tiles grouped by kickoff day and time, each with
 *               both sides' Gaffer IQ score and an FDR / Gaffer IQ / H2H edge
 *               strip. A tile opens the match report drawer: match events,
 *               both teamsheets and the pairing's H2H record.
 *   table     — The league table, accumulated from played fixtures, with an
 *               Overall/Home/Away split and European/relegation zones.
 *   team      — One club's season as a ribbon: every result so far and every
 *               fixture still to come, its table row and its home/away split.
 *   h2h       — Every meeting between two clubs across the seasons loaded,
 *               with the tallies, a meeting-by-meeting chart or table, the
 *               venue split and the notable runs.
 *
 * The modes cross-link: a club in the table opens By team on that club; a
 * ribbon cell, or the H2H block inside a match report, opens Head-to-head on
 * that pairing.
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
 * Subscriptions: data:ready, route:changed, live:updated, match:updated
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import { LEAGUE_FORM_WINDOW, H2H_MEETING_WINDOW } from '../config.js';
import { fetchLivePoints, fetchMatchTimeline, fetchMatchData, attachAssists } from '../api.js';
import {
  calcLeagueTable, attachNextFixtures, addMovement, buildTeamSchedule,
} from '../engine/standings.js';
import { buildH2hMeetings, takeRecentMeetings, summariseH2h } from '../engine/h2h.js';
import { findUnderstatMatchId } from '../engine/channel.js';
import { normaliseMatchLineups } from '../engine/normalise.js';
import { buildScoreContext, scoreFixture, bandFromValue } from '../engine/composite.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// The four modes, in tab order: the label the tab reads, and its kicker.
const MODES = [
  { key: 'gameweek', label: 'Matchday',     kicker: 'GW'      },
  { key: 'table',    label: 'Table',        kicker: 'Now'     },
  { key: 'team',     label: 'By team',      kicker: 'Season'  },
  { key: 'h2h',      label: 'Head-to-head', kicker: 'History' },
];
const MODE_KEYS = MODES.map(m => m.key);

const FIRST_GW = 1;
const LAST_GW  = 38;

// Status a fixture can carry. `label` is what a tile reads; `hint` is the
// tile's accessible description of it.
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
  goal:     { icon: '⚽',     label: 'Goal' },
  own_goal: { icon: '⚽',     label: 'Own goal' },
  yellow:   { icon: '\u{1f7e8}',  label: 'Yellow card' },
  red:      { icon: '\u{1f7e5}',  label: 'Red card' },
  sub:      { icon: '⇄',     label: 'Substitution' },
};

// Reading order for a team's featured players.
const POS_ORDER = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

// League table columns, left to right. `align` is the header's alignment.
const LEAGUE_COLUMNS = [
  { label: '#',    align: '' },
  { label: '',     align: 'c', sr: 'Movement' },
  { label: 'Team', align: 'l' },
  { label: 'Pl',   align: '' },
  { label: 'W',    align: '' },
  { label: 'D',    align: '' },
  { label: 'L',    align: '' },
  { label: 'GF',   align: '' },
  { label: 'GA',   align: '' },
  { label: 'GD',   align: '' },
  { label: 'Pts',  align: '' },
  { label: 'Form', align: 'l' },
  { label: 'Next', align: 'l' },
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

// The By team stat strip, left to right. Keys are league-row fields
// (engine/standings.js), so the strip and the table can never disagree.
const TEAM_STATS = [
  { key: 'played',         label: 'Pl'  },
  { key: 'won',            label: 'W'   },
  { key: 'drawn',          label: 'D'   },
  { key: 'lost',           label: 'L'   },
  { key: 'goalsFor',       label: 'GF'  },
  { key: 'goalsAgainst',   label: 'GA'  },
  { key: 'goalDifference', label: 'GD', signed: true },
  { key: 'points',         label: 'Pts' },
];

// The By team home/away split table. Same fields as the strip above plus the
// position WITHIN that split, which is the only number the strip can't carry.
const SPLIT_COLUMNS = [
  { key: 'position',       label: 'Pos' },
  ...TEAM_STATS,
];

// Head-to-head meeting table, left to right. Date carries its year, so there
// is no separate Season column — which season a match fell in is a detail the
// date already answers, and two columns saying the same thing read as noise.
const H2H_COLUMNS = ['Date', 'Venue', 'Home', 'Score', 'Away', 'Result'];

// Ordinal suffixes for league positions 1–20; anything else falls back to 'th'.
const ORDINALS = { 1: 'st', 2: 'nd', 3: 'rd', 21: 'st', 22: 'nd', 23: 'rd' };

const BAND_LABEL = {
  excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral',
  tough: 'Tough', brutal: 'Brutal', extreme: 'Extreme',
};

// Result box shown for a finished fixture.
const OUTCOMES = {
  W: { key: 'w', label: 'Won' },
  D: { key: 'd', label: 'Drawn' },
  L: { key: 'l', label: 'Lost' },
};

const RM = window.matchMedia('(prefers-reduced-motion: reduce)');

// ─── Module-level state ───────────────────────────────────────────────────────

let _root    = null;   // [data-module="fixtures"] section
let _panel   = null;   // #fc-panel — the one pane, rebuilt per mode
let _drawer  = null;   // #fc-drawer — match report
let _scrim   = null;
let _tabs    = [];     // .mode tab buttons
let _mode    = 'gameweek';

let _gw    = null;         // gameweek the Matchday pane is showing
let _gwRoll = 'in';        // which way the GW title rolls on its next render
let _scope = 'overall';    // league table venue split
let _teamId = null;        // club the By team pane is showing
let _h2hA   = null;        // the two clubs the Head-to-head pane is comparing
let _h2hB   = null;
let _h2hView = 'chart';    // 'chart' | 'table' — the meeting-by-meeting display
let _cell   = null;        // By team ribbon: selected index (null = next up)
let _ribbon = [];          // By team ribbon entries, as last rendered

let _drawerId = null;      // fixture the match report is open on
let _drawerReturn = null;  // element focus returns to when it closes

let _hasRendered = false;
let _raf = 0;

// Gaffer IQ scores for the tiles and the ribbon: one context per data
// generation, one scoreFixture per (team, fixture). Dropped on data:ready.
let _ctx = null;
const _scores = new Map();

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

/** "1st", "2nd", "13th" — league positions, in prose. */
function ordinal(n) {
  if (!Number.isInteger(n) || n < 1) return '—';
  return `${n}${ORDINALS[n] ?? 'th'}`;
}

/** A goal difference or margin, always carrying its sign. */
function signed(n) {
  return `${n > 0 ? '+' : ''}${n}`;
}

/**
 * A team crest. Real badge when the team is known (team.badgeUrl is
 * precomputed in normalise.js), otherwise an empty ring. onerror hides a
 * missing badge rather than showing a broken-image icon.
 */
function crest(team, size = '') {
  const mod = size ? ` cr--${size}` : '';
  if (!team?.badgeUrl) return `<span class="cr-none${mod}" aria-hidden="true"></span>`;
  return `<img class="cr${mod}" src="${esc(team.badgeUrl)}" alt="" loading="lazy"`
       + ` onerror="this.style.visibility='hidden'">`;
}

/** The same badge as SVG, for an oversized watermark where the 70px PNG would blur. */
function badgeSvg(team) {
  return String(team.badgeUrl).replace('/badges/70/', '/badges/').replace(/\.png$/, '.svg');
}

function watermark(team, right = false) {
  if (!team?.badgeUrl) return '';
  return `<span class="mark${right ? ' mark--r' : ''}" aria-hidden="true"`
       + ` style="background-image:url('${esc(badgeSvg(team))}')"></span>`;
}

// ─── Date formatting ─────────────────────────────────────────────────────────
// Kickoffs arrive as ISO strings in UTC and are rendered in the viewer's local
// zone — deliberate: a personal tool should show the time you'd actually watch
// the match at. All formatting is display-only and stays in this module.

/**
 * Both feeds' date strings. FPL writes ISO-8601 with a trailing Z; Understat
 * (which reaches these formatters through the H2H meeting list) writes
 * 'YYYY-MM-DD HH:MM:SS' with a space and no zone, which only some engines
 * parse — normalising the separator makes it unambiguous everywhere.
 */
function toDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "15:00" */
function fmtTime(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'TBC';
}

/** "Sat" */
function fmtWeekdayShort(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { weekday: 'short' }) : 'TBC';
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

/** "19 Apr 2026" — short, but unambiguous across seasons. */
function fmtDateYear(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBC';
}

/** "Apr 2026" — the meeting chart's foot label. */
function fmtMonthYear(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
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
 * Win/draw/loss boxes.
 * @param {string[]} form  ['W','D','L',…] oldest → newest
 * @param {number} [d0]    entrance delay of the first box, in ms
 */
function pips(form, d0 = null, cls = '') {
  if (!form?.length) return '<span class="muted">—</span>';
  return `<span class="pips${cls ? ` ${cls}` : ''}">${form.map((r, i) => {
    const o = OUTCOMES[r];
    const d = d0 === null ? '' : ` style="--d:${d0 + i * 60}ms"`;
    return `<span class="pip pip--${o.key}" title="${esc(o.label)}" aria-label="${esc(o.label)}"${d}>${r}</span>`;
  }).join('')}</span>`;
}

/** A short "nothing to show" line. */
function emptyState(message) {
  return `<p class="muted">${esc(message)}</p>`;
}

/**
 * A "still arriving" block — the same slot emptyState fills, but for a wait
 * rather than a verdict.
 *
 * These two states used to look identical: both rendered a line of muted text,
 * so "No meeting between these teams" and "Loading match data" read as the
 * same kind of statement, and only the wording separated a settled answer from
 * a pending one. A skeleton reads as pending at a glance and, unlike the text,
 * stops reading as pending the moment it is replaced.
 *
 * The message is kept as the block's accessible label rather than dropped: a
 * shimmer conveys nothing to a screen reader.
 *
 * @param {string} message  what is being waited for, e.g. 'Loading match data'
 * @param {number} lines    how tall the placeholder should read
 */
function loadingState(message, lines = 2) {
  const rows = Array.from({ length: lines }, () => '<span class="sk"></span>').join('');
  return `<div class="sk-lines" role="status" aria-busy="true"
               aria-label="${esc(message)}" title="${esc(message)}">${rows}</div>`;
}

/**
 * The context object engine/h2h.js reads. Assembled here rather than held in
 * the store because it is a plain view over state the store already owns —
 * the same shape composite.js's buildScoreContext passes that engine.
 */
function h2hCtx() {
  return {
    teamsById:     store.getSeason()?.teamsById ?? {},
    fixtures:      store.getFixtures(),
    leagueXg:      store.getLeagueXg(),
    leagueXgPrev:  store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
  };
}

/**
 * How many Understat seasons are actually loaded. Reported to the user rather
 * than a hardcoded number, because each season's payload is fetched
 * independently at boot (main.js, Promise.allSettled) and any of them can fail
 * without taking the others down — "across 4 seasons" would then be a lie.
 */
function loadedSeasonCount() {
  return [store.getLeagueXg(), store.getLeagueXgPrev()].filter(Boolean).length
       + store.getLeagueXgHistory().length;
}

/** The pairing's head-to-head record over the standard meeting window. */
function pairRecord(teamAId, teamBId) {
  return summariseH2h(takeRecentMeetings(buildH2hMeetings(teamAId, teamBId, h2hCtx())));
}

/** Clubs, alphabetical, as <option>s with `selected` applied. */
function teamOptions(selected, placeholder) {
  const teams = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
  return `<option value="">${esc(placeholder)}</option>` + teams.map(t =>
    `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
}

// ─── Gaffer IQ score (engine calls only) ──────────────────────────────────────

/**
 * Build a fresh score context from the current store state — the same inputs
 * every other module's buildCtx passes.
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

/**
 * One side's CompositeScore for a fixture, or null where the engine cannot
 * score it. Memoised until the next data:ready.
 */
function sideScore(teamId, fixture) {
  const key = `${teamId}:${fixture.id}`;
  if (_scores.has(key)) return _scores.get(key);
  let score = null;
  try {
    _ctx ??= buildCtx();
    const team = store.getTeam(teamId);
    if (_ctx && team) score = scoreFixture(team, fixture, _ctx);
  } catch {
    score = null;
  }
  _scores.set(key, score);
  return score;
}

/**
 * Is every input to this fixture's scores in yet?
 *
 * A CompositeScore blends counter-matchup, which cannot be computed until BOTH
 * teams' Understat payloads have landed in the boot-time prefetch — so a score
 * shown before then is provisional and will rewrite itself when they do. Same
 * test the Matchup page gates its skeletons on.
 */
function fixtureScoreSettled(fixture) {
  if (!fixture) return false;
  return store.isTeamScoreSettled(fixture.homeTeamId)
      && store.isTeamScoreSettled(fixture.awayTeamId);
}

/** A score's band key, or 'none' when it is withheld or missing. */
function bandOf(score, settled) {
  return settled && typeof score?.value === 'number' ? bandFromValue(score.value) : 'none';
}

/**
 * A Gaffer IQ chip. Pending withholds the value but keeps the footprint;
 * a low-confidence score (CompositeScore.provisional) gets the dashed ring.
 */
function chip(score, settled, cls = '') {
  const has = typeof score?.value === 'number';
  const band = bandOf(score, settled);
  const classes = ['chip', cls, !settled && 'is-pending', settled && score?.provisional && 'is-est']
    .filter(Boolean).join(' ');
  const label = !settled ? 'Gaffer IQ still calculating'
    : has ? `Gaffer IQ ${Math.round(score.value)} ${BAND_LABEL[band]}` : 'Gaffer IQ: no data';
  const text = !settled ? '00' : has ? Math.round(score.value) : '—';
  return `<span class="${classes}" data-band="${band}" aria-label="${esc(label)}">${text}</span>`;
}

// ─── Matchday ─────────────────────────────────────────────────────────────────

/**
 * @returns {'ft'|'live'|'upcoming'}  which status a fixture carries.
 *   `started` is set at kickoff and `finished` (→ played) at full time, so
 *   started && !played is exactly "in progress" — no clock arithmetic needed.
 */
function statusOf(fixture) {
  if (fixture.played)  return 'ft';
  if (fixture.started) return 'live';
  return 'upcoming';
}

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

/**
 * The gameweek this tab opens on, and the one its "back" button returns to.
 *
 * `upcomingGw` — the round still to be played — rather than FPL's `is_current`,
 * which stays pointing at a round from its own deadline until the next one
 * opens and so names a finished gameweek for most of every week. Landing on a
 * round whose last whistle blew days ago made the pane read as stale on the
 * very screen a reader opens to ask what is next. See engine/normalise.js
 * deriveUpcomingGw; the raw flags stay as fallbacks for a payload that has not
 * fully arrived.
 *
 * @returns {number}
 */
function homeGw() {
  return store.getUpcomingGw() ?? store.getCurrentGw() ?? store.getNextGw() ?? FIRST_GW;
}

/**
 * One FDR / Gaffer IQ / H2H edge row on a tile: home's value, a three-part
 * bar leaning toward the side with the edge, away's value.
 */
function ratioHTML(k, h, a, fh, fd, fa, aria, delay, pending = false) {
  const flex = v => Math.max(0, Number(v) || 0);
  return `<span class="ratio${pending ? ' is-pending' : ''}" aria-label="${esc(aria)}" title="${esc(aria)}">`
    + `<span class="ratio__k" aria-hidden="true">${k}</span>`
    + `<span class="ratio__h" aria-hidden="true">${pending ? '<span class="sk-t">00</span>' : esc(h)}</span>`
    + `<span class="ratio__bar" aria-hidden="true">`
    + `<i style="flex:${flex(fh)};--d:${delay}ms"></i><i style="flex:${flex(fd)};--d:${delay}ms"></i>`
    + `<i style="flex:${flex(fa)};--d:${delay}ms"></i></span>`
    + `<span class="ratio__a" aria-hidden="true">${pending ? '<span class="sk-t">00</span>' : esc(a)}</span></span>`;
}

function ratiosHTML(f, home, away, settled, hs, as, d0) {
  const hn = home?.shortName ?? 'Home', an = away?.shortName ?? 'Away';
  const hf = f.fplDifficulty?.home, af = f.fplDifficulty?.away;
  const fdr = (hf && af)
    ? ratioHTML('FDR', hf, af, 6 - hf, 0, 6 - af,
        `FPL difficulty: ${hn} ${hf}, ${an} ${af}`, d0)
    : ratioHTML('FDR', '–', '–', 0, 1, 0, 'No FPL difficulty published', d0);

  const hg = typeof hs?.value === 'number' ? Math.round(hs.value) : null;
  const ag = typeof as?.value === 'number' ? Math.round(as.value) : null;
  const giq = !settled
    ? ratioHTML('GIQ', '', '', 0, 1, 0, 'Gaffer IQ composite still calculating', d0 + 90, true)
    : (hg !== null && ag !== null)
      ? ratioHTML('GIQ', hg, ag, hg, 0, ag, `Gaffer IQ composite: ${hn} ${hg}, ${an} ${ag}`, d0 + 90)
      : ratioHTML('GIQ', '–', '–', 0, 1, 0, 'No Gaffer IQ score', d0 + 90);

  const m = pairRecord(f.homeTeamId, f.awayTeamId);
  const h2h = m.played
    ? ratioHTML('H2H', m.aWins, m.bWins, m.aWins, m.draws, m.bWins,
        `Head-to-head, last ${m.played}: ${hn} ${m.aWins} wins, ${m.draws} draws, ${an} ${m.bWins} wins`, d0 + 180)
    : ratioHTML('H2H', '–', '–', 0, 1, 0, 'No head-to-head on record', d0 + 180);

  return fdr + giq + h2h;
}

/** One fixture tile: status, both sides with goals and Gaffer IQ, the edge strip. */
function tileHTML(f, delay) {
  const home = store.getTeam(f.homeTeamId);
  const away = store.getTeam(f.awayTeamId);
  const status = statusOf(f);
  const chipDef = STATUS_CHIPS.find(c => c.key === status);
  const settled = fixtureScoreSettled(f);
  const hs = sideScore(f.homeTeamId, f);
  const as = sideScore(f.awayTeamId, f);

  // A score is shown as soon as FPL publishes one, so a match in progress
  // carries its running score; the LIVE status beside it is what says the
  // score is not final. A fixture yet to kick off shows none — its time is
  // the slot heading above it.
  const r = f.result;
  const hn = home?.name ?? '???', an = away?.name ?? '???';
  const aria = r
    ? `${hn} ${r.homeGoals}, ${an} ${r.awayGoals}. ${chipDef.hint}.`
    : `${hn} v ${an}, kicks off ${fmtDateTime(f.kickoff)}. ${chipDef.hint}.`;

  const side = (team, goals, score) =>
    `<span class="tile__team">${crest(team)}${esc(team?.shortName ?? '???')}</span>`
    + `<span class="tile__v">${r ? `<span class="tile__g">${goals}</span>` : ''}${chip(score, settled)}</span>`;

  const cls = status === 'live' ? ' is-live' : status === 'upcoming' ? ' is-ko' : '';
  return `
    <button type="button" class="tile${cls}" id="fc-tile-${f.id}" data-fixture="${f.id}"
            aria-haspopup="dialog" aria-label="${esc(`${aria} Open match report.`)}" style="--d:${delay}ms">
      <span class="tile__st">
        <span class="st st--${status}">${status === 'live' ? '<i class="live" aria-hidden="true"></i>' : ''}${chipDef.label}</span>
        ${f.played && !f.bonusConfirmed ? '<span class="tile__prov">bonus provisional</span>' : ''}
      </span>
      <span class="tile__sides">
        ${side(home, r?.homeGoals, hs)}
        ${side(away, r?.awayGoals, as)}
      </span>
      <span class="tile__ratios">${ratiosHTML(f, home, away, settled, hs, as, delay + 280)}</span>
    </button>`;
}

/** One kickoff day: its heading, then the fixtures grouped by kickoff time. */
function dayHTML(g, di, isHomeGw) {
  const today = dayKey(new Date().toISOString()) === g.key;
  const slots = [];
  for (const f of g.fixtures) {
    const t = fmtTime(f.kickoff);
    let slot = slots.find(s => s.time === t);
    if (!slot) slots.push(slot = { time: t, fixtures: [] });
    slot.fixtures.push(f);
  }

  let tc = 0;
  const body = slots.map(s => `
    <div class="slot">
      <div class="slot__t">${esc(s.time)}<span class="rule" aria-hidden="true"></span></div>
      ${s.fixtures.map(f => tileHTML(f, di * 90 + (tc++) * 60)).join('')}
    </div>`).join('');

  const nowText = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return `
    <section class="day${today ? ' is-today' : ''}" aria-label="${esc(`${fmtWeekday(g.kickoff)} ${fmtDateLong(g.kickoff)}`)}">
      <h3 class="day__h" style="--d:${di * 90}ms">
        <span class="day__d">${esc(fmtWeekdayShort(g.kickoff))}</span>
        <span class="day__date">${esc(fmtDateLong(g.kickoff))}</span>
      </h3>
      ${body}
      ${today && isHomeGw ? `<div class="now" aria-label="Now, ${esc(nowText)}">NOW ${esc(nowText)}</div>` : ''}
    </section>`;
}

/**
 * Postponed fixtures — no gameweek assigned, awaiting a rearranged date.
 *
 * These were previously invisible everywhere in the app: they sit in the
 * fixtures array with gw === null, and every view filters by gameweek. A team
 * with a pending rearrangement simply looked like a team playing fewer games.
 *
 * Rendered once at the foot of the Matchday pane rather than inside a day
 * group, because they belong to no day and no gameweek. Returns '' when there
 * are none, which is the normal state.
 *
 * @returns {string} HTML
 */
function pendingSectionHtml() {
  const pending = store.getSeason()?.pendingFixtures ?? [];
  if (pending.length === 0) return '';

  const items = pending.map(f => {
    const h = store.getTeam(f.homeTeamId);
    const a = store.getTeam(f.awayTeamId);
    return `<span class="pp__i">${crest(h, '16')}${esc(h?.name ?? '?')} v ${crest(a, '16')}${esc(a?.name ?? '?')}`
      + ` <em>· awaiting a date</em></span>`;
  }).join('');

  return `<div class="pp hatch"><b>Postponed</b>${items}</div>`;
}

function gameweekHTML() {
  const gw       = _gw;
  const home     = homeGw();
  const event    = store.getEvents().find(e => e.id === gw) ?? null;
  const all      = store.getFixtures();
  const fixtures = all.filter(f => f.gw === gw);
  const groups   = groupByDay(fixtures);

  const first = fixtures[0]?.kickoff;
  const last  = fixtures[fixtures.length - 1]?.kickoff;
  const span  = first && last && dayKey(first) !== dayKey(last)
    ? `${fmtDateShort(first)} – ${fmtDateShort(last)}`
    : fmtDateLong(first);

  const tag = event?.isCurrent ? 'Current' : event?.isNext ? 'Next' : '';
  const n = { ft: 0, live: 0, upcoming: 0 };
  for (const f of fixtures) n[statusOf(f)]++;
  const progress = [n.ft && `${n.ft} played`, n.live && `${n.live} live`, n.upcoming && `${n.upcoming} to come`]
    .filter(Boolean).join(' · ');
  const sub = [span, `${fixtures.length} ${fixtures.length === 1 ? 'fixture' : 'fixtures'}`, progress]
    .filter(Boolean).join(' · ');

  // A gameweek is complete once every fixture in it has a final score.
  let complete = 0;
  for (let g = FIRST_GW; g <= LAST_GW; g++) {
    const list = all.filter(f => f.gw === g);
    if (list.length && list.every(f => f.played)) complete++;
  }

  const ruler = Array.from({ length: LAST_GW }, (_, i) => {
    const g = i + 1;
    const label = `Gameweek ${g}${g === home ? ' — current' : g < home ? ' — played' : ''}`;
    const cls = g === home ? 'is-home' : g < home ? 'is-past' : '';
    return `<button type="button" data-gw-to="${g}" class="${cls}" aria-label="${label}" title="${label}"`
      + ` aria-current="${g === gw}" style="--d:${i * 10}ms"></button>`;
  }).join('');

  return `
    <section aria-labelledby="fc-gw-title">
      <header class="gw__head">
        <div class="gw__top">
          <div class="gw__clock">
            <button type="button" class="gw__step" data-gw="prev" aria-label="Previous gameweek"${gw <= FIRST_GW ? ' disabled' : ''}>‹</button>
            <h2 id="fc-gw-title" class="gw__n" aria-live="polite" data-roll="${_gwRoll}">GW${gw}</h2>
            <button type="button" class="gw__step" data-gw="next" aria-label="Next gameweek"${gw >= LAST_GW ? ' disabled' : ''}>›</button>
          </div>
          <div class="gw__meta">
            <span class="gw__line">${tag ? `<span class="tag">${tag}</span>` : ''}${event ? `<b>Deadline ${esc(fmtDateTime(event.deadline))}</b>` : ''}</span>
            <span class="gw__sub">${esc(sub)}</span>
            ${gw !== home ? '<button type="button" class="gw__home" data-gw="now">Back to this GW →</button>' : ''}
          </div>
        </div>
        <div class="ruler" role="group" aria-label="Season, jump to gameweek">${ruler}</div>
        <div class="ruler__k"><span>GW${FIRST_GW}</span><span>${complete} gameweeks complete · ${LAST_GW - complete} to come</span><span>GW${LAST_GW}</span></div>
      </header>

      ${fixtures.length ? `
        <div class="days" style="--n:${Math.max(groups.length, 1)}">
          ${groups.map((g, di) => dayHTML(g, di, gw === home)).join('')}
        </div>
        <p class="note">Each tile reads home over away: goals, then the Gaffer IQ score for that side. Below, home left v away right — FPL FDR, Gaffer IQ composite and head-to-head wins (grey is draws); each bar leans toward the side with the edge. Select a tile for the match report.</p>`
      : `
        <div class="blank hatch">
          <h3>Blank gameweek</h3>
          <p>No fixtures scheduled for gameweek ${gw}.</p>
        </div>`}

      ${pendingSectionHtml()}
    </section>`;
}

// ─── Match report drawer ──────────────────────────────────────────────────────

/** One line in the FPL-grouped events fallback. */
function eventHtml({ player, kind, count }) {
  return `<li>${kind.icon} <b>${esc(player.name)}</b> <span class="muted">${count > 1 ? `×${count} ` : ''}${esc(kind.label)}</span></li>`;
}

/** One team's column of players who featured. */
function featuredHtml(list, team) {
  return `
    <div class="xi">
      <span class="xi__h xi__h--fe"><b>${crest(team, '16')}${esc(team?.shortName ?? '')}</b><span>${list.length} played</span></span>
      ${list.length ? list.map(({ player, minutes }) => `
        <span class="xr xr--fe"><span class="xr__m">${minutes}'</span><span>${esc(player.name)}</span><span class="xr__p">${esc(player.position)}</span></span>`).join('')
        : emptyState('No appearances recorded.')}
    </div>`;
}

/**
 * One line of the chronological match feed.
 *
 * A goal carries its assister on the SAME line: the two are one moment, and
 * Understat's shots JSON is what makes the pairing possible at all (FPL only
 * reports that someone assisted, never whose goal).
 *
 * Home events sit left of the centre spine, away events right of it, with the
 * minute in the middle; which side an event belongs to is carried by
 * position, so the label stays for anyone not reading the layout.
 */
function timelineEventHtml(ev, i) {
  const kind = TIMELINE_ICONS[ev.type] ?? TIMELINE_ICONS.goal;
  const goal = ev.type === 'goal' || ev.type === 'own_goal';
  const body = ev.type === 'sub'
    ? `<span><b>${esc(ev.player)}</b> → ${esc(ev.playerIn ?? '')}</span>`
    : `<span><b>${esc(ev.player)}</b>${ev.assist ? `<span class="ev__as"> assist ${esc(ev.assist)}</span>` : ''}</span>`
      + (ev.score ? `<span class="ev__sc">${esc(ev.score)}</span>` : '');

  return `
    <li class="ev ev--${ev.side}${goal ? ' ev--goal' : ''}" style="--d:${160 + i * 45}ms">
      <span class="ev__body"><span title="${esc(kind.label)}" aria-hidden="true">${kind.icon}</span>${body}</span>
      <span class="ev__min">${ev.minute}'</span>
      <span class="sr">${esc(kind.label)}, ${esc(ev.side === 'home' ? 'home team' : 'away team')}</span>
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
    <section class="blk">
      <h3 class="h-sm">Match events</h3>
      <ol class="tl">${events.map(timelineEventHtml).join('')}</ol>
      <p class="note">In order of minute, home team left of the centre line and away team right of it. Timings and goal/assist pairings come from Understat — FPL publishes neither.</p>
    </section>`;
}

/**
 * Per-player marks on a lineup row: what he did, in the order a matchday
 * programme would list it. Repeats collapse to a count.
 */
function lineupMarksText(p) {
  const marks = [];
  if (p.goals)    marks.push(`⚽${p.goals > 1 ? `×${p.goals}` : ''}`);
  if (p.ownGoals) marks.push(`⚽${p.ownGoals > 1 ? `×${p.ownGoals}` : ''} (og)`);
  if (p.assists)  marks.push(`Ⓐ${p.assists > 1 ? `×${p.assists}` : ''}`);
  if (p.yellow)   marks.push('\u{1f7e8}');
  if (p.red)      marks.push('\u{1f7e5}');
  return marks.join(' ');
}

/** One player row in the XI or the substitutes list. */
function lineupRowHtml(p, isSub) {
  // A starter who was replaced, and a substitute who came on, each carry the
  // minute it happened — the same number, read from opposite ends.
  const swap = isSub
    ? (p.cameOnFor ? `${p.onAt}' for ${p.cameOnFor}` : '')
    : (p.replacedBy ? `${p.minutes}' → ${p.replacedBy}` : '');
  const marks = lineupMarksText(p);

  if (isSub) {
    return `
      <span class="xr xr--sub"><span class="xr__p">SUB</span>
        <span class="xr__n"><span class="xr__nm">${esc(p.name)}</span> ${esc(marks)} <span class="xr__sw">${esc(swap)}</span></span>
        <span class="xr__m">${p.minutes}'</span></span>`;
  }
  return `
    <span class="xr"${swap ? ` title="${esc(swap)}"` : ''}><span class="xr__p">${esc(p.position)}</span>
      <span class="xr__n">${esc(p.name)} ${esc(marks)}</span>
      <span class="xr__m">${p.minutes}'</span></span>`;
}

/** One team's teamsheet: formation, starting XI, then the substitutes used. */
function lineupColumnHtml(side, team) {
  return `
    <div class="xi">
      <span class="xi__h"><b>${crest(team, '18')}${esc(team?.shortName ?? '')}</b>${side.formation ? `<span>${esc(side.formation)}</span>` : ''}</span>
      ${side.starters.map(p => lineupRowHtml(p, false)).join('')}
      ${side.subs.length ? `<span class="xi__sh">Substitutes used</span>${side.subs.map(p => lineupRowHtml(p, true)).join('')}` : ''}
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
    <section class="blk">
      <h3 class="h-sm">Lineups</h3>
      <div class="cols cols--xi">
        ${lineupColumnHtml(lineups.home, home)}
        ${lineupColumnHtml(lineups.away, away)}
      </div>
      <p class="note">Starting XI in position order, with the formation derived from those positions. Understat lists only players who appeared, so the second list is the substitutes USED — unused subs are published nowhere.</p>
    </section>`;
}

/**
 * The head-to-head record for one fixture's pairing, shown in its match
 * report. Rendered for UPCOMING fixtures as well as played ones — the record
 * is exactly what you want before a match, not only after it.
 */
function h2hMiniHtml(fixture, home, away) {
  // Same window as the full pane — a peek that counted a different set of
  // matches from the view it links to would be worse than no peek at all.
  const record = pairRecord(fixture.homeTeamId, fixture.awayTeamId);

  const open = `<button type="button" class="cta" data-h2h-a="${fixture.homeTeamId}"
      data-h2h-b="${fixture.awayTeamId}">Full head-to-head →</button>`;

  if (!record.played) {
    return `
      <section class="blk">
        <h3 class="h-sm">Head-to-head</h3>
        ${emptyState(loadedSeasonCount()
          ? `No meeting between ${home?.shortName ?? '???'} and ${away?.shortName ?? '???'} in the seasons loaded.`
          : 'Head-to-head history is still loading.')}
        ${open}
      </section>`;
  }

  return `
    <section class="blk">
      <h3 class="h-sm">Head-to-head</h3>
      <div class="mini">
        <span class="mini__t"><b>${record.aWins}</b><span>${esc(home?.shortName ?? 'home')} wins</span></span>
        <span class="mini__t mini__t--d"><b>${record.draws}</b><span>draws</span></span>
        <span class="mini__t"><b>${record.bWins}</b><span>${esc(away?.shortName ?? 'away')} wins</span></span>
        ${pips(record.trend)}
      </div>
      <p class="note">
        Their last ${record.played} ${record.played === 1 ? 'meeting' : 'meetings'},
        spanning ${record.seasons} ${record.seasons === 1 ? 'season' : 'seasons'}; last met
        ${esc(fmtDateLong(record.last.date))}. Boxes read from
        ${esc(home?.shortName ?? 'the home team')}’s perspective, oldest first.
      </p>
      ${open}
    </section>`;
}

/**
 * Is a match's Understat payload still on its way?
 *
 * Both blocks of the match report -- the event timeline and the lineups --
 * come from the same store.matchDetail entry, and both have an FPL-derived
 * fallback that looks nothing like the real thing: grouped totals in two
 * left-aligned lists, versus a centred minute-by-minute feed. Rendering that
 * fallback while the real payload was a second away meant opening a fixture
 * showed one layout and then visibly swapped to a different one. This lets the
 * caller say "wait" instead, so the fallback appears only when it is the final
 * answer rather than a placeholder for one.
 *
 * @param {Fixture} fixture
 * @returns {boolean}  true while the payload may still arrive
 */
function timelinePending(fixture) {
  if (_timelineFailed.has(fixture.id)) return false;
  if (store.getMatchDetail(fixture.id)) return false;
  // The fixture->match lookup is derived from Understat's league payload.
  // Until that lands ensureTimeline cannot even ask, so nothing is in flight
  // and the FPL fallback is the best available answer, not a placeholder.
  return Boolean(store.getLeagueXg());
}

/**
 * The match report half of the drawer: what happened, and who was on the
 * pitch. An upcoming fixture has neither, and a played one needs the GW's
 * live payload, fetched lazily when the drawer is first opened.
 */
function matchReportHtml(fixture, home, away) {
  const status = statusOf(fixture);

  if (status === 'upcoming') {
    return emptyState(`Not played yet — kicks off ${fmtDateTime(fixture.kickoff)}.`);
  }

  if (_liveFailed.has(fixture.gw)) {
    return emptyState(
      'Match data unavailable — the live endpoint could not be reached. Reload to retry.');
  }

  const live = store.getLive(fixture.gw);
  if (!live) {
    return loadingState('Loading match data…', 3);
  }

  const { events, featured } = indexFixtureLive(live, fixture);
  const anyEvents = events.home.length || events.away.length;

  // Understat's chronological feed is the one we want. It only exists once
  // both its calls have landed, so until then (or if they fail) fall back to
  // FPL's grouped totals rather than showing nothing.
  const timeline = timelineHtml(fixture);
  const pending  = timelinePending(fixture);

  const groupCol = (list, team) => `
    <ul class="grp">
      <li class="grp__h">${crest(team, '16')}${esc(team?.shortName ?? '')}</li>
      ${list.length ? list.map(eventHtml).join('') : '<li class="muted">Nothing recorded.</li>'}
    </ul>`;

  const eventsBlock = timeline ?? (pending ? `
      <section class="blk">
        <h3 class="h-sm">Match events</h3>
        ${loadingState('Loading the minute-by-minute feed…', 3)}
      </section>` : `
      <section class="blk blk--alt">
        <h3 class="h-sm">Match events</h3>
        ${anyEvents
          ? `<div class="cols">${groupCol(events.home, home)}${groupCol(events.away, away)}</div>`
          : emptyState('No goals, assists or cards recorded.')}
        <p class="note">Understat’s timeline is unavailable for this match, so these are FPL’s per-match totals: grouped by type, without minutes.${
          fixture.played && !fixture.bonusConfirmed ? ' Bonus points for this match are still provisional.' : ''}</p>
      </section>`);

  return `
      ${eventsBlock}

      ${lineupsHtml(fixture, home, away) ?? (pending ? `
      <section class="blk">
        <h3 class="h-sm">Lineups</h3>
        ${loadingState('Loading the teamsheets…', 3)}
      </section>` : `
      <section class="blk blk--alt">
        <h3 class="h-sm">Who featured</h3>
        <div class="cols cols--fe">
          ${featuredHtml(featured.home, home)}
          ${featuredHtml(featured.away, away)}
        </div>
        <p class="note">Every player with minutes, longest first within each position — FPL publishes no teamsheet. The real XI comes from Understat and is not available for this match.</p>
      </section>`)}`;
}

function drawerHTML(f) {
  const home = store.getTeam(f.homeTeamId);
  const away = store.getTeam(f.awayTeamId);
  const status = statusOf(f);
  const chipDef = STATUS_CHIPS.find(c => c.key === status);
  const settled = fixtureScoreSettled(f);
  const hs = sideScore(f.homeTeamId, f);
  const as = sideScore(f.awayTeamId, f);
  const centre = f.result ? `${f.result.homeGoals}–${f.result.awayGoals}` : fmtTime(f.kickoff);
  const bandName = (s) => {
    const b = bandOf(s, settled);
    return b === 'none' ? '' : `<span class="bandname" data-band="${b}">${BAND_LABEL[b]}</span>`;
  };

  return `
    <header class="dr__head">
      <div class="dr__bar">
        <span class="st st--${status}">${status === 'live' ? '<i class="live" aria-hidden="true"></i>' : ''}${chipDef.label} · ${esc(fmtDateTime(f.kickoff))}</span>
        <button type="button" class="btn" id="fc-drawer-close" data-close>Close <kbd>Esc</kbd></button>
      </div>
      <h2 id="fc-drawer-title" class="dr__title">
        <span class="dr__side">${crest(home, '36')}${esc(home?.name ?? '???')}</span>
        <span class="dr__score">${esc(centre)}</span>
        <span class="dr__side dr__side--a">${esc(away?.name ?? '???')}${crest(away, '36')}</span>
      </h2>
      <div class="dr__giq">
        <span>${chip(hs, settled, 'chip--md')}${bandName(hs)}</span>
        <span class="muted">Gaffer IQ</span>
        <span>${bandName(as)}${chip(as, settled, 'chip--md')}</span>
        <a href="#matchup" class="dr__mx">Matchup Analyser →</a>
      </div>
    </header>
    <div class="dr__body">
      ${matchReportHtml(f, home, away)}
      ${h2hMiniHtml(f, home, away)}
    </div>`;
}

/**
 * Paint the open match report. Its body keeps its scroll position across a
 * repaint (a live payload landing), and only an open animates its entrances.
 */
function renderDrawer(animate = false) {
  if (_drawerId === null || !_drawer) return;
  const f = store.getFixture(_drawerId);
  if (!f) { closeDrawer(); return; }
  const scroll = _drawer.querySelector('.dr__body')?.scrollTop ?? 0;
  _drawer.toggleAttribute('data-anim', animate);
  _drawer.innerHTML = drawerHTML(f);
  const body = _drawer.querySelector('.dr__body');
  if (body && !animate) body.scrollTop = scroll;
}

/**
 * Opening a fixture is what triggers its GW's live fetch — the payload is
 * needed by nothing else, so nothing pays for it until a user asks.
 */
function openDrawer(fixtureId, from) {
  const fixture = store.getFixture(fixtureId);
  if (!fixture || !_drawer) return;
  _drawerId = fixtureId;
  _drawerReturn = from ?? document.activeElement;

  if (statusOf(fixture) !== 'upcoming') {
    ensureLive(fixture.gw);
    ensureTimeline(fixture);
  }

  renderDrawer(true);
  _drawer.hidden = false;
  _scrim.hidden = false;
  _drawer.querySelector('#fc-drawer-close')?.focus();
}

function closeDrawer() {
  if (_drawerId === null) return;
  const id = _drawerId;
  _drawerId = null;
  _drawer.hidden = true;
  _scrim.hidden = true;
  _drawer.innerHTML = '';
  const back = (_drawerReturn?.isConnected ? _drawerReturn : null)
    ?? _panel.querySelector(`#fc-tile-${id}`);
  _drawerReturn = null;
  back?.focus();
}

// ─── Live payload (match events + appearances) ────────────────────────────────

/**
 * Fetch and cache one GW's live payload, once. Fire-and-forget: the drawer
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
      renderDrawer();
    });
}

/**
 * Give up on a fixture's timeline, and repaint so the UI stops waiting for it.
 *
 * The repaint is not optional. matchReportHtml renders a "loading"
 * placeholder for as long as timelinePending() is true, and this flag is what
 * makes it false -- so a path that sets the flag without repainting leaves the
 * placeholder on screen permanently.
 *
 * Deferred to a microtask because the "no match id" path runs synchronously
 * inside openDrawer, before the drawer's first paint.
 *
 * @param {number} fixtureId
 * @param {string} reason  logged, not shown -- the UI wording is fixed copy
 */
function failTimeline(fixtureId, reason) {
  _timelineFailed.add(fixtureId);
  console.warn(`[fixtures] ${reason}`);
  queueDrawerRepaint();
}

// Set while a repaint is already queued, so several failures in one task
// collapse to one repaint.
let _repaintQueued = false;

/** Repaint the match report once, after the current task finishes. */
function queueDrawerRepaint() {
  if (_repaintQueued) return;
  _repaintQueued = true;
  queueMicrotask(() => {
    _repaintQueued = false;
    renderDrawer();
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
 * Fire-and-forget; the drawer re-renders off 'match:updated'. Failures are
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
    // record of this fixture. Flag it so the FPL fallback replaces the loading
    // placeholder instead of the placeholder sitting there for ever.
    failTimeline(fixture.id, `no Understat match found for fixture ${fixture.id}`);
    return;
  }

  _timelineRequested.add(fixture.id);

  fetchMatchTimeline(matchId)
    .then(async (events) => {
      if (!events.length) {
        failTimeline(fixture.id, `Understat returned an empty timeline for fixture ${fixture.id}`);
        return;
      }

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
      failTimeline(fixture.id,
        `Understat timeline unavailable for fixture ${fixture.id}: ${err.message ?? err}`);
    });
}

// ─── League table ─────────────────────────────────────────────────────────────

/**
 * @param {number} pos  1-based league position
 * @returns {object|null}  the zone the position falls in, if any.
 */
function zoneFor(pos) {
  return LEAGUE_ZONES.find(z => pos >= z.from && pos <= z.to) ?? null;
}

/** ▲ / – / ▼ for a team's movement since the previous gameweek. */
function movementHtml(movement) {
  if (movement > 0) return `<span class="mv--up" title="Up ${movement}" aria-label="Up ${movement}">▲</span>`;
  if (movement < 0) return `<span class="mv--down" title="Down ${-movement}" aria-label="Down ${-movement}">▼</span>`;
  return '<span class="muted" title="No change" aria-label="No change">–</span>';
}

/** The Next column: opponent crest, short name, venue and official FDR. */
function nextFixtureHtml(next) {
  if (!next) return '<span class="muted">—</span>';
  return `<span class="club">${crest(next.opponent, '18')}`
       + `<b title="${esc(next.opponent?.name ?? '')}">${esc(next.opponent?.shortName ?? '???')}</b>`
       + `<span>(${next.isHome ? 'H' : 'A'})</span>`
       + (next.difficulty
           ? `<span class="fdr" title="Official FPL difficulty" aria-label="FPL difficulty ${next.difficulty} of 5">${next.difficulty}</span>`
           : '')
       + '</span>';
}

function leagueRowHtml(row) {
  const zone = zoneFor(row.position);
  return `
    <tr>
      <td class="pos"${zone ? ` data-zone="${zone.key}" title="${esc(zone.label)}"` : ''}>${row.position}</td>
      <td class="mv">${movementHtml(row.movement)}</td>
      <td class="team"><span class="club">${crest(row.team)}
        <button type="button" class="linkb" data-team="${row.teamId}">${esc(row.team.name)}</button></span></td>
      <td>${row.played}</td>
      <td>${row.won}</td>
      <td>${row.drawn}</td>
      <td>${row.lost}</td>
      <td>${row.goalsFor}</td>
      <td>${row.goalsAgainst}</td>
      <td>${signed(row.goalDifference)}</td>
      <td class="pts">${row.points}</td>
      <td class="form">${pips(row.form)}</td>
      <td class="next">${nextFixtureHtml(row.nextFixture)}</td>
    </tr>`;
}

function tableHTML() {
  const season   = store.getSeason();
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

  const lastKickoff = played.reduce(
    (latest, f) => (f.kickoff && (!latest || f.kickoff > latest) ? f.kickoff : latest), null);

  const scopeNote = _scope === 'overall'
    ? 'All fixtures.'
    : `${_scope === 'home' ? 'Home' : 'Away'} fixtures only — positions are for this split, not the real table.`;

  const scopes = [['overall', 'Overall'], ['home', 'Home'], ['away', 'Away']].map(([k, label]) =>
    `<button type="button" data-scope="${k}" aria-pressed="${_scope === k}">${label}</button>`).join('');

  return `
    <section class="lt" aria-labelledby="fc-lt-title">
      <div class="lt__scope">
        <span class="lbl" id="fc-scope-label">Split</span>
        <div class="seg" role="group" aria-labelledby="fc-scope-label">${scopes}</div>
      </div>

      <header class="lt__head">
        <div class="lt__title">
          <h2 id="fc-lt-title" class="h-xl">League table</h2>
          <p class="meta">
            <span>After ${lastGw} ${lastGw === 1 ? 'gameweek' : 'gameweeks'}</span>
            ${lastKickoff ? `<span>Latest result ${esc(fmtDateShort(lastKickoff))}</span>` : ''}
            <span>${esc(scopeNote)}</span>
          </p>
        </div>
        <ul class="zones" aria-label="Table zones">
          ${LEAGUE_ZONES.map(z => `<li data-zone="${z.key}"><i aria-hidden="true"></i>${esc(z.label)}</li>`).join('')}
        </ul>
      </header>

      ${played.length ? `
        <div class="tw" role="region" aria-labelledby="fc-lt-title" tabindex="0">
          <table>
            <caption class="sr">League table, ${_scope === 'overall' ? 'all fixtures' : `${_scope} fixtures only`}. Select a club to open its season.</caption>
            <thead>
              <tr>${LEAGUE_COLUMNS.map(c =>
                `<th scope="col"${c.align ? ` class="${c.align}"` : ''}>${esc(c.label)}${c.sr ? `<span class="sr">${c.sr}</span>` : ''}</th>`).join('')}</tr>
            </thead>
            <tbody>${rows.map(leagueRowHtml).join('')}</tbody>
          </table>
        </div>

        <p class="note">Accumulated from finished fixtures — FPL publishes no standings endpoint. Ordering is points, then goal difference, then goals scored; clubs level on all three are shown alphabetically rather than split by head-to-head. Form is the last ${LEAGUE_FORM_WINDOW} results, most recent last. Next shows the official FPL 1–5 difficulty, not the Gaffer IQ score.</p>`
        : '<p class="empty">No fixtures have been played yet this season.</p>'}
    </section>`;
}

// ─── By team ──────────────────────────────────────────────────────────────────

/**
 * One club's season as ribbon entries, oldest result first, then every fixture
 * still to come. The split between the two is buildTeamSchedule's own (played
 * AND scored), so a result the table has not counted is not shown as one here.
 */
function ribbonEntries(team) {
  const { results, upcoming } = buildTeamSchedule(
    team.id, store.getFixtures(), store.getSeason().teamsById);
  // "Next up" is the gameweek whose deadline comes next — the one a manager is
  // picking for — not the round that may still be in progress.
  const pickGw = store.getNextGw() ?? homeGw();

  return [...results, ...upcoming].map(e => {
    const fixture = store.getFixture(e.fixtureId);
    const played = e.outcome !== null;
    const postponed = e.gw === null;
    const live = !played && e.started;
    const settled = played || fixtureScoreSettled(fixture);
    const score = played || !fixture ? null : sideScore(team.id, fixture);
    let running = '';
    if (live && fixture?.result) {
      const { homeGoals, awayGoals } = fixture.result;
      running = e.isHome ? `${homeGoals}–${awayGoals}` : `${awayGoals}–${homeGoals}`;
    }
    return {
      ...e, team, played, postponed, live, settled, score, running,
      isNext: !played && !postponed && !e.started && e.gw === pickGw,
    };
  });
}

/** The cell's accessible name — everything the tile shows, in a sentence. */
function cellAria(e) {
  const where = `${e.gw === null ? 'Unscheduled' : `GW${e.gw}`}, ${e.opponent?.name ?? 'TBC'} ${e.isHome ? 'home' : 'away'}`;
  if (e.played) return `${where}, ${OUTCOMES[e.outcome].label} ${e.scored}–${e.conceded}`;
  if (e.postponed) return `${where}, postponed`;
  const band = bandOf(e.score, e.settled);
  const giq = !e.settled ? 'Gaffer IQ still calculating'
    : typeof e.score?.value === 'number' ? `Gaffer IQ ${Math.round(e.score.value)} ${BAND_LABEL[band]}` : 'no Gaffer IQ score';
  return `${e.isNext ? 'Next up, ' : ''}${where}, ${e.live ? `live ${e.running}, ` : ''}${giq}, FPL difficulty ${e.difficulty ?? '—'}`;
}

function cellHTML(e, i, sel, nPlayed) {
  const band = e.played || e.postponed ? null : bandOf(e.score, e.settled);
  const delay = e.played ? i * 18 : 220 + (i - nPlayed) * 18;
  const has = typeof e.score?.value === 'number';
  let val;
  if (e.played) val = `${e.scored}–${e.conceded}`;
  else if (e.postponed) val = 'PP';
  else if (!e.settled) val = '<span class="sk-t">00</span>';
  else if (e.live) val = `${esc(e.running)} live`;
  else val = has ? `${Math.round(e.score.value)}${e.isNext ? ` ${BAND_LABEL[band]}` : ''}` : '—';

  const cls = ['cell', e.isNext && 'is-next', e.live && 'is-live', e.postponed && 'is-pp',
    e.settled && e.score?.provisional && 'is-est'].filter(Boolean).join(' ');
  const attrs = e.played ? ` data-out="${OUTCOMES[e.outcome].key}"` : band ? ` data-band="${band}"` : '';

  return `
    <button type="button" role="gridcell" class="${cls}"${attrs} id="fc-cell-${i}" data-cell="${i}"
            tabindex="${sel ? 0 : -1}" aria-selected="${sel}" aria-label="${esc(cellAria(e))}"
            style="--d:${delay}ms;--dt:${delay + 420}ms">
      <span class="cell__top"><span class="cell__gw">${e.gw === null ? '—' : `GW${e.gw}`}</span>${e.isNext ? '<span class="cell__tag">Next up</span>' : ''}</span>
      <span class="cell__opp"><span class="cell__o">${crest(e.opponent, '16')}${esc(e.opponent?.shortName ?? 'TBC')}</span><span class="cell__v">${e.isHome ? 'HOME' : 'AWAY'}</span></span>
      ${e.isNext ? `<span class="cell__meta">${esc(fmtDateTime(e.kickoff))} · FDR ${e.difficulty ?? '—'}</span>` : ''}
      <span class="cell__val">${val}</span>
    </button>`;
}

/** The selected cell, read out in full under the ribbon. */
function cellDetailHTML(e) {
  if (!e) return '<b>No fixtures</b>';
  const when = e.postponed ? 'Postponed — awaiting a date' : fmtDateTime(e.kickoff);
  let detail = '';
  if (e.played) {
    detail = `${OUTCOMES[e.outcome].label} ${e.scored}–${e.conceded}`;
  } else if (!e.postponed) {
    const band = bandOf(e.score, e.settled);
    const giq = !e.settled ? 'Gaffer IQ still calculating'
      : typeof e.score?.value === 'number' ? `Gaffer IQ ${Math.round(e.score.value)} ${BAND_LABEL[band]}` : 'No Gaffer IQ score';
    detail = `${e.live ? `Live ${e.running} · ` : ''}${giq} · FPL FDR ${e.difficulty ?? '—'}`;
  }
  return `<b>${e.gw === null ? '—' : `GW${e.gw}`} · ${esc(e.opponent?.name ?? 'TBC')}</b>`
    + `<span class="muted">${e.isHome ? 'Home' : 'Away'} · ${esc(when)}</span>`
    + (detail ? `<span>${esc(detail)}</span>` : '')
    + (e.opponent ? `<button type="button" class="btn" data-h2h-a="${e.team.id}" data-h2h-b="${e.opponent.id}">Head-to-head →</button>` : '');
}

/** The ribbon's default cell: the next-up fixture, else the first to come. */
function defaultCell(entries) {
  const next = entries.findIndex(e => e.isNext);
  if (next >= 0) return next;
  const firstUpcoming = entries.findIndex(e => !e.played);
  return firstUpcoming >= 0 ? firstUpcoming : Math.max(0, entries.length - 1);
}

/**
 * One venue's line in the By team home/away split.
 *
 * Position is blanked until the team has played at that venue: with nothing
 * to separate them every club is level, so the sort falls through to the
 * alphabetical tiebreak and "2nd away" would be a statement about the club's
 * name, not its record.
 */
function splitRowHtml(label, row) {
  const cell = (c) => {
    if (!row) return '—';
    if (c.key === 'position' && !row.played) return '—';
    return c.signed ? signed(row[c.key]) : row[c.key];
  };
  return `<tr><th scope="row">${esc(label)}</th>${SPLIT_COLUMNS.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`;
}

function teamHTML() {
  const team = _teamId === null ? null : store.getTeam(_teamId);
  const picker = `<label class="sel"><span class="lbl">Club</span>`
    + `<select data-select="team" aria-label="Club">${teamOptions(_teamId, 'Select a team…')}</select></label>`;

  if (!team) {
    _ribbon = [];
    return `<section>${picker}<p class="empty">Pick a team above — or click a club in the Table — to see its season.</p></section>`;
  }

  const fixtures  = store.getFixtures();
  const teams     = store.getTeams();
  const rowFor  = venue => calcLeagueTable(fixtures, teams, { venue })
    .find(r => r.teamId === team.id) ?? null;
  const overall = rowFor('overall');
  const homeRow = rowFor('home');
  const awayRow = rowFor('away');

  const entries = ribbonEntries(team);
  _ribbon = entries;
  const nPlayed = entries.filter(e => e.played).length;
  if (_cell === null || _cell >= entries.length) _cell = defaultCell(entries);

  const nextE = entries.find(e => !e.played && !e.postponed) ?? null;
  const nextText = nextE
    ? `${nextE.opponent?.shortName ?? 'TBC'} (${nextE.isHome ? 'H' : 'A'}) · ${fmtDateShort(nextE.kickoff)}`
    : 'Season complete';

  const results = entries.slice(0, nPlayed);
  const upcoming = entries.slice(nPlayed);
  const pickGw = store.getNextGw() ?? homeGw();
  const pickEvent = store.getEvents().find(ev => ev.id === pickGw);
  const wdl = ['W', 'D', 'L'].map(r => `${results.filter(e => e.outcome === r).length}${r}`).join(' ');

  const pos = overall?.played ? overall.position : null;
  const stat = (s) => {
    if (!overall) return '—';
    const v = overall[s.key];
    return s.signed || v < 0 ? signed(v) : `<span data-cu="${v}">${v}</span>`;
  };

  return `
    <section aria-labelledby="fc-team-name">
      <div class="tm__hero">
        <div class="tm__card">${watermark(team)}
          ${picker}
          <h2 id="fc-team-name" class="tm__name">${esc(team.name)}</h2>
          <p class="tm__meta">
            <span class="pips">Form&nbsp;${pips(overall?.form ?? [], 300, 'pips--lg')}</span>
            <span>Next <b>${esc(nextText)}</b></span>
          </p>
        </div>
        <div class="tm__pos">
          <span class="lbl">In the table</span>
          <span class="tm__ord">${pos ? `<span data-cu="${pos}" data-min="1">${pos}</span>${ORDINALS[pos] ?? 'th'}` : '—'}</span>
        </div>
      </div>

      <ul class="stats" aria-label="Season record">
        ${TEAM_STATS.map((s, i) => `<li style="--d:${120 + i * 50}ms"><b>${stat(s)}</b><span>${esc(s.label)}</span></li>`).join('')}
      </ul>

      <div class="rb">
        <header class="sub-h"><h3 class="h-md">Season ribbon</h3><span>Arrows move, Enter opens head-to-head</span></header>
        <div class="rb__grids" data-ribbon>
          ${results.length ? `
            <div class="rb__grp" role="grid" aria-label="Played, oldest first">
              <div class="rb__gh"><b>Played</b><span>${nPlayed} · ${wdl} · oldest first</span><span class="rule" aria-hidden="true"></span></div>
              <div class="rb__row" role="row">${results.map((e, i) => cellHTML(e, i, i === _cell, nPlayed)).join('')}</div>
            </div>` : ''}
          ${upcoming.length ? `
            <div class="rb__grp" role="grid" aria-label="To come, soonest first">
              <div class="rb__gh"><b>To come</b><span>${upcoming.length} to play${pickEvent ? ` · GW${pickGw} deadline ${esc(fmtDateTime(pickEvent.deadline))}` : ''}</span><span class="rule" aria-hidden="true"></span></div>
              <div class="rb__row" role="row">${upcoming.map((e, j) => cellHTML(e, nPlayed + j, nPlayed + j === _cell, nPlayed)).join('')}</div>
            </div>` : ''}
        </div>
        <div class="rb__detail" id="fc-cell" aria-live="polite">${cellDetailHTML(entries[_cell])}</div>
        <p class="rb__key"><span>Played: score + W/D/L tint</span><span>To come: Gaffer IQ band + FPL FDR</span><span>Blue tag: next gameweek, the one you’re picking for</span><span>Hatched: postponed</span><span>Red ring: live</span><span>Dashed: low-confidence score</span></p>
      </div>

      <div class="split scroll" tabindex="0" role="region" aria-label="Home and away split">
        <table class="dt">
          <caption><b>Home / away split</b> <span>position is within that split, not the real table</span></caption>
          <thead><tr><th scope="col">Venue</th>${SPLIT_COLUMNS.map(c => `<th scope="col">${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${splitRowHtml('Home', homeRow)}${splitRowHtml('Away', awayRow)}</tbody>
        </table>
      </div>

      <p class="note">Accumulated from FPL's fixture list — there is no standings endpoint to read this from. A fixture appears under Played only once it carries a final score, so one flagged finished while FPL is still processing the round stays under To come until its score lands. Kickoffs are shown in your local time; FDR is the official FPL 1–5 difficulty, the band is the Gaffer IQ score. Double-click a fixture, or press Enter on it, for the full head-to-head.</p>
    </section>`;
}

/**
 * Move the ribbon selection without a re-render, so picking a cell doesn't
 * replay the whole pane's entrances.
 */
function pickCell(i, focus = false) {
  if (!_ribbon.length) return;
  const n = Math.max(0, Math.min(_ribbon.length - 1, i));
  const cells = _panel.querySelectorAll('[data-cell]');
  if (n !== _cell) {
    _cell = n;
    cells.forEach(c => {
      const on = Number(c.dataset.cell) === n;
      c.setAttribute('aria-selected', String(on));
      c.tabIndex = on ? 0 : -1;
    });
    const detail = _panel.querySelector('#fc-cell');
    if (detail) detail.innerHTML = cellDetailHTML(_ribbon[n]);
  }
  if (focus) cells[n]?.focus();
}

/** Arrow keys walk the ribbon; up/down jump a visual row. */
function onRibbonKey(e) {
  const cell = e.target.closest('[data-cell]');
  if (!cell) return;
  const i = Number(cell.dataset.cell);
  const cells = [..._panel.querySelectorAll('[data-cell]')];
  const perRow = Math.max(1, cells.filter(c => c.offsetTop === cell.offsetTop).length);
  let n;
  switch (e.key) {
    case 'ArrowRight': n = i + 1; break;
    case 'ArrowLeft':  n = i - 1; break;
    case 'ArrowDown':  n = i + perRow; break;
    case 'ArrowUp':    n = i - perRow; break;
    case 'Home':       n = 0; break;
    case 'End':        n = cells.length - 1; break;
    case 'Enter': {
      e.preventDefault();
      const entry = _ribbon[i];
      if (entry?.opponent) { selectH2h(entry.team.id, entry.opponent.id); setMode('h2h'); }
      return;
    }
    default: return;
  }
  e.preventDefault();
  pickCell(n, true);
}

// ─── Head-to-head ─────────────────────────────────────────────────────────────

/** The current unbroken run, in prose, read from team A's end. */
function streakText(streak, teamA, teamB) {
  if (!streak) return '—';
  const { outcome, count } = streak;

  if (count === 1) {
    if (outcome === 'D') return 'The last meeting was drawn';
    return `${outcome === 'W' ? teamA.shortName : teamB.shortName} won the last meeting`;
  }
  if (outcome === 'D') return `The last ${count} meetings were drawn`;
  return `${outcome === 'W' ? teamA.shortName : teamB.shortName} have won the last ${count}`;
}

/** A meeting as a one-line scoreline, read from team A's end. */
function marginText(meeting) {
  if (!meeting) return null;
  return `${meeting.goalsForA}–${meeting.goalsAgainstA}`
       + ` ${meeting.aWasHome ? 'at home' : 'away'}, ${meeting.season ?? fmtDateShort(meeting.date)}`;
}

/** One meeting in the full history table. */
function h2hRowHtml(meeting, teamA, teamB) {
  const home = meeting.aWasHome ? teamA : teamB;
  const away = meeting.aWasHome ? teamB : teamA;
  const outcome = OUTCOMES[meeting.outcomeA];
  const result = `${teamA.shortName} ${outcome.label.toLowerCase()}`;

  return `
    <tr>
      <td class="mono">${esc(fmtDateYear(meeting.date))}</td>
      <td title="${esc(teamA.shortName)} ${meeting.aWasHome ? 'at home' : 'away'}"><span class="vn">${meeting.aWasHome ? 'H' : 'A'}</span></td>
      <td class="disp"><span class="club">${crest(home, '18')}${esc(home?.shortName ?? meeting.homeName)}</span></td>
      <td class="disp">${meeting.homeGoals}–${meeting.awayGoals}</td>
      <td class="disp"><span class="club">${crest(away, '18')}${esc(away?.shortName ?? meeting.awayName)}</span></td>
      <td><span class="pip pip--${outcome.key}" style="--s:24px" title="${esc(result)}" aria-label="${esc(result)}">${meeting.outcomeA}</span></td>
    </tr>`;
}

/** Meeting-by-meeting bars: A's goals above the line, B's below, oldest left. */
function chartHTML(meetings, teamA, teamB) {
  const maxG = Math.max(3, ...meetings.map(m => Math.max(m.goalsForA, m.goalsAgainstA)));
  // The winner's bar is solid, a draw's are grey, the loser's recede.
  const bar = (goals, cls, delay) => `<span class="mt__b${cls}"`
    + ` style="--h:${(goals / maxG) * 100}%;--d:${delay}ms">${goals || ''}</span>`;
  const items = meetings.map((m, i) => {
    const o = OUTCOMES[m.outcomeA];
    const home = m.aWasHome ? teamA : teamB;
    const away = m.aWasHome ? teamB : teamA;
    const aria = `${fmtDateYear(m.date)}: ${home.shortName} ${m.homeGoals}–${m.awayGoals} ${away.shortName} — ${teamA.shortName} ${o.label.toLowerCase()}`;
    const clsA = m.outcomeA === 'W' ? ' is-win' : m.outcomeA === 'D' ? ' is-draw' : '';
    const clsB = m.outcomeA === 'L' ? ' is-win' : m.outcomeA === 'D' ? ' is-draw' : '';
    return `
      <li class="mt" aria-label="${esc(aria)}">
        <span class="mt__up" aria-hidden="true">${bar(m.goalsForA, clsA, i * 55)}</span>
        <span class="mt__line" aria-hidden="true"></span>
        <span class="mt__dn" aria-hidden="true">${bar(m.goalsAgainstA, clsB, i * 55)}</span>
        <span class="mt__f" aria-hidden="true"><span class="pip pip--${o.key}">${m.outcomeA}</span><span>${esc(fmtMonthYear(m.date))}</span></span>
      </li>`;
  }).join('');

  return `
    <div class="chart">
      <div class="chart__axis" aria-hidden="true"><span>${esc(teamA.shortName)} goals</span><span>${esc(teamB.shortName)} goals</span></div>
      <ol aria-label="Meetings, oldest first" style="--n:${meetings.length || 1}">${items}</ol>
    </div>
    <p class="note">Oldest left. Bars above the line are ${esc(teamA.name)}’s goals, below are ${esc(teamB.name)}’s; the winner’s bar is solid, a draw is grey. W/D/L read from ${esc(teamA.name)}’s perspective, oldest first.</p>`;
}

function h2hHTML() {
  const teamA = _h2hA === null ? null : store.getTeam(_h2hA);
  const teamB = _h2hB === null ? null : store.getTeam(_h2hB);

  const picker = `
    <div class="h2h__pick">
      <label class="sel"><span class="sr">Team A</span><select data-select="a">${teamOptions(_h2hA, 'Team A…')}</select></label>
      <button type="button" class="swap" data-swap aria-label="Swap the two teams">⇄</button>
      <label class="sel"><span class="sr">Team B</span><select data-select="b">${teamOptions(_h2hB, 'Team B…')}</select></label>
    </div>`;
  const message = (title, msg) => `<section aria-labelledby="fc-h2h-title">${picker}`
    + `<div class="msg"><h2 id="fc-h2h-title">${esc(title)}</h2><p>${esc(msg)}</p></div></section>`;

  if (!teamA || !teamB) {
    return message('Pick two teams', 'Choose a club on each side above, or open a fixture and follow its head-to-head link.');
  }
  if (teamA.id === teamB.id) {
    return message('Pick two different teams', `${teamA.name} cannot play itself.`);
  }

  // The window is applied HERE, once: everything below — tallies, venue
  // split, run of form, table — then describes the same set of matches.
  const onRecord = buildH2hMeetings(teamA.id, teamB.id, h2hCtx());
  const meetings = takeRecentMeetings(onRecord);
  const record   = summariseH2h(meetings);
  const capped   = onRecord.length > meetings.length;
  const seasonsLoaded = loadedSeasonCount();

  if (!record.played) {
    return message(`${teamA.name} vs ${teamB.name}`, seasonsLoaded
      ? `No league meeting in the ${seasonsLoaded} ${seasonsLoaded === 1 ? 'season' : 'seasons'} loaded — the two have not been in this division together in that window.`
      : 'Historical results are still loading.');
  }

  const { aHome, aAway } = record.venue;
  const views = [['chart', 'Chart'], ['table', 'Table']].map(([k, label]) =>
    `<button type="button" data-view="${k}" aria-pressed="${_h2hView === k}">${label}</button>`).join('');

  const bBest = record.biggestB
    ? `${record.biggestB.goalsAgainstA}–${record.biggestB.goalsForA} ${record.biggestB.aWasHome ? 'away' : 'at home'}, ${record.biggestB.season ?? fmtDateShort(record.biggestB.date)}`
    : 'No win on record';

  return `
    <section aria-labelledby="fc-h2h-title">
      ${picker}

      <header class="hh">${watermark(teamA)}${watermark(teamB, true)}
        <div class="hh__side"><span class="hh__n" data-cu="${record.aWins}">${record.aWins}</span><span class="hh__name" id="fc-h2h-title">${esc(teamA.name)}</span></div>
        <div class="hh__d"><b data-cu="${record.draws}">${record.draws}</b><span class="lbl">Draws</span></div>
        <div class="hh__side hh__side--b"><span class="hh__n" data-cu="${record.bWins}">${record.bWins}</span><span class="hh__name">${esc(teamB.name)}</span></div>
      </header>
      <div class="hh__bar" role="img" aria-label="${esc(`${teamA.name} ${record.aWins} wins, ${record.draws} draws, ${teamB.name} ${record.bWins} wins`)}">
        <i style="flex:${record.aWins}"></i><i style="flex:${record.draws}"></i><i style="flex:${record.bWins}"></i>
      </div>
      <p class="hh__meta">
        <span>${capped
          ? `Last ${record.played} of ${onRecord.length} meetings`
          : `${record.played} ${record.played === 1 ? 'meeting' : 'meetings'} on record`}</span>
        <span>Spanning ${record.seasons} ${record.seasons === 1 ? 'season' : 'seasons'}</span>
        <span>Last met ${esc(fmtDateLong(record.last.date))}</span>
        <span>Goals ${record.goalsA}–${record.goalsB} · ${record.avgGoals.toFixed(2)} a game</span>
      </p>

      <div class="mm">
        <div class="mm__h">
          <h3 class="h-md">Meeting by meeting</h3>
          <div class="seg" role="group" aria-label="Display">${views}</div>
        </div>
        ${_h2hView === 'chart' ? chartHTML(meetings, teamA, teamB) : `
          <div class="scroll" tabindex="0" role="region" aria-label="Meetings table">
            <table class="dt dt--meet">
              <thead><tr>${H2H_COLUMNS.map(c => `<th scope="col">${c}</th>`).join('')}</tr></thead>
              <tbody>${meetings.slice().reverse().map(m => h2hRowHtml(m, teamA, teamB)).join('')}</tbody>
            </table>
          </div>`}
      </div>

      <div class="h2h__cols">
        <div class="scroll" tabindex="0" role="region" aria-label="Venue split">
          <table class="dt dt--venue">
            <caption><b>Venue split</b> <span>${esc(teamA.shortName)}’s record by where it was played</span></caption>
            <thead><tr><th scope="col">Venue</th><th scope="col">Pl</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col">GF</th><th scope="col">GA</th></tr></thead>
            <tbody>
              ${[['At home', aHome], ['Away', aAway]].map(([label, v]) => `
                <tr><th scope="row">${label}</th><td>${v.played}</td><td>${v.wins}</td><td>${v.draws}</td><td>${v.losses}</td><td>${v.goalsFor}</td><td>${v.goalsAgainst}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="notable">
          <h3 class="h-sm">Notable</h3>
          <dl>
            <div><dt>Current run</dt><dd>${esc(streakText(record.streak, teamA, teamB))}</dd></div>
            <div><dt>${esc(teamA.shortName)}’s best</dt><dd>${esc(marginText(record.biggestA) ?? 'No win on record')}</dd></div>
            <div><dt>${esc(teamB.shortName)}’s best</dt><dd>${esc(bBest)}</dd></div>
            <div><dt>League points taken</dt><dd>${esc(teamA.shortName)} ${record.pointsA}, ${esc(teamB.shortName)} ${record.pointsB} <em>of ${record.played * 3} each</em></dd></div>
          </dl>
        </div>
      </div>

      <p class="note">
        ${capped
          ? `Their ${H2H_MEETING_WINDOW} most recent league meetings; ${
              onRecord.length - meetings.length} older ${
              onRecord.length - meetings.length === 1 ? 'meeting is' : 'meetings are'} on record but not shown.`
          : record.played === 1
            ? `Their only league meeting on record — the search reaches back ${seasonsLoaded} ${
                seasonsLoaded === 1 ? 'season' : 'seasons'}, and these two have not met more often in this division.`
            : `All ${record.played} league meetings these two have on record — the search reaches back ${seasonsLoaded} ${
                seasonsLoaded === 1 ? 'season' : 'seasons'}, and they have not met more often in this division.`}
        The window is a fixed count of meetings rather than a fixed number of
        seasons, so it means the same thing for every pairing and does not shrink
        each August. Sourced from Understat's full-league fixture lists, merged
        with this season's FPL results — each pairing appears once per venue per
        season, so a match carried by both feeds is counted once. Cups and
        play-offs are in neither feed. Venue, form and the run are all read from
        ${esc(teamA.name)}’s end; swap the two to mirror them.
      </p>
    </section>`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function loadingHTML() {
  return `
    <div class="loading" role="status" aria-busy="true" aria-label="Loading FPL data…">
      <span class="sk loading__t"></span>
      <div class="loading__cols"><span class="sk"></span><span class="sk"></span><span class="sk"></span><span class="sk"></span></div>
    </div>`;
}

/** Count numbers up from zero on an animated render. */
function countUp(root) {
  cancelAnimationFrame(_raf);
  if (RM.matches) return;
  const items = [...root.querySelectorAll('[data-cu]')]
    .map(el => ({ el, to: Number(el.dataset.cu), min: Number(el.dataset.min ?? 0) }))
    .filter(x => Number.isFinite(x.to));
  if (!items.length) return;
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / 900);
    const k = 1 - (1 - t) ** 3;
    for (const { el, to, min } of items) el.textContent = String(Math.max(min, Math.round(to * k)));
    if (t < 1) _raf = requestAnimationFrame(tick);
  };
  tick(t0);
}

/**
 * Paint the active mode's pane.
 * @param {boolean|'r'|'l'|'fade'} animate  false for a data repaint; otherwise
 *   play the entrances, sliding the whole pane in from `animate` when given.
 */
function render(animate = false) {
  if (!_panel) return;
  _hasRendered = true;
  cancelAnimationFrame(_raf);

  _panel.removeAttribute('data-anim');
  if (animate) {
    _panel.dataset.enter = typeof animate === 'string' ? animate : 'none';
    void _panel.offsetWidth;   // restart the pane's own entrance
    _panel.setAttribute('data-anim', '');
  }

  if (!store.getSeason()) {
    _panel.innerHTML = loadingHTML();
    return;
  }

  _panel.innerHTML = _mode === 'gameweek' ? gameweekHTML()
    : _mode === 'table' ? tableHTML()
    : _mode === 'team'  ? teamHTML()
    : h2hHTML();

  if (animate) countUp(_panel);
}

// ─── Selection ────────────────────────────────────────────────────────────────

/** The single mutation point for the By team selection. */
function selectTeam(teamId) {
  const id = Number.isInteger(teamId) ? teamId : null;
  if (id !== _teamId) _cell = null;
  _teamId = id;
}

/** The single mutation point for the Head-to-head pairing. */
function selectH2h(teamAId, teamBId) {
  _h2hA = Number.isInteger(teamAId) ? teamAId : null;
  _h2hB = Number.isInteger(teamBId) ? teamBId : null;
}

/**
 * Seed both panes so they open onto something real rather than a prompt.
 *
 * The first fixture of the current gameweek supplies all three selections —
 * one rule, both panes, and it is always available the moment data lands. Runs
 * once: a later re-emit must not yank the user back off a club they chose.
 */
function seedSelections() {
  if (_teamId !== null && _h2hA !== null) return;

  const gw = homeGw();
  const fixtures = store.getFixtures();
  const first = fixtures.find(f => f.gw === gw) ?? fixtures[0] ?? null;
  if (!first) return;

  if (_teamId === null) _teamId = first.homeTeamId;
  if (_h2hA === null) {
    _h2hA = first.homeTeamId;
    _h2hB = first.awayTeamId;
  }
}

/** Switch mode; the pane slides in from the side the new tab sits on. */
function setMode(mode, focusTab = false) {
  if (!MODE_KEYS.includes(mode)) return;
  const from = MODE_KEYS.indexOf(_mode);
  const to = MODE_KEYS.indexOf(mode);
  _mode = mode;
  closeDrawer();

  for (const tab of _tabs) {
    const on = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focusTab) tab.focus();
  }
  _panel.setAttribute('aria-labelledby', `fc-tab-${mode}`);
  render(to === from ? 'fade' : to > from ? 'r' : 'l');
}

function stepGw(next) {
  const clamped = Math.min(LAST_GW, Math.max(FIRST_GW, next));
  if (clamped === _gw) return;
  _gwRoll = clamped > _gw ? 'up' : 'down';
  _gw = clamped;
  render(true);
  _gwRoll = 'in';
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * Every control on the page, delegated on the section (stable across
 * renders). A cross-link carries its target selection in data attributes, so
 * following one lands on the pairing or club you clicked rather than on
 * whatever the pane happened to be showing.
 */
function onClick(e) {
  const t = e.target;
  let el;

  if ((el = t.closest('[data-mode]'))) { if (el.dataset.mode !== _mode) setMode(el.dataset.mode); return; }
  if ((el = t.closest('[data-close]')) || t === _scrim) { closeDrawer(); return; }

  if ((el = t.closest('[data-h2h-a]'))) {
    selectH2h(Number(el.dataset.h2hA), Number(el.dataset.h2hB));
    setMode('h2h');
    return;
  }
  if ((el = t.closest('[data-fixture]'))) { openDrawer(Number(el.dataset.fixture), el); return; }
  if ((el = t.closest('[data-gw-to]'))) { stepGw(Number(el.dataset.gwTo)); return; }
  if ((el = t.closest('[data-gw]'))) {
    if (el.disabled) return;
    const dir = el.dataset.gw;
    stepGw(dir === 'prev' ? _gw - 1 : dir === 'next' ? _gw + 1 : homeGw());
    return;
  }
  if ((el = t.closest('[data-scope]'))) {
    if (el.dataset.scope !== _scope) { _scope = el.dataset.scope; render(); }
    return;
  }
  if ((el = t.closest('[data-team]'))) {
    selectTeam(Number(el.dataset.team));
    setMode('team');
    return;
  }
  if ((el = t.closest('[data-cell]'))) { pickCell(Number(el.dataset.cell)); return; }
  if (t.closest('[data-swap]')) { selectH2h(_h2hB, _h2hA); render(true); return; }
  if ((el = t.closest('[data-view]'))) {
    if (el.dataset.view !== _h2hView) { _h2hView = el.dataset.view; render(); }
  }
}

/** A double-clicked ribbon cell opens that pairing's head-to-head. */
function onDblClick(e) {
  const cell = e.target.closest('[data-cell]');
  const entry = cell ? _ribbon[Number(cell.dataset.cell)] : null;
  if (!entry?.opponent) return;
  selectH2h(entry.team.id, entry.opponent.id);
  setMode('h2h');
}

/** '' (the placeholder option) means "no selection", not team 0. */
function onChange(e) {
  const sel = e.target.closest('[data-select]');
  if (!sel) return;
  const id = sel.value === '' ? null : Number(sel.value);
  if (sel.dataset.select === 'team') selectTeam(id);
  else if (sel.dataset.select === 'a') selectH2h(id, _h2hB);
  else selectH2h(_h2hA, id);
  render(true);
  _panel.querySelector(`[data-select="${sel.dataset.select}"]`)?.focus();
}

/** Focusing a ribbon cell selects it, the same as clicking. */
function onFocusIn(e) {
  const cell = e.target.closest?.('[data-cell]');
  if (cell) pickCell(Number(cell.dataset.cell));
}

function onKeydown(e) {
  // Match report: Escape closes, Tab stays inside.
  if (_drawerId !== null) {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key === 'Tab') {
      const f = _drawer.querySelectorAll('button, a[href], select, [tabindex="0"]');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!_drawer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }

  if (!_root.contains(e.target)) return;

  // Mode tabs: arrows, Home and End move between them.
  if (e.target.closest('[role="tablist"]')) {
    const i = MODE_KEYS.indexOf(_mode);
    const n = e.key === 'ArrowRight' ? (i + 1) % MODE_KEYS.length
            : e.key === 'ArrowLeft'  ? (i + MODE_KEYS.length - 1) % MODE_KEYS.length
            : e.key === 'Home' ? 0
            : e.key === 'End'  ? MODE_KEYS.length - 1
            : null;
    if (n === null) return;
    e.preventDefault();
    setMode(MODE_KEYS[n], true);
    return;
  }

  if (e.target.closest('[data-ribbon]')) onRibbonKey(e);
}

/**
 * Season data has landed, or been re-emitted as an enrichment arrives (main.js
 * re-fires data:ready when each Understat payload lands, which is what brings
 * the cross-season half of the H2H record — and settled Gaffer IQ scores —
 * into view).
 *
 * The opening gameweek and the seeded selections are picked the FIRST TIME
 * only, so a re-emit can't yank the user back off a GW they stepped to or a
 * club they chose.
 */

/**
 * Set when data changed while Fixtures was off screen, so activation knows it
 * owes a render. See onRouteChanged.
 */
let _pendingRender = false;

function onDataReady() {
  if (_gw === null) _gw = homeGw();
  seedSelections();
  _ctx = null;
  _scores.clear();

  // Seeding above is cheap. The pane below rebuilds real markup — the H2H
  // pane alone walks several seasons of meetings, the Matchday tiles score
  // every fixture — so skip it while hidden. See store.js's activeModule note.
  if (store.getActiveModule() !== 'fixtures') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;

  render(!_hasRendered && 'fade');
  renderDrawer();
}

/** Flush a render deferred while off screen, once Fixtures is shown. */
function onRouteChanged(module) {
  if (module !== 'fixtures') { closeDrawer(); return; }
  if (!_pendingRender && _hasRendered) return;
  _pendingRender = false;
  render('fade');
}

/** A GW's live payload landed — only the match report reads it. */
function onLiveUpdated() {
  renderDrawer();
}

/** One fixture's Understat match detail landed (events + lineups). */
function onMatchUpdated() {
  renderDrawer();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initFixtures() {
  _root = document.querySelector('[data-module="fixtures"]');
  if (!_root) return;

  _panel  = _root.querySelector('#fc-panel');
  _drawer = _root.querySelector('#fc-drawer');
  _scrim  = _root.querySelector('#fc-scrim');
  _tabs   = Array.from(_root.querySelectorAll('.mode'));

  store.subscribe('data:ready',   onDataReady);
  store.subscribe('route:changed', onRouteChanged);
  store.subscribe('live:updated', onLiveUpdated);
  store.subscribe('match:updated', onMatchUpdated);

  _root.addEventListener('click', onClick);
  _root.addEventListener('dblclick', onDblClick);
  _root.addEventListener('change', onChange);
  // On document, not the section: Escape must close the match report even
  // when focus has fallen back to <body> (a click on the scrim's backdrop).
  document.addEventListener('keydown', onKeydown);
  _root.addEventListener('focusin', onFocusIn);

  // Only the loading state can be drawn before data lands.
  if (_panel) _panel.innerHTML = loadingHTML();

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
