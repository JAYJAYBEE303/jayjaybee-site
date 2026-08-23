/**
 * js/engine/h2h.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds the full head-to-head record between two clubs — every meeting the
 * app can see, plus the tallies derived from them.
 *
 * WHY THIS IS SEPARATE FROM engine/fixtures.js: calcFixtureHistory there
 * answers one narrow question for the composite — "what share of the available
 * league points has A taken off B lately" — and reduces each meeting to three
 * numbers on the way. The Head-to-head view needs the meetings THEMSELVES:
 * date, season, venue, both scorelines, and (where known) the fixture the rest
 * of the tab navigates by. Same source data, a strictly richer output, so
 * calcFixtureHistory's collector delegates to collectUnderstatMeetings() below
 * rather than the two implementations drifting apart.
 *
 * Like engine/standings.js, and unlike the rest of engine/, nothing here is a
 * 0–100 score. These are literal counts and records; nothing feeds composite.
 */

import {
  SEASON_BOUNDARY_MONTH, H2H_TREND_WINDOW,
  POINTS_WIN, POINTS_DRAW, POINTS_LOSS,
} from '../config.js';
import { canonicalClubKey } from './normalise.js';

/**
 * @typedef {object} Meeting
 * @property {string|null} date        raw date string as its feed wrote it
 * @property {string|null} season      '2025/26', or null if the date won't parse
 * @property {number|null} homeTeamId  FPL id of whichever picked club was home
 * @property {number|null} awayTeamId  FPL id of whichever picked club was away
 * @property {string} homeName         club name as its feed wrote it
 * @property {string} awayName
 * @property {number} homeGoals
 * @property {number} awayGoals
 * @property {boolean} aWasHome        was team A the home side?
 * @property {number} goalsForA        the same score read from A's end
 * @property {number} goalsAgainstA
 * @property {'W'|'D'|'L'} outcomeA
 * @property {'fpl'|'understat'} source
 * @property {number|null} fixtureId   FPL fixture id — 'fpl' meetings only
 * @property {number|null} gw          gameweek — 'fpl' meetings only
 */

// ─── Dates ───────────────────────────────────────────────────────────────────

/**
 * Parse either feed's date string.
 *
 * The two disagree on format: Understat writes 'YYYY-MM-DD HH:MM:SS' with a
 * space and no zone (so it parses as LOCAL time), FPL writes ISO-8601 with a
 * trailing Z. The few hours between those readings never move a match across a
 * season boundary and never reorders two meetings months apart, which is all
 * this parse is used for.
 *
 * @param {string|null|undefined} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The season a date falls in, e.g. '2025/26'.
 * @param {string|null} value
 * @returns {string|null}  null when the date won't parse
 */
function seasonLabel(value) {
  const d = toDate(value);
  if (!d) return null;
  const year  = d.getUTCFullYear();
  const start = d.getUTCMonth() >= SEASON_BOUNDARY_MONTH ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Oldest → newest, matching the order every form/trend array in the app uses. */
function byDateAscending(x, y) {
  return (toDate(x.date)?.getTime() ?? 0) - (toDate(y.date)?.getTime() ?? 0);
}

// ─── Meeting construction ────────────────────────────────────────────────────

/**
 * Complete a partially-built meeting: derive A's view of the scoreline, the
 * outcome and the season label from the raw fields both collectors share.
 * @param {object} base
 * @returns {Meeting}
 */
function makeMeeting(base) {
  const goalsForA     = base.aWasHome ? base.homeGoals : base.awayGoals;
  const goalsAgainstA = base.aWasHome ? base.awayGoals : base.homeGoals;

  return {
    fixtureId: null,
    gw: null,
    ...base,
    season: seasonLabel(base.date),
    goalsForA,
    goalsAgainstA,
    outcomeA: goalsForA > goalsAgainstA ? 'W' : goalsForA < goalsAgainstA ? 'L' : 'D',
  };
}

/**
 * Identity of a meeting, for de-duplication.
 *
 * Each pairing occurs once per venue per league season, so club + club + which
 * way round + season is unique WITHOUT the exact date — deliberately, because
 * a rescheduled fixture can carry a different date in each feed and must still
 * collapse to one row. The date is only the fallback key for a record whose
 * date won't parse into a season.
 */
function meetingKey(m) {
  return `${m.season ?? m.date ?? '?'}|${canonicalClubKey(m.homeName)}|${canonicalClubKey(m.awayName)}`;
}

// ─── Collectors ──────────────────────────────────────────────────────────────

/**
 * Cross-season meetings drawn from Understat's datesData (full-league fixture
 * lists — every match, not just one team's), across ctx.leagueXg,
 * ctx.leagueXgPrev and every payload in ctx.leagueXgHistory. How far back that
 * reaches is UNDERSTAT_HISTORY_SEASONS (config.js), currently five seasons in
 * total — clubs meet twice a season, so a shallower window leaves a pairing
 * with too few meetings to read anything from.
 *
 * MODEL: matched by team NAME via canonicalClubKey, never by Understat's own
 * numeric ids, which are as unstable across seasons as FPL's. Same resolver
 * buildRollingVenueStatsByTeamId and buildUnderstatSlugsByTeamId use.
 *
 * @param {number} teamAId
 * @param {number} teamBId
 * @param {object} ctx  { teamsById, leagueXg, leagueXgPrev, leagueXgHistory }
 * @returns {Meeting[]}  oldest → newest. Empty when either club can't be
 *   name-matched, or no meeting appears in the fetched seasons (thin overlap,
 *   a promoted side, or an Understat outage).
 */
export function collectUnderstatMeetings(teamAId, teamBId, ctx) {
  const teamsById = ctx.teamsById || {};
  const teamA = teamsById[teamAId];
  const teamB = teamsById[teamBId];
  if (!teamA || !teamB) return [];

  const keysA = new Set([teamA.name, teamA.shortName].filter(Boolean).map(canonicalClubKey));
  const keysB = new Set([teamB.name, teamB.shortName].filter(Boolean).map(canonicalClubKey));

  const allDates = [
    ...(ctx.leagueXg?.datesData || []),
    ...(ctx.leagueXgPrev?.datesData || []),
    ...(ctx.leagueXgHistory || []).flatMap(payload => payload?.datesData || []),
  ];

  const meetings = [];
  for (const m of allDates) {
    if (!m?.isResult || !m.h?.title || !m.a?.title) continue;

    const hKey = canonicalClubKey(m.h.title);
    const aKey = canonicalClubKey(m.a.title);
    const aWasHome = keysA.has(hKey) && keysB.has(aKey);
    const aWasAway = keysA.has(aKey) && keysB.has(hKey);
    if (!aWasHome && !aWasAway) continue;

    const hg = Number(m.goals?.h);
    const ag = Number(m.goals?.a);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;

    meetings.push(makeMeeting({
      date:       m.datetime,
      // Which of the two PICKED clubs was at home. Safe to express as an FPL
      // id even for a meeting three seasons old: the match was matched by
      // name, so the id only ever labels "this one of the two, not the other".
      homeTeamId: aWasHome ? teamAId : teamBId,
      awayTeamId: aWasHome ? teamBId : teamAId,
      homeName:   m.h.title,
      awayName:   m.a.title,
      homeGoals:  hg,
      awayGoals:  ag,
      aWasHome,
      source:     'understat',
    }));
  }

  meetings.sort(byDateAscending);
  return meetings;
}

/**
 * This season's meetings from FPL's own fixture list. Narrower than the
 * Understat sweep above (one season, and only what FPL has marked complete)
 * but authoritative for the current campaign and the only source carrying a
 * fixture id and gameweek.
 *
 * @param {number} teamAId
 * @param {number} teamBId
 * @param {object} ctx  { teamsById, fixtures }
 * @returns {Meeting[]}  oldest → newest
 */
export function collectFplMeetings(teamAId, teamBId, ctx) {
  const teamsById = ctx.teamsById || {};
  const meetings = [];

  for (const f of ctx.fixtures || []) {
    const isPair =
      (f.homeTeamId === teamAId && f.awayTeamId === teamBId) ||
      (f.homeTeamId === teamBId && f.awayTeamId === teamAId);
    if (!isPair || !f.played || !f.result) continue;

    const hg = f.result.homeGoals;
    const ag = f.result.awayGoals;
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;

    meetings.push(makeMeeting({
      date:       f.kickoff,
      homeTeamId: f.homeTeamId,
      awayTeamId: f.awayTeamId,
      homeName:   teamsById[f.homeTeamId]?.name ?? '',
      awayName:   teamsById[f.awayTeamId]?.name ?? '',
      homeGoals:  hg,
      awayGoals:  ag,
      aWasHome:   f.homeTeamId === teamAId,
      source:     'fpl',
      fixtureId:  f.id,
      gw:         f.gw,
    }));
  }

  meetings.sort(byDateAscending);
  return meetings;
}

/**
 * Every meeting between two clubs the app can see: Understat's cross-season
 * history merged with this season's FPL fixtures.
 *
 * Both feeds cover the CURRENT season, so the merge de-duplicates (see
 * meetingKey) and resolves a collision in FPL's favour — that record carries
 * the fixture id and gameweek, and is the feed the rest of the tab navigates
 * by. Older seasons exist only in Understat and merge in untouched.
 *
 * @param {number} teamAId
 * @param {number} teamBId
 * @param {object} ctx  { teamsById, fixtures, leagueXg, leagueXgPrev,
 *                        leagueXgHistory }
 * @returns {Meeting[]}  oldest → newest
 */
export function buildH2hMeetings(teamAId, teamBId, ctx) {
  if (teamAId === teamBId) return [];

  const merged = new Map();
  for (const m of collectUnderstatMeetings(teamAId, teamBId, ctx)) merged.set(meetingKey(m), m);
  for (const m of collectFplMeetings(teamAId, teamBId, ctx))       merged.set(meetingKey(m), m);

  return [...merged.values()].sort(byDateAscending);
}

// ─── Tallies ─────────────────────────────────────────────────────────────────

/** A blank venue bucket, before any meeting has been folded in. */
function emptyVenue() {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
}

/**
 * Fold the meeting list down to the numbers the view reports.
 *
 * Everything is read FROM TEAM A'S PERSPECTIVE — `aWins`, `trend`, `streak`
 * and the venue split all answer "how has A fared", with B's totals given
 * alongside. Swapping the two teams mirrors the whole summary, which is
 * exactly what the pane's swap button does.
 *
 * @param {Meeting[]} meetings  output of buildH2hMeetings (oldest → newest)
 * @param {object} [opts]
 * @param {number} [opts.trendWindow=H2H_TREND_WINDOW]
 * @returns {object}  zeroed-out but structurally complete when there are none
 */
export function summariseH2h(meetings, { trendWindow = H2H_TREND_WINDOW } = {}) {
  const summary = {
    played: meetings.length,
    aWins: 0, draws: 0, bWins: 0,
    goalsA: 0, goalsB: 0,
    avgGoals: 0,
    pointsA: 0, pointsB: 0,
    seasons: 0,
    first: null, last: null,
    trend: [],            // A's outcomes, oldest → newest, capped at trendWindow
    streak: null,         // {outcome, count} — A's current unbroken run
    biggestA: null,       // A's widest win; null if A has never won
    biggestB: null,       // B's widest win
    venue: { aHome: emptyVenue(), aAway: emptyVenue() },
  };

  if (!meetings.length) return summary;

  const seasons = new Set();

  for (const m of meetings) {
    if (m.season) seasons.add(m.season);

    summary.goalsA += m.goalsForA;
    summary.goalsB += m.goalsAgainstA;

    const bucket = m.aWasHome ? summary.venue.aHome : summary.venue.aAway;
    bucket.played++;
    bucket.goalsFor     += m.goalsForA;
    bucket.goalsAgainst += m.goalsAgainstA;

    if (m.outcomeA === 'W') {
      summary.aWins++; bucket.wins++;
      summary.pointsA += POINTS_WIN;  summary.pointsB += POINTS_LOSS;
    } else if (m.outcomeA === 'L') {
      summary.bWins++; bucket.losses++;
      summary.pointsA += POINTS_LOSS; summary.pointsB += POINTS_WIN;
    } else {
      summary.draws++; bucket.draws++;
      summary.pointsA += POINTS_DRAW; summary.pointsB += POINTS_DRAW;
    }

    const margin = m.goalsForA - m.goalsAgainstA;
    if (margin > 0 && (!summary.biggestA
        || margin > summary.biggestA.goalsForA - summary.biggestA.goalsAgainstA)) {
      summary.biggestA = m;
    }
    if (margin < 0 && (!summary.biggestB
        || margin < summary.biggestB.goalsForA - summary.biggestB.goalsAgainstA)) {
      summary.biggestB = m;
    }
  }

  summary.seasons  = seasons.size;
  summary.first    = meetings[0];
  summary.last     = meetings[meetings.length - 1];
  summary.avgGoals = (summary.goalsA + summary.goalsB) / meetings.length;
  summary.trend    = meetings.slice(-trendWindow).map(m => m.outcomeA);

  // The current run, counted backwards from the most recent meeting. Always at
  // least 1 — the latest result is itself a run of one.
  const latest = summary.last.outcomeA;
  let count = 0;
  for (let i = meetings.length - 1; i >= 0 && meetings[i].outcomeA === latest; i--) count++;
  summary.streak = { outcome: latest, count };

  return summary;
}
