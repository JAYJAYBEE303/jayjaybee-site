/**
 * js/engine/prices.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Predicts imminent FPL price rises and falls from in-GW transfer flow.
 * Inputs come from the normalised Player model (transfersInEvent,
 * transfersOutEvent, ownership) — all already present in bootstrap-static.
 * No new API calls are required.
 * See ROADMAP.md Phase 4-4, ARCHITECTURE.md §8.
 */

import {
  PRICE_MIN_ACTIVITY,
  PRICE_ACTIVITY_SCALE,
} from '../config.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a price-change risk signal for one player.
 *
 * Direction is determined by which way in-GW net transfers are flowing;
 * confidence (0–1) is a product of how one-sided the flow is and how much
 * total transfer activity there has been this GW.
 *
 * MODEL: FPL raises a price when net transfers in exceed roughly 2% of current
 * owners. We do not know total FPL team count, so we use the ratio of net
 * to total in-GW activity as the primary signal and scale confidence by
 * absolute activity volume. Predictions are probabilistic — always show
 * confidence, never present as certain.
 *
 * @param {Player} player  normalised Player (must have transfersInEvent,
 *                         transfersOutEvent, ownership)
 * @returns {{ direction: 'rise'|'fall'|'stable', confidence: number, reasoning: string }}
 *          confidence is 0–1, higher = stronger signal
 */
export function calcPriceChangeRisk(player) {
  const transfersIn  = player.transfersInEvent  ?? 0;
  const transfersOut = player.transfersOutEvent ?? 0;
  const net      = transfersIn - transfersOut;
  const activity = transfersIn + transfersOut;

  if (activity < PRICE_MIN_ACTIVITY) {
    return {
      direction:  'stable',
      confidence: 0,
      reasoning:  'Insufficient transfer activity this GW to predict a price move.',
    };
  }

  // How one-sided the activity is: 0 = perfectly split, 1 = entirely one direction.
  const netRatio = Math.abs(net) / activity;

  // Scale confidence by absolute volume — a strong net ratio from thin volume
  // (e.g. 600 in vs 400 out early in the GW) is much less reliable than the
  // same ratio at 60k vs 40k. Cap at 1.
  const activityFactor = Math.min(1, activity / PRICE_ACTIVITY_SCALE);
  const confidence = parseFloat((netRatio * activityFactor).toFixed(3));

  if (net > 0) {
    return {
      direction:  'rise',
      confidence,
      reasoning: _reasonRise(transfersIn, transfersOut, player.ownership ?? 0),
    };
  }

  if (net < 0) {
    return {
      direction:  'fall',
      confidence,
      reasoning: _reasonFall(transfersIn, transfersOut, player.ownership ?? 0),
    };
  }

  return {
    direction:  'stable',
    confidence: 0,
    reasoning:  'Equal transfers in and out — no price move predicted.',
  };
}

/**
 * Return players most likely to rise, sorted by confidence descending.
 * @param {Player[]} players
 * @returns {Array<{ player: Player, priceRisk: ReturnType<calcPriceChangeRisk> }>}
 */
export function rankByPriceRise(players) {
  return players
    .map(player => ({ player, priceRisk: calcPriceChangeRisk(player) }))
    .filter(({ priceRisk }) => priceRisk.direction === 'rise')
    .sort((a, b) => b.priceRisk.confidence - a.priceRisk.confidence);
}

/**
 * Return players most likely to fall, sorted by confidence descending.
 * @param {Player[]} players
 * @returns {Array<{ player: Player, priceRisk: ReturnType<calcPriceChangeRisk> }>}
 */
export function rankByPriceFall(players) {
  return players
    .map(player => ({ player, priceRisk: calcPriceChangeRisk(player) }))
    .filter(({ priceRisk }) => priceRisk.direction === 'fall')
    .sort((a, b) => b.priceRisk.confidence - a.priceRisk.confidence);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _reasonRise(transfersIn, transfersOut, ownership) {
  const pct = ((transfersIn / (transfersIn + transfersOut)) * 100).toFixed(0);
  return `${pct}% of this week's transfer activity is IN (${_fmtK(transfersIn)} in, ${_fmtK(transfersOut)} out). Owned by ${ownership.toFixed(1)}%.`;
}

function _reasonFall(transfersIn, transfersOut, ownership) {
  const pct = ((transfersOut / (transfersIn + transfersOut)) * 100).toFixed(0);
  return `${pct}% of this week's transfer activity is OUT (${_fmtK(transfersIn)} in, ${_fmtK(transfersOut)} out). Owned by ${ownership.toFixed(1)}%.`;
}

/** Format large integers as "127k" or "1.2M" for concise display. */
function _fmtK(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1000)}k`;
  return String(n);
}
