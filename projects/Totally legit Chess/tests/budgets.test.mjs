/**
 * Phase 2 — budget ledger tests.
 *
 * Run with:  node --test tests/budgets.test.mjs
 *
 * Covers (spec §3 + Phase 2 acceptance criteria):
 *  1. Correct initial category budgets
 *  2. Correct initial per-piece qty from catalogue
 *  3. spend() decrements both category budget and piece qty
 *  4. Category drains across different cheats in the same category
 *  5. Category hitting 0 locks ALL cheats in that category
 *  6. Per-piece qty hitting 0 locks only that vehicle (cheat still available via others)
 *  7. global×1 cheats use the 'global' sentinel key and drain the category
 *  8. reset() fully restores all budgets and qtys
 *  9. 'both'-ctx cheats have separate atk and def qty pools (resolution C)
 * 10. qtyInitial() is immutable after spending
 * 11. categoryInitial() is immutable after spending
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE }        from '../src/engine/catalogue.js';
import { createLedger, CATEGORY_BUDGETS } from '../src/engine/budgets.js';

// ── Catalogue shape ────────────────────────────────────────────────────────────

describe('CATALOGUE shape', () => {

  it('exports 11 cheats total (7 CanMoveOdd + 4 PrmtPiece)', () => {
    assert.equal(CATALOGUE.length, 11);
    assert.equal(CATALOGUE.filter(c => c.category === 'CanMoveOdd').length, 7);
    assert.equal(CATALOGUE.filter(c => c.category === 'PrmtPiece').length,  4);
  });

  it('every cheat has required fields with correct types', () => {
    for (const cheat of CATALOGUE) {
      assert.ok(typeof cheat.id === 'string' && cheat.id.length > 0,
        `${cheat.id}: missing id`);
      assert.ok(['CanMoveOdd', 'PrmtPiece'].includes(cheat.category),
        `${cheat.id}: invalid category '${cheat.category}'`);
      assert.ok(cheat.pieces && typeof cheat.pieces === 'object',
        `${cheat.id}: missing pieces`);
      assert.ok(['atk', 'def', 'both'].includes(cheat.ctx),
        `${cheat.id}: invalid ctx '${cheat.ctx}'`);
      assert.equal(typeof cheat.canCheck, 'boolean',
        `${cheat.id}: canCheck must be boolean`);
    }
  });

  it('both-ctx cheats have byCtx with atk and def sub-objects', () => {
    const bothCheats = CATALOGUE.filter(c => c.ctx === 'both');
    assert.ok(bothCheats.length > 0, 'expected at least one both-ctx cheat');
    for (const cheat of bothCheats) {
      assert.ok(cheat.byCtx, `${cheat.id}: missing byCtx`);
      assert.ok(cheat.byCtx.atk, `${cheat.id}: byCtx.atk missing`);
      assert.ok(cheat.byCtx.def, `${cheat.id}: byCtx.def missing`);
    }
  });

  it('move-like-bishop byCtx values match spec', () => {
    const c = CATALOGUE.find(c => c.id === 'move-like-bishop');
    assert.ok(c, 'move-like-bishop not found');
    assert.equal(c.byCtx.atk.sbtlRnk, 5);
    assert.equal(c.byCtx.atk.adv,     5);
    assert.equal(c.byCtx.atk.threshold.type,  'MxBen');
    assert.equal(c.byCtx.atk.threshold.value, 4);
    assert.equal(c.byCtx.def.sbtlRnk, 6);
    assert.equal(c.byCtx.def.adv,     4);
    assert.equal(c.byCtx.def.threshold.type,  'MnThrt');
    assert.equal(c.byCtx.def.threshold.value, 5);
  });

  it('move-like-knight canCheck is true', () => {
    const c = CATALOGUE.find(c => c.id === 'move-like-knight');
    assert.equal(c.canCheck, true);
  });

  it('move-like-king pieces include r×1 (resolution B typo fix)', () => {
    const c = CATALOGUE.find(c => c.id === 'move-like-king');
    assert.equal(c.pieces.r, 1);
  });

  it('emergency-queen and king-replacement are global×1 rescue-branch cheats', () => {
    for (const id of ['emergency-queen', 'king-replacement']) {
      const c = CATALOGUE.find(c => c.id === id);
      assert.ok(c, `${id} not found`);
      assert.deepEqual(c.pieces, { global: 1 });
      assert.equal(c.threshold, null);
      assert.ok(typeof c.trigger === 'string' && c.trigger.length > 0,
        `${id}: trigger missing`);
    }
  });

  it('illegal-castle uses global pool with vehiclePieces [n, b]', () => {
    const c = CATALOGUE.find(c => c.id === 'illegal-castle');
    assert.ok(c, 'illegal-castle not found');
    assert.deepEqual(c.pieces, { global: 1 });
    assert.deepEqual(c.vehiclePieces, ['n', 'b']);
  });

  it('capture-reversal pieces cover all six piece types with qty 1 each', () => {
    const c = CATALOGUE.find(c => c.id === 'capture-reversal');
    for (const t of ['p', 'n', 'b', 'r', 'q', 'k']) {
      assert.equal(c.pieces[t], 1, `capture-reversal missing piece type '${t}'`);
    }
  });

  it('adjacent-landing p×2 (pawn vehicle qty is 2)', () => {
    const c = CATALOGUE.find(c => c.id === 'adjacent-landing');
    assert.equal(c.pieces.p, 2);
    assert.equal(c.pieces.n, 1);
    assert.equal(c.pieces.b, 1);
  });

});

// ── Ledger behaviour ───────────────────────────────────────────────────────────

describe('createLedger', () => {

  // ── 1 & 2: Initialisation ──────────────────────────────────────────────────

  it('initial category budgets: CanMoveOdd=5, PrmtPiece=3', () => {
    const ledger = createLedger(CATALOGUE);
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 5);
    assert.equal(ledger.categoryBudget('PrmtPiece'),  3);
  });

  it('CATEGORY_BUDGETS export matches ledger initial values', () => {
    assert.equal(CATEGORY_BUDGETS.CanMoveOdd, 5);
    assert.equal(CATEGORY_BUDGETS.PrmtPiece,  3);
  });

  it('initial per-piece qty matches catalogue definitions', () => {
    const ledger = createLedger(CATALOGUE);
    // adjacent-landing: n×1, b×1, p×2
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 1);
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'b'), 1);
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'p'), 2);
    // move-like-king: n×1, b×1, r×1
    assert.equal(ledger.qty('move-like-king', 'def', 'n'), 1);
    assert.equal(ledger.qty('move-like-king', 'def', 'r'), 1);
    // emergency-queen: global×1
    assert.equal(ledger.qty('emergency-queen', 'def', 'global'), 1);
    // king-replacement: global×1
    assert.equal(ledger.qty('king-replacement', 'def', 'global'), 1);
    // illegal-castle: global×1
    assert.equal(ledger.qty('illegal-castle', 'def', 'global'), 1);
    // ghost-piece: p×1, n×1, b×1
    assert.equal(ledger.qty('ghost-piece', 'atk', 'p'), 1);
    assert.equal(ledger.qty('ghost-piece', 'atk', 'n'), 1);
    assert.equal(ledger.qty('ghost-piece', 'atk', 'b'), 1);
  });

  // ── 3: spend() basic ──────────────────────────────────────────────────────

  it('spend() decrements both the piece qty and the category budget', () => {
    const ledger = createLedger(CATALOGUE);
    ledger.spend('adjacent-landing', 'atk', 'n');
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 0);
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 4);
  });

  it('spend() does not decrement other piece slots or the other category', () => {
    const ledger = createLedger(CATALOGUE);
    ledger.spend('adjacent-landing', 'atk', 'n');
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'b'), 1, 'b slot untouched');
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'p'), 2, 'p slot untouched');
    assert.equal(ledger.categoryBudget('PrmtPiece'), 3, 'PrmtPiece untouched');
  });

  // ── 4: Category drains across cheats ──────────────────────────────────────

  it('category budget drains across different cheats in the same category', () => {
    const ledger = createLedger(CATALOGUE);
    // Five distinct (cheat, ctx, piece) combinations from CanMoveOdd
    ledger.spend('adjacent-landing',  'atk', 'n');   // 5→4
    ledger.spend('adjacent-landing',  'atk', 'b');   // 4→3
    ledger.spend('move-like-bishop',  'atk', 'k');   // 3→2
    ledger.spend('move-like-rook',    'atk', 'b');   // 2→1
    ledger.spend('move-like-knight',  'atk', 'k');   // 1→0
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 0);
  });

  // ── 5: Category 0 locks all cheats ────────────────────────────────────────

  it('category hitting 0 locks ALL cheats in that category', () => {
    const ledger = createLedger(CATALOGUE);
    // Drain CanMoveOdd to 0 using five unique slots
    ledger.spend('adjacent-landing',  'atk', 'n');
    ledger.spend('adjacent-landing',  'atk', 'b');
    ledger.spend('move-like-bishop',  'atk', 'k');
    ledger.spend('move-like-rook',    'atk', 'b');
    ledger.spend('move-like-knight',  'atk', 'k');
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 0);

    // Every CanMoveOdd cheat is now locked by the category cap
    for (const cheat of CATALOGUE.filter(c => c.category === 'CanMoveOdd')) {
      assert.equal(ledger.isCheatLocked(cheat.id), true,
        `${cheat.id} should be locked after category exhausted`);
    }
    // PrmtPiece cheats are unaffected
    assert.equal(ledger.isCheatLocked('ghost-piece'),     false);
    assert.equal(ledger.isCheatLocked('emergency-queen'), false);
  });

  // ── 6: Per-piece qty 0 locks only that vehicle ────────────────────────────

  it('per-piece qty 0 locks only that vehicle, not the whole cheat', () => {
    const ledger = createLedger(CATALOGUE);
    // Exhaust the knight vehicle for adjacent-landing
    ledger.spend('adjacent-landing', 'atk', 'n');
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 0, 'n vehicle exhausted');
    // The cheat itself is NOT fully locked (b and p still have qty)
    assert.equal(ledger.isCheatLocked('adjacent-landing'), false,
      'cheat still available via b/p vehicles');
    // Other vehicles are unaffected
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'b'), 1, 'b intact');
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'p'), 2, 'p intact');
  });

  it('cheat IS fully locked when all its vehicle slots reach 0', () => {
    const ledger = createLedger(CATALOGUE);
    // Exhaust all vehicles for move-like-king (def context only, n/b/r each qty=1)
    ledger.spend('move-like-king', 'def', 'n');
    ledger.spend('move-like-king', 'def', 'b');
    ledger.spend('move-like-king', 'def', 'r');
    // Category still has budget (we've spent 3 of 5 CanMoveOdd)
    assert.ok(ledger.categoryBudget('CanMoveOdd') > 0);
    // All vehicle slots for move-like-king are 0 → cheat is locked
    assert.equal(ledger.isCheatLocked('move-like-king'), true);
  });

  // ── 7: global×1 sentinel key ─────────────────────────────────────────────

  it('global×1 cheats use the global sentinel key and drain the category', () => {
    const ledger = createLedger(CATALOGUE);
    // Initial
    assert.equal(ledger.qty('emergency-queen', 'def', 'global'), 1);
    // Spend
    ledger.spend('emergency-queen', 'def', 'global');
    assert.equal(ledger.qty('emergency-queen', 'def', 'global'), 0);
    assert.equal(ledger.categoryBudget('PrmtPiece'), 2);
    // Cheat is now locked (all qty 0)
    assert.equal(ledger.isCheatLocked('emergency-queen'), true);
  });

  it('king-replacement global×1 similarly drains PrmtPiece', () => {
    const ledger = createLedger(CATALOGUE);
    ledger.spend('king-replacement', 'def', 'global');
    assert.equal(ledger.qty('king-replacement', 'def', 'global'), 0);
    assert.equal(ledger.categoryBudget('PrmtPiece'), 2);
  });

  it('illegal-castle global×1 drains CanMoveOdd', () => {
    const ledger = createLedger(CATALOGUE);
    ledger.spend('illegal-castle', 'def', 'global');
    assert.equal(ledger.qty('illegal-castle', 'def', 'global'), 0);
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 4);
    assert.equal(ledger.isCheatLocked('illegal-castle'), true);
  });

  // ── 8: reset() ────────────────────────────────────────────────────────────

  it('reset() restores all category budgets and per-piece qtys to initial values', () => {
    const ledger = createLedger(CATALOGUE);
    // Drain several slots
    ledger.spend('adjacent-landing',  'atk', 'n');
    ledger.spend('adjacent-landing',  'atk', 'b');
    ledger.spend('move-like-bishop',  'atk', 'k');
    ledger.spend('move-like-rook',    'atk', 'b');
    ledger.spend('move-like-knight',  'atk', 'k');  // CanMoveOdd = 0
    ledger.spend('emergency-queen',   'def', 'global');  // PrmtPiece: 3→2
    // Verify they're drained
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 0);
    assert.equal(ledger.categoryBudget('PrmtPiece'),  2);
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 0);

    ledger.reset();

    // All category budgets restored
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 5);
    assert.equal(ledger.categoryBudget('PrmtPiece'),  3);
    // All per-piece qtys restored
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 1);
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'p'), 2);
    assert.equal(ledger.qty('move-like-bishop', 'atk', 'k'), 1);
    assert.equal(ledger.qty('emergency-queen',  'def', 'global'), 1);
    // Previously locked cheats are unlocked
    assert.equal(ledger.isCheatLocked('adjacent-landing'),  false);
    assert.equal(ledger.isCheatLocked('emergency-queen'),   false);
  });

  // ── 9: Separate atk/def pools (resolution C) ─────────────────────────────

  it('both-ctx cheats have separate atk and def qty pools (resolution C)', () => {
    const ledger = createLedger(CATALOGUE);
    // Initial: both pools present and equal
    assert.equal(ledger.qty('move-like-bishop', 'atk', 'k'), 1);
    assert.equal(ledger.qty('move-like-bishop', 'def', 'k'), 1);
    // Spend atk slot
    ledger.spend('move-like-bishop', 'atk', 'k');
    assert.equal(ledger.qty('move-like-bishop', 'atk', 'k'), 0, 'atk k depleted');
    assert.equal(ledger.qty('move-like-bishop', 'def', 'k'), 1, 'def k unchanged');
  });

  it('both-ctx cheat is not locked when only one context is fully exhausted', () => {
    const ledger = createLedger(CATALOGUE);
    // Exhaust ALL atk slots for move-like-rook (b×1, n×1, p×1)
    ledger.spend('move-like-rook', 'atk', 'b');
    ledger.spend('move-like-rook', 'atk', 'n');
    ledger.spend('move-like-rook', 'atk', 'p');
    // def slots still have qty 1 — cheat not locked
    assert.equal(ledger.isCheatLocked('move-like-rook'), false);
    // def slots are intact
    assert.equal(ledger.qty('move-like-rook', 'def', 'b'), 1);
    assert.equal(ledger.qty('move-like-rook', 'def', 'n'), 1);
  });

  // ── 10 & 11: Immutable initial values ─────────────────────────────────────

  it('qtyInitial() is immutable — unchanged by spending', () => {
    const ledger = createLedger(CATALOGUE);
    // adjacent-landing p starts at 2
    assert.equal(ledger.qtyInitial('adjacent-landing', 'atk', 'p'), 2);
    ledger.spend('adjacent-landing', 'atk', 'p');
    ledger.spend('adjacent-landing', 'atk', 'p');  // drains to 0
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'p'), 0);
    // qtyInitial still reports 2
    assert.equal(ledger.qtyInitial('adjacent-landing', 'atk', 'p'), 2);
  });

  it('categoryInitial() is immutable — unchanged by draining', () => {
    const ledger = createLedger(CATALOGUE);
    // Drain all 5 CanMoveOdd spends
    ledger.spend('adjacent-landing', 'atk', 'n');
    ledger.spend('adjacent-landing', 'atk', 'b');
    ledger.spend('move-like-bishop', 'atk', 'k');
    ledger.spend('move-like-rook',   'atk', 'b');
    ledger.spend('move-like-knight', 'atk', 'k');
    assert.equal(ledger.categoryBudget('CanMoveOdd'),  0);
    assert.equal(ledger.categoryInitial('CanMoveOdd'), 5); // still 5
  });

});
