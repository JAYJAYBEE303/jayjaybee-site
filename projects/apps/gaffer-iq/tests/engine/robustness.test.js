/**
 * tests/engine/robustness.test.js
 * The robustness layer (docs/decision-engine-plan.md Phase 6): seeded noise on
 * the engine's input, the re-runs scored 3/2/1, and the shortlist of buys the
 * re-runs score.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seededRandom, normalDeviate } from '../../js/util.js';
import { runDecisionEngine } from '../../js/engine/decision.js';
import { noisyInput, robustness, withRobustness, moveKey } from '../../js/engine/robustness.js';
import { DECISION_ENGINE } from '../../js/config.js';
import { MODES, close, scenario } from './decision-fixtures.js';

// ─── Seeded noise ────────────────────────────────────────────────────────────

test('the seeded generator repeats its sequence for a seed, and another seed gives another', () => {
  const draw = seed => {
    const random = seededRandom(seed);
    return [random(), random(), random()];
  };
  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
  for (const x of draw(9)) assert.ok(x >= 0 && x < 1);
});

test('normal deviates have mean 0 and spread 1', () => {
  const random = seededRandom(3);
  const xs = Array.from({ length: 20000 }, () => normalDeviate(random));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + ((b - mean) ** 2), 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.03, `sd ${sd}`);
});

test('noise keeps xpts = (1 - pZero) x xptsIfPlays, and leaves blanks and certain chances alone', () => {
  // DEF 5 blanks in the second GW; DEF 6 is ruled out throughout; DEF 4 is a 30% doubt.
  const input = scenario({ changes: [{ id: 5, fx: [1, 0, 1, 1, 1, 1] }, { id: 6, pz: 1, av: 0 }, { id: 4, pz: 0.3 }] });
  const { input: noisy } = noisyInput(input, DECISION_ENGINE, seededRandom(1));
  let moved = 0;
  for (const [id, projection] of noisy.projections) {
    projection.gws.forEach((g, k) => {
      const before = input.projections.get(id).gws[k];
      assert.ok(Math.abs(g.xpts - ((1 - g.pZero) * g.xptsIfPlays)) < 1e-12, `player ${id} GW${g.gw}`);
      if (before.fixtures === 0) assert.deepEqual(g, before);
      if (before.pZero === 0 || before.pZero === 1) assert.equal(g.pZero, before.pZero);
      if (g.xptsIfPlays !== before.xptsIfPlays) moved++;
    });
    // One factor for all his GWs: a projection is off the same way all season.
    const factors = projection.gws.map((g, k) => g.xptsIfPlays / input.projections.get(id).gws[k].xptsIfPlays)
      .filter(Number.isFinite);
    for (const f of factors) close(f, factors[0]);
  }
  assert.ok(moved > 0);
  const doubt = noisy.projections.get(4).gws[0].pZero;
  assert.ok(doubt !== 0.3 && doubt > 0 && doubt < 1, `a doubt's chance moves but stays a chance: ${doubt}`);
  assert.equal(input.projections.get(1).gws[0].xptsIfPlays, 4, 'the input itself is left alone');
});

test('noise scales the free transfer\'s value by one factor and moves the decay, within range', () => {
  const { config } = noisyInput(scenario(), DECISION_ENGINE, seededRandom(2));
  const factor = config.ftValueFlat / DECISION_ENGINE.ftValueFlat;
  assert.notEqual(factor, 1);
  assert.ok(factor > 0);
  for (const [n, v] of Object.entries(config.ftValueSchedule)) close(v / DECISION_ENGINE.ftValueSchedule[n], factor);
  assert.notEqual(config.decayBase, DECISION_ENGINE.decayBase);
  assert.ok(config.decayBase >= 0 && config.decayBase <= 1);
});

// ─── Robustness ──────────────────────────────────────────────────────────────

test('a dominant move is robust: it tops nearly every run', () => {
  // Keeper 101 is six points a GW better than keeper 1; nothing else is close.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 10 }, { id: 102, position: 'GKP', xip: 4.5 }] });
  const result = runDecisionEngine(input);
  const share = robustness(input, DECISION_ENGINE, result).now.get(moveKey(result.modes.now.root));
  assert.ok(share >= 0.9, `robustness ${share}`);
});

test('second place earns two points of the three first place does', () => {
  // Selling either keeper for 101 scores the same: one twin is first, the other second.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 10 }, { id: 102, position: 'GKP', xip: 4.5 }] });
  const result = runDecisionEngine(input);
  const second = robustness(input, DECISION_ENGINE, result).now.get(moveKey(result.modes.now.alternatives[0]));
  assert.ok(second > 0.5 && second < 0.75, `second ${second}`);
});

test('a run\'s top three score however far behind the best they are', () => {
  // Buying keeper 101 (either keeper out) is four points clear of buying 102:
  // too far back to show as an alternative, yet third in most runs.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 10 }, { id: 102, position: 'GKP', xip: 7 }] });
  const result = runDecisionEngine(input);
  assert.ok(!result.modes.now.alternatives.some(a => a.inId === 102));
  const shares = robustness(input, DECISION_ENGINE, result).now;
  const third = (shares.get('1>102') ?? 0) + (shares.get('2>102') ?? 0);
  assert.ok(third > 0.25, `third ${third}`);
});

test('two near-identical moves split the top spot between them', () => {
  // Keepers 101 and 102 project the same: the noise decides between them.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 6 }] });
  const result = runDecisionEngine(input);
  const now = result.modes.now;
  const shares = robustness(input, DECISION_ENGINE, result).now;
  const [a, b] = [now.root, now.alternatives[0]].map(m => shares.get(moveKey(m)));
  assert.ok(Math.abs(a - b) < 0.15, `${a} vs ${b}`);
  assert.ok(Math.max(a, b) < 0.95, `${a} vs ${b}`);
});

test('the same input and seed give the same robustness', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 6 }] });
  const result = runDecisionEngine(input);
  const flat = shares => MODES.map(m => [...(shares[m] ?? new Map())].sort());
  assert.deepEqual(flat(robustness(input, DECISION_ENGINE, result)), flat(robustness(input, DECISION_ENGINE, result)));
});

test('withRobustness gives each mode\'s move and alternatives their share; a roll gets none', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 6 }] });
  const result = runDecisionEngine(input);
  const shares = robustness(input, DECISION_ENGINE, result);
  const rated = withRobustness(result, shares);
  assert.equal(rated.modes.now.robustness, shares.now.get(moveKey(result.modes.now.root)));
  rated.modes.now.alternatives.forEach(a => assert.equal(a.robustness, shares.now.get(moveKey(a)) ?? 0));
  assert.equal(result.modes.now.robustness, null, 'the result it was given is left alone');
  // Funds counts only downgrades that free money, and none does here: it rolls.
  assert.equal(rated.modes.funds.call, 'roll');
  assert.equal(rated.modes.funds.robustness, null);
});

// ─── The shortlist the re-runs score ─────────────────────────────────────────

const NARROW = { ...DECISION_ENGINE, robustnessShortlist: 1 };

test('the re-runs score the buys of every mode\'s best moves, not every candidate', () => {
  // DEF 104 is a small upgrade, behind keeper 101 in every mode, but the best
  // replacement for every defender: Ceiling's lock values need him.
  const candidates = [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 5.5 },
    { id: 103, position: 'GKP', xip: 4.2 }, { id: 104, position: 'DEF', xip: 3.5 }];
  const { shortlist } = runDecisionEngine(scenario({ candidates }), NARROW);
  assert.deepEqual(shortlist.sort(), [101, 104]);
  assert.deepEqual(runDecisionEngine(scenario({ candidates })).shortlist.sort(), [101, 102, 103, 104]);
});

test('the shortlist keeps the second buy a downgrade pays for', () => {
  // Funds' move frees the money for FWD 111, a buy no single move can afford.
  const { shortlist } = runDecisionEngine(scenario({
    changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }],
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }],
    freeTransfers: 2,
  }), NARROW);
  assert.ok(shortlist.includes(109) && shortlist.includes(111), `${shortlist}`);
});

test('the re-runs buy only from the shortlist', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 5.5 }] });
  const shares = robustness(input, NARROW, runDecisionEngine(input, NARROW));
  const keys = MODES.flatMap(m => [...(shares[m]?.keys() ?? [])]);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.match(key, />101$/);
});
