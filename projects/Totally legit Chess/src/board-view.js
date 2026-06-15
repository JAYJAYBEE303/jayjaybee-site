const MOVE_ANIM_MS = 120;

const GLYPHS = {
  w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

export class BoardView {
  #boardEl;
  #squares = {};
  #moveListEl;
  #playerClockEl;
  #opponentClockEl;
  #playerCapturedEl;
  #opponentCapturedEl;
  #statusEl;
  #playerNameEl;
  #opponentNameEl;
  #resultOverlayEl;
  #resultTitleEl;
  #resultSubEl;
  #promoPickerEl;
  #moveRows = [];

  constructor(boardEl) {
    this.#boardEl       = boardEl;
    this.#moveListEl    = document.getElementById('move-list');
    this.#playerClockEl = document.getElementById('player-clock');
    this.#opponentClockEl = document.getElementById('opponent-clock');
    this.#playerCapturedEl   = document.getElementById('player-captured');
    this.#opponentCapturedEl = document.getElementById('opponent-captured');
    this.#statusEl       = document.getElementById('status');
    this.#playerNameEl   = document.getElementById('player-name');
    this.#opponentNameEl = document.getElementById('opponent-name');
    this.#resultOverlayEl = document.getElementById('result-overlay');
    this.#resultTitleEl   = document.getElementById('result-title');
    this.#resultSubEl     = document.getElementById('result-sub');
    this.#promoPickerEl   = document.getElementById('promo-picker');
    this.#build();
  }

  // ── Board construction ─────────────────────────────────

  #build() {
    this.#boardEl.innerHTML = '';
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const sq = document.createElement('div');
        const sqName = FILES[file] + RANKS[rank];
        sq.className = 'square ' + ((rank + file) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.square = sqName;
        this.#boardEl.appendChild(sq);
        this.#squares[sqName] = sq;
      }
    }
  }

  // ── Board rendering ────────────────────────────────────

  render(chess) {
    const board = chess.board();
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const sqName = FILES[file] + RANKS[rank];
        const el = this.#squares[sqName];
        const piece = board[rank][file];
        const existing = el.querySelector('.piece');
        if (existing) el.removeChild(existing);
        if (piece) {
          const span = document.createElement('span');
          span.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
          span.textContent = GLYPHS[piece.color][piece.type];
          el.appendChild(span);
        }
      }
    }
  }

  renderDiff(diff) {
    const removals = [];
    const additions = [];
    for (const entry of diff) {
      (entry.piece ? additions : removals).push(entry);
    }

    const readDom = sq => {
      const span = this.#squares[sq]?.querySelector('.piece');
      if (!span) return null;
      const color = span.classList.contains('white') ? 'w' : 'b';
      const type = Object.entries(GLYPHS[color]).find(([, g]) => g === span.textContent)?.[0];
      return { el: span, color, type };
    };

    const remState = removals.map(r => ({ square: r.square, dom: readDom(r.square) }));

    const usedRem = new Set();
    const movers = [];
    for (const add of additions) {
      const i = remState.findIndex((rs, idx) =>
        !usedRem.has(idx) && rs.dom?.color === add.piece.color && rs.dom?.type === add.piece.type
      );
      if (i !== -1) {
        usedRem.add(i);
        movers.push({ from: remState[i].square, fromEl: remState[i].dom.el, to: add.square, piece: add.piece });
      }
    }

    const unmatchedRem = remState.filter((_, i) => !usedRem.has(i));
    const movedTo = new Set(movers.map(m => m.to));
    const unmatchedAdd = additions.filter(a => !movedTo.has(a.square));

    if (movers.length === 0) {
      for (const { square, piece } of diff) {
        const el = this.#squares[square];
        if (!el) continue;
        el.querySelector('.piece')?.remove();
        if (piece) {
          const span = document.createElement('span');
          span.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
          span.textContent = GLYPHS[piece.color][piece.type];
          el.appendChild(span);
        }
      }
      return;
    }

    const animations = movers.map(mover => {
      const fromRect = this.#squares[mover.from].getBoundingClientRect();
      const toRect   = this.#squares[mover.to].getBoundingClientRect();
      const capturedEl = this.#squares[mover.to].querySelector('.piece');

      const floater = mover.fromEl.cloneNode(true);
      const fs = window.getComputedStyle(mover.fromEl).fontSize;
      floater.style.cssText = [
        'position:fixed',
        `left:${fromRect.left}px`,
        `top:${fromRect.top}px`,
        `width:${fromRect.width}px`,
        `height:${fromRect.height}px`,
        'margin:0',
        'padding:0',
        `font-size:${fs}`,
        'z-index:1000',
        'pointer-events:none',
        'box-sizing:border-box',
      ].join(';');
      document.body.appendChild(floater);

      mover.fromEl.style.visibility = 'hidden';

      const dx = toRect.left - fromRect.left;
      const dy = toRect.top  - fromRect.top;
      const anim = floater.animate(
        [{ transform: 'translate(0,0)' }, { transform: `translate(${dx}px,${dy}px)` }],
        { duration: MOVE_ANIM_MS, easing: 'ease-in-out' }
      );

      return { anim, floater, mover, capturedEl };
    });

    Promise.all(animations.map(a => a.anim.finished)).then(() => {
      for (const { floater, mover, capturedEl } of animations) {
        floater.remove();
        mover.fromEl.remove();
        capturedEl?.remove();
        const span = document.createElement('span');
        span.className = `piece ${mover.piece.color === 'w' ? 'white' : 'black'}`;
        span.textContent = GLYPHS[mover.piece.color][mover.piece.type];
        this.#squares[mover.to].appendChild(span);
      }
      for (const rs of unmatchedRem) {
        rs.dom?.el.remove();
      }
      for (const add of unmatchedAdd) {
        const el = this.#squares[add.square];
        if (!el) continue;
        el.querySelector('.piece')?.remove();
        const span = document.createElement('span');
        span.className = `piece ${add.piece.color === 'w' ? 'white' : 'black'}`;
        span.textContent = GLYPHS[add.piece.color][add.piece.type];
        el.appendChild(span);
      }
    });
  }

  getSquareEl(sqName) {
    return this.#squares[sqName] ?? null;
  }

  // ── Highlights ─────────────────────────────────────────

  clearHighlights() {
    for (const el of Object.values(this.#squares)) {
      el.classList.remove('selected', 'legal-target', 'legal-capture', 'last-move', 'in-check');
    }
  }

  setSelected(sqName) {
    if (sqName) this.#squares[sqName]?.classList.add('selected');
  }

  setLastMove(from, to) {
    if (from) this.#squares[from]?.classList.add('last-move');
    if (to)   this.#squares[to]?.classList.add('last-move');
  }

  setInCheck(sqName) {
    if (sqName) this.#squares[sqName]?.classList.add('in-check');
  }

  /** @param {import('../lib/chess.js').Move[]} moves - verbose move objects */
  showLegalTargets(moves) {
    for (const m of moves) {
      const el = this.#squares[m.to];
      if (!el) continue;
      el.classList.add(m.captured ? 'legal-capture' : 'legal-target');
    }
  }

  // ── Player info ────────────────────────────────────────

  setStatus(text) {
    if (this.#statusEl) this.#statusEl.textContent = text;
  }

  setPlayerName(name)   { if (this.#playerNameEl)   this.#playerNameEl.textContent   = name; }
  setOpponentName(name) { if (this.#opponentNameEl) this.#opponentNameEl.textContent = name; }

  // ── Clocks ─────────────────────────────────────────────

  setClock(color, seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const text = `${mins}:${String(secs).padStart(2, '0')}`;
    const el = color === 'w' ? this.#playerClockEl : this.#opponentClockEl;
    if (el) el.textContent = text;
  }

  setClockActive(color) {
    this.#playerClockEl?.classList.toggle('active',   color === 'w');
    this.#opponentClockEl?.classList.toggle('active', color === 'b');
  }

  // ── Move list ──────────────────────────────────────────

  /**
   * Append a SAN move to the move list.
   * White moves start a new row; black moves fill the second cell of the last row.
   */
  appendMove(moveNum, san, color) {
    if (!this.#moveListEl) return;
    if (color === 'w') {
      const row = document.createElement('div');
      row.className = 'move-row';
      const numSpan  = document.createElement('span');
      numSpan.className = 'move-num';
      numSpan.textContent = `${moveNum}.`;
      const wSpan = document.createElement('span');
      wSpan.className = 'move-san';
      wSpan.textContent = san;
      const bSpan = document.createElement('span');
      bSpan.className = 'move-san';
      row.append(numSpan, wSpan, bSpan);
      this.#moveListEl.appendChild(row);
      this.#moveRows.push(row);
    } else {
      const lastRow = this.#moveRows[this.#moveRows.length - 1];
      if (lastRow) {
        const cells = lastRow.querySelectorAll('.move-san');
        if (cells[1]) cells[1].textContent = san;
      }
    }
    this.#moveListEl.scrollTop = this.#moveListEl.scrollHeight;
  }

  clearMoves() {
    if (this.#moveListEl) this.#moveListEl.innerHTML = '';
    this.#moveRows = [];
  }

  // ── Captured pieces ────────────────────────────────────

  /**
   * @param {'player'|'opponent'} side
   * @param {string[]} glyphs - Unicode glyph strings, sorted by value
   */
  setCaptures(side, glyphs) {
    const el = side === 'player' ? this.#playerCapturedEl : this.#opponentCapturedEl;
    if (!el) return;
    el.textContent = glyphs.join('');
  }

  // ── Result overlay ─────────────────────────────────────

  showResult(title, sub) {
    if (this.#resultTitleEl) this.#resultTitleEl.textContent = title;
    if (this.#resultSubEl)   this.#resultSubEl.textContent   = sub;
    this.#resultOverlayEl?.classList.add('visible');
  }

  hideResult() {
    this.#resultOverlayEl?.classList.remove('visible');
  }

  // ── Promotion picker ───────────────────────────────────

  /**
   * Show the promotion picker for the given colour.
   * @param {'w'|'b'} color
   * @param {(piece: string) => void} cb - called with the chosen piece type
   */
  showPromotionPicker(color, cb) {
    if (!this.#promoPickerEl) return;
    this.#promoPickerEl.innerHTML = '';
    for (const p of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.textContent = GLYPHS[color][p];
      btn.title = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p];
      btn.addEventListener('click', () => {
        this.hidePromotionPicker();
        cb(p);
      });
      this.#promoPickerEl.appendChild(btn);
    }
    this.#promoPickerEl.classList.add('visible');
  }

  hidePromotionPicker() {
    this.#promoPickerEl?.classList.remove('visible');
  }
}
