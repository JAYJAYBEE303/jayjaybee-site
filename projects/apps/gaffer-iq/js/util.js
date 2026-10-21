/**
 * js/util.js
 * Layer: utilities (pure). No DOM, no network, no store mutation.
 * Math helpers, formatting, and array operations used across the codebase.
 * Every export must be a pure function (same input → same output).
 */

/**
 * @param {number} min  lower bound (inclusive)
 * @param {number} max  upper bound (inclusive)
 * @param {number} x
 * @returns {number}    x clamped into [min, max]
 */
export function clamp(min, max, x) {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

/**
 * Linear min–max normalisation onto a 0–100 scale, with clamping.
 * Returns 50 (neutral) when the input range collapses (max === min).
 * @param {number} x
 * @param {number} min  raw value mapped to 0
 * @param {number} max  raw value mapped to 100
 * @returns {number}    0–100; higher input → higher output. Direction: linear ascending.
 */
export function normaliseLinear(x, min, max) {
  if (max === min) return 50;
  return clamp(0, 100, ((x - min) / (max - min)) * 100);
}

/**
 * @param {number} score 0–100
 * @returns {number}     100 − score; flips direction so "higher = worse" inputs become
 *                       "higher = better" before they enter the composite.
 */
export function invert(score) {
  return 100 - score;
}

/**
 * Weighted arithmetic mean.
 * @param {number[]} values
 * @param {number[]} weights  parallel to values; need not sum to 1
 * @returns {number}          weighted mean, or NaN when total weight is 0
 */
export function weightedMean(values, weights) {
  let sum = 0;
  let totalW = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i] ?? 0;
    sum += values[i] * w;
    totalW += w;
  }
  return totalW === 0 ? NaN : sum / totalW;
}

/**
 * @param {number[]} values
 * @returns {number}  arithmetic mean, or NaN when empty
 */
export function mean(values) {
  if (!values.length) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * Division guarded against divide-by-zero (returns the fallback rather than NaN/Infinity).
 * @param {number} a
 * @param {number} b
 * @param {number} [fallback=0]
 */
export function safeDiv(a, b, fallback = 0) {
  return b === 0 ? fallback : a / b;
}

/**
 * Group array items by a key extractor, into a plain object keyed by the extracted value.
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => string | number} keyFn
 * @returns {Object<string, T[]>}
 */
export function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] ||= []).push(item);
  }
  return out;
}

/**
 * A price in millions (the normalised Player.price, e.g. 5.5) as integer tenths
 * of a million (55) - the unit FPL itself uses and the one money arithmetic in
 * the decision engine runs in, so rounding never drifts.
 * @param {number} millions
 * @returns {number} integer tenths
 */
export function toTenths(millions) {
  return Math.round(millions * 10);
}

/**
 * Integer tenths of a million back to millions (55 -> 5.5), for funds terms
 * and display.
 * @param {number} tenths
 * @returns {number} millions
 */
export function fromTenths(tenths) {
  return tenths / 10;
}

/**
 * An integer seed for one named stream of draws (FNV-1a over its parts), so
 * each entity's draws depend on the run's seed and its own name only - never
 * on what else is drawn alongside it.
 * @param {...(number|string)} parts
 * @returns {number}
 */
export function streamSeed(...parts) {
  let h = 2166136261;
  for (const c of parts.join('|')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h | 0;
}

/**
 * A seeded pseudo-random generator (mulberry32): the same seed gives the same
 * sequence, so a noisy computation repeats exactly.
 * @param {number} seed  any integer
 * @returns {() => number}  uniform in [0, 1)
 */
export function seededRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A standard normal deviate (Box-Muller) from a uniform generator.
 * @param {() => number} random  uniform in [0, 1)
 * @returns {number}  mean 0, standard deviation 1
 */
export function normalDeviate(random) {
  const u = 1 - random();   // in (0, 1], so the log is finite
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Probability mass below which a count's sums stop: far past anything one match produces. */
const COUNT_TAIL = 1e-12;

/**
 * E[floor(X / divisor)] for X ~ Poisson(lambda): the points from a count paid
 * per `divisor` (goals conceded, saves). For the small means of one match.
 */
export function poissonFloorMean(lambda, divisor) {
  if (!(lambda > 0)) return 0;
  let p = Math.exp(-lambda);
  let mean = 0;
  for (let k = 0; k <= lambda || p > COUNT_TAIL; k++) {
    mean += p * Math.floor(k / divisor);
    p *= lambda / (k + 1);
  }
  return mean;
}

/**
 * P(X >= threshold) for a negative binomial count with this mean and
 * dispersion (the "size": variance = mean + mean^2 / dispersion); an infinite
 * dispersion is the Poisson count.
 */
export function negativeBinomialTail(mean, dispersion, threshold) {
  if (threshold <= 0) return 1;
  if (!(mean > 0)) return 0;
  const poisson = !Number.isFinite(dispersion);
  const keep = poisson ? 0 : dispersion / (dispersion + mean);
  let p = poisson ? Math.exp(-mean) : keep ** dispersion;
  let below = 0;
  for (let k = 0; k < threshold; k++) {
    below += p;
    p *= poisson ? mean / (k + 1) : ((k + dispersion) / (k + 1)) * (1 - keep);
  }
  return Math.max(0, 1 - below);
}
