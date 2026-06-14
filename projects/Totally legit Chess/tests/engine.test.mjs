/**
 * Phase 7 engine tests — the six integration scenarios from the plan, plus a
 * determinism check and a scripted headless game (acceptance criterion).
 *
 * Run (not on the dev machine): `node --test tests/engine.test.mjs`
 *
 * Full pipeline, real modules: real chess.js, real createLedger(CATALOGUE),
 * real metrics/eligibility/scoring/mutate.  CPU = black ('b'), player = white.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { Chess }          from '../lib/chess.js';
import { CATALOGUE }      from '../src/engine/catalogue.js';
import { createLedger }   from '../src/engine/budgets.js';
import { processCpuTurn } from '../src/engine/engine.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const freshLedger = () => createLedger(CATALOGUE);

/**
 * Calm even-ish board: CPU king a8 + knight d4, player king h1.
 * computeMetrics → threatLevel 0 (context 'atk'), boardAdvantage 3, has legal moves.
 * On a calm board the most-subtle atk cheat (adjacent-landing, sbtlRnk 7) tops
 * selection. Its medium score is 0.92 (< 1.00 → honest); its easy score is
 * 0.965 (≥ 0.75 → cheat).
 */
function calmBoard() {
  const c = new Chess();
  c.load('k7/8/8/8/3n4/8/8/7K b - - 0 1');
  return c;
}

/**
 * Black (CPU) is checkmated: king a8, white queen b7, white king c6, black to move.
 * Verified checkmate in tests/mutate.test.mjs (king-replacement escape scenario).
 */
function matedBoard() {
  const c = new Chess();
  c.load('k7/1Q6/2K5/8/8/8/8/8 b - - 0 1', { skipValidation: true });
  return c;
}

/** Total budget points spent across both categories (initial 5 + 3). */
const spent = (ledger) =>
  (5 - ledger.categoryBudget('CanMoveOdd')) + (3 - ledger.categoryBudget('PrmtPiece'));

/** Drain PrmtPiece (budget 3) without touching the king-replacement qty slot. */
function drainPrmtPiece(ledger) {
  ledger.spend('ghost-piece',        'atk', 'p');
  ledger.spend('ghost-piece',        'atk', 'n');
  ledger.spend('mid-move-promotion', 'atk', 'p');
}

/** Drain CanMoveOdd (budget 5) via five distinct fires. */
function drainCanMoveOdd(ledger) {
  ledger.spend('adjacent-landing', 'atk', 'n');
  ledger.spend('adjacent-landing', 'atk', 'b');
  ledger.spend('adjacent-landing', 'atk', 'p');
  ledger.spend('move-like-bishop', 'atk', 'k');
  ledger.spend('move-like-rook',   'atk', 'b');
}

// ── Scenario 1: calm + subtle cheat available + score ≥ threshold → cheat ──────

test('scenario 1 — calm, subtle cheat clears threshold (easy) → cheat, both budgets drop', () => {
  const chess  = calmBoard();
  const ledger = freshLedger();

  const r = processCpuTurn(chess, ledger, 'easy');           // adjacent-landing scores 0.965 ≥ 0.75

  assert.equal(r.kind, 'cheat');
  assert.equal(r.cheatId, 'adjacent-landing', 'most-subtle atk cheat wins on a calm board');
  assert.equal(ledger.categoryBudget('CanMoveOdd'), 4, 'category budget decremented by 1');
  assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 0, 'piece qty decremented by 1');
  assert.ok(typeof r.fen === 'string' && typeof r.notation === 'string' && Array.isArray(r.diff),
    'cheat result carries fen / notation / diff');
});

// ── Scenario 2: calm + all scores below threshold → honest ────────────────────

test('scenario 2 — calm, all scores below threshold (medium) → honest, no spend', () => {
  const chess  = calmBoard();
  const ledger = freshLedger();

  const r = processCpuTurn(chess, ledger, 'medium');         // best score 0.92 < 1.00

  assert.equal(r.kind, 'honest');
  assert.ok(r.move, 'returns a legal base move');
  assert.equal(ledger.categoryBudget('CanMoveOdd'), 5, 'no CanMoveOdd spend');
  assert.equal(ledger.categoryBudget('PrmtPiece'),  3, 'no PrmtPiece spend');
});

// ── Scenario 3: checkmate + king replacement affordable → rescue cheat ────────

test('scenario 3 — checkmate, king replacement affordable → rescue cheat, no longer mate', () => {
  const chess = matedBoard();
  assert.equal(chess.isCheckmate(), true, 'precondition: CPU is checkmated');

  const ledger = freshLedger();
  const r = processCpuTurn(chess, ledger, 'medium');

  assert.equal(r.kind, 'cheat');
  assert.equal(r.cheatId, 'king-replacement', 'king replacement tried first (resolution H)');
  assert.equal(ledger.categoryBudget('PrmtPiece'), 2, 'PrmtPiece budget −1');
  assert.equal(ledger.qty('king-replacement', 'def', 'global'), 0, 'rescue qty −1');

  // Position is no longer mate: black king sits on an unattacked square, player to move.
  const blackKing = [...chess.board().flat()].find(c => c && c.type === 'k' && c.color === 'b').square;
  assert.equal(chess.isAttacked(blackKing, 'w'), false, 'relocated king is safe → not checkmate');
  assert.equal(chess.turn(), 'w', 'player to move after the rescue');
});

// ── Scenario 4: checkmate + PrmtPiece exhausted → concede ─────────────────────

test('scenario 4 — checkmate, PrmtPiece exhausted → concede, no spend, board untouched', () => {
  const chess  = matedBoard();
  const ledger = freshLedger();
  drainPrmtPiece(ledger);
  assert.equal(ledger.categoryBudget('PrmtPiece'), 0, 'precondition: PrmtPiece drained');

  const r = processCpuTurn(chess, ledger, 'medium');

  assert.equal(r.kind, 'concede');
  assert.equal(ledger.qty('king-replacement', 'def', 'global'), 1,
    'unaffordable rescue does NOT spend the king-replacement slot');
  assert.equal(chess.isCheckmate(), true, 'no mutation occurred — still checkmate');
});

// ── Scenario 5: budget exhaustion across a sequence locks the category ────────

test('scenario 5 — draining CanMoveOdd locks the whole category', () => {
  const chess  = calmBoard();
  const ledger = freshLedger();
  drainCanMoveOdd(ledger);                                   // scripted sequence of fires
  assert.equal(ledger.categoryBudget('CanMoveOdd'), 0, 'category budget drained to 0');

  // Every CanMoveOdd cheat is locked once the category budget hits 0.
  assert.equal(ledger.isCheatLocked('adjacent-landing'), true);
  assert.equal(ledger.isCheatLocked('move-like-rook'),   true);
  assert.equal(ledger.isCheatLocked('capture-reversal'), true);

  // The engine must never fire a locked-category cheat.
  const r = processCpuTurn(chess, ledger, 'easy');
  if (r.kind === 'cheat') {
    const cat = CATALOGUE.find(c => c.id === r.cheatId).category;
    assert.notEqual(cat, 'CanMoveOdd', 'a locked category must not fire');
  }
  assert.equal(ledger.categoryBudget('CanMoveOdd'), 0, 'CanMoveOdd stays locked at 0');
});

// ── Scenario 6: a single call never returns two cheats ────────────────────────

test('scenario 6 — one processCpuTurn call fires at most one cheat', () => {
  const chess  = calmBoard();
  const ledger = freshLedger();
  assert.equal(spent(ledger), 0);

  const r = processCpuTurn(chess, ledger, 'easy');           // fires exactly one cheat

  assert.equal(Array.isArray(r), false, 'returns a single result object, not a list');
  assert.equal(r.kind, 'cheat');
  assert.equal(spent(ledger), 1, 'exactly one budget point spent across all categories');
});

// ── Determinism ───────────────────────────────────────────────────────────────

test('cheat selection is deterministic for fixed inputs', () => {
  const a = processCpuTurn(calmBoard(), freshLedger(), 'easy');
  const b = processCpuTurn(calmBoard(), freshLedger(), 'easy');
  assert.equal(a.kind, b.kind);
  assert.equal(a.cheatId, b.cheatId, 'same cheat selected every run');
});

// ── Acceptance: scripted headless game ────────────────────────────────────────

test('scripted ~20-ply game runs headless; budgets respected, ≤1 cheat per CPU turn', () => {
  const chess  = new Chess();                                // standard start, white to move
  const ledger = freshLedger();

  let cpuTurns = 0;
  for (let ply = 0; ply < 20; ply++) {
    if (chess.turn() === 'w') {
      // Scripted deterministic player move (first legal move).
      const moves = chess.moves({ verbose: true });
      if (moves.length === 0) break;                         // player has no move → game over
      chess.move(moves[0]);
      continue;
    }

    // CPU (black) turn.
    const before = spent(ledger);
    const r = processCpuTurn(chess, ledger, 'easy');
    cpuTurns++;

    assert.ok(['honest', 'cheat', 'concede'].includes(r.kind), `valid result kind: ${r.kind}`);
    const delta = spent(ledger) - before;
    assert.ok(delta === 0 || delta === 1, `at most one cheat per CPU turn (delta=${delta})`);
    assert.ok(ledger.categoryBudget('CanMoveOdd') >= 0, 'CanMoveOdd budget never negative');
    assert.ok(ledger.categoryBudget('PrmtPiece')  >= 0, 'PrmtPiece budget never negative');

    if (r.kind === 'honest') {
      chess.move(r.move);                                    // caller applies the honest move
    } else if (r.kind === 'cheat') {
      assert.equal(chess.turn(), 'w', 'post-cheat: engine left the player to move');
    } else {
      break;                                                 // concede → game over
    }
  }

  assert.ok(cpuTurns >= 1, 'exercised at least one CPU turn');
  assert.ok(spent(ledger) <= 8, 'total spend within the combined budget (5 + 3)');
});
