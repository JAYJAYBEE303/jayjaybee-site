/**
 * js/modules/planner-boards.js
 * Layer: module (DOM). Builds the Transfer Planner's verdict banner and lens
 * boards as HTML strings. No listeners, no state, no engine calls — planner.js
 * owns all three and passes the already-scored data in.
 *
 * Split out of planner.js, which was 1,324 lines before this feature and is
 * the file both halves of this page are edited in.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §9.
 */

import { BOARD_TOP_N, BOARD_EXPANDED_N } from '../config.js';

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/**
 * The five boards, in render order. `unit` labels the headline number so a
 * reader never has to guess whether "+4.1" means points, pounds or a swing.
 */
export const LANE_BOARDS = [
  { id: 'now',       title: 'Now',                 unit: 'pts to XI',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
  { id: 'future',    title: 'Future Prep',         unit: 'swing',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
  { id: 'funds',     title: 'Funds & Flexibility', unit: 'flex/pt',
    format: v => v.toFixed(1) },
  { id: 'ceiling',   title: 'Ceiling',             unit: 'peak pts',
    format: v => v.toFixed(1) },
  { id: 'structure', title: 'Structure Fix',       unit: 'pts restored',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
];

/** Display name for a lane id. 'funds' must not render as "Funds", losing
 *  half its meaning, and 'roll' has no board at all. */
export function laneLabel(laneId) {
  if (laneId === 'roll') return 'Roll it';
  return LANE_BOARDS.find(b => b.id === laneId)?.title ?? laneId;
}

/** A stable key for one swap, used to remember which why-panels are open. */
export function swapKey(swap) {
  return `${swap.outId}-${swap.inId}`;
}

/**
 * The verdict banner: the week's call, its confidence, and any triggers.
 *
 * When `verdict.promotedBy` is set, a hard trigger jumped this lane ahead of
 * the arithmetically better one — its message already leads the reasoning
 * prose (see engine/strategy.js), so it is skipped here to avoid stating it
 * twice. Every other trigger still renders as a bullet. The banner root still
 * gets a `--promoted` modifier as the visual cue.
 * @param {object|null} verdict  from buildVerdict()
 * @returns {string}  HTML
 */
export function renderVerdictBanner(verdict) {
  if (!verdict) {
    return `<div class="planner-verdict planner-verdict--empty">
      <p class="planner-verdict__headline">Add 15 players to get a verdict.</p>
    </div>`;
  }

  const listedTriggers = verdict.triggers.filter(t => t.id !== verdict.promotedBy);
  const triggers = listedTriggers.length === 0 ? '' : `
    <ul class="planner-verdict__triggers">
      ${listedTriggers.map(t => `
        <li class="planner-verdict__trigger" data-trigger="${esc(t.id)}">
          <span class="planner-verdict__trigger-mark" aria-hidden="true">!</span>
          ${esc(t.message)}
        </li>`).join('')}
    </ul>`;

  const alternatives = verdict.alternatives.length === 0 ? '' : `
    <p class="planner-verdict__alts">Close behind:
      ${verdict.alternatives.map(a => `${esc(a.label)} (${a.score.toFixed(0)})`).join(', ')}
    </p>`;

  const promotedModifier = verdict.promotedBy ? ' planner-verdict--promoted' : '';

  return `
    <div class="planner-verdict planner-verdict--${esc(verdict.confidence)}${promotedModifier}${verdict.estimated ? ' planner-verdict--estimated' : ''}">
      <div class="planner-verdict__head">
        <span class="planner-verdict__lane">${esc(laneLabel(verdict.lane))}</span>
        <span class="planner-verdict__confidence">${esc(verdict.confidence)}</span>
        ${verdict.promotedBy
          ? '<span class="planner-verdict__promoted-mark" title="Promoted ahead of the arithmetic leader by a hard trigger">promoted</span>'
          : ''}
        ${verdict.lane === 'roll' ? '' :
          `<span class="planner-verdict__score">${verdict.laneScore.toFixed(0)}
            <span class="planner-verdict__margin">+${verdict.margin.toFixed(0)} clear</span>
          </span>`}
      </div>
      <p class="planner-verdict__headline">${esc(verdict.reasoning)}</p>
      ${alternatives}
      ${triggers}
    </div>
  `.trim();
}

/**
 * One compact swap row. Collapsed it is a single line; `why` expands it in
 * place to the full breakdown.
 */
function renderSwapRow(swap, board, isOpen) {
  const lane  = swap.lanes[board.id];
  const key   = swapKey(swap);
  const price = swap.priceDiff >= 0
    ? `+£${swap.priceDiff.toFixed(1)}m`
    : `−£${Math.abs(swap.priceDiff).toFixed(1)}m`;

  const badges = [
    swap.flags.outUnavailable
      ? '<span class="planner-swap-row__badge planner-swap-row__badge--urgent" title="Flagged or injured">!</span>' : '',
    swap.flags.inEntersXi
      ? '<span class="planner-swap-row__badge planner-swap-row__badge--xi" title="Goes straight into your XI">XI</span>' : '',
    lane.estimated
      ? '<span class="planner-swap-row__badge planner-swap-row__badge--estimated" title="Some inputs are estimated">~</span>' : '',
  ].join('');

  const why = !isOpen ? '' : `
    <div class="planner-why" id="why-${esc(key)}">
      <p class="planner-why__reasoning">${esc(lane.reasoning)}</p>
      <dl class="planner-why__components">
        ${Object.entries(lane.components).map(([k, v]) => `
          <div class="planner-why__row">
            <dt class="planner-why__key">${esc(k)}</dt>
            <dd class="planner-why__val">${esc(typeof v === 'number' ? v.toFixed(2) : String(v))}</dd>
          </div>`).join('')}
      </dl>
    </div>`;

  return `
    <li class="planner-swap-row${isOpen ? ' is-open' : ''}" data-swap-key="${esc(key)}">
      <div class="planner-swap-row__line">
        <span class="planner-swap-row__names">
          <span class="planner-swap-row__out">${esc(swap.outPlayer.name)}</span>
          <span class="planner-swap-row__arrow" aria-hidden="true">→</span>
          <span class="planner-swap-row__in">${esc(swap.inPlayer.name)}</span>
        </span>
        <span class="planner-swap-row__value">${esc(board.format(lane.value))}</span>
        <span class="planner-swap-row__price">${esc(price)}</span>
        ${badges}
        <button class="planner-swap-row__why" type="button"
                data-why-key="${esc(key)}"
                aria-expanded="${isOpen}"
                aria-controls="why-${esc(key)}">why</button>
      </div>
      ${why}
    </li>
  `.trim();
}

/** One board: title, meta, and its top rows. */
function renderBoard(board, swaps, opts) {
  const { expandedBoards, openRows } = opts;
  const isExpanded = expandedBoards.has(board.id);
  const limit = isExpanded ? BOARD_EXPANDED_N : BOARD_TOP_N;

  const ranked = swaps
    .filter(s => s.lanes[board.id] && s.lanes[board.id].value > 0)
    .sort((a, b) => b.lanes[board.id].value - a.lanes[board.id].value);

  const rows = ranked.slice(0, limit);

  // An empty board says so plainly. Padding it with the next-best generic swap
  // would be exactly the tunnel vision this feature exists to remove.
  const body = rows.length === 0
    ? `<p class="planner-board__empty">${esc(emptyMessage(board.id))}</p>`
    : `<ul class="planner-board__rows">
         ${rows.map(s => renderSwapRow(s, board, openRows.has(swapKey(s)))).join('')}
       </ul>`;

  const more = ranked.length > rows.length
    ? `<button class="planner-board__more" type="button" data-board-more="${esc(board.id)}">
         ${isExpanded ? 'less' : `more (${ranked.length - rows.length})`}
       </button>`
    : '';

  return `
    <section class="planner-board planner-board--${esc(board.id)}" aria-label="${esc(board.title)}">
      <header class="planner-board__hd">
        <h3 class="planner-board__title">${esc(board.title)}</h3>
        <span class="planner-board__unit">${esc(board.unit)}</span>
      </header>
      ${body}
      ${more}
    </section>
  `.trim();
}

/** What a board says when it has nothing to recommend. */
function emptyMessage(boardId) {
  switch (boardId) {
    case 'structure': return 'Nothing broken — no starter is flagged or short of minutes.';
    case 'future':    return 'No fixture swings worth pre-empting within your budget.';
    case 'funds':     return 'No move improves your flexibility without costing too much.';
    case 'ceiling':   return 'No higher-ceiling option within budget.';
    default:          return 'No move gains points in your XI within budget.';
  }
}

/**
 * The full grid of five boards.
 * @param {Array<Swap>} swaps
 * @param {{expandedBoards: Set<string>, openRows: Set<string>,
 *          rankTierByPlayerId: Map<number,string>}} opts
 * @returns {string}  HTML
 */
export function renderBoardGrid(swaps, opts) {
  return `<div class="planner-board-grid">
    ${LANE_BOARDS.map(board => renderBoard(board, swaps, opts)).join('')}
  </div>`;
}
