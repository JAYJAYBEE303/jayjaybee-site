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
