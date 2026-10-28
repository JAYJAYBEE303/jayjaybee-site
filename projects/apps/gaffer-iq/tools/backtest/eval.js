/**
 * tools/backtest/eval.js
 * The Phase 4 report's figures (docs/decision-engine-solver-phase4-plan.md, Task 4) as pure functions on the backtest's
 * result rows, so they are tested without running the CLI. run.js lays the words round them; every number in the report
 * comes from data/results.json and data/solver-eval-m<margin>.json through these.
 *
 * A row is a task of either file ({season, schedule, squad, label, out}); withEval lays the eval runs over the results',
 * each under evalName(mode, margin), and the rest takes those rows.
 */

import { PERCENT } from '../../js/config.js';
import { seededRandom } from '../../js/util.js';
import { GAIN_WINDOWS, LOWER_TAIL, UPPER_TAIL } from './lib.js';

/**
 * The robustness buckets, in whole percents as the card shows the figure ("Robust 67%": planner.js rounds it as
 * `percentOf` does): high from `high`, low to `low`, the rest between; under `min` moves in any, terciles instead.
 */
export const BUCKETS = { high: 67, low: 33, min: 30 };
/** A robustness share as the card reads it. */
export const percentOf = share => Math.round(share * PERCENT);
/** A move's gain is its realised gain over this many GWs against rolling: moveMetrics' longest window. */
export const GAIN_WINDOW = Math.max(...GAIN_WINDOWS);
const EVAL_PREFIX = 'solver:';

/** A mode's solver run at a hit margin, as it is named once a margin's file is laid over the results. */
export const evalName = (mode, margin) => `${EVAL_PREFIX}${mode}@${margin}`;
/** The mode of an evalName, or undefined for any other policy. */
export const evalMode = name => name.match(/^solver:(.+)@/)?.[1];

const sum = xs => xs.reduce((a, b) => a + b, 0);
const key = r => `${r.season}|${r.schedule}|${r.squad}`;

/**
 * data/results.json's tasks that a solver-eval file also ran, each with that file's runs laid over under evalName. The
 * files are by margin ({0: tasks | null, 2: ...}; null for one not run). The same squads: a squad index with another
 * label is another file's squad, and throws.
 */
export function withEval(results, byMargin) {
  const files = Object.entries(byMargin).filter(([, tasks]) => tasks)
    .map(([margin, tasks]) => ({ margin, byKey: new Map(tasks.map(r => [key(r), r])) }));
  return results.filter(r => files.some(({ byKey }) => byKey.has(key(r)))).map(r => {
    const out = { ...r.out };
    for (const { margin, byKey } of files) {
      const x = byKey.get(key(r));
      if (!x) continue;
      if (x.label !== r.label) throw new Error(`eval.js: ${key(r)}: data/solver-eval-m${margin}.json's squad is not data/results.json's`);
      for (const [name, run] of Object.entries(x.out)) out[evalName(name.slice(EVAL_PREFIX.length), margin)] = run;
    }
    return { ...r, out };
  });
}

/** The margin with the higher total (2024-25's), the lowest on a tie; `totals` by margin. */
export const defaultMargin = (totals, margins) => [...margins].sort((a, b) => a - b)
  .reduce((best, margin) => (totals[margin] > totals[best] ? margin : best));

/**
 * A mode's pass line, from its paired differences ({mean, lo, hi}, pairedBootstrap's) on the held-out season: it beats
 * the previous engine with the interval above zero, and is not clearly worse than Long term (the interval not wholly
 * below zero). No pairing, no pass.
 */
export function passLine(vsOld, vsLongterm) {
  const beatsOld = Boolean(vsOld) && vsOld.lo > 0;
  const notWorse = Boolean(vsLongterm) && !(vsLongterm.hi < 0);
  return { beatsOld, notWorse, pass: beatsOld && notWorse };
}

// ─── Robustness ──────────────────────────────────────────────────────────────

/**
 * A task's settled first moves that have a robustness figure, in the named runs: each with the gain that week's
 * moveMetrics gives it - realised over five GWs against keeping the squad, the week's hits already off - matched to the
 * log's week by GW.
 */
export function robustMoves(row, names) {
  return names.flatMap(name => {
    const { log, metrics } = row.out[name];
    return log.filter(week => week.robustness !== null).map(week => {
      const made = metrics.find(m => m.gw === week.t);
      if (!made) throw new Error(`eval.js: ${key(row)}: ${name} has a robustness figure at GW${week.t} but no move in its metrics`);
      const gain = made.realised[GAIN_WINDOW];
      if (gain === undefined) throw new Error(`eval.js: ${key(row)}: ${name} has no realised gain over ${GAIN_WINDOW} GWs at GW${week.t}`);
      return { robustness: week.robustness, gain };
    });
  });
}

/**
 * Each move with its bucket ('high' | 'middle' | 'low'), on its robustness as a whole percent (`percentOf`, the card's), cut
 * at BUCKETS' thresholds; if any bucket holds fewer than BUCKETS.min moves, at terciles of the percents instead (low: up to
 * the lowest third's top figure, high: from the highest third's bottom, so equal figures are never split). `rule` says
 * which ('tied' when so many figures share one value that both tercile cuts land on it, and the thresholds stand);
 * `cuts` are the percents a move is low at or below, and high at or above; `atThresholds` (terciles or tied) is the count
 * in each bucket at the thresholds that sent it there.
 */
export function bucketMoves(moves) {
  const place = cuts => moves.map(m => {
    const percent = percentOf(m.robustness);
    return { ...m, bucket: percent <= cuts.low ? 'low' : percent >= cuts.high ? 'high' : 'middle' };
  });
  if (!moves.length) return { rule: 'thresholds', moves: [] };
  const thresholds = place(BUCKETS);
  const atThresholds = Object.fromEntries(['high', 'middle', 'low'].map(b => [b, thresholds.filter(m => m.bucket === b).length]));
  if (Object.values(atThresholds).every(n => n >= BUCKETS.min)) {
    return { rule: 'thresholds', cuts: { low: BUCKETS.low, high: BUCKETS.high }, moves: thresholds };
  }
  const sorted = moves.map(m => percentOf(m.robustness)).sort((a, b) => a - b);
  const third = Math.ceil(sorted.length / 3);
  const cuts = { low: sorted[third - 1], high: sorted[sorted.length - third] };
  // Over a third of the figures on one value puts both cuts on it, so terciles cannot split them: the thresholds stand.
  if (cuts.low >= cuts.high) return { rule: 'tied', cuts: { low: BUCKETS.low, high: BUCKETS.high }, atThresholds, moves: thresholds };
  return { rule: 'terciles', cuts, atThresholds, moves: place(cuts) };
}

/**
 * High's mean gain less low's, with a 95% interval from resampling whole squads: each draw resamples every season's
 * squads with replacement (a squad takes all its moves along), pools the drawn squads' moves and takes the difference of
 * the buckets' means. A draw that leaves either bucket empty is drawn again, never counted as zero. NaN throughout when
 * the moves hold no high or no low.
 *
 * @param {Array<Array<Array<{bucket: string, gain: number}>>>} strata  per season, per squad, its moves
 * @param {{draws: number, seed: number}} boot
 */
export function bucketGap(strata, { draws, seed }) {
  const gapOf = squads => {
    const tally = { high: [], low: [] };
    for (const move of squads.flat()) tally[move.bucket]?.push(move.gain);
    return tally.high.length && tally.low.length ? sum(tally.high) / tally.high.length - sum(tally.low) / tally.low.length : null;
  };
  const observed = gapOf(strata.flat());
  if (observed === null) return { mean: NaN, lo: NaN, hi: NaN };
  const random = seededRandom(seed);
  const gaps = [];
  while (gaps.length < draws) {
    const gap = gapOf(strata.flatMap(squads => squads.map(() => squads[Math.floor(random() * squads.length)])));
    if (gap !== null) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return { mean: observed, lo: gaps[Math.floor(LOWER_TAIL * draws)], hi: gaps[Math.ceil(UPPER_TAIL * draws) - 1] };
}

/** The robustness pass: high's mean above low's, and the interval of the difference not wholly below zero. */
export const robustnessPasses = gap => gap.mean > 0 && !(gap.hi < 0);

// ─── The guard ───────────────────────────────────────────────────────────────

/**
 * What the guard did over some runs ({log, counts}, modePolicy's): their weeks split into those the first solve was
 * trusted (`trusted`), a longer solve was (`resolved`), the engine's move was kept after a solve (`fallback`) and those
 * with no solve at all (`noSolve`: no weeks to weigh, or Ceiling in a big week); and the weeks that settled to a roll as
 * a tie with rolling (`ties`) or a wait that sold a kept player (`kept`), the first picks that were short of their
 * bound and so solved again (`reSolved`), the solves of every kind, those that `stopped` at their limit, and the `ms` they
 * took.
 */
export function guardTotals(runs) {
  const weeks = runs.flatMap(run => run.log);
  const counted = k => sum(runs.map(run => run.counts[k]));
  const fallback = counted('engineFallback');
  return {
    weeks: weeks.length,
    trusted: weeks.filter(w => w.guard === 'trusted').length,
    resolved: weeks.filter(w => w.guard === 'resolved').length,
    fallback,
    noSolve: weeks.filter(w => w.guard === 'engine').length - fallback,
    ties: counted('ties'),
    kept: counted('kept'),
    reSolved: counted('resolved'),
    solves: counted('solves'),
    stopped: counted('stopped'),
    ms: counted('ms'),
  };
}
