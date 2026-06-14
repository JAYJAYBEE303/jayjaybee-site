import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../lib/chess.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('chess.js smoke', () => {
  it('new Chess() returns the start FEN', () => {
    const chess = new Chess();
    assert.equal(chess.fen(), START_FEN);
  });

  it('board() returns an 8x8 array', () => {
    const chess = new Chess();
    const board = chess.board();
    assert.equal(board.length, 8);
    for (const row of board) {
      assert.equal(row.length, 8);
    }
  });

  it('board() rank 0 (rank 8) starts with black pieces', () => {
    const chess = new Chess();
    const board = chess.board();
    const rank8 = board[0];
    assert.equal(rank8[0].color, 'b');
    assert.equal(rank8[0].type, 'r');
    assert.equal(rank8[4].type, 'k');
  });

  it('board() rank 7 (rank 1) starts with white pieces', () => {
    const chess = new Chess();
    const board = chess.board();
    const rank1 = board[7];
    assert.equal(rank1[0].color, 'w');
    assert.equal(rank1[0].type, 'r');
    assert.equal(rank1[4].type, 'k');
  });
});
