/**
 * tests/tools/backtest-eval-fixtures.js
 * Hand-built backtest rows for the Phase 4 report (tools/backtest/eval.js, run.js's solverEvalSection): the shape of
 * data/results.json's and data/solver-eval-m<margin>.json's tasks, small enough that every figure in the report can be
 * worked out on paper. Not a test file: the tests and a scratch script that renders the report both import it.
 *
 * A policy's weekly points are its `level` plus the squad's index, so a policy's difference from another is the
 * difference of their levels in every squad and week, and the paired bootstrap of it is a point.
 */

import { DECISION_ENGINE } from '../../js/config.js';

const SEASONS = ['2024-25', '2025-26'];
const MODES = Object.keys(DECISION_ENGINE.modes);
const WEEKS = [4, 5, 6, 7];

/** The week-by-week guard every fake solver run goes through: four weeks, one of each outcome. */
const GUARDS = ['trusted', 'resolved', 'fallback', 'no solve'];

const task = (season, squad, out) => ({ season, schedule: 'asItStood', squad, label: `squad ${squad}`, out, shadow: null, ms: 1 });

/** A run of `level` + squad points a week, `moves` transfers a week and `hits` hit points in the first. */
function fakeRun(level, squad, { moves = 0, hits = 0, metrics = [], counts = null, log = null } = {}) {
  const gws = WEEKS.map((t, i) => ({ t, points: level + squad, hits: i === 0 ? hits : 0, ft: 1, moves, lostFt: false }));
  return { total: gws.reduce((a, g) => a + g.points - g.hits, 0), gws, metrics, counts, log };
}

/** data/results.json's tasks: the previous engine, the baselines and the engine's modes at the given levels. */
export function fakeResults(levels, { squads = 3 } = {}) {
  return SEASONS.flatMap(season => Array.from({ length: squads }, (_, squad) => task(season, squad,
    Object.fromEntries(Object.entries(levels).map(([name, level]) => [name, fakeRun(level, squad, { moves: 1, hits: 2 })])))));
}

/**
 * One fake solver run: every week a move with the next of `robustness` (cycled; null for none that week) and the gain
 * `gain(robustness)`, the weeks going through GUARDS. Its counts are the log's: 2 solves a week at 100 ms, 2 stopped.
 */
export function fakeSolverRun(level, squad, { robustness = [null], gain = () => 0 } = {}) {
  const log = WEEKS.map((t, i) => ({ t, call: 'move', moves: [{ outId: 1, inId: 2 }], source: 'solver',
    guard: GUARDS[i] === 'trusted' || GUARDS[i] === 'resolved' ? GUARDS[i] : 'engine', gap: 0, gain: 1,
    robustness: robustness[(squad + i) % robustness.length] }));
  const metrics = log.map(({ t, robustness: r }) => ({ gw: t, moves: 1, realised: { 1: 0, 3: 0, 5: r === null ? 0 : gain(r) },
    expected: { 1: 0, 3: 0, 5: 0 }, sellRegret: null, free: 1, hit: 0, hits: 0 }));
  const counts = { solves: 2 * WEEKS.length, ms: 100 * 2 * WEEKS.length, stopped: 2, unordered: 0, resolved: 1, twins: 1,
    alternatives: 0, engineFallback: 1, ties: 1, kept: 0 };
  return fakeRun(level, squad, { moves: 1, hits: 2, metrics, counts, log });
}

/**
 * data/solver-eval-m<margin>.json's tasks: each mode's run at `levels[mode]`; `robustness` and `gain` as fakeSolverRun's.
 * Its tasks are the results' (the same seasons, squads and labels).
 */
export function fakeEval(levels, { squads = 3, ...extra } = {}) {
  return SEASONS.flatMap(season => Array.from({ length: squads }, (_, squad) => task(season, squad,
    Object.fromEntries(MODES.map(mode => [`solver:${mode}`, fakeSolverRun(levels[mode], squad, extra)])))));
}
