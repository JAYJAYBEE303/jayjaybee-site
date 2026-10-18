/**
 * tests/tools/minutes.test.js
 * The offline minutes-model tool (tools/minutes, plan Phase 4): reading
 * vaastav's merged_gw.csv, the per-player season index, training rows that
 * hold no future data, the baselines the model is judged against, and the
 * logistic fit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv, seasonData, buildRows, restDays, teamRotation, fitLogistic, brier, logLoss,
} from '../../tools/minutes/lib.js';

// ─── A small season in merged_gw.csv's shape ─────────────────────────────────

const HEADER = 'name,position,team,element,fixture,kickoff_time,minutes,starts,total_points,value,GW';
const DAY = 24 * 60 * 60 * 1000;
const SATURDAY = Date.UTC(2025, 7, 16, 14);

/**
 * One club, a match every Saturday from GW1 to GW8 and a second on the
 * Tuesday of GW5. Per fixture: [gw, minutes, starts, points].
 * Player 1 (MID) starts, misses GW3-4, starts both matches of the double,
 * comes off the bench in GW6, then starts again.
 */
const PLAYER_1 = [[1, 90, 1, 6], [2, 90, 1, 2], [3, 0, 0, 0], [4, 0, 0, 0],
  [5, 90, 1, 6], [5, 60, 1, 3], [6, 30, 0, 1], [7, 90, 1, 2], [8, 90, 1, 12]];

function seasonCsv(mutate = row => row) {
  const lines = [HEADER];
  PLAYER_1.forEach(([gw, minutes, starts, points], i) => {
    const second = i === 5;                      // GW5's Tuesday match
    const fixture = second ? 50 : gw;
    const kickoff = new Date(SATURDAY + ((gw - 1) * 7 * DAY) + (second ? 3 * DAY : 0)).toISOString();
    const rows = [
      { element: 1, position: 'MID', minutes, starts, points },
      { element: 3, position: 'GK', minutes: 90, starts: 1, points: 2 },
      { element: 99, position: 'AM', minutes: 0, starts: 0, points: 3 },
    ];
    for (const row of rows) {
      const r = mutate({ ...row, gw });
      lines.push([`Player ${r.element}`, r.position, 'Alpha', r.element, fixture, kickoff,
        r.minutes, r.starts, r.points, 55, r.gw].join(','));
    }
  });
  return lines.join('\n');
}

const at = (rows, gw, playerId = 1) => rows.find(r => r.playerId === playerId && r.gw === gw);
const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not ${expected}`);

// ─── Reading the data ────────────────────────────────────────────────────────

test('the CSV reader keeps quoted commas and doubled quotes inside a field', () => {
  assert.deepEqual(parseCsv('name,team\r\n"Smith, Jr.",Alpha\r\n"O""Neil",Beta\r\n'),
    [{ name: 'Smith, Jr.', team: 'Alpha' }, { name: 'O"Neil', team: 'Beta' }]);
});

test('a season is indexed per player per gameweek, a double summed, assistant managers dropped', () => {
  const season = seasonData(parseCsv(seasonCsv()));
  const gw5 = season.players.get(1).records.find(r => r.gw === 5);
  assert.deepEqual([gw5.fixtures, gw5.minutes, gw5.starts, gw5.points], [2, 150, 2, 9]);
  assert.equal(season.players.get(1).position, 'MID');
  assert.equal(season.players.get(3).position, 'GKP');
  assert.equal(season.players.has(99), false);
});

// ─── Training rows ───────────────────────────────────────────────────────────

test('rows are single-fixture gameweeks with some history before them', () => {
  // GW1 has no history; GW5 is a double.
  const rows = buildRows(seasonData(parseCsv(seasonCsv())));
  assert.deepEqual(rows.filter(r => r.playerId === 1).map(r => r.gw), [2, 3, 4, 6, 7, 8]);
  const gw6 = at(rows, 6);
  assert.deepEqual([gw6.appear, gw6.start, gw6.p60, gw6.points], [1, 0, 0, 1]);
  close(gw6.features.rest, 4);                  // Tuesday to Saturday
});

test('a row reads nothing from its own gameweek or later except its outcome', () => {
  const blankFrom = from => row => (row.gw >= from ? { ...row, minutes: 0, starts: 0, points: 0 } : row);
  const base = buildRows(seasonData(parseCsv(seasonCsv())));
  const changed = buildRows(seasonData(parseCsv(seasonCsv(blankFrom(6)))));
  assert.deepEqual(at(changed, 6).features, at(base, 6).features);
  assert.deepEqual([at(changed, 6).appear, at(base, 6).appear], [0, 1]);
  assert.notDeepEqual(at(changed, 7).features, at(base, 7).features, 'GW6 is history for GW7');

  // Two gameweeks ahead, the history stops two before the target: GW8 read
  // from GW6 sees what GW6 itself sees, apart from GW8's own rest.
  const ahead = buildRows(seasonData(parseCsv(seasonCsv())), { lead: 2 });
  const aheadChanged = buildRows(seasonData(parseCsv(seasonCsv(blankFrom(6)))), { lead: 2 });
  assert.deepEqual(at(aheadChanged, 8).features, at(ahead, 8).features);
  assert.deepEqual(at(ahead, 8).features, { ...at(base, 6).features, rest: 7 });
});

test('the baselines: his last five gameweeks raw for last-5-starts, the excused record for v1', () => {
  // Before GW7 his last five are GW2-6: started GW2, missed GW3-4, started the
  // double, came off the bench. v1 excuses GW3-4 (two weeks, played since), so
  // its rates are four starts in four gameweeks of contention.
  const gw7 = at(buildRows(seasonData(parseCsv(seasonCsv()))), 7);
  close(gw7.baseline.start, 0.4);
  close(gw7.baseline.appear, 0.6);
  assert.deepEqual(gw7.v1, { appear: 1, start: 1, p60: 1 });
  // Fewer than minContentionGws gameweeks of contention: v1 used the price
  // prior, which the tool does not rebuild.
  assert.equal(at(buildRows(seasonData(parseCsv(seasonCsv()))), 3).v1, null);
});

// ─── Club measures (tested in the fit, not used by the app) ─────────────────

test('rest is the days since his club\'s latest earlier kickoff, and null before its first', () => {
  const kickoffs = ['2025-08-30T14:00:00Z', '2025-08-16T14:00:00Z', '2025-08-23T11:30:00Z'];
  close(restDays(kickoffs, '2025-08-30T14:00:00Z'), 7 + (2.5 / 24));
  assert.equal(restDays(kickoffs, '2025-08-16T14:00:00Z'), null);
});

test('rotation is the share of the XI changed between a club\'s latest gameweeks', () => {
  const xi = ids => new Set(ids);
  const other = xi([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  const a = xi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const b = xi([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13]);   // two changes from a
  // Over the last two changes: a -> b (2) and b -> b (0), not other -> a (11).
  close(teamRotation([other, a, b, b], 2), (2 + 0) / 2 / 11);
  assert.equal(teamRotation([a]), null);
  assert.equal(teamRotation([]), null);
});

// ─── Fit and scores ──────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const logistic = z => 1 / (1 + Math.exp(-z));

function drawn(n, coefficients, random) {
  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const x = [(random() * 2) - 1, (random() * 2) - 1];
    X.push(x);
    y.push(random() < logistic(coefficients[0] + (coefficients[1] * x[0]) + (coefficients[2] * x[1])) ? 1 : 0);
  }
  return { X, y };
}

test('the fit recovers the coefficients its data were drawn from', () => {
  const { X, y } = drawn(20000, [-0.5, 1.5, -2], seeded(7));
  const coefficients = fitLogistic(X, y, { lambda: 0 });
  [-0.5, 1.5, -2].forEach((c, i) => close(coefficients[i], c, 0.1));
});

test('the ridge penalty shrinks the weights but never the intercept', () => {
  const { X, y } = drawn(5000, [0.8, 1, -1], seeded(11));
  const [intercept, ...weights] = fitLogistic(X, y, { lambda: 1e9 });
  for (const w of weights) assert.ok(Math.abs(w) < 1e-4, `weight ${w}`);
  const rate = y.reduce((a, b) => a + b, 0) / y.length;
  close(intercept, Math.log(rate / (1 - rate)), 1e-4);
});

test('Brier and log loss score probabilities against outcomes, log loss clipped off 0 and 1', () => {
  assert.equal(brier([0.5, 1], [1, 1]), 0.125);
  close(logLoss([0.5, 0.5], [1, 0]), Math.log(2));
  close(logLoss([0], [1], 0.01), -Math.log(0.01));
});
