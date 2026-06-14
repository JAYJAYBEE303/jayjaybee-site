/**
 * Cheat-engine entry point (Phase 7) — ties the full pipeline together.
 *
 * processCpuTurn(chess, ledger, difficulty) is the single function game.js calls
 * on every CPU (black) turn, INCLUDING when the CPU is checkmated: the rescue
 * branch fires first and gives the engine its chance to cheat out of mate
 * (resolution H) before the player is allowed to win.
 *
 * Pipeline (one cheat per call maximum — enforced structurally):
 *   computeMetrics → [rescue if no legal move] → chooseHonestMove
 *                  → enumerateEligible → selectBest → fireThreshold gate
 *                  → mutate.apply + ledger.spend
 *
 * Pure logic — no DOM, no game.js / board-view.js imports, no console.* of any
 * kind (never leak the rig).
 *
 * Return contract (SPEC.md §7):
 *   { kind: 'honest', move }                          normal legal chess.js move
 *   { kind: 'cheat',  cheatId, fen, notation, diff }  forced mutation (applied)
 *   { kind: 'concede' }                               player wins legitimately
 *
 * ── Phase-7 decisions surfaced (see hand-off notes) ─────────────────────────
 *   • selectBest returns a bare Application with no `.score` field, so the
 *     fireThreshold gate recomputes the winner's score via score() rather than
 *     reading best.score (Phase 5 files are not modified).
 *   • The cheat result adds cheatId explicitly (the spec spread omits it but the
 *     return-type contract requires it).
 *   • Rescue reuses the metrics already computed at the top of processCpuTurn —
 *     computeMetrics is never run twice (resolution H default).
 *   • budgets.js / tuning.js are not runtime-imported: the ledger is injected and
 *     fireThreshold-the-function lives in scoring.js (Phase 5). The ledger shape
 *     is referenced via JSDoc only — no dead imports.
 */

import { computeMetrics }                   from './metrics.js';
import { enumerateEligible }                from './eligibility.js';
import { score, selectBest, fireThreshold } from './scoring.js';
import * as mutate                          from './mutate.js';
import { chooseHonestMove }                 from '../cpu.js';

const CPU_COLOR    = 'b';
const PLAYER_COLOR = 'w';

// Both rescue cheats are PrmtPiece, ctx 'def', single global vehicle pool.
const RESCUE_CATEGORY = 'PrmtPiece';
const RESCUE_CTX      = 'def';
const RESCUE_PIECE    = 'global';

/**
 * Drive one CPU turn end-to-end.
 *
 * @param {import('../../lib/chess.js').Chess} chess  — CPU (black) is to move
 * @param {ReturnType<import('./budgets.js').createLedger>} ledger
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {{kind:'honest', move:object}
 *          | {kind:'cheat', cheatId:string, fen:string, notation:string, diff:Array}
 *          | {kind:'concede'}}
 */
export function processCpuTurn(chess, ledger, difficulty) {
  const metrics = computeMetrics(chess);

  // Rescue branch fires at the START of the turn when the CPU is out of legal
  // moves (checkmate or stalemate) — not as a post-player-move hook (resolution H).
  if (metrics.cpuHasNoLegalMove) {
    return tryRescue(chess, ledger, metrics, difficulty);
  }

  const baseMove     = chooseHonestMove(chess);
  const applications = enumerateEligible(chess, ledger, metrics, difficulty);
  const best         = selectBest(applications, metrics, ledger, difficulty);

  // Intermittency gate (resolution G): fire only if the winner clears the bar.
  // selectBest returns no score, so recompute the winner's score here.
  if (best === null || score(best, metrics, ledger, difficulty) < fireThreshold(difficulty)) {
    return { kind: 'honest', move: baseMove };
  }

  const result = mutate.apply(chess, best);                 // board mutated in place
  ledger.spend(best.cheatId, best.ctx, best.pieceType);     // category budget + piece qty
  return { kind: 'cheat', cheatId: best.cheatId, ...result };
}

/**
 * Rescue branch: try to cheat the CPU out of a no-legal-move position.
 * King replacement is attempted before emergency queen (resolution H).
 * A rescue spends budget ONLY when its mutation actually escapes — a failed
 * attempt is rolled back and costs nothing.
 *
 * @param {import('../../lib/chess.js').Chess} chess
 * @param {ReturnType<import('./budgets.js').createLedger>} ledger
 * @param {import('./metrics.js').Metrics} metrics      reused, not recomputed
 * @param {'easy'|'medium'|'hard'} difficulty           reserved (rescue is difficulty-agnostic)
 * @returns {{kind:'cheat', cheatId:string, fen:string, notation:string, diff:Array}
 *          | {kind:'concede'}}
 */
export function tryRescue(chess, ledger, metrics, difficulty) {
  // 1. King replacement first.
  if (_affordable(ledger, 'king-replacement')) {
    const rescued = _attemptRescue(chess, ledger, 'king-replacement');
    if (rescued) return rescued;
  }

  // 2. Emergency queen — only when the CPU queen is actually gone.
  if (_affordable(ledger, 'emergency-queen') && _cpuQueenGone(chess)) {
    const rescued = _attemptRescue(chess, ledger, 'emergency-queen');
    if (rescued) return rescued;
  }

  // Nothing affordable, or every attempt failed → the player wins fair.
  return { kind: 'concede' };
}

// ── Rescue helpers ──────────────────────────────────────────────────────────

/** A rescue cheat is affordable iff its category budget AND its global qty remain. */
function _affordable(ledger, cheatId) {
  return ledger.categoryBudget(RESCUE_CATEGORY) > 0
      && ledger.qty(cheatId, RESCUE_CTX, RESCUE_PIECE) > 0;
}

/**
 * Apply one rescue cheat atomically.  On success: spend budget, return the cheat
 * result.  On failure: restore the pre-attempt position, spend nothing, return
 * null so the caller can fall through to the next option / concede.
 */
function _attemptRescue(chess, ledger, cheatId) {
  const snapshot = chess.fen();
  const result   = mutate.apply(chess, { cheatId });

  if (_cpuEscaped(chess)) {
    ledger.spend(cheatId, RESCUE_CTX, RESCUE_PIECE);
    return { kind: 'cheat', cheatId, ...result };
  }

  // Failed rescue: roll back, do not spend (resolution H).
  chess.load(snapshot, { skipValidation: true });
  return null;
}

/**
 * Did the CPU escape? After a rescue mutation the player is to move; the CPU has
 * escaped iff its king is no longer attacked (not in check ⇒ not checkmate).
 */
function _cpuEscaped(chess) {
  const king = _findKing(chess, CPU_COLOR);
  return king ? !chess.isAttacked(king, PLAYER_COLOR) : false;
}

/** Scan the live board for a CPU queen (emergency-queen eligibility). */
function _cpuQueenGone(chess) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'q' && cell.color === CPU_COLOR) return false;
    }
  }
  return true;
}

/** Locate the algebraic square of a king of the given colour, or null. */
function _findKing(chess, color) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}
