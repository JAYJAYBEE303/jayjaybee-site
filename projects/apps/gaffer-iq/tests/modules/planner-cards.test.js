/**
 * tests/modules/planner-cards.test.js
 * The Planner's mode card as markup (js/modules/planner.js: modeCardHTML), with no DOM: the card the single-move engine
 * makes, byte for byte as it was before the solver (fixtures/planner-cards-solver-off.json, captured from the code
 * before the solver's states were added), and the cards the solver's runner makes - refining, updated, with several
 * moves, with a figure still calculating, with the later weeks of the plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DECISION_ENGINE } from '../../js/config.js';
import { store } from '../../js/store.js';
import { createDecisionCache, describePlan, runDecisionEngine } from '../../js/engine/decision.js';
import { withRobustness } from '../../js/engine/robustness.js';
import { orderMoves, solverCard, withFigure } from '../../js/engine/solver/plan.js';
import { modeCardHTML } from '../../js/modules/planner.js';
import { GW, projectionOf, scenario, withDraws } from '../engine/decision-fixtures.js';

const SOLVER_OFF = JSON.parse(readFileSync(new URL('./fixtures/planner-cards-solver-off.json', import.meta.url), 'utf8'));

// ─── The engine's cards, as they were ────────────────────────────────────────

function doubleAt(input, id, k = 0) {
  const projections = new Map(input.projections);
  const p = projections.get(id) ?? projectionOf({ id, position: 'MID', team: id, price: 50, xip: 1 }, input.planningGw);
  projections.set(id, { ...p, gws: p.gws.map((g, i) => (i === k ? { ...g, fixtures: 2, draw: g.draw } : g)) });
  return { ...input, projections };
}
const UPSIDE = () => withDraws(scenario({ candidates: [
  { id: 101, position: 'FWD', xip: 8 }, { id: 102, position: 'FWD', xip: 7.9 }] }), { 102: { goals: 3, share: 0.5 } });

/** The scenarios the snapshot covers: moves with alternatives, robustness and an open list, rolls of each reason, a
 *  wait, team news, a blank week, an estimated sell price, Ceiling's tail. */
const CASES = {
  moves: { input: scenario({ bankTenths: 5, candidates: [
    { id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'MID', xip: 9, price: 55 },
    { id: 103, position: 'DEF', xip: 8, price: 45 }, { id: 104, position: 'GKP', xip: 6, price: 40 },
    { id: 105, position: 'FWD', xip: 11.5 }, { id: 107, position: 'FWD', xip: 11.2 }, { id: 106, position: 'MID', xip: 8.5, price: 50 }] }),
  shares: true, open: ['now', 'longterm'], lock: [15], ban: [101] },
  rolls: { input: scenario({ freeTransfers: 0, candidates: [{ id: 101, position: 'FWD', xip: 9 }] }) },
  rollsFt: { input: scenario({ freeTransfers: 2, candidates: [{ id: 101, position: 'FWD', xip: 5.5 }] }) },
  covered: { input: scenario({ chipPlan: { [GW]: 'wildcard' }, candidates: [{ id: 101, position: 'FWD', xip: 12 }] }) },
  wait: { input: scenario({ candidates: [{ id: 101, position: 'GKP', xip: [4.5, 6, 6, 6, 6, 6] }] }) },
  news: { input: scenario({ changes: [{ id: 5, pz: 0.5, av: 0.5 }], candidates: [{ id: 116, position: 'DEF', xip: 9 }], hoursToDeadline: 48 }) },
  blank: { input: scenario({ changes: [{ id: 9, fx: 0 }, { id: 8, purchase: null }], candidates: [{ id: 117, position: 'MID', xip: 9 }] }) },
  estimated: { input: scenario({ changes: [{ id: 15, purchase: null, price: 52 }], candidates: [{ id: 117, position: 'FWD', xip: 9 }] }) },
  tail: { input: doubleAt(UPSIDE(), 3), shares: true },
  tailPlan: { input: { ...UPSIDE(), chipPlan: { [GW]: 'benchboost' } } },
};

/** The store as a page holds it for an input: every squad player and candidate, on a team of his own. */
function load(input) {
  const players = [
    ...input.squad.map(s => ({ id: s.playerId, name: s.name, position: s.position, teamId: s.teamId, price: s.priceTenths / 10 })),
    ...input.candidates,
  ];
  const teamsById = Object.fromEntries(players.map(p => [p.teamId, { id: p.teamId, shortName: `T${p.teamId}`, badgeUrl: null }]));
  store.setSeason({ players, playersById: Object.fromEntries(players.map(p => [p.id, p])), teamsById, events: [] });
}

const settingsOf = input => ({ bankTenths: input.bankTenths, freeTransfers: input.freeTransfers, chipPlan: input.chipPlan, used: {} });

/** The solver off, whatever the tracked config says: the cards below it are the single-move engine's. */
const OFF = { ...DECISION_ENGINE, solver: { ...DECISION_ENGINE.solver, enabled: false } };

test('modeCardHTML with the solver off is unchanged', () => {
  assert.deepEqual(Object.keys(SOLVER_OFF), Object.keys(CASES));
  for (const [name, c] of Object.entries(CASES)) {
    load(c.input);
    let result = runDecisionEngine(c.input, OFF);
    if (c.shares) {
      result = withRobustness(result, Object.fromEntries(Object.entries(result.modes).map(([m, mode]) =>
        [m, new Map([...(mode.root ? [mode.root] : []), ...mode.alternatives].map((mv, i) => [`${mv.outId}>${mv.inId}`, 0.9 - (i * 0.3)]))])));
    }
    const html = Object.values(result.modes).map((mode, i) =>
      modeCardHTML(mode, i, settingsOf(c.input), c.input.planningGw, {
        players: result.players, locks: new Set(c.lock), bans: new Set(c.ban), openAlts: new Set(c.open),
      }));
    assert.deepEqual(html, SOLVER_OFF[name], name);
  }
});

// ─── The solver's cards ──────────────────────────────────────────────────────

const week = (gw, out = [], ins = []) => ({ gw, out, in: ins, hits: 0, ft: 1 });
const plan = (objective, ...weeks) => ({ objective, weeks });

/** The card the runner makes for a mode from a plan: the engine's mode with the solver's moves, as planner-solver.js builds it. */
function solverCardOf(engine, modeId, solved, over = {}) {
  const { input, result, cache } = engine;
  const call = solved.weeks[0].out.length ? 'move' : solved.weeks[1]?.out.length ? 'wait' : 'roll';
  const { moves } = orderMoves(input, result, call === 'wait' ? solved.weeks[1] : solved.weeks[0]);
  const describe = describePlan(input, DECISION_ENGINE, cache, modeId, moves);
  const positions = new Map([...input.squad.map(s => [s.playerId, s.position]), ...input.candidates.map(c => [c.id, c.position])]);
  return {
    ...solverCard(result.modes[modeId], { plan: solved, moves, describe, inputVersion: 1, positionOf: id => positions.get(id) }),
    state: 'ready', updated: false, ...over,
  };
}
const landed = (card, name, value) => withFigure(card, name, card.key, value);

function engineOf(input) {
  const cache = createDecisionCache();
  load(input);
  return { input, cache, result: runDecisionEngine(input, DECISION_ENGINE, cache) };
}

const CANDIDATES = [{ id: 101, position: 'FWD', xip: 12 }, { id: 102, position: 'FWD', xip: 11 }, { id: 105, position: 'FWD', xip: 10 }];
const pts = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`;
const html = (engine, card, state = {}) => modeCardHTML(card, 0, settingsOf(engine.input), engine.input.planningGw,
  { players: engine.result.players, showRobustness: false, ...state });
const count = (text, part) => text.split(part).length - 1;
const ENGINE = () => engineOf(scenario({ candidates: CANDIDATES }));
const sellsOne = (objective = 10) => plan(objective, week(GW, [15], [101]));

test('a pending gain shows the skeleton and "Still calculating", the card aria-busy', () => {
  const engine = ENGINE();
  const card = solverCardOf(engine, 'now', sellsOne());
  const pending = html(engine, card);
  assert.match(pending, /<li class="mc" data-mode="now" data-call="move" tabindex="-1" aria-busy="true" /);
  assert.match(pending, /<p class="mc__ev"><b class="num skeleton" aria-hidden="true">\+0\.0<\/b><span>Still calculating<\/span><\/p>/);
  assert.ok(!pending.includes('pts vs rolling</span></p><p class="mc__sum">Over'), 'no figure beside the skeleton');

  // Once the gain and the alternatives have landed there is nothing left to wait for.
  const done = html(engine, landed(landed(card, 'gain', 6), 'alternatives', []));
  assert.ok(!done.includes('aria-busy'));
  assert.ok(!done.includes('skeleton'));
  assert.match(done, /<p class="mc__ev"><b class="num">\+6\.0<\/b><span>pts vs rolling<\/span><\/p>/);

  // The alternatives are a figure too: their place keeps a skeleton of the real shape until they land.
  const gainOnly = html(engine, landed(card, 'gain', 6));
  assert.match(gainOnly, /aria-busy="true"/);
  // Built as the gain's is: the skeleton, and the words in the same muted label span - not bare text of another size.
  assert.match(gainOnly, /<p class="mc__ev"><span class="skeleton" aria-hidden="true">2 alternatives<\/span><span>Still calculating<\/span><\/p>/);
  assert.ok(!/<p class="mc__sum">[^<]*Still calculating/.test(gainOnly) && !/<\/span> Still calculating/.test(gainOnly), 'no bare "Still calculating"');
  assert.match(gainOnly, /<b class="num">\+6\.0<\/b><span>pts vs rolling<\/span>/);
});

test('a figure that could not be computed is not shown, and is not waited for', () => {
  const engine = ENGINE();
  const card = landed(landed(solverCardOf(engine, 'now', sellsOne()), 'gain', null), 'alternatives', null);
  const text = html(engine, card);
  assert.ok(!text.includes('mc__ev'));
  assert.ok(!text.includes('aria-busy'));
  assert.ok(!text.includes('mc__alts'));
});

test('the engine\'s card says Refining while the solver works, and the source of its move', () => {
  const engine = ENGINE();
  const mode = engine.result.modes.now;
  const refining = html(engine, { ...mode, source: 'engine', state: 'refining' });
  assert.match(refining, /aria-busy="true"/);
  assert.match(refining, /<\/p><div class="mc__tags"><p class="mc__tag">Refining<\/p><p class="mc__tag">Engine move<\/p><\/div><div class="mc__mv">/,
    'first after the header and the blurb, before the move');
  const ready = html(engine, { ...mode, source: 'engine', state: 'ready' });
  assert.ok(!ready.includes('aria-busy'));
  assert.ok(!ready.includes('Refining'));
  assert.match(ready, /<div class="mc__tags"><p class="mc__tag">Engine move<\/p><\/div>/);
  // The engine's own figures, as before.
  assert.ok(ready.includes(`<b class="num">${pts(mode.root.outScore)}</b><span>pts vs rolling</span>`));
  assert.match(html(engine, { ...mode, source: 'engine-tail', state: 'ready' }), /<p class="mc__tag">Engine move · upper tail<\/p>/);
  assert.match(html(engine, solverCardOf(engine, 'now', sellsOne())), /<p class="mc__tag">Solver plan<\/p>/);
  // A roll shows its source too, once the solver is on.
  const rolling = engineOf(scenario({ chipPlan: { [GW]: 'wildcard' }, candidates: CANDIDATES }));
  assert.match(html(rolling, { ...rolling.result.modes.now, source: 'engine', state: 'ready' }), /data-call="roll"[^>]*>.*<p class="mc__tag">Engine move<\/p>.*<p class="mc__call">Roll<\/p>/);
});

test('"Updated" names the engine\'s move the solver\'s plan replaced, until the next input change', () => {
  const engine = ENGINE();
  const replaced = engine.result.modes.now.root;
  const card = solverCardOf(engine, 'now', plan(10, week(GW, [14], [102])), { updated: true, replaced });
  assert.match(html(engine, card), /<p class="mc__note">Updated: the solver’s plan replaced the engine’s move \(sell P15 → buy P101\)\.<\/p>/);
  assert.ok(!html(engine, { ...card, updated: false }).includes('Updated'));
  // A Funds move with the second move it pays for: the note names both.
  const funds = engineOf(scenario({ changes: [{ id: 10, price: 80 }, { id: 14, price: 60 }], freeTransfers: 2,
    candidates: [{ id: 109, position: 'MID', xip: 5.9 }, { id: 111, position: 'FWD', xip: 10, price: 90 }] }));
  const chained = funds.result.modes.funds.root;
  assert.ok(chained.chained);
  assert.match(html(funds, solverCardOf(funds, 'funds', plan(10, week(GW, [10], [109])), { updated: true, replaced: chained })),
    /replaced the engine’s move \(sell P10 → buy P109, sell P14 → buy P111\)\./);
  // The engine rolled: there was no move to name.
  assert.match(html(engine, { ...card, replaced: null }), /replaced the engine’s move \(roll\)\./);
});

test('"Updated" says the plan makes the move now when it is the move the engine would wait for', () => {
  const engine = engineOf(CASES.wait.input);
  const { future } = engine.result.modes;
  assert.equal(future.call, 'wait');
  const { outId, inId } = future.root;
  const note = /<p class="mc__note">Updated: the solver’s plan makes now the move the engine would wait for\.<\/p>/;
  const now = solverCardOf(engine, 'future', plan(10, week(GW, [outId], [inId])), { updated: true, replaced: future.root, engineCall: 'wait' });
  assert.equal(now.call, 'move');
  assert.match(html(engine, now), note);
  assert.ok(!html(engine, now).includes('replaced the engine’s move'), 'it is the card\'s own move, not one it replaced');
  // A different move now still replaces the engine's, wait or not; and a card that carries no engine call reads as it did.
  const other = solverCardOf(engine, 'future', plan(10, week(GW, [outId === 1 ? 2 : 1], [inId])), { updated: true, replaced: future.root, engineCall: 'wait' });
  assert.match(html(engine, other), /replaced the engine’s move \(sell P1 → buy P101\)/);
  assert.match(html(engine, { ...now, engineCall: undefined }), /replaced the engine’s move/);
  assert.match(html(engine, { ...now, engineCall: 'move' }), /replaced the engine’s move/);
});

test('two moves render two .mc__mv blocks and "2 transfers · one −4 hit"', () => {
  const engine = ENGINE();
  const two = plan(14, week(GW, [14, 15], [101, 102]));
  const card = solverCardOf(engine, 'now', two);
  const text = html(engine, card);
  assert.equal(count(text, 'class="mc__mv"'), 2);
  assert.equal(count(text, 'data-lock="'), 2, 'each sale keeps its Don’t sell toggle');
  assert.equal(count(text, 'data-ban="'), 2);
  assert.match(text, /<p class="mc__sum">2 transfers · one −4 hit<\/p>/);
  assert.ok(text.indexOf('2 transfers') > text.lastIndexOf('class="mc__mv"'), 'under the moves');
  assert.match(html(engine, { ...card, hits: 8 }), /2 transfers · two −4 hits/);
  assert.match(html(engine, { ...card, hits: 0 }), /2 transfers, all free/);
  // One move keeps today's markup: one block, no line about transfers.
  const single = html(engine, solverCardOf(engine, 'now', sellsOne()));
  assert.equal(count(single, 'class="mc__mv"'), 1);
  assert.ok(!/<p class="mc__sum">\d+ transfers/.test(single));
});

test('later weeks render under "Plan for GWa–b · tentative"', () => {
  const engine = ENGINE();
  const card = solverCardOf(engine, 'longterm', plan(12, week(GW, [14], [101]), week(GW + 1, [15], [102]), week(GW + 2, [13], [105])));
  const text = html(engine, card);
  assert.match(text, /<details class="mc__alts" data-plan="longterm"><summary>Plan for GW11–12 · tentative<\/summary><ol>/);
  assert.match(text, /<li class="is-tent" title="Tentative: projections, team news and prices can change before this week"><span>GW11: sell <b>P15<\/b> → buy <b>P102<\/b><\/span><span class="sr"> tentative<\/span><\/li>/);
  assert.match(text, /<li class="is-tent"[^>]*><span>GW12: sell <b>P13<\/b> → buy <b>P105<\/b><\/span>/);
  assert.ok(!text.includes('data-plan="longterm" open'));
  assert.match(html(engine, card, { openPlans: new Set(['longterm']) }), /data-plan="longterm" open>/);
  // Several moves in a week are joined; one later week is "GW12" alone; no later move, no list.
  const joined = html(engine, solverCardOf(engine, 'longterm', plan(12, week(GW, [14], [101]), week(GW + 1, [15, 13], [102, 105]))));
  assert.match(joined, /Plan for GW11 · tentative/);
  assert.match(joined, /GW11: sell <b>P13<\/b> → buy <b>P102<\/b>, sell <b>P15<\/b> → buy <b>P105<\/b>/);
  assert.ok(!html(engine, solverCardOf(engine, 'longterm', plan(12, week(GW, [14], [101]), week(GW + 1)))).includes('data-plan'));
});

test('robustness is not rendered while showRobustness is false', () => {
  const engine = ENGINE();
  const base = landed(landed(solverCardOf(engine, 'now', sellsOne()), 'gain', 6), 'alternatives', []);
  const withShare = landed(base, 'robustness', 0.8);
  assert.ok(!html(engine, withShare, { showRobustness: false }).includes('Robust'));
  assert.match(html(engine, withShare, { showRobustness: true }), /<span class="mc__rb" title="[^"]*">Robust 80%<\/span>/);
  // Pending: nothing waits for it while it is hidden; once it is shown, it is a figure like the others.
  const hidden = html(engine, base, { showRobustness: false });
  assert.ok(!hidden.includes('Robust') && !hidden.includes('aria-busy') && !hidden.includes('skeleton'));
  const shown = html(engine, base, { showRobustness: true });
  assert.match(shown, /aria-busy="true"/);
  assert.match(shown, /<span class="mc__rb skeleton" aria-hidden="true">Robust 00%<\/span>/);
  // The engine's own robustness is hidden too while the solver is on.
  const mode = withRobustness(engine.result, { now: new Map([['15>101', 0.9]]) }).modes.now;
  assert.ok(!html(engine, { ...mode, source: 'engine', state: 'ready' }, { showRobustness: false }).includes('Robust'));
  assert.ok(html(engine, { ...mode, source: 'engine', state: 'ready' }, { showRobustness: true }).includes('Robust 90%'));
});

test('a solver card\'s alternatives read their moves, and their gains are against rolling', () => {
  const engine = ENGINE();
  const card = landed(solverCardOf(engine, 'now', sellsOne()), 'gain', 6);
  const alternatives = [
    { moves: [{ outId: 14, inId: 101 }, { outId: 15, inId: 102 }], key: '14,15>101,102', gain: -0.5 },
    { moves: [], key: '', gain: -0.8 },
    { moves: [{ outId: 13, inId: 105 }], key: '13>105', gain: 0.25 },
  ];
  const text = html(engine, landed(card, 'alternatives', alternatives));
  assert.match(text, /<summary>3 alternatives<\/summary>/);
  assert.match(text, /<li><span>Sell <b>P14<\/b>, <b>P15<\/b> → buy <b>P101<\/b>, <b>P102<\/b><\/span><span class="mc__an"><b class="num">\+5\.5<\/b><\/span><\/li>/);
  assert.match(text, /<li><span><b>Roll<\/b><\/span><span class="mc__an"><b class="num">\+5\.2<\/b><\/span><\/li>/);
  assert.match(text, /<li><span>Sell <b>P13<\/b> → buy <b>P105<\/b><\/span><span class="mc__an"><b class="num">\+6\.3<\/b><\/span><\/li>/,
    'one that scores above the pick is shown as it is, in its place');
  assert.ok(text.indexOf('P14') < text.indexOf('<b>Roll</b>') && text.indexOf('<b>Roll</b>') < text.indexOf('P105'));
  assert.match(html(engine, landed(card, 'alternatives', [alternatives[0]]), { openAlts: new Set(['now']) }), /data-alts="now" open>/);
  // Until the gain lands the cells keep their place as skeletons.
  const pending = html(engine, landed(solverCardOf(engine, 'now', sellsOne()), 'alternatives', [alternatives[0]]));
  assert.match(pending, /<span class="mc__an"><b class="num skeleton" aria-hidden="true">\+0\.0<\/b><\/span>/);
});

test('a solver wait that is the engine\'s own wait keeps its explanation but none of the engine\'s scores beside "Solver plan"', () => {
  // Future prep waits for a keeper who pays from the second week; the solver's plan waits for the same move.
  const engine = engineOf(CASES.wait.input);
  const { future } = engine.result.modes;
  assert.equal(future.call, 'wait');
  assert.ok(future.deferral.laterScore !== undefined && future.root.outScore !== undefined);
  const waiting = plan(5, week(GW), week(GW + 1, [future.root.outId], [future.root.inId]), week(GW + 2));
  const solved = solverCardOf(engine, 'future', waiting);
  // The runner keeps the engine's own text when the move is its own (planner-solver.js pickCard).
  const card = { ...solved, root: future.root, deferral: future.deferral };
  const text = html(engine, card);
  assert.match(text, /<p class="mc__tag">Solver plan<\/p>/);
  assert.match(text, /<p class="mc__call">Wait<\/p><p class="mc__sum">Made for GW11 instead: /);
  assert.ok(!text.includes('this move scores'), 'no figure of the engine\'s beside the solver\'s tag');
  assert.ok(!text.includes(pts(future.deferral.laterScore)) && !text.includes(pts(future.root.outScore)));
  // The engine's own card still says what its wait scores.
  assert.match(html(engine, { ...future, source: 'engine', state: 'ready' }), /this move scores .* against .* now:/);
  assert.match(html(engine, future), /this move scores .* against .* now:/);
});

test('a wait card shows no points for next week\'s move as if made now', () => {
  const engine = engineOf(scenario({ candidates: CANDIDATES }));
  const waiting = plan(5, week(GW), week(GW + 1, [15], [101]), week(GW + 2));
  const card = solverCardOf(engine, 'longterm', waiting, { updated: true, replaced: engine.result.modes.longterm.root });
  assert.equal(card.call, 'wait');
  const text = html(engine, card);
  assert.match(text, /<p class="mc__call">Wait<\/p><p class="mc__sum">Made for GW11 instead: /);
  assert.ok(!text.includes('pgw'), 'no per-week gains');
  assert.ok(!text.includes('mc__why'), 'and no explanation of the move as if made now');
  assert.ok(!text.includes('mc__ev'));
  assert.equal(count(text, 'class="mc__mv"'), 1);
});

test('a roll card from the solver says where the plan goes next', () => {
  const engine = ENGINE();
  const card = solverCardOf(engine, 'longterm', plan(5, week(GW), week(GW + 1), week(GW + 2, [15], [101])), { updated: true, replaced: engine.result.modes.longterm.root });
  assert.equal(card.call, 'roll');
  const text = html(engine, card);
  assert.match(text, /<p class="mc__call">Roll<\/p>/);
  assert.match(text, /Plan for GW12 · tentative/);
  assert.match(text, /Updated: the solver’s plan replaced the engine’s move \(sell P15 → buy P101\)\./);
});
