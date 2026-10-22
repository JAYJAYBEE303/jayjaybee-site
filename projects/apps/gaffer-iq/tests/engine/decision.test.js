/**
 * tests/engine/decision.test.js
 * The decision engine (brief §5-§7, docs/decision-engine-plan.md Phase 3) on
 * hand-built projections, so every expected figure can be worked out on paper.
 *
 * The base squad: XI 4-4-2 - GK 1; DEF 3, 4, 5, 6; MID 8, 9, 10, 11; FWD 13,
 * 14 - worth 62, captain FWD 13 (9) for 71 in all; bench MID 12, FWD 15, DEF 7,
 * GK 2. Everyone plays and every player is £5.0m at his own club unless a test
 * says otherwise, so autosubs and club limits stay out of the way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDecisionEngine, transferCost, createDecisionCache } from '../../js/engine/decision.js';
import { squadValue } from '../../js/engine/squad-value.js';
import { DECISION_ENGINE, SEASON_GWS } from '../../js/config.js';

import {
  GW, MODES, BASE, close, scenario, playerOf, allBest,
} from './decision-fixtures.js';

// ─── Transfer cost (plan §5.2) ───────────────────────────────────────────────

test('a free transfer costs what rolling it would bank; with none left, the hit plus its margin', () => {
  assert.equal(transferCost(0), 4 + 2);
  assert.equal(transferCost(1), 1.5);
  assert.equal(transferCost(2), 1.0);
  assert.equal(transferCost(3), 0.6);
  assert.equal(transferCost(4), 0.3);
  assert.equal(transferCost(5), 0);
});

test('in flat mode every free transfer is worth the same, and at the cap nothing', () => {
  const flat = { ...DECISION_ENGINE, ftValueMode: 'flat' };
  assert.equal(transferCost(1, flat), 1.75);
  assert.equal(transferCost(4, flat), 1.75);
  assert.equal(transferCost(5, flat), 0);
});

// ─── OutScore and the call ───────────────────────────────────────────────────

test('a move whose squad gain equals the free transfer\'s value scores 0, and the call is to roll', () => {
  // Keeper 101 projects 5.5 to keeper 1's 4: +1.5 in the planning GW, exactly
  // what one free transfer is worth.
  const result = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: 5.5 }] }));
  const best = playerOf(result, 1).best.now;
  assert.equal(best.inId, 101);
  assert.equal(best.deltaEv, 1.5);
  assert.equal(best.outScore, 0);
  assert.equal(result.modes.now.call, 'roll');
  assert.equal(result.modes.now.root, null);
  assert.equal(result.modes.now.rollValue, 1.5);
});

test('with no free transfer a move must clear the hit and its margin; with five banked it is free', () => {
  // Keeper 101 projects 6.5 to keeper 1's 4: +2.5 in the planning GW.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6.5 }] });
  const none = runDecisionEngine({ ...input, freeTransfers: 0 });
  assert.equal(none.modes.now.rollValue, 4 + 2);
  assert.equal(none.modes.now.call, 'roll');
  close(playerOf(none, 1).best.now.outScore, 2.5 - 6);
  assert.match(playerOf(none, 1).best.now.why.cost, /hit/);

  const five = runDecisionEngine({ ...input, freeTransfers: 5 });
  assert.equal(five.modes.now.rollValue, 0);
  close(five.modes.now.root.outScore, 2.5);
  assert.match(five.modes.now.root.why.cost, /waste/);
});

test('Long term rolls a move that beats rolling only thanks to the money it frees', () => {
  // Keeper 101 projects 4.4 (+0.4 a GW, 1.2 over Long term's three GWs) and costs £2.0m less: OutScore
  // 1.2 + 0.30 x 2.0 - 1.5 = 0.3, but the squad gain is under the FT's 1.5.
  const result = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: 4.4, price: 30 }] }));
  const best = playerOf(result, 1).best.longterm;
  assert.ok(best.outScore > 0, `OutScore ${best.outScore}`);
  assert.ok(best.deltaEv < 1.5, `DeltaEV ${best.deltaEv}`);
  assert.equal(result.modes.longterm.call, 'roll');
});

test('every owned player carries KeepValue, OutScore and his best move for all six modes', () => {
  // A cheaper candidate at every position, so each player has a legal move in
  // every mode - Funds only counts downgrades, here those within tau.
  const result = runDecisionEngine(scenario({ candidates: [
    { id: 101, position: 'GKP', xip: 4.5, price: 45 }, { id: 102, position: 'DEF', xip: 5.2, price: 45 },
    { id: 103, position: 'MID', xip: 8.2, price: 45 }, { id: 104, position: 'FWD', xip: 9.2, price: 45 }] }));
  const components = ['outId', 'inId', 'deltaEv', 'perGw', 'fundsTerm', 'priceTerm', 'transferCost',
    'deadSlotTerm', 'outScore', 'tentativeFromGw', 'minutesRisk', 'chained', 'tags', 'why'];
  assert.equal(result.players.length, 15);
  for (const player of result.players) {
    for (const mode of MODES) {
      assert.equal(typeof player.keepValue[mode], 'number', `${player.playerId} ${mode}`);
      const move = player.best[mode];
      assert.ok(move, `${player.playerId} has a ${mode} move`);
      for (const key of components) assert.ok(key in move, `${mode} move lacks ${key}`);
      assert.equal(move.perGw.length, 5);
      assert.equal(player.outScore[mode], move.outScore);
    }
  }
});

test('a player with no legal move in a mode has no best move and no OutScore there', () => {
  // Nothing cheaper exists, so Funds - which only counts downgrades - has none.
  const result = runDecisionEngine(scenario({ candidates: [{ id: 103, position: 'MID', xip: 6.5 }] }));
  const player = playerOf(result, 11);
  assert.equal(player.best.funds, null);
  assert.equal(player.outScore.funds, null);
  assert.ok(player.best.now);
});

test('the base squad\'s KeepValues: its captain is worth 7.5 to keep, its third sub nothing', () => {
  // Without FWD 13 the XI turns 4-5-1 at 55.5 and MID 8 captains: 71 - 63.5, every GW alike - so Long term,
  // a total over three GWs, has him at 22.5.
  const result = runDecisionEngine(scenario());
  close(playerOf(result, 13).keepValue.now, 7.5);
  close(playerOf(result, 7).keepValue.now, 0);
  close(playerOf(result, 13).keepValue.longterm, 22.5);
});

test('every mode weighs its window as a total: Long term and Future prep are not averages, and their lambda is in step', () => {
  // Keeper 101 gains 1 every GW. As totals, Long term's three GWs make 3 and Future prep's five weights 4.25.
  const result = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: 5 }] }));
  const keeper = playerOf(result, 1);
  close(keeper.best.longterm.deltaEv, 3);
  close(keeper.best.future.deltaEv, 4.25);
  assert.deepEqual(DECISION_ENGINE.modes.longterm.weights, [1, 1, 1, 0, 0]);
  assert.deepEqual(DECISION_ENGINE.modes.future.weights, [0.5, 0.75, 1, 1, 1]);
  // The money terms value £1m against a point as they did on the averaged scale: lambda times the weights' sum.
  close(DECISION_ENGINE.modes.longterm.lambda, 0.10 * 3);
  close(DECISION_ENGINE.modes.future.lambda, 0.15 * 4.25);
  close(DECISION_ENGINE.modes.future.deferralEpsilon, 0.1 * 4.25);
});

test('alternatives are the next-best moves within the window that also beat rolling, at most two', () => {
  // Only MID 11 (£6.0m) can afford the £5.5m midfielders: +3.5, +3, +2.5 and +1
  // in his place, so OutScores 2.0, 1.5, 1.0 and -0.5.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 11, price: 60 }],
    candidates: [[125, 8.5], [126, 8], [127, 7.5], [128, 6]].map(([id, xip]) => ({ id, position: 'MID', xip, price: 55 })),
  }));
  const { root, alternatives } = result.modes.now;
  assert.equal(root.inId, 125);
  assert.deepEqual(alternatives.map(m => m.inId), [126, 127]);
});

test('a move beyond the alternatives window is not offered as an alternative', () => {
  // Only bench MID 12 (£6.0m) can afford them; each starts over DEF 6 (3):
  // OutScores 4.0, 3.0 and 1.0 - the last is 3 points off the move.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 12, price: 60 }],
    candidates: [[125, 8.5], [126, 7.5], [127, 5.5]].map(([id, xip]) => ({ id, position: 'MID', xip, price: 55 })),
  }));
  const { root, alternatives } = result.modes.now;
  close(root.outScore, 4);
  assert.deepEqual(alternatives.map(m => m.inId), [126]);
});

test('how many alternatives are shown and how close they must be are separate settings', () => {
  // OutScores 2.0, 1.5, 1.25 and 1.0, all beating rolling.
  const input = scenario({
    changes: [{ id: 11, price: 60 }],
    candidates: [[125, 8.5], [126, 8], [129, 7.75], [127, 7.5]].map(([id, xip]) => ({ id, position: 'MID', xip, price: 55 })),
  });
  const alternatives = config => runDecisionEngine(input, config).modes.now.alternatives.map(m => m.inId);
  assert.deepEqual(alternatives({ ...DECISION_ENGINE, alternativesWindow: 3 }), [126, 129]);
  assert.deepEqual(alternatives({ ...DECISION_ENGINE, alternativesWindow: 0.5 }), [126]);
});

test('a move explains itself in plain English', () => {
  const result = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6.5 }] }));
  const { why } = result.modes.now.root;
  assert.match(why.squad, /P1 out, P101 in/);
  assert.match(why.cost, /free transfer/);
  assert.equal(why.price, null);
});

test('a move\'s explanation names only the GWs it counts', () => {
  // Free Hit in GW11: Long term counts GW10 and GW12 (+4 each, a third weight).
  const result = runDecisionEngine(scenario({
    candidates: [{ id: 101, position: 'GKP', xip: 8 }], chipPlan: { [GW + 1]: 'freehit' } }));
  assert.match(result.modes.longterm.root.why.squad, /over GW10 and GW12\./);
});

test('identical input gives identical output', () => {
  const make = () => scenario({ candidates: [
    { id: 101, position: 'GKP', xip: 5 }, { id: 102, position: 'DEF', xip: 5.5 },
    { id: 103, position: 'MID', xip: 7.5 }, { id: 104, position: 'FWD', xip: 8 }] });
  assert.deepEqual(runDecisionEngine(make()), runDecisionEngine(make()));
});

// ─── Money: sell price, ledger, locks and bans ───────────────────────────────

test('budget uses the sell price, never the current price', () => {
  // MID 11 cost £5.0m and is now £5.6m: he sells for £5.3m. MID 117 at £5.5m
  // is affordable at his current price but not at his sell price.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 11, price: 56, purchase: 50 }],
    candidates: [{ id: 117, position: 'MID', xip: 7, price: 55 }, { id: 118, position: 'MID', xip: 6.5, price: 53 }],
  }));
  assert.equal(playerOf(result, 11).best.now.inId, 118);
  assert.ok(allBest(result).every(m => m.inId !== 117));
  assert.equal(playerOf(result, 11).sellPriceTenths, 53, 'the table shows the sell price');
});

test('with no ledger entry a player sells at his current price, flagged estimated', () => {
  const result = runDecisionEngine(scenario({
    changes: [{ id: 11, price: 56, purchase: null }],
    candidates: [{ id: 117, position: 'MID', xip: 7, price: 55 }],
  }));
  const player = playerOf(result, 11);
  assert.ok(player.flags.includes('sellPriceEstimated'));
  assert.equal(player.best.now.inId, 117);
  assert.ok(player.best.now.tags.includes('sellPriceEstimated'));
});

/** DEF 4 is injured all horizon; DEF 7, the third sub, is a £4.0m bench filler. */
const fillerScenario = (extra = {}) => scenario({
  changes: [{ id: 4, pz: 1, av: 0 }, { id: 7, price: 40 }],
  candidates: [{ id: 103, position: 'DEF', xip: 4.5 }, { id: 104, position: 'DEF', xip: 2.4, price: 40 }],
  ...extra,
});

test('a bench filler is not Now\'s top sell when the squad holds a genuine one', () => {
  // DEF 4 out for DEF 103 is +2.0 (103 starts over MID 12); the filler can only
  // afford DEF 104, who would sit on the bench like him.
  const result = runDecisionEngine(fillerScenario());
  assert.equal(result.modes.now.root.outId, 4);
  assert.equal(result.modes.now.root.inId, 103);
  assert.ok(playerOf(result, 7).best.now.outScore < 0);
});

test('a locked player is never a sell, and a banned player never a buy', () => {
  const locked = runDecisionEngine(fillerScenario({ locks: new Set([4]) }));
  assert.ok(playerOf(locked, 4).flags.includes('locked'));
  for (const mode of MODES) assert.notEqual(locked.modes[mode].root?.outId, 4, mode);

  const banned = runDecisionEngine(fillerScenario({ bans: new Set([103]) }));
  assert.ok(allBest(banned).every(m => m.inId !== 103));
  for (const mode of MODES) assert.notEqual(banned.modes[mode].root?.inId, 103, mode);
});

// ─── Chips and blanks ────────────────────────────────────────────────────────

test('a starter who blanks only in a planned Free Hit GW is not a top sell in any mode', () => {
  // MID 11 blanks in GW11 alone; only he can afford MID 102. Unplanned,
  // Structure sells him; with a Free Hit in GW11 that GW counts for nothing.
  const base = {
    changes: [{ id: 11, price: 60, fx: [1, 0, 1, 1, 1, 1] }],
    candidates: [{ id: 102, position: 'MID', xip: 5, price: 55 }],
  };
  assert.equal(runDecisionEngine(scenario(base)).modes.structure.root?.outId, 11);
  const planned = runDecisionEngine(scenario({ ...base, chipPlan: { 11: 'freehit' } }));
  for (const mode of MODES) assert.notEqual(planned.modes[mode].root?.outId, 11, mode);
});

test('a fit player who blanks next GW: Now may sell him, labelled one-week; the other modes keep him', () => {
  // FWD 13 blanks in GW10, then outscores FWD 105 (6, then 8) every week.
  const base = {
    changes: [{ id: 13, fx: [0, 1, 1, 1, 1, 1] }, { id: 15, price: 40 }],
    candidates: [{ id: 105, position: 'FWD', xip: [6, 8, 8, 8, 8, 8] }],
  };
  const result = runDecisionEngine(scenario(base));
  const now = result.modes.now.root;
  assert.equal(now.outId, 13);
  assert.ok(now.tags.includes('blankGwOneWeek'));
  assert.match(now.why.squad, /one-week/);
  assert.equal(now.minutesRisk.out, 'blank', 'no fixture is a blank, not a minutes risk');
  for (const mode of MODES.slice(1)) assert.notEqual(result.modes[mode].root?.outId, 13, mode);

  // A Free Hit that GW means he is never sold.
  const freeHit = runDecisionEngine(scenario({ ...base, chipPlan: { [GW]: 'freehit' } }));
  for (const mode of MODES) assert.notEqual(freeHit.modes[mode].root?.outId, 13, mode);
});

test('a Wildcard in the planning GW leaves every mode nothing to weigh: all six roll', () => {
  // Selling the £15.0m captain (9 a GW) for a £4.5m forward (2 a GW) frees
  // £10.5m; with every GW played by the Wildcard squad, money alone must not
  // make the move.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 13, price: 150 }],
    candidates: [{ id: 120, position: 'FWD', xip: 2, price: 45 }],
    freeTransfers: 4,
    chipPlan: { [GW]: 'wildcard' },
  }));
  for (const mode of MODES) assert.equal(result.modes[mode].call, 'roll', mode);
  assert.deepEqual(allBest(result), []);
  assert.equal(result.modes.ceiling.targetGw, null);
});

test('gameweeks past the end of the season count for nothing and are never hinted', () => {
  // Planning GW36: the projections run to GW41; the bench doubles in GW39-40.
  const result = runDecisionEngine(scenario({
    planningGw: 36,
    candidates: [{ id: 101, position: 'GKP', xip: 6.5 }],
    changes: [{ id: 12, xip: [2.5, 2.5, 2.5, 9, 9, 2.5], fx: [1, 1, 1, 2, 2, 1] }],
  }));
  assert.deepEqual(result.modes.future.weights.slice(SEASON_GWS - 36 + 1), [0, 0]);
  assert.ok(result.modes.future.weights[0] > 0);
  assert.ok(result.modes.ceiling.targetGw <= SEASON_GWS);
  assert.ok(result.chipHints.benchboost.gw <= SEASON_GWS, `hinted GW${result.chipHints.benchboost.gw}`);
});

test('a chip planned for a GW already gone is ignored', () => {
  const base = { candidates: [{ id: 101, position: 'GKP', xip: 6.5 }] };
  assert.deepEqual(runDecisionEngine(scenario({ ...base, chipPlan: { [GW - 2]: 'wildcard' } })),
    runDecisionEngine(scenario(base)));
});

test('money freed counts only for the share of a mode\'s weight a planned chip leaves', () => {
  // A Wildcard in GW11 leaves Long term GW10's third of its weight, so keeper
  // 101's £2.0m saving is worth 0.30 x 2.0 x 1/3 there.
  const result = runDecisionEngine(scenario({
    candidates: [{ id: 101, position: 'GKP', xip: 5, price: 30 }], chipPlan: { [GW + 1]: 'wildcard' } }));
  close(playerOf(result, 1).best.longterm.fundsTerm, 0.30 * 2.0 / 3);
});

test('the dead-slot penalty shrinks with the share of Structure\'s weight a planned chip leaves', () => {
  // DEF 4 is out all horizon; a Wildcard in GW11 leaves GW10's 1 of 3.7.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 4, pz: 1, av: 0 }],
    candidates: [{ id: 115, position: 'DEF', xip: 4 }],
    chipPlan: { [GW + 1]: 'wildcard' },
  }));
  close(playerOf(result, 4).best.structure.deadSlotTerm,
    DECISION_ENGINE.modes.structure.deadSlotPenalty / 3.7);
});

test('the captain and XI panel names the next captain and the gap, doubled under Triple Captain', () => {
  const normal = runDecisionEngine(scenario()).lineup;
  assert.equal(normal.captainId, 13);
  assert.equal(normal.nextCaptainId, 8);
  assert.equal(normal.captainGap, 1);
  assert.equal(normal.xi.length, 11);
  const tc = runDecisionEngine(scenario({ chipPlan: { [GW]: 'triplecaptain' } })).lineup;
  assert.equal(tc.captainGap, 2 * normal.captainGap);
});

test('the Bench Boost hint is the GW with the largest Bench Boost increment', () => {
  // The bench plays doubles in GW12.
  const input = scenario({ changes: [
    { id: 12, xip: [2.5, 2.5, 5, 2.5, 2.5, 2.5], fx: [1, 1, 2, 1, 1, 1] },
    { id: 15, xip: [2.2, 2.2, 4.4, 2.2, 2.2, 2.2], fx: [1, 1, 2, 1, 1, 1] },
    { id: 7, xip: [1, 1, 2, 1, 1, 1], fx: [1, 1, 2, 1, 1, 1] },
  ] });
  const hint = runDecisionEngine(input).chipHints.benchboost;
  const ids = input.squad.map(s => s.playerId);
  assert.equal(hint.gw, 12);
  close(hint.gain, squadValue(ids, 12, input.projections, { chip: 'benchboost' }).components.benchBoost);
  assert.match(hint.reasoning, /GW12/);
});

test('the Triple Captain hint picks a captain\'s double over his singles', () => {
  const input = scenario({ changes: [{ id: 13, xip: [9, 9, 9, 18, 9, 9], fx: [1, 1, 1, 2, 1, 1] }] });
  const hint = runDecisionEngine(input).chipHints.triplecaptain;
  assert.equal(hint.gw, 13);
  close(hint.gain, 18);
});

test('a chip already used in a half is never hinted for a GW in that half', () => {
  const used = [{ chip: 'benchboost', gw: 3 }, { chip: 'triplecaptain', gw: 5 }];
  const { chipHints } = runDecisionEngine(scenario({ chipsUsed: used }));
  assert.equal(chipHints.benchboost, null);
  assert.equal(chipHints.triplecaptain, null);

  // Planning GW17: GW17-19 are the first half, GW20-22 the second. The bench's
  // best week is GW18, but Bench Boost is spent for that half: GW21 instead.
  const input = scenario({
    planningGw: 17,
    chipsUsed: [{ chip: 'benchboost', gw: 3 }],
    changes: [{ id: 12, xip: [2.5, 9, 2.5, 2.5, 6, 2.5] }],
  });
  assert.equal(runDecisionEngine(input).chipHints.benchboost.gw, 21);
});

test('no Bench Boost week is hinted at or after a planned Wildcard', () => {
  // The bench's double is GW12, but a Wildcard in GW11 replaces this squad.
  const input = scenario({
    changes: [
      { id: 12, xip: [2.5, 2.5, 5, 2.5, 2.5, 2.5], fx: [1, 1, 2, 1, 1, 1] },
      { id: 15, xip: [2.2, 2.2, 4.4, 2.2, 2.2, 2.2], fx: [1, 1, 2, 1, 1, 1] },
    ],
    chipPlan: { [GW + 1]: 'wildcard' },
  });
  assert.equal(runDecisionEngine(input).chipHints.benchboost.gw, GW);
});

// ─── Mode 1: Now ─────────────────────────────────────────────────────────────

test('Now never buys a player more likely than its gate to get no minutes', () => {
  // MID 106 scores 12 when he plays but plays 60% of the time (7.2): the best
  // buy on value, which Long term takes. Now settles for MID 107 (6.6, nailed).
  const result = runDecisionEngine(scenario({ candidates: [
    { id: 106, position: 'MID', xip: 12, pz: 0.4 }, { id: 107, position: 'MID', xip: 6.6 }] }));
  assert.equal(result.modes.longterm.root.inId, 106);
  assert.equal(result.modes.longterm.root.minutesRisk.in, 'high');
  assert.equal(result.modes.longterm.root.minutesRisk.out, 'low');
  assert.equal(result.modes.now.root.inId, 107);
  assert.ok(allBest(result).filter(m => m.mode === 'now').every(m => m.inId !== 106));
});

// ─── Mode 4: Funds & flexibility ─────────────────────────────────────────────

const FUNDS_WEIGHT_SUM = [0, 1, 2, 3, 4].reduce((s, k) => s + (0.85 ** k), 0);

test('Funds does not count a downgrade that gives up more than tau points', () => {
  // MID 10 (£8.0m) for MID 110 (£5.0m) frees £3.0m but gives up 0.5 a GW:
  // 0.5 x 3.71 = 1.85 points over the horizon, above tau.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 10, price: 80 }],
    candidates: [{ id: 110, position: 'MID', xip: 5.5 }],
  }));
  assert.equal(playerOf(result, 10).best.funds, null);
});

test('Funds weighs the GWs by the configured decay', () => {
  const config = { ...DECISION_ENGINE, decayBase: 0.5 };
  assert.deepEqual(runDecisionEngine(scenario(), config).modes.funds.weights, [1, 0.5, 0.25, 0.125, 0.0625]);
});

test('Funds rates a downgrade\'s efficiency as the money it frees per point it gives up', () => {
  // MID 109 instead (0.1 a GW less): £3.0m for 0.1 x 3.71 = 0.37 points.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 10, price: 80 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }],
  }));
  const best = playerOf(result, 10).best.funds;
  assert.equal(best.inId, 109);
  close(best.efficiency, 3.0 / (0.1 * FUNDS_WEIGHT_SUM));
  assert.equal(result.modes.funds.call, 'roll');
});

test('Funds credits a downgrade with the second move it pays for, net of that move\'s cost', () => {
  // Selling MID 10 (£8.0m) for MID 109 frees £3.0m, which - and only which -
  // lets FWD 14 (£6.0m) become FWD 111 (£9.0m, 10 a GW and the new captain):
  // +5 a GW, less a second FT worth 1.5.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }],
    freeTransfers: 2,
  }));
  const root = result.modes.funds.root;
  assert.equal(root.outId, 10);
  assert.equal(root.inId, 109);
  assert.equal(root.chained.outId, 14);
  assert.equal(root.chained.inId, 111);
  close(root.fundsTerm, (5 * FUNDS_WEIGHT_SUM) - 1.5);
  assert.match(root.why.funds, /P111/);
});

test('with one free transfer, the second move a downgrade pays for is costed as a hit', () => {
  const result = runDecisionEngine(scenario({
    changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }],
  }));
  const { chained } = result.modes.funds.root;
  assert.equal(chained.transferCost, 4 + 2);
  close(chained.outScore, (5 * FUNDS_WEIGHT_SUM) - 6);
  assert.match(chained.why.cost, /hit/);
});

// ─── Mode 5: Ceiling ─────────────────────────────────────────────────────────

test('Ceiling targets the GW with the highest top-15 xpts', () => {
  const result = runDecisionEngine(scenario({
    candidates: [{ id: 112, position: 'FWD', xip: [6, 6, 20, 6, 6, 6], fx: [1, 1, 2, 1, 1, 1] }] }));
  assert.equal(result.modes.ceiling.targetGw, 12);
  assert.deepEqual(result.modes.ceiling.weights, [0.1, 0.1, 1, 0.1, 0.1]);
});

test('Ceiling breaks a tie for the target GW by the most double-GW fixtures', () => {
  // +3 in GW11 from a single fixture, +3 in GW13 from a double.
  const result = runDecisionEngine(scenario({ changes: [
    { id: 8, xip: [8, 11, 8, 8, 8, 8] },
    { id: 9, xip: [7, 7, 7, 10, 7, 7], fx: [1, 1, 1, 2, 1, 1] }] }));
  assert.equal(result.modes.ceiling.targetGw, 13);
});

test('Ceiling never targets a GW a planned chip covers', () => {
  // GW12 is the strongest week, but a Free Hit plays it: the target is the
  // next best, GW13 (+3 from a double).
  const result = runDecisionEngine(scenario({
    changes: [{ id: 9, xip: [7, 7, 7, 10, 7, 7], fx: [1, 1, 1, 2, 1, 1] }],
    candidates: [{ id: 112, position: 'FWD', xip: [6, 6, 20, 6, 6, 6], fx: [1, 1, 2, 1, 1, 1] }],
    chipPlan: { 12: 'freehit' },
  }));
  assert.equal(result.modes.ceiling.targetGw, 13);
  assert.deepEqual(result.modes.ceiling.weights, [0.1, 0.1, 0, 1, 0.1]);
});

test('a player with a high lock value at the target GW is protected from sale in modes 1-4', () => {
  // FWD 13 is a 90% doubt in GW10, so Now alone would sell him; but his GW12
  // double makes him worth 22 at the target GW: 89 with him, 67 with FWD 113.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 13, xip: [9, 9, 18, 9, 9, 9], pz: [0.9, 0, 0, 0, 0, 0], fx: [1, 1, 2, 1, 1, 1] }],
    candidates: [{ id: 113, position: 'FWD', xip: 6 }],
  }));
  const player = playerOf(result, 13);
  close(player.lockValue, 22);
  assert.ok(player.flags.includes('protected'));
  for (const mode of ['now', 'longterm', 'future', 'funds']) {
    assert.notEqual(result.modes[mode].root?.outId, 13, mode);
  }
});

test('Ceiling puts no value on money (brief §6: lambda 0)', () => {
  // Keeper 101 is £2.0m cheaper than keeper 1.
  const result = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: 5, price: 30 }] }));
  assert.equal(playerOf(result, 1).best.ceiling.fundsTerm, 0);
  close(playerOf(result, 1).best.longterm.fundsTerm, 0.30 * 2.0);
});

test('Ceiling counts the bench in full when Bench Boost is planned for the target GW', () => {
  // GW12 is the target (FWD 13's double). MID 114 (2.9) would sit on the
  // bench in place of MID 12 (2.5): worth nothing unless the bench scores.
  const base = {
    changes: [{ id: 13, xip: [9, 9, 18, 9, 9, 9], fx: [1, 1, 2, 1, 1, 1] }],
    candidates: [{ id: 114, position: 'MID', xip: 2.9 }],
  };
  const plain = playerOf(runDecisionEngine(scenario(base)), 12).best.ceiling;
  const boosted = playerOf(runDecisionEngine(scenario({ ...base, chipPlan: { 12: 'benchboost' } })), 12).best.ceiling;
  close(plain.perGw[2], 0);
  close(boosted.perGw[2], 0.4);
});

/**
 * Every projection given a draw spec (engine/ceiling.js): each player always
 * plays 60+ in a fixture of his own, nobody scores and nobody concedes, so his
 * draws are a fixed 2 (6 for a keeper or defender, 3 for a midfielder) -
 * unless `scoring` gives his club goals and him a share of them.
 */
function withDraws(input, scoring = {}) {
  const terms = goal => ({ share: 1, goal, assist: 0, defcon: 0, yellow: 0, red: 0, bonus: 0 });
  const projections = new Map([...input.projections].map(([id, p]) => [id, { ...p, gws: p.gws.map(g => ({
    ...g,
    draw: {
      position: p.position, availability: 1, appear: 1, p60: 1, savesPerXga: 0,
      bonus: { goal: 0, assist: 0, cleanSheet: 0 },
      full: terms(scoring[id]?.share ?? 0), short: terms(0),
      sides: [{ fixtureId: id, teamId: id, opponentId: -id, goalsFor: scoring[id]?.goals ?? 0, goalsAgainst: 0, lambdaAgainst: 0 }],
    },
  })) }]));
  return { ...input, projections };
}

test('Ceiling\'s upper tail buys the upside: of two forwards, the one a little lower on expected points but far higher at its 90th percentile', () => {
  // 101 projects 8 and always scores 2; 102 projects 7.9 but takes half of his club's 3 expected goals.
  const input = withDraws(scenario({ candidates: [
    { id: 101, position: 'FWD', xip: 8 }, { id: 102, position: 'FWD', xip: 7.9 }] }), { 102: { goals: 3, share: 0.5 } });
  const tailed = runDecisionEngine(input);
  assert.equal(tailed.modes.ceiling.call, 'move');
  assert.equal(tailed.modes.ceiling.root.inId, 102);
  assert.equal(tailed.modes.ceiling.tail.quantile, 0.9);
  // The fixed draws make the squad's own tail exact: 6 x 5 (keeper, four defenders) + 3 x 4 + 2 x 2, captain 13's 2 again.
  assert.equal(tailed.modes.ceiling.tail.squad, 30 + 12 + 4 + 2);
  assert.equal(playerOf(tailed, 13).pP90, 2);

  const mean = runDecisionEngine(input, { ...DECISION_ENGINE, modes: { ...DECISION_ENGINE.modes,
    ceiling: { ...DECISION_ENGINE.modes.ceiling, tail: null } } });
  assert.equal(mean.modes.ceiling.root.inId, 101);
  assert.equal(mean.modes.ceiling.tail, null);
  assert.equal(playerOf(mean, 13).pP90, null);
  // Without draws to read (the v1 basis), the tail stands down.
  assert.equal(runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'FWD', xip: 8 }] })).modes.ceiling.tail, null);
});

test('under its tail Ceiling\'s KeepValue reads the draws at t* too, so Keep and Out share a basis', () => {
  const input = withDraws(scenario({}));
  const noTail = { ...DECISION_ENGINE, modes: { ...DECISION_ENGINE.modes, ceiling: { ...DECISION_ENGINE.modes.ceiling, tail: null } } };
  // Every week alike, so the mean KeepValue is 1.4 x one week's d (weights 1 and four of 0.1). Without forward 14
  // (always 2), midfielder 12 (always 3) joins the XI: on the draws his place at t* is worth -1.
  const mean = playerOf(runDecisionEngine(input, noTail), 14).keepValue.ceiling;
  const tailed = playerOf(runDecisionEngine(input), 14).keepValue.ceiling;
  close(tailed, (mean * (0.4 / 1.4)) - 1);
});

test('Ceiling\'s draws are kept while a player\'s draw spec is the same object, whatever projections Map carries it', () => {
  const input = withDraws(scenario({}), { 13: { goals: 2, share: 1 } });
  const cache = createDecisionCache();
  runDecisionEngine(input, DECISION_ENGINE, cache);
  const first = cache.tail.draws.get(13).points;
  runDecisionEngine({ ...input, projections: new Map(input.projections) }, DECISION_ENGINE, cache);
  assert.equal(cache.tail.draws.get(13).points, first);
  // A new spec (new projections built) is drawn again.
  runDecisionEngine(withDraws(scenario({}), { 13: { goals: 2, share: 1 } }), DECISION_ENGINE, cache);
  assert.notEqual(cache.tail.draws.get(13).points, first);
});

test('Ceiling\'s tail counts the armband three times under a planned Triple Captain', () => {
  // The captain's draws vary: club 13 expects 2 goals and he takes all of them.
  const plain = withDraws(scenario({}), { 13: { goals: 2, share: 1 } });
  const tc = runDecisionEngine({ ...plain, chipPlan: { [GW]: 'triplecaptain' } }).modes.ceiling.tail.squad;
  const normal = runDecisionEngine(plain).modes.ceiling.tail.squad;
  assert.ok(tc > normal, `${tc} under Triple Captain v ${normal}`);
});

// ─── Mode 6: Structure fix ───────────────────────────────────────────────────

test('Structure reports each starter\'s uncovered loss, summed with its decay', () => {
  // MID 8 plays half the time (8 when he does); MID 12 covers him with 2.5:
  // 0.5 x (8 - 2.5) = 2.75 a GW, x (1 + 0.85 + 0.72 + 0.61 + 0.52).
  const result = runDecisionEngine(scenario({ changes: [{ id: 8, pz: 0.5 }] }));
  close(playerOf(result, 8).uncoveredLoss, 2.75 * 3.7);
  assert.equal(playerOf(result, 13).uncoveredLoss, 0);
});

test('Structure adds the dead-slot penalty to selling a player out for several GWs', () => {
  // DEF 4 is out now and recovering slowly: expected 2.3 GWs missed of five.
  const result = runDecisionEngine(scenario({
    changes: [{ id: 4, pz: [1, 0.6, 0.36, 0.216, 0.1296, 0.07776],
      av: [0, 0.4, 0.64, 0.784, 0.8704, 0.92224] }],
    candidates: [{ id: 115, position: 'DEF', xip: 4 }],
  }));
  const move = playerOf(result, 4).best.structure;
  assert.equal(move.deadSlotTerm, DECISION_ENGINE.modes.structure.deadSlotPenalty);
  close(move.outScore, move.deltaEv + move.fundsTerm + move.deadSlotTerm - move.priceTerm - move.transferCost);
  assert.equal(playerOf(result, 3).best.structure.deadSlotTerm, 0);
  assert.equal(playerOf(result, 4).best.now.deadSlotTerm, 0, 'the penalty is Structure\'s alone');
});

test('Structure holds a doubtful player who recovers inside the horizon', () => {
  // DEF 5 is 50% now and back to 95% by GW12. Only he can afford DEF 116.
  const base = {
    changes: [{ id: 5, price: 60, pz: [0.5, 0.15, 0.045, 0.0135, 0.004, 0.0012],
      av: [0.5, 0.85, 0.955, 0.9865, 0.996, 0.9988] }],
    candidates: [{ id: 116, position: 'DEF', xip: 4, price: 55 }],
  };
  const result = runDecisionEngine(scenario(base));
  const player = playerOf(result, 5);
  assert.ok(player.flags.includes('hold'));
  assert.ok(player.flags.includes('pendingNews'));
  assert.notEqual(result.modes.structure.root?.outId, 5);

  // Were the recovery not inside the horizon, Structure would sell him.
  const neverRecovered = { ...DECISION_ENGINE, modes: { ...DECISION_ENGINE.modes,
    structure: { ...DECISION_ENGINE.modes.structure, recoveredAvailability: 2 } } };
  assert.equal(runDecisionEngine(scenario(base), neverRecovered).modes.structure.root?.outId, 5);
});

// ─── Prices, timing and money (Phase 5) ──────────────────────────────────────

/** A price signal in the adapter's shape: chances of a fall and a rise. */
const signal = (fall, rise = 0) => ({ fall, rise, source: 'fpl' });

/**
 * Keeper 101 is half a point better than keeper 1 in the planning GW and two
 * points better every GW after: a move whose gain comes later, so waiting a
 * week gives up little of it.
 */
const LATE_KEEPER = { id: 101, position: 'GKP', xip: [4.5, 6, 6, 6, 6, 6] };

test('PriceTerm is zero when a likely fall would not change his sell price', () => {
  // Bought at £5.0m, now £5.3m: he sells for £5.1m, and still for £5.1m at £5.2m.
  const input = scenario({ changes: [{ id: 1, price: 53, purchase: 50 }],
    candidates: [{ id: 101, position: 'GKP', xip: 6 }], priceSignals: { 1: signal(1) } });
  const keeper = playerOf(runDecisionEngine(input), 1);
  assert.equal(keeper.best.longterm.priceTerm, 0);
  assert.ok(!keeper.flags.includes('priceFall'), 'the fall costs him nothing');
  assert.equal(keeper.best.longterm.why.price, null);
});

test('a price signal estimated from transfers is flagged so, only on the lines it gives', () => {
  const changes = [{ id: 1, price: 52, purchase: 50 }];
  const candidates = [{ id: 101, position: 'GKP', xip: 6 }];
  const estimated = playerOf(runDecisionEngine(scenario({ changes, candidates,
    priceSignals: { 1: { fall: 1, rise: 0, source: 'estimate' } } })), 1);
  assert.equal(estimated.priceSource, 'estimate');
  assert.match(estimated.best.longterm.why.price, /Estimated from this week/);
  // FPL's line for the seller; the buy's estimate gives no line of its own.
  const mixed = playerOf(runDecisionEngine(scenario({ changes, candidates,
    priceSignals: { 1: signal(1), 101: { fall: 0, rise: 0.5, source: 'estimate' } } })), 1);
  assert.equal(mixed.priceSource, 'fpl');
  assert.doesNotMatch(mixed.best.longterm.why.price, /Estimated/);
});

test('a price signal without numeric chances reads as no move expected', () => {
  // The shape before Phase 5, { fallLikely }, among them.
  const result = runDecisionEngine(scenario({ candidates: [LATE_KEEPER],
    priceSignals: { 1: { fallLikely: true }, 101: { rise: 'soon' } } }));
  for (const move of allBest(result)) assert.ok(Number.isFinite(move.outScore), `${move.mode} ${move.outScore}`);
  assert.equal(playerOf(result, 1).best.longterm.priceTerm, 0);
  assert.equal(result.modes.future.call, 'wait');
  assert.ok(Number.isFinite(result.modes.future.deferral.laterScore));
});

test('a likely fall that lowers his sell price makes selling now worth lambda x £0.1m more; a rise that lifts it, less', () => {
  // Bought at £5.0m, now £5.2m: he sells for £5.1m, and for £5.0m after a fall.
  const changes = [{ id: 1, price: 52, purchase: 50 }];
  const candidates = [{ id: 101, position: 'GKP', xip: 6 }];
  const without = playerOf(runDecisionEngine(scenario({ changes, candidates })), 1).best.longterm;
  const falling = playerOf(runDecisionEngine(scenario({ changes, candidates, priceSignals: { 1: signal(1) } })), 1);
  close(falling.best.longterm.priceTerm, -0.3 * 0.1);
  close(falling.best.longterm.outScore, without.outScore + 0.03);
  assert.match(falling.best.longterm.why.price, /fall/);
  assert.ok(falling.flags.includes('priceFall'));
  close(falling.best.now.priceTerm, 0, 'Now puts no value on money');
  // At £5.3m a rise to £5.4m lifts his sell price from £5.1m to £5.2m.
  const rising = playerOf(runDecisionEngine(scenario({ changes: [{ id: 1, price: 53, purchase: 50 }], candidates,
    priceSignals: { 1: signal(0, 1) } })), 1);
  close(rising.best.longterm.priceTerm, 0.3 * 0.1);
  assert.ok(rising.flags.includes('priceRise'));
});

test('Structure does not hold a recovering player whose sell price is likely to fall first', () => {
  // The hold case above, with DEF 5's price about to fall.
  const recovering = { id: 5, price: 60, pz: [0.5, 0.15, 0.045, 0.0135, 0.004, 0.0012],
    av: [0.5, 0.85, 0.955, 0.9865, 0.996, 0.9988] };
  const base = { candidates: [{ id: 116, position: 'DEF', xip: 4, price: 55 }], priceSignals: { 5: signal(1) } };
  const result = runDecisionEngine(scenario({ ...base, changes: [recovering] }));
  assert.ok(!playerOf(result, 5).flags.includes('hold'));
  assert.equal(result.modes.structure.root?.outId, 5);
  // Bought at £5.7m, he sells for £5.8m at £6.0m and still at £5.9m: held.
  const oddTenths = runDecisionEngine(scenario({ ...base, changes: [{ ...recovering, purchase: 57 }] }));
  assert.ok(playerOf(oddTenths, 5).flags.includes('hold'));
});

test('at five banked free transfers money alone moves no mode but Funds, and Funds only for £0.5m or more', () => {
  // Keeper 101 projects exactly what keeper 1 does and costs £0.3m less.
  const same = { id: 101, position: 'GKP', xip: 4, price: 47 };
  const result = runDecisionEngine(scenario({ candidates: [same], freeTransfers: 5 }));
  for (const mode of MODES) assert.equal(result.modes[mode].call, 'roll', mode);
  assert.ok(playerOf(result, 1).best.future.outScore > 0, 'it clears Q7\'s threshold on money alone');
  // £0.6m freed is worth a free transfer that would otherwise be wasted - to Funds.
  const cheaper = runDecisionEngine(scenario({ candidates: [{ ...same, price: 44 }], freeTransfers: 5 }));
  assert.equal(cheaper.modes.funds.call, 'move');
  assert.equal(cheaper.modes.future.call, 'roll');
});

test('Future prep waits when the same move made next week scores within epsilon', () => {
  const input = scenario({ candidates: [LATE_KEEPER] });
  const future = runDecisionEngine(input).modes.future;
  assert.equal(future.call, 'wait');
  assert.equal(future.root.inId, 101);
  assert.deepEqual(Object.keys(future.deferral).sort(), ['epsilon', 'gw', 'laterScore']);
  assert.equal(future.deferral.gw, GW + 1);
  // Over the same five GWs, the later move gives up the planning GW's gain
  // and nothing else: the two weeks make one transfer and bank the same free
  // transfers, so its cost is the same either way.
  assert.ok(future.root.perGw[0] > 0);
  close(future.deferral.laterScore, future.root.outScore - future.root.perGw[0]);
  assert.equal(future.deferral.epsilon, DECISION_ENGINE.modes.future.deferralEpsilon);
  // Money freed counts only for the GWs the later move covers: all but the
  // planning GW's 0.5 of 4.25.
  const cheaper = runDecisionEngine(scenario({ candidates: [{ ...LATE_KEEPER, price: 45 }] })).modes.future;
  assert.equal(cheaper.call, 'wait');
  close(cheaper.deferral.laterScore,
    cheaper.root.outScore - cheaper.root.perGw[0] - (cheaper.root.fundsTerm * (0.5 / 4.25)));

  // A waiting mode sells nobody yet.
  const futureOnly = { ...DECISION_ENGINE, modes: Object.fromEntries(Object.entries(DECISION_ENGINE.modes)
    .map(([id, m]) => [id, id === 'future' ? m : { ...m, threshold: Infinity }])) };
  assert.ok(!playerOf(runDecisionEngine(input, futureOnly), 1).flags.includes('sell'));
});

test('at five banked free transfers Future prep never waits: rolling would waste one', () => {
  const input = scenario({ candidates: [LATE_KEEPER], freeTransfers: 5 });
  const future = runDecisionEngine(input).modes.future;
  assert.equal(future.call, 'move');
  assert.equal(future.deferral, null);
});

test('with no free transfer banked, waiting turns this week\'s hit into next week\'s free transfer', () => {
  // DEF 3 projects 5; DEF 116 projects 7, 2 a GW better: over the five GWs the move clears the hit now
  // (4.25 x 2 - 6), and waiting gives up only the planning GW's 0.5 x 2 to make the 6-point hit a 1.5 free transfer.
  const future = runDecisionEngine(scenario({ candidates: [{ id: 116, position: 'DEF', xip: 7 }],
    freeTransfers: 0 })).modes.future;
  assert.equal(future.call, 'wait');
  close(future.deferral.laterScore - future.root.outScore,
    transferCost(0) - transferCost(1) - future.root.perGw[0]);
  // DEF 116 at 12 a GW takes the armband: this week's gain (0.5 x 14) outweighs the 4.5 that waiting saves, so it
  // moves now. On the averaged scale (÷ 4.25) the same week counted for 1.6 and the mode waited.
  const big = runDecisionEngine(scenario({ candidates: [{ id: 116, position: 'DEF', xip: 12 }],
    freeTransfers: 0 })).modes.future;
  assert.equal(big.call, 'move');
  assert.ok(big.root.perGw[0] > transferCost(0) - transferCost(1), `${big.root.perGw[0]}`);
});

test('Future prep never waits when no later GW counts: the season\'s last, or a Wildcard next week', () => {
  // Keeper 101 is 3 points a GW better: only the planning GW counts, a small
  // move at 4 FTs. However wide the epsilon, there is nothing to wait for.
  const keeper = { candidates: [{ id: 101, position: 'GKP', xip: 7 }], freeTransfers: 4 };
  const wide = { ...DECISION_ENGINE, modes: { ...DECISION_ENGINE.modes,
    future: { ...DECISION_ENGINE.modes.future, deferralEpsilon: 10 } } };
  const last = runDecisionEngine(scenario({ ...keeper, planningGw: SEASON_GWS }), wide).modes.future;
  assert.equal(last.call, 'move');
  assert.equal(last.deferral, null);
  const wildcard = runDecisionEngine(scenario({ ...keeper, chipPlan: { [GW + 1]: 'wildcard' } }), wide).modes.future;
  assert.equal(wildcard.call, 'move');
});

test('with a Free Hit next week, Future prep\'s wait is for the GW after it', () => {
  // Keeper 101 gains half a point now and three a GW from GW+2.
  const future = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: [4.5, 6, 7, 7, 7, 7] }],
    chipPlan: { [GW + 1]: 'freehit' } })).modes.future;
  assert.equal(future.call, 'wait');
  assert.equal(future.deferral.gw, GW + 2);
});

test('a steady gain is made now: waiting would give up the planning GW\'s share of it', () => {
  // Keeper 101 is 2 points a GW better every week.
  const future = runDecisionEngine(scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }] })).modes.future;
  assert.equal(future.call, 'move');
  assert.equal(future.deferral, null);
});

test('Future prep does not wait when a likely price move would put the buy out of reach', () => {
  // Keeper 101 costs £5.0m: keeper 1's sale and an empty bank pay for it, just.
  const base = { candidates: [LATE_KEEPER] };
  const call = input => runDecisionEngine(scenario({ ...base, ...input })).modes.future.call;
  assert.equal(call({ priceSignals: { 101: signal(0, 1) } }), 'move', 'the buy is about to rise');
  assert.equal(call({ priceSignals: { 1: signal(1) } }), 'move', 'the sale is about to fall');
  assert.equal(call({ priceSignals: { 101: signal(0, 0.5) } }), 'wait', 'a rise is not likely');
  assert.equal(call({ bankTenths: 1, priceSignals: { 101: signal(0, 1) } }), 'wait', 'still affordable after it');

  // With the sale about to fall but q still within reach, waiting costs the
  // planning GW's gain and the fall once - today's PriceTerm - not again in
  // next week's money.
  const future = runDecisionEngine(scenario({ ...base, bankTenths: 1, priceSignals: { 1: signal(1) } })).modes.future;
  assert.equal(future.call, 'wait');
  close(future.root.outScore - future.deferral.laterScore, future.root.perGw[0] - future.root.priceTerm);
});

test('Now waits for team news when a flagged player is in its move, the press conferences are ahead and no price move is due', () => {
  // DEF 5 is 50% now; DEF 116 is a better buy either way.
  const base = { changes: [{ id: 5, pz: 0.5, av: 0.5 }], candidates: [{ id: 116, position: 'DEF', xip: 9 }] };
  const now = input => runDecisionEngine(scenario({ ...base, ...input })).modes.now;
  const early = now({ hoursToDeadline: 48 });
  assert.equal(early.call, 'move');
  assert.equal(early.root.outId, 5);
  assert.equal(early.waitForNews, true);
  assert.equal(now({ hoursToDeadline: 12 }).waitForNews, false, 'the press conferences are done');
  assert.equal(now({}).waitForNews, false, 'no deadline to go by');
  assert.equal(now({ hoursToDeadline: 48, priceSignals: { 5: signal(1) } }).waitForNews, false,
    'his sell price is about to fall');
  assert.equal(now({ hoursToDeadline: 48, priceSignals: { 116: signal(0, 1) } }).waitForNews, false,
    'the buy is about to rise');
});

// ─── The V cache and the presets ─────────────────────────────────────────────

test('a warm cache gives exactly the cold result after a lock, a ban, a bank, an FT or a chip change', () => {
  const input = fillerScenario({ bankTenths: 5 });
  const cache = createDecisionCache();
  runDecisionEngine(input, DECISION_ENGINE, cache);
  const changes = [{ locks: new Set([4]) }, { bans: new Set([103]) }, { bankTenths: 20 },
    { freeTransfers: 0 }, { freeTransfers: 5 }, { chipPlan: { [GW + 1]: 'benchboost' } }];
  for (const change of changes) {
    const next = { ...input, ...change };
    assert.deepEqual(runDecisionEngine(next, DECISION_ENGINE, cache), runDecisionEngine(next),
      Object.keys(change).join());
  }
});

test('a warm cache matches a cold one when the planning GW and a planned chip move on together', () => {
  // Projections for GW10-16, so both planning GWs have their six.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6.5 }] });
  const projections = new Map([...input.projections].map(([id, p]) =>
    [id, { ...p, gws: [...p.gws, { ...p.gws.at(-1), gw: p.gws.at(-1).gw + 1 }] }]));
  const run = (planningGw, cache) => runDecisionEngine(
    { ...input, projections, planningGw, chipPlan: { [planningGw + 2]: 'benchboost' } }, DECISION_ENGINE, cache);
  const cache = createDecisionCache();
  run(GW, cache);
  assert.deepEqual(run(GW + 1, cache), run(GW + 1, createDecisionCache()));
});

test('moving a planned Bench Boost keeps the V values of every other week', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6.5 }] });
  const cache = createDecisionCache();
  runDecisionEngine({ ...input, chipPlan: { [GW + 2]: 'benchboost' } }, DECISION_ENGINE, cache);
  const before = cache.values.size;
  runDecisionEngine({ ...input, chipPlan: { [GW + 3]: 'benchboost' } }, DECISION_ENGINE, cache);
  assert.ok(cache.values.size > before, `${cache.values.size} values after, ${before} before`);
});

test('every mode preset must weigh the same number of GWs', () => {
  const short = { ...DECISION_ENGINE, modes: { ...DECISION_ENGINE.modes,
    now: { ...DECISION_ENGINE.modes.now, weights: [1, 0, 0] } } };
  assert.throws(() => runDecisionEngine(scenario(), short), /same number of GWs/);
});

// ─── Performance (plan risk 6) ───────────────────────────────────────────────

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a full run takes well under 5 s on a 600-player pool, and a lock or ban re-run under 200 ms', () => {
  const random = seeded(3);
  const positions = ['GKP', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD'];
  // Prices skewed cheap like FPL's (median about £5.4m, up to £15.0m).
  const candidates = Array.from({ length: 600 }, (_, i) => ({
    id: 1000 + i, position: positions[i % positions.length], team: 1 + (i % 20),
    price: 40 + Math.round((random() ** 3) * 110), xip: 1 + Math.round(random() * 18) / 2,
    pz: [0, 0, 0.05, 0.2, 0.5][Math.floor(random() * 5)],
  }));
  // Real squad prices, so Funds has downgrades to chain and the lock re-run
  // searches new second moves.
  const prices = [50, 40, 62, 55, 45, 50, 40, 125, 95, 80, 70, 50, 140, 75, 45];
  const changes = BASE.map((s, i) => ({ id: s.id, price: prices[i] }));
  const input = scenario({ changes, candidates, bankTenths: 20, freeTransfers: 2 });
  const cache = createDecisionCache();

  let start = performance.now();
  const first = runDecisionEngine(input, DECISION_ENGINE, cache);
  const cold = performance.now() - start;
  assert.ok(first.players.some(p => p.best.funds?.chained), 'the pool exercises the chain search');
  start = performance.now();
  runDecisionEngine({ ...input, locks: new Set([13]), bans: new Set([1003, 1004]) }, DECISION_ENGINE, cache);
  const warm = performance.now() - start;

  assert.ok(cold < 5000, `full run ${cold.toFixed(0)} ms`);
  assert.ok(warm < 200, `lock/ban re-run ${warm.toFixed(0)} ms`);
});
