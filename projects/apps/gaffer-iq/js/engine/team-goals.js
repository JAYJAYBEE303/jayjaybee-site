/**
 * js/engine/team-goals.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Each club's expected goals for and against (docs/decision-engine-plan.md,
 * Phase 6b): the one place a fixture enters the points model. A club's rates
 * come from its players' season totals of FPL's expected goals (xG) and
 * expected goals conceded (xGC), so the app and the offline fit read the same
 * figures; its attack and defence are those rates against the league's, pulled
 * towards a prior (last season's, or a promoted club's) while its record is
 * short.
 */

import { MATCH_MINUTES, XI_SIZE } from '../config.js';

/**
 * Each club's xG for and against per 90 so far. Its xG for is its players'
 * summed xG over its matches (eleven on the pitch: summed minutes / 990); its
 * xG against is the minutes-weighted average of its players' xGC per 90, each
 * player's xGC being the club's xG against while he was on.
 *
 * @param {Array<{teamId: number, totals: {minutes: number, xG: number, xGC: number}}>} players  normalised
 * @returns {Map<number, {xgFor90: number, xgAgainst90: number, matches: number}>}
 */
export function teamRates(players) {
  const sums = new Map();
  for (const { teamId, totals } of players) {
    const s = sums.get(teamId) ?? { minutes: 0, xg: 0, xgc: 0 };
    s.minutes += totals.minutes;
    s.xg += totals.xG;
    s.xgc += totals.xGC;
    sums.set(teamId, s);
  }
  const rates = new Map();
  for (const [teamId, s] of sums) {
    const matches = s.minutes / (XI_SIZE * MATCH_MINUTES);
    const nineties = s.minutes / MATCH_MINUTES;
    rates.set(teamId, {
      xgFor90: matches > 0 ? s.xg / matches : 0,
      xgAgainst90: nineties > 0 ? s.xgc / nineties : 0,
      matches,
    });
  }
  return rates;
}

/**
 * Each club's attack and defence against the league (1 = the league's level;
 * a defence above 1 concedes more). Its record counts its matches against
 * model.priorMatches of its prior's; the league's level is pulled towards
 * model.leagueXg by the same weight per club. A club without a prior reads as
 * model.promoted.
 *
 * @param {Map<number, {xgFor90: number, xgAgainst90: number, matches: number}>} rates  teamRates()
 * @param {Map<number, {attack: number, defence: number}>} priors  by club id
 * @param {{leagueXg: number, priorMatches: number, promoted: {attack: number, defence: number}}} model
 * @returns {{league: number, byTeam: Map<number, {attack: number, defence: number}>}}
 */
export function teamStrengths(rates, priors, model) {
  let goals = model.priorMatches * rates.size * model.leagueXg;
  let matches = model.priorMatches * rates.size;
  for (const r of rates.values()) {
    goals += r.matches * r.xgFor90;
    matches += r.matches;
  }
  const league = matches > 0 ? goals / matches : model.leagueXg;

  const byTeam = new Map();
  for (const [teamId, r] of rates) {
    const prior = priors.get(teamId) ?? model.promoted;
    const weight = r.matches + model.priorMatches;
    const blend = (rate, priorValue) => (weight > 0
      ? ((r.matches * rate) + (model.priorMatches * priorValue * league)) / (weight * league)
      : priorValue);
    byTeam.set(teamId, { attack: blend(r.xgFor90, prior.attack), defence: blend(r.xgAgainst90, prior.defence) });
  }
  return { league, byTeam };
}

/**
 * The goals each side of a fixture is expected to score, in xG units: the
 * league's level x its attack x the other side's defence, with home advantage
 * on the home side's and against the away side's.
 *
 * @returns {{home: number, away: number}}
 */
export function fixtureGoals({ league, byTeam }, homeId, awayId, model) {
  const strength = id => {
    const s = byTeam.get(id);
    if (!s) throw new RangeError(`fixtureGoals: no strength for club ${id}`);
    return s;
  };
  const home = strength(homeId);
  const away = strength(awayId);
  return {
    home: league * home.attack * away.defence * model.homeAdvantage,
    away: (league * away.attack * home.defence) / model.homeAdvantage,
  };
}
