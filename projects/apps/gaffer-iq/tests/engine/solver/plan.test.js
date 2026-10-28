/**
 * tests/engine/solver/plan.test.js
 * A solved plan as the card shows it (js/engine/solver/plan.js; docs/decision-engine-solver-plan.md §3): the first
 * week's sales and buys as moves FPL takes one at a time, the check that no protected player was sold, the move set's
 * key, the call, the engine's explanation of an arbitrary move set (describePlan), the card with its keyed figures,
 * the gain over rolling and the alternatives. The engine inputs are the decision tests' hand-built ones; the solved
 * tests run on the vendored HiGHS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDecisionCache, describePlan, runDecisionEngine, transferCost } from '../../../js/engine/decision.js';
import { solveProblem } from '../../../js/engine/solver/highs.js';
import {
  alternativesOf, callOf, checkProtected, gainOverRolling, moveSetKey, orderMoves, pairMoves, rollingProblem, solverCard,
  withFigure,
} from '../../../js/engine/solver/plan.js';
import { modeSetting, solverProblem } from '../../../js/engine/solver/problem.js';
import { squadValue } from '../../../js/engine/squad-value.js';
import { GW, MODES, close, scenario } from '../decision-fixtures.js';
import { CONFIG, loadVendored } from './fixtures.js';

const highs = await loadVendored();
const EXACT = { time_limit: CONFIG.solver.timeLimitS, mip_abs_gap: 0, mip_rel_gap: 0 };
const solve = problem => solveProblem(highs, problem, EXACT).plan;
const sum = xs => xs.reduce((a, x) => a + x, 0);

/** The engine's run on an input, kept with the cache it ran on. */
function engineOf(input) {
  const cache = createDecisionCache();
  return { input, cache, result: runDecisionEngine(input, CONFIG, cache) };
}
const positionsOf = input => new Map([...input.squad, ...input.candidates].map(p => [p.playerId ?? p.id, p.position]));

// ─── The first week as moves FPL takes one at a time ─────────────────────────

test('orderMoves keeps the bank and the clubs legal after every move', () => {
  // Selling 8 (£5.0m) for 101 (£6.0m) needs the money that selling 9 for 102 (£4.0m) frees: that one first.
  const { input, result } = engineOf(scenario({ candidates: [
    { id: 101, position: 'MID', price: 60, xip: 3 }, { id: 102, position: 'MID', price: 40, xip: 3 },
    { id: 103, position: 'FWD', xip: 3 }] }));
  const { moves, unordered } = orderMoves(input, result, { in: [101, 102, 103], out: [8, 9, 13] });
  assert.equal(unordered, false);
  assert.equal(moves.length, 3);
  const position = positionsOf(input);
  assert.ok(moves.every(m => position.get(m.outId) === position.get(m.inId)), 'each sale is paired with a buy of his position');
  assert.ok(moves.findIndex(m => m.inId === 102) < moves.findIndex(m => m.inId === 101));
  // Greedy: the pair that frees most first (8 or 9 for 102 frees £1.0m, 8 first), then 13 for 103 (nothing), then 9 for 101.
  assert.deepEqual(moves, [{ outId: 8, inId: 102 }, { outId: 13, inId: 103 }, { outId: 9, inId: 101 }]);
  assert.deepEqual(orderMoves(input, result, { in: [], out: [] }), { moves: [], unordered: false });

  // Three of the squad's midfielders share club 50: a forward from it waits for one of them to go.
  const crowded = engineOf(scenario({ changes: [8, 9, 10].map(id => ({ id, team: 50 })), candidates: [
    { id: 102, position: 'FWD', team: 50, xip: 3 }, { id: 103, position: 'MID', xip: 3 }] }));
  assert.deepEqual(orderMoves(crowded.input, crowded.result, { in: [102, 103], out: [13, 9] }),
    { moves: [{ outId: 9, inId: 103 }, { outId: 13, inId: 102 }], unordered: false });
});

test('orderMoves values a sale at his sell price, not his price', () => {
  // 8 was bought at £5.0m and is now £5.4m: he sells for £5.2m. 101 at £5.3m is out of reach (his price would reach it).
  const { input, result } = engineOf(scenario({ changes: [{ id: 8, price: 54, purchase: 50 }], candidates: [
    { id: 101, position: 'MID', price: 53, xip: 3 }, { id: 102, position: 'MID', price: 52, xip: 3 }] }));
  assert.deepEqual(orderMoves(input, result, { in: [101], out: [8] }), { moves: [], unordered: true });
  assert.deepEqual(orderMoves(input, result, { in: [102], out: [8] }), { moves: [{ outId: 8, inId: 102 }], unordered: false });

  // Selling 8 for a £4.0m 102 leaves £1.2m, not £1.4m: with 9's £5.0m that reaches £6.2m, not a £6.3m 103.
  const next = engineOf(scenario({ changes: [{ id: 8, price: 54, purchase: 50 }], candidates: [
    { id: 102, position: 'MID', price: 40, xip: 3 }, { id: 103, position: 'MID', price: 63, xip: 3 }] }));
  assert.deepEqual(orderMoves(next.input, next.result, { in: [102, 103], out: [8, 9] }),
    { moves: [{ outId: 8, inId: 102 }], unordered: true });
});

test('moves left without a legal order are left out, the legal ones made, and the week is called unordered', () => {
  // 101 costs £7.0m; no sale frees enough.
  const { input, result } = engineOf(scenario({ candidates: [
    { id: 101, position: 'MID', price: 70, xip: 3 }, { id: 102, position: 'FWD', xip: 3 }] }));
  assert.deepEqual(orderMoves(input, result, { in: [101, 102], out: [8, 13] }),
    { moves: [{ outId: 13, inId: 102 }], unordered: true });
});

test('pairMoves pairs each sale with the lowest buy of his position, for the weeks that are not ordered', () => {
  const position = new Map([[8, 'MID'], [9, 'MID'], [13, 'FWD'], [102, 'MID'], [103, 'MID'], [105, 'FWD']]);
  assert.deepEqual(pairMoves({ in: [103, 105, 102], out: [13, 9, 8] }, id => position.get(id)),
    [{ outId: 8, inId: 102 }, { outId: 9, inId: 103 }, { outId: 13, inId: 105 }]);
  assert.throws(() => pairMoves({ in: [102], out: [13] }, id => position.get(id)), /no buy/);
});

// ─── Protected players ───────────────────────────────────────────────────────

test('a protected sale in Now throws; the same sale in Ceiling does not; a locked sale throws in every mode', () => {
  const result = { players: [
    { playerId: 8, flags: ['protected'] }, { playerId: 9, flags: ['locked'] }, { playerId: 10, flags: ['hold'] },
    { playerId: 11, flags: ['sell', 'priceFall'] }] };
  const sells = id => ({ in: [101], out: [id] });
  for (const modeId of ['now', 'longterm', 'future', 'funds']) {
    assert.throws(() => checkProtected(modeId, sells(8), result), new RegExp(`^Error: solver: ${modeId} sold protected player 8 in its first week$`),
      modeId);
  }
  for (const modeId of ['ceiling', 'structure']) checkProtected(modeId, sells(8), result);

  for (const modeId of MODES) {
    assert.throws(() => checkProtected(modeId, sells(9), result), /solver: \w+ sold protected player 9 in its first week/, modeId);
  }
  // Structure's holds are its own; the other modes may sell them.
  assert.throws(() => checkProtected('structure', sells(10), result), /sold protected player 10/);
  for (const modeId of MODES.filter(m => m !== 'structure')) checkProtected(modeId, sells(10), result);
  // An ordinary sale, a plan that only buys, and a sale among others all pass.
  for (const modeId of MODES) {
    checkProtected(modeId, sells(11), result);
    checkProtected(modeId, { in: [], out: [] }, result);
  }
  assert.throws(() => checkProtected('now', { in: [101, 102], out: [11, 8] }, result), /player 8/);
});

test('a wait\'s own move week is checked as a first week is, and the error says which week', () => {
  const { result } = engineOf(scenario({ locks: new Set([15]), candidates: [{ id: 101, position: 'FWD', xip: 9 }] }));
  const wait = { objective: 5, weeks: [{ gw: 10, in: [], out: [], hits: 0, ft: 1 }, { gw: 11, in: [101], out: [15], hits: 0, ft: 2 }] };
  assert.equal(callOf(wait), 'wait');
  // Week 0 sells nothing, so only the week the wait is made in finds the locked player.
  for (const modeId of MODES) {
    checkProtected(modeId, wait.weeks[0], result);
    assert.throws(() => checkProtected(modeId, wait.weeks[1], result, 'the week it waits for'),
      new RegExp(`^Error: solver: ${modeId} sold protected player 15 in the week it waits for$`), modeId);
    assert.throws(() => checkProtected(modeId, wait.weeks[1], result), /player 15 in its first week/, 'the week is its first by default');
  }
});

test('the flags checkProtected reads are the engine\'s: a lock the engine saw is a locked sale', () => {
  const { result } = engineOf(scenario({ locks: new Set([4]), candidates: [{ id: 101, position: 'DEF', xip: 9 }] }));
  for (const modeId of MODES) assert.throws(() => checkProtected(modeId, { in: [101], out: [4] }, result), /player 4/, modeId);
  for (const modeId of MODES) checkProtected(modeId, { in: [101], out: [5] }, result);
});

// ─── The move set's key and the call ─────────────────────────────────────────

test('moveSetKey is order-free and keys the sales and buys, not how they are paired', () => {
  const a = { outId: 9, inId: 103 };
  const b = { outId: 13, inId: 102 };
  assert.equal(moveSetKey([a, b]), '9,13>102,103');
  assert.equal(moveSetKey([b, a]), moveSetKey([a, b]));
  assert.equal(moveSetKey([a]), '9>103', 'one move stays out>in, the key the engine caches its swap under');
  assert.equal(moveSetKey([]), '', 'rolling has no moves');
  // The same two sales and buys paired the other way are the same squad change, so the same key.
  assert.equal(moveSetKey([{ outId: 9, inId: 102 }, { outId: 13, inId: 103 }]), moveSetKey([a, b]));
  assert.notEqual(moveSetKey([a, b]), moveSetKey([a, { outId: 13, inId: 104 }]));
  assert.notEqual(moveSetKey([a, b]), moveSetKey([{ outId: 9, inId: 103 }, { outId: 14, inId: 102 }]));
  // Ids sort as numbers: 9 before 13.
  assert.equal(moveSetKey([{ outId: 13, inId: 20 }, { outId: 9, inId: 3 }]), '9,13>3,20');
});

test('callOf: move, wait, roll', () => {
  const week = (inIds, outIds) => ({ in: inIds, out: outIds });
  assert.equal(callOf({ weeks: [week([101], [15]), week([], [])] }), 'move');
  assert.equal(callOf({ weeks: [week([101], [15]), week([102], [14])] }), 'move', 'a move now, whatever follows');
  assert.equal(callOf({ weeks: [week([], []), week([101], [15])] }), 'wait');
  assert.equal(callOf({ weeks: [week([], []), week([], []), week([101], [15])] }), 'roll', 'two weeks out is still a roll');
  assert.equal(callOf({ weeks: [week([], [])] }), 'roll', 'a one-week plan has no next week');
});

// ─── The engine's explanation of a move set ──────────────────────────────────

test('describePlan of one move equals the engine\'s own root for that move', () => {
  const candidates = [{ id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'GKP', xip: 8 }];
  const variants = {
    'one free transfer': {},
    'no free transfer': { freeTransfers: 0 },
    'three free transfers': { freeTransfers: 3 },
    'a Free Hit in GW11': { chipPlan: { [GW + 1]: 'freehit' } },
    'a blank for the seller': { changes: [{ id: 15, fx: [0, 1, 1, 1, 1, 1] }] },
  };
  let compared = 0;
  for (const [name, over] of Object.entries(variants)) {
    const { input, cache, result } = engineOf(scenario({ candidates, ...over }));
    for (const modeId of MODES) {
      const { root, bigWeek, waitForNews } = result.modes[modeId];
      if (!root || bigWeek) continue;
      const size = cache.values.size;
      const d = describePlan(input, CONFIG, cache, modeId, [{ outId: root.outId, inId: root.inId }]);
      const at = `${modeId} with ${name}`;
      assert.deepEqual(d.perGw, root.perGw, at);
      assert.equal(d.deltaEv, root.deltaEv, at);
      assert.deepEqual(d.overFiveGws, root.overFiveGws, at);
      assert.deepEqual(d.moves, [{ outId: root.outId, inId: root.inId, minutesRisk: root.minutesRisk, tags: root.tags }], at);
      assert.equal(d.why.squad, root.why.squad, `${at}: the engine's own words for the squad`);
      assert.equal(d.waitForNews, waitForNews, at);
      assert.equal(cache.values.size, size, `${at}: a single move is keyed as the engine keys its swap, so no V is recomputed`);
      compared += 1;
    }
  }
  assert.ok(compared >= 15, `compared ${compared} roots`);
  // The Free Hit week is no part of the span the words name, nor of the blank's one-week view.
  const freeHit = engineOf(scenario({ candidates, chipPlan: { [GW + 1]: 'freehit' } }));
  assert.match(describePlan(freeHit.input, CONFIG, freeHit.cache, 'longterm', [{ outId: 15, inId: 101 }]).why.squad, /over GW10 and GW12\.$/);
  const blank = engineOf(scenario({ candidates, changes: [{ id: 15, fx: [0, 1, 1, 1, 1, 1] }] }));
  const blanked = describePlan(blank.input, CONFIG, blank.cache, 'now', [{ outId: 15, inId: 101 }]);
  assert.deepEqual(blanked.moves[0].tags, ['blankGwOneWeek']);
  assert.match(blanked.why.squad, /P15 has no fixture in GW10: a one-week view\.$/);
});

test('describePlan of one move reads the engine\'s weights for Ceiling too (its target week, not the five)', () => {
  const { input, cache, result } = engineOf(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] }));
  const { root, bigWeek, weights } = result.modes.ceiling;
  assert.ok(root && !bigWeek, 'Ceiling reads expected points on this input');
  assert.notDeepEqual(weights, result.modes.now.weights);
  const d = describePlan(input, CONFIG, cache, 'ceiling', [{ outId: root.outId, inId: root.inId }]);
  assert.deepEqual(d.perGw, root.perGw);
});

test('describePlan of several moves is the squad after all of them, and its words say what they use', () => {
  const candidates = [{ id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'GKP', xip: 8 }];
  const moves = [{ outId: 15, inId: 101 }, { outId: 2, inId: 102 }];
  const after = ids => ids.map(id => ({ 15: 101, 2: 102 })[id] ?? id);
  const text = (freeTransfers, modeId = 'longterm') => {
    const { input, cache } = engineOf(scenario({ freeTransfers, candidates }));
    return describePlan(input, CONFIG, cache, modeId, moves);
  };

  const { input, cache, result } = engineOf(scenario({ freeTransfers: 2, candidates }));
  const before = input.squad.map(s => s.playerId);
  const opts = { autosubMode: CONFIG.autosubMode, benchWeightsLinear: CONFIG.benchWeightsLinear };
  const dV = k => squadValue(after(before), GW + k, input.projections, opts).value - squadValue(before, GW + k, input.projections, opts).value;
  const weights = result.modes.longterm.weights;
  const d = describePlan(input, CONFIG, cache, 'longterm', moves);
  d.perGw.forEach((v, k) => close(v, weights[k] * dV(k), `GW${GW + k}`));
  close(d.deltaEv, sum(d.perGw));
  assert.ok(d.deltaEv > 0);
  assert.deepEqual(d.moves.map(m => [m.outId, m.inId]), [[15, 101], [2, 102]]);
  assert.equal(d.key, moveSetKey(moves), 'it says which move set it explains');
  assert.equal(describePlan(input, CONFIG, cache, 'longterm', [...moves].reverse()).key, d.key);
  assert.match(d.why.squad, /^P15, P2 out, P101, P102 in: \+\d+\.\d weighted points for the squad over GW10–12\.$/);

  // Now's five GWs at full weight, less both transfers' cost: the second is paid for with what the first leaves.
  const now = describePlan(input, CONFIG, cache, 'now', moves);
  close(now.overFiveGws.points, sum([0, 1, 2, 3, 4].map(dV)) - (transferCost(2) + transferCost(1)));
  assert.deepEqual(now.overFiveGws.gws, [10, 11, 12, 13, 14]);

  // Free transfers by FPL's rule: what is free is used, the rest is a hit.
  assert.deepEqual([d.hits, d.why.cost], [0, 'Uses 2 free transfers.']);
  const one = text(1);
  assert.deepEqual([one.hits, one.why.cost], [4, 'Uses 1 free transfer and takes one 4-point hit.']);
  const none = text(0);
  assert.deepEqual([none.hits, none.why.cost], [8, 'Takes two 4-point hits.']);
  assert.equal(text(5).why.cost, 'Uses 2 free transfers.');
  const { input: single, cache: singleCache } = engineOf(scenario({ freeTransfers: 0, candidates }));
  const hit = describePlan(single, CONFIG, singleCache, 'longterm', [moves[0]]);
  assert.deepEqual([hit.hits, hit.why.cost], [4, 'Takes one 4-point hit.']);
});

test('describePlan of no moves is the squad as it is: nothing gained, nothing said', () => {
  const { input, cache } = engineOf(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }] }));
  const d = describePlan(input, CONFIG, cache, 'longterm', []);
  assert.deepEqual(d.perGw, [0, 0, 0, 0, 0]);
  assert.deepEqual([d.deltaEv, d.hits, d.waitForNews, d.moves, d.why, d.key], [0, 0, false, [], { squad: null, cost: null }, '']);
  assert.equal(d.overFiveGws.points, 0);
  assert.throws(() => describePlan(input, CONFIG, cache, 'longterm', [{ outId: 101, inId: 15 }]), /not in the squad/);
});

test('describePlan carries Now\'s wait-for-team-news flag when any move of the set has the news pending', () => {
  // DEF 5 is 50% now; DEF 116 is a better buy either way.
  const base = { changes: [{ id: 5, pz: 0.5, av: 0.5 }], candidates: [
    { id: 116, position: 'DEF', xip: 9 }, { id: 101, position: 'FWD', xip: 12 }] };
  const wait = (modeId, over, moves) => {
    const { input, cache } = engineOf(scenario({ ...base, ...over }));
    return describePlan(input, CONFIG, cache, modeId, moves);
  };
  const pending = [{ outId: 5, inId: 116 }];
  const early = wait('now', { hoursToDeadline: 48 }, pending);
  assert.equal(early.waitForNews, true);
  assert.ok(early.moves[0].tags.includes('pendingNews'));
  assert.equal(wait('now', { hoursToDeadline: 48 }, [{ outId: 15, inId: 101 }, ...pending]).waitForNews, true, 'the second move is the flagged one');
  assert.equal(wait('now', { hoursToDeadline: 48 }, [{ outId: 15, inId: 101 }]).waitForNews, false, 'no flagged player in it');
  assert.equal(wait('now', { hoursToDeadline: 12 }, pending).waitForNews, false, 'the press conferences are done');
  assert.equal(wait('longterm', { hoursToDeadline: 48 }, pending).waitForNews, false, 'only Now waits for news');
});

// ─── The card ────────────────────────────────────────────────────────────────

/** Long term's plan on an input where it sells 15 for 101 in the first week, and what a card is made from. */
function cardParts(others = []) {
  const { input, cache, result } = engineOf(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 12 }, ...others] }));
  const problem = solverProblem(input, result, modeSetting(input, result, 'longterm', CONFIG), CONFIG);
  const plan = solve(problem);
  return { input, cache, result, problem, plan };
}
const cardOf = ({ input, cache, result, plan }, over = {}) => {
  const moves = over.moves ?? orderMoves(input, result, plan.weeks[0]).moves;
  const parts = { plan, moves, describe: describePlan(input, CONFIG, cache, 'longterm', moves), inputVersion: 7,
    positionOf: id => positionsOf(input).get(id), ...over };
  return solverCard(result.modes.longterm, parts);
};

test('the card is the engine\'s mode with the solver\'s moves, and its figures start null and carry the card\'s key', () => {
  const parts = cardParts();
  assert.deepEqual([parts.plan.weeks[0].out, parts.plan.weeks[0].in], [[15], [101]]);
  const card = cardOf(parts);
  const engine = parts.result.modes.longterm;
  assert.equal(card.modeId, 'longterm');
  assert.equal(card.label, engine.label);
  assert.deepEqual(card.weights, engine.weights);
  assert.deepEqual([card.source, card.call, card.key], ['solver', 'move', '15>101|7']);
  assert.deepEqual([card.gain, card.alternatives, card.robustness], [null, null, null]);

  assert.deepEqual(card.moves, [{ outId: 15, inId: 101, minutesRisk: { out: 'low', in: 'low' }, tags: [] }]);
  const d = describePlan(parts.input, CONFIG, parts.cache, 'longterm', [{ outId: 15, inId: 101 }]);
  assert.deepEqual(card.root, { ...card.moves[0], perGw: d.perGw, deltaEv: d.deltaEv, why: d.why, overFiveGws: d.overFiveGws, tentativeFromGw: GW + 1 });
  assert.deepEqual([card.hits, card.later, card.deferral, card.waitForNews], [0, [], null, false]);

  // A figure lands only on the card it was computed for: this move set and this input.
  const gained = withFigure(card, 'gain', card.key, 2.5);
  assert.deepEqual(gained.gain, { key: card.key, value: 2.5 });
  assert.deepEqual([gained.alternatives, gained.robustness], [null, null]);
  assert.equal(card.gain, null, 'the card it landed on is left as it was');
  for (const stale of ['15>101|6', '14>101|7', '|7']) assert.equal(withFigure(card, 'gain', stale, 9), card, stale);
  assert.deepEqual(withFigure(gained, 'robustness', card.key, 0.8).robustness, { key: card.key, value: 0.8 });
  assert.throws(() => withFigure(card, 'root', card.key, null), /figure/);
});

test('a card\'s key follows its moves, in any order, and the input\'s version', () => {
  const parts = cardParts();
  const two = [{ outId: 15, inId: 101 }, { outId: 2, inId: 102 }];
  const keyOf = (moves, inputVersion) => {
    const describe = { perGw: [], deltaEv: 0, why: {}, overFiveGws: null, hits: 0, waitForNews: false, key: moveSetKey(moves),
      moves: moves.map(m => ({ ...m, minutesRisk: null, tags: [] })) };
    return solverCard(parts.result.modes.longterm, { plan: parts.plan, moves, describe, inputVersion, positionOf: () => 'FWD' }).key;
  };
  assert.equal(keyOf(two, 3), '2,15>101,102|3');
  assert.equal(keyOf([...two].reverse(), 3), '2,15>101,102|3');
  assert.equal(keyOf([{ outId: 15, inId: 102 }, { outId: 2, inId: 101 }], 3), '2,15>101,102|3', 'paired the other way, the same change');
  assert.notEqual(keyOf(two, 4), keyOf(two, 3));
});

test('a card is refused what it cannot render or cannot trust: no move for a move, no way to pair, a describe for other moves', () => {
  const parts = cardParts();
  const engine = parts.result.modes.longterm;
  const moves = [{ outId: 15, inId: 101 }];
  const made = over => solverCard(engine, { plan: parts.plan, moves, describe: describePlan(parts.input, CONFIG, parts.cache, 'longterm', moves),
    inputVersion: 7, positionOf: () => 'FWD', ...over });
  made({});

  // The plan moves now but orderMoves found no legal first move: no card, so the runner keeps the engine's.
  const none = describePlan(parts.input, CONFIG, parts.cache, 'longterm', []);
  assert.throws(() => made({ moves: [], describe: none }), /no move/);
  const waits = { ...parts.plan, weeks: [{ ...parts.plan.weeks[0], in: [], out: [] }, parts.plan.weeks[0]] };
  assert.throws(() => made({ plan: waits, moves: [], describe: none }), /no move/, 'a wait needs its next week\'s move');
  assert.equal(made({ plan: { ...parts.plan, weeks: [{ ...parts.plan.weeks[0], in: [], out: [] }] }, moves: [], describe: none }).call, 'roll',
    'a roll has none, and is no error');

  // The later weeks are paired by position, so a plan without later moves needs it too.
  for (const positionOf of [undefined, null, new Map()]) assert.throws(() => made({ positionOf }), /positionOf/);

  // Its explanation is of these moves, not others (they are matched by index).
  const other = describePlan(parts.input, CONFIG, parts.cache, 'longterm', [{ outId: 14, inId: 101 }]);
  assert.throws(() => made({ describe: other }), /describe/);
  assert.throws(() => made({ describe: { ...made({}), key: undefined } }), /describe/);
});

test('the card counts its hits from its moves by FPL\'s rule, not from the plan\'s own count', () => {
  const parts = cardParts();
  // A solve stopped inside its gap can report hits its moves do not make.
  const over = { ...parts.plan, weeks: parts.plan.weeks.map(w => ({ ...w, hits: 8 })) };
  assert.equal(cardOf({ ...parts, plan: over }).hits, 0, 'one move on one free transfer is free');
  const two = [{ outId: 15, inId: 101 }, { outId: 2, inId: 102 }];
  const { input, cache, result } = engineOf(scenario({ candidates: [
    { id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'GKP', xip: 8 }] }));
  const card = cardOf({ input, cache, result, plan: { ...parts.plan, weeks: parts.plan.weeks.map(w => ({ ...w, hits: 0 })) } }, { moves: two });
  assert.equal(card.hits, 4, 'two moves on one free transfer is one hit');
  assert.equal(card.moves.length, 2);
});

test('a wait is the next week\'s move, tentative, with the week it is made for', () => {
  const parts = cardParts([{ id: 102, position: 'FWD', xip: 3 }]);
  const plan = { objective: 5, weeks: [
    { gw: 10, in: [], out: [], hits: 0, ft: 1 }, { gw: 11, in: [101], out: [15], hits: 0, ft: 2 },
    { gw: 12, in: [102], out: [14], hits: 0, ft: 2 }] };
  assert.equal(callOf(plan), 'wait');
  const card = cardOf({ ...parts, plan }, { moves: [{ outId: 15, inId: 101 }] });
  assert.deepEqual([card.call, card.deferral, card.hits, card.key], ['wait', { gw: 11 }, 0, '15>101|7']);
  assert.deepEqual([card.root.outId, card.root.inId], [15, 101]);
  assert.deepEqual(card.later, [{ gw: 12, moves: [{ outId: 14, inId: 102 }] }], 'the week it waits for is the card\'s own');
});

test('a roll has no root and no moves; later weeks show once the move is made, only the weeks that have moves', () => {
  const parts = cardParts([{ id: 102, position: 'MID', xip: 3 }, { id: 103, position: 'MID', xip: 3 }]);
  const rolled = { objective: 1, weeks: [{ gw: 10, in: [], out: [], ft: 1 }, { gw: 11, in: [], out: [], ft: 2 }] };
  const roll = cardOf({ ...parts, plan: rolled }, { moves: [] });
  assert.deepEqual([roll.call, roll.root, roll.moves, roll.key, roll.hits, roll.later], ['roll', null, [], '|7', 0, []]);

  const plan = { objective: 5, weeks: [
    { gw: 10, in: [101], out: [15], hits: 0, ft: 1 }, { gw: 11, in: [], out: [], ft: 1 },
    { gw: 12, in: [103, 102], out: [9, 8], hits: 0, ft: 2 }] };
  const card = cardOf({ ...parts, plan }, { moves: [{ outId: 15, inId: 101 }] });
  assert.deepEqual(card.later, [{ gw: 12, moves: [{ outId: 8, inId: 102 }, { outId: 9, inId: 103 }] }]);
});

test('a pick the gain calls a roll is a roll card that keeps the plan\'s later weeks', () => {
  const parts = cardParts([{ id: 102, position: 'MID', xip: 3 }]);
  const plan = { objective: 5, weeks: [
    { gw: 10, in: [101], out: [15], hits: 0, ft: 1 }, { gw: 11, in: [102], out: [9], hits: 0, ft: 1 }] };
  assert.equal(callOf(plan), 'move');
  const roll = cardOf({ ...parts, plan }, { moves: [], call: 'roll' });
  assert.deepEqual([roll.source, roll.call, roll.root, roll.moves, roll.key, roll.hits, roll.deferral], ['solver', 'roll', null, [], '|7', 0, null]);
  assert.deepEqual(roll.later, [{ gw: 11, moves: [{ outId: 9, inId: 102 }] }], 'the plan\'s tentative later weeks stay');
  // Without the override the plan's own call stands, and a move still needs a move to show.
  assert.equal(cardOf({ ...parts, plan }).call, 'move');
  assert.throws(() => cardOf({ ...parts, plan }, { moves: [] }), /no move has a legal order/);
});

test('a wait the solver cannot make is a roll that keeps the weeks after the wait', () => {
  const parts = cardParts([{ id: 102, position: 'MID', xip: 3 }]);
  const plan = { objective: 5, weeks: [
    { gw: 10, in: [], out: [], hits: 0, ft: 1 }, { gw: 11, in: [101], out: [15], hits: 0, ft: 2 },
    { gw: 12, in: [102], out: [9], hits: 0, ft: 2 }] };
  const roll = cardOf({ ...parts, plan }, { moves: [], call: 'roll' });
  assert.deepEqual([roll.call, roll.deferral, roll.moves], ['roll', null, []]);
  assert.deepEqual(roll.later, [{ gw: 12, moves: [{ outId: 9, inId: 102 }] }], 'the sale it could not make is not in the list');
});

// ─── Gain over rolling and the alternatives ──────────────────────────────────

test('gain over rolling is the plan less its rolled plan', () => {
  const { problem, plan } = cardParts();
  const rolled = rollingProblem(problem);
  assert.deepEqual(rolled.fixed.first, { in: [], out: [] });
  assert.equal(problem.fixed.first, undefined, 'the problem it came from is left as it was');
  const rolling = solve(rolled);
  assert.deepEqual([rolling.weeks[0].in, rolling.weeks[0].out], [[], []]);
  assert.equal(gainOverRolling(plan, rolling), plan.objective - rolling.objective);
  assert.ok(gainOverRolling(plan, rolling) > 0, 'a forward worth 12 a week beats his bench place');
  assert.equal(gainOverRolling(rolling, rolling), 0);
});

/** Three forwards worth nearly the same, so the pick has alternatives close behind it. */
function closeCall() {
  const { input, cache, result } = engineOf(scenario({ candidates: [
    { id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'FWD', xip: 11.8 }, { id: 103, position: 'FWD', xip: 11.6 }] }));
  const problem = solverProblem(input, result, modeSetting(input, result, 'longterm', CONFIG), CONFIG);
  return { input, cache, result, problem, plan: solve(problem) };
}

test('alternatives exclude the pick and stay within the window', async () => {
  const { problem, plan } = closeCall();
  const keyOf = week => moveSetKey(pairMoves(week, id => problem.players.find(q => q.id === id).position));
  const calls = [];
  const spy = p => { calls.push(p.exclude); return solve(p); };
  const alts = await alternativesOf(problem, plan, spy, CONFIG);

  assert.equal(alts.length, CONFIG.alternativesMax, 'two close alternatives are found');
  assert.deepEqual(calls[0], [{ in: plan.weeks[0].in, out: plan.weeks[0].out }], 'the pick is excluded from the first re-solve');
  assert.equal(calls[1].length, 2, 'and the first alternative from the second');
  assert.equal(problem.exclude, undefined, 'the problem it came from is left as it was');
  const keys = [keyOf(plan.weeks[0]), ...alts.map(a => moveSetKey(a.moves))];
  assert.equal(new Set(keys).size, keys.length, `${keys} are all different`);
  for (const alt of alts) {
    assert.ok(alt.moves.length > 0 && alt.moves.every(m => m.outId && m.inId));
    assert.ok(alt.gain <= 1e-9 && -alt.gain <= CONFIG.alternativesWindow, `${alt.gain}: no better than the pick, within the window`);
  }
  assert.ok(alts[0].gain >= alts[1].gain - 1e-9, 'best first');

  // The window decides, to the point; so does the cap.
  const gap = -alts[0].gain;
  assert.ok(gap > 0);
  assert.deepEqual(await alternativesOf(problem, plan, solve, { ...CONFIG, alternativesWindow: gap - 1e-6 }), []);
  assert.equal((await alternativesOf(problem, plan, solve, { ...CONFIG, alternativesWindow: gap + 1e-6 })).length >= 1, true);
  assert.equal((await alternativesOf(problem, plan, solve, { ...CONFIG, alternativesWindow: Infinity, alternativesMax: 1 })).length, 1);
});

test('alternatives stop when a re-solve finds no plan, and wait on a solve that answers later', async () => {
  const { problem, plan } = closeCall();
  assert.deepEqual(await alternativesOf(problem, plan, () => null, CONFIG), []);
  const later = p => new Promise(resolve => setTimeout(() => resolve(solve(p)), 1));
  assert.equal((await alternativesOf(problem, plan, later, CONFIG)).length, CONFIG.alternativesMax);
  // A pick that rolls is excluded too: the alternative is a move.
  const rolling = solve(rollingProblem(problem));
  const [first] = await alternativesOf(problem, rolling, solve, { ...CONFIG, alternativesWindow: Infinity });
  assert.ok(first.moves.length > 0);
});
