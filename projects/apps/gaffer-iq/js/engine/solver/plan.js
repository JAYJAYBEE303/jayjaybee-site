/**
 * js/engine/solver/plan.js
 * Layer: engine (pure). A solved plan as the card shows it (docs/decision-engine-solver-plan.md §3): the first week's
 * sales and buys paired and ordered into moves FPL takes one at a time, the check that no protected player was sold,
 * the card's call, the card with the figures that land on it later - keyed to the move set and the input they were
 * computed for - the plan's gain over rolling, and its alternatives. The engine explains the moves
 * (describePlan, engine/decision.js); nothing here restates its rules.
 */

import { toTenths } from '../../util.js';
import { LOCK_PROTECTED_MODES, moveSetKey } from '../decision.js';
import { checkSwap } from '../feasibility.js';

export { moveSetKey };

// The figures a card carries once they land: each is { key, value }, or null until computed for this card's move set.
const FIGURES = ['gain', 'alternatives', 'robustness'];

/**
 * The first week's sales and buys as moves FPL takes one at a time - each sale paired with a buy of his position, in an
 * order that keeps the bank and the club limit legal after every move (FPL checks the week's set as a whole; the
 * app's moves are made one by one). Greedy: each step makes the legal pair that frees the most money, a sale valued at
 * his sell price. If it gets stuck, the moves made so far.
 *
 * @param {object} input   the engine's input
 * @param {object} result  runDecisionEngine(input, config): the sell prices
 * @param {{in: number[], out: number[]}} firstWeek  a plan's first week
 * @returns {{moves: Array<{outId: number, inId: number}>, unordered: boolean}}  unordered: some moves had no legal order
 */
export function orderMoves(input, result, firstWeek) {
  const sellPrice = new Map(result.players.map(player => [player.playerId, player.sellPriceTenths]));
  const buys = new Map((input.candidates ?? []).map(c => [c.id, c]));
  let state = {
    bankTenths: input.bankTenths,
    players: input.squad.map(s => ({ playerId: s.playerId, position: s.position, teamId: s.teamId,
      priceTenths: s.priceTenths, sellPriceTenths: sellPrice.get(s.playerId) })),
  };
  let left = { ins: firstWeek.in, outs: firstWeek.out };
  const moves = [];
  const freed = ({ outId, inId }) => state.players.find(p => p.playerId === outId).sellPriceTenths - toTenths(buys.get(inId).price);
  while (left.outs.length) {
    const legal = left.outs.flatMap(outId => left.ins.map(inId => ({ outId, inId })))
      .filter(({ outId, inId }) => checkSwap(state, outId, buys.get(inId)).ok);
    if (!legal.length) break;
    const move = legal.reduce((a, b) => (freed(b) > freed(a) ? b : a));
    const { position, teamId, price } = buys.get(move.inId);
    const bank = state.bankTenths + freed(move);
    // A buy sells back at his price until it moves.
    state = {
      bankTenths: bank,
      players: state.players.map(p => (p.playerId === move.outId
        ? { playerId: move.inId, position, teamId, priceTenths: toTenths(price), sellPriceTenths: toTenths(price) } : p)),
    };
    moves.push(move);
    left = { outs: left.outs.filter(id => id !== move.outId), ins: left.ins.filter(id => id !== move.inId) };
  }
  return { moves, unordered: left.outs.length > 0 };
}

/**
 * A week's sales and buys as moves, paired by position and by id with no thought for the bank: for the weeks of a plan
 * that are not made yet and the alternatives, which are shown but not ordered (orderMoves is the first week's).
 *
 * @param {{in: number[], out: number[]}} week
 * @param {(id: number) => string} positionOf
 * @returns {Array<{outId: number, inId: number}>}
 */
export function pairMoves(week, positionOf) {
  const ins = [...week.in].sort((a, b) => a - b);
  return [...week.out].sort((a, b) => a - b).map(outId => {
    const inId = ins.find(id => positionOf(id) === positionOf(outId));
    if (inId === undefined) throw new Error(`pairMoves: no buy of ${positionOf(outId)} for ${outId}`);
    ins.splice(ins.indexOf(inId), 1);
    return { outId, inId };
  });
}

/**
 * Throws if a plan's first week sells a player the mode must not sell (the engine's flags): a Ceiling-protected one in
 * Now, Long term, Future prep and Funds, a locked one in every mode, one Structure holds in Structure. That is a bug in
 * the model or the problem, never a recommendation.
 *
 * A wait is checked too, in the week it waits for: the model keeps a player in the first week only, so a plan may
 * sell a locked one the week after, which the card would then recommend against the lock on its own button.
 *
 * @param {string} modeId
 * @param {{in: number[], out: number[]}} firstWeek  the week the card's move is made in
 * @param {object} result  runDecisionEngine's: players[].flags
 * @param {string} [when]  how the error names that week
 */
export function checkProtected(modeId, firstWeek, result, when = 'its first week') {
  const flagsOf = new Map(result.players.map(player => [player.playerId, player.flags]));
  for (const id of firstWeek.out) {
    const flags = flagsOf.get(id) ?? [];
    if (flags.includes('locked') || (LOCK_PROTECTED_MODES.has(modeId) && flags.includes('protected'))
        || (modeId === 'structure' && flags.includes('hold'))) {
      throw new Error(`solver: ${modeId} sold protected player ${id} in ${when}`);
    }
  }
}

/**
 * The card's call: a move if the first week has moves; a wait if it has none and the second week does; else a roll.
 * @param {{weeks: Array<{in: number[], out: number[]}>}} plan
 * @returns {'move'|'wait'|'roll'}
 */
export function callOf(plan) {
  const [first, second] = plan.weeks;
  if (first.out.length) return 'move';
  return second?.out.length ? 'wait' : 'roll';
}

/**
 * The card a solved plan makes for a mode: the engine's card for it with the solver's moves in place of the engine's.
 * `root` keeps today's shape (the first move with the whole set's figures), so a card of one move renders as it did.
 * The figures that take another solve or more (`gain`, `alternatives`, `robustness`) start null: each lands as
 * { key, value } through withFigure, and only on the card whose key it was computed for.
 *
 * @param {object} engineMode  the engine's summary of the mode (DecisionResult.modes[m])
 * @param {object} p
 * @param {object} p.plan          the decoded plan
 * @param {Array<{outId: number, inId: number}>} p.moves  the card's moves, in order: the first week's, or a wait's next week's
 * @param {object} p.describe      describePlan(...) for those moves
 * @param {number|string} p.inputVersion  which run of the engine's input the plan is for
 * @param {(id: number) => string} p.positionOf  an id's position, to pair the later weeks' sales and buys (pairMoves)
 * @param {'move'|'wait'|'roll'} [p.call]  the card's call where it is not the plan's own: a roll, with no moves, for a
 *   pick whose gain over rolling is no more than the solver's tolerance (the plan's later weeks stay, tentative)
 * @returns {object}
 * @throws  when the plan moves or waits but `moves` is empty, when `describe` is not for `moves`, or without positionOf
 */
export function solverCard(engineMode, { plan, moves, describe, inputVersion, positionOf, call = callOf(plan) }) {
  if (typeof positionOf !== 'function') throw new TypeError('solverCard: positionOf is required, to pair the later weeks');
  // describe.moves are matched to moves by index: they must be the explanation of these moves.
  if (describe.key !== moveSetKey(moves)) throw new Error('solverCard: describe is not for these moves');
  // A card that moves or waits is rendered from its first move: with none (no legal order was found) there is no card.
  if (call !== 'roll' && moves.length === 0) throw new Error(`solverCard: the plan calls a ${call} but no move has a legal order`);
  const merged = moves.map((move, i) => ({ ...move, ...describe.moves[i] }));
  const tentativeFromGw = plan.weeks[0].gw + 1;
  // Week 0 is the card's own, or (a wait) week 1 is: the weeks after that are shown tentative.
  const after = plan.weeks.slice(1);
  // Whatever the call, the weeks after the plan's own move: a wait the solver cannot make rolls with that list.
  const later = (callOf(plan) === 'wait' ? after.slice(1) : after).filter(week => week.out.length);
  return {
    ...engineMode,
    source: 'solver',
    call,
    moves: merged,
    root: merged.length === 0 ? null : {
      ...merged[0], perGw: describe.perGw, deltaEv: describe.deltaEv, why: describe.why,
      overFiveGws: describe.overFiveGws, tentativeFromGw,
    },
    // By FPL's rule, from the moves: the plan's own count can run over when a solve stops inside its gap.
    hits: call === 'move' ? describe.hits : 0,
    waitForNews: describe.waitForNews,
    deferral: call === 'wait' ? { gw: plan.weeks[1].gw } : null,
    later: later.map(week => ({ gw: week.gw, moves: pairMoves(week, positionOf) })),
    key: `${moveSetKey(moves)}|${inputVersion}`,
    gain: null,
    alternatives: null,
    robustness: null,
  };
}

/**
 * A figure landing on a card: set when it was computed for this card's move set and input, else dropped - the card
 * comes back as it was, so a figure for another move or an older input is never shown beside this one.
 *
 * @param {object} card    solverCard's
 * @param {'gain'|'alternatives'|'robustness'} name
 * @param {string} key     the key of the card the figure was computed for
 * @param {*} value
 * @returns {object}  a new card, or the same one
 */
export function withFigure(card, name, key, value) {
  if (!FIGURES.includes(name)) throw new Error(`withFigure: ${name} is not a figure of a card`);
  return key === card.key ? { ...card, [name]: { key, value } } : card;
}

/**
 * A problem's rolling twin: the same problem with the first week held to no moves, which the gain over rolling is
 * priced against.
 * @param {object} problem  buildPlan's input
 * @returns {object}
 */
export function rollingProblem(problem) {
  return { ...problem, fixed: { ...problem.fixed, first: { in: [], out: [] } } };
}

/**
 * The plan's gain over rolling, on the mode's own objective.
 * @param {{objective: number}} plan
 * @param {{objective: number}} rollingPlan  the solve of rollingProblem
 * @returns {number}
 */
export const gainOverRolling = (plan, rollingPlan) => plan.objective - rollingPlan.objective;

/**
 * The plan's alternatives: up to `alternativesMax` re-solves of its problem, each with the first weeks found so far
 * excluded (no-good cuts), kept while the plan's objective less theirs is within `alternativesWindow`. Best first.
 *
 * @param {object} problem   buildPlan's input, the one `plan` solved
 * @param {{objective: number, weeks: Array<{in: number[], out: number[]}>}} plan  the pick
 * @param {(problem: object) => object|null|Promise<object|null>} solveFn  a plan, or null when there is none
 * @param {{alternativesMax: number, alternativesWindow: number}} config
 * @returns {Promise<Array<{moves: Array<{outId: number, inId: number}>, gain: number}>>}  gain: its objective less the
 *   pick's (no more than 0 when the pick is optimal); `moves` are paired, not ordered (pairMoves)
 */
export async function alternativesOf(problem, plan, solveFn, config) {
  const positions = new Map(problem.players.map(q => [q.id, q.position]));
  const firstOf = ({ in: ins, out }) => ({ in: ins, out });
  let exclude = [...(problem.exclude ?? []), firstOf(plan.weeks[0])];
  const found = [];
  while (found.length < config.alternativesMax) {
    const alt = await solveFn({ ...problem, exclude });
    if (!alt || plan.objective - alt.objective > config.alternativesWindow) break;
    found.push({ moves: pairMoves(alt.weeks[0], id => positions.get(id)), gain: alt.objective - plan.objective });
    exclude = [...exclude, firstOf(alt.weeks[0])];
  }
  return found;
}
