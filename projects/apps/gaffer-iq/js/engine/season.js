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

/**
 * Infer which gameweek each postponed fixture was taken out of.
 *
 * WHY THIS IS AN INFERENCE. FPL sets `event: null` on a postponed fixture and
 * does not retain the gameweek it was scheduled for, so the answer is not in
 * the feed. What IS observable is the hole it left: two clubs with no fixture
 * in a week the rest of the league plays. A pending tie between exactly those
 * two clubs is the obvious cause.
 *
 * DISPLAY-ONLY. Nothing here feeds a score, and ARCHITECTURE.md §9's rule that
 * gameweek aggregation must skip `gw === null` fixtures is untouched. The UI
 * states that the attribution is inferred, so a wrong guess reads as a guess.
 *
 * Earliest match wins: a rearranged date is always later than the hole.
 * A gameweek with NO scheduled fixtures at all is skipped — that is an unplayed
 * stretch of the season, not a hole, and every club is trivially "blank" in it.
 *
 * @param {Array<object>} pending  fixtures with gw === null
 * @param {object} ctx             from buildScoreContext
 * @returns {Map<number, Array<object>>}  gameweek → fixtures attributed to it
 */
export function attributePostponements(pending, ctx) {
  const out = new Map();
  if (!pending || pending.length === 0) return out;

  // Which clubs play in each gameweek that has any fixtures at all.
  const playingByGw = new Map();
  for (const f of (ctx.fixtures || [])) {
    if (typeof f.gw !== 'number') continue;
    let set = playingByGw.get(f.gw);
    if (!set) playingByGw.set(f.gw, set = new Set());
    set.add(f.homeTeamId);
    set.add(f.awayTeamId);
  }

  const gws = [...playingByGw.keys()].sort((a, b) => a - b);
  for (const f of pending) {
    for (const gw of gws) {
      const playing = playingByGw.get(gw);
      if (playing.has(f.homeTeamId) || playing.has(f.awayTeamId)) continue;
      let list = out.get(gw);
      if (!list) out.set(gw, list = []);
      list.push(f);
      break;                       // earliest match only
    }
  }
  return out;
}
