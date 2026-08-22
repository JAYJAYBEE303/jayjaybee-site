/**
 * js/engine/standings.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Derives the league table from played fixtures.
 *
 * WHY THIS EXISTS: the FPL API ships no standings payload — bootstrap-static
 * carries team strengths but not points, and there is no /standings endpoint.
 * The table therefore has to be accumulated from `fixtures/`. That is an
 * analytical derivation, so per ARCHITECTURE.md §3 hard rule 2 it lives here
 * and not in js/modules/fixtures.js, which only renders the result.
 *
 * Unlike the rest of engine/, these outputs are NOT 0–100 scores — they are
 * literal counts (points, goals, position). Nothing here feeds the composite.
 */

import { POINTS_WIN, POINTS_DRAW, POINTS_LOSS, LEAGUE_FORM_WINDOW } from '../config.js';

/**
 * Which side(s) of a fixture a venue split counts.
 * @typedef {'overall'|'home'|'away'} VenueSplit
 */

/** A blank row, before any fixture has been folded in. */
function emptyRow(team) {
  return {
    teamId: team.id,
    team,
    position: 0,
    movement: 0,        // filled by addMovement(); + = climbed, − = fell
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    points: 0,
    form: [],           // ['W','D','L',…] oldest → newest, capped below
    nextFixture: null,  // {fixtureId, opponent, isHome, kickoff, difficulty}
  };
}

/**
 * Fold one played fixture into one team's row.
 * @param {object} row       row to mutate
 * @param {number} scored    goals this team scored
 * @param {number} conceded  goals this team conceded
 */
function applyResult(row, scored, conceded) {
  row.played++;
  row.goalsFor     += scored;
  row.goalsAgainst += conceded;

  if (scored > conceded)      { row.won++;   row.points += POINTS_WIN;  row.form.push('W'); }
  else if (scored < conceded) { row.lost++;  row.points += POINTS_LOSS; row.form.push('L'); }
  else                        { row.drawn++; row.points += POINTS_DRAW; row.form.push('D'); }

  row.goalDifference = row.goalsFor - row.goalsAgainst;
}

/**
 * Premier League ordering: points, then goal difference, then goals scored.
 * The real competition breaks a remaining tie by head-to-head record and
 * ultimately a play-off; neither is derivable here, so club name is the final
 * tiebreak purely to keep the sort STABLE and reproducible across renders.
 * Two clubs level on all three are genuinely tied — the ordering between them
 * is presentational, not a ranking claim.
 */
function compareRows(a, b) {
  return (b.points - a.points)
      || (b.goalDifference - a.goalDifference)
      || (b.goalsFor - a.goalsFor)
      || a.team.name.localeCompare(b.team.name);
}

/**
 * @param {object} fixture
 * @param {number} teamId
 * @param {VenueSplit} venue
 * @returns {boolean}  does this fixture count towards this team under the split?
 */
function countsForTeam(fixture, teamId, venue) {
  const isHome = fixture.homeTeamId === teamId;
  if (venue === 'home') return isHome;
  if (venue === 'away') return !isHome;
  return true;
}

/**
 * Build the league table from a season's fixtures.
 *
 * Only fixtures with `played === true` AND a non-null `result` contribute —
 * a fixture flagged finished but still missing its score (which happens
 * briefly while FPL processes a round) is skipped rather than counted as 0–0.
 *
 * @param {object[]} fixtures            all fixtures (store.getFixtures())
 * @param {object[]} teams               all teams (store.getTeams())
 * @param {object}  [opts]
 * @param {VenueSplit} [opts.venue='overall']  which side of each fixture counts
 * @param {number|null} [opts.upToGw=null]     only count fixtures with gw <= this
 *                                             (null = the whole season so far)
 * @param {number} [opts.formWindow=LEAGUE_FORM_WINDOW]  form column length
 * @returns {object[]}  rows sorted best-first, each carrying a 1-based `position`
 */
export function calcLeagueTable(fixtures, teams, {
  venue = 'overall',
  upToGw = null,
  formWindow = LEAGUE_FORM_WINDOW,
} = {}) {
  const rowsById = new Map(teams.map(t => [t.id, emptyRow(t)]));

  // Fixtures arrive sorted by GW then kickoff (normalise.js), so pushing onto
  // `form` in iteration order already yields oldest → newest.
  for (const f of fixtures) {
    if (!f.played || !f.result) continue;
    if (upToGw !== null && (f.gw === null || f.gw > upToGw)) continue;

    const { homeGoals, awayGoals } = f.result;
    if (typeof homeGoals !== 'number' || typeof awayGoals !== 'number') continue;

    const home = rowsById.get(f.homeTeamId);
    const away = rowsById.get(f.awayTeamId);

    if (home && countsForTeam(f, f.homeTeamId, venue)) applyResult(home, homeGoals, awayGoals);
    if (away && countsForTeam(f, f.awayTeamId, venue)) applyResult(away, awayGoals, homeGoals);
  }

  const rows = [...rowsById.values()];

  for (const row of rows) {
    row.form = row.form.slice(-formWindow);
  }

  rows.sort(compareRows);
  rows.forEach((row, i) => { row.position = i + 1; });

  return rows;
}

/**
 * Attach each team's next unplayed fixture to its row, in place.
 *
 * Kept separate from calcLeagueTable because "next fixture" is a property of
 * the schedule, not of the standings — a Home-only table still wants the true
 * next fixture, whichever venue it happens to be at.
 *
 * @param {object[]} rows      output of calcLeagueTable (mutated)
 * @param {object[]} fixtures  all fixtures
 * @param {Object<number,object>} teamsById
 * @returns {object[]}  the same rows, for chaining
 */
export function attachNextFixtures(rows, fixtures, teamsById) {
  for (const row of rows) {
    const next = fixtures.find(f =>
      !f.played
      && f.gw !== null
      && (f.homeTeamId === row.teamId || f.awayTeamId === row.teamId));

    if (!next) { row.nextFixture = null; continue; }

    const isHome = next.homeTeamId === row.teamId;
    row.nextFixture = {
      fixtureId:  next.id,
      gw:         next.gw,
      isHome,
      kickoff:    next.kickoff,
      opponent:   teamsById[isHome ? next.awayTeamId : next.homeTeamId] ?? null,
      // The official FPL 1–5 rating for THIS team in that fixture. Shown for
      // reference only — the Gaffer IQ composite is what the rest of the app
      // scores on (FEATURE_ENGINE.md §1).
      difficulty: isHome ? next.fplDifficulty?.home : next.fplDifficulty?.away,
    };
  }
  return rows;
}

/**
 * Compare two tables and record how far each team has moved, in place.
 *
 * @param {object[]} rows      current table (mutated)
 * @param {object[]} previous  an earlier table from calcLeagueTable
 * @returns {object[]}  the same rows, each with `movement` set: positive =
 *   climbed, negative = fell, 0 = unchanged or not previously ranked.
 */
export function addMovement(rows, previous) {
  const wasAt = new Map(previous.map(r => [r.teamId, r.position]));
  for (const row of rows) {
    const before = wasAt.get(row.teamId);
    row.movement = before === undefined ? 0 : before - row.position;
  }
  return rows;
}
