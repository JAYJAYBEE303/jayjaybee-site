/**
 * Board metrics computed on the CPU's turn.
 *
 * computeMetrics(chess) must be called when chess.turn() === 'b' (CPU is black).
 *
 * Threat detection uses the "turn-flip" method (SPEC.md §5):
 *   take the current FEN, swap the active-colour field to the player's colour,
 *   clear en-passant, load into a scratch Chess with {skipValidation:true},
 *   generate all player moves, and collect every move that captures a CPU piece.
 *   A CPU piece is endangered if attacked AND (undefended OR attacker < victim).
 *   King in check short-circuits to threatLevel 100 automatically.
 */

import { Chess } from '../../lib/chess.js';

/** Authoritative material values (SPEC.md resolution I). */
export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

const CPU_COLOR    = 'b';
const PLAYER_COLOR = 'w';

/**
 * @typedef {{ square: string, pieceType: string, value: number }} Threat
 *
 * @typedef {{
 *   cpuMaterial:       number,
 *   playerMaterial:    number,
 *   boardAdvantage:    number,
 *   threats:           Threat[],
 *   threatLevel:       number,
 *   context:           'atk'|'def',
 *   cpuHasNoLegalMove: boolean,
 * }} Metrics
 */

/**
 * Compute board metrics on the CPU's turn.
 * @param {import('../../lib/chess.js').Chess} chess
 * @returns {Metrics}
 */
export function computeMetrics(chess) {
  // ── Material ──────────────────────────────────────────────────────────────
  let cpuMaterial = 0, playerMaterial = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const v = PIECE_VALUES[piece.type] ?? 0;
      if (piece.color === CPU_COLOR) cpuMaterial    += v;
      else                           playerMaterial += v;
    }
  }

  // ── No-legal-move flag ────────────────────────────────────────────────────
  // chess.moves() respects chess.turn() — must be called on the CPU's turn.
  const cpuHasNoLegalMove = chess.moves().length === 0;

  // ── Threats ───────────────────────────────────────────────────────────────
  const threats     = _detectThreats(chess);
  const threatLevel = threats.reduce((max, t) => Math.max(max, t.value), 0);

  return {
    cpuMaterial,
    playerMaterial,
    boardAdvantage:    cpuMaterial - playerMaterial,
    threats,
    threatLevel,
    context:           threatLevel > 0 ? 'def' : 'atk',
    cpuHasNoLegalMove,
  };
}

// ── Threat detection ──────────────────────────────────────────────────────────

function _detectThreats(chess) {
  // King in check = automatic threatLevel 100 (SPEC.md §5).
  if (chess.inCheck()) {
    const sq = _findKing(chess, CPU_COLOR);
    return sq ? [{ square: sq, pieceType: 'k', value: PIECE_VALUES.k }] : [];
  }

  // Turn-flip: swap active colour to player, clear en-passant.
  const flip1 = new Chess();
  flip1.load(_flipToPlayer(chess.fen()), { skipValidation: true });
  const playerMoves = flip1.moves({ verbose: true });

  // Build attack map: target square → cheapest attacker value.
  const attackMap = new Map(); // sq -> lowestAttackerValue
  for (const m of playerMoves) {
    if (!m.captured) continue;
    const aVal = PIECE_VALUES[m.piece] ?? 0;
    const prev = attackMap.get(m.to);
    if (prev === undefined || aVal < prev) attackMap.set(m.to, aVal);
  }

  const threats = [];

  for (const [sq, lowestAtkVal] of attackMap) {
    const cpuPiece = chess.get(sq);
    if (!cpuPiece || cpuPiece.color !== CPU_COLOR) continue;

    const victimVal = PIECE_VALUES[cpuPiece.type] ?? 0;

    // Profitable capture: attacker gains material even if recaptured.
    if (lowestAtkVal < victimVal) {
      threats.push({ square: sq, pieceType: cpuPiece.type, value: victimVal });
      continue;
    }

    // Equal or losing trade: only dangerous if the piece is undefended.
    if (!_isDefended(chess, sq)) {
      threats.push({ square: sq, pieceType: cpuPiece.type, value: victimVal });
    }
  }

  return threats;
}

/**
 * Is the CPU piece on targetSq defended (can a CPU piece recapture after player captures)?
 *
 * Simulates the capture: removes the CPU piece, places a player sentinel on the square,
 * then checks whether any CPU move can land on that square (recapture).
 */
function _isDefended(chess, targetSq) {
  const scratch = new Chess();
  scratch.load(chess.fen(), { skipValidation: true });
  scratch.remove(targetSq);                                   // remove CPU piece
  scratch.put({ type: 'p', color: PLAYER_COLOR }, targetSq); // player sentinel

  // Reload via FEN to ensure a clean internal state.
  // Active colour remains 'b' (CPU's turn) — unchanged by put/remove.
  scratch.load(scratch.fen(), { skipValidation: true });

  // Any CPU move that lands on targetSq = recapture = defended.
  return scratch.moves({ verbose: true }).some(m => m.to === targetSq);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Swap active colour to player and clear en-passant in a FEN string. */
function _flipToPlayer(fen) {
  const parts = fen.split(' ');
  parts[1] = PLAYER_COLOR; // active colour → player
  parts[3] = '-';           // clear en-passant (SPEC.md §5)
  return parts.join(' ');
}

/** Find the algebraic square of a king of the given colour. */
function _findKing(chess, color) {
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.type === 'k' && p.color === color) {
        return String.fromCharCode('a'.charCodeAt(0) + f) + (8 - r);
      }
    }
  }
  return null;
}
