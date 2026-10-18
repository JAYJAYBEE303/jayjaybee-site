/**
 * tests/engine/points.test.js
 * The points model (docs/decision-engine-plan.md, Phase 6b): a player's
 * expected FPL points in one fixture he plays, built from its parts, with his
 * team's expected goals for and against carrying the fixture; and the two
 * count-distribution helpers it rests on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { poissonFloorMean, negativeBinomialTail } from '../../js/util.js';
import { fixturePoints, playerRates } from '../../js/engine/points.js';
import { FPL_SCORING } from '../../js/config.js';

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);

const poisson = (lambda, k) => {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
};
const poissonAtLeast = (lambda, k) => 1 - Array.from({ length: k }, (_, i) => poisson(lambda, i)).reduce((a, b) => a + b, 0);

// ─── Count helpers ───────────────────────────────────────────────────────────

test('poissonFloorMean is E[floor(X / d)] for a Poisson count', () => {
  close(poissonFloorMean(0, 2), 0);
  // E[floor(X / d)] = sum over k >= 1 of P(X >= k d).
  for (const [lambda, d] of [[1, 2], [3, 3], [0.4, 2], [6.5, 3]]) {
    const expected = Array.from({ length: 40 }, (_, i) => poissonAtLeast(lambda, (i + 1) * d)).reduce((a, b) => a + b, 0);
    close(poissonFloorMean(lambda, d), expected, `lambda ${lambda}, d ${d}`);
  }
});

test('negativeBinomialTail is P(X >= t); infinite dispersion is the Poisson tail', () => {
  close(negativeBinomialTail(12, Infinity, 12), poissonAtLeast(12, 12));
  // Dispersion 1 is the geometric count: P(X >= t) = (m / (1 + m))^t.
  close(negativeBinomialTail(12, 1, 12), (12 / 13) ** 12);
  close(negativeBinomialTail(5, 1, 0), 1);
  close(negativeBinomialTail(0, 2, 1), 0);
  // More spread puts more weight in the tail above the mean.
  assert.ok(negativeBinomialTail(8, 2, 14) > negativeBinomialTail(8, Infinity, 14));
});

// ─── One fixture, part by part ───────────────────────────────────────────────

/** A model whose multipliers are 1 and whose bonus is off, so every part can be worked out by hand. */
const MODEL = {
  goalsPerXg: 1, assistsPerXa: 1, minutesIfFull: 90, defconDispersion: Infinity,
  bonus: Object.fromEntries(['GKP', 'DEF', 'MID', 'FWD'].map(p => [p, { base: 0, goal: 0, assist: 0, cleanSheet: 0 }])),
};
const rates = overrides => ({
  position: 'MID', goalShare: 0, assistShare: 0, savesPerXga: 0, defconPer90: 0,
  yellowsPer90: 0, redsPer90: 0, bonusResidualPer90: 0, ...overrides,
});
const FULL = { lambdaFor: 1.5, lambdaAgainst: 1, p60: 1, minutes: 90 };

test('a forward\'s goals and assists are his shares of his team\'s expected goals', () => {
  const { total, parts } = fixturePoints(rates({ position: 'FWD', goalShare: 0.3, assistShare: 0.1 }), FULL, MODEL);
  close(parts.appearance, 2);
  close(parts.goals, 4 * 0.3 * 1.5);
  close(parts.assists, 3 * 0.1 * 1.5);
  close(parts.cleanSheet, 0);
  close(parts.conceded, 0);
  close(total, 2 + 1.8 + 0.45);
});

test('a defender\'s clean sheet and goals conceded follow the goals his team is expected to concede', () => {
  const { parts } = fixturePoints(rates({ position: 'DEF', goalShare: 0.05, assistShare: 0.05 }), FULL, MODEL);
  close(parts.goals, 6 * 0.05 * 1.5);
  close(parts.cleanSheet, 4 * Math.exp(-1));
  // -1 per two conceded: E[floor(G / 2)] for G ~ Poisson(1).
  close(parts.conceded, -Array.from({ length: 20 }, (_, i) => poissonAtLeast(1, 2 * (i + 1))).reduce((a, b) => a + b, 0));
  const midfielder = fixturePoints(rates({ goalShare: 0.05 }), FULL, MODEL).parts;
  close(midfielder.cleanSheet, Math.exp(-1));
  close(midfielder.conceded, 0);
});

test('a substitute gets one appearance point, no clean sheet and returns for his minutes only', () => {
  const sub = { ...FULL, p60: 0, minutes: 20 };
  const { parts } = fixturePoints(rates({ position: 'DEF', goalShare: 0.3 }), sub, MODEL);
  close(parts.appearance, 1);
  close(parts.cleanSheet, 0);
  close(parts.goals, 6 * 0.3 * 1.5 * (20 / 90));
  close(parts.conceded, -poissonFloorMean(20 / 90, 2));
});

test('defensive contributions pay 2 when he reaches his position\'s threshold, under the rules that have them', () => {
  const busy = rates({ defconPer90: 12 });
  close(fixturePoints(busy, FULL, MODEL).parts.defcon, 2 * poissonAtLeast(12, 12));
  close(fixturePoints(rates({ position: 'DEF', defconPer90: 12 }), FULL, MODEL).parts.defcon, 2 * poissonAtLeast(12, 10));
  close(fixturePoints(rates({ position: 'GKP', defconPer90: 30 }), FULL, MODEL).parts.defcon, 0);
  close(fixturePoints(busy, FULL, { ...MODEL, defconDispersion: 1 }).parts.defcon, 2 * (12 / 13) ** 12);
  close(fixturePoints(busy, FULL, MODEL, { ...FPL_SCORING, defensiveContribution: null }).parts.defcon, 0);
});

test('a keeper\'s saves follow the goals his team is expected to concede, one point per three', () => {
  const keeper = rates({ position: 'GKP', savesPerXga: 2 });
  close(fixturePoints(keeper, { ...FULL, lambdaAgainst: 1.5 }, MODEL).parts.saves, poissonFloorMean(3, 3));
  close(fixturePoints(rates({ savesPerXga: 2 }), FULL, MODEL).parts.saves, 0);
});

test('bonus follows his expected returns, plus his own tendency, never below nothing', () => {
  const model = { ...MODEL, bonus: { ...MODEL.bonus, FWD: { base: 0.1, goal: 1, assist: 0.5, cleanSheet: 0 } } };
  const forward = rates({ position: 'FWD', goalShare: 0.3, assistShare: 0.1 });
  close(fixturePoints(forward, FULL, model).parts.bonus, 0.1 + 0.45 + (0.5 * 0.15));
  close(fixturePoints({ ...forward, bonusResidualPer90: 0.2 }, FULL, model).parts.bonus, 0.1 + 0.45 + 0.075 + 0.2);
  close(fixturePoints({ ...forward, bonusResidualPer90: -5 }, FULL, model).parts.bonus, 0);
});

test('cards cost their points at his rate for his minutes', () => {
  close(fixturePoints(rates({ yellowsPer90: 0.2, redsPer90: 0.01 }), { ...FULL, minutes: 45, p60: 0 }, MODEL).parts.cards,
    (-1 * 0.2 * 0.5) + (-3 * 0.01 * 0.5));
});

test('FPL\'s assists per expected assist scale the assists; a part-time player\'s defensive actions and clean sheet', () => {
  const forward = rates({ position: 'FWD', assistShare: 0.1, defconPer90: 12 });
  close(fixturePoints(forward, FULL, { ...MODEL, assistsPerXa: 1.4 }).parts.assists, 3 * 1.4 * 0.1 * 1.5);
  // Half a match: half his defensive actions.
  const half = { ...FULL, minutes: 45, p60: 0 };
  close(fixturePoints(forward, half, MODEL).parts.defcon, 2 * poissonAtLeast(6, 12));
  // A clean sheet's exposure is a full player's match (minutesIfFull), whatever his own expected minutes.
  const defender = rates({ position: 'DEF' });
  const model = { ...MODEL, minutesIfFull: 85 };
  close(fixturePoints(defender, { ...FULL, minutes: 70 }, model).parts.cleanSheet, 4 * Math.exp(-1 * (85 / 90)));
});

test('the parts add up, and a better fixture moves only the parts it should', () => {
  const forward = rates({ position: 'FWD', goalShare: 0.3, assistShare: 0.1, defconPer90: 4, yellowsPer90: 0.1 });
  const { total, parts } = fixturePoints(forward, FULL, MODEL);
  close(total, Object.values(parts).reduce((a, b) => a + b, 0));
  const easier = fixturePoints(forward, { ...FULL, lambdaFor: 2.5 }, MODEL).parts;
  assert.ok(easier.goals > parts.goals && easier.assists > parts.assists);
  close(easier.appearance, parts.appearance);
  close(easier.defcon, parts.defcon);
  const defender = rates({ position: 'DEF', goalShare: 0.05 });
  const tougher = fixturePoints(defender, { ...FULL, lambdaAgainst: 2 }, MODEL).parts;
  const normal = fixturePoints(defender, FULL, MODEL).parts;
  assert.ok(tougher.cleanSheet < normal.cleanSheet && tougher.conceded < normal.conceded);
  close(tougher.appearance, normal.appearance);
});

// ─── His rates: his season so far, pulled towards his prior ──────────────────

const PRIOR_MODEL = {
  ...MODEL,
  bonus: { ...MODEL.bonus, MID: { base: 0.2, goal: 1, assist: 0.5, cleanSheet: 0.1 } },
  // goalShare and the like read a + b x price in £m.
  priors: { MID: { goalShare: [0.02, 0.01], assistShare: [0.03, 0.005], defconPer90: [6, 0],
    savesPerXga: 0, yellowsPer90: 0.15, redsPer90: 0.005 } },
  priorWeight: { share: 2, per90: 5, saves: 3 },
};
const TEAM = { xgFor90: 1.5, xgAgainst90: 1.2 };
const NONE = { minutes: 0, xG: 0, xA: 0, saves: 0, defensiveContribution: 0, yellowCards: 0, redCards: 0, bonus: 0, goals: 0,
  assists: 0, cleanSheets: 0 };
const MID_8 = { position: 'MID', priceTenths: 80 };

test('with no minutes his rates are the prior for his position and price', () => {
  const r = playerRates(NONE, TEAM, MID_8, PRIOR_MODEL);
  close(r.goalShare, 0.02 + (0.01 * 8));
  close(r.assistShare, 0.03 + (0.005 * 8));
  close(r.defconPer90, 6);
  close(r.yellowsPer90, 0.15);
  close(r.bonusResidualPer90, 0);
  assert.equal(r.position, 'MID');
});

test('his record counts for as much as the prior weighs, in team chances or in 90s', () => {
  // 900 minutes: ten 90s, on the pitch for 15 of his team's expected goals.
  const stats = { ...NONE, minutes: 900, xG: 3, xA: 1.5, defensiveContribution: 100, yellowCards: 2 };
  const r = playerRates(stats, TEAM, MID_8, PRIOR_MODEL);
  close(r.goalShare, (3 + (2 * 0.1)) / (15 + 2));
  close(r.assistShare, (1.5 + (2 * 0.07)) / (15 + 2));
  close(r.defconPer90, (100 + (5 * 6)) / (10 + 5));
  close(r.yellowsPer90, (2 + (5 * 0.15)) / (10 + 5));
});

test('his bonus residual is what he earned beyond his returns, shrunk towards none', () => {
  const stats = { ...NONE, minutes: 900, goals: 2, assists: 2, cleanSheets: 3, bonus: 9 };
  const explained = (0.2 * 10) + (1 * 2) + (0.5 * 2) + (0.1 * 3);
  close(playerRates(stats, TEAM, MID_8, PRIOR_MODEL).bonusResidualPer90, (9 - explained) / (10 + 5));
});

test('a prior line that would go below nothing at a low price stops at nothing', () => {
  const model = { ...PRIOR_MODEL, priors: { MID: { ...PRIOR_MODEL.priors.MID, goalShare: [-0.1, 0.01] } } };
  close(playerRates(NONE, TEAM, { position: 'MID', priceTenths: 45 }, model).goalShare, 0);
});
