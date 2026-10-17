/**
 * js/engine/feasibility.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Says whether FPL would accept a single transfer: the decision engine only
 * ever scores moves this function lets through.
 *
 * Money is integer TENTHS of a million (50 = £5.0m), and the outgoing player
 * is valued at his SELL price, never his current price (brief §4, §10) - the
 * squad state carries both so the difference cannot be lost on the way in.
 *
 * See docs/decision-engine-plan.md Phase 1.
 */

import { MAX_PER_CLUB } from '../config.js';
import { toTenths } from '../util.js';

/**
 * Check one transfer against FPL's rules.
 *
 * Like-for-like by position, so the squad keeps its 2/5/5/3 shape and a legal
 * formation is always still possible; no more than MAX_PER_CLUB from one club
 * once the outgoing player has left; and the incoming price must fit within the
 * bank plus what the outgoing player sells for.
 *
 * @param {{ bankTenths: number,
 *           players: Array<{ playerId: number, position: string, teamId: number,
 *                            priceTenths: number, sellPriceTenths: number }> }} squadState
 * @param {number} outId    the player being sold
 * @param {Player} inPlayer the normalised player being bought (price in millions)
 * @returns {{ ok: true } | { ok: false,
 *   reason: 'not-in-squad'|'already-owned'|'position'|'club-limit'|'budget' }}
 */
export function checkSwap(squadState, outId, inPlayer) {
  const players = squadState?.players ?? [];
  const out = players.find(p => p.playerId === outId);
  if (!out) return { ok: false, reason: 'not-in-squad' };
  if (players.some(p => p.playerId === inPlayer.id)) return { ok: false, reason: 'already-owned' };
  if (inPlayer.position !== out.position) return { ok: false, reason: 'position' };

  const clubCount = players.filter(p => p.playerId !== outId && p.teamId === inPlayer.teamId).length;
  if (clubCount >= MAX_PER_CLUB) return { ok: false, reason: 'club-limit' };

  if (toTenths(inPlayer.price) > (squadState.bankTenths ?? 0) + out.sellPriceTenths) {
    return { ok: false, reason: 'budget' };
  }
  return { ok: true };
}
