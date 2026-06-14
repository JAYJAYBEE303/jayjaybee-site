/**
 * Phase 6 mutation tests — six scenarios from the implementation plan.
 *
 * Run (not on the dev machine): `node --test tests/mutate.test.mjs`
 *
 * CPU = black ('b'), player = white ('w').  Rigged FENs are loaded via
 * load(fen, { skipValidation:true }) — the Chess constructor validates, so it
 * must NOT be used for impossible positions.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Chess } from '../lib/chess.js';
import { apply } from '../src/engine/mutate.js';

/** Load a (possibly rigged) FEN without validation. */
function rig(fen) {
  const c = new Chess();
  c.load(fen, { skipValidation: true });
  return c;
}

/** Count pieces of a given type/colour on the board. */
function count(chess, type, color) {
  let n = 0;
  for (const row of chess.board()) for (const cell of row) {
    if (cell && cell.type === type && cell.color === color) n++;
  }
  return n;
}

const mv = (over) => ({
  cheatId: 'move-like-bishop', category: 'CanMoveOdd', ctx: 'atk', pieceType: 'n',
  fromSquare: 'b8', toSquare: 'b5', effectiveSbtlRnk: 5, effectiveAdv: 5, ...over,
});

// ── Scenario 1: board reflects the illegal change ──────────────────────────────

test('scenario 1 — board reflects the illegal mutation', () => {
  const chess = rig('1n2k3/8/8/8/8/8/8/R3K3 b - - 0 1');
  const { diff } = apply(chess, mv());                 // knight b8 → b5 (illegal)

  assert.equal(chess.get('b8'), undefined, 'vehicle left from-square');
  assert.deepEqual(chess.get('b5'), { type: 'n', color: 'b' }, 'vehicle on to-square');
  // diff carries both squares for the renderer.
  assert.deepEqual(diff.find(d => d.square === 'b8'), { square: 'b8', piece: null });
  assert.deepEqual(diff.find(d => d.square === 'b5'), { square: 'b5', piece: { type: 'n', color: 'b' } });
});

// ── Scenario 2: chess.js re-synchronises with the player to move ────────────────

test('scenario 2 — player to move with legal moves after mutation', () => {
  const chess = rig('1n2k3/8/8/8/8/8/8/R3K3 b - - 0 1');
  const { fen } = apply(chess, mv());

  assert.equal(chess.turn(), 'w', 'player (white) to move');
  assert.equal(fen.split(' ')[1], 'w', 'FEN active colour = player');
  assert.ok(chess.moves().length > 0, 'player has legal moves');
});

// ── Scenario 3: movement onto a player piece records a capture ──────────────────

test('scenario 3 — capturing movement records "x" in notation', () => {
  const chess = rig('1n2k3/8/8/1P6/8/8/8/4K3 b - - 0 1'); // white pawn on b5
  const { notation } = apply(chess, mv());               // knight b8 → b5 (xP)

  assert.equal(notation, 'Nxb5', 'SAN-as-if-legal records the capture');
  assert.deepEqual(chess.get('b5'), { type: 'n', color: 'b' }, 'CPU piece now on b5');
  assert.equal(count(chess, 'p', 'w'), 0, 'captured player pawn is gone');
});

// ── Scenario 4: emergency queen adds exactly one CPU queen ──────────────────────

test('scenario 4 — emergency queen adds exactly one CPU queen, safely', () => {
  const chess = rig('4k3/8/8/8/8/8/8/R3K3 b - - 0 1');
  const before = count(chess, 'q', 'b');
  const { notation } = apply(chess, { cheatId: 'emergency-queen', category: 'PrmtPiece', ctx: 'def', pieceType: 'global' });

  assert.equal(count(chess, 'q', 'b') - before, 1, 'exactly one CPU queen added');
  assert.match(notation, /^Q[a-h][1-8]$/, 'SAN-as-if-legal: plain queen move, no drop marker');
  assert.equal(chess.turn(), 'w', 'player to move');
  assert.equal(chess.inCheck(), false, 'queen does not check the player king');
  assert.ok(chess.moves().length > 0, 'player has legal moves');
});

// ── Scenario 5: king replacement moves off the mating square ────────────────────

test('scenario 5 — king replacement escapes mate (isCheckmate false)', () => {
  const chess = rig('k7/1Q6/2K5/8/8/8/8/8 b - - 0 1'); // black king a8 is mated
  // sanity: the start position really is checkmate for black to move
  const pre = rig('k7/1Q6/2K5/8/8/8/8/8 b - - 0 1');
  assert.equal(pre.isCheckmate(), true, 'precondition: black is checkmated');

  apply(chess, { cheatId: 'king-replacement', category: 'PrmtPiece', ctx: 'def', pieceType: 'global' });

  assert.equal(chess.isCheckmate(), false, 'no longer checkmate after relocation');
  const ks = [...chess.board().flat()].find(c => c && c.type === 'k' && c.color === 'b').square;
  assert.notEqual(ks, 'a8', 'king actually moved off the mating square');
  assert.equal(chess.isAttacked(ks, 'w'), false, 'relocated king is on a safe square');
});

// ── Scenario 6: a rigged 9-pawn position loads and mutates without throwing ──────

test('scenario 6 — rigged position with 9 pawns does not throw', () => {
  const fen = '4k3/pppppppp/p7/8/8/8/8/4K3 b - - 0 1'; // 9 black pawns
  let chess;
  assert.doesNotThrow(() => { chess = rig(fen); }, 'rigged FEN loads via skipValidation');
  assert.equal(count(chess, 'p', 'b'), 9, 'all nine pawns present');

  assert.doesNotThrow(() => {
    apply(chess, mv({ fromSquare: 'a6', toSquare: 'a4' })); // shove a pawn illegally
  }, 'mutation does not throw on the rigged position');
  assert.equal(chess.turn(), 'w', 'player to move');
  assert.ok(chess.moves().length > 0, 'player has legal moves');
});
