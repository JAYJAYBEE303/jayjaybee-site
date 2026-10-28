/**
 * js/engine/solver/problem.js
 * Layer: engine (pure). A mode's problem for the solver, from the decision
 * engine's input and result (docs/decision-engine-solver-plan.md §2): each
 * mode as a setting - its weights and horizon, the players it keeps, the Free
 * Hit weeks it freezes, who it may buy, what its horizon's end is worth - and
 * that setting as the input of the model (engine/solver/model.js).
 *
 * Nothing here restates the engine's rules: the weights come masked by the
 * engine's own Free Hit and Wildcard rule, the protected players and holds from
 * its flags, the sell prices from its squad, the dead slots from its test. The
 * solver adds only what a plan over several weeks needs.
 */

import { MAX_PER_CLUB, SQUAD_LIMITS, XI_FORMATION_MIN } from '../../config.js';
import { fromTenths, toTenths } from '../../util.js';
import { LOCK_PROTECTED_MODES, isDeadSlot } from '../decision.js';

const dot = (weights, values) => weights.reduce((s, w, k) => s + (w * values[k]), 0);

/**
 * @typedef {object} SolverSetting
 * @property {string} modeId
 * @property {number[]} gws        the horizon: from the planning GW to the mode's last weighted one, before any Wildcard
 * @property {number[]} weights    the engine's weights for them, planned chips masked (a Free Hit week weighs 0)
 * @property {number[]} frozen     the horizon's GWs with a planned Free Hit: no transfers at all
 * @property {number[]} keep       owned ids not sold in the first week: locked, Ceiling-protected, Structure's holds
 * @property {number[]} bans       ids never bought
 * @property {(id: number) => boolean} buyable  not banned; Now's also fit to play, by its pZero gate, in the first GW
 * @property {boolean} [engineBuys]  false: the pool holds none of the engine's own buys, only the best of the others
 *   (the backtest's reproduction check); omitted or true: it holds them
 * @property {Object<number, number>} endFtValue  the value of each free transfer banked at the horizon's end, by count
 * @property {number} bankPerTenth  points for each tenth of £1m left in the bank at the horizon's end, scaled by the engine's share
 * @property {number} hitMargin    points added to every hit's cost
 * @property {boolean} [flatHits]  each hit costs hitCost plus the margin whatever its week weighs, as the engine prices
 *   a transfer (transferCost); omitted or false: a hit costs that times its week's weight (Phase 8's planner, which the
 *   backtest's reproduction check holds)
 * @property {{penalty: number, isDead: (id: number) => boolean}|null} deadSlot  Structure's: a dead slot kept costs the
 *   penalty, scaled by the engine's share
 * @property {Object<number, number>} salePoints  points for selling an owned id in the first week, scaled by the engine's share
 * @property {{benchboost: number|null, triplecaptain: number|null}} chips  the planned chip's GW inside the horizon
 */

/**
 * What each free transfer banked at a horizon's end is worth, by the count it brings the bank to: the engine's schedule,
 * or its flat value at every count when the engine prices a free transfer flat.
 * @param {object} config  DECISION_ENGINE
 * @returns {Object<number, number>}
 */
export function endFtValueOf(config) {
  return config.ftValueMode === 'decreasing' ? { ...config.ftValueSchedule }
    : Object.fromEntries(Object.keys(config.ftValueSchedule).map(count => [count, config.ftValueFlat]));
}

/**
 * One mode as a solver setting.
 *
 * @param {object} input   the engine's input
 * @param {object} result  runDecisionEngine(input, config)
 * @param {string} modeId
 * @param {object} config  DECISION_ENGINE
 * @returns {SolverSetting|{source: 'engine-tail'}|null}  null: every weight is 0, so the card rolls with no solve;
 *   engine-tail: Ceiling in a big week, which the engine's upper tail scores and the solver's expected points cannot
 */
export function modeSetting(input, result, modeId, config) {
  const mode = config.modes[modeId];
  const summary = result.modes[modeId];
  if (summary.bigWeek) return { source: 'engine-tail' };

  // The horizon ends at the last GW that weighs anything. The engine zeroes every GW from a planned Wildcard on, and a
  // Free Hit week alone, so that cut is also the one before a Wildcard.
  const last = summary.weights.findLastIndex(w => w > 0);
  if (last < 0) return null;
  const modeGws = summary.weights.map((_, k) => input.planningGw + k);
  const gws = modeGws.slice(0, last + 1);
  const planned = chip => gws.find(gw => input.chipPlan?.[gw] === chip) ?? null;

  const locks = input.locks ?? new Set();
  const kept = player => locks.has(player.playerId)
    || (LOCK_PROTECTED_MODES.has(modeId) && player.flags.includes('protected'))
    || (modeId === 'structure' && player.flags.includes('hold'));
  const bans = [...(input.bans ?? [])];
  const banned = new Set(bans);

  // MODEL: every mode values the bank at its own lambda, as the engine carries it in FundsTerm (Now's and Ceiling's is
  // 0); a tenth of £1m is a tenth of lambda. A likely fall in an owned player's sell price is worth selling him for.
  // Money and a dead slot matter only while this squad plays, so all three money terms follow the engine's share: the
  // part of the mode's weight no planned chip covers (a Wildcard's weeks are cut from the horizon, but not from the share).
  const { share } = summary;
  const lambda = mode.lambda ?? config.lambdaDefault;
  const salePoints = Object.fromEntries(result.players
    .map(player => [player.playerId, 0 - (lambda * fromTenths(player.saleTenths) * share)])
    .filter(([, points]) => points !== 0));

  const gate = mode.pZeroGate;
  return {
    modeId,
    gws,
    weights: summary.weights.slice(0, last + 1),
    frozen: gws.filter(gw => input.chipPlan?.[gw] === 'freehit'),
    keep: result.players.filter(kept).map(player => player.playerId),
    bans,
    // The engine's own gate: a buy flagged out, or likelier than the gate to get no minutes, in the first GW.
    buyable: id => {
      if (banned.has(id)) return false;
      if (gate === undefined) return true;
      const first = input.projections.get(id)?.gws.find(g => g.gw === input.planningGw);
      return first !== undefined && first.availability > 0 && first.pZero <= gate;
    },
    endFtValue: endFtValueOf(config),
    bankPerTenth: fromTenths(lambda) * share,
    hitMargin: config.solver.modes[modeId].hitMargin,
    flatHits: true,
    deadSlot: modeId === 'structure'
      ? { penalty: mode.deadSlotPenalty * share, isDead: id => isDeadSlot(input.projections.get(id), modeGws, mode) } : null,
    salePoints,
    chips: { benchboost: planned('benchboost'), triplecaptain: planned('triplecaptain') },
  };
}

/**
 * A setting as the model's input: the owned 15 at the engine's sell prices, the pool of others a plan may buy, their
 * projections by GW, the bank, the free transfers and the game's rules.
 *
 * The pool is, per position, the `pool.points` best of the others by weighted points over the horizon and the
 * `pool.pointsPerTenth` best by weighted points a tenth of £1m, among those the setting can buy; plus every buy the
 * engine itself made across its modes (roots, alternatives and the second buys Funds chains), if the setting can buy
 * it, unless the setting turns that off. A player outside both lists is rarely in an optimal plan, and the whole pool is
 * too big to solve.
 *
 * @param {object} input   the engine's input
 * @param {object} result  runDecisionEngine(input, config)
 * @param {SolverSetting} setting  modeSetting's, not null and not the engine's
 * @param {object} config  DECISION_ENGINE
 * @returns {object}  buildPlan's input
 */
export function solverProblem(input, result, setting, config) {
  const { gws, weights } = setting;
  const { pool } = config.solver;
  const xptsOf = id => gws.map(gw => input.projections.get(id)?.gws.find(g => g.gw === gw)?.xpts ?? 0);

  const sellPrice = new Map(result.players.map(player => [player.playerId, player.sellPriceTenths]));
  const owned = input.squad.map(s => ({
    id: s.playerId, position: s.position, teamId: s.teamId, priceTenths: s.priceTenths,
    sellTenths: sellPrice.get(s.playerId), owned: true, xpts: xptsOf(s.playerId),
  }));
  const ownedIds = new Set(owned.map(q => q.id));

  const others = (input.candidates ?? []).filter(c => !ownedIds.has(c.id) && setting.buyable(c.id));
  const worth = new Map(others.map(c => [c.id, dot(weights, xptsOf(c.id))]));
  const perTenth = c => worth.get(c.id) / toTenths(c.price);
  const best = (list, n, score) => [...list].sort((a, b) => (score(b) - score(a)) || (a.id - b.id)).slice(0, n).map(c => c.id);
  const chosen = new Set();
  for (const position of Object.keys(SQUAD_LIMITS)) {
    const ofPosition = others.filter(c => c.position === position);
    for (const id of [...best(ofPosition, pool.points, c => worth.get(c.id)), ...best(ofPosition, pool.pointsPerTenth, perTenth)]) chosen.add(id);
  }
  const candidateOf = new Map(others.map(c => [c.id, c]));
  const engineMoves = setting.engineBuys === false ? [] : Object.values(result.modes).flatMap(m => [m.root, ...m.alternatives]);
  for (const move of engineMoves.filter(Boolean)) {
    for (const id of [move.inId, move.chained?.inId]) if (candidateOf.has(id)) chosen.add(id);
  }
  const bought = [...chosen].map(id => {
    const c = candidateOf.get(id);
    const priceTenths = toTenths(c.price);
    return { id, position: c.position, teamId: c.teamId, priceTenths, sellTenths: priceTenths, owned: false, xpts: xptsOf(id) };
  });
  const players = [...owned, ...bought];

  // The chips the setting places, each in its planned week.
  const placed = Object.entries(setting.chips).filter(([, gw]) => gw !== null);
  return {
    gws, weights, players,
    bankTenths: input.bankTenths,
    ft: input.freeTransfers,
    maxBankedFt: config.maxBankedFt,
    hitCost: config.hitCost,
    benchWeights: config.benchWeightsLinear,
    maxPerClub: MAX_PER_CLUB,
    squadLimits: SQUAD_LIMITS,
    xiMin: XI_FORMATION_MIN,
    lineTerms: config.solver.lpLineTerms,
    chips: Object.fromEntries(placed.map(([chip]) => [chip, true])),
    fixed: Object.fromEntries(placed),
    endFtValue: setting.endFtValue,
    bankPerTenth: setting.bankPerTenth,
    hitMargin: setting.hitMargin,
    flatHits: setting.flatHits,
    keep: setting.keep,
    frozen: setting.frozen,
    salePoints: setting.salePoints,
    deadSlot: setting.deadSlot && {
      ids: players.filter(q => setting.deadSlot.isDead(q.id)).map(q => q.id),
      penalty: setting.deadSlot.penalty,
    },
  };
}
