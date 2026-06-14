/**
 * Phase 5 scoring tests — five scenarios from the implementation plan.
 *
 * Run (not on the dev machine): `node --test tests/scoring.test.mjs`
 *
 * scoring.js takes pre-computed values, so these tests feed plain Application
 * objects + a stub ledger + a minimal metrics object.  No chess.js, no DOM.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { score, selectBest, fireThreshold } from '../src/engine/scoring.js';
import { getDifficultyModifiers }           from '../src/engine/tuning.js';

const EPS = 1e-9;
const near = (a, b) => Math.abs(a - b) < EPS;

/** Stub ledger: returns fixed numbers regardless of key (deterministic traces). */
function makeLedger({ catBudget = 5, catInitial = 5, qty = 1, qtyInitial = 1 } = {}) {
  return {
    categoryBudget:  () => catBudget,
    categoryInitial: () => catInitial,
    qty:             () => qty,
    qtyInitial:      () => qtyInitial,
  };
}

// ── Applications ──────────────────────────────────────────────────────────────

// atk-context pair for the calm board
const subtleAtk  = { cheatId: 'adjacent-landing',   category: 'CanMoveOdd', ctx: 'atk', pieceType: 'n', effectiveSbtlRnk: 7, effectiveAdv: 3 };
const blatantAtk = { cheatId: 'mid-move-promotion', category: 'PrmtPiece',  ctx: 'atk', pieceType: 'n', effectiveSbtlRnk: 2, effectiveAdv: 6 };

// def-context pair for the high-threat board
const blatantDef = { cheatId: 'capture-reversal',   category: 'CanMoveOdd', ctx: 'def', pieceType: 'q', effectiveSbtlRnk: 5, effectiveAdv: 7 };
const subtleDef  = { cheatId: 'move-like-king',     category: 'CanMoveOdd', ctx: 'def', pieceType: 'n', effectiveSbtlRnk: 8, effectiveAdv: 2 };

const calm  = { threatLevel: 0 };  // even board, no threat
const queen = { threatLevel: 9 };  // CPU queen hanging

// ── Scenario 1: calm even board → subtle (high-SbtlRnk) outscores blatant ──────

test('scenario 1 — calm board: subtle application wins', () => {
  const ledger = makeLedger();                       // full budget → budgetScarc 0 → desperation 0
  const sSubtle  = score(subtleAtk,  calm, ledger, 'medium');
  const sBlatant = score(blatantAtk, calm, ledger, 'medium');

  assert.ok(near(sSubtle,  0.92), `subtle expected 0.92, got ${sSubtle}`);
  assert.ok(near(sBlatant, 0.54), `blatant expected 0.54, got ${sBlatant}`);
  assert.ok(sSubtle > sBlatant);
  assert.equal(selectBest([blatantAtk, subtleAtk], calm, ledger, 'medium'), subtleAtk);
});

// ── Scenario 2: high threat → blatant (high-Adv) outscores subtle ──────────────

test('scenario 2 — queen hanging: blatant high-Adv application wins', () => {
  const ledger = makeLedger();                       // desperation = 0.7*0.9 = 0.63
  const sBlatant = score(blatantDef, queen, ledger, 'medium');
  const sSubtle  = score(subtleDef,  queen, ledger, 'medium');

  assert.ok(near(sBlatant, 1.502), `blatant expected 1.502, got ${sBlatant}`);
  assert.ok(near(sSubtle,  0.822), `subtle expected 0.822, got ${sSubtle}`);
  assert.ok(sBlatant > sSubtle);
  assert.equal(selectBest([subtleDef, blatantDef], queen, ledger, 'medium'), blatantDef);
});

// ── Scenario 3: empty application list → null ──────────────────────────────────

test('scenario 3 — empty list: selectBest returns null', () => {
  assert.equal(selectBest([], calm, makeLedger(), 'medium'), null);
  assert.equal(selectBest(undefined, calm, makeLedger(), 'medium'), null);
});

// ── Scenario 4: best score below medium threshold → honest ─────────────────────

test('scenario 4 — best below fireThreshold plays honest (threshold helper)', () => {
  const ledger = makeLedger();
  const best   = score(subtleAtk, calm, ledger, 'medium');   // 0.92

  assert.equal(fireThreshold('medium'), 1.00);
  assert.ok(best < fireThreshold('medium'), `${best} should be < 1.00 → honest`);
});

// ── Scenario 5: easy/hard fire where medium would not (−0.25 threshold) ─────────

test('scenario 5 — easy/hard −0.25 threshold flips fire vs honest', () => {
  const ledger = makeLedger();

  assert.equal(fireThreshold('easy'), 0.75);
  assert.equal(fireThreshold('hard'), 0.75);
  assert.equal(fireThreshold('medium'), 1.00);

  // Identical score, different gate: isolates the −0.25 modifier.
  const s = score(subtleAtk, calm, ledger, 'medium');        // 0.92
  assert.ok(s <  fireThreshold('medium'), 'medium: honest');  // 0.92 < 1.00
  assert.ok(s >= fireThreshold('easy'),   'easy: fires');     // 0.92 ≥ 0.75
  assert.ok(s >= fireThreshold('hard'),   'hard: fires');     // 0.92 ≥ 0.75

  // easy also recomputes higher (W_ADV +0.3) and still clears its own gate.
  const sEasy = score(subtleAtk, calm, ledger, 'easy');       // 0.965
  assert.ok(near(sEasy, 0.965), `easy score expected 0.965, got ${sEasy}`);
  assert.ok(sEasy >= fireThreshold('easy'));
});

// ── Determinism + modifier sanity ──────────────────────────────────────────────

test('selectBest is deterministic for fixed inputs', () => {
  const ledger = makeLedger();
  const a = selectBest([blatantDef, subtleDef], queen, ledger, 'medium');
  const b = selectBest([blatantDef, subtleDef], queen, ledger, 'medium');
  assert.equal(a, b);
  assert.equal(a, blatantDef);
});

test('getDifficultyModifiers — easy/hard bonus, medium baseline', () => {
  assert.deepEqual(getDifficultyModifiers('easy'),   { wAdvBonus: 0.3, mxBenDelta: 1,  mnThrtDelta: -1 });
  assert.deepEqual(getDifficultyModifiers('hard'),   { wAdvBonus: 0.3, mxBenDelta: 1,  mnThrtDelta: -1 });
  assert.deepEqual(getDifficultyModifiers('medium'), { wAdvBonus: 0,   mxBenDelta: 0,  mnThrtDelta: 0  });
});
