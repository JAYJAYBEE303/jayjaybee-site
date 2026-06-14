import { Chess } from '../lib/chess.js';
import { BoardView } from './board-view.js';
import { Game } from './game.js';

document.addEventListener('DOMContentLoaded', () => {
  const chess = new Chess();
  const view  = new BoardView(document.getElementById('board'));
  new Game(chess, view);
});
