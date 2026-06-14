import { processCpuTurn } from './engine/engine.js';
import { createLedger }   from './engine/budgets.js';
import { CATALOGUE }      from './engine/catalogue.js';

const PLAYER = 'w';
const CPU    = 'b';
const CPU_DELAY_MS = 350;

const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];
const GLYPHS_W = { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' };
const GLYPHS_B = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };

function buildMoveDiff(move) {
  const diff = [
    { square: move.from, piece: null },
    { square: move.to,   piece: { type: move.promotion ?? move.piece, color: move.color } },
  ];
  if (move.flags.includes('e')) {
    const epRank = move.color === 'w' ? +move.to[1] - 1 : +move.to[1] + 1;
    diff.push({ square: move.to[0] + epRank, piece: null });
  }
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank     = move.color === 'w' ? '1' : '8';
    const [rf, rt] = move.flags.includes('k') ? ['h', 'f'] : ['a', 'd'];
    diff.push({ square: rf + rank, piece: null });
    diff.push({ square: rt + rank, piece: { type: 'r', color: move.color } });
  }
  return diff;
}

function deriveMoveSquares(diff) {
  const from = diff.find(d => d.piece === null)?.square                              ?? null;
  const to   = diff.find(d => d.piece !== null && d.piece.color === CPU)?.square     ?? null;
  return { from, to };
}

export class Game {
  #chess;
  #view;
  #difficulty   = 'medium';
  #selected     = null;
  #legalMoves   = [];
  #gameOver     = false;
  #awaitingCpu  = false;
  #pendingPromotion = null;
  #clockSeconds = { w: 0, b: 0 };
  #clockInterval = null;
  #capturedByPlayer = [];
  #capturedByCpu    = [];
  #ledger       = null;
  #moveCount    = 0;
  #lastMoveFrom = null;
  #lastMoveTo   = null;

  constructor(chess, view) {
    this.#chess = chess;
    this.#view  = view;
    this.#bindUI();
    this.#startNewGame();
  }

  // ── UI wiring ──────────────────────────────────────────

  #bindUI() {
    document.getElementById('board')?.addEventListener('click', e => {
      const sqEl = e.target.closest('[data-square]');
      if (sqEl) this.#onSquareClick(sqEl.dataset.square);
    });

    document.getElementById('btn-new-game')?.addEventListener('click',
      () => this.#startNewGame());
    document.getElementById('btn-play-again')?.addEventListener('click',
      () => this.#startNewGame());
    document.getElementById('btn-resign')?.addEventListener('click',
      () => this.#resign());

    for (const btn of document.querySelectorAll('.diff-btn')) {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.#difficulty = btn.dataset.diff;
      });
    }
  }

  // ── Game lifecycle ─────────────────────────────────────

  #startNewGame() {
    this.#chess.reset();
    this.#ledger          = createLedger(CATALOGUE);
    this.#gameOver        = false;
    this.#awaitingCpu     = false;
    this.#selected        = null;
    this.#legalMoves      = [];
    this.#pendingPromotion = null;
    this.#capturedByPlayer = [];
    this.#capturedByCpu    = [];
    this.#clockSeconds    = { w: 0, b: 0 };
    this.#moveCount       = 0;
    this.#lastMoveFrom    = null;
    this.#lastMoveTo      = null;

    this.#view.hideResult();
    this.#view.hidePromotionPicker();
    this.#view.clearMoves();
    this.#view.clearHighlights();
    this.#view.render(this.#chess);
    this.#view.setClock('w', 0);
    this.#view.setClock('b', 0);
    this.#view.setClockActive(PLAYER);
    this.#view.setCaptures('player',   []);
    this.#view.setCaptures('opponent', []);
    this.#view.setStatus('White to move');

    document.querySelectorAll('.diff-btn').forEach(b => { b.disabled = false; });
    this.#startClock();
  }

  #resign() {
    if (this.#gameOver) return;
    this.#endGame('Engine wins', 'You resigned');
  }

  #endGame(title, sub) {
    this.#gameOver = true;
    this.#stopClock();
    this.#view.showResult(title, sub);
    this.#view.setStatus(`${title} — ${sub}`);
    document.querySelectorAll('.diff-btn').forEach(b => { b.disabled = false; });
  }

  // ── Clock ──────────────────────────────────────────────

  #startClock() {
    this.#stopClock();
    this.#clockInterval = setInterval(() => {
      if (this.#gameOver) { this.#stopClock(); return; }
      const color = this.#chess.turn();
      this.#clockSeconds[color]++;
      this.#view.setClock(color, this.#clockSeconds[color]);
    }, 1000);
  }

  #stopClock() {
    clearInterval(this.#clockInterval);
    this.#clockInterval = null;
  }

  // ── Click handling ─────────────────────────────────────

  #onSquareClick(sqName) {
    if (this.#gameOver || this.#awaitingCpu || this.#pendingPromotion) return;
    if (this.#chess.turn() !== PLAYER) return;

    const piece = this.#chess.get(sqName);

    if (this.#selected) {
      const targetMove = this.#legalMoves.find(m => m.to === sqName);
      if (targetMove) {
        this.#executePlayerMove(this.#selected, sqName);
        return;
      }
      if (piece?.color === PLAYER) {
        this.#selectSquare(sqName);
        return;
      }
      this.#clearSelection();
      return;
    }

    if (piece?.color === PLAYER) {
      this.#selectSquare(sqName);
    }
  }

  #selectSquare(sqName) {
    const allLegal   = this.#chess.moves({ verbose: true });
    const pieceMoves = allLegal.filter(m => m.from === sqName);
    if (pieceMoves.length === 0) return;

    this.#selected   = sqName;
    this.#legalMoves = pieceMoves;

    this.#view.clearHighlights();
    this.#applyPersistentHighlights();
    this.#view.setSelected(sqName);

    const seen   = new Set();
    const unique = [];
    for (const m of pieceMoves) {
      if (!seen.has(m.to)) { seen.add(m.to); unique.push(m); }
    }
    this.#view.showLegalTargets(unique);
  }

  #clearSelection() {
    this.#selected   = null;
    this.#legalMoves = [];
    this.#view.clearHighlights();
    this.#applyPersistentHighlights();
  }

  #applyPersistentHighlights() {
    if (this.#lastMoveFrom || this.#lastMoveTo) {
      this.#view.setLastMove(this.#lastMoveFrom, this.#lastMoveTo);
    }
    if (this.#chess.inCheck()) {
      this.#view.setInCheck(this.#findKing(this.#chess.turn()));
    }
  }

  // ── Move execution ─────────────────────────────────────

  #executePlayerMove(from, to) {
    const isPromotion = this.#legalMoves.some(m => m.to === to && m.promotion !== undefined);
    if (isPromotion) {
      this.#pendingPromotion = { from, to };
      this.#view.clearHighlights();
      this.#view.showPromotionPicker(PLAYER, promo => {
        this.#pendingPromotion = null;
        this.#completeMove(from, to, promo);
      });
      return;
    }
    this.#completeMove(from, to, null);
  }

  #completeMove(from, to, promotion) {
    const opts = { from, to };
    if (promotion) opts.promotion = promotion;
    const move = this.#chess.move(opts);
    if (!move) return;

    this.#selected   = null;
    this.#legalMoves = [];
    this.#postMove(move);

    if (!this.#gameOver) {
      this.#awaitingCpu = true;
      this.#view.setStatus('Engine is thinking…');
      setTimeout(() => this.#cpuTurn(), CPU_DELAY_MS);
    }
  }

  #cpuTurn() {
    this.#awaitingCpu = false;
    if (this.#gameOver) return;

    const snapshot = this.#chess.board();
    const result   = processCpuTurn(this.#chess, this.#ledger, this.#difficulty);

    if (result.kind === 'concede') {
      // No legal move and no affordable rescue: distinguish a genuine mate (player
      // wins) from a stalemate (draw) so the result is never mislabelled.
      if (this.#chess.isStalemate()) this.#endGame('Draw', 'Stalemate');
      else                           this.#endGame('You win', 'Checkmate');
      return;
    }

    if (result.kind === 'honest') {
      const applied = this.#chess.move(result.move);
      if (applied) this.#postMove(applied);
      return;
    }

    this.#postEngineMove(result, snapshot);
  }

  // ── Post-move housekeeping ─────────────────────────────

  #postMove(move) {
    if (move.captured) {
      if (move.color === PLAYER) {
        this.#capturedByPlayer.push(move.captured);
      } else {
        this.#capturedByCpu.push(move.captured);
      }
      this.#refreshCaptures();
    }

    this.#view.clearHighlights();
    this.#view.renderDiff(buildMoveDiff(move));
    this.#view.setLastMove(move.from, move.to);
    this.#lastMoveFrom = move.from;
    this.#lastMoveTo   = move.to;

    this.#moveCount++;
    const moveNum = Math.ceil(this.#moveCount / 2);
    this.#view.appendMove(moveNum, move.san, move.color);
    this.#view.setClockActive(this.#chess.turn());

    if (this.#moveCount === 1) {
      document.querySelectorAll('.diff-btn').forEach(b => { b.disabled = true; });
    }

    if (this.#chess.turn() === PLAYER) {
      this.#checkGameOver();
      if (!this.#gameOver) {
        if (this.#chess.inCheck()) {
          this.#view.setInCheck(this.#findKing(PLAYER));
          this.#view.setStatus('Check! Your move');
        } else {
          this.#view.setStatus('Your move');
        }
      }
    }
  }

  #postEngineMove(result, snapshot) {
    const preMap = {};
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        preMap[String.fromCharCode(97 + f) + (8 - r)] = snapshot[r][f];
      }
    }

    let anyCaptured = false;
    for (const { square } of result.diff) {
      const was = preMap[square];
      if (was?.color === PLAYER) {
        this.#capturedByCpu.push(was.type);
        anyCaptured = true;
      }
    }
    if (anyCaptured) this.#refreshCaptures();

    const { from, to } = deriveMoveSquares(result.diff);
    this.#view.clearHighlights();
    this.#view.renderDiff(result.diff);
    this.#view.setLastMove(from, to);
    this.#lastMoveFrom = from;
    this.#lastMoveTo   = to;

    this.#moveCount++;
    const moveNum = Math.ceil(this.#moveCount / 2);
    this.#view.appendMove(moveNum, result.notation, CPU);
    this.#view.setClockActive(this.#chess.turn());

    this.#checkGameOver();

    if (!this.#gameOver) {
      if (this.#chess.inCheck()) {
        this.#view.setInCheck(this.#findKing(PLAYER));
        this.#view.setStatus('Check! Your move');
      } else {
        this.#view.setStatus('Your move');
      }
    }
  }

  #refreshCaptures() {
    const sort = types => [...types].sort(
      (a, b) => PIECE_ORDER.indexOf(a) - PIECE_ORDER.indexOf(b)
    );
    this.#view.setCaptures('player',   sort(this.#capturedByPlayer).map(t => GLYPHS_B[t]));
    this.#view.setCaptures('opponent', sort(this.#capturedByCpu).map(t => GLYPHS_W[t]));
  }

  #checkGameOver() {
    if (this.#chess.isCheckmate()) {
      const winner = this.#chess.turn() === PLAYER ? 'Engine wins' : 'You win';
      this.#endGame(winner, 'Checkmate');
    } else if (this.#chess.isDraw()) {
      let reason = 'Draw';
      if (this.#chess.isStalemate())                reason = 'Stalemate';
      else if (this.#chess.isInsufficientMaterial()) reason = 'Insufficient material';
      else if (this.#chess.isThreefoldRepetition())  reason = 'Threefold repetition';
      this.#endGame('Draw', reason);
    }
  }

  // ── Helpers ────────────────────────────────────────────

  #findKing(color) {
    const board = this.#chess.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (p?.type === 'k' && p.color === color) {
          return String.fromCharCode('a'.charCodeAt(0) + f) + (8 - r);
        }
      }
    }
    return null;
  }
}
