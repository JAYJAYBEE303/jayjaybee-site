/**
 * tools/points/lib.js
 * The offline points-model tool (docs/decision-engine-plan.md, Phase 6b): the
 * figures DECISION_ENGINE.pointsModel holds, fitted on vaastav's seasons
 * (tools/backtest/history.js), and the scoreboard that tests the projections
 * they give against what players then scored.
 */

import { FPL_SCORING, MATCH_MINUTES } from '../../js/config.js';
import { fromTenths, seededRandom } from '../../js/util.js';
import { solve } from '../minutes/lib.js';

const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];
// A whisker of ridge, so a column with nothing in it (a keeper's goals) solves to 0.
const RIDGE = 1e-9;
// The scoreboard's 95% interval.
const LOWER_TAIL = 0.025;
const UPPER_TAIL = 0.975;

const sum = (xs, f) => xs.reduce((total, x) => total + f(x), 0);
const mean = (xs, f) => (xs.length ? sum(xs, f) / xs.length : 0);

/** Goals per xG, FPL assists per xA, and the minutes of a full (60+) and a short appearance. */
export function appearanceConstants(rows) {
  const apps = rows.filter(r => r.minutes > 0);
  const full = apps.filter(r => r.minutes >= FPL_SCORING.fullMinutes);
  const short = apps.filter(r => r.minutes < FPL_SCORING.fullMinutes);
  return {
    goalsPerXg: sum(apps, r => r.goals) / sum(apps, r => r.xg),
    assistsPerXa: sum(apps, r => r.assists) / sum(apps, r => r.xa),
    minutesIfFull: mean(full, r => r.minutes),
    minutesIfShort: mean(short, r => r.minutes),
  };
}

/**
 * The bonus model per position: least squares of an appearance's bonus on
 * its share of 90 minutes, goals, assists and clean sheet.
 * @returns {Object<string, {base: number, goal: number, assist: number, cleanSheet: number}>}
 */
export function fitBonus(rows) {
  const out = {};
  for (const position of POSITIONS) {
    const apps = rows.filter(r => r.position === position && r.minutes > 0);
    const X = apps.map(r => [r.minutes / MATCH_MINUTES, r.goals, r.assists, r.cleanSheets]);
    const A = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => sum(X, x => x[i] * x[j]) + (i === j ? RIDGE : 0)));
    const b = [0, 1, 2, 3].map(i => apps.reduce((total, r, n) => total + (X[n][i] * r.bonus), 0));
    const [base, goal, assist, cleanSheet] = apps.length ? solve(A, b) : [0, 0, 0, 0];
    out[position] = { base, goal, assist, cleanSheet };
  }
  return out;
}

/** Weighted least squares of y on x: [intercept, slope]. */
function line(points) {
  const w = sum(points, p => p.w);
  if (!(w > 0)) return [0, 0];
  const mx = sum(points, p => p.w * p.x) / w;
  const my = sum(points, p => p.w * p.y) / w;
  const sxx = sum(points, p => p.w * ((p.x - mx) ** 2));
  const slope = sxx > 0 ? sum(points, p => p.w * (p.x - mx) * (p.y - my)) / sxx : 0;
  return [my - (slope * mx), slope];
}

/**
 * The priors engine/points.js pulls a player's record towards, per position:
 * his share of his club's xG and xA, and his defensive actions per 90, as
 * exposure-weighted lines in price (£m); a keeper's saves per xG against and
 * every position's cards per 90 as rates.
 *
 * @param {object[]} totals   season totals (tools/backtest/history.js totalsBefore)
 * @param {Map<number, {xgFor90: number, xgAgainst90: number}>} clubs  by club id
 */
export function fitPriors(totals, clubs) {
  const out = {};
  for (const position of POSITIONS) {
    const players = totals.filter(t => t.position === position && t.minutes > 0 && clubs.has(t.teamId));
    const nineties = t => t.minutes / MATCH_MINUTES;
    const onFor = t => clubs.get(t.teamId).xgFor90 * nineties(t);
    const onAgainst = t => clubs.get(t.teamId).xgAgainst90 * nineties(t);
    const shareLine = key => line(players.filter(t => onFor(t) > 0)
      .map(t => ({ x: fromTenths(t.priceTenths), y: t[key] / onFor(t), w: onFor(t) })));
    out[position] = {
      goalShare: shareLine('xg'),
      assistShare: shareLine('xa'),
      defconPer90: line(players.map(t => ({ x: fromTenths(t.priceTenths), y: t.defcon / nineties(t), w: nineties(t) }))),
      savesPerXga: position === 'GKP' ? sum(players, t => t.saves) / sum(players, onAgainst) : 0,
      yellowsPer90: sum(players, t => t.yellows) / sum(players, nineties),
      redsPer90: sum(players, t => t.reds) / sum(players, nineties),
    };
  }
  return out;
}

/**
 * The dispersion of defensive actions in an appearance (engine/points.js's
 * negative binomial), by the method of moments: each appearance's mean is
 * the player's rate per 90 for its minutes. Infinite when they spread no
 * more than a Poisson count.
 */
export function fitDefconDispersion(rows) {
  const apps = rows.filter(r => r.minutes > 0 && FPL_SCORING.defensiveContribution.threshold[r.position]);
  const rate = new Map();
  for (const r of apps) {
    const p = rate.get(r.element) ?? { actions: 0, nineties: 0 };
    p.actions += r.defcon;
    p.nineties += r.minutes / MATCH_MINUTES;
    rate.set(r.element, p);
  }
  let squares = 0;
  let excess = 0;
  for (const r of apps) {
    const p = rate.get(r.element);
    const mu = (p.actions / p.nineties) * (r.minutes / MATCH_MINUTES);
    squares += mu * mu;
    excess += ((r.defcon - mu) ** 2) - mu;
  }
  return excess > 0 ? squares / excess : Infinity;
}

/** Each fixture's sides with their xG: [{fixture, teamId, home, xg, against}], fixtures with no xG left out. */
function sides(season) {
  const byFixture = new Map();
  for (const r of season.rows) {
    const teams = byFixture.get(r.fixture) ?? new Map();
    const side = teams.get(r.teamId) ?? { fixture: r.fixture, teamId: r.teamId, home: r.home, xg: 0 };
    side.xg += r.xg;
    teams.set(r.teamId, side);
    byFixture.set(r.fixture, teams);
  }
  const out = [];
  for (const teams of byFixture.values()) {
    const [a, b] = [...teams.values()];
    if (!b || a.xg + b.xg === 0) continue;
    out.push({ ...a, against: b.xg }, { ...b, against: a.xg });
  }
  return out;
}

/**
 * A whole season's club ratings, keyed by FPL club code (stable from season
 * to season): xG for and against a match, each against the league's mean.
 * @returns {Map<number, {attack: number, defence: number}>}
 */
export function seasonTeamRatings(season) {
  const all = sides(season);
  const league = mean(all, s => s.xg);
  const code = new Map(season.teams.map(t => [t.id, t.code]));
  const ratings = new Map();
  for (const teamId of new Set(all.map(s => s.teamId))) {
    const mine = all.filter(s => s.teamId === teamId);
    ratings.set(code.get(teamId), { attack: mean(mine, s => s.xg) / league, defence: mean(mine, s => s.against) / league });
  }
  return ratings;
}

/** Next season's club priors: this season's ratings pulled towards the league's level by `regression` (1 keeps them). */
export function teamPriors(ratings, regression) {
  const pull = r => 1 + (regression * (r - 1));
  return Object.fromEntries([...ratings].map(([code, r]) => [code, { attack: pull(r.attack), defence: pull(r.defence) }]));
}

/**
 * A promoted club's prior: the mean first-season rating of the clubs in each
 * [previous, current] pair of seasons that were not in the previous one.
 */
export function promotedPrior(pairs) {
  const ratings = pairs.flatMap(([previous, current]) => {
    const before = new Set(previous.teams.map(t => t.code));
    const now = seasonTeamRatings(current);
    return current.teams.filter(t => !before.has(t.code) && now.has(t.code)).map(t => now.get(t.code));
  });
  return { attack: mean(ratings, r => r.attack), defence: mean(ratings, r => r.defence) };
}

/** The league's mean xG for a club in a match, and home advantage: the square root of home over away. */
export function leagueConstants(seasons) {
  const all = seasons.flatMap(sides);
  const home = mean(all.filter(s => s.home), s => s.xg);
  const away = mean(all.filter(s => !s.home), s => s.xg);
  return { leagueXg: (home + away) / 2, homeAdvantage: Math.sqrt(home / away) };
}

/**
 * Each asked-about player's projected points against what he scored, per
 * gameweek of the window (0 when he did not play).
 * @returns {Array<{playerId: number, gw: number, k: number, projected: number, actual: number}>}
 */
export function windowErrors(projections, actual, playerIds, gws) {
  const out = [];
  for (const playerId of playerIds) {
    const projection = projections.get(playerId);
    gws.forEach((gw, k) => out.push({
      playerId, gw, k,
      projected: projection?.gws.find(g => g.gw === gw)?.xpts ?? 0,
      actual: actual.get(playerId)?.get(gw) ?? 0,
    }));
  }
  return out;
}

/** Mean squared and absolute error, and mean bias (projected less actual). */
export function summarise(errors) {
  return {
    n: errors.length,
    mse: mean(errors, e => (e.projected - e.actual) ** 2),
    mae: mean(errors, e => Math.abs(e.projected - e.actual)),
    bias: mean(errors, e => e.projected - e.actual),
  };
}

/**
 * A moving-block bootstrap of a series' mean: blocks of `block` consecutive
 * values (neighbouring decision gameweeks share most of their window, so
 * they are not independent), `draws` resamples, seeded.
 * @returns {{mean: number, lo: number, hi: number}}  the 95% interval
 */
export function blockBootstrap(values, { block, draws, seed }) {
  const random = seededRandom(seed);
  const n = values.length;
  const size = Math.min(block, n);
  const means = [];
  for (let d = 0; d < draws; d++) {
    let total = 0;
    let count = 0;
    while (count < n) {
      const start = Math.floor(random() * (n - size + 1));
      for (let i = start; i < start + size && count < n; i++, count++) total += values[i];
    }
    means.push(total / n);
  }
  means.sort((a, b) => a - b);
  return {
    mean: sum(values, v => v) / n,
    lo: means[Math.floor(LOWER_TAIL * draws)],
    hi: means[Math.ceil(UPPER_TAIL * draws) - 1],
  };
}
