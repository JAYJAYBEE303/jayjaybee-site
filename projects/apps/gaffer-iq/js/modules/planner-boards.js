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

import { BOARD_TOP_N, BOARD_EXPANDED_N, STRUCTURE_PLAYTIME_FLOOR } from '../config.js';

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/**
 * The five boards, in render order.
 *
 * `blurb` is the one-line strategy statement under the title: what question
 * this board answers, in plain language. Without it the five titles read as
 * five arbitrary rankings of the same transfer list.
 *
 * `unit` labels the MIDDLE COLUMN — the one number on every row — so a reader
 * never has to guess whether "+8.0" is points, pounds, a rate or a swing. It
 * describes that column and nothing else; the strategy explanation lives in
 * `blurb`, not here.
 */
export const LANE_BOARDS = [
  { id: 'now',       title: 'Now',
    blurb: 'The biggest immediate upgrade to your starting XI over the current '
         + 'horizon. Says nothing about what happens after it.',
    unit: 'proj. XI pts over horizon',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },

  { id: 'future',    title: 'Future Prep',
    blurb: 'Buying before the fixtures turn. Ranks by how much MORE a player is '
         + 'worth in the deferred window than he is right now.',
    unit: 'XI pts, later minus now',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },

  { id: 'funds',     title: 'Funds & Flexibility',
    blurb: 'Cash and room to manoeuvre. Frees money and unclumps your price '
         + 'bands for the smallest sacrifice in projected points.',
    unit: 'flex pts per pt given up',
    format: v => v.toFixed(1) },

  { id: 'ceiling',   title: 'Ceiling',
    blurb: 'Chasing one big week rather than a steady one. This is where '
         + 'captaincy and Triple Captain points come from.',
    unit: 'proj. peak-week pts',
    format: v => v.toFixed(1) },

  { id: 'structure', title: 'Structure Fix',
    blurb: 'Repairing a broken XI slot: a starter who is flagged, barely '
         + 'playing, or rating in the bottom band of the whole pool.',
    unit: 'XI pts restored',
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
 * Confidence badge copy. The raw enum values are engine vocabulary — 'close'
 * on its own reads as an adjective with no noun and told the user nothing.
 */
const CONFIDENCE_LABELS = {
  dominant: 'Dominant',
  clear:    'Clear',
  close:    'Close call',
};

/**
 * What acting on this lane actually COMMITS you to. The engine's `reasoning`
 * explains why a lane won; this says what winning means for the week, which
 * is the half a reader needs to act and the half that was missing.
 */
const LANE_DIRECTIONS = {
  now: 'Strategy: spend this week\'s transfer on the biggest immediate gain to '
     + 'your XI. This is a bet on the next few gameweeks only — it takes no '
     + 'view on fixtures beyond the horizon.',
  future: 'Strategy: move early and accept a flat week or two. The gain arrives '
        + 'when the fixtures turn, not now, so judge it in a month rather than '
        + 'on Saturday.',
  funds: 'Strategy: trade a little scoring for room to manoeuvre. Free the cash '
       + 'and unclump your price bands so the upgrade you actually want is '
       + 'affordable in a week or two.',
  ceiling: 'Strategy: play for a spike rather than a steady score. Decide your '
         + 'captain alongside this, and check it against any Triple Captain you '
         + 'still hold.',
  structure: 'Strategy: repair before you upgrade. A starting slot is broken and '
           + 'is leaking points every week it stays — fixing it comes ahead of '
           + 'any speculative buy.',
  roll: 'Strategy: bank the transfer. Nothing on the boards clears the bar to '
      + 'act, and carrying a free transfer into next week is worth more than a '
      + 'marginal move now.',
};

/**
 * The gameweek this plan is FOR, and why it may not be the gameweek showing on
 * the scoreboard. A round that has kicked off cannot be changed, so once
 * GW n is under way the planner is planning GW n+1 and must say so — otherwise
 * every recommendation reads as advice about a deadline that has already gone.
 *
 * @param {PlannerTiming|null} timing
 * @returns {string}  plain text, or '' when there is nothing to say
 */
function timingNote(timing) {
  if (!timing || !timing.planningGw) return '';
  const { phase, currentGw, planningGw, unplayed } = timing;

  if (phase === 'pre-deadline') {
    return `Planning GW${planningGw} — the deadline has not passed, so every `
         + 'move below is still live for this round.';
  }
  if (phase === 'off-season' || currentGw == null) {
    return `Planning GW${planningGw}.`;
  }

  const lead = phase === 'finished'
    ? `GW${currentGw} is complete, so this plan is for GW${planningGw}.`
    : `GW${currentGw} has already kicked off and can no longer be changed, so `
      + `this plan is for GW${planningGw}.`;

  // The caution only makes sense while results are still outstanding: those
  // results move every number on this page, so committing a transfer now is
  // committing on information that is not in yet.
  const caution = unplayed > 0
    ? ` ${unplayed} GW${currentGw} ${unplayed === 1 ? 'match is' : 'matches are'} `
      + 'still to play, and those results will move these numbers — deciding now '
      + 'means deciding on incomplete information, so there is rarely anything to '
      + 'gain by rushing it.'
    : '';

  return lead + caution;
}

/**
 * A signature of what this verdict is SAYING, so a dismissal can persist
 * without hiding a verdict that has since changed its mind. Budget keystrokes
 * and score jitter must not resurrect the banner; a new gameweek or a new
 * strategic call must.
 *
 * @param {object|null} verdict
 * @param {PlannerTiming|null} timing
 * @returns {string}
 */
export function verdictSignature(verdict, timing) {
  if (!verdict) return '';
  return [
    timing?.planningGw ?? '?',
    verdict.lane,
    verdict.promotedBy ?? '',
  ].join('|');
}

/**
 * @typedef {{ currentGw: number|null, planningGw: number|null,
 *             phase: 'live'|'pre-deadline'|'finished'|'off-season',
 *             unplayed: number }} PlannerTiming
 */

/**
 * The verdict banner: the week's call, its confidence, what it commits you to,
 * which gameweek it is for, and any triggers.
 *
 * When `verdict.promotedBy` is set, a hard trigger jumped this lane ahead of
 * the arithmetically better one — its message already leads the reasoning
 * prose (see engine/strategy.js), so it is skipped here to avoid stating it
 * twice. Every other trigger still renders as a bullet. The banner root still
 * gets a `--promoted` modifier as the visual cue.
 *
 * @param {object|null} verdict  from buildVerdict()
 * @param {{ timing?: PlannerTiming|null, dismissed?: boolean }} [opts]
 * @returns {string}  HTML
 */
export function renderVerdictBanner(verdict, opts = {}) {
  if (!verdict) {
    return `<div class="planner-verdict planner-verdict--empty">
      <p class="planner-verdict__headline">Add 15 players to get a verdict.</p>
    </div>`;
  }

  const timing = opts.timing ?? null;

  // Dismissed: collapse to a single line rather than removing it. A banner
  // with no way back would leave the week's actual call unreachable until the
  // squad happened to change.
  if (opts.dismissed) {
    return `
      <div class="planner-verdict planner-verdict--collapsed">
        <span class="planner-verdict__lane">${esc(laneLabel(verdict.lane))}</span>
        <span class="planner-verdict__confidence">${esc(CONFIDENCE_LABELS[verdict.confidence] ?? verdict.confidence)}</span>
        ${timing?.planningGw ? `<span class="planner-verdict__gw">GW${esc(timing.planningGw)}</span>` : ''}
        <button class="planner-verdict__reopen" type="button" data-verdict-show>show verdict</button>
      </div>
    `.trim();
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

  const note = timingNote(timing);
  const timingLine = note
    ? `<p class="planner-verdict__timing">${esc(note)}</p>`
    : '';

  const direction = LANE_DIRECTIONS[verdict.lane]
    ? `<p class="planner-verdict__direction">${esc(LANE_DIRECTIONS[verdict.lane])}</p>`
    : '';

  return `
    <div class="planner-verdict planner-verdict--${esc(verdict.confidence)}${promotedModifier}${verdict.estimated ? ' planner-verdict--estimated' : ''}">
      <div class="planner-verdict__head">
        <span class="planner-verdict__lane">${esc(laneLabel(verdict.lane))}</span>
        <span class="planner-verdict__confidence">${esc(CONFIDENCE_LABELS[verdict.confidence] ?? verdict.confidence)}</span>
        ${verdict.promotedBy
          ? '<span class="planner-verdict__promoted-mark" title="Promoted ahead of the arithmetic leader by a hard trigger">promoted</span>'
          : ''}
        ${verdict.lane === 'roll' ? '' :
          `<span class="planner-verdict__score" title="Lane score, 0–100">${verdict.laneScore.toFixed(0)}
            ${verdict.promotedBy ? '' :
              `<span class="planner-verdict__margin">+${verdict.margin.toFixed(0)} clear</span>`}
          </span>`}
        <button class="planner-verdict__close" type="button" data-verdict-dismiss
                title="Hide this verdict" aria-label="Hide this verdict">×</button>
      </div>
      ${timingLine}
      <p class="planner-verdict__headline">${esc(verdict.reasoning)}</p>
      ${direction}
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
  ].join('');

  // The estimated signal is carried by the VALUE itself — a dashed underline
  // plus a title — rather than by a separate "~" glyph. The glyph occupied a
  // whole column on every row to say something about one of them; the rest of
  // this app already uses a border treatment for exactly this (see
  // .score-pill--estimated, css/components.css), so this is the house
  // convention rather than a new one.
  const valueClass = 'planner-swap-row__value'
    + (lane.estimated ? ' planner-swap-row__value--estimated' : '');
  const valueTitle = lane.estimated
    ? ' title="Some inputs behind this number are estimated"'
    : '';

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
        <span class="${valueClass}"${valueTitle}>${esc(board.format(lane.value))}</span>
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
    ? `<p class="planner-board__empty">${esc(emptyMessage(board.id, swaps))}</p>`
    : `<ul class="planner-board__rows">
         ${rows.map(s => renderSwapRow(s, board, openRows.has(swapKey(s)))).join('')}
       </ul>`;

  // `|| isExpanded` matters when a board has, say, 6 qualifying swaps: once
  // expanded (limit = BOARD_EXPANDED_N) ranked.length === rows.length and the
  // plain `ranked.length > rows.length` check would drop the button entirely,
  // leaving no way back to the collapsed view — _expandedBoards persists
  // across renders, so that board would be stuck expanded for the session.
  const more = (ranked.length > rows.length || isExpanded)
    ? `<button class="planner-board__more" type="button" data-board-more="${esc(board.id)}">
         ${isExpanded ? 'less' : `more (${ranked.length - rows.length})`}
       </button>`
    : '';

  return `
    <section class="planner-board planner-board--${esc(board.id)}" aria-label="${esc(board.title)}">
      <header class="planner-board__hd">
        <div class="planner-board__titles">
          <h3 class="planner-board__title">${esc(board.title)}</h3>
          <p class="planner-board__blurb">${esc(board.blurb)}</p>
        </div>
        <span class="planner-board__unit" title="What the number on each row measures">${esc(board.unit)}</span>
      </header>
      ${body}
      ${more}
    </section>
  `.trim();
}

/**
 * Whether SOME candidate out-player is structurally broken, independent of
 * whether any candidate swap for them turned out profitable (the Structure
 * lane always scores `max(0, nearXiDelta)`, so a broken starter with no
 * affordable improvement scores exactly 0 — same as "nothing is broken").
 * Mirrors the three OUT-side conditions `scoreStructureLane` checks
 * (engine/transfers.js), read back off data the swaps already carry rather
 * than recomputed here — this stays a DOM module, no engine logic.
 * @param {Array<Swap>} swaps  the full unfiltered enumeration
 * @returns {boolean}
 */
function hasBrokenStarter(swaps) {
  return (swaps ?? []).some(s => s.flags?.outInXi && (
    s.flags?.outUnavailable
    || (s.lanes?.structure?.components?.playtime ?? 1) < STRUCTURE_PLAYTIME_FLOOR
    || s.lanes?.structure?.components?.rankTier === 'bottomPercentile'
  ));
}

/** What a board says when it has nothing to recommend.
 *  @param {string} boardId
 *  @param {Array<Swap>} [swaps]  only read by 'structure', to tell "nothing
 *    broken" apart from "broken, but nothing affordable fixes it" — the two
 *    are very different claims and the verdict banner above may already be
 *    naming the broken player, so silently reusing one empty string for both
 *    would contradict it. */
function emptyMessage(boardId, swaps) {
  switch (boardId) {
    case 'structure': return hasBrokenStarter(swaps)
      ? 'A starter is flagged, low on minutes, or rating poorly — but no '
        + 'affordable replacement actually gains points in your XI.'
      : 'Nothing broken — no starter is flagged or short of minutes.';
    case 'future':    return 'No fixture swings worth pre-empting within your budget.';
    case 'funds':     return 'No move improves your flexibility without costing too much.';
    case 'ceiling':   return 'No higher-ceiling option within budget.';
    default:          return 'No move gains points in your XI within budget.';
  }
}

/**
 * The full grid of five boards.
 * @param {Array<Swap>} swaps
 * @param {{expandedBoards: Set<string>, openRows: Set<string>}} opts
 * @returns {string}  HTML
 */
export function renderBoardGrid(swaps, opts) {
  return `<div class="planner-board-grid">
    ${LANE_BOARDS.map(board => renderBoard(board, swaps, opts)).join('')}
  </div>`;
}
