/**
 * tests/tools/points.test.js
 * The offline points-model tool (tools/points, plan Phase 6b): the constants
 * read off appearances, the bonus model, the priors, the spread of defensive
 * contributions, the clubs' ratings and priors, and the scoreboard's errors
 * and confidence intervals.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appearanceConstants, fitBonus, fitPriors, fitDefconDispersion, seasonTeamRatings, teamPriors,
  leagueConstants, promotedPrior, windowErrors, summarise, blockBootstrap,
} from '../../tools/points/lib.js';

const close = (actual, expected, message, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, message ?? `${actual} is not ${expected}`);

const row = overrides => ({
  element: 1, position: 'MID', teamId: 1, opponentId: 2, home: true, fixture: 1, gw: 1, minutes: 90,
  points: 2, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, xg: 0, xa: 0, xgc: 0, saves: 0, defcon: 0,
  yellows: 0, reds: 0, priceTenths: 60, ...overrides,
});

// ─── Constants read off appearances ──────────────────────────────────────────

test('goals per xG, FPL assists per xA and the minutes of a full and a short appearance', () => {
  const rows = [
    row({ minutes: 90, goals: 1, xg: 0.5, assists: 1, xa: 0.25 }), row({ minutes: 80, goals: 0, xg: 0.5, assists: 1, xa: 0.75 }),
    row({ minutes: 20, xg: 0 }), row({ minutes: 30 }), row({ minutes: 0, goals: 0, xg: 5 }),
  ];
  const c = appearanceConstants(rows);
  close(c.goalsPerXg, 1);
  close(c.assistsPerXa, 2);
  close(c.minutesIfFull, 85);
  close(c.minutesIfShort, 25);
});

test('the bonus model recovers coefficients the data was built from', () => {
  const truth = { base: 0.2, goal: 1, assist: 0.5, cleanSheet: 0.3 };
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const goals = i % 3, assists = (i % 4 === 1) ? 1 : 0, cleanSheets = i % 2, minutes = 30 + (i % 7) * 10;
    rows.push(row({ position: 'FWD', goals, assists, cleanSheets, minutes,
      bonus: (truth.base * minutes / 90) + (truth.goal * goals) + (truth.assist * assists) + (truth.cleanSheet * cleanSheets) }));
  }
  const fwd = fitBonus(rows).FWD;
  for (const key of Object.keys(truth)) close(fwd[key], truth[key], key, 1e-6);
});

test('a keeper\'s bonus model has no goal term to find', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ position: 'GKP', cleanSheets: i % 2, bonus: i % 2 }));
  const gkp = fitBonus(rows).GKP;
  assert.ok(Number.isFinite(gkp.goal) && Number.isFinite(gkp.base));
});

// ─── Priors ──────────────────────────────────────────────────────────────────

test('the priors are exposure-weighted lines in price, and per-90 rates by position', () => {
  // Three midfielders on a line: share = 0.01 + 0.02 x price; club xG 1.5 per 90.
  const totals = [5, 7, 9].map((price, i) => ({
    element: i + 1, position: 'MID', teamId: 1, priceTenths: price * 10, minutes: 900 * (i + 1),
    xg: (0.01 + (0.02 * price)) * 1.5 * 10 * (i + 1), xa: 0.05 * 1.5 * 10 * (i + 1), defcon: 6 * 10 * (i + 1),
    saves: 0, xgc: 0, yellows: 0.1 * 10 * (i + 1), reds: 0,
  }));
  const priors = fitPriors(totals, new Map([[1, { xgFor90: 1.5, xgAgainst90: 1.2 }]])).MID;
  close(priors.goalShare[0], 0.01, 'intercept', 1e-9);
  close(priors.goalShare[1], 0.02, 'slope', 1e-9);
  close(priors.assistShare[0] + (priors.assistShare[1] * 7), 0.05);
  close(priors.defconPer90[0] + (priors.defconPer90[1] * 6), 6);
  close(priors.yellowsPer90, 0.1);
});

// ─── Defensive contributions: their spread ───────────────────────────────────

test('the dispersion of defensive actions, by the method of moments', () => {
  // Every appearance has a mean of 10; actions of 5 and 15 give squared deviations of 25, which his own
  // two-match mean understates by (n - 1) / n: variance 50 against a Poisson's 10.
  const rows = [row({ element: 1, defcon: 5 }), row({ element: 1, defcon: 15 })];
  close(fitDefconDispersion(rows), (10 * 10 * 2) / (2 * ((2 * 25) - 10)));
  // A player with a single appearance has no spread to measure and is left out.
  close(fitDefconDispersion([...rows, row({ element: 2, defcon: 30 })]), (10 * 10 * 2) / (2 * ((2 * 25) - 10)));
  // No more spread than a Poisson count: infinite dispersion.
  assert.equal(fitDefconDispersion([row({ defcon: 10 }), row({ defcon: 10 })]), Infinity);
});

// ─── Clubs ───────────────────────────────────────────────────────────────────

const club = (fixture, teamId, opponentId, home, xg) => row({ fixture, teamId, opponentId, home, xg });

test('a season\'s club ratings by FPL code, and next season\'s priors pulled towards the league', () => {
  const season = {
    teams: [{ id: 1, code: 3 }, { id: 2, code: 8 }],
    rows: [club(1, 1, 2, true, 2), club(1, 2, 1, false, 1), club(2, 2, 1, true, 1), club(2, 1, 2, false, 2)],
  };
  const ratings = seasonTeamRatings(season);
  close(ratings.get(3).attack, 2 / 1.5);
  close(ratings.get(3).defence, 1 / 1.5);
  close(ratings.get(8).attack, 1 / 1.5);
  const priors = teamPriors(ratings, 0.5);
  close(priors[3].attack, 1 + (0.5 * ((2 / 1.5) - 1)));
  close(priors[8].defence, 1 + (0.5 * ((2 / 1.5) - 1)));
});

test('a fixture with no xG recorded is left out of the ratings', () => {
  const season = {
    teams: [{ id: 1, code: 3 }, { id: 2, code: 8 }],
    rows: [club(1, 1, 2, true, 0), club(1, 2, 1, false, 0), club(2, 1, 2, true, 2), club(2, 2, 1, false, 1)],
  };
  close(seasonTeamRatings(season).get(3).attack, 2 / 1.5);
});

test('a promoted club\'s prior is how clubs new to the league rated in their first season', () => {
  const previous = { teams: [{ id: 1, code: 3 }, { id: 2, code: 8 }], rows: [] };
  const current = {
    teams: [{ id: 1, code: 3 }, { id: 2, code: 99 }],
    rows: [club(1, 1, 2, true, 2), club(1, 2, 1, false, 1), club(2, 2, 1, true, 1), club(2, 1, 2, false, 2)],
  };
  const prior = promotedPrior([[previous, current]]);
  close(prior.attack, 1 / 1.5);
  close(prior.defence, 2 / 1.5);
});

test('the league\'s level is its clubs\' mean xG a match, home advantage the root of home over away', () => {
  const season = { teams: [{ id: 1, code: 3 }, { id: 2, code: 8 }],
    rows: [club(1, 1, 2, true, 1.8), club(1, 2, 1, false, 1.2), club(2, 2, 1, true, 1.8), club(2, 1, 2, false, 1.2)] };
  const c = leagueConstants([season]);
  close(c.leagueXg, 1.5);
  close(c.homeAdvantage, Math.sqrt(1.8 / 1.2));
});

// ─── The scoreboard ──────────────────────────────────────────────────────────

test('window errors pair each projected GW with what he scored (0 when he did not play) for the players asked about', () => {
  const projections = new Map([[7, { gws: [{ gw: 5, xpts: 4 }, { gw: 6, xpts: 3 }] }], [8, { gws: [{ gw: 5, xpts: 1 }, { gw: 6, xpts: 1 }] }]]);
  const actual = new Map([[7, new Map([[5, 6]])]]);
  const errors = windowErrors(projections, actual, [7], [5, 6]);
  assert.deepEqual(errors, [{ playerId: 7, gw: 5, k: 0, projected: 4, actual: 6 }, { playerId: 7, gw: 6, k: 1, projected: 3, actual: 0 }]);
  const s = summarise(errors);
  close(s.mse, ((2 * 2) + (3 * 3)) / 2);
  close(s.mae, 2.5);
  close(s.bias, ((4 - 6) + (3 - 0)) / 2);
  assert.equal(s.n, 2);
});

test('the block bootstrap repeats for a seed, is no wider than nothing for a constant, and brackets its mean', () => {
  const constant = blockBootstrap(Array(12).fill(0.3), { block: 3, draws: 200, seed: 1 });
  close(constant.lo, 0.3);
  close(constant.hi, 0.3);
  const values = Array.from({ length: 30 }, (_, i) => Math.sin(i) + 0.5);
  const a = blockBootstrap(values, { block: 5, draws: 500, seed: 4 });
  assert.deepEqual(a, blockBootstrap(values, { block: 5, draws: 500, seed: 4 }));
  assert.ok(a.lo < a.mean && a.mean < a.hi);
  close(a.mean, values.reduce((x, y) => x + y, 0) / values.length);
});

test('the block bootstrap wraps round the series, so its end values are drawn as often as the rest', () => {
  // Without wrapping, the last value can sit in at most one drawn block and the mean is the interval's top.
  const b = blockBootstrap([0, 0, 0, 0, 0, 0, 7], { block: 5, draws: 2000, seed: 3 });
  assert.ok(b.hi > b.mean, `[${b.lo}, ${b.hi}] around ${b.mean}`);
});
