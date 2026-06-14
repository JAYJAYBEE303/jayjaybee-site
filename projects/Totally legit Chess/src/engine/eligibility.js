/**
 * Eligibility gate filter — Phase 4.
 *
 * enumerateEligible(chess, ledger, metrics, difficulty) expands the cheat
 * catalogue into concrete Applications, one per (cheat, vehicle piece instance,
 * candidate target square), keeping only those passing all six gates from
 * SPEC.md §4.
 *
 * Gates (applied in order — first failure short-circuits):
 *   1. ledger.categoryBudget(cheat.category) > 0
 *   2. ledger.qty(cheat.id, effectiveCtx, pieceType) > 0
 *   3. cheat.ctx matches metrics.context (or cheat.ctx === 'both')
 *   4. atk cheats: metrics.boardAdvantage ≤ effective MxBen
 *   5. def cheats: metrics.threatLevel ≥ effective MnThrt
 *   6. canCheck guard: if cheat.canCheck === false, drop any target that
 *      would deliver check to the player's king
 */

import { CATALOGUE } from './catalogue.js';
import { Chess }     from '../../lib/chess.js';

const CPU_COLOR    = 'b';
const PLAYER_COLOR = 'w';

/**
 * @typedef {{
 *   cheatId:          string,
 *   category:         string,
 *   ctx:              'atk'|'def',
 *   pieceType:        string,
 *   fromSquare:       string,
 *   toSquare:         string,
 *   effectiveSbtlRnk: number,
 *   effectiveAdv:     number,
 * }} Application
 */

/**
 * Enumerate all eligible cheat applications for the current position.
 *
 * @param {import('../../lib/chess.js').Chess} chess
 * @param {ReturnType<import('./budgets.js').createLedger>} ledger
 * @param {import('./metrics.js').Metrics} metrics
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {Application[]}
 */
export function enumerateEligible(chess, ledger, metrics, difficulty) {
  const applications = [];
  const board = chess.board();

  for (const cheat of CATALOGUE) {
    // Rescue-branch cheats (emergency-queen, king-replacement) are handled by
    // tryRescue, not here.
    if (cheat.trigger) continue;

    // Gate 1: category budget > 0.
    if (ledger.categoryBudget(cheat.category) <= 0) continue;

    // Gate 3: context matches (resolution F).
    const ctx = metrics.context; // 'atk' | 'def'
    if (cheat.ctx !== 'both' && cheat.ctx !== ctx) continue;

    // For 'both' cheats, the effective context is the current turn's context
    // (resolution E — selects the correct byCtx block).
    const effectiveCtx = cheat.ctx === 'both' ? ctx : cheat.ctx;

    // Resolve sbtlRnk, adv, threshold for the effective context.
    let effectiveSbtlRnk, effectiveAdv, threshold;
    if (cheat.byCtx) {
      const ctxData    = cheat.byCtx[effectiveCtx];
      effectiveSbtlRnk = ctxData.sbtlRnk;
      effectiveAdv     = ctxData.adv;
      threshold        = ctxData.threshold;
    } else {
      effectiveSbtlRnk = cheat.sbtlRnk;
      effectiveAdv     = cheat.adv;
      threshold        = cheat.threshold;
    }

    // Apply difficulty modifiers to threshold values (SPEC.md §4).
    const adjThreshold = _applyDifficultyToThreshold(threshold, difficulty);

    // Gate 4 (atk cheats): boardAdvantage ≤ MxBen.
    if (effectiveCtx === 'atk' && adjThreshold?.type === 'MxBen') {
      if (metrics.boardAdvantage > adjThreshold.value) continue;
    }

    // Gate 5 (def cheats): threatLevel ≥ MnThrt.
    if (effectiveCtx === 'def' && adjThreshold?.type === 'MnThrt') {
      if (metrics.threatLevel < adjThreshold.value) continue;
    }

    // Expand into per-vehicle-piece applications.
    // Global cheats share one qty pool keyed by 'global'; non-global cheats use
    // separate pools per piece type (resolution C).
    const isGlobal = 'global' in cheat.pieces;

    if (isGlobal) {
      // Gate 2: global qty > 0.
      if (ledger.qty(cheat.id, effectiveCtx, 'global') <= 0) continue;

      // vehiclePieces lists which CPU piece types may be the physical vehicle.
      const vehicleSquares = _findPieceSquares(board, cheat.vehiclePieces ?? [], CPU_COLOR);

      for (const fromSquare of vehicleSquares) {
        const piece   = chess.get(fromSquare);
        const targets = _enumerateTargets(cheat, piece, fromSquare, board);

        for (const toSquare of targets) {
          // A cheated move must never capture the player's king. canCheck:true
          // cheats skip the check guard below, so enforce no-king-capture here too.
          const occ = chess.get(toSquare);
          if (occ?.type === 'k' && occ.color === PLAYER_COLOR) continue;
          // Gate 6: canCheck guard (resolution D).
          if (!cheat.canCheck && _wouldDeliverCheck(chess, piece, fromSquare, toSquare)) continue;

          applications.push({
            cheatId:          cheat.id,
            category:         cheat.category,
            ctx:              effectiveCtx,
            pieceType:        'global',
            fromSquare,
            toSquare,
            effectiveSbtlRnk,
            effectiveAdv,
          });
        }
      }

    } else {
      // Non-global: each piece type has its own qty pool.
      for (const [pieceType] of Object.entries(cheat.pieces)) {
        // Gate 2: per-(cheat, effectiveCtx, pieceType) qty > 0.
        if (ledger.qty(cheat.id, effectiveCtx, pieceType) <= 0) continue;

        const pieceSquares = _findPieceSquares(board, [pieceType], CPU_COLOR);

        for (const fromSquare of pieceSquares) {
          const piece   = chess.get(fromSquare);
          const targets = _enumerateTargets(cheat, piece, fromSquare, board);

          for (const toSquare of targets) {
            // A cheated move must never capture the player's king. canCheck:true
            // cheats skip the check guard below, so enforce no-king-capture here too.
            const occ = chess.get(toSquare);
            if (occ?.type === 'k' && occ.color === PLAYER_COLOR) continue;
            // Gate 6: canCheck guard (resolution D).
            if (!cheat.canCheck && _wouldDeliverCheck(chess, piece, fromSquare, toSquare)) continue;

            applications.push({
              cheatId:          cheat.id,
              category:         cheat.category,
              ctx:              effectiveCtx,
              pieceType,
              fromSquare,
              toSquare,
              effectiveSbtlRnk,
              effectiveAdv,
            });
          }
        }
      }
    }
  }

  return applications;
}

// ── Difficulty modifier ───────────────────────────────────────────────────────

/**
 * Apply easy/hard difficulty modifiers to a threshold object.
 * Returns a new object — never mutates catalogue data.
 *
 * Modifiers (SPEC.md §4): MxBen +1, MnThrt -1 for easy and hard.
 * Medium: no change.
 */
function _applyDifficultyToThreshold(threshold, difficulty) {
  if (!threshold || difficulty === 'medium') return threshold;
  if (threshold.type === 'MxBen')  return { type: 'MxBen',  value: threshold.value + 1 };
  if (threshold.type === 'MnThrt') return { type: 'MnThrt', value: threshold.value - 1 };
  return threshold;
}

// ── Target enumeration ────────────────────────────────────────────────────────

/**
 * Enumerate candidate target squares for a cheat applied to a specific piece.
 * Geometry is determined by the cheat id, not the piece's normal movement.
 */
function _enumerateTargets(cheat, piece, fromSquare, board) {
  switch (cheat.id) {
    case 'adjacent-landing':   return _adjacentSquares(fromSquare, board);
    case 'move-like-bishop':   return _diagonalRays(fromSquare, board);
    case 'move-like-rook':     return _rankFileRays(fromSquare, board);
    case 'move-like-knight':   return _knightSquares(fromSquare, board);
    case 'move-like-king':     return _adjacentSquares(fromSquare, board);
    // Illegal castle: vehicle slides along ranks/files (castling is a horizontal move).
    case 'illegal-castle':     return _rankFileRays(fromSquare, board);
    // Capture reversal: teleport to any square held by a player piece.
    case 'capture-reversal':   return _playerPieceSquares(board);
    // Ghost piece: a copy of the vehicle appears on any empty square.
    case 'ghost-piece':        return _emptySquares(board);
    // Mid-move promotion: piece moves then promotes to a queen mid-board.
    case 'mid-move-promotion': return _midMovePromotionTargets(fromSquare, piece, board);
    default:                   return [];
  }
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

// col: 'a'=0 .. 'h'=7
function _col(sq) { return sq.charCodeAt(0) - 97; }
// row: rank 8→0, rank 1→7  (matches chess.board() indexing)
function _row(sq) { return 8 - parseInt(sq[1], 10); }
// Convert (col, row) back to algebraic notation.
function _toSq(col, row) { return String.fromCharCode(97 + col) + (8 - row); }

// ── Geometric target sets ─────────────────────────────────────────────────────

/** 8 surrounding squares; excludes own-colour pieces. */
function _adjacentSquares(fromSq, board) {
  const col = _col(fromSq), row = _row(fromSq);
  const targets = [];
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      const c = col + dc, r = row + dr;
      if (c < 0 || c > 7 || r < 0 || r > 7) continue;
      if (board[r][c]?.color === CPU_COLOR) continue;
      targets.push(_toSq(c, r));
    }
  }
  return targets;
}

/** Diagonal rays — bishop geometry; stops on first occupied square (captures player). */
function _diagonalRays(fromSq, board) {
  return _rays(fromSq, board, [[-1, -1], [-1, 1], [1, -1], [1, 1]]);
}

/** File/rank rays — rook geometry. */
function _rankFileRays(fromSq, board) {
  return _rays(fromSq, board, [[-1, 0], [1, 0], [0, -1], [0, 1]]);
}

function _rays(fromSq, board, dirs) {
  const col = _col(fromSq), row = _row(fromSq);
  const targets = [];
  for (const [dc, dr] of dirs) {
    let c = col + dc, r = row + dr;
    while (c >= 0 && c < 8 && r >= 0 && r < 8) {
      const occ = board[r][c];
      if (occ) {
        if (occ.color !== CPU_COLOR) targets.push(_toSq(c, r)); // can capture player pieces
        break;
      }
      targets.push(_toSq(c, r));
      c += dc; r += dr;
    }
  }
  return targets;
}

/** 8 knight-jump squares; excludes own-colour pieces. */
function _knightSquares(fromSq, board) {
  const col = _col(fromSq), row = _row(fromSq);
  const targets = [];
  for (const [dc, dr] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const c = col + dc, r = row + dr;
    if (c < 0 || c > 7 || r < 0 || r > 7) continue;
    if (board[r][c]?.color === CPU_COLOR) continue;
    targets.push(_toSq(c, r));
  }
  return targets;
}

/** All squares currently occupied by player pieces. */
function _playerPieceSquares(board) {
  const targets = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.color === PLAYER_COLOR) targets.push(_toSq(c, r));
    }
  }
  return targets;
}

/** All empty squares on the board. */
function _emptySquares(board) {
  const targets = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!board[r][c]) targets.push(_toSq(c, r));
    }
  }
  return targets;
}

/**
 * Mid-move promotion targets:
 *   pawn   → one square forward (toward rank 1 for black CPU)
 *   knight → all knight-jump squares (piece promotes at destination)
 *   bishop → all diagonal ray squares (piece promotes at destination)
 */
function _midMovePromotionTargets(fromSq, piece, board) {
  if (piece.type === 'p') {
    const col = _col(fromSq), row = _row(fromSq);
    const r = row + 1; // black pawns advance toward higher row (rank 1)
    if (r > 7 || board[r][col]) return [];
    return [_toSq(col, r)];
  }
  if (piece.type === 'n') return _knightSquares(fromSq, board);
  if (piece.type === 'b') return _diagonalRays(fromSq, board);
  return [];
}

// ── Piece location ────────────────────────────────────────────────────────────

/** Return all squares occupied by CPU pieces of any of the given types. */
function _findPieceSquares(board, types, color) {
  const typeSet = new Set(types);
  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color && typeSet.has(p.type)) squares.push(_toSq(c, r));
    }
  }
  return squares;
}

// ── canCheck guard ────────────────────────────────────────────────────────────

/**
 * Returns true if the cheat move (piece from fromSquare to toSquare) would
 * deliver check to the player's king.
 *
 * Simulation: remove the piece from fromSquare, place it on toSquare, flip to
 * player's turn, call inCheck().  Uses skipValidation to handle positions
 * chess.js would otherwise reject (resolution D).
 *
 * Edge case: moving to the player king's own square (king capture) is treated
 * as delivering check, since check is strictly less extreme than capture.
 */
function _wouldDeliverCheck(chess, piece, fromSquare, toSquare) {
  // Capturing the player's king = trivially "delivering check" (and worse).
  const target = chess.get(toSquare);
  if (target?.type === 'k' && target?.color === PLAYER_COLOR) return true;

  const scratch = new Chess();
  scratch.load(chess.fen(), { skipValidation: true });
  scratch.remove(fromSquare);
  scratch.remove(toSquare); // clear any occupant (could be a player piece)
  scratch.put({ type: piece.type, color: CPU_COLOR }, toSquare);

  // Re-sync internal state via FEN (mirrors the pattern in metrics.js _isDefended).
  scratch.load(scratch.fen(), { skipValidation: true });

  // Flip to player's turn to detect check on the player's king.
  const parts = scratch.fen().split(' ');
  parts[1] = PLAYER_COLOR;
  parts[3] = '-'; // clear en-passant

  const checker = new Chess();
  checker.load(parts.join(' '), { skipValidation: true });
  return checker.inCheck();
}
