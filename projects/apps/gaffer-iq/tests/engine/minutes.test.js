/**
 * tests/engine/minutes.test.js
 * The minutes model's shared half (docs/decision-engine-plan.md Phase 4): the
 * features read from a player's contention record and the three selection
 * heads. The offline tool builds its training rows with the same functions,
 * so each test pins a definition both sides use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { minutesFeatures, selectionChances } from '../../js/engine/minutes.js';

// Small windows, so every figure can be checked by hand.
const SETTINGS = { windows: { short: 2, mid: 3, long: 4 }, playedMinutes: 60, minHistoryGws: 1 };
const MID = { position: 'MID', priceTenths: 65 };

/** One gameweek of his record: his club's fixtures that week, his minutes and starts over them. */
const gw = (number, minutes, starts, fixtures = 1) => ({ gw: number, fixtures, minutes, starts });

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

// ─── Features ────────────────────────────────────────────────────────────────

test('features average his starts, appearances and minutes over the configured windows', () => {
  const history = [
    gw(1, 90, 1),
    gw(2, 0, 0),
    gw(3, 30, 0),          // off the bench
    gw(4, 150, 2, 2),      // a double: started both, 75 minutes a fixture
    gw(5, 70, 1),
  ];
  const f = minutesFeatures(history, MID, SETTINGS);
  assert.equal(f.startShort, 1);                       // GW4-5
  assert.equal(f.startLong, 0.5);                      // GW2-5
  close(f.startSeason, 0.6);
  assert.equal(f.appearMid, 1);                        // GW3-5
  close(f.minutesMid, (30 + 75 + 70) / 3 / 90);
  assert.equal(f.startedLast, 1);
  assert.equal(f.played60Last, 1);
  assert.equal(f.zeroRun, 0);
  close(f.fullRun, Math.log(3));                       // 60 minutes a fixture in GW4 and GW5
  assert.equal(f.history, 1);                          // five gameweeks, capped at the long window
});

test('runs still going - of zero-minute and of 60-minute gameweeks - count as log(1 + length)', () => {
  const history = [gw(1, 90, 1), gw(2, 0, 0), gw(3, 0, 0), gw(4, 0, 0)];
  const f = minutesFeatures(history, MID, SETTINGS);
  close(f.zeroRun, Math.log(4));
  assert.equal(f.fullRun, 0);
  assert.equal(f.startedLast, 0);
  assert.equal(f.played60Last, 0);
  // A run he has played since is over, and a new one has begun.
  const back = minutesFeatures([...history, gw(5, 90, 1)], MID, SETTINGS);
  assert.equal(back.zeroRun, 0);
  close(back.fullRun, Math.log(2));
});

test('where the record has no starts, 60 minutes a fixture stands in for a start', () => {
  // GW1 (90) and GW3 (75 a fixture) count; GW2 (45) and GW4 (50 a fixture) do not.
  const history = [gw(1, 90, null), gw(2, 45, null), gw(3, 150, null, 2), gw(4, 100, null, 2)];
  assert.equal(minutesFeatures(history, MID, SETTINGS).startSeason, 0.5);
});

test('below minHistoryGws there are no features, and the history term grows to the long window', () => {
  const settings = { ...SETTINGS, minHistoryGws: 2 };
  assert.equal(minutesFeatures([gw(1, 90, 1)], MID, settings), null);
  assert.equal(minutesFeatures([], MID, SETTINGS), null);
  assert.equal(minutesFeatures([gw(1, 90, 1), gw(2, 90, 1)], MID, settings).history, 0.5);
});

test('position is three flags against a keeper, and price is in tenths', () => {
  const history = [gw(1, 90, 1)];
  const keeper = minutesFeatures(history, { position: 'GKP', priceTenths: 45 }, SETTINGS);
  assert.deepEqual([keeper.def, keeper.mid, keeper.fwd, keeper.price], [0, 0, 0, 45]);
  const forward = minutesFeatures(history, { position: 'FWD', priceTenths: 105 }, SETTINGS);
  assert.deepEqual([forward.def, forward.mid, forward.fwd, forward.price], [0, 0, 1, 105]);
});

// ─── Selection heads ─────────────────────────────────────────────────────────

const MODEL = {
  appear: { intercept: 1, startShort: 2 },
  start:  { intercept: -2, startShort: 3 },
  p60:    { intercept: -2.5, startShort: 3 },
  // Per head, [a, b] for one and two gameweeks ahead: the logit z reads as a + b z.
  ahead: {
    appear: [[0.5, 0.5], [0, 0.5]],
    start:  [[0, 1], [0, 1]],
    p60:    [[0, 1], [-1, 1]],
  },
};
const logistic = z => 1 / (1 + Math.exp(-z));

test('each head is the logistic of its intercept plus its weighted features', () => {
  const chances = selectionChances({ startShort: 1 }, MODEL);
  close(chances.appear, logistic(3));
  close(chances.start, logistic(1));
  close(chances.p60, logistic(0.5));
});

test('further ahead each head is read through that gameweek\'s recalibration, and past the last through the last', () => {
  const one = selectionChances({ startShort: 1 }, MODEL, 1);
  close(one.appear, logistic(0.5 + (0.5 * 3)));
  close(one.start, logistic(1));
  close(one.p60, logistic(0.5));
  for (const k of [2, 5]) {
    const later = selectionChances({ startShort: 1 }, MODEL, k);
    close(later.appear, logistic(0.5 * 3));
    close(later.p60, logistic(-1 + 0.5));
  }
});

test('a start or a 60-minute game is never likelier than an appearance', () => {
  const chances = selectionChances({ startShort: 0 }, { ...MODEL, appear: { intercept: -3 } });
  assert.equal(chances.start, chances.appear);
  assert.equal(chances.p60, chances.appear);
});

test('a model weighing a feature the record does not give is an error, not a silent zero', () => {
  assert.throws(() => selectionChances({ startShort: 1 }, { ...MODEL, appear: { intercept: 0, rotation: 1 } }),
    /rotation/);
});
