/**
 * js/engine/points.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * The points model (docs/decision-engine-plan.md, Phase 6b): a player's
 * expected FPL points in one fixture he plays, built from the parts FPL pays
 * for - playing time, goals, assists, clean sheet, goals conceded, saves,
 * defensive contributions, bonus and cards.
 *
 * The fixture enters once, through his team's expected goals for and against
 * in it: his goals and assists are his shares of the first, his clean sheet,
 * goals conceded and saves follow the second. The points he gets for turning
 * up, and his defensive contributions, do not move with the opponent.
 */

import { FPL_SCORING, MATCH_MINUTES } from '../config.js';
import { fromTenths, negativeBinomialTail, poissonFloorMean } from '../util.js';

/**
 * A player's rates, as the points model reads them (playerRates, once his
 * record has been pulled towards his prior).
 * @typedef {object} PointsRates
 * @property {'GKP'|'DEF'|'MID'|'FWD'} position
 * @property {number} goalShare         his expected goals per unit of his team's, while he is on
 * @property {number} assistShare       his expected assists per unit of his team's expected goals
 * @property {number} savesPerXga       a keeper's saves per unit of expected goals against
 * @property {number} defconPer90       defensive actions (FPL's count) per 90 minutes
 * @property {number} yellowsPer90
 * @property {number} redsPer90
 * @property {number} bonusResidualPer90  his bonus per 90 beyond what his returns explain
 */

/**
 * His expected points in one fixture he plays, part by part.
 *
 * @param {PointsRates} rates
 * @param {{lambdaFor: number, lambdaAgainst: number, p60: number, minutes: number}} fixture
 *   his team's expected goals for and against in it (xG units), and, given
 *   he plays, his chance of 60 minutes or more and his expected minutes
 * @param {object} model   DECISION_ENGINE.pointsModel (fitted by tools/points)
 * @param {object} [rules] FPL_SCORING; a season without defensive
 *   contributions passes defensiveContribution: null
 * @returns {{total: number, parts: Object<string, number>}}
 */
export function fixturePoints(rates, fixture, model, rules = FPL_SCORING) {
  const { position } = rates;
  const { lambdaFor, lambdaAgainst, p60 } = fixture;
  const share = fixture.minutes / MATCH_MINUTES;

  const goals = model.goalsPerXg * rates.goalShare * lambdaFor * share;
  const assists = model.assistsPerXa * rates.assistShare * lambdaFor * share;
  // A clean sheet needs 60 minutes, so its exposure is a full player's match.
  const cleanSheet = p60 * Math.exp(-model.goalsPerXg * lambdaAgainst * (model.minutesIfFull / MATCH_MINUTES));
  const conceded = model.goalsPerXg * lambdaAgainst * share;
  const bonus = model.bonus[position];
  const defcon = rules.defensiveContribution;
  const threshold = defcon?.threshold[position];

  // MODEL: penalty saves (+5), penalty misses (-2) and own goals (-2) are left
  // out: about 2% of a keeper's points and less of anyone else's.
  const parts = {
    appearance: rules.appearance.short + ((rules.appearance.full - rules.appearance.short) * p60),
    goals: rules.goal[position] * goals,
    assists: rules.assist * assists,
    cleanSheet: rules.cleanSheet[position] * cleanSheet,
    conceded: rules.conceded.positions.includes(position)
      ? rules.conceded.points * poissonFloorMean(conceded, rules.conceded.per) : 0,
    saves: position === 'GKP'
      ? rules.saves.points * poissonFloorMean(rates.savesPerXga * lambdaAgainst * share, rules.saves.per) : 0,
    defcon: threshold
      ? defcon.points * negativeBinomialTail(rates.defconPer90 * share, model.defconDispersion, threshold) : 0,
    bonus: Math.max(0, (bonus.base * share) + (bonus.goal * goals) + (bonus.assist * assists)
      + (bonus.cleanSheet * cleanSheet) + (rates.bonusResidualPer90 * share)),
    cards: ((rules.yellow * rates.yellowsPer90) + (rules.red * rates.redsPer90)) * share,
  };
  return { total: Object.values(parts).reduce((sum, v) => sum + v, 0), parts };
}

/**
 * His rates: his season so far pulled towards the prior for his position and
 * price (model.priors, each share and per-90 rate a line a + b x price in £m,
 * never below nothing). His record weighs what it covers - his team's
 * expected goals while he was on for the shares, his 90s for the per-90 rates
 * - against model.priorWeight of the prior's. His bonus residual is what he
 * earned beyond what the bonus model gives his actual returns, pulled towards
 * none.
 *
 * @param {object} totals   his season totals, as normalise.js keeps them (minutes,
 *   xG, xA, saves, defensiveContribution, yellowCards, redCards, bonus, goals,
 *   assists, cleanSheets)
 * @param {{xgFor90: number, xgAgainst90: number}} team   his club's (team-goals.js teamRates)
 * @param {{position: string, priceTenths: number}} player
 * @param {object} model   DECISION_ENGINE.pointsModel
 * @returns {PointsRates}
 */
export function playerRates(totals, team, { position, priceTenths }, model) {
  const prior = model.priors[position];
  const weight = model.priorWeight;
  const price = fromTenths(priceTenths);
  const line = ([a, b]) => Math.max(0, a + (b * price));
  const nineties = totals.minutes / MATCH_MINUTES;
  const onFor = team.xgFor90 * nineties;
  const onAgainst = team.xgAgainst90 * nineties;
  const shrink = (count, exposure, priorRate, priorWeight) => (count + (priorWeight * priorRate)) / (exposure + priorWeight);
  const bonus = model.bonus[position];
  const explained = (bonus.base * nineties) + (bonus.goal * totals.goals) + (bonus.assist * totals.assists)
    + (bonus.cleanSheet * totals.cleanSheets);
  return {
    position,
    goalShare: shrink(totals.xG, onFor, line(prior.goalShare), weight.share),
    assistShare: shrink(totals.xA, onFor, line(prior.assistShare), weight.share),
    savesPerXga: shrink(totals.saves, onAgainst, prior.savesPerXga, weight.saves),
    defconPer90: shrink(totals.defensiveContribution, nineties, line(prior.defconPer90), weight.per90),
    yellowsPer90: shrink(totals.yellowCards, nineties, prior.yellowsPer90, weight.per90),
    redsPer90: shrink(totals.redCards, nineties, prior.redsPer90, weight.per90),
    bonusResidualPer90: shrink(totals.bonus - explained, nineties, 0, weight.per90),
  };
}
