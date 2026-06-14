const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/**
 * Choose a move for the CPU.
 * Prefers the highest-material capture; ties broken randomly.
 * Falls back to a uniform-random legal move.
 * Returns null if there are no legal moves.
 *
 * @param {Chess} chess
 * @param {() => number} rng - injectable RNG returning [0, 1); defaults to Math.random
 */
export function chooseHonestMove(chess, rng = Math.random) {
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;

  const captures = moves.filter(m => m.captured);
  if (captures.length > 0) {
    let bestVal = 0;
    for (const m of captures) {
      const v = PIECE_VALUES[m.captured] ?? 0;
      if (v > bestVal) bestVal = v;
    }
    const tied = captures.filter(m => (PIECE_VALUES[m.captured] ?? 0) === bestVal);
    return tied[Math.floor(rng() * tied.length)];
  }

  return moves[Math.floor(rng() * moves.length)];
}
