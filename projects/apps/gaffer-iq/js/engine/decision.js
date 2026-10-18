/**
 * js/engine/decision.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * The decision engine (brief §5-§6; docs/decision-engine-plan.md §5.2,
 * Phase 3): every legal single transfer is scored by what it does to the whole
 * squad's value V_t(S) (engine/squad-value.js) over the next five gameweeks,
 * and six modes - parameter presets of that one calculation, differing in
 * their GW weights, funds rate and gates - each name one move, a "roll", or
 * (Future prep) a move to "wait" on.
 * Every component is kept, so the UI can explain each call.
 *
 * OutScore = DeltaEV + FundsTerm - PriceTerm - TransferCost: the gain over
 * rolling, with the free transfer's value (or the hit) already paid, so a
 * move is made only when OutScore clears the mode's threshold (Q7).
 *
 * Money is integer tenths of a million, and a sold player is always valued at
 * his SELL price (engine/prices.js, engine/feasibility.js). V is cached per
 * (gameweek, swap): pass the same cache back and a lock, ban or FT change
 * re-runs on cached values; a bank change, or a lock that changes which
 * downgrades Funds chains, computes only the swaps it newly makes legal.
 *
 * Prices (Phase 5) come in as signals (engine/price-adapter.js) and act on the
 * seller's SELL price, never his price: PriceTerm is the change to expect in
 * it, a tie-break worth lambda per £1.0m. They also time the calls: Future
 * prep waits when the move made next week scores as well, unless a likely
 * price move would put the buy out of reach; Now flags a move to wait for team
 * news when the press conferences are still to come and waiting costs nothing
 * in price. Money and price never make a move on their own (Funds aside).
 */

import { DECISION_ENGINE, SQUAD_TOTAL, SEASON_GWS, CHIP_RESET_AFTER_GW, CHIP_LABELS } from '../config.js';
import { fromTenths, toTenths } from '../util.js';
import { calcSellPrice } from './prices.js';
import { checkSwap } from './feasibility.js';
import { squadValue, uncoveredLoss } from './squad-value.js';

const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];

// Chips that V itself prices; Free Hit and Wildcard act through the weights.
const VALUE_CHIPS = new Set(['benchboost', 'triplecaptain']);

// Modes whose sells a high Ceiling lock value blocks (brief §6, mode 5).
const LOCK_PROTECTED_MODES = new Set(['now', 'longterm', 'future', 'funds']);

/**
 * A cache of V values to pass back into runDecisionEngine between runs. It
 * empties itself when the projections Map, the squad or the autosub settings
 * change; each value is keyed by its GW's planned Bench Boost / Triple
 * Captain, so moving one recomputes only the weeks it touches. A projections
 * Map is read as immutable: build a new one rather than editing it in place.
 */
export function createDecisionCache() {
  return { projections: null, key: null, values: new Map() };
}

/**
 * What making a transfer costs, given the free transfers banked (plan §5.2):
 * with none left, the hit plus its margin; at the cap, nothing (rolling would
 * waste one); otherwise the value of the free transfer that rolling would bank.
 *
 * @param {number} freeTransfers
 * @param {object} [config]  DECISION_ENGINE by default
 * @returns {number} points
 */
export function transferCost(freeTransfers, config = DECISION_ENGINE) {
  if (freeTransfers <= 0) return config.hitCost + config.hitMargin;
  if (freeTransfers >= config.maxBankedFt) return 0;
  return config.ftValueMode === 'flat' ? config.ftValueFlat : config.ftValueSchedule[freeTransfers + 1];
}

/**
 * Score every legal single transfer under each mode.
 *
 * @param {object} input
 * @param {number} input.planningGw
 * @param {Array<{playerId: number, name: string, position: string, teamId: number,
 *   priceTenths: number, purchaseTenths: number|null}>} input.squad  15; a
 *   purchase of null means no ledger entry: he sells at his current price, flagged
 * @param {number} input.bankTenths
 * @param {number} input.freeTransfers  banked for the planning GW, 0-5
 * @param {Object<number, string>} input.chipPlan  gw -> chip id (the engine's only chip input)
 * @param {Array<{chip: string, gw: number}>} input.chipsUsed  for the chip hints' halves
 * @param {Set<number>} input.locks  never sold
 * @param {Set<number>} input.bans   never bought
 * @param {Map} input.projections    buildProjections output for the squad and every candidate
 * @param {Player[]} input.candidates  every possible replacement (price in millions)
 * @param {Object<number, {fall: number, rise: number, source: string}>|null} input.priceSignals
 *   priceSignals() of engine/price-adapter.js: each player's chances of a price
 *   fall and rise soon; null or a missing player means no move expected
 * @param {number|null} [input.hoursToDeadline]  to the planning GW's deadline;
 *   null when unknown (Now then never waits for team news)
 * @param {object} [config]  DECISION_ENGINE by default
 * @param {object} [cache]   createDecisionCache(), kept between runs; the
 *   one argument written to (by design: it holds the V values)
 * @returns {DecisionResult}  see docs/decision-engine-plan.md §5.2
 */
export function runDecisionEngine(input, config = DECISION_ENGINE, cache = createDecisionCache()) {
  const run = prepare(input, config, cache);
  const pairs = enumeratePairs(run);
  const keepDeltas = new Map(run.owned.map(p => [p.playerId, ghostDeltas(run, p)]));
  const ceiling = ceilingTarget(run, pairs);
  const structure = structureSignals(run);

  const modes = {};
  const bestByMode = {};
  // The buys engine/robustness.js re-scores: each mode's best moves, with the
  // second buys Funds chains to them, and each player's peak-week replacement
  // (Ceiling's lock values read them).
  const shortlist = new Set(ceiling.replacements);
  for (const [modeId, mode] of Object.entries(config.modes)) {
    const raw = modeId === 'ceiling' ? ceiling.weights : weightsOf(run, mode);
    const weights = masked(run, raw);
    const total = sum(raw);
    // MODEL: money freed and a dead slot matter only while this squad plays;
    // a Free Hit or Wildcard budget is the squad's value either way. So both
    // count for the share of the mode's weight that no planned chip covers.
    const share = total > 0 ? sum(weights) / total : 0;
    const result = scoreMode(run, { modeId, mode, raw, weights, share, pairs, ceiling, structure });
    modes[modeId] = result.summary;
    bestByMode[modeId] = result.bestByOwner;
    for (const id of result.top) shortlist.add(id);
  }

  const rootSells = new Set(Object.values(modes).filter(m => m.call === 'move').map(m => m.root.outId));
  const players = run.owned.map(p => {
    const keepValue = {};
    const outScore = {};
    const best = {};
    for (const [modeId, summary] of Object.entries(modes)) {
      keepValue[modeId] = dot(summary.weights, keepDeltas.get(p.playerId));
      best[modeId] = bestByMode[modeId].get(p.playerId) ?? null;
      outScore[modeId] = best[modeId]?.outScore ?? null;
    }
    return {
      playerId: p.playerId,
      sellPriceTenths: p.sellPriceTenths,
      keepValue, outScore, best,
      flags: flagsFor(run, p, { rootSells, ceiling, structure }),
      lockValue: ceiling.lockValues.get(p.playerId),
      uncoveredLoss: structure.uncovered.get(p.playerId),
      priceSource: input.priceSignals?.[p.playerId]?.source ?? null,
    };
  });

  return { modes, players, lineup: lineupOf(run), chipHints: chipHints(run), shortlist: [...shortlist] };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

function prepare(input, config, cache) {
  const { planningGw, squad, bankTenths, freeTransfers, projections } = input ?? {};
  if (!Number.isInteger(planningGw) || !Array.isArray(squad) || squad.length !== SQUAD_TOTAL
      || !Number.isInteger(bankTenths) || !Number.isInteger(freeTransfers) || freeTransfers < 0
      || !(projections instanceof Map)) {
    throw new TypeError('runDecisionEngine: planningGw, a full squad, integer bankTenths, '
      + 'freeTransfers and a projections Map are required');
  }

  const owned = squad.map(s => {
    const estimated = s.purchaseTenths === null || s.purchaseTenths === undefined;
    return {
      ...s,
      sellPriceTenths: calcSellPrice(estimated ? s.priceTenths : s.purchaseTenths, s.priceTenths),
      sellPriceEstimated: estimated,
    };
  });
  const ids = owned.map(p => p.playerId);
  const ownedIds = new Set(ids);
  for (const id of ids) {
    if (!projections.has(id)) throw new TypeError(`runDecisionEngine: squad player ${id} has no projection`);
  }
  // A chip planned for a GW already gone is history, not a plan.
  const chipPlan = Object.fromEntries(Object.entries(input.chipPlan ?? {})
    .filter(([gw]) => Number(gw) >= planningGw));

  // Ghosts for KeepValue (plan §5.2): a zero-points placeholder per position,
  // never bought, never priced.
  const overlay = new Map(projections);
  const reference = projections.get(ids[0]);
  for (const position of POSITIONS) {
    overlay.set(ghostId(position), {
      playerId: ghostId(position), position, teamId: null, price: 0,
      gws: reference.gws.map(g => ({ ...g, fixtures: 0, xpts: 0, xptsIfPlays: 0, pZero: 1, pStart: 0,
        p60: 0, availability: 0 })),
    });
  }

  const candidatesByPosition = Object.fromEntries(POSITIONS.map(pos => [pos, []]));
  for (const player of input.candidates ?? []) {
    if (ownedIds.has(player.id)) continue;
    if (!projections.has(player.id)) {
      throw new TypeError(`runDecisionEngine: candidate ${player.id} has no projection`);
    }
    candidatesByPosition[player.position]?.push(player);
  }

  const modeGws = config.modes.now.weights.map((_, k) => planningGw + k);
  for (const [modeId, mode] of Object.entries(config.modes)) {
    if (Array.isArray(mode.weights) && mode.weights.length !== modeGws.length) {
      throw new TypeError(`runDecisionEngine: mode ${modeId} must weigh the same number of GWs as Now`);
    }
  }
  const chipAt = gw => (VALUE_CHIPS.has(chipPlan[gw]) ? chipPlan[gw] : null);
  const wildcardGws = Object.entries(chipPlan).filter(([, chip]) => chip === 'wildcard').map(([gw]) => Number(gw));
  // Free Hit and Wildcard (plan §5.2): a Free Hit GW, and every GW from a
  // Wildcard on, is played by a different squad - this one's moves count
  // nothing there. Nor does a GW after the season's last: nobody plays it.
  const zeroed = gw => gw > SEASON_GWS || chipPlan[gw] === 'freehit' || wildcardGws.some(w => w <= gw);

  // The squad and the autosub settings key the whole cache; a GW's planned
  // Bench Boost / Triple Captain keys each value, so moving one keeps the rest.
  const key = [ids.join(','), config.autosubMode, JSON.stringify(config.benchWeightsLinear)].join('|');
  if (cache.projections !== projections || cache.key !== key) {
    cache.projections = projections;
    cache.key = key;
    cache.values = new Map();
  }
  const valueOpts = gw => ({ chip: chipAt(gw), autosubMode: config.autosubMode,
    benchWeightsLinear: config.benchWeightsLinear });
  const value = (gw, squadIds, swapKey) => {
    const cacheKey = `${gw}|${chipAt(gw) ?? ''}|${swapKey}`;
    let v = cache.values.get(cacheKey);
    if (v === undefined) {
      v = squadValue(squadIds, gw, overlay, valueOpts(gw)).value;
      cache.values.set(cacheKey, v);
    }
    return v;
  };

  const names = new Map([...owned.map(p => [p.playerId, p.name]),
    ...(input.candidates ?? []).map(c => [c.id, c.name])]);

  const signals = input.priceSignals ?? {};
  const outlook = new Map(owned.map(p => [p.playerId, sellOutlook(p, signals[p.playerId], config)]));

  return {
    input, config, owned, ids, chipPlan, overlay, candidatesByPosition, modeGws, chipAt, zeroed,
    value, valueOpts, names, outlook,
    riseLikely: id => chanceOf(signals[id], 'rise') >= config.priceMoveLikely,
    state: { bankTenths, players: owned },
    locks: input.locks ?? new Set(),
    bans: input.bans ?? new Set(),
    cost: transferCost(freeTransfers, config),
    base: modeGws.map(gw => value(gw, ids, 'S')),
    gwOf: (id, gw) => overlay.get(id)?.gws.find(g => g.gw === gw),
  };
}

const ghostId = position => `ghost:${position}`;
const swapIn = (ids, outId, inId) => ids.map(id => (id === outId ? inId : id));
const dot = (weights, values) => weights.reduce((s, w, k) => s + (w * values[k]), 0);
const sum = values => values.reduce((s, x) => s + x, 0);

/** A preset's GW weights: as written, or decayBase^k for 'decay'. */
function weightsOf(run, mode) {
  return mode.weights === 'decay' ? run.modeGws.map((_, k) => run.config.decayBase ** k) : mode.weights;
}

/** A mode's weights with the Free Hit / Wildcard GWs zeroed. */
function masked(run, weights) {
  return weights.map((w, k) => (run.zeroed(run.modeGws[k]) ? 0 : w));
}

/**
 * What a player's price signal means for his sell price: the change to expect,
 * in tenths, what one fall or rise would do to it, and whether a fall that
 * lowers it, or a rise that lifts it, is likely. A fall from an odd-tenths
 * profit costs the seller nothing (brief §7 Phase 5).
 */
function sellOutlook(p, signal, config) {
  const purchase = p.sellPriceEstimated ? p.priceTenths : p.purchaseTenths;
  const down = calcSellPrice(purchase, p.priceTenths - 1) - p.sellPriceTenths;
  const up = calcSellPrice(purchase, p.priceTenths + 1) - p.sellPriceTenths;
  const fall = chanceOf(signal, 'fall');
  const rise = chanceOf(signal, 'rise');
  return {
    expected: (fall * down) + (rise * up),
    down,
    up,
    fallLikely: down < 0 && fall >= config.priceMoveLikely,
    riseLikely: up > 0 && rise >= config.priceMoveLikely,
  };
}

/** A price signal's chance of a fall or rise; 0 when the signal or the number is missing. */
function chanceOf(signal, key) {
  return Number.isFinite(signal?.[key]) ? signal[key] : 0;
}

// ─── V for every legal swap ──────────────────────────────────────────────────

/**
 * Every legal (p, q): q the same position, the club limit kept, affordable at
 * p's sell price. dV[k] = V_t(S - p + q) - V_t(S) for each of the five GWs,
 * left at 0 where a Free Hit or Wildcard makes the GW count for nothing.
 * Banned players are scored too, so a ban re-run needs no new V.
 */
function enumeratePairs(run) {
  const pairs = [];
  for (const p of run.owned) {
    for (const q of run.candidatesByPosition[p.position]) {
      if (!checkSwap(run.state, p.playerId, q).ok) continue;
      const ids = swapIn(run.ids, p.playerId, q.id);
      pairs.push({
        p, q,
        dV: run.modeGws.map((gw, k) =>
          (run.zeroed(gw) ? 0 : run.value(gw, ids, `${p.playerId}>${q.id}`) - run.base[k])),
        moneyFreed: p.sellPriceTenths - toTenths(q.price),
      });
    }
  }
  return pairs;
}

/** V_t(S) - V_t(S - p + ghost) for each GW: what p is worth to the squad. */
function ghostDeltas(run, p) {
  const ids = swapIn(run.ids, p.playerId, ghostId(p.position));
  return run.modeGws.map((gw, k) =>
    (run.zeroed(gw) ? 0 : run.base[k] - run.value(gw, ids, `${p.playerId}>ghost`)));
}

// ─── Mode 5: the target GW and the lock list ─────────────────────────────────

/**
 * t*: the GW in the mode horizon whose 15 highest projected xpts - across
 * every projected player, the squad and the candidates - sum highest; a tie
 * goes to the GW with more clubs playing a double, then to the earlier GW. A
 * GW a planned Free Hit or Wildcard covers is played by another squad and is
 * never t*; with every GW covered there is none.
 * MODEL: read as the GW with the most to gain for any squad, which also keeps
 * t* from moving with the moves being scored.
 *
 * Lock value: V_t*(S) - V_t*(S - p + his best affordable replacement); at or
 * above lockThreshold he is protected from sale in modes 1-4. With no
 * affordable replacement, or no t*, there is no sale to protect against: null.
 *
 * @returns {{ targetGw: number|null, weights: number[], lockValues: Map,
 *   protectedIds: Set, replacements: Set }}  weights before Free Hit / Wildcard
 *   masking; replacements: each player's best affordable replacement at t*
 */
function ceilingTarget(run, pairs) {
  const { config, modeGws } = run;
  const mode = config.modes.ceiling;
  const projections = [...run.input.projections.values()];
  let target = null;
  modeGws.forEach((gw, k) => {
    if (run.zeroed(gw)) return;
    const gws = projections.map(p => p.gws.find(g => g.gw === gw));
    const top = gws.map(g => g?.xpts ?? 0).sort((a, b) => b - a).slice(0, SQUAD_TOTAL);
    const total = sum(top);
    const doubles = new Set(projections.filter((p, i) => (gws[i]?.fixtures ?? 0) > 1).map(p => p.teamId)).size;
    if (!target || total > target.total || (total === target.total && doubles > target.doubles)) {
      target = { gw, k, total, doubles };
    }
  });
  const weights = modeGws.map(gw => (target === null ? 0
    : gw === target.gw ? mode.targetWeight : mode.otherWeight));

  const lockValues = new Map();
  const replacements = new Set();
  for (const p of run.owned) {
    let best = null;
    for (const pair of pairs) {
      if (target === null || pair.p !== p || run.bans.has(pair.q.id)) continue;
      if (best === null || pair.dV[target.k] > best.dV[target.k]) best = pair;
    }
    lockValues.set(p.playerId, best === null ? null : -best.dV[target.k]);
    if (best) replacements.add(best.q.id);
  }
  const protectedIds = new Set(run.owned.map(p => p.playerId)
    .filter(id => lockValues.get(id) !== null && lockValues.get(id) >= mode.lockThreshold));
  return { targetGw: target?.gw ?? null, weights, lockValues, protectedIds, replacements };
}

// ─── Mode 6: uncovered loss, dead slots, holds ───────────────────────────────

/**
 * Per owned player: his uncovered loss - pZero x (xptsIfPlays - what the bench
 * recovers in his place) - summed with Structure's weights (brief §6).
 * MODEL: it is reported, not added: V already counts it, through the autosub
 * term, so every mode's DeltaEV credits a move that removes it.
 *
 * A dead slot: expected GWs unavailable over the horizon reach deadSlotMinGws.
 * A hold: flagged now, his availability reaches recoveredAvailability inside
 * the horizon, and no fall in his sell price is likely.
 */
function structureSignals(run) {
  const { config, modeGws } = run;
  const mode = config.modes.structure;
  const weights = masked(run, weightsOf(run, mode));
  const losses = modeGws.map(gw => uncoveredLoss(run.ids, gw, run.overlay, run.valueOpts(gw)));
  const uncovered = new Map(run.owned.map(p => [p.playerId,
    dot(weights, losses.map(loss => loss.get(p.playerId) ?? 0))]));

  const availabilities = id => modeGws.map(gw => run.gwOf(id, gw)?.availability ?? 1);
  const isDeadSlot = id =>
    sum(availabilities(id).map(a => 1 - a)) >= mode.deadSlotMinGws;
  const holds = new Set(run.owned.map(p => p.playerId).filter(id => {
    const a = availabilities(id);
    return a[0] < 1 && a.some(x => x >= mode.recoveredAvailability) && !run.outlook.get(id).fallLikely;
  }));
  return { uncovered, isDeadSlot, holds };
}

// ─── Scoring one mode ────────────────────────────────────────────────────────

function scoreMode(run, { modeId, mode, raw, weights, share, pairs, ceiling, structure }) {
  const { config, cost } = run;
  const lambda = mode.lambda ?? config.lambdaDefault;
  const gate = mode.pZeroGate;
  const pointsLostOf = deltaEv => Math.max(0, -deltaEv);

  // A mode whose every GW a planned chip covers has nothing to weigh: it
  // rolls, whatever money a move would free.
  const scored = weights.some(w => w > 0) ? pairs : [];
  const records = [];
  for (const pair of scored) {
    if (run.bans.has(pair.q.id)) continue;
    if (gate !== undefined) {
      // Now: an incoming player flagged out, or likelier than the gate to get
      // no minutes in the planning GW, is never its buy.
      const first = run.gwOf(pair.q.id, run.modeGws[0]);
      if (first.availability === 0 || first.pZero > gate) continue;
    }
    const perGw = weights.map((w, k) => w * pair.dV[k]);
    const deltaEv = sum(perGw);
    const record = {
      pair, perGw, deltaEv,
      fundsTerm: lambda * fromTenths(pair.moneyFreed) * share,
      // The change his sell price can expect before the next chance to act,
      // valued like money freed: selling now gains a likely fall it avoids.
      priceTerm: lambda * fromTenths(run.outlook.get(pair.p.playerId).expected) * share,
      deadSlotTerm: 0,
      efficiency: null,
      chained: null,
    };
    if (modeId === 'funds') {
      // A downgrade that frees money for at most tau points lost (brief §6,
      // mode 4). Its efficiency, money freed per point lost, picks the
      // downgrades addChains searches; moves rank by OutScore, as in every mode.
      const pointsLost = pointsLostOf(deltaEv);
      if (pair.moneyFreed <= 0 || pointsLost > mode.tau) continue;
      record.efficiency = fromTenths(pair.moneyFreed) / Math.max(mode.eps, pointsLost);
    }
    if (modeId === 'structure') {
      const penalty = mode.deadSlotPenalty * share;
      record.deadSlotTerm = (structure.isDeadSlot(pair.p.playerId) ? penalty : 0)
        - (structure.isDeadSlot(pair.q.id) ? penalty : 0);
    }
    records.push(record);
  }

  const eligibleSeller = id => !run.locks.has(id)
    && !(LOCK_PROTECTED_MODES.has(modeId) && ceiling.protectedIds.has(id))
    && !(modeId === 'structure' && structure.holds.has(id));

  if (modeId === 'funds') addChains(run, records, mode, weights, eligibleSeller);
  for (const r of records) {
    r.outScore = r.deltaEv + r.fundsTerm + r.deadSlotTerm - r.priceTerm - cost;
  }

  // Best first; ties to the larger squad gain, then the lower ids.
  records.sort((a, b) => (b.outScore - a.outScore) || (b.deltaEv - a.deltaEv)
    || (a.pair.p.playerId - b.pair.p.playerId) || (a.pair.q.id - b.pair.q.id));

  const bestByOwner = new Map();
  for (const r of records) {
    if (!bestByOwner.has(r.pair.p.playerId)) bestByOwner.set(r.pair.p.playerId, buildMove(run, modeId, weights, r));
  }

  // A move is made only when it beats rolling (Q7); Long term also keeps the
  // brief's own gate: the squad gain alone must beat the transfer's cost.
  // Money and price break ties but never make a move alone (brief §7 Phase 5):
  // with no squad gain and no second move to pay for, only Funds moves, and
  // only for minFreedTenths or more - at five banked FTs a move costs nothing,
  // so £0.1m would otherwise be enough.
  const forMoneyAlone = r => r.deltaEv + r.deadSlotTerm <= 0 && !r.chained
    && (modeId !== 'funds' || r.pair.moneyFreed < mode.minFreedTenths);
  const admissible = records.filter(r => eligibleSeller(r.pair.p.playerId)
    && r.outScore > mode.threshold
    && (modeId !== 'longterm' || r.deltaEv > cost)
    && !forMoneyAlone(r));
  const [rootRecord, ...rest] = admissible;
  const root = rootRecord ? bestOrBuild(run, modeId, weights, rootRecord, bestByOwner) : null;
  const alternatives = rootRecord
    ? rest.filter(r => r.outScore >= rootRecord.outScore - config.alternativesWindow)
      .slice(0, config.alternativesMax)
      .map(r => bestOrBuild(run, modeId, weights, r, bestByOwner))
    : [];

  const deferral = modeId === 'future' && rootRecord ? deferralOf(run, mode, weights, raw, rootRecord) : null;
  const summary = {
    modeId,
    label: mode.label,
    weights,
    call: deferral ? 'wait' : root ? 'move' : 'roll',
    root,
    rollValue: cost,
    alternatives,
    waitForNews: modeId === 'now' && root !== null && waitsForNews(run, root),
    deferral,
    robustness: null,
  };
  if (modeId === 'ceiling') summary.targetGw = ceiling.targetGw;
  const top = records.slice(0, config.robustnessShortlist)
    .flatMap(r => (r.chained ? [r.pair.q.id, r.chained.inId] : [r.pair.q.id]));
  return { summary, bestByOwner, top };
}

/**
 * Future prep's deferral test (brief §6, mode 3): the same move made a week
 * later, scored over the same five GWs with the planning GW given up (your
 * reading, after Phase 5's review), against q's price then. Its free transfer
 * costs what it costs now: either way the two weeks make one transfer and bank
 * the same free transfers - except with none banked, where waiting turns this
 * week's hit into next week's free transfer. Within deferralEpsilon of making
 * it now, the mode waits. It never waits when no later GW counts (the season's
 * end, a Wildcard), when a likely price move would put the buy out of reach by
 * then, or with free transfers at the cap, where waiting would roll one away
 * (brief §10).
 *
 * @param {number[]} weights  the mode's weights, planned chips masked
 * @param {number[]} raw      the same, unmasked
 * @returns {{gw: number, laterScore: number, epsilon: number}|null}  gw: the
 *   first GW the later move counts for; null: make it now
 */
function deferralOf(run, mode, weights, raw, record) {
  const { config, input } = run;
  if (input.freeTransfers >= config.maxBankedFt) return null;
  const later = weights.map((w, k) => (k === 0 ? 0 : w));
  if (later.every(w => w === 0)) return null;
  const { p, q, dV } = record.pair;
  const total = sum(raw);
  const share = total > 0 ? sum(later) / total : 0;
  const deltaEv = dot(later, dV);

  // p sells at today's price: the fall that waiting risks is already in
  // today's PriceTerm, so it is not counted twice.
  const qPrice = toTenths(q.price);
  const qSignal = input.priceSignals?.[q.id];
  const qChange = chanceOf(qSignal, 'rise') - chanceOf(qSignal, 'fall');
  const lambda = mode.lambda ?? config.lambdaDefault;
  const laterScore = deltaEv + (lambda * fromTenths(p.sellPriceTenths - qPrice - qChange) * share)
    - transferCost(Math.max(input.freeTransfers, 1), config);

  const outlook = run.outlook.get(p.playerId);
  const reach = run.state.bankTenths + p.sellPriceTenths + (outlook.fallLikely ? outlook.down : 0);
  const outOfReach = qPrice + (run.riseLikely(q.id) ? 1 : 0) > reach;
  if (outOfReach || laterScore < record.outScore - mode.deferralEpsilon) return null;
  return { gw: run.modeGws[later.findIndex(w => w > 0)], laterScore, epsilon: mode.deferralEpsilon };
}

/**
 * Now's "wait for team news" (brief §6, mode 1): a flagged player is in its
 * move, the press conferences are still to come (more than
 * waitForNewsMinHours to the deadline), and waiting costs nothing in price - no
 * likely fall in the seller's sell price, no likely rise in the buy's price.
 */
function waitsForNews(run, move) {
  const hours = run.input.hoursToDeadline;
  return move.tags.includes('pendingNews')
    && Number.isFinite(hours) && hours > run.config.waitForNewsMinHours
    && !run.outlook.get(move.outId).fallLikely
    && !run.riseLikely(move.inId);
}

/** Reuse the per-owner Move object when the record is that owner's best. */
function bestOrBuild(run, modeId, weights, record, bestByOwner) {
  const best = bestByOwner.get(record.pair.p.playerId);
  return best && best.inId === record.pair.q.id ? best : buildMove(run, modeId, weights, record);
}

// ─── Mode 4: the second move a downgrade pays for ────────────────────────────

/**
 * For the chainTopK most efficient downgrades p -> q, the best second move
 * r -> s that only the freed money makes affordable: s same position as r, too
 * dear for the bank plus r's sell price alone, within reach once the
 * downgrade's money is added, and the club limit kept across both moves. It is
 * scored jointly, V(S - p + q - r + s) - V(S - p + q), with Funds' decaying
 * weights, as a second transfer this GW at the cost of the next free transfer
 * (or a hit).
 * MODEL: the downgrade's funds credit is the better of that net gain and
 * lambda per £1.0m freed (Q10's reading of the brief's "derived" lambda).
 */
function addChains(run, records, mode, weights, eligibleSeller) {
  const ftLeft = run.input.freeTransfers - 1;
  const secondCost = transferCost(ftLeft, run.config);
  const top = records.filter(r => eligibleSeller(r.pair.p.playerId))
    .sort((a, b) => (b.efficiency - a.efficiency) || (a.pair.p.playerId - b.pair.p.playerId)
      || (a.pair.q.id - b.pair.q.id))
    .slice(0, mode.chainTopK);

  for (const record of top) {
    const { p, q, moneyFreed } = record.pair;
    const firstIds = swapIn(run.ids, p.playerId, q.id);
    const firstKey = `${p.playerId}>${q.id}`;
    const firstValues = run.modeGws.map((gw, k) => (weights[k] === 0 ? 0 : run.value(gw, firstIds, firstKey)));
    const qPrice = toTenths(q.price);
    const state = {
      bankTenths: run.state.bankTenths + moneyFreed,
      players: run.state.players.map(x => (x.playerId === p.playerId
        ? { playerId: q.id, position: q.position, teamId: q.teamId, priceTenths: qPrice, sellPriceTenths: qPrice }
        : x)),
    };

    let best = null;
    for (const r of state.players) {
      if (r.playerId === q.id || !eligibleSeller(r.playerId)) continue;
      const reachBefore = run.state.bankTenths + r.sellPriceTenths;
      for (const s of run.candidatesByPosition[r.position]) {
        if (s.id === p.playerId || s.id === q.id || run.bans.has(s.id)) continue;
        if (toTenths(s.price) <= reachBefore) continue;          // affordable anyway
        if (!checkSwap(state, r.playerId, s).ok) continue;
        const ids = swapIn(firstIds, r.playerId, s.id);
        const chainKey = `${firstKey}+${r.playerId}>${s.id}`;
        const dV = run.modeGws.map((gw, k) => (weights[k] === 0 ? 0
          : run.value(gw, ids, chainKey) - firstValues[k]));
        const perGw = weights.map((w, k) => w * dV[k]);
        const gain = sum(perGw);
        const net = gain - secondCost;
        if (!best || net > best.net) best = { r, s, perGw, gain, net };
      }
    }

    const plain = record.fundsTerm;
    if (best && best.net > plain) {
      record.fundsTerm = best.net;
      const rOwned = run.owned.find(o => o.playerId === best.r.playerId);
      record.chained = buildMove(run, 'funds', weights, {
        pair: { p: rOwned, q: best.s, moneyFreed: best.r.sellPriceTenths - toTenths(best.s.price) },
        perGw: best.perGw, deltaEv: best.gain, fundsTerm: 0, priceTerm: 0, deadSlotTerm: 0,
        efficiency: null, chained: null, outScore: best.net,
      }, ftLeft);
    }
  }
}

// ─── Moves ───────────────────────────────────────────────────────────────────

function buildMove(run, modeId, weights, record, freeTransfers = run.input.freeTransfers) {
  const { p, q } = record.pair;
  const { config } = run;
  const cost = transferCost(freeTransfers, config);
  const first = run.modeGws[0];
  const pGw = run.gwOf(p.playerId, first);
  const qGw = run.gwOf(q.id, first);
  const tags = [];
  if (modeId === 'now' && pGw.fixtures === 0) tags.push('blankGwOneWeek');
  if (p.sellPriceEstimated) tags.push('sellPriceEstimated');
  if (pendingNews(pGw) || pendingNews(qGw)) tags.push('pendingNews');

  return {
    mode: modeId,
    outId: p.playerId,
    inId: q.id,
    deltaEv: record.deltaEv,
    perGw: record.perGw,
    fundsTerm: record.fundsTerm,
    priceTerm: record.priceTerm,
    transferCost: cost,
    deadSlotTerm: record.deadSlotTerm,
    outScore: record.outScore,
    efficiency: record.efficiency,
    tentativeFromGw: first + 1,
    minutesRisk: { out: minutesRisk(config, pGw), in: minutesRisk(config, qGw) },
    chained: record.chained,
    tags,
    why: explain(run, weights, record, freeTransfers, tags),
  };
}

/** 'blank' with no fixture (his pZero of 1 is no minutes risk), else by pZero. */
function minutesRisk(config, gw) {
  const bands = config.minutesRiskPZero;
  if (gw.fixtures === 0) return 'blank';
  if (gw.pZero >= bands.high) return 'high';
  return gw.pZero >= bands.medium ? 'medium' : 'low';
}

/** MODEL: flagged doubtful now - press conferences may still change the picture. */
function pendingNews(gw) {
  return gw.availability > 0 && gw.availability < 1;
}

// ─── Plain English ───────────────────────────────────────────────────────────

const points = x => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}`;
const money = tenths => `£${fromTenths(Math.abs(tenths)).toFixed(1)}m`;

function explain(run, weights, record, freeTransfers, tags) {
  const { p, q, moneyFreed } = record.pair;
  const name = id => run.names.get(id) ?? String(id);
  const counted = run.modeGws.filter((_, k) => weights[k] > 0);
  const span = counted.at(-1) - counted[0] === counted.length - 1
    ? (counted.length === 1 ? `GW${counted[0]}` : `GW${counted[0]}–${counted.at(-1)}`)
    : `${counted.slice(0, -1).map(gw => `GW${gw}`).join(', ')} and GW${counted.at(-1)}`;

  let squad = `${name(p.playerId)} out, ${name(q.id)} in: ${points(record.deltaEv)} weighted points for the squad over ${span}.`;
  if (tags.includes('blankGwOneWeek')) {
    squad += ` ${name(p.playerId)} has no fixture in GW${run.modeGws[0]}: a one-week view.`;
  }

  let funds = null;
  if (record.chained) {
    const c = record.chained;
    funds = `Frees ${money(moneyFreed)}, which pays for ${name(c.outId)} out, ${name(c.inId)} in as a second `
      + `transfer: ${points(c.outScore)} points after its cost.`;
  } else if (record.fundsTerm !== 0) {
    funds = `${moneyFreed > 0 ? 'Frees' : 'Spends'} ${money(moneyFreed)}: ${points(record.fundsTerm)} points.`;
  }

  const { config } = run;
  let costText;
  if (freeTransfers <= 0) {
    costText = `A ${config.hitCost}-point hit, which must also clear a ${config.hitMargin}-point margin.`;
  } else if (freeTransfers >= config.maxBankedFt) {
    costText = `Free: with ${config.maxBankedFt} banked, rolling would waste a free transfer.`;
  } else {
    costText = `Uses a free transfer worth ${transferCost(freeTransfers, config).toFixed(1)} points if rolled.`;
  }

  return { squad, funds, price: priceText(run, p, q), cost: costText };
}

/** The price moves likely before the next chance to act, as they bear on this move; null with none. */
function priceText(run, p, q) {
  const name = id => run.names.get(id) ?? String(id);
  const outlook = run.outlook.get(p.playerId);
  const lines = [];   // [sentence, the player whose signal gives it]
  if (outlook.fallLikely) {
    lines.push([`${name(p.playerId)}'s price is likely to fall soon, taking ${money(-outlook.down)} off his sell price: selling now avoids it.`, p.playerId]);
  }
  if (outlook.riseLikely) {
    lines.push([`${name(p.playerId)}'s price is likely to rise soon, adding ${money(outlook.up)} to his sell price if kept.`, p.playerId]);
  }
  if (run.riseLikely(q.id)) lines.push([`${name(q.id)}'s price is likely to rise soon: buying now costs £0.1m less.`, q.id]);
  if (lines.length === 0) return null;
  const estimated = lines.some(([, id]) => run.input.priceSignals?.[id]?.source === 'estimate');
  return lines.map(([text]) => text).join(' ') + (estimated ? ' (Estimated from this week’s transfers.)' : '');
}

// ─── Players, lineup, chip hints ─────────────────────────────────────────────

function flagsFor(run, p, { rootSells, ceiling, structure }) {
  const flags = [];
  if (rootSells.has(p.playerId)) flags.push('sell');
  if (structure.holds.has(p.playerId)) flags.push('hold');
  if (ceiling.protectedIds.has(p.playerId)) flags.push('protected');
  if (run.locks.has(p.playerId)) flags.push('locked');
  if (pendingNews(run.gwOf(p.playerId, run.modeGws[0]))) flags.push('pendingNews');
  if (p.sellPriceEstimated) flags.push('sellPriceEstimated');
  if (run.outlook.get(p.playerId).fallLikely) flags.push('priceFall');
  if (run.outlook.get(p.playerId).riseLikely) flags.push('priceRise');
  return flags;
}

/** The XI, bench and armband for the planning GW, as the Captain and XI panel shows them. */
function lineupOf(run) {
  const gw = run.modeGws[0];
  const v = squadValue(run.ids, gw, run.overlay, run.valueOpts(gw));
  return { xi: v.xi, bench: v.bench, captainId: v.captainId, viceId: v.viceId,
    captainGap: v.captainGap, nextCaptainId: v.nextCaptainId };
}

/**
 * Bench Boost and Triple Captain pre-fills for the chip plan (Q4): the GW of
 * the projection horizon where the chip adds most to the squad as it stands -
 * Bench Boost's increment over the autosubs already credited, Triple Captain's
 * extra captain bonus. Only GWs in a half whose chip is unused, with no other
 * chip planned, and before any planned Wildcard (after it the squad is
 * another one). Never applied unless accepted.
 */
function chipHints(run) {
  const { input, config, ids, overlay } = run;
  const used = input.chipsUsed ?? [];
  const firstHalf = gw => gw <= CHIP_RESET_AFTER_GW;
  const gws = Array.from({ length: config.horizonGws }, (_, k) => input.planningGw + k)
    .filter(gw => gw <= SEASON_GWS);
  const opts = { autosubMode: config.autosubMode, benchWeightsLinear: config.benchWeightsLinear };

  const hint = (chip, gainAt, describe) => {
    let best = null;
    for (const gw of gws) {
      if (used.some(u => u.chip === chip && firstHalf(u.gw) === firstHalf(gw))) continue;
      if (run.chipPlan[gw] && run.chipPlan[gw] !== chip) continue;
      if (Object.entries(run.chipPlan).some(([w, c]) => c === 'wildcard' && Number(w) <= gw)) continue;
      const gain = gainAt(gw);
      if (gain > 0 && (!best || gain > best.gain)) best = { gw, gain };
    }
    return best ? { ...best, reasoning: describe(best) } : null;
  };

  return {
    benchboost: hint('benchboost',
      gw => squadValue(ids, gw, overlay, { ...opts, chip: 'benchboost' }).components.benchBoost,
      ({ gw, gain }) => `${CHIP_LABELS.benchboost} in GW${gw}: the bench adds ${gain.toFixed(1)} points `
        + 'beyond what autosubs would bring in anyway.'),
    triplecaptain: hint('triplecaptain',
      gw => squadValue(ids, gw, overlay, { ...opts, chip: 'triplecaptain' }).value
        - squadValue(ids, gw, overlay, opts).value,
      ({ gw, gain }) => {
        const captainId = squadValue(ids, gw, overlay, opts).captainId;
        return `${CHIP_LABELS.triplecaptain} in GW${gw}: ${run.names.get(captainId) ?? captainId} as captain `
          + `is worth ${gain.toFixed(1)} more points.`;
      }),
  };
}
