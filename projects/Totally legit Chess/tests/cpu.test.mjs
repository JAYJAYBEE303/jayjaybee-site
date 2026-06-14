import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../lib/chess.js';
import { chooseHonestMove } from '../src/cpu.js';

describe('chooseHonestMove', () => {

  it('returns null when there are no legal moves (checkmate)', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    const chess = new Chess();
    chess.move('f3');
    chess.move('e5');
    chess.move('g4');
    chess.move('Qh4');
    assert.ok(chess.isCheckmate(), 'position should be checkmate');
    assert.equal(chooseHonestMove(chess), null);
  });

  it('prefers the highest-value free capture over a quiet move', () => {
    // Black knight on f6 can capture the undefended white queen on g4.
    // All other black moves are quiet (no captures).
    // FEN: black to move; Nf6 captures Qg4
    const chess = new Chess();
    chess.load('rnbqkb1r/pppppppp/5n2/8/6Q1/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1');
    const move = chooseHonestMove(chess);
    assert.equal(move.from, 'f6', 'should move from f6');
    assert.equal(move.to,   'g4', 'should capture on g4');
    assert.equal(move.captured, 'q', 'captured piece should be a queen');
  });

  it('falls back to random with seeded RNG — same seed produces same move', () => {
    const chess = new Chess(); // starting position, no captures available
    const alwaysFirst = () => 0;
    const move1 = chooseHonestMove(chess, alwaysFirst);
    const move2 = chooseHonestMove(chess, alwaysFirst);
    assert.ok(move1 !== null);
    assert.equal(move1.san, move2.san, 'same RNG seed must produce the same move');
  });

  it('falls back to random with seeded RNG — different seeds produce different moves', () => {
    const chess = new Chess();
    const moves = chess.moves({ verbose: true });
    const first = chooseHonestMove(chess, () => 0);
    const last  = chooseHonestMove(chess, () => 0.9999);
    assert.notEqual(first.san, last.san,
      'different RNG seeds should produce different moves across the full move list');
    // Verify both are legal
    const legal = chess.moves();
    assert.ok(legal.includes(first.san), 'first should be a legal move');
    assert.ok(legal.includes(last.san),  'last should be a legal move');
    // Verify they index correctly into the moves array
    assert.equal(first.san, moves[0].san);
    assert.equal(last.san,  moves[moves.length - 1].san);
  });

  it('among tied best captures, picks randomly via the injected RNG', () => {
    // Two black rooks, each can capture a white queen on opposite files.
    // Both queens have the same value (9), so any tie-break is valid — but it
    // must be deterministic for a fixed RNG seed.
    // FEN: black rooks on a8 and h8; white queens on a1 and h1; kings clear of attacks.
    // r6r/8/8/8/8/8/8/Q5kQ b - - 0 1  (but kings must not be in check...)
    // Simpler: just verify that with () => 0 it picks the first tied option reproducibly.
    const chess = new Chess();
    // Position: black rook a8 can capture white queen a1; black rook h8 can capture Qh1.
    // Kings: white king on e1, black king on e8.
    chess.load('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
    // In this position black has captures: Rxa1 and Rxh1 (both rooks capture rooks of value 5).
    // With seeded RNG, must be deterministic.
    const m1 = chooseHonestMove(chess, () => 0);
    const m2 = chooseHonestMove(chess, () => 0);
    assert.equal(m1.san, m2.san, 'seeded tie-break should be deterministic');
  });

});
