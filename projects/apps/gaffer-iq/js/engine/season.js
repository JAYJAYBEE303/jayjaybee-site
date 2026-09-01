/**
 * js/engine/season.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds the whole-season model behind the Matchup page's Full Season strip:
 * per-gameweek matchups, per-gameweek player projections, schedule
 * irregularities and chip windows.
 * See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.
 */

import { SEASON_TOP_MATCHUPS, SEASON_LOADED_MIN_GREAT, BANDS } from '../config.js';
import { scoreFixture } from './composite.js';

/** Premier League seasons are 38 gameweeks. */
export const LAST_GW = 38;

/**
 * The top matchups of one gameweek.
 *
 * A fixture carries TWO composite scores, one per side. The matchup's score is
 * the higher of them and the side that produced it is the favoured side — so
 * the UI's "which team does this fixture favour" ring falls out of the same
 * calculation rather than needing a second rule.
 *
 * @param {number} gw
 * @param {object} ctx   from buildScoreContext
 * @param {{score?: Function}} [opts]  scoreFixture injection point, for tests
 * @returns {Array<object>}  at most SEASON_TOP_MATCHUPS, value descending
 */
export function buildGameweekMatchups(gw, ctx, opts = {}) {
  const score = opts.score ?? scoreFixture;
  const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);

  // A team playing twice this week makes every fixture it appears in a double.
  const counts = new Map();
  for (const f of fixtures) {
    counts.set(f.homeTeamId, (counts.get(f.homeTeamId) ?? 0) + 1);
    counts.set(f.awayTeamId, (counts.get(f.awayTeamId) ?? 0) + 1);
  }

  const rows = [];
  for (const f of fixtures) {
    const home = ctx.teamsById[f.homeTeamId];
    const away = ctx.teamsById[f.awayTeamId];
    if (!home || !away) continue;
    const h = score(home, f, ctx);
    const a = score(away, f, ctx);
    const homeLeads = h.value >= a.value;
    const best = homeLeads ? h : a;
    rows.push({
      fixtureId:  f.id,
      homeId:     f.homeTeamId,
      awayId:     f.awayTeamId,
      favouredId: homeLeads ? f.homeTeamId : f.awayTeamId,
      value:      best.value,
      band:       best.band,
      isDouble:   (counts.get(f.homeTeamId) > 1) || (counts.get(f.awayTeamId) > 1),
      postponed:  false,
    });
  }

  return rows.sort((x, y) => y.value - x.value).slice(0, SEASON_TOP_MATCHUPS);
}

/**
 * Is this a week worth waiting for? True once SEASON_LOADED_MIN_GREAT of the
 * week's top matchups reach the `great` band. One blowout is an ordinary week
 * with a good fixture in it; several together is a different thing.
 *
 * @param {Array<object>} matchups  buildGameweekMatchups output
 */
export function isLoadedWeek(matchups) {
  return matchups.filter(m => !m.postponed && m.value >= BANDS.great).length
    >= SEASON_LOADED_MIN_GREAT;
}
