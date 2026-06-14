/**
 * tests/metrics.test.mjs
 *
 * Unit tests for src/engine/metrics.js — computeMetrics and PIECE_VALUES.
 *
 * All six acceptance scenarios from ROADMAP Phase 3 are covered here and
 * are manually traced in the comment blocks below each test.
 *
 * Run:  node --test tests/metrics.test.mjs
 * (SentinelOne users: provide this command to a safe terminal)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Chess } from '../lib/chess.js';
import { computeMetrics, PIECE_VALUES } from '../src/engine/metrics.js';

// ── PIECE_VALUES shape ────────────────────────────────────────────────────────

describe('PIECE_VALUES', () => {

  test('exports correct values for all six piece types', () => {
    assert.equal(PIECE_VALUES.p,  1);
    assert.equal(PIECE_VALUES.n,  3);
    assert.equal(PIECE_VALUES.b,  3);
    assert.equal(PIECE_VALUES.r,  5);
    assert.equal(PIECE_VALUES.q,  9);
    assert.equal(PIECE_VALUES.k, 100);
  });

});

// ── computeMetrics — return shape ─────────────────────────────────────────────

describe('computeMetrics return shape', () => {

  test('returns all required fields', () => {
    // Position: after 1.e4, black to move (no threats, equal material)
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');

    const m = computeMetrics(chess);

    assert.ok('cpuMaterial'       in m, 'cpuMaterial missing');
    assert.ok('playerMaterial'    in m, 'playerMaterial missing');
    assert.ok('boardAdvantage'    in m, 'boardAdvantage missing');
    assert.ok('threats'           in m, 'threats missing');
    assert.ok('threatLevel'       in m, 'threatLevel missing');
    assert.ok('context'           in m, 'context missing');
    assert.ok('cpuHasNoLegalMove' in m, 'cpuHasNoLegalMove missing');
    assert.ok(Array.isArray(m.threats),    'threats must be an array');
  });

});

// ── Scenario (a): No CPU piece under attack ────────────────────────────────────

describe('scenario (a): no CPU piece under attack', () => {

  /**
   * Trace:
   *   FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1
   *   chess.inCheck() = false
   *   Turn-flip → w to move, en-passant cleared.
   *   All white moves from opening are quiet or advance pawns — none reach
   *   rank 7 to capture a black piece.  attackMap is empty.
   *   threats = [], threatLevel = 0, context = 'atk'.
   */
  test('threatLevel is 0', () => {
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.threatLevel, 0);
  });

  test('context is "atk"', () => {
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.context, 'atk');
  });

  test('threats array is empty', () => {
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const m = computeMetrics(chess);
    assert.deepEqual(m.threats, []);
  });

  test('cpuHasNoLegalMove is false (black has legal moves)', () => {
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.cpuHasNoLegalMove, false);
  });

});

// ── Scenario (b): CPU queen attacked by pawn, undefended ─────────────────────

describe('scenario (b): CPU queen attacked by pawn, undefended', () => {

  /**
   * Position:
   *   k7/8/8/3q4/2P5/8/8/K7  b - - 0 1
   *   Black: king a8, queen d5
   *   White: king a1, pawn c4
   *
   * Trace:
   *   chess.inCheck() = false (white pawn does not attack a8)
   *   Turn-flip → w to move, en-passant '-'
   *   White pawn on c4 attacks b5 and d5.  d5 has the black queen.
   *   m.to = 'd5', m.piece = 'p' (value 1), m.captured = 'q' (value 9)
   *   attackMap: { d5 → 1 }
   *   victimVal = 9.  lowestAtkVal (1) < victimVal (9) → profitable capture.
   *   Endangered regardless of defense.
   *   threats = [{ square:'d5', pieceType:'q', value:9 }]
   *   threatLevel = 9, context = 'def'.
   */

  test('threatLevel is 9', () => {
    const chess = new Chess();
    chess.load('k7/8/8/3q4/2P5/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.threatLevel, 9);
  });

  test('context is "def"', () => {
    const chess = new Chess();
    chess.load('k7/8/8/3q4/2P5/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.context, 'def');
  });

  test('threat entry identifies the queen on d5', () => {
    const chess = new Chess();
    chess.load('k7/8/8/3q4/2P5/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    const t = m.threats.find(t => t.square === 'd5');
    assert.ok(t, 'expected threat on d5');
    assert.equal(t.pieceType, 'q');
    assert.equal(t.value,     9);
  });

});

// ── Scenario (c): CPU king in check ──────────────────────────────────────────

describe('scenario (c): CPU king in check', () => {

  /**
   * Position:
   *   5k2/8/8/8/5R2/8/8/5K2  b - - 0 1
   *   Black: king f8
   *   White: king f1, rook f4
   *
   * Trace:
   *   White rook on f4 attacks entire f-file, including f8.
   *   chess.inCheck() = true → short-circuit.
   *   _findKing(chess, 'b') = 'f8'
   *   threats = [{ square:'f8', pieceType:'k', value:100 }]
   *   threatLevel = 100, context = 'def'.
   */

  test('threatLevel is 100', () => {
    const chess = new Chess();
    chess.load('5k2/8/8/8/5R2/8/8/5K2 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.threatLevel, 100);
  });

  test('context is "def"', () => {
    const chess = new Chess();
    chess.load('5k2/8/8/8/5R2/8/8/5K2 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.context, 'def');
  });

  test('threat entry identifies the king on f8', () => {
    const chess = new Chess();
    chess.load('5k2/8/8/8/5R2/8/8/5K2 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.threats.length, 1);
    assert.equal(m.threats[0].square,    'f8');
    assert.equal(m.threats[0].pieceType, 'k');
    assert.equal(m.threats[0].value,     100);
  });

});

// ── Scenario (d): CPU king and rook forked — king priority ────────────────────

describe('scenario (d): CPU king and rook forked (knight fork)', () => {

  /**
   * Position:
   *   4r1k1/8/5N2/8/8/8/8/3K4  b - - 0 1
   *   Black: king g8, rook e8
   *   White: king d1, knight f6
   *
   * Trace:
   *   Knight on f6 attacks: d5, d7, e4, e8, g4, g8, h5, h7
   *   Black king on g8 is attacked → chess.inCheck() = true.
   *   Short-circuit: _findKing(chess, 'b') = 'g8'
   *   threats = [{ square:'g8', pieceType:'k', value:100 }]
   *   threatLevel = 100 (king takes priority over rook on e8).
   *   context = 'def'.
   */

  test('threatLevel is 100 (king takes priority over forked rook)', () => {
    const chess = new Chess();
    chess.load('4r1k1/8/5N2/8/8/8/8/3K4 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.threatLevel, 100);
  });

  test('context is "def"', () => {
    const chess = new Chess();
    chess.load('4r1k1/8/5N2/8/8/8/8/3K4 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.context, 'def');
  });

  test('single threat entry is the king, not the rook', () => {
    const chess = new Chess();
    chess.load('4r1k1/8/5N2/8/8/8/8/3K4 b - - 0 1');
    const m = computeMetrics(chess);
    // Check short-circuit returns only the king threat
    assert.equal(m.threats.length, 1);
    assert.equal(m.threats[0].pieceType, 'k');
  });

});

// ── Scenario (e): Equal material ─────────────────────────────────────────────

describe('scenario (e): equal material', () => {

  /**
   * Position: after 1.e4 (both sides have full starting army).
   *   Each side: K(100) + Q(9) + 2R(10) + 2B(6) + 2N(6) + 8P(8) = 139.
   *   boardAdvantage = 139 - 139 = 0.
   */

  test('boardAdvantage is 0', () => {
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.boardAdvantage, 0);
  });

  test('cpuMaterial equals playerMaterial', () => {
    const chess = new Chess();
    chess.load('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.cpuMaterial, m.playerMaterial);
  });

});

// ── Scenario (f): CPU up a rook ───────────────────────────────────────────────

describe('scenario (f): CPU up a rook', () => {

  /**
   * Position:
   *   k1r5/8/8/8/8/8/8/K7  b - - 0 1
   *   Black: king a8 (100), rook c8 (5)   → cpuMaterial    = 105
   *   White: king a1 (100)                 → playerMaterial = 100
   *   boardAdvantage = 105 - 100 = 5.
   */

  test('boardAdvantage is 5', () => {
    const chess = new Chess();
    chess.load('k1r5/8/8/8/8/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.boardAdvantage, 5);
  });

  test('cpuMaterial is 105', () => {
    const chess = new Chess();
    chess.load('k1r5/8/8/8/8/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.cpuMaterial, 105);
  });

  test('playerMaterial is 100', () => {
    const chess = new Chess();
    chess.load('k1r5/8/8/8/8/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.playerMaterial, 100);
  });

});

// ── Defense detection: defended piece is NOT flagged as threatened ─────────────

describe('defense detection', () => {

  /**
   * Position:
   *   k3r3/8/8/3q4/2P5/8/8/K7  b - - 0 1
   *   Black: king a8, rook e8, queen d5
   *   White: king a1, pawn c4
   *
   *   White pawn c4 attacks d5 (black queen).
   *   Attacker value 1 < victim value 9 → profitable → queen is endangered
   *   REGARDLESS of defense (this is correct per spec).
   *
   *   Separate case to confirm defense logic for equal/losing trade:
   *
   *   Position:
   *   k7/8/8/3r4/2Q5/8/8/K7  b - - 0 1
   *   Black: king a8, rook d5
   *   White: king a1, queen c4
   *
   *   White queen (c4) attacks d5 (black rook, value 5).
   *   lowestAtkVal = 9 (queen) >= victimVal = 5 → NOT profitable.
   *   No black piece defends d5 → undefended → rook IS endangered.
   *   threatLevel = 5, context = 'def'.
   */

  test('undefended rook attacked by queen (equal/losing trade) → threatened', () => {
    const chess = new Chess();
    // Black rook d5, white queen c4 attacks d5 (diagonal), no black defender
    chess.load('k7/8/8/3r4/2Q5/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    assert.equal(m.threatLevel, 5);
    assert.equal(m.context, 'def');
  });

  /**
   * Position:
   *   k3r3/8/8/3r4/2Q5/8/8/K7  b - - 0 1
   *   Black: king a8, rook e8, rook d5
   *   White: king a1, queen c4
   *
   *   White queen (c4) attacks d5 (black rook, value 5).
   *   lowestAtkVal = 9 >= victimVal = 5 → NOT profitable.
   *   Black rook on e8 can move to d8? No, but rook on e8 can move to d8 only if e8→d8.
   *   Actually: to check if d5 is defended, we simulate:
   *     - remove black rook from d5
   *     - place white pawn sentinel on d5
   *     - it's black's turn
   *     - black rook on e8 can move to e5 (same file? no, e8→d5 is neither rank nor file)
   *       Wait: e8 to d5 is not a rook move.
   *
   *   Let me use black rook on d8 instead (same file as d5):
   *   k2r4/8/8/3r4/2Q5/8/8/K7  b - - 0 1
   *   Black rook on d8 defends d5 (same d-file).
   *   After white queen captures on d5, black rook on d8 can recapture on d5.
   *   lowestAtkVal (9) >= victimVal (5), but defended → NOT endangered.
   *   All other pieces: king a8 (not on d-file). No threats → threatLevel 0.
   */

  test('rook defended by another rook along the same file → not threatened', () => {
    const chess = new Chess();
    // Black rook d5 defended by black rook d8; white queen c4 attacks d5 (diagonal)
    chess.load('k2r4/8/8/3r4/2Q5/8/8/K7 b - - 0 1');
    const m = computeMetrics(chess);
    // Queen attacks d5 but d5 is defended → not threatened
    // (Also check: is the queen on c4 "attacking" anything else in this position?
    //  Queen c4 moves diagonally: b3,a2 / b5,a6 / d3,e2,f1 / d5(black rook) — captured here.
    //  Queen c4 on rank/file: c1-c8,a4-h4. Black rook on d8 is not on c-file or rank 4.
    //  Black rook on d5 — already handled. No other captures.
    //  So only d5 rook is attacked, and it's defended → threatLevel 0.)
    assert.equal(m.threatLevel, 0);
    assert.equal(m.context, 'atk');
  });

});
