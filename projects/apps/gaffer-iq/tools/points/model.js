/**
 * tools/points/model.js
 * The points model's fit, as pieces (docs/decision-engine-plan.md, Phase 6b):
 * the constants from a set of seasons, the defensive-contribution prior from
 * a season's gameweeks so far, and DECISION_ENGINE.pointsModel's shape from
 * them and the chosen prior weights. fit.js fits and reports with them; the
 * decision backtest (tools/backtest/run.js) rebuilds, with pointsModelAt, the
 * model a past season would have had at each planning gameweek.
 */

import { DECISION_ENGINE, SEASON_GWS } from '../../js/config.js';
import { teamRates } from '../../js/engine/team-goals.js';
import { totalsBefore } from '../backtest/history.js';
import {
  appearanceConstants, fitBonus, fitDefconDispersion, fitPriors, leagueConstants, promotedPrior, seasonTeamRatings, teamPriors,
} from './lib.js';

export const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];

/** A season's end-of-season totals with club ids made unique across seasons, and its clubs' rates. */
export function seasonTotals(season) {
  const key = id => `${season.name}:${id}`;
  const totals = [...totalsBefore(season, SEASON_GWS + 1).values()].map(t => ({ ...t, teamId: key(t.teamId) }));
  const clubs = teamRates(totals.map(t => ({ teamId: t.teamId, totals: { minutes: t.minutes, xG: t.xg, xGC: t.xgc } })));
  return { totals, clubs };
}

export function constantsFrom(train) {
  const rows = train.flatMap(s => s.rows);
  const pooled = train.map(seasonTotals);
  const clubs = new Map(pooled.flatMap(p => [...p.clubs]));
  return {
    ...appearanceConstants(rows),
    bonus: fitBonus(rows),
    priors: fitPriors(pooled.flatMap(p => p.totals), clubs),
    defconDispersion: fitDefconDispersion(rows),
    ...leagueConstants(train),
  };
}

/** Defensive contributions' prior lines and spread from a season's rows before a gameweek. */
export function defconBefore(season, gw) {
  const before = { ...season, rows: season.rows.filter(r => r.gw < gw) };
  const { totals, clubs } = seasonTotals(before);
  const priors = fitPriors(totals, clubs);
  return {
    dispersion: fitDefconDispersion(before.rows),
    lines: Object.fromEntries(POSITIONS.map(p => [p, priors[p].defconPer90])),
  };
}

export function modelOf(constants, hyper, { previous, promoted, defcon = null }) {
  return {
    goalsPerXg: constants.goalsPerXg,
    assistsPerXa: constants.assistsPerXa,
    minutesIfFull: constants.minutesIfFull,
    minutesIfShort: constants.minutesIfShort,
    defconDispersion: defcon ? defcon.dispersion : constants.defconDispersion,
    bonus: constants.bonus,
    priors: Object.fromEntries(POSITIONS.map(p => [p, {
      ...constants.priors[p], ...(defcon ? { defconPer90: defcon.lines[p] } : {}),
    }])),
    priorWeight: { share: hyper.share, per90: hyper.per90, saves: hyper.saves },
    teams: {
      leagueXg: constants.leagueXg, priorMatches: hyper.priorMatches, homeAdvantage: constants.homeAdvantage, promoted,
      // How far last season's ratings were pulled to the league's level in teamPriors.
      priorRegression: hyper.regression,
    },
    teamPriors: teamPriors(seasonTeamRatings(previous), hyper.regression),
    fixtureRating: { weight: hyper.rating ?? 0 },
  };
}

/** The prior weights and club choices a fitted model was built with, read back from it. */
export function hyperOf(model = DECISION_ENGINE.pointsModel) {
  return {
    share: model.priorWeight.share, per90: model.priorWeight.per90, saves: model.priorWeight.saves,
    priorMatches: model.teams.priorMatches, regression: model.teams.priorRegression, rating: model.fixtureRating.weight,
  };
}

/**
 * The model a season would have had, gameweek by gameweek, as Phase 6b's test
 * built 2025-26's: constants from the seasons before it (2022-23, whose xG
 * starts at GW16, only as club priors), club priors from the season before,
 * and - where the season scored defensive contributions - their prior and
 * spread from its own gameweeks before the planning one.
 *
 * @param {object[]} seasons  loadSeason results, oldest first
 * @param {string} name       the season replayed; at least the third
 * @returns {(t: number) => object}  DECISION_ENGINE.pointsModel's shape
 */
export function pointsModelAt(seasons, name, hyper = hyperOf()) {
  const i = seasons.findIndex(s => s.name === name);
  if (i < 2) throw new Error(`pointsModelAt: ${name} needs two seasons before it`);
  const season = seasons[i];
  const constants = constantsFrom(seasons.slice(1, i));
  const promoted = promotedPrior(seasons.slice(1, i).map((s, k) => [seasons[k], s]));
  const scored = season.rows.some(r => r.defcon > 0);
  const cache = new Map();
  return t => {
    if (!cache.has(t)) {
      cache.set(t, modelOf(constants, hyper, { previous: seasons[i - 1], promoted, defcon: scored ? defconBefore(season, t) : null }));
    }
    return cache.get(t);
  };
}
