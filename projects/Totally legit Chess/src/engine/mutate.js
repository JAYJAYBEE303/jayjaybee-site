/**
 * Forced board mutation for the cheat engine (Phase 6).
 *
 * apply(chess, application) executes a single pre-chosen cheat as an illegal
 * forced move, then leaves chess.js in a state where the PLAYER (white) is to
 * move and has legal moves.  Returns { fen, notation, diff }.
 *
 * Pure logic — no DOM, no imports of eligibility.js / scoring.js, and (per
 * the "never leak the rig" constraint) no console.* of any kind.  Operates on
 * the caller's Chess instance directly; never spins up a scratch board.
 *
 * Colour convention (SPEC.md): CPU = black ('b'), player = white ('w').
 *
 * Post-mutation contract — EVERY handler ends here (SPEC.md §7):
 *   1. Rebuild FEN explicitly from chess.board():
 *        active colour = player ('w'), castling pruned to remaining
 *        rooks/kings, en-passant '-', halfmove 0, fullmove preserved.
 *   2. Load with chess.load(fen, { skipValidation: true })   ← confirmed
 *        supported in this vendored chess.js (load() skips validateFen when
 *        skipValidation is true; it never throws on a rigged position).
 *   3. Fallback if the load is somehow not honoured: chess.clear() +
 *        per-piece chess.put(), then rebuild + load again.
 *
 * Resolution D: canCheck is enforced upstream in eligibility (Phase 4).
 * mutate.js does NOT re-check.  The movement / ghost handlers could in
 * principle deliver check on a canCheck:false application — but by contract
 * only eligibility-filtered applications reach here, so they never do.  (Risk
 * flagged, not guarded, per the resolution.)
 */

const FILES = 'abcdefgh';

/** Material tiers (Resolution I): P1 N3/B3 R5 Q9 — used by mid-move promotion. */
const NEXT_TIER = { p: 'n', n: 'r', b: 'r', r: 'q', q: 'q' };

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute one cheat as a forced mutation.
 *
 * @param {import('../../lib/chess.js').Chess} chess  — CPU (black) is to move
 * @param {import('./eligibility.js').Application} application
 * @returns {{ fen: string, notation: string, diff: Array<{square:string, piece:{type:string,color:string}|null}> }}
 */
export function apply(chess, application) {
  // fullmove + castling rights are read BEFORE the mutation: put/remove never
  // touch fullmove, and castling must be PRUNED from the original rights (only
  // removed, never added), so we need the pre-mutation value.
  const fields    = chess.fen().split(' ');
  const fullmove  = fields[5];
  const castling0 = fields[2];
  const before    = _boardMap(chess);

  // Mutate the board in place; handler returns SAN-as-if-legal.
  const notation = _dispatch(chess, application);

  // Re-synchronise chess.js with the player to move.
  const fen = _rebuildFen(chess, fullmove, castling0);
  _commit(chess, fen, castling0);

  // Append the check / mate suffix so the recorded SAN matches what chess.js
  // would produce for a legal move (player = white is now to move).
  const suffix = chess.isCheckmate() ? '#' : (chess.inCheck() ? '+' : '');

  const after = _boardMap(chess);
  return { fen, notation: notation ? notation + suffix : notation, diff: _diff(before, after) };
}

// ── Handler dispatch ────────────────────────────────────────────────────────

function _dispatch(chess, app) {
  switch (app.cheatId) {
    case 'ghost-piece':        return _ghost(chess, app);
    case 'mid-move-promotion': return _promote(chess, app);
    case 'emergency-queen':    return _emergencyQueen(chess);
    case 'king-replacement':   return _kingReplacement(chess);
    // All CanMoveOdd movement cheats (adjacent-landing, move-like-*,
    // illegal-castle, capture-reversal) share one handler.
    default:                   return _movement(chess, app);
  }
}

// ── Movement (CanMoveOdd) ───────────────────────────────────────────────────

/**
 * remove(from) → remove(to) if occupied (capture) → put(vehicle, to).
 * Vehicle type/colour read from the live board so 'global' cheats work too.
 */
function _movement(chess, app) {
  const { fromSquare: from, toSquare: to } = app;
  const piece = chess.get(from);
  if (!piece) return ''; // defensive: vehicle vanished — nothing to do

  const captured = chess.get(to) || null;
  chess.remove(from);
  if (captured) chess.remove(to);
  chess.put({ type: piece.type, color: piece.color }, to);

  return _movementSan(piece.type, from, to, Boolean(captured));
}

/** SAN-as-if-legal for a movement cheat (no check/# suffix, no disambiguation). */
function _movementSan(type, from, to, capture) {
  if (type === 'p') return (capture ? from[0] + 'x' : '') + to;
  return type.toUpperCase() + (capture ? 'x' : '') + to;
}

// ── Ghost piece (PrmtPiece) ─────────────────────────────────────────────────

/** Spawn a CPU copy of the vehicle on the (empty) target square. */
function _ghost(chess, app) {
  const piece = chess.get(app.fromSquare);
  const type  = piece ? piece.type : 'n';
  chess.put({ type, color: 'b' }, app.toSquare);
  // SAN-as-if-legal (SPEC §10): render exactly like a normal move of this piece
  // — no drop marker, which never appears in standard chess notation.
  return _movementSan(type, app.fromSquare, app.toSquare, false);
}

// ── Mid-move promotion (PrmtPiece) ──────────────────────────────────────────

/**
 * Upgrade the vehicle on its CURRENT square to the next material tier
 * (SPEC deliverable: "next value tier" → p→n, n/b→r, r→q; capped at queen).
 * toSquare is intentionally ignored for this cheat.
 *
 * NOTE (flag): the cheat is named "promotion" yet the deliverable specifies
 * a single-tier step, so a pawn becomes a knight, NOT a queen.  Implemented
 * literally per spec; surfaced here in case promote-to-queen was intended.
 */
function _promote(chess, app) {
  const sq    = app.fromSquare;
  const piece = chess.get(sq);
  const type  = piece ? piece.type : 'p';
  const up    = NEXT_TIER[type] ?? 'q';
  chess.remove(sq);
  chess.put({ type: up, color: 'b' }, sq);
  // SAN-as-if-legal (SPEC §10): a '=' promotion marker off the back rank is
  // impossible in real chess, so record it as a plain move of the upgraded piece.
  return up.toUpperCase() + sq;
}

// ── Emergency queen (PrmtPiece rescue) ──────────────────────────────────────

/**
 * Place a CPU queen on a SAFE square.  Strategy (documented):
 *   scan all squares in board order (a8 → h1) and take the first square that is
 *     (a) empty,
 *     (b) not attacked by the player (queen not immediately capturable), and
 *     (c) does not put the player's king in check (honours canCheck:false).
 * Deterministic.  Falls back to the first empty square if no fully-safe square
 * exists (guarantees the queen is always placed).
 */
function _emergencyQueen(chess) {
  const playerKing = _findKing(chess, 'w');

  for (const sq of _allSquares()) {
    if (chess.get(sq)) continue;                       // (a) empty
    chess.put({ type: 'q', color: 'b' }, sq);
    const capturable = chess.isAttacked(sq, 'w');      // (b) safe from player
    const givesCheck = playerKing ? chess.isAttacked(playerKing, 'b') : false; // (c)
    if (!capturable && !givesCheck) return 'Q' + sq;
    chess.remove(sq);                                  // reject; try next
  }
  // Fallback: any empty square.
  for (const sq of _allSquares()) {
    if (chess.get(sq)) continue;
    chess.put({ type: 'q', color: 'b' }, sq);
    return 'Q' + sq;
  }
  return 'Q-';
}

// ── King replacement (PrmtPiece rescue) ─────────────────────────────────────

/**
 * Relocate the CPU king to the NEAREST safe square.  Strategy (documented):
 *   order every square by Chebyshev distance from the king's current square
 *   (ascending, ties by board order) and take the first square that is
 *     (a) empty, and
 *     (b) not attacked by the player.
 *   A non-attacked square means the king is not in check there, hence
 *   chess.isCheckmate() is necessarily false.
 * Falls back to the nearest empty square (even if attacked) so the king is
 * always relocated.
 */
function _kingReplacement(chess) {
  const from  = _findKing(chess, 'b');
  const order = from ? _squaresByDistance(from) : _allSquares();

  for (const sq of order) {
    if (sq === from || chess.get(sq)) continue;        // (a) empty, not current
    if (from) chess.remove(from);
    chess.put({ type: 'k', color: 'b' }, sq);
    if (!chess.isAttacked(sq, 'w')) return 'K' + sq;   // (b) safe → not in check
    chess.remove(sq);                                  // revert
    if (from) chess.put({ type: 'k', color: 'b' }, from);
  }
  // Fallback: nearest empty square regardless of attack.
  for (const sq of order) {
    if (sq === from || chess.get(sq)) continue;
    if (from) chess.remove(from);
    chess.put({ type: 'k', color: 'b' }, sq);
    return 'K' + sq;
  }
  return 'K-';
}

// ── FEN rebuild + commit ────────────────────────────────────────────────────

/**
 * Build the FEN explicitly from board(): active=player, castling pruned, ep '-', half 0.
 * @param {string} castling0  — pre-mutation castling field; rights are only ever
 *                              pruned from this, never added.
 */
function _rebuildFen(chess, fullmove, castling0) {
  const board = chess.board();

  const rows = [];
  for (let r = 0; r < 8; r++) {
    let s = '', empty = 0;
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (!cell) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      s += cell.color === 'w' ? cell.type.toUpperCase() : cell.type.toLowerCase();
    }
    if (empty) s += empty;
    rows.push(s);
  }
  const placement = rows.join('/');

  // Castling = the pre-mutation rights, MINUS any whose king/rook no longer sits
  // on its home square.  Pure pruning — a right absent from castling0 is never
  // re-granted just because the pieces happen to be home.
  const rights = castling0 === '-' ? '' : castling0;
  const map = {};
  for (const row of board) for (const cell of row) if (cell) map[cell.square] = cell;
  const has = (sq, type, color) => map[sq] && map[sq].type === type && map[sq].color === color;
  let castling = '';
  if (rights.includes('K') && has('e1', 'k', 'w') && has('h1', 'r', 'w')) castling += 'K';
  if (rights.includes('Q') && has('e1', 'k', 'w') && has('a1', 'r', 'w')) castling += 'Q';
  if (rights.includes('k') && has('e8', 'k', 'b') && has('h8', 'r', 'b')) castling += 'k';
  if (rights.includes('q') && has('e8', 'k', 'b') && has('a8', 'r', 'b')) castling += 'q';
  if (!castling) castling = '-';

  return `${placement} w ${castling} - 0 ${fullmove}`;
}

/**
 * Load the rebuilt FEN with the player to move.
 * Primary path: chess.load(fen, { skipValidation: true }).
 * Fallback (load not honoured): clear() + per-piece put(), then rebuild + load.
 */
function _commit(chess, fen, castling0) {
  const placement = fen.split(' ')[0];
  const fullmove  = fen.split(' ')[5];

  try {
    chess.load(fen, { skipValidation: true });
    if (chess.turn() === 'w' && chess.fen().split(' ')[0] === placement) return;
  } catch (_) { /* fall through to manual rebuild */ }

  // Fallback: clear() resets turn → white (player); place every piece by hand.
  chess.clear();
  for (const p of _piecesFromPlacement(placement)) {
    chess.put({ type: p.type, color: p.color }, p.square);
  }
  try { chess.load(_rebuildFen(chess, fullmove, castling0), { skipValidation: true }); } catch (_) { /* board already correct */ }
}

// ── Board snapshot + diff ───────────────────────────────────────────────────

/** Map every square → { type, color } | null. board() omits the square on null
 *  cells, so iterate by coordinate to cover empty squares too. */
function _boardMap(chess) {
  const out = {};
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = FILES[c] + (8 - r);
      const cell = board[r][c];
      out[sq] = cell ? { type: cell.type, color: cell.color } : null;
    }
  }
  return out;
}

/** Squares whose occupant changed between two board maps. */
function _diff(before, after) {
  const changes = [];
  for (const sq of _allSquares()) {
    if (!_samePiece(before[sq], after[sq])) changes.push({ square: sq, piece: after[sq] });
  }
  return changes;
}

function _samePiece(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.color === b.color;
}

// ── Square helpers ──────────────────────────────────────────────────────────

/** All 64 squares in board order a8 → h1 (matches chess.js SQUARES). */
function _allSquares() {
  const out = [];
  for (let r = 8; r >= 1; r--) for (let f = 0; f < 8; f++) out.push(FILES[f] + r);
  return out;
}

/** Squares sorted by Chebyshev distance from `from` (asc, ties by board order). */
function _squaresByDistance(from) {
  const ff = from.charCodeAt(0) - 97, fr = +from[1];
  return _allSquares()
    .map((sq, i) => {
      const d = Math.max(Math.abs(sq.charCodeAt(0) - 97 - ff), Math.abs(+sq[1] - fr));
      return { sq, d, i };
    })
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(o => o.sq);
}

/** Locate the king of a colour from the live board. */
function _findKing(chess, color) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

/** Parse a FEN placement field into [{ square, type, color }]. */
function _piecesFromPlacement(placement) {
  const out = [];
  const rows = placement.split('/');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { c += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      out.push({ square: FILES[c] + (8 - r), type: ch.toLowerCase(), color });
      c++;
    }
  }
  return out;
}
