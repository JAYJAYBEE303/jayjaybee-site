/**
 * js/modules/planner-boards.js
 * Layer: module (copy). The Transfer Planner's six lens boards and the words
 * around the verdict: what each lens measures, what a lane commits you to,
 * which gameweek the plan is for, and what an empty lens says. No listeners,
 * no state, no engine calls — planner.js owns all three.
 *
 * Split out of planner.js, which was 1,324 lines before this feature and is
 * the file both halves of this page are edited in.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §9.
 */

import { STRUCTURE_PLAYTIME_FLOOR } from '../config.js';

/**
 * The six boards, in render order.
 *
 * `blurb` is the one-line strategy statement under the title: what question
 * this board answers, in plain language. Without it the six titles read as
 * six arbitrary rankings of the same transfer list.
 *
 * `unit` labels the MIDDLE COLUMN — the one number on every row — so a reader
 * never has to guess whether "+8.0" is points, pounds, a rate or a ratio. It
 * describes that column and nothing else; the strategy explanation lives in
 * `blurb`, not here.
 *
 * The unit labels are load-bearing, not decoration. Now, Long term, Future Prep
 * and Structure Fix all report projected XI points, but over DIFFERENT SPANS —
 * one gameweek, five, three, five — so their numbers are not comparable to one
 * another and the span in each label is the only thing that says so. Never
 * shorten a unit to just "projected XI points". See engine/transfers.js's
 * header and spec §6.
 */
export const LANE_BOARDS = [
  { id: 'now',       title: 'Now',
    blurb: 'The biggest upgrade to your starting XI for the next gameweek '
         + 'alone. Says nothing about what happens after it.',
    unit: 'projected XI points, next GW',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },

  { id: 'longterm',  title: 'Long term',
    blurb: 'The biggest upgrade across the whole planning window. Ranks by '
         + 'total projected points over the next five gameweeks, not one.',
    unit: 'projected XI points, next 5 GWs',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },

  { id: 'future',    title: 'Future Prep',
    blurb: 'Buying before the fixtures turn. Ranks by the strongest run over '
         + 'the 3rd to 5th upcoming gameweeks, ignoring the next two.',
    unit: 'projected XI points, GWs 3–5',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },

  { id: 'funds',     title: 'Funds & Flexibility',
    blurb: 'Downgrades in price that are upgrades in output. Only cheaper '
         + 'players appear, ranked by the points each pound released buys.',
    unit: 'XI points gained per £m freed',
    format: v => v.toFixed(1) },

  { id: 'ceiling',   title: 'Ceiling',
    blurb: 'Chasing one big week rather than a steady one. This is where '
         + 'captaincy and Triple Captain points come from.',
    unit: 'projected peak-week points',
    format: v => v.toFixed(1) },

  { id: 'structure', title: 'Structure Fix',
    blurb: 'Repairing a broken XI slot: a starter who is flagged, barely '
         + 'playing, or rating in the bottom band of the whole pool.',
    unit: 'projected XI points restored, next 5 GWs',
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
export const CONFIDENCE_LABELS = {
  dominant: 'Dominant',
  clear:    'Clear',
  close:    'Close call',
};

/**
 * What acting on this lane actually COMMITS you to. The engine's `reasoning`
 * explains why a lane won; this says what winning means for the week, which
 * is the half a reader needs to act and the half that was missing.
 */
export const LANE_DIRECTIONS = {
  now: 'Strategy: spend this week\'s transfer on the biggest gain for the next '
     + 'gameweek. This is a bet on Saturday alone — it takes no view on '
     + 'anything beyond it, so check it against Long term before committing.',
  longterm: 'Strategy: spend the transfer on the biggest gain across the whole '
          + 'planning window. A move that is flat this week but strong over five '
          + 'gameweeks wins here, and that is usually the right trade with a '
          + 'free transfer in hand.',
  future: 'Strategy: move early and accept a flat week or two. The gain arrives '
        + 'when the fixtures turn, not now, so judge it in a month rather than '
        + 'on Saturday.',
  funds: 'Strategy: take the free lunch. Every move here costs less than the '
       + 'player it replaces AND scores more, so it banks cash toward the '
       + 'upgrade you actually want without giving up points to do it.',
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
 * Small counts spelled out, so prose never collides with the gameweek numbers
 * sitting next to it — "1 GW2 match" reads as one number run into another.
 * A gameweek holds at most ten fixtures, so the table covers every real case
 * and anything past it falls back to a digit rather than inventing words.
 */
const NUMBER_WORDS = ['zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six',
                      'Seven', 'Eight', 'Nine', 'Ten'];

function numberWord(n) {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * The gameweek this plan is FOR, and why it may not be the gameweek showing on
 * the scoreboard. A round that has kicked off cannot be changed, so once
 * GW n is under way the planner is planning GW n+1 and must say so — otherwise
 * every recommendation reads as advice about a deadline that has already gone.
 *
 * @param {PlannerTiming|null} timing
 * @returns {string}  plain text, or '' when there is nothing to say
 */
export function timingNote(timing) {
  if (!timing || !timing.planningGw) return '';
  const { phase, currentGw, planningGw, unplayed } = timing;

  // The same short sentence in every phase. WHY the planning gameweek is not
  // the live one is a detail the user does not need spelled out on every
  // render — which round is being planned is the only part that changes what
  // they actually do.
  const lead = `This plan is for GW${planningGw}.`;

  if (phase !== 'live' || currentGw == null || unplayed <= 0) return lead;

  // The caution only makes sense while results are still outstanding: those
  // results move every number on this page, so committing a transfer now is
  // committing on information that is not in yet.
  const caution = unplayed === 1
    ? ` One GW${currentGw} match is still to play, and its result will move `
      + 'these numbers — deciding now means deciding on incomplete information.'
    : ` ${numberWord(unplayed)} GW${currentGw} matches are still to play, and `
      + 'those results will move these numbers — deciding now means deciding on '
      + 'incomplete information.';

  return lead + caution;
}

/**
 * @typedef {{ currentGw: number|null, planningGw: number|null,
 *             phase: 'live'|'pre-deadline'|'finished'|'off-season',
 *             unplayed: number }} PlannerTiming
 */

/**
 * Whether SOME candidate out-player is structurally broken, independent of
 * whether any candidate swap for them turned out profitable (the Structure
 * lane always scores `max(0, longXiDelta * gws)`, so a broken starter with no
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
export function emptyMessage(boardId, swaps) {
  switch (boardId) {
    case 'structure': return hasBrokenStarter(swaps)
      ? 'A starter is flagged, low on minutes, or rating poorly — but no '
        + 'affordable replacement actually gains points in your XI.'
      : 'Nothing broken — no starter is flagged or short of minutes.';
    case 'future':    return 'No strong enough run over the 3rd to 5th upcoming '
                           + 'gameweeks within your budget.';
    case 'funds':     return 'No cheaper player would also improve your XI — every '
                           + 'downgrade in price is a downgrade in points too.';
    case 'ceiling':   return 'No higher-ceiling option within budget.';
    case 'longterm':  return 'No move gains points across the next five gameweeks '
                           + 'within budget.';
    default:          return 'No move gains points in your XI within budget.';
  }
}
