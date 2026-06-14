# Totally Legit Chess — Design Specification

## 1. Concept

A browser-based chess game where the CPU cheats in intermittent, undisclosed ways. The game
presents itself as a completely legitimate chess client. No commentary, no reveals, no winking UI.
The comedy is the player's slow arc from confusion → suspicion → certainty → outrage. British
humour. Straight face throughout. Ragebait by design.

---

## 2. Cheat Categories

### CanMoveOdd — odd movement cheats

**Category budget: 5**

Cheats where a CPU piece moves to a square it geometrically couldn't reach under legal rules.
The movement pattern of the piece is violated.

| cheat | pieces (qty) | ctx | SbtlRnk | Adv | MxBen / MnThrt | check? | shared |
|---|---|---|---|---|---|---|---|
| adjacent landing | n×1, b×1, p×2 | atk | 7 | 3 | MxBen: 5 | no | — |
| move like bishop | k×1, r×1, n×1, p×1 | both | atk: 5 / def: 6 | atk: 5 / def: 4 | atk MxBen: 4 / def MnThrt: 5 | no | no |
| move like rook | b×1, n×1, p×1 | both | atk: 5 / def: 6 | atk: 5 / def: 4 | atk MxBen: 4 / def MnThrt: 5 | no | no |
| move like knight | k×1, q×1, b×1, r×1, p×1 | both | atk: 4 / def: 5 | atk: 6 / def: 5 | atk MxBen: 5 / def MnThrt: 6 | yes | no |
| move like king | n×1, b×1, r×1 | def | 8 | 2 | MnThrt: 7 | no | — |
| illegal castle | n×1, b×1 (global: 1 total) | def | 3 | 4 | MnThrt: 6 | no | — |
| capture reversal | any×1 | def | 5 | 7 | MnThrt: 8 | no | — |

### PrmtPiece — illegal promotion cheats

**Category budget: 3**

Cheats involving illegal promotion conditions, ghost pieces, or mid-move upgrades.

| cheat | pieces (qty) | ctx | SbtlRnk | Adv | MxBen / MnThrt | check? | shared |
|---|---|---|---|---|---|---|---|
| emergency queen | global×1 (trigger: CPU queen taken) | def | 2 | 8 | — | no | — |
| king replacement | global×1 (trigger: king captured) | def | 1 | 10 | — | no | — |
| ghost piece | p×1, n×1, b×1 | atk | 3 | 7 | MxBen: 3 | yes | — |
| mid-move promotion | p×1, n×1, b×1 | atk | 2 | 6 | MxBen: 4 | no | — |

---

## 3. Budget System

- Category budget = shared pool per category, drained by 1 each time any cheat in that
  category fires
- Per-piece qty = maximum times a specific piece can be the vehicle for that cheat
- Both limits active simultaneously — either hitting 0 locks that cheat or category for the
  rest of the game
- Global ×1 cheats bypass piece assignment but still drain the category budget
- All budgets and qtys reset on new game only

---

## 4. Cheat Selection Algorithm

### Eligibility gates (all must pass)

1. Category budget > 0
2. Per-piece qty > 0 for the target piece
3. ctx matches current game state (atk / def / both)
4. For atk cheats: current board advantage ≤ MxBen (CPU not already winning too hard)
5. For def cheats: endangered piece material value ≥ MnThrt
6. canCheck guard: if canCheck is false, drop any target square that would deliver check
   to the player's king

### Scoring function (highest score wins)

Inputs: SbtlRnk, Adv, remaining category budget, remaining per-piece qty, threat level of
target piece.

General principle: subtlety is penalised under desperation; Adv is weighted higher when CPU
is under high threat. One cheat per CPU turn maximum.

### Scoring formula

```
MAX_RANK     = 10
blatancy     = (MAX_RANK - effectiveSbtlRnk) / MAX_RANK       // 0..1; low rank = blatant
advNorm      = effectiveAdv / 10                               // 0..1
threatNorm   = min(threatLevel, 10) / 10                       // 0..1; king saturates at 1
budgetScarc  = 1 - categoryBudget / categoryInitial            // 0..1
desperation  = clamp(W_THREAT*threatNorm + W_SCARCITY*budgetScarc, 0, 1)
approp       = 1 - abs(blatancy - desperation)                 // matched blatancy scores high
qtyFactor    = qty / qtyInitial                                // prefer not exhausting scarce vehicles

score = W_APP*approp
      + W_ADV*advNorm*(0.5 + 0.5*threatNorm)
      + W_QTY*qtyFactor
```

### Default tuning constants

```
W_THREAT   = 0.7
W_SCARCITY = 0.3
W_APP      = 1.0
W_ADV      = 0.8
W_QTY      = 0.1
fireThreshold = { medium: 1.00 }
```

### Difficulty modifiers

```
easy / hard:
  fireThreshold  -0.25   (fires more readily)
  W_ADV          +0.3    (values advantage more)
  MxBen ceilings +1      (easier for atk cheats to qualify)
  MnThrt floors  -1      (easier for def cheats to qualify)

medium: baseline — no modifiers
```

All three difficulties cause cheating. Easy and Hard both cheat more than Medium. No UI hint
that difficulty affects cheat behaviour.

---

## 5. Threat Level

- Defined as the material value of the most endangered CPU piece currently at risk
- Material values: P=1, N=3, B=3, R=5, Q=9, K=100
- No endangered piece = threat level 0 = no defensive cheats can fire
- Forked king + rook = threat level 100 (king takes priority)
- King in check = threat level 100 automatically

### Threat detection method (turn-flip)

Take the current FEN, swap the active-colour field to the player's colour, set en-passant to
`-`, load into a scratch Chess instance with `{skipValidation:true}`, generate all player
moves, collect every move whose captured piece lands on a CPU piece. A CPU piece is endangered
if attacked AND (undefended OR attacker value < victim value) — depth-1 profitable-capture
heuristic.

---

## 6. Cheat Escalation

Emergent, not scripted. The scoring function naturally surfaces subtle cheats during low-stakes
moments and obvious/high-Adv cheats during desperation (high threat, low remaining budget).
No separate escalation system required.

---

## 7. Chess Engine

chess.js@1.0.0 (vendored ESM) for legal move generation and game state tracking.

CPU heuristic: prioritise captures by material value, otherwise random legal move.

The cheat layer intercepts the CPU's chosen move and mutates it before execution. No external
engine — no Stockfish, no lichess.

### Board mutation method

- Movement cheats: `chess.remove(from)`, `chess.remove(to)` if occupied,
  `chess.put({type, color}, to)`
- After mutation: rebuild FEN explicitly from `chess.board()`, set active colour to player,
  castling rights pruned, en-passant `-`, load with `chess.load(fen, {skipValidation:true})`
- Fallback if skipValidation unsupported: `chess.clear()` + per-piece `chess.put()` to set
  the rigged position manually
- SAN notation for cheated moves: recorded as-if legal

### Pipeline entry point

`engine.processCpuTurn(chess, ledger, difficulty)` returns one of:

- `{ kind: "honest", move }` — normal legal move
- `{ kind: "cheat", cheatId, fen, notation, diff }` — forced mutation
- `{ kind: "concede" }` — no legal move and no affordable rescue

### Per-turn pipeline

```
processCpuTurn(chess, ledger, difficulty):
  metrics      = computeMetrics(chess)
  if metrics.cpuHasNoLegalMove:
    return tryRescue(chess, ledger, metrics, difficulty)   // rescue branch
  baseMove     = cpu.chooseHonestMove(chess)
  applications = enumerateEligible(chess, ledger, metrics, difficulty)
  best         = selectBest(applications, metrics, ledger, difficulty)
  if best is null OR best.score < fireThreshold(difficulty):
    return { kind: "honest", move: baseMove }
  result       = mutate.apply(chess, best)
  ledger.spend(best.cheatId, best.ctx, best.pieceType)
  return { kind: "cheat", ...result }
```

### Rescue branch

When the CPU has no legal moves (checkmate/stalemate), attempt rescue before conceding:
king replacement first, then emergency queen. Only fires if the relevant cheat is still
affordable. Failed rescue does not spend budget.

---

## 8. Player Experience

- The game never acknowledges cheating at any point — during game, after game, or anywhere
  in the UI
- Cheats execute with identical visual weight to legal moves — no special animations, sounds,
  or indicators
- No post-game summary or reveal of any kind
- The UI presents as a completely legitimate chess client at all times
- The player must figure it out themselves
- No console.log statements that reference cheat state — the game must never leak its rigged
  nature even in dev tooling

---

## 9. Win Conditions

- The player can genuinely win — cheats are budget-capped and scoring-gated, so a skilled
  player can outplay bad cheat decisions
- The CPU is not designed to be unbeatable; it cheats opportunistically based on board state
- King replacement and emergency queen are desperation moves that burn budget and may not save
  the game if the player is far enough ahead
- When all rescue options are exhausted: `{ kind: "concede" }` — player wins legitimately

---

## 10. UI Scope

Full match client UI:

- Chess board with legal move highlighting
- Move history in standard algebraic notation (illegal moves recorded as-if legal)
- Captured pieces display
- Player name / CPU name
- Running clock (count-up, no flagging)
- Fake difficulty selector: Easy / Medium / Hard (locked mid-game, resets on new game)

### Fake difficulty behaviour

- All three settings cause the CPU to cheat
- Easy and Hard increase cheat frequency relative to Medium
- No UI indication that difficulty affects cheat behaviour
- Completely straight-faced

---

## 11. Aesthetic

Clean, serious chess client. The more legitimate it looks, the funnier the cheating is.
No comedy in the visual design whatsoever.

---

## 12. Spec Ambiguity Resolutions (binding)

| # | Resolution |
|---|---|
| A | Higher SbtlRnk = more subtle. 0 = obvious, 10 = invisible. Blatancy = `(10 - SbtlRnk) / 10`. |
| B | `r×1ble` in move like king piece list treated as `r×1` (typo). Confirm if second rook or special flag was intended — does not block implementation. |
| C | `shared: no` means atk/def use separate qty pools. Ledger key is `(cheatId, ctx, pieceType)`. Since all populated values are `no`, no joint-pool logic is needed. |
| D | `canCheck: false` means the cheat must not deliver check to the player's king. Eligibility drops any target square that would give check. |
| E | Context-varying values stored as `byCtx: { atk:{...}, def:{...} }`. Effective value selected by `metrics.context` at decision time. |
| F | Turn classification is binary: `def` if `threatLevel > 0`, else `atk`. A `both` cheat is eligible on either. Tunable in playtest. |
| G | Intermittency via `fireThreshold`: top-scoring cheat fires only if `score >= threshold`, else CPU plays honest. Low-stakes turns score low naturally — no separate probability system needed. |
| H | Rescue branch fires at the start of `processCpuTurn` when `cpuHasNoLegalMove`. King replacement attempted before emergency queen. Failed rescue does not spend budget. |
| I | Material values: P=1, N=3, B=3, R=5, Q=9, K=100. `boardAdvantage = cpuMaterial - playerMaterial` in pawns. `threatLevel = max value among endangered CPU pieces`. |

---

## 13. File Structure

```
index.html
styles.css
ROADMAP.md                    Phased implementation plan
SPEC.md                       This file
package.json                  { "type": "module" }
lib/chess.js                  Vendored chess.js@1.0.0 ESM build
src/main.js                   Bootstraps game on DOMContentLoaded
src/game.js                   Match orchestration: turn loop, input, win/draw, difficulty
src/cpu.js                    Honest CPU heuristic + no-legal-move detect
src/board-view.js             Rendering: board, pieces, highlights, move list, clock, captures
src/engine/catalogue.js       Static cheat definitions (structured data, no logic)
src/engine/budgets.js         Ledger: category budgets + per-(cheat,ctx,piece) qty
src/engine/metrics.js         Material, boardAdvantage, threat map, threatLevel, context
src/engine/eligibility.js     Five-gate filter → concrete applications
src/engine/scoring.js         score() + selectBest()
src/engine/mutate.js          Forced board mutation + SAN-as-if-legal + diff
src/engine/engine.js          processCpuTurn orchestration + rescue branch
src/engine/tuning.js          All coefficients, fireThreshold, per-difficulty modifiers
tests/                        node --test unit tests (one per logic module)
```
