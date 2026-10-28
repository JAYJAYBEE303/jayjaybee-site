/**
 * tests/engine/solver/rescore.test.js
 * Robustness as re-scoring (js/engine/solver/rescore.js; docs/decision-engine-solver-plan.md §1): under the engine's
 * seeded noisy copies of its input, how often the solver's pick scores best against its alternatives, on the engine's
 * own squad value; and the second message kind of the robustness worker, which runs it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DECISION_ENGINE } from '../../../js/config.js';
import { runDecisionEngine } from '../../../js/engine/decision.js';
import { robustness } from '../../../js/engine/robustness.js';
import { handle } from '../../../js/engine/robustness-worker.js';
import { moveSetKey } from '../../../js/engine/solver/plan.js';
import * as rescore from '../../../js/engine/solver/rescore.js';
import { scenario } from '../decision-fixtures.js';
import { CONFIG } from './fixtures.js';

const { pickBeatsAlternatives } = rescore;

/** A candidate: one sale and the buy that replaces him. */
const swap = (outId, inId) => ({ key: moveSetKey([{ outId, inId }]), moves: [{ outId, inId }] });
const ROLL = { key: '', moves: [] };
const weightsOf = (input, modeId) => runDecisionEngine(input, CONFIG).modes[modeId].weights;
const share = (input, modeId, candidates, pick, config = CONFIG) =>
  pickBeatsAlternatives(input, config, modeId, weightsOf(input, modeId), candidates, pick.key);
/** No noise at all: every copy is the input itself, so a share is 0 or 1 and the terms can be pinned exactly. */
const STILL = { ...CONFIG, robustnessNoise: { xpts: 0, pZero: 0, ftValue: 0, decay: 0 } };

test('a pick that dominates scores 1; rolling against a clearly better move scores 0', () => {
  // Keeper 101 is six points a GW better than keeper 1; 102 is half a point better.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 10 }, { id: 102, position: 'GKP', xip: 4.5 }] });
  const best = swap(1, 101);
  assert.equal(share(input, 'longterm', [best, swap(1, 102), ROLL], best), 1);
  assert.equal(share(input, 'longterm', [ROLL, best], ROLL), 0);
});

test('the same seed gives the same share', () => {
  // Keepers 101 and 102 project the same: the noise decides between them, so the share is neither 0 nor 1.
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 6 }] });
  const [a, b] = [swap(1, 101), swap(1, 102)];
  const first = share(input, 'longterm', [a, b], a);
  assert.ok(first > 0 && first < 1, `share ${first}`);
  assert.equal(share(input, 'longterm', [a, b], a), first);
  assert.ok(first + share(input, 'longterm', [a, b], b) >= 1, 'each copy has a best, so the two shares cover the copies');
});

test('duplicate candidates count once', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 6 }] });
  const [a, b] = [swap(1, 101), swap(1, 102)];
  const once = share(input, 'longterm', [a, b, ROLL], a);
  assert.ok(once > 0 && once < 1, `share ${once}`);
  // The same candidate again, however often, changes nothing.
  assert.equal(share(input, 'longterm', [a, b, ROLL, { ...a }, { ...b }, ROLL, a], a), once);
});

test('a pick that is not among the candidates is refused', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }] });
  assert.throws(() => share(input, 'now', [ROLL], swap(1, 101)), /not among/);
});

test('a second move past the free transfer must earn its hit', () => {
  // One free transfer. Keeper 101 is six points a GW better than keeper 1; DEF 103 is `better` a GW better than DEF 6.
  const run = better => {
    const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 10 }, { id: 103, position: 'DEF', xip: 3 + better }] });
    const one = swap(1, 101);
    const moves = [...one.moves, { outId: 6, inId: 103 }];
    return share(input, 'longterm', [one, { key: moveSetKey(moves), moves }], one, STILL);
  };
  // Long term weighs three GWs: 3 x 1 = 3 points is short of the 4-point hit, 3 x 1.5 = 4.5 clears it.
  assert.equal(run(1), 1);
  assert.equal(run(1.5), 0);
});

test('rolling banks a free transfer, which a single move gives up', () => {
  // Now weighs only this GW. A move gaining 1.2 does not make up the 1.5 a second banked transfer is worth; 1.8 does.
  const run = (gain, config) => {
    const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 4 + gain }] });
    return share(input, 'now', [swap(1, 101), ROLL], swap(1, 101), config);
  };
  assert.equal(run(1.2, STILL), 0);
  assert.equal(run(1.8, STILL), 1);
  // The flat mode prices each banked transfer at 1.75, so 1.6 is not enough there but is under the schedule's 1.5.
  assert.equal(run(1.6, STILL), 1);
  assert.equal(run(1.6, { ...STILL, ftValueMode: 'flat' }), 0);
});

// ─── Weeks that weigh nothing, and the chips planned in the weeks that do ────

/** The same input with some gameweeks missing from every projection. */
const withoutGws = (input, missing) => ({ ...input, projections: new Map([...input.projections].map(([id, projection]) =>
  [id, { ...projection, gws: projection.gws.filter(g => !missing(g.gw)) }])) });

test('a Free Hit week weighs nothing and needs no projection', () => {
  // Long term weighs GW10-12; the engine masks the Free Hit week (GW12). Its projections are gone: squadValue throws for
  // a week it cannot find, so a share comes back only if the week is skipped.
  const full = scenario({ chipPlan: { 12: 'freehit' }, candidates: [{ id: 101, position: 'GKP', xip: 10 }] });
  const weights = weightsOf(full, 'longterm');
  assert.deepEqual(weights.slice(0, 3), [1, 1, 0]);
  const input = withoutGws(full, gw => gw === 12);
  const best = swap(1, 101);
  const answer = pickBeatsAlternatives(input, CONFIG, 'longterm', weights, [best, ROLL], best.key);
  assert.ok(Number.isFinite(answer));
  assert.equal(answer, 1);
});

test('weeks past the season\'s end weigh nothing and need no projection', () => {
  // Planning GW37: GW39 on is masked. Projections stop at GW38.
  const full = scenario({ planningGw: 37, candidates: [{ id: 101, position: 'GKP', xip: 10 }] });
  const weights = weightsOf(full, 'longterm');
  assert.deepEqual(weights.slice(0, 3), [1, 1, 0]);
  const input = withoutGws(full, gw => gw > 38);
  const best = swap(1, 101);
  const answer = pickBeatsAlternatives(input, CONFIG, 'longterm', weights, [best, ROLL], best.key);
  assert.ok(Number.isFinite(answer));
  assert.equal(answer, 1);
});

test('a planned Bench Boost counts the bench in the week it is planned', () => {
  // A 2.9-point defender for the bench's 1 stays on the bench (DEF 6 has 3): the week gains nothing, so the move loses
  // to rolling's banked transfer; under Bench Boost the week gains 1.9, which wins.
  const candidates = [{ id: 101, position: 'DEF', xip: 2.9 }];
  const run = chipPlan => {
    const input = scenario({ chipPlan, candidates });
    return share(input, 'now', [swap(7, 101), ROLL], swap(7, 101), STILL);
  };
  assert.equal(run({}), 0);
  assert.equal(run({ 10: 'benchboost' }), 1);
});

test('the copies move the free transfer\'s value, so a move worth exactly its schedule value wins some and loses some', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 5.5 }] });
  const onlyFt = { ...STILL, robustnessNoise: { ...STILL.robustnessNoise, ftValue: CONFIG.robustnessNoise.ftValue } };
  const wins = share(input, 'now', [swap(1, 101), ROLL], swap(1, 101), onlyFt);
  assert.ok(wins > 0 && wins < 1, `share ${wins}`);
});

test('the label is pickBeatsAlternatives, not a confidence', () => {
  assert.deepEqual(Object.keys(rescore), ['pickBeatsAlternatives']);
  assert.equal(pickBeatsAlternatives.name, 'pickBeatsAlternatives');
  const source = readFileSync(new URL('../../../js/engine/solver/rescore.js', import.meta.url), 'utf8');
  const header = source.slice(0, source.indexOf('*/')).replace(/\s*\n\s*\*\s?/g, ' ');
  assert.match(header, /how often the pick beats these alternatives under noise, not how often a fresh solve would choose it/);
});

// ─── The robustness worker's second message kind ─────────────────────────────

test('the robustness worker answers a rescore message with its key and the share, and the old message as before', () => {
  const input = scenario({ candidates: [{ id: 101, position: 'GKP', xip: 6 }, { id: 102, position: 'GKP', xip: 6 }] });
  const [a, b] = [swap(1, 101), swap(1, 102)];
  const weights = weightsOf(input, 'longterm');
  const message = { kind: 'rescore', input, modeId: 'longterm', weights, candidates: [a, b, ROLL], pickKey: a.key, key: `${a.key}|7` };
  const share = pickBeatsAlternatives(input, DECISION_ENGINE, 'longterm', weights, [a, b, ROLL], a.key);
  // As postMessage hands it over.
  assert.deepEqual(handle(structuredClone(message)), { kind: 'rescore', key: `${a.key}|7`, share });

  const result = runDecisionEngine(input);
  assert.deepEqual(handle({ input, result: { shortlist: result.shortlist } }), robustness(input, DECISION_ENGINE, result));
});
