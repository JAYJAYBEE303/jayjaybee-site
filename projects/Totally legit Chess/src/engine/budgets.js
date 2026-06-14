/**
 * Budget ledger for the cheat engine.
 *
 * Two independent limits are tracked simultaneously (spec §3):
 *   1. Category budget  — shared pool per category, drained by 1 on every cheat fire.
 *   2. Per-piece qty    — max times a specific (cheatId, ctx, pieceType) vehicle can be used.
 *
 * Ledger key:  `${cheatId}:${ctx}:${pieceType}`   (resolution C — shared:no)
 * Global cheats use sentinel pieceType  "global"   (resolution C / spec §3).
 *
 * All budgets and qtys reset on new game only (via reset()).
 */

/** Initial category budgets, spec §2. */
export const CATEGORY_BUDGETS = {
  CanMoveOdd: 5,
  PrmtPiece:  3,
};

/**
 * Build a fresh ledger initialised from the given catalogue array.
 * @param {import('./catalogue.js').Cheat[]} catalogue
 */
export function createLedger(catalogue) {

  // ── State ──────────────────────────────────────────────────────────────────

  /** @type {Record<string, number>} current category budgets */
  const catCurrent = { ...CATEGORY_BUDGETS };

  /** @type {Record<string, number>} immutable initial qty per key */
  const qtyInitialMap = {};
  /** @type {Record<string, number>} mutable current qty per key */
  const qtyCurrent    = {};

  // Populate qty maps from catalogue
  for (const cheat of catalogue) {
    // For 'both' context cheats, atk and def use separate pools (resolution C).
    const ctxKeys = cheat.ctx === 'both' ? ['atk', 'def'] : [cheat.ctx];
    for (const ctx of ctxKeys) {
      for (const [pieceType, initial] of Object.entries(cheat.pieces)) {
        const key = _key(cheat.id, ctx, pieceType);
        qtyInitialMap[key] = initial;
        qtyCurrent[key]    = initial;
      }
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  function _findCheat(cheatId) {
    return catalogue.find(c => c.id === cheatId) ?? null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {

    /** Current remaining budget for a category ('CanMoveOdd' | 'PrmtPiece'). */
    categoryBudget(cat) {
      return catCurrent[cat] ?? 0;
    },

    /** Immutable initial budget for a category (used by scoring for scarcity calc). */
    categoryInitial(cat) {
      return CATEGORY_BUDGETS[cat] ?? 0;
    },

    /**
     * Current remaining qty for a specific vehicle slot.
     * @param {string} cheatId
     * @param {'atk'|'def'} ctx
     * @param {string} pieceType  — piece type letter or 'global'
     */
    qty(cheatId, ctx, pieceType) {
      return qtyCurrent[_key(cheatId, ctx, pieceType)] ?? 0;
    },

    /**
     * Immutable initial qty for a vehicle slot (used by scoring for qtyFactor calc).
     */
    qtyInitial(cheatId, ctx, pieceType) {
      return qtyInitialMap[_key(cheatId, ctx, pieceType)] ?? 0;
    },

    /**
     * Spend one use from the given vehicle slot AND decrement the category budget.
     * Callers (eligibility gates) ensure both values are > 0 before calling.
     */
    spend(cheatId, ctx, pieceType) {
      const qKey = _key(cheatId, ctx, pieceType);
      if ((qtyCurrent[qKey] ?? 0) > 0) {
        qtyCurrent[qKey]--;
      }
      const cheat = _findCheat(cheatId);
      if (cheat && (catCurrent[cheat.category] ?? 0) > 0) {
        catCurrent[cheat.category]--;
      }
    },

    /**
     * Returns true if the cheat can never fire again:
     *   – category budget is 0, OR
     *   – every (ctx, pieceType) vehicle slot has qty 0.
     */
    isCheatLocked(cheatId) {
      const cheat = _findCheat(cheatId);
      if (!cheat) return true;
      if ((catCurrent[cheat.category] ?? 0) <= 0) return true;

      // Check if at least one vehicle slot still has qty > 0
      const ctxKeys = cheat.ctx === 'both' ? ['atk', 'def'] : [cheat.ctx];
      for (const ctx of ctxKeys) {
        for (const pieceType of Object.keys(cheat.pieces)) {
          if ((qtyCurrent[_key(cheat.id, ctx, pieceType)] ?? 0) > 0) return false;
        }
      }
      return true; // all vehicle slots exhausted
    },

    /**
     * Reset all budgets and qtys to their initial values.
     * Called only on new game (spec §3).
     */
    reset() {
      Object.assign(catCurrent, CATEGORY_BUDGETS);
      for (const key of Object.keys(qtyCurrent)) {
        qtyCurrent[key] = qtyInitialMap[key];
      }
    },

  };
}

// ── Module-private helpers ─────────────────────────────────────────────────────

/** Compose the map key string. */
function _key(cheatId, ctx, pieceType) {
  return `${cheatId}:${ctx}:${pieceType}`;
}
