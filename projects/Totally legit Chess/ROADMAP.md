# Totally Legit Chess — Rigged Cheat Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Environment note:** This machine runs SentinelOne EDR. Before executing any phase that runs code, invoke `anthropic-skills:safe-for-s1`. Tests use `node --test` invoked on demand (short-lived, EDR-friendly). Do **not** leave long-running dev servers up; for manual UI checks, open `index.html` over `file://` or a brief, manually-killed `python -m http.server`.

**Goal:** Ship a static, single-page chess client that looks completely legitimate but whose CPU cheats intermittently and silently, driven by a budget-capped, scoring-gated cheat engine.

**Architecture:** Vanilla ESM modules. chess.js owns legal game state for honest play and for player-move generation; a separate **cheat layer** intercepts the CPU's turn, decides whether/what to cheat via a deterministic scoring engine, and force-mutates the board (bypassing chess.js legality) while keeping chess.js re-synchronised so the player can keep playing. Pure-logic modules are unit-tested headless in Node; UI is integration/manual.

**Tech Stack:** HTML/CSS/vanilla JS (ES modules), `chess.js@1.0.0` (vendored ESM), `node --test` for unit tests, no build system, no framework, no backend. Static deploy (GitHub Pages / Vercel).

---

## 0. Spec ambiguities resolved before planning

The spec uses compact table notation. These points were under-specified; each is **resolved here as a binding assumption** so the plan has zero ambiguity. Flagged ⚠️ items are worth a one-line confirmation from the product owner but do not block implementation.

| # | Ambiguity | Resolution (binding) |
|---|---|---|
| A | **SbtlRnk direction** — does a high number mean more or less subtle? | **Higher SbtlRnk = more subtle.** Evidenced by `king replacement` (SbtlRnk 1 = blatant, Adv 10) vs `move like king` (SbtlRnk 8 = subtle, Adv 2). Blatancy = `(MAX_RANK - SbtlRnk)/MAX_RANK`, `MAX_RANK=10`. |
| B | `move like king` piece list contains **`r×1ble`** | ⚠️ Treated as `r×1` (typo for the "ble" fragment). Confirm whether a second rook or a special flag was intended. Does not change architecture. |
| C | **`shared` column** (only on the three `move like X` both-context cheats, value `no`) | `shared:no` ⇒ atk and def applications of the same cheat keep **separate** per-piece qty pools. Since every populated value is `no`, the ledger key is simply `(cheatId, ctx, pieceType)`; no joint-pool logic is needed. |
| D | **`check?` column** | Interpreted as `canCheck`: whether a cheated move is **allowed to deliver check** to the player's king. If `canCheck=false`, eligibility must reject any target square/move that would give check (prevents suspicious instant mates from subtle cheats). |
| E | **Context-varying values** (e.g. `atk:5/def:6`) | Stored as `byCtx: { atk:{...}, def:{...} }`. The "effective" SbtlRnk/Adv/threshold is selected by the turn's resolved context. |
| F | **atk vs def turn classification** (gate 3 "ctx matches current game state") | Binary per turn: **def turn if `threatLevel > 0`, else atk turn.** A `both` cheat is eligible on either. ⚠️ Tunable in playtest; documented as a Phase-5 key decision. |
| G | **Intermittency mechanism** — nothing in the spec stops the engine firing every turn until budgets drain | Add a **`fireThreshold`**: the top-scoring cheat fires only if its score ≥ threshold, else the CPU plays honest. Low-stakes turns naturally score low ⇒ cheats are intermittent. Difficulty lowers the threshold. No separate probability system (keeps escalation emergent, per §6). |
| H | **`king replacement` / `emergency queen` triggers** (king/queen captured) | Unified into the CPU-turn pipeline as a **rescue branch**: when it is the CPU's turn and the position is checkmate/stalemate (no legal move) or the CPU has just lost its queen, the engine attempts the matching desperation cheat *before* conceding game-over. No separate event hook on player moves. |
| I | **"board advantage" / "threat level" units** | Material only. `P1 N3 B3 R5 Q9 K100`. `boardAdvantage = Σ(CPU material) − Σ(player material)` in pawns. `threatLevel = max material value among endangered CPU pieces` (0 if none). |

---

## 1. Architecture deep-dive: the cheat scoring engine

This is the most complex subsystem. It is fully specified here so its implementation phases (4–7) are mechanical.

### 1.1 Two interception points, one entry function

Everything routes through **`engine.processCpuTurn(chess, ledger, difficulty)`**, called by the game loop whenever it is the CPU's move. It returns one of:

- `{ kind: "honest", move }` — a normal chess.js move object, or
- `{ kind: "cheat", cheatId, fen, notation, diff }` — a forced board mutation + how to render/record it, or
- `{ kind: "concede" }` — genuinely no legal move and no affordable rescue ⇒ the player has actually won.

There is **no** separate post-player-move hook. The "king/queen captured" triggers are handled by the **rescue branch** at the top of `processCpuTurn` (resolution H): the game loop, after the player moves, checks game-over; if the CPU is mated it *still* calls `processCpuTurn`, giving the engine its chance to cheat the king out of mate before the app declares a loss.

### 1.2 Per-turn pipeline

```
processCpuTurn(chess, ledger, difficulty):
  metrics      = computeMetrics(chess)              // §1.3
  if metrics.cpuHasNoLegalMove:                      // mate/stalemate -> rescue branch
      return tryRescue(chess, ledger, metrics, difficulty)   // king replacement / emergency queen
  baseMove     = cpu.chooseHonestMove(chess)         // capture-by-value else random
  applications = enumerateEligible(chess, ledger, metrics, difficulty)   // §1.4 (Phase 4)
  best         = selectBest(applications, metrics, ledger, difficulty)   // §1.5 (Phase 5)
  if best is null OR best.score < fireThreshold(difficulty):
      return { kind:"honest", move: baseMove }
  result       = mutate.apply(chess, best)           // §1.6 (Phase 6)
  ledger.spend(best.cheatId, best.ctx, best.pieceType)
  return { kind:"cheat", ...result }
```

One cheat per CPU turn, maximum (spec §4).

### 1.3 Board metrics (`metrics.js`, Phase 3)

`computeMetrics(chess)` returns:

| field | meaning | computation |
|---|---|---|
| `cpuMaterial`, `playerMaterial` | summed piece values | iterate `chess.board()` |
| `boardAdvantage` | `cpuMaterial − playerMaterial` (resolution I) | subtraction |
| `threats` | array of `{ square, pieceType, value }` for endangered CPU pieces | **turn-flip method** below |
| `threatLevel` | `max(threats.value)` or `0` | reduce |
| `context` | `"def"` if `threatLevel>0` else `"atk"` (resolution F) | derive |
| `cpuHasNoLegalMove` | `chess.moves().length === 0` on CPU's turn | chess.js |

**Turn-flip threat detection** (version-stable, no reliance on `attackers()`): take `chess.fen()`, swap the active-colour field to the player's colour, set the en-passant field to `-`, `load(fen, {skipValidation:true})` into a scratch `Chess`, generate `moves({verbose:true})`, and collect every move whose `.captured` lands on a CPU piece. A CPU piece counts as **endangered** if attacked by a player piece **and** (undefended **or** attacker value < victim value) — a "profitable or free capture" heuristic. King-in-check yields `threatLevel = 100` automatically (resolution I; handles the forked king+rook = 100 case).

### 1.4 Eligibility (`eligibility.js`, Phase 4)

`enumerateEligible(...)` expands the catalogue into concrete **applications** — one per `(cheat, eligible piece instance, candidate target square/move)` — and keeps only those passing **all five gates**:

1. `ledger.categoryBudget(cheat.category) > 0`
2. `ledger.qty(cheat.id, ctx, pieceType) > 0`
3. `cheat.ctx === metrics.context || cheat.ctx === "both"` (resolution F)
4. atk cheats: `metrics.boardAdvantage ≤ effective(MxBen)`
5. def cheats: `metrics.threatLevel ≥ effective(MnThrt)`
6. **`canCheck` guard** (resolution D): if `cheat.canCheck === false`, drop any target that would deliver check.

An **application** is `{ cheatId, category, ctx, pieceType, fromSquare, toSquare, effectiveSbtlRnk, effectiveAdv }`. Movement cheats (`CanMoveOdd`) enumerate the illegal-but-geometrically-described target squares for the named piece type (e.g. a knight moving "like a bishop" enumerates diagonal rays from the knight's square). Promotion/global cheats enumerate their fixed effect (spawn square, upgrade target).

### 1.5 Scoring & selection (`scoring.js` + `tuning.js`, Phase 5)

Implements §4's principles — *"subtlety penalised under desperation; Adv weighted higher under high threat"* — and §6's emergent escalation as a **blatancy-to-desperation match**.

```
MAX_RANK = 10
blatancy(app)   = (MAX_RANK - app.effectiveSbtlRnk) / MAX_RANK         // 0..~1 ; low rank = blatant
advNorm(app)    = app.effectiveAdv / 10                                 // 0..1
threatNorm      = min(metrics.threatLevel, 10) / 10                     // 0..1, king saturates at 1
budgetScarcity  = 1 - ledger.categoryBudget(cat) / ledger.categoryInitial(cat)   // 0..1
desperation     = clamp(W_THREAT*threatNorm + W_SCARCITY*budgetScarcity, 0, 1)
appropriateness = 1 - abs(blatancy(app) - desperation)                  // matched blatancy scores high
qtyFactor       = ledger.qty(app...) / ledger.qtyInitial(app...)        // prefer not exhausting scarce vehicles

score(app) = W_APP*appropriateness
           + W_ADV*advNorm*(0.5 + 0.5*threatNorm)
           + W_QTY*qtyFactor
```

`selectBest` returns the max-scoring application, or `null` if none. The engine fires it only if `score ≥ fireThreshold` (resolution G).

**Default tuning constants** (`tuning.js`, all overridable per difficulty):
```
W_THREAT=0.7  W_SCARCITY=0.3  W_APP=1.0  W_ADV=0.8  W_QTY=0.1
fireThreshold: { medium: 1.00 }
```
**Difficulty modifiers** (§10 — Easy & Hard both cheat *more* than Medium):
```
easy/hard:  fireThreshold -0.25 ; W_ADV +0.3 ; MxBen ceilings +1 (easier to qualify) ;
            MnThrt floors -1 (easier to qualify)
medium:     baseline
```
This makes calm/even turns surface subtle low-Adv cheats and desperate (high-threat, low-budget) turns surface blatant high-Adv cheats — escalation without a scripted system.

### 1.6 Execution / board mutation (`mutate.js`, Phase 6)

`apply(chess, app)` performs a **forced mutation** that chess.js would reject, then re-synchronises chess.js so the player can move legally next. Per-cheat handlers:

- **Movement (`CanMoveOdd`)**: `chess.remove(fromSquare)`; `chess.remove(toSquare)` (capture if occupied); `chess.put({type,color}, toSquare)`.
- **`ghost piece` / `mid-move promotion`**: place/upgrade a piece on the target square.
- **`emergency queen`**: place a queen on a chosen safe CPU square (rescue branch).
- **`king replacement`**: relocate the CPU king to a safe square (illegal king move) or remove the checking piece, so the position is no longer mate (rescue branch).

After mutation, build a FEN explicitly (board from `chess.board()`, active colour = player, castling rights pruned to remaining rooks/kings, en-passant `-`, halfmove `0`, fullmove preserved) and `chess.load(fen, {skipValidation:true})`. Return `{ fen, notation, diff }` where `notation` is SAN-as-if-legal (spec §10: illegal moves recorded as-if legal) and `diff` is the list of square changes for the renderer.

> ⚠️ **Single biggest technical risk:** `skipValidation` must allow "impossible" positions (>8 pawns, kings adjacent, player in check from an impossible vector). Phase 6 verifies the pinned chess.js honours `{skipValidation:true}` on `load`; documented fallback is `clear()` + per-piece `put()` to set the rigged position when `load` rejects it.

---

## 2. File structure

All paths relative to `projects/Totally legit Chess/`.

```
index.html                 App shell; loads lib/chess.js + src/main.js as modules
styles.css                 Clean, serious chess-client styling (no comedy)
package.json               { "type":"module" }, chess.js@1.0.0 devDependency for tests
lib/chess.js               Vendored chess.js@1.0.0 ESM build (browser + node import)
src/main.js                Bootstraps the game on DOMContentLoaded
src/game.js                Match orchestration: turn loop, player input, win/draw, difficulty
src/cpu.js                 Honest CPU heuristic (capture-by-value else random) + no-legal-move detect
src/board-view.js          Rendering: board, pieces, highlights, animations, captures, move list, clock
src/engine/catalogue.js    Static cheat definitions (the two tables, as structured data)
src/engine/budgets.js      Ledger: category budgets + per-(cheat,ctx,piece) qty; spend/check/reset
src/engine/metrics.js      Material, boardAdvantage, threat map, threatLevel, context
src/engine/eligibility.js  Five-gate filter -> concrete applications
src/engine/scoring.js      Scoring + selectBest
src/engine/mutate.js       Forced board mutation + SAN-as-if-legal + diff
src/engine/engine.js       processCpuTurn orchestration + rescue branch
src/engine/tuning.js       All coefficients, fireThreshold, per-difficulty modifiers
tests/*.test.mjs           node --test files, one per logic module
```

Files that change together live together (`src/engine/*`). UI (`board-view`, `game`) is isolated from logic so logic stays headless-testable.

---

## 3. Phased plan

Each phase produces working, testable software on its own. Bottom-up within the cheat layer; the **legitimate client is built first** because the comedy depends on it.

---

### Phase 0 — Project skeleton & test harness
**Goal:** A static page renders the chess.js starting position on a clean board, and `node --test` runs green on a smoke test.
**Deliverables:**
- `index.html`, `styles.css`, `src/main.js`, `src/board-view.js` (render-only), `package.json` (`type:module`), vendored `lib/chess.js@1.0.0`.
- `tests/smoke.test.mjs` importing chess.js and asserting the start FEN.
- Board renders 8×8 with pieces from `chess.board()`; no interaction yet.
**Dependencies:** None.
**Key decisions:** Coordinate origin (a8 top-left, white at bottom); piece glyph source (Unicode vs SVG sprite — default Unicode for zero assets); confirm chess.js ESM import path works under both browser `<script type=module>` and `node --test`.
**Acceptance criteria:** Opening `index.html` shows the start position; `node --test tests/smoke.test.mjs` passes; no console errors.

---

### Phase 1 — Honest, fully playable chess client
**Goal:** A human can play a complete legal game against an honest CPU, with all match-client UI present.
**Deliverables:**
- `src/cpu.js`: `chooseHonestMove(chess)` — highest-material capture, else uniform-random legal move; deterministic via injectable RNG for tests.
- `src/game.js`: turn loop, player input (click-source → legal-target highlight → click-target), CPU response, win/draw/checkmate/stalemate detection.
- `src/board-view.js` extended: legal-move highlighting, move history in SAN, captured-pieces tray, player/CPU name labels, running clock, **fake difficulty selector (Easy/Medium/Hard)** — cosmetic this phase.
- Tests: `tests/cpu.test.mjs` (prefers a free queen capture over a quiet move; falls back to random with seeded RNG; returns null at checkmate).
**Dependencies:** Phase 0.
**Key decisions:** Clock format (count-up vs fixed countdown — default count-up, no flagging logic); promotion UI for the *player* (default auto-queen with a small picker); whether difficulty selector is locked mid-game (default: locked until new game).
**Acceptance criteria:** A full legal game is playable to checkmate/draw; move list, captures, clock, names, and difficulty selector all update correctly; the client is visually indistinguishable from a legitimate one (no cheating yet); CPU tests pass.

---

### Phase 2 — Cheat catalogue & budget ledger
**Goal:** Both cheat tables exist as validated data, and the budget/qty ledger passes unit tests for init, spend, lock-at-zero, and reset.
**Deliverables:**
- `src/engine/catalogue.js`: every cheat as `{ id, category, pieces:{type:qty}|{global:1}, ctx, byCtx?, sbtlRnk, adv, threshold:{type:'MxBen'|'MnThrt', value}, canCheck, trigger? }`. Encodes resolutions A–E, I (context-varying values in `byCtx`; `r→1`).
- `src/engine/budgets.js`: `createLedger(catalogue)`, `categoryBudget(cat)`, `qty(cheatId,ctx,pieceType)`, `spend(cheatId,ctx,pieceType)` (decrements both category and qty), `isCheatLocked(cheatId)`, `reset()`. Category budgets: `CanMoveOdd=5`, `PrmtPiece=3`. Key = `(cheatId,ctx,pieceType)` per resolution C.
- Tests: `tests/budgets.test.mjs` — category drains across different cheats in the same category; hitting category 0 locks all cheats in it; hitting a piece qty 0 locks only that vehicle; `reset()` restores all; global×1 cheats drain category without a piece key.
**Dependencies:** Phase 0.
**Key decisions:** Representation of global×1 cheats in the qty map (default: sentinel piece key `"global"`); whether `reset()` is the only reset path (yes — budgets reset on new game only, spec §3).
**Acceptance criteria:** `tests/budgets.test.mjs` passes; catalogue round-trips every row from the spec tables with correct numbers.

---

### Phase 3 — Board metrics & threat model
**Goal:** `computeMetrics` returns correct material, advantage, threat map, threat level, and context on curated FENs.
**Deliverables:**
- `src/engine/metrics.js`: `computeMetrics(chess)` per §1.3, incl. turn-flip threat detection and the profitable/free-capture endangerment rule.
- Tests: `tests/metrics.test.mjs` with hand-built FENs — (a) nothing hanging ⇒ `threatLevel 0`, `context "atk"`; (b) CPU queen attacked by a pawn, undefended ⇒ `threatLevel 9`, `context "def"`; (c) CPU king in check ⇒ `threatLevel 100`; (d) forked king+rook ⇒ `threatLevel 100` (king priority); (e) equal material ⇒ `boardAdvantage 0`; (f) CPU up a rook ⇒ `boardAdvantage 5`.
**Dependencies:** Phases 0, 2 (piece values).
**Key decisions:** Defended-piece detection method (default: a CPU square is "defended" if a CPU piece can recapture, computed via a second turn-flip on the player-capture target); whether multi-attacker/SEE depth matters (default: depth-1 profitable-capture heuristic only — sufficient for comedy, documented as tunable).
**Acceptance criteria:** All six metric scenarios pass; threat detection works without relying on any chess.js `attackers()` API.

---

### Phase 4 — Eligibility gates
**Goal:** `enumerateEligible` produces only applications passing all five gates plus the `canCheck` guard, on curated positions.
**Deliverables:**
- `src/engine/eligibility.js`: `enumerateEligible(chess, ledger, metrics, difficulty)` → `Application[]` per §1.4, including per-cheat target enumeration for movement cheats and `canCheck` filtering (resolution D). Applies difficulty modifiers to MxBen/MnThrt thresholds.
- Tests: `tests/eligibility.test.mjs` — (a) atk cheat excluded when `boardAdvantage > MxBen`; (b) def cheat excluded when `threatLevel < MnThrt`; (c) cheat excluded when category budget 0; (d) cheat excluded when piece qty 0; (e) `both` cheat eligible in both contexts; (f) `canCheck:false` cheat drops checking targets but keeps non-checking ones; (g) Hard difficulty admits a cheat that Medium rejects (raised MxBen / lowered MnThrt).
**Dependencies:** Phases 2, 3.
**Key decisions:** Cap on enumerated targets per cheat to bound cost (default: all geometric targets — board is tiny); how `both` cheats pick their effective `byCtx` block (by `metrics.context`).
**Acceptance criteria:** All seven eligibility scenarios pass; output applications carry correct `effectiveSbtlRnk`/`effectiveAdv` for the resolved context.

---

### Phase 5 — Scoring & selection (engine brain)
**Goal:** `selectBest` chooses the cheat whose blatancy matches desperation, weights Adv under threat, and the fire-threshold gate makes cheats intermittent — all unit-tested.
**Deliverables:**
- `src/engine/tuning.js`: constants + per-difficulty modifiers from §1.5.
- `src/engine/scoring.js`: `score(app, metrics, ledger)`, `selectBest(applications, metrics, ledger)`, `fireThreshold(difficulty)`.
- Tests: `tests/scoring.test.mjs` — (a) calm even board: a high-SbtlRnk (subtle) application outscores a low-SbtlRnk (blatant) one; (b) high threat (queen/king hanging): a blatant high-Adv application outscores a subtle one; (c) empty application list ⇒ `selectBest` returns null; (d) best score below `fireThreshold` ⇒ engine plays honest (assert via the threshold helper); (e) Easy/Hard fire at a score where Medium would not.
**Dependencies:** Phase 4.
**Key decisions (surfaced here):** Final coefficient values (tuned in Phase 9 playtest); **resolution F** (binary atk/def turn) — confirm it feels right or switch to "atk always active, def when threatened"; whether `fireThreshold` should also scale with move number to avoid early-game cheating (default: no — emergent only).
**Acceptance criteria:** All five scoring scenarios pass; selection is deterministic given fixed inputs.

---

### Phase 6 — Cheat execution / board mutation
**Goal:** `mutate.apply` executes every cheat type as a forced mutation, returns FEN + SAN-as-if-legal + render diff, and leaves chess.js in a state where the player can legally move.
**Deliverables:**
- `src/engine/mutate.js`: per-cheat handlers (movement, ghost piece, mid-move promotion, emergency queen, king replacement) per §1.6; explicit FEN rebuild; `load(fen,{skipValidation:true})`; SAN-as-if-legal generator; `diff` builder.
- Tests: `tests/mutate.test.mjs` — for each handler: (a) board reflects the illegal change; (b) chess.js re-synchronises with player to move and `chess.moves().length > 0`; (c) movement cheat that lands on a player piece records a capture in notation; (d) emergency queen adds exactly one CPU queen; (e) king replacement moves the king off a mating square so `isCheckmate()` is false; (f) a rigged position with 9 pawns loads without throwing.
**Dependencies:** Phase 4 (application shape). Logically after Phase 5 (needs a chosen application), but handlers can be built against hand-made applications.
**Key decisions (surfaced here):** **Confirm `{skipValidation:true}` support** in pinned chess.js; if absent, use the documented `clear()`+`put()` fallback. Castling-rights pruning rules after a king/rook is teleported. SAN disambiguation for spawned pieces.
**Acceptance criteria:** All six mutation scenarios pass; no scenario throws on an "impossible" position; player can always move after any mutation.

---

### Phase 7 — Engine orchestration + rescue branch
**Goal:** `processCpuTurn` ties the pipeline together, including the checkmate/queen-loss rescue branch, and passes scripted-game integration tests headlessly.
**Deliverables:**
- `src/engine/engine.js`: `processCpuTurn(chess, ledger, difficulty)` per §1.2; `tryRescue(...)` for king replacement / emergency queen (resolution H); returns `honest` | `cheat` | `concede`; spends budget on fire.
- Tests: `tests/engine.test.mjs` — (a) calm position with a subtle cheat available and score ≥ threshold ⇒ returns `cheat` and decrements both budgets; (b) calm position, all scores below threshold ⇒ returns `honest`; (c) CPU checkmated but king-replacement affordable ⇒ rescue returns `cheat` and position is no longer mate; (d) CPU checkmated and PrmtPiece budget exhausted ⇒ returns `concede`; (e) budget exhaustion across a scripted sequence locks the category; (f) never returns two cheats for one call.
**Dependencies:** Phases 2–6.
**Key decisions:** Rescue priority order (king replacement before emergency queen); whether a failed rescue still spends budget (default: no — only successful mutations spend).
**Acceptance criteria:** All six engine scenarios pass; a scripted 20-move game runs end-to-end headless with budgets respected and at most one cheat per CPU turn.

---

### Phase 8 — Wire the engine into the live client
**Goal:** The CPU in the real UI cheats per the engine, with cheated moves rendered identically to legal ones and recorded as-if legal.
**Deliverables:**
- `src/game.js`: replace the honest CPU call with `engine.processCpuTurn`; apply `honest` via chess.js, `cheat` via the returned FEN/diff, `concede` ⇒ player wins.
- `src/board-view.js`: render the `diff` — animate illegal-path moves with the *same* tween as legal moves; render spawns/teleports (piece simply appears/relocates, no special effect — spec §8); append `notation` to the SAN move list; update captured tray from the diff.
- Difficulty selector wired to `tuning` modifiers (Easy/Hard cheat more; no UI hint — spec §10).
**Dependencies:** Phases 1, 7.
**Key decisions:** Animation duration parity (cheated and legal moves must share one timing constant); how a captured-by-cheat player piece flows into the captured tray; ensuring no dev-only logging leaks the cheat to the console (strip/inert in production).
**Acceptance criteria:** Playing a real game, the CPU occasionally makes illegal moves that animate and record exactly like legal ones; no UI element ever acknowledges cheating; difficulty changes cheat frequency with no visible indication; the player can still genuinely win.

---

### Phase 9 — Tuning, legitimacy hardening & deploy
**Goal:** Coefficients tuned to feel "occasional then escalating," all illegal-position edge cases are crash-free and silent, and the site is deployed.
**Deliverables:**
- Tuned `tuning.js` (from playtest notes).
- Hardening: >8 pawns render correctly; two adjacent kings don't crash chess.js sync; en-passant/castling FEN edge cases after mutation; king replacement when genuinely unsaveable falls back to a clean, honest loss; rapid difficulty switches between games reset budgets.
- QA checklist confirming spec §§8–11 (no reveal anywhere; identical visual weight; straight-faced aesthetic).
- Static deploy to GitHub Pages / Vercel.
**Dependencies:** Phase 8.
**Key decisions:** Final fireThreshold/W_ADV per difficulty; how aggressive Easy/Hard should feel relative to Medium; deploy target.
**Acceptance criteria:** A 10-game playtest shows the confusion→suspicion→certainty arc; no console errors or visual flicker on any cheat; no element of the UI ever references cheating; live URL serves the working game.

---

## 4. Self-review against the spec

| Spec section | Covered by |
|---|---|
| §2 Cheat categories & tables | Phase 2 catalogue (resolutions A–E, I) |
| §3 Budget system (category + per-piece, lock-at-zero, reset on new game) | Phase 2 ledger |
| §4 Eligibility gates 1–5 | Phase 4 |
| §4 Scoring function (inputs, principles, one cheat/turn) | Phase 5 (§1.5) + Phase 7 |
| §5 Threat level (values, 0 = no def cheats, forked king=100) | Phase 3 |
| §6 Emergent escalation | Phase 5 appropriateness/desperation model |
| §7 chess.js, capture-by-value heuristic, interception | Phases 1, 6, 7 |
| §8 Never acknowledge; identical visual weight; no reveal | Phase 8 + Phase 9 QA |
| §9 Player can genuinely win; desperation moves burn budget | Phases 7 (`concede`), 8 |
| §10 Full match UI; fake difficulty affecting cheating silently | Phases 1, 8 |
| §11 Clean serious aesthetic | Phases 0, 1, 9 |

**Open ⚠️ confirmations (non-blocking):** B (`r×1ble`), D (`canCheck` semantics), F (binary atk/def classification). Each has a binding default; confirm during Phase 5/6.
