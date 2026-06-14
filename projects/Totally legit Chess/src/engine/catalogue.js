/**
 * Static cheat catalogue — pure data, no logic.
 *
 * Field reference
 * ───────────────
 * id          kebab-case identifier
 * category    'CanMoveOdd' | 'PrmtPiece'
 * pieces      { [pieceType]: qty }  — piece types that can be vehicles and their use-counts.
 *             pieceType 'global' = single shared pool (no specific vehicle piece).
 * vehiclePieces  (optional) — for global-pooled cheats that still need a physical vehicle,
 *             lists which piece types are eligible.  The eligibility engine uses this when
 *             pieces === { global: 1 }.
 * ctx         'atk' | 'def' | 'both'
 * sbtlRnk     subtlety rank 0–10.  HIGHER = more subtle (resolution A).
 *             Omitted when values vary by context — see byCtx.
 * adv         advantage weight 0–10.  Omitted when values vary by context — see byCtx.
 * threshold   { type: 'MxBen'|'MnThrt', value: number } | null
 *             Omitted when values vary by context — see byCtx.
 *             null for cheats with no eligibility threshold (rescue-branch cheats).
 * byCtx       { atk: { sbtlRnk, adv, threshold }, def: { sbtlRnk, adv, threshold } }
 *             Present only on ctx:'both' cheats whose values differ by context (resolution E).
 * canCheck    boolean — may the cheated move deliver check to the player's king? (resolution D)
 * trigger     (optional) — rescue-branch event string: 'cpu-queen-taken' | 'king-captured'
 *
 * Resolutions applied
 * ───────────────────
 * A  Higher SbtlRnk = more subtle.
 * B  'r×1ble' in move-like-king treated as r×1 (typo).
 * C  shared:no → separate atk/def qty pools; ledger key = (cheatId, ctx, pieceType).
 * D  canCheck field present on every cheat.
 * E  Context-varying values live in byCtx.
 * I  Material values: P=1 N=3 B=3 R=5 Q=9 K=100 (used by threshold values below).
 */

// ── CanMoveOdd (category budget: 5) ───────────────────────────────────────────

const CAN_MOVE_ODD = [

  {
    id:        'adjacent-landing',
    category:  'CanMoveOdd',
    pieces:    { n: 1, b: 1, p: 2 },
    ctx:       'atk',
    sbtlRnk:   7,
    adv:       3,
    threshold: { type: 'MxBen', value: 5 },
    canCheck:  false,
  },

  {
    id:       'move-like-bishop',
    category: 'CanMoveOdd',
    pieces:   { k: 1, r: 1, n: 1, p: 1 },
    ctx:      'both',
    // sbtlRnk / adv / threshold vary by context — stored in byCtx (resolution E)
    byCtx: {
      atk: { sbtlRnk: 5, adv: 5, threshold: { type: 'MxBen',  value: 4 } },
      def: { sbtlRnk: 6, adv: 4, threshold: { type: 'MnThrt', value: 5 } },
    },
    canCheck: false,
  },

  {
    id:       'move-like-rook',
    category: 'CanMoveOdd',
    pieces:   { b: 1, n: 1, p: 1 },
    ctx:      'both',
    byCtx: {
      atk: { sbtlRnk: 5, adv: 5, threshold: { type: 'MxBen',  value: 4 } },
      def: { sbtlRnk: 6, adv: 4, threshold: { type: 'MnThrt', value: 5 } },
    },
    canCheck: false,
  },

  {
    id:       'move-like-knight',
    category: 'CanMoveOdd',
    pieces:   { k: 1, q: 1, b: 1, r: 1, p: 1 },
    ctx:      'both',
    byCtx: {
      atk: { sbtlRnk: 4, adv: 6, threshold: { type: 'MxBen',  value: 5 } },
      def: { sbtlRnk: 5, adv: 5, threshold: { type: 'MnThrt', value: 6 } },
    },
    canCheck: true,
  },

  {
    id:        'move-like-king',
    category:  'CanMoveOdd',
    // r×1ble treated as r×1 per resolution B
    pieces:    { n: 1, b: 1, r: 1 },
    ctx:       'def',
    sbtlRnk:   8,
    adv:       2,
    threshold: { type: 'MnThrt', value: 7 },
    canCheck:  false,
  },

  {
    id:       'illegal-castle',
    category: 'CanMoveOdd',
    // "(global: 1 total)" — one combined use across n and b vehicles.
    // Modelled as a global pool of 1.  vehiclePieces tells the eligibility engine
    // which piece types may be the physical vehicle.
    pieces:        { global: 1 },
    vehiclePieces: ['n', 'b'],
    ctx:       'def',
    sbtlRnk:   3,
    adv:       4,
    threshold: { type: 'MnThrt', value: 6 },
    canCheck:  false,
  },

  {
    id:        'capture-reversal',
    category:  'CanMoveOdd',
    // "any×1" — each piece type gets one use as vehicle
    pieces:    { p: 1, n: 1, b: 1, r: 1, q: 1, k: 1 },
    ctx:       'def',
    sbtlRnk:   5,
    adv:       7,
    threshold: { type: 'MnThrt', value: 8 },
    canCheck:  false,
  },

];

// ── PrmtPiece (category budget: 3) ────────────────────────────────────────────

const PRMT_PIECE = [

  {
    id:        'emergency-queen',
    category:  'PrmtPiece',
    pieces:    { global: 1 },
    ctx:       'def',
    sbtlRnk:   2,
    adv:       8,
    threshold: null,                  // rescue-branch only — no eligibility threshold
    canCheck:  false,
    trigger:   'cpu-queen-taken',
  },

  {
    id:        'king-replacement',
    category:  'PrmtPiece',
    pieces:    { global: 1 },
    ctx:       'def',
    sbtlRnk:   1,
    adv:       10,
    threshold: null,                  // rescue-branch only
    canCheck:  false,
    trigger:   'king-captured',
  },

  {
    id:        'ghost-piece',
    category:  'PrmtPiece',
    pieces:    { p: 1, n: 1, b: 1 },
    ctx:       'atk',
    sbtlRnk:   3,
    adv:       7,
    threshold: { type: 'MxBen', value: 3 },
    canCheck:  true,
  },

  {
    id:        'mid-move-promotion',
    category:  'PrmtPiece',
    pieces:    { p: 1, n: 1, b: 1 },
    ctx:       'atk',
    sbtlRnk:   2,
    adv:       6,
    threshold: { type: 'MxBen', value: 4 },
    canCheck:  false,
  },

];

// ── Exports ────────────────────────────────────────────────────────────────────

export const CATALOGUE = [...CAN_MOVE_ODD, ...PRMT_PIECE];
