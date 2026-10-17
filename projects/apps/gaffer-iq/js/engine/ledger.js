/**
 * js/engine/ledger.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Two facts FPL's public endpoints never state outright: what the manager paid
 * for each player (which sets his sell price, engine/prices.js → calcSellPrice)
 * and how many free transfers are banked going into the planning gameweek.
 *
 * Inputs are the normalised entry payloads from engine/normalise.js; money is
 * integer TENTHS of a million throughout.
 *
 * See docs/decision-engine-plan.md Phase 1.
 */

import { DECISION_ENGINE } from '../config.js';

// Chips during which FPL neither spends nor accrues free transfers.
const FT_FREEZE_CHIPS = new Set(['wildcard', 'freehit']);

/**
 * Purchase price of every player in the squad, keyed by player id.
 *
 * A player's price is what his most recent purchase cost. A player never bought
 * by transfer has been owned since the squad was built, so he is priced by
 * `initialPriceTenthsOf`; when that is unknown too he is left out, and callers
 * fall back to his current price, flagged estimated.
 *
 * Only buys are read. A Free Hit week's transfers may be listed, but the squad
 * reverts afterwards to players whose latest buy came before that week (or who
 * were never bought), so the latest buy of each CURRENT squad member is right
 * either way - barring the pointless case of selling and re-buying the same
 * player inside the Free Hit week itself.
 *
 * @param {Array<{inId: number, inCostTenths: number, gw: number, time: string}>} transfers
 * @param {number[]} squadIds
 * @param {(playerId: number) => number|null} initialPriceTenthsOf  price of a
 *   player owned since the squad was built, or null when unknown
 * @returns {Map<number, number>}  playerId -> purchase price in tenths
 */
export function buildPurchaseLedger(transfers, squadIds, initialPriceTenthsOf) {
  const latestBuy = new Map();
  for (const t of transfers ?? []) {
    const previous = latestBuy.get(t.inId);
    if (!previous || isLater(t, previous)) latestBuy.set(t.inId, t);
  }

  const ledger = new Map();
  for (const playerId of squadIds ?? []) {
    const price = latestBuy.get(playerId)?.inCostTenths ?? initialPriceTenthsOf(playerId);
    if (Number.isInteger(price)) ledger.set(playerId, price);
  }
  return ledger;
}

/** True when transfer `a` happened after transfer `b`. ISO times sort as text. */
function isLater(a, b) {
  return a.gw !== b.gw ? a.gw > b.gw : String(a.time) > String(b.time);
}

/**
 * Free transfers available for `planningGw`, replayed from the manager's history.
 *
 * Every gameweek before the planning one counts, including a live one: its
 * deadline has passed, so its transfers are spent and its roll-over is banked.
 *
 * MODEL: FPL's rules since 2024/25. The first deadline has unlimited transfers,
 * leaving one free transfer for the next gameweek. After that each gameweek's
 * transfers spend the bank (a hit can only take it to zero), then one more is
 * added, up to DECISION_ENGINE.maxBankedFt. A Wildcard or Free Hit week neither
 * spends nor adds. A one-off top-up FPL may announce mid-season is not in the
 * API, so the result is a pre-fill the user can correct.
 *
 * @param {{ gws: Array<{gw: number, transfers: number}>,
 *           chips: Array<{chip: string, gw: number}> }} history
 * @param {number} planningGw
 * @returns {number|null}  0..maxBankedFt; null when no deadline has passed yet
 *   (transfers into the first gameweek are unlimited, so there is no count)
 */
export function deriveFreeTransfers(history, planningGw) {
  const frozen = new Set((history?.chips ?? [])
    .filter(c => FT_FREEZE_CHIPS.has(c.chip))
    .map(c => c.gw));
  const played = (history?.gws ?? [])
    .filter(g => g.gw < planningGw)
    .sort((a, b) => a.gw - b.gw);

  let freeTransfers = null;
  for (const g of played) {
    if (freeTransfers === null) freeTransfers = 1;
    else if (!frozen.has(g.gw)) {
      freeTransfers = Math.min(DECISION_ENGINE.maxBankedFt,
        Math.max(0, freeTransfers - g.transfers) + 1);
    }
  }
  return freeTransfers;
}
