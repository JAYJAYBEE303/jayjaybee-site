/**
 * js/engine/prices.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Predicts imminent FPL price rises and falls from in-GW transfer flow.
 * Inputs come from the normalised Player model (transfersInEvent,
 * transfersOutEvent, ownership) - all already present in bootstrap-static.
 * No new API calls are required.
 * See ROADMAP.md Phase 4-4, ARCHITECTURE.md §8.
 */

import {
  PRICE_MIN_ACTIVITY,
  PRICE_ACTIVITY_SCALE,
  SELL_PROFIT_SHARE,
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
 * absolute activity volume. Predictions are probabilistic - always show
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

  // Scale confidence by absolute volume - a strong net ratio from thin volume
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
    reasoning:  'Equal transfers in and out - no price move predicted.',
  };
}

/**
 * Actual price movement since the season opened - a FACT, not a prediction.
 * The sibling of calcPriceChangeRisk above, and deliberately separate from it:
 * that one forecasts the next move from transfer flow, this one reports the
 * moves already banked. Never merge them.
 *
 * `costChangeStart` arrives in TENTHS of a million (bootstrap-static's
 * cost_change_start), so the divide happens here, once.
 *
 * @param {Player} player  normalised Player (must have costChangeStart)
 * @returns {{ value: number, direction: 'rise'|'fall'|'flat', label: string }}
 *          value is in millions; label is signed and always one decimal place
 *          ("+£0.3m", "-£0.1m", "£0.0m" - no sign at all when flat).
 */
export function calcSeasonPriceChange(player) {
  const tenths = player.costChangeStart ?? 0;

  const direction = tenths > 0 ? 'rise' : tenths < 0 ? 'fall' : 'flat';
  const sign      = tenths > 0 ? '+' : tenths < 0 ? '-' : '';

  // Format from the ABSOLUTE value and prepend the sign, so a fall renders
  // "-£0.1m" rather than "£-0.1m". Zero gets no sign - "+£0.0m" would read as
  // a rise that never happened.
  const label = `${sign}£${(Math.abs(tenths) / 10).toFixed(1)}m`;

  return { value: tenths / 10, direction, label };
}

/**
 * What FPL pays you for a player you sell - not his current price.
 *
 * A seller keeps SELL_PROFIT_SHARE of any rise since purchase, rounded down to
 * £0.1m, and absorbs any fall in full. So a £0.1m rise is worth nothing to the
 * seller and £0.3m is worth £0.1m. Every budget and funds calculation in the
 * decision engine must use this, never the current price (brief §10).
 *
 * Integer TENTHS of a million in and out (50 = £5.0m), so the rounding is
 * exact; a float price is a caller bug and throws rather than rounding wrong.
 *
 * @param {number} purchaseTenths  price paid, in tenths of a million
 * @param {number} currentTenths   price now, in tenths of a million
 * @returns {number}  sell price in tenths of a million, <= max(purchase, current)
 * @throws {TypeError} when either price is not an integer number of tenths
 */
export function calcSellPrice(purchaseTenths, currentTenths) {
  if (!Number.isInteger(purchaseTenths) || !Number.isInteger(currentTenths)) {
    throw new TypeError(
      `calcSellPrice: prices must be integer tenths, got ${purchaseTenths} and ${currentTenths}`);
  }
  if (currentTenths <= purchaseTenths) return currentTenths;
  return purchaseTenths + Math.floor((currentTenths - purchaseTenths) * SELL_PROFIT_SHARE);
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
