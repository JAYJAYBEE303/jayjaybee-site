/**
 * tests/eligibility.test.mjs
 *
 * Unit tests for src/engine/eligibility.js — enumerateEligible.
 *
 * Covers the seven acceptance scenarios from ROADMAP Phase 4:
 *   (a) atk cheat excluded when boardAdvantage > MxBen
 *   (b) def cheat excluded when threatLevel < MnThrt
 *   (c) cheat excluded when category budget = 0
 *   (d) cheat excluded when per-piece qty = 0
 *   (e) 'both' cheat eligible in both atk and def contexts; correct byCtx values
 *   (f) canCheck:false cheat drops checking targets but keeps non-checking ones
 *   (g) Hard difficulty admits a cheat that Medium rejects
 *
 * Run:  node --test tests/eligibility.test.mjs
 * (SentinelOne users: provide this command to a safe terminal)
 *
 * ── Position notes ──────────────────────────────────────────────────────────
 *
 * All tests use custom FENs.  The metrics object is always supplied directly
 * (not via computeMetrics) so that eligibility gate behaviour can be isolated
 * from the threat-detection code tested separately in metrics.test.mjs.
 *
 * CPU = black (b), player = white (w), matching src/engine/metrics.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Chess }                from '../lib/chess.js';
import { CATALOGUE }            from '../src/engine/catalogue.js';
import { createLedger }         from '../src/engine/budgets.js';
import { enumerateEligible }    from '../src/engine/eligibility.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fresh ledger with all budgets and qtys at their initial values. */
function freshLedger() { return createLedger(CATALOGUE); }

/**
 * Build a minimal metrics object.  Only the three fields consumed by
 * enumerateEligible are required; others are not used in Phase 4.
 */
function metrics(context, boardAdvantage, threatLevel) {
  return { context, boardAdvantage, threatLevel };
}

// ── Position catalogue ────────────────────────────────────────────────────────

/*
 * FEN: k7/8/8/8/3n4/8/8/7K b - - 0 1
 *   CPU (black):  king a8, knight d4
 *   Player (white): king h1
 *   Neither king is in check.  Used as the default "knight present" position.
 */
const FEN_KNIGHT_D4 = 'k7/8/8/8/3n4/8/8/7K b - - 0 1';

/*
 * FEN: k7/8/8/8/3b4/8/8/7K b - - 0 1
 *   CPU (black):  king a8, bishop d4
 *   Player (white): king h1
 *   Used when a bishop vehicle is needed (e.g. move-like-rook, move-like-king).
 */
const FEN_BISHOP_D4 = 'k7/8/8/8/3b4/8/8/7K b - - 0 1';

/*
 * FEN: k7/8/8/6K1/8/8/8/7r b - - 0 1
 *   CPU (black):  king a8, rook h1
 *   Player (white): king g5
 *
 *   Used for the canCheck scenario (f).
 *
 *   move-like-bishop applied to the rook at h1 enumerates NW diagonal rays:
 *     g2, f3, e4, d5, c6, b7  (a8 is the CPU king — stop before it).
 *
 *   Check analysis (rook-on-target vs white king g5):
 *     g2 → rook attacks g-file → g5 is on g-file → CHECK (dropped)
 *     f3 → rook attacks f-file and rank 3 → g5 is neither → no check (kept)
 *     e4 → rook attacks e-file and rank 4 → g5 is neither → no check (kept)
 *     d5 → rook attacks d-file and rank 5 → g5 is on rank 5 → CHECK (dropped)
 *     c6 → rook attacks c-file and rank 6 → g5 is neither → no check (kept)
 *     b7 → rook attacks b-file and rank 7 → g5 is neither → no check (kept)
 */
const FEN_ROOK_H1_KING_G5 = 'k7/8/8/6K1/8/8/8/7r b - - 0 1';

// ── Return-shape smoke test ───────────────────────────────────────────────────

describe('enumerateEligible — return shape', () => {

  test('returns an array', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(chess, freshLedger(), metrics('atk', 0, 0), 'medium');
    assert.ok(Array.isArray(apps));
  });

  test('every application carries the required fields', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(chess, freshLedger(), metrics('atk', 0, 0), 'medium');

    for (const app of apps) {
      assert.ok(typeof app.cheatId          === 'string', 'cheatId missing');
      assert.ok(typeof app.category         === 'string', 'category missing');
      assert.ok(['atk', 'def'].includes(app.ctx),         'ctx must be atk or def');
      assert.ok(typeof app.pieceType        === 'string', 'pieceType missing');
      assert.ok(typeof app.fromSquare       === 'string', 'fromSquare missing');
      assert.ok(typeof app.toSquare         === 'string', 'toSquare missing');
      assert.ok(typeof app.effectiveSbtlRnk === 'number', 'effectiveSbtlRnk missing');
      assert.ok(typeof app.effectiveAdv     === 'number', 'effectiveAdv missing');
    }
  });

  test('rescue-branch cheats (trigger present) are never included', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(chess, freshLedger(), metrics('def', 0, 100), 'medium');
    for (const app of apps) {
      const cheat = CATALOGUE.find(c => c.id === app.cheatId);
      assert.ok(!cheat.trigger, `rescue-branch cheat '${app.cheatId}' must not appear`);
    }
  });

});

// ── Scenario (a): atk cheat excluded when boardAdvantage > MxBen ─────────────

describe('scenario (a): atk cheat excluded when boardAdvantage > MxBen', () => {

  /**
   * adjacent-landing: ctx='atk', MxBen=5.
   * boardAdvantage=6 > 5 → gate 4 fails → no applications.
   *
   * Position: CPU knight at d4, player king at h1.
   * Ledger: fresh (all budgets full).
   */

  test('no adjacent-landing applications when boardAdvantage(6) > MxBen(5)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 6, 0), 'medium',
    );
    const count = apps.filter(a => a.cheatId === 'adjacent-landing').length;
    assert.equal(count, 0, `expected 0, got ${count}`);
  });

  test('adjacent-landing IS included when boardAdvantage(5) = MxBen(5)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    // CPU knight at d4: 8 adjacent squares all empty (player king at h1, CPU king at a8)
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 5, 0), 'medium',
    );
    const count = apps.filter(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'n').length;
    assert.ok(count > 0, 'expected >0 applications when advantage equals MxBen');
  });

  test('gate 4 is specific to atk cheats — def cheats are unaffected by boardAdvantage', () => {
    // move-like-king: ctx='def', MnThrt=7.  boardAdvantage is irrelevant for def cheats.
    // With threatLevel=7 and high boardAdvantage, move-like-king should still fire.
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('def', 99, 7), 'medium',
    );
    const count = apps.filter(a => a.cheatId === 'move-like-king').length;
    assert.ok(count > 0, 'move-like-king should be eligible regardless of boardAdvantage');
  });

});

// ── Scenario (b): def cheat excluded when threatLevel < MnThrt ───────────────

describe('scenario (b): def cheat excluded when threatLevel < MnThrt', () => {

  /**
   * move-like-king: ctx='def', MnThrt=7.
   * threatLevel=3 < 7 → gate 5 fails → no applications.
   *
   * Position: CPU knight at d4 (vehicle for move-like-king is n×1).
   * Ledger: fresh.
   */

  test('no move-like-king applications when threatLevel(3) < MnThrt(7)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('def', 0, 3), 'medium',
    );
    const count = apps.filter(a => a.cheatId === 'move-like-king').length;
    assert.equal(count, 0, `expected 0, got ${count}`);
  });

  test('move-like-king IS included when threatLevel(7) = MnThrt(7)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('def', 0, 7), 'medium',
    );
    const count = apps.filter(a => a.cheatId === 'move-like-king' && a.pieceType === 'n').length;
    assert.ok(count > 0, 'expected >0 applications when threatLevel equals MnThrt');
  });

  test('gate 5 is specific to def cheats — atk cheats are unaffected by threatLevel', () => {
    // adjacent-landing: ctx='atk', MxBen=5.  Even with threatLevel=0, should fire in atk context.
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    );
    const count = apps.filter(a => a.cheatId === 'adjacent-landing').length;
    assert.ok(count > 0, 'adjacent-landing should fire in atk context regardless of threatLevel');
  });

});

// ── Scenario (c): cheat excluded when category budget = 0 ───────────────────

describe('scenario (c): cheat excluded when category budget = 0', () => {

  /**
   * Drain the CanMoveOdd category to 0 (five distinct spend calls).
   * All CanMoveOdd cheats must then return zero applications.
   * PrmtPiece cheats must be unaffected.
   */

  function drainCanMoveOdd(ledger) {
    ledger.spend('adjacent-landing', 'atk', 'n');  // 5→4
    ledger.spend('adjacent-landing', 'atk', 'b');  // 4→3
    ledger.spend('move-like-bishop', 'atk', 'k');  // 3→2
    ledger.spend('move-like-rook',   'atk', 'b');  // 2→1
    ledger.spend('move-like-knight', 'atk', 'k');  // 1→0
  }

  test('no CanMoveOdd applications when category budget = 0', () => {
    const chess  = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const ledger = freshLedger();
    drainCanMoveOdd(ledger);
    assert.equal(ledger.categoryBudget('CanMoveOdd'), 0);

    const apps = enumerateEligible(chess, ledger, metrics('atk', 0, 0), 'medium');
    const canMoveOddApps = apps.filter(a => a.category === 'CanMoveOdd');
    assert.equal(canMoveOddApps.length, 0,
      'no CanMoveOdd apps expected when category budget is 0');
  });

  test('PrmtPiece cheats are unaffected by CanMoveOdd exhaustion', () => {
    const chess  = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const ledger = freshLedger();
    drainCanMoveOdd(ledger);

    // ghost-piece is an atk PrmtPiece cheat (MxBen=3).  boardAdvantage=0 ≤ 3. ✓
    const apps       = enumerateEligible(chess, ledger, metrics('atk', 0, 0), 'medium');
    const prmtApps   = apps.filter(a => a.category === 'PrmtPiece');
    assert.ok(prmtApps.length > 0, 'expected PrmtPiece apps even when CanMoveOdd is drained');
  });

  test('PrmtPiece cheats are also excluded when PrmtPiece budget = 0', () => {
    const chess  = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const ledger = freshLedger();
    // Drain PrmtPiece (3 uses) with three distinct spends
    ledger.spend('ghost-piece',        'atk', 'p');
    ledger.spend('ghost-piece',        'atk', 'n');
    ledger.spend('mid-move-promotion', 'atk', 'p');
    assert.equal(ledger.categoryBudget('PrmtPiece'), 0);

    const apps     = enumerateEligible(chess, ledger, metrics('atk', 0, 0), 'medium');
    const prmtApps = apps.filter(a => a.category === 'PrmtPiece');
    assert.equal(prmtApps.length, 0, 'no PrmtPiece apps expected when PrmtPiece budget = 0');
  });

});

// ── Scenario (d): cheat excluded when per-piece qty = 0 ─────────────────────

describe('scenario (d): cheat excluded when per-piece qty = 0', () => {

  /**
   * illegal-castle uses pieces: { global: 1 }.  After spending that global slot,
   * the cheat must produce zero applications even though the category budget > 0.
   *
   * This tests gate 2 in isolation from gate 1.
   */

  test('no illegal-castle applications after global qty is exhausted', () => {
    const chess  = new Chess();
    // Position with a CPU knight (vehicle for illegal-castle via vehiclePieces: ['n', 'b'])
    chess.load(FEN_KNIGHT_D4);
    const ledger = freshLedger();
    ledger.spend('illegal-castle', 'def', 'global');
    assert.equal(ledger.qty('illegal-castle', 'def', 'global'), 0,
      'pre-condition: global qty must be 0 after spending');
    // Category still has budget (we only spent 1 of 5)
    assert.ok(ledger.categoryBudget('CanMoveOdd') > 0, 'category budget must still be > 0');

    const apps = enumerateEligible(chess, ledger, metrics('def', 0, 6), 'medium');
    const count = apps.filter(a => a.cheatId === 'illegal-castle').length;
    assert.equal(count, 0, 'illegal-castle must be excluded when global qty = 0');
  });

  test('exhausting one piece-type slot leaves other slots eligible', () => {
    // adjacent-landing has n×1, b×1, p×2.  Exhausting 'n' leaves b and p.
    const chess  = new Chess();
    // Position: CPU knight AND bishop both present, so both vehicles are on the board.
    // CPU king a8, black knight d4, black bishop e5, white king h1.
    chess.load('k7/8/8/4b3/3n4/8/8/7K b - - 0 1');
    const ledger = freshLedger();
    ledger.spend('adjacent-landing', 'atk', 'n');
    assert.equal(ledger.qty('adjacent-landing', 'atk', 'n'), 0);

    const apps      = enumerateEligible(chess, ledger, metrics('atk', 0, 0), 'medium');
    const fromKnight = apps.filter(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'n');
    const fromBishop = apps.filter(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'b');

    assert.equal(fromKnight.length, 0, 'knight vehicle must be excluded after n qty = 0');
    assert.ok(fromBishop.length > 0, 'bishop vehicle must still be eligible');
  });

});

// ── Scenario (e): 'both' cheat eligible in both atk and def contexts ─────────

describe("scenario (e): 'both' cheat eligible in both atk and def contexts", () => {

  /**
   * move-like-bishop: ctx='both', byCtx = {
   *   atk: { sbtlRnk:5, adv:5, threshold:{type:'MxBen', value:4} },
   *   def: { sbtlRnk:6, adv:4, threshold:{type:'MnThrt', value:5} },
   * }
   *
   * Position: CPU king a8, CPU knight d4 (r×1 and n×1 are vehicles for move-like-bishop).
   */

  test('move-like-bishop produces atk applications in atk context', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    // boardAdvantage=0 ≤ MxBen=4 ✓
    const apps = enumerateEligible(chess, freshLedger(), metrics('atk', 0, 0), 'medium');
    const atkApps = apps.filter(a => a.cheatId === 'move-like-bishop' && a.ctx === 'atk');
    assert.ok(atkApps.length > 0, 'expected atk applications for move-like-bishop');
  });

  test('move-like-bishop produces def applications in def context', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    // threatLevel=5 ≥ MnThrt=5 ✓
    const apps = enumerateEligible(chess, freshLedger(), metrics('def', 0, 5), 'medium');
    const defApps = apps.filter(a => a.cheatId === 'move-like-bishop' && a.ctx === 'def');
    assert.ok(defApps.length > 0, 'expected def applications for move-like-bishop');
  });

  test('atk applications carry byCtx.atk values (sbtlRnk=5, adv=5)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps   = enumerateEligible(chess, freshLedger(), metrics('atk', 0, 0), 'medium');
    const atkApp = apps.find(a => a.cheatId === 'move-like-bishop' && a.ctx === 'atk');
    assert.ok(atkApp, 'expected at least one atk application');
    assert.equal(atkApp.effectiveSbtlRnk, 5, 'atk sbtlRnk must be 5');
    assert.equal(atkApp.effectiveAdv,     5, 'atk adv must be 5');
  });

  test('def applications carry byCtx.def values (sbtlRnk=6, adv=4)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps   = enumerateEligible(chess, freshLedger(), metrics('def', 0, 5), 'medium');
    const defApp = apps.find(a => a.cheatId === 'move-like-bishop' && a.ctx === 'def');
    assert.ok(defApp, 'expected at least one def application');
    assert.equal(defApp.effectiveSbtlRnk, 6, 'def sbtlRnk must be 6');
    assert.equal(defApp.effectiveAdv,     4, 'def adv must be 4');
  });

  test('both-context cheat uses separate atk/def qty pools (resolution C)', () => {
    const chess  = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const ledger = freshLedger();
    // Spend the atk knight slot for move-like-bishop
    ledger.spend('move-like-bishop', 'atk', 'n');
    assert.equal(ledger.qty('move-like-bishop', 'atk', 'n'), 0);
    assert.equal(ledger.qty('move-like-bishop', 'def', 'n'), 1); // def pool untouched

    // In def context the knight slot should still produce applications.
    const apps  = enumerateEligible(chess, ledger, metrics('def', 0, 5), 'medium');
    const count = apps.filter(a => a.cheatId === 'move-like-bishop' && a.pieceType === 'n').length;
    assert.ok(count > 0, 'def pool must remain after atk pool is spent');
  });

  test('single-context cheats only appear in their declared context', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);

    // adjacent-landing is atk-only: must not appear in def context.
    const defApps = enumerateEligible(chess, freshLedger(), metrics('def', 0, 10), 'medium');
    const badAtk  = defApps.filter(a => a.cheatId === 'adjacent-landing');
    assert.equal(badAtk.length, 0, 'adjacent-landing (atk-only) must not appear in def context');

    // move-like-king is def-only: must not appear in atk context.
    const atkApps = enumerateEligible(chess, freshLedger(), metrics('atk', 0, 0), 'medium');
    const badDef  = atkApps.filter(a => a.cheatId === 'move-like-king');
    assert.equal(badDef.length, 0, 'move-like-king (def-only) must not appear in atk context');
  });

});

// ── Scenario (f): canCheck guard ─────────────────────────────────────────────

describe('scenario (f): canCheck:false cheat drops checking targets, keeps non-checking ones', () => {

  /**
   * Position: FEN_ROOK_H1_KING_G5
   *   CPU rook at h1, CPU king at a8, white king at g5.
   *
   * move-like-bishop (canCheck:false) applied to the rook at h1
   * enumerates the NW diagonal: g2, f3, e4, d5, c6, b7
   * (a8 = CPU king, so the ray stops before it).
   *
   * After placing the rook on each square, the white king (g5) is in check from:
   *   g2 → rook attacks g-file → g5 ∈ g-file → CHECK  → application dropped
   *   d5 → rook attacks rank 5 → g5 ∈ rank 5 → CHECK  → application dropped
   *
   * Non-checking targets (kept): f3, e4, c6, b7.
   *
   * The metrics object is supplied directly:
   *   context='atk', boardAdvantage=0 ≤ MxBen(atk)=4 → gate 4 passes.
   */

  let apps;

  // Initialise once and reuse.
  test('setup: produces applications from the rook at h1', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(apps.length > 0, 'expected move-like-bishop apps from rook at h1');
  });

  test('g2 is dropped (rook on g2 delivers check to white king on g-file)', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    const filtered = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(!filtered.some(a => a.toSquare === 'g2'), 'g2 must be dropped (delivers check)');
  });

  test('d5 is dropped (rook on d5 delivers check to white king on rank 5)', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    const filtered = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(!filtered.some(a => a.toSquare === 'd5'), 'd5 must be dropped (delivers check)');
  });

  test('f3 is kept (rook on f3 does not attack g5)', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    const filtered = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(filtered.some(a => a.toSquare === 'f3'), 'f3 must be kept (no check)');
  });

  test('e4 is kept (rook on e4 does not attack g5)', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    const filtered = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(filtered.some(a => a.toSquare === 'e4'), 'e4 must be kept (no check)');
  });

  test('c6 is kept (rook on c6 does not attack g5)', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    const filtered = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(filtered.some(a => a.toSquare === 'c6'), 'c6 must be kept (no check)');
  });

  test('b7 is kept (rook on b7 does not attack g5)', () => {
    const chess = new Chess();
    chess.load(FEN_ROOK_H1_KING_G5, { skipValidation: true });
    const filtered = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-bishop' && a.fromSquare === 'h1');
    assert.ok(filtered.some(a => a.toSquare === 'b7'), 'b7 must be kept (no check)');
  });

  test('canCheck:true cheat (move-like-knight) keeps checking targets but never captures the king', () => {
    // move-like-knight: canCheck=true — the check guard is skipped, so targets that
    // merely DELIVER check are kept.  But NO cheat may CAPTURE the player's king
    // (that leaves a kingless, game-breaking board), so the king square is always
    // dropped by the universal king-capture guard.
    // Position: CPU king a8, CPU queen d4 (q×1 vehicle), white king e2.
    // Knight-jumps from d4: b3, b5, c2, c6, e2(white king), e6, f3, f5.
    //   e2 = king square                    → king capture → always dropped.
    //   c2 = queen there checks e2 (rank 2) → kept (canCheck:true skips check guard).
    const chess = new Chess();
    chess.load('k7/8/8/8/3q4/8/4K3/8 b - - 0 1', { skipValidation: true });
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-knight' && a.fromSquare === 'd4');

    assert.ok(!apps.some(a => a.toSquare === 'e2'),
      'king-capture square must be dropped even for canCheck:true cheats');
    assert.ok(apps.some(a => a.toSquare === 'c2'),
      'canCheck:true cheat still keeps checking (non-king) targets — check guard not applied');
  });

});

// ── Scenario (g): Hard difficulty admits a cheat Medium rejects ───────────────

describe('scenario (g): Hard difficulty admits a cheat that Medium rejects', () => {

  /**
   * adjacent-landing: ctx='atk', MxBen=5 (medium baseline).
   *   Hard modifier: MxBen +1 → effective MxBen = 6.
   *   Easy modifier: MxBen +1 → effective MxBen = 6.
   *
   * boardAdvantage=6:
   *   Medium → 6 > 5 → gate 4 fails → excluded
   *   Hard   → 6 ≤ 6 → gate 4 passes → included
   *   Easy   → 6 ≤ 6 → gate 4 passes → included
   *
   * Position: CPU knight at d4 (vehicle n×1), player king at h1.
   * All 8 adjacent squares of d4 are empty/non-CPU — no canCheck issues
   * because the player king is far away.
   */

  test('Medium excludes adjacent-landing when boardAdvantage(6) > MxBen(5)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps  = enumerateEligible(chess, freshLedger(), metrics('atk', 6, 0), 'medium');
    const count = apps.filter(a => a.cheatId === 'adjacent-landing').length;
    assert.equal(count, 0, 'Medium: adjacent-landing must be excluded when advantage=6 > MxBen=5');
  });

  test('Hard includes adjacent-landing when boardAdvantage(6) = raised MxBen(5+1=6)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps  = enumerateEligible(chess, freshLedger(), metrics('atk', 6, 0), 'hard');
    const count = apps.filter(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'n').length;
    assert.ok(count > 0,
      'Hard: adjacent-landing must be admitted when raised MxBen=6 ≥ boardAdvantage=6');
  });

  test('Easy includes adjacent-landing when boardAdvantage(6) = raised MxBen(5+1=6)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const apps  = enumerateEligible(chess, freshLedger(), metrics('atk', 6, 0), 'easy');
    const count = apps.filter(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'n').length;
    assert.ok(count > 0,
      'Easy: adjacent-landing must be admitted when raised MxBen=6 ≥ boardAdvantage=6');
  });

  test('Hard admits a def cheat (move-like-king) when threatLevel(6) = lowered MnThrt(7-1=6)', () => {
    /**
     * move-like-king: ctx='def', MnThrt=7 (medium baseline).
     * Hard modifier: MnThrt -1 → effective MnThrt = 6.
     *
     * threatLevel=6:
     *   Medium → 6 < 7 → gate 5 fails → excluded
     *   Hard   → 6 ≥ 6 → gate 5 passes → included
     *
     * Position: CPU knight at d4 (n×1 vehicle for move-like-king), player king at h1.
     */
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);

    const medApps  = enumerateEligible(chess, freshLedger(), metrics('def', 0, 6), 'medium');
    const hardApps = enumerateEligible(chess, freshLedger(), metrics('def', 0, 6), 'hard');

    const medCount  = medApps.filter(a => a.cheatId === 'move-like-king').length;
    const hardCount = hardApps.filter(a => a.cheatId === 'move-like-king' && a.pieceType === 'n').length;

    assert.equal(medCount,  0, 'Medium: move-like-king excluded when threatLevel(6) < MnThrt(7)');
    assert.ok(hardCount > 0,  'Hard: move-like-king admitted when threatLevel(6) = lowered MnThrt(6)');
  });

  test('Medium (baseline) is unmodified — no threshold changes applied', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);

    // boardAdvantage=5 = MxBen=5 (boundary): should be included in all difficulties.
    const medApps  = enumerateEligible(chess, freshLedger(), metrics('atk', 5, 0), 'medium');
    const hardApps = enumerateEligible(chess, freshLedger(), metrics('atk', 5, 0), 'hard');
    const easyApps = enumerateEligible(chess, freshLedger(), metrics('atk', 5, 0), 'easy');

    // All three should include adjacent-landing (5 ≤ 5 for medium, 5 ≤ 6 for hard/easy).
    for (const [label, apps] of [['medium', medApps], ['hard', hardApps], ['easy', easyApps]]) {
      const count = apps.filter(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'n').length;
      assert.ok(count > 0, `${label}: expected adjacent-landing at boardAdvantage=5`);
    }
  });

});

// ── Target enumeration geometry ───────────────────────────────────────────────

describe('target enumeration geometry', () => {

  /**
   * Spot-checks that each cheat id produces geometrically correct targets.
   * Full coverage of each geometry function is implicit in scenarios (a)-(g).
   */

  test('adjacent-landing from d4 produces 8 surrounding squares when all empty', () => {
    // d4 at (col3,row4).  Surrounding: c3,c4,c5,d3,d5,e3,e4,e5.
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4); // CPU knight at d4, all adjacent squares empty
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'adjacent-landing' && a.fromSquare === 'd4');

    const squares = new Set(apps.map(a => a.toSquare));
    for (const sq of ['c3', 'c4', 'c5', 'd3', 'd5', 'e3', 'e4', 'e5']) {
      assert.ok(squares.has(sq), `expected '${sq}' in adjacent-landing targets from d4`);
    }
    assert.equal(apps.length, 8, 'expected exactly 8 adjacent targets');
  });

  test('move-like-rook from d4 includes rank and file squares', () => {
    // CPU bishop at d4 (b×1 vehicle for move-like-rook), player king at h1.
    const chess = new Chess();
    chess.load(FEN_BISHOP_D4);
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).filter(a => a.cheatId === 'move-like-rook' && a.fromSquare === 'd4');

    const squares = new Set(apps.map(a => a.toSquare));
    // d-file: d1, d2, d3, d5, d6, d7 (d8 is empty too) — note d8 is unoccupied
    assert.ok(squares.has('d1'), 'should reach d1 along d-file');
    assert.ok(squares.has('d7'), 'should reach d7 along d-file');
    // rank 4: a4, b4, c4, e4, f4, g4, h4 (h4 adjacent to h1? no, h4 is rank 4)
    assert.ok(squares.has('a4'), 'should reach a4 along rank 4');
    assert.ok(squares.has('h4'), 'should reach h4 along rank 4');
  });

  test('capture-reversal targets include non-king player pieces and exclude the player king', () => {
    // Position: CPU king a8, white pawn e4, white king h1.
    const chess = new Chess();
    chess.load('k7/8/8/8/4P3/8/8/7K b - - 0 1', { skipValidation: true });
    // capture-reversal: def, MnThrt=8.  CPU king at a8 is the vehicle (k×1).
    const apps = enumerateEligible(
      chess, freshLedger(), metrics('def', 0, 8), 'medium',
    ).filter(a => a.cheatId === 'capture-reversal');

    const targets = new Set(apps.map(a => a.toSquare));

    // e4 (white pawn) must appear — it is a valid capture-reversal target.
    assert.ok(targets.has('e4'), 'e4 (white pawn) must appear as capture-reversal target');

    // h1 (white king) must be EXCLUDED — _wouldDeliverCheck returns true for any
    // move that lands on the player king's square (king capture ≥ check).
    assert.ok(!targets.has('h1'),
      'h1 (white king) must be excluded by the canCheck guard (king capture counts as check)');
  });

});

// ── effectiveSbtlRnk and effectiveAdv correctness ────────────────────────────

describe('effectiveSbtlRnk and effectiveAdv in returned applications', () => {

  test('adjacent-landing (non-byCtx) carries top-level sbtlRnk=7 and adv=3', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const app = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).find(a => a.cheatId === 'adjacent-landing' && a.pieceType === 'n');

    assert.ok(app, 'expected at least one adjacent-landing application');
    assert.equal(app.effectiveSbtlRnk, 7);
    assert.equal(app.effectiveAdv,     3);
  });

  test('move-like-knight atk context carries byCtx.atk values (sbtlRnk=4, adv=6)', () => {
    // move-like-knight: both ctx, k×1 vehicle.  CPU king at a8 can be vehicle.
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4); // CPU king a8, CPU knight d4
    const app = enumerateEligible(
      chess, freshLedger(), metrics('atk', 0, 0), 'medium',
    ).find(a => a.cheatId === 'move-like-knight' && a.ctx === 'atk');

    assert.ok(app, 'expected atk application for move-like-knight');
    assert.equal(app.effectiveSbtlRnk, 4, 'byCtx.atk.sbtlRnk should be 4');
    assert.equal(app.effectiveAdv,     6, 'byCtx.atk.adv should be 6');
  });

  test('move-like-knight def context carries byCtx.def values (sbtlRnk=5, adv=5)', () => {
    const chess = new Chess();
    chess.load(FEN_KNIGHT_D4);
    const app = enumerateEligible(
      chess, freshLedger(), metrics('def', 0, 6), 'medium',
    ).find(a => a.cheatId === 'move-like-knight' && a.ctx === 'def');

    assert.ok(app, 'expected def application for move-like-knight');
    assert.equal(app.effectiveSbtlRnk, 5, 'byCtx.def.sbtlRnk should be 5');
    assert.equal(app.effectiveAdv,     5, 'byCtx.def.adv should be 5');
  });

});
