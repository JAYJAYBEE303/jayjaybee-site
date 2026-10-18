/**
 * tests/engine/team-goals.test.js
 * Each club's expected goals for and against (docs/decision-engine-plan.md,
 * Phase 6b): its rates read from its players' season totals, its attack and
 * defence against the league pulled towards a prior, and the goals each side
 * of a fixture is expected to score.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { teamRates, teamStrengths, fixtureGoals } from '../../js/engine/team-goals.js';

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);

/** Eleven players who played every minute of n matches, sharing the club's xG and each seeing all of its xG against. */
const player = (teamId, minutes, xG, xGC) => ({ teamId, totals: { minutes, xG, xGC } });
const club = (teamId, matches, xgFor, xgAgainst) => Array.from({ length: 11 }, () => player(teamId, matches * 90, xgFor / 11, xgAgainst));

test('a club\'s rates per 90 come from its players\' season totals', () => {
  const rates = teamRates([...club(1, 10, 15, 12), player(1, 0, 0, 0)]);
  close(rates.get(1).xgFor90, 1.5);
  close(rates.get(1).xgAgainst90, 1.2);
  close(rates.get(1).matches, 10);
  // A sub's minutes count for less of the club's: half a match, half his xG against.
  const mixed = teamRates([...club(2, 4, 8, 4), player(2, 45, 0, 0.5)]);
  close(mixed.get(2).xgAgainst90, (11 * 4 + 0.5) / ((11 * 4) + 0.5));
});

const MODEL = { leagueXg: 1.4, priorMatches: 0, homeAdvantage: 1, promoted: { attack: 0.8, defence: 1.2 } };

test('with no prior weight a club\'s attack and defence are its rates against the league\'s', () => {
  const rates = teamRates([...club(1, 10, 20, 10), ...club(2, 10, 10, 20)]);
  const { league, byTeam } = teamStrengths(rates, new Map(), MODEL);
  close(league, 1.5);
  close(byTeam.get(1).attack, 2 / 1.5);
  close(byTeam.get(1).defence, 1 / 1.5);
  close(byTeam.get(2).attack, 1 / 1.5);
});

test('early on a club reads mostly as its prior; a club with none reads as promoted', () => {
  const rates = teamRates([...club(1, 1, 3, 0), ...club(2, 1, 0, 3)]);
  const priors = new Map([[1, { attack: 1.1, defence: 0.9 }]]);
  const model = { ...MODEL, priorMatches: 4 };
  const { league, byTeam } = teamStrengths(rates, priors, model);
  // The league's level is pulled towards leagueXg by the same weight per club.
  close(league, (3 + 0 + (2 * 4 * 1.4)) / (2 + (2 * 4)));
  close(byTeam.get(1).attack, (3 + (4 * 1.1 * league)) / ((1 + 4) * league));
  close(byTeam.get(2).defence, (3 + (4 * 1.2 * league)) / ((1 + 4) * league));
  // A club in the fixture list with no record yet is its prior.
  const empty = teamStrengths(new Map([[3, { xgFor90: 0, xgAgainst90: 0, matches: 0 }]]), new Map(), model);
  close(empty.byTeam.get(3).attack, 0.8);
  close(empty.league, 1.4);
});

test('each side\'s expected goals: the league\'s level, its attack, the other\'s defence and home advantage', () => {
  const strengths = { league: 1.4, byTeam: new Map([[1, { attack: 1.2, defence: 0.8 }], [2, { attack: 0.9, defence: 1.1 }]]) };
  const { home, away } = fixtureGoals(strengths, 1, 2, { ...MODEL, homeAdvantage: 1.1 });
  close(home, 1.4 * 1.2 * 1.1 * 1.1);
  close(away, 1.4 * 0.9 * 0.8 / 1.1);
  assert.throws(() => fixtureGoals(strengths, 1, 9, MODEL), /no strength for club 9/);
});
