/**
 * js/engine/price-adapter.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * The one reader of FPL's 2026/27 price-change predictor (brief §7 Phase 5;
 * docs/decision-engine-plan.md Phase 5). Its fields are undocumented, so a
 * change to them breaks this file alone. Where they are missing, or FPL is
 * still calibrating a player, the transfer-flow estimate
 * (engine/prices.js calcPriceChangeRisk) stands in, flagged.
 *
 * Read from bootstrap-static (normalise.js passes them through as priceFeed):
 * price_change_percent is his progress towards a price change, signed (rise
 * positive), where 100 makes the change; price_change_projections gives the
 * progress FPL projects at its next updates ({ offset, projected_percent,
 * likelihood }, likelihood being a coarse band of the projected percent).
 */

import { PERCENT } from '../config.js';
import { clamp } from '../util.js';
import { calcPriceChangeRisk } from './prices.js';

/**
 * His chances of a price fall and of a rise within the predictor's window:
 * the furthest progress towards each that FPL projects by its last update, as
 * a share of the threshold - 1 when a change is projected.
 *
 * @param {Player} player  normalised (priceFeed, and the transfer counts the estimate reads)
 * @returns {{fall: number, rise: number, source: 'fpl'|'estimate'}}  chances 0-1
 */
export function priceSignal(player) {
  const feed = player.priceFeed;
  const progress = feed && feed.price_change_calibrating !== true ? projectedProgress(feed) : [];
  if (progress.length > 0) {
    return {
      fall:   chance(-Math.min(...progress) / PERCENT),
      rise:   chance(Math.max(...progress) / PERCENT),
      source: 'fpl',
    };
  }
  const risk = calcPriceChangeRisk(player);
  return {
    fall:   risk.direction === 'fall' ? risk.confidence : 0,
    rise:   risk.direction === 'rise' ? risk.confidence : 0,
    source: 'estimate',
  };
}

/** priceSignal for every player, keyed by id: the decision engine's priceSignals input. */
export function priceSignals(players) {
  return Object.fromEntries(players.map(p => [p.id, priceSignal(p)]));
}

/** A share of the threshold as a chance, 0-1; FPL's "-0.0" gives 0, not -0. */
const chance = share => clamp(0, 1, share) || 0;

/** The progress FPL projects at each update it gives, or his current progress alone. */
function projectedProgress(feed) {
  const projections = Array.isArray(feed.price_change_projections) ? feed.price_change_projections : [];
  const projected = projections.map(p => Number.parseFloat(p?.projected_percent)).filter(Number.isFinite);
  if (projected.length > 0) return projected;
  const now = Number.parseFloat(feed.price_change_percent);
  return Number.isFinite(now) ? [now] : [];
}
