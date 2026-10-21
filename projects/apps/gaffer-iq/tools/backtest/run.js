/**
 * tools/backtest/run.js
 * The decision backtest (docs/decision-engine-plan.md, Phase 7a): every policy
 * - no transfers, the roll baseline, the old engine and the new engine in each
 * mode - manages its own squad through 2024-25 and 2025-26 from many starting
 * squads, each week's moves made on what was known before its deadline and
 * scored on what then happened (tools/backtest/lib.js). Writes
 * docs/decision-engine-backtest.md.
 *
 *   git worktree add --detach <dir> 3aa8f3a        # the old engine (plan §4.4), once
 *   node tools/backtest/download.js
 *   node tools/backtest/run.js --old <dir>/projects/apps/gaffer-iq [--quick]
 *   node tools/backtest/run.js --report
 *
 * --quick runs one squad for a few weeks and prints, writing nothing.
 * --report rewrites the report from the last runs' data/*.json.
 * --resume finishes a run that died, keeping the tasks it had finished.
 * --tune runs the tuning sweep on 2024-25 (data/tune.json); --test-tuned runs
 * the values it chose on 2025-26 (data/tuned.json); --alt runs Long term's
 * alternative preset (data/alt.json). The report includes each once it exists.
 *
 * Every week of every season replays the app's own path - normaliseSeason,
 * buildScoreContext, buildProjections, runDecisionEngine - on vaastav as it
 * stood before that week's deadline (history.js rawSeasonAt), with the points
 * model rebuilt as that season would have had it (tools/points/model.js) and
 * the fixture schedule as it stood (history.js scheduleAt); the final schedule
 * runs as a sensitivity. The old engine runs from its own commit on the same
 * replayed JSON, so nothing of it lives in this tree. Workers run the
 * (season, schedule, squad) tasks in parallel.
 */

import os from 'node:os';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DECISION_ENGINE, PERCENT, SEASON_GWS } from '../../js/config.js';
import { normaliseSeason } from '../../js/engine/normalise.js';
import { buildScoreContext } from '../../js/engine/composite.js';
import { buildProjections } from '../../js/engine/projections.js';
import { createDecisionCache, runDecisionEngine } from '../../js/engine/decision.js';
import { squadValue } from '../../js/engine/squad-value.js';
import { checkSwap } from '../../js/engine/feasibility.js';
import { fromTenths, seededRandom, toTenths } from '../../js/util.js';
import { SEASONS, gwTablesBefore, loadSeason, rawSeasonAt, totalsBefore } from './history.js';
import {
  GAIN_WINDOWS, enginePolicy, moveMetrics, pairedBootstrap, pickSquad, randomSquad, rollPolicy, scoreGameweek, simulateAll,
  slopeInterval, squadState,
} from './lib.js';
import { pointsModelAt } from '../points/model.js';

const RUN_SEASONS = ['2024-25', '2025-26'];
const HELD_OUT = '2025-26';
const SCHEDULES = ['asItStood', 'final'];
const START_GW = 4;                      // the projections were tested from GW4 (Phase 6b)
const QUICK_GWS = 4;
const BUDGET_TENTHS = 1000;
const VALUE_PRICE_CAP_TENTHS = 80;       // the value squad: the template with nobody dearer
const RANDOM_SQUADS = 10;
const RANDOM_MIN_SPEND_TENTHS = 970;
const SQUAD_SEED = 1;
const ROLL = { gain: 2, horizon: 5 };    // points over five GWs a free move must clear
// FPL set every manager's free transfers to five before 2025-26's GW16 (AFCON).
const FT_TOPUPS = { '2025-26': { 16: 5 } };
const OLD_HORIZON = 'GW5';               // the old planner's default window
const BOOT = { block: 5, draws: 2000, seed: 1 };
const CEILING_BEST_WEEKS = 5;            // Ceiling's tail is judged on the weeks that go big as well
// A buy is held for weeks, so neighbouring weeks' differences are related for
// longer than five: the verdict is re-read with blocks this long.
const LONG_BLOCK = 10;
const NONE = { points: 0, minutes: 0 };
// Every stage's results are kept in data/ (gitignored with the data), so --report can rewrite the report without a rerun.
const MODES = Object.keys(DECISION_ENGINE.modes);

// Risk 8: each preset in the other unit. Long term and Future prep are
// normalised as written, so their variant is the horizon total (largest weight
// 1); Funds and Structure are totals as written, so theirs sums to 1. A gate
// stated in the mode's own units (Funds' tau and eps, Future prep's deferral
// epsilon) moves with its weights. The one-off terms stay as written - the
// free-transfer value, the hit and lambda's money terms (FundsTerm, PriceTerm,
// Funds' chain credit) - so what changes is how the weighted gain compares
// with them. Structure's dead-slot penalty never fires here (no status flags),
// so it is left alone.
const DM = DECISION_ENGINE.modes;
const decayWeights = DM.now.weights.map((_, k) => DECISION_ENGINE.decayBase ** k);
const largest = ws => Math.max(...ws);
const total = ws => ws.reduce((a, w) => a + w, 0);
const toTotal = 1 / largest(DM.future.weights);
const toNormalised = 1 / total(decayWeights);

/** DECISION_ENGINE with plain-JSON overrides laid over it, each mode merged on its own (tasks carry them to workers). */
const configWith = (overrides = {}) => ({
  ...DECISION_ENGINE, ...overrides,
  modes: Object.fromEntries(Object.entries(DECISION_ENGINE.modes).map(([id, m]) => [id, { ...m, ...overrides.modes?.[id] }])),
});
const VARIANTS = {
  asWritten: {},
  totals: { modes: {
    longterm: { weights: DM.longterm.weights.map(w => w / largest(DM.longterm.weights)) },
    future: { weights: DM.future.weights.map(w => w * toTotal), deferralEpsilon: DM.future.deferralEpsilon * toTotal },
  } },
  normalised: { modes: {
    funds: { weights: decayWeights.map(w => w * toNormalised), tau: DM.funds.tau * toNormalised, eps: DM.funds.eps * toNormalised },
    structure: { weights: DM.structure.weights.map(w => w / total(DM.structure.weights)) },
  } },
  ceilingMean: { modes: { ceiling: { tail: null } } },
  // The brief's alternative for Long term (§6): decay 0.85 over five GWs, as a per-GW average like the preset.
  longtermDecay: { modes: { longterm: { weights: decayWeights.map(w => w * toNormalised) } } },
};

// A policy: kind none | roll | old | engine; an engine policy plays one mode
// of one config variant; picks above one ask again on the new squad (lib.js).
const MAX_PICKS = 5;
const policy = (name, kind, extra = {}) => ({ name, kind, variant: 'asWritten', picks: 1, ...extra });
const BASE = [policy('none', 'none'), policy('roll', 'roll'), policy('old', 'old')];
const SINGLE = MODES.map(mode => policy(mode, 'engine', { mode }));
const RISK8 = [
  policy('longterm (total)', 'engine', { variant: 'totals', mode: 'longterm', preset: 'longterm' }),
  policy('future (total)', 'engine', { variant: 'totals', mode: 'future', preset: 'future' }),
  policy('funds (normalised)', 'engine', { variant: 'normalised', mode: 'funds', preset: 'funds' }),
  policy('structure (normalised)', 'engine', { variant: 'normalised', mode: 'structure', preset: 'structure' }),
];
// Several moves a week: the roll baseline and each mode, as the planner is used.
const MULTI = [policy('roll+', 'roll', { picks: MAX_PICKS }),
  ...MODES.map(mode => policy(`${mode}+`, 'engine', { mode, picks: MAX_PICKS }))];
// Ceiling on its mean at t*, as before Phase 7b's upper tail.
const CEILING_MEAN = policy('ceiling (mean)', 'engine', { variant: 'ceilingMean', mode: 'ceiling' });
const BASELINES = BASE.map(p => p.name);
const HEADLINE = [...BASELINES, ...MODES];
const ALL_POLICIES = [...BASE, ...SINGLE, ...RISK8, ...MULTI, CEILING_MEAN];
const ALL = ALL_POLICIES.map(p => p.name);
// The brief's alternative preset for Long term, one move and several (--alt), beside the preset as written.
const ALT = [policy('longterm (decay)', 'engine', { mode: 'longterm', variant: 'longtermDecay' }),
  policy('longterm+ (decay)', 'engine', { mode: 'longterm', variant: 'longtermDecay', picks: MAX_PICKS })];

// ─── Tuning (Phase 7b) ───────────────────────────────────────────────────────
//
// One-at-a-time departures from the presets as written, each run on the modes
// it touches, one move a week, over TUNE_SEASON; a value is chosen when it
// gains at least TUNE_MATERIAL points a season on average over those modes,
// and the choices together are then tested on the held-out season. The mode
// weights stay as written (Q6).
const TUNE_SEASON = '2024-25';
const TUNE_MATERIAL = 10;
const LAMBDA_MODES = ['longterm', 'future', 'funds', 'structure'];
const scaleFt = k => ({
  ftValueFlat: DECISION_ENGINE.ftValueFlat * k,
  ftValueSchedule: Object.fromEntries(Object.entries(DECISION_ENGINE.ftValueSchedule).map(([n, v]) => [n, v * k])),
});
const everyMode = (modes, change) => ({ modes: Object.fromEntries(modes.map(m => [m, change(DM[m])])) });
const TUNING = [
  ...[0, 0.5, 2, 3].map(k => ({ param: 'free-transfer value', value: `x${k}`, modes: MODES, overrides: scaleFt(k) })),
  ...[0.5, 1].map(h => ({ param: 'threshold', value: String(h), modes: MODES, overrides: everyMode(MODES, () => ({ threshold: h })) })),
  ...[0, 4].map(m => ({ param: 'hit margin', value: String(m), modes: ['funds'], overrides: { hitMargin: m } })),
  ...[0, 2].map(k => ({ param: 'lambda', value: `x${k}`, modes: LAMBDA_MODES, overrides: {
    lambdaDefault: DECISION_ENGINE.lambdaDefault * k,
    ...everyMode(LAMBDA_MODES.filter(m => DM[m].lambda !== undefined), m => ({ lambda: m.lambda * k })),
  } })),
  ...[0.5, 2].map(t => ({ param: 'tau', value: String(t), modes: ['funds'], overrides: everyMode(['funds'], () => ({ tau: t })) })),
  ...[0.7, 1].map(d => ({ param: 'decay', value: String(d), modes: ['funds'], overrides: { decayBase: d } })),
].map(t => ({ ...t, variant: `${t.param} ${t.value}` }));
const tuningPolicies = () => TUNING.flatMap(t => t.modes.map(mode => policy(`${mode} @ ${t.variant}`, 'engine', { mode, variant: t.variant })));

/** Two overrides objects as one, modes merged. */
const merged = (a, b) => ({ ...a, ...b, modes: Object.fromEntries([...new Set([...Object.keys(a.modes ?? {}), ...Object.keys(b.modes ?? {})])]
  .map(m => [m, { ...a.modes?.[m], ...b.modes?.[m] }])) });

/** Each sweep value's mean paired gain over the modes it touches, and the choice per parameter. */
function tuningChoices(tune) {
  const rows = TUNING.map(t => {
    const gains = t.modes.map(mode => {
      const r = paired(tune, [TUNE_SEASON], 'asItStood', `${mode} @ ${t.variant}`, mode);
      return r ? r.mean * r.gws : NaN;
    });
    return { ...t, gains, gain: mean(gains) };
  });
  const params = [...new Set(TUNING.map(t => t.param))];
  const chosen = params.map(param => {
    const best = rows.filter(r => r.param === param).reduce((a, b) => (b.gain > a.gain ? b : a));
    return best.gain >= TUNE_MATERIAL ? best : null;
  }).filter(Boolean);
  return { rows, chosen, overrides: chosen.reduce((acc, c) => merged(acc, c.overrides), {}) };
}

const memo = (fn, key) => {
  const cache = new Map();
  return (...args) => {
    const k = key(...args);
    if (!cache.has(k)) cache.set(k, fn(...args));
    return cache.get(k);
  };
};
const idsKey = ids => [...ids].sort((a, b) => a - b).join(',');
const stateKey = s => `${s.ft}|${s.bankTenths}|${s.squad.map(p => `${p.id}:${p.purchaseTenths}`).sort().join(',')}`;

// ─── The starting squads ─────────────────────────────────────────────────────

/** The template (by GW3 ownership), the value squad and the random ones, at START_GW's prices, from players who had appeared. */
function startingSquads(season) {
  const appeared = new Set(season.rows.filter(r => r.gw < START_GW && r.minutes > 0).map(r => r.element));
  const owned = new Map(season.rows.filter(r => r.gw === START_GW - 1).map(r => [r.element, r.selected]));
  const pool = [...totalsBefore(season, START_GW).values()].filter(t => appeared.has(t.element)).map(t => ({
    id: t.element, position: t.position, teamId: t.teamId, priceTenths: t.priceTenths, selected: owned.get(t.element) ?? 0,
  }));
  const byOwnership = [...pool].sort((a, b) => b.selected - a.selected);
  const squads = [
    { label: 'template', ...pickSquad(byOwnership, { budgetTenths: BUDGET_TENTHS }) },
    { label: 'value', ...pickSquad(byOwnership.filter(p => p.priceTenths <= VALUE_PRICE_CAP_TENTHS), { budgetTenths: BUDGET_TENTHS }) },
    ...Array.from({ length: RANDOM_SQUADS }, (_, k) => ({
      label: `random ${k + 1}`,
      ...randomSquad(pool, seededRandom(SQUAD_SEED + k), { budgetTenths: BUDGET_TENTHS, minSpendTenths: RANDOM_MIN_SPEND_TENTHS }),
    })),
  ];
  if (squads.some(s => !s.ids)) throw new Error(`startingSquads: ${season.name} has no ${squads.find(s => !s.ids).label} squad`);
  return squads.map((s, index) => ({ ...s, index }));
}

// ─── The world: a season as it stood, week by week ───────────────────────────

function buildWorld(seasons, name, schedule, old) {
  const season = seasons.find(s => s.name === name);
  const modelAt = pointsModelAt(seasons, name);
  const actual = new Map();
  for (const r of season.rows) {
    const k = `${r.gw}|${r.element}`;
    const a = actual.get(k) ?? { points: 0, minutes: 0 };
    a.points += r.points;
    a.minutes += r.minutes;
    actual.set(k, a);
  }
  const at = memo(t => {
    const raw = rawSeasonAt(season, t, { schedule });
    const s = normaliseSeason(raw.bootstrap, raw.fixtures);
    const ctx = buildScoreContext(s, { currentGw: t });
    const projections = buildProjections(s.players, ctx, { planningGw: t, gwTable: gwTablesBefore(season, t), pointsModel: modelAt(t) });
    return { raw, s, projections, positions: new Map(s.players.map(p => [p.id, p.position])) };
  }, t => t);
  return {
    key: `${name}|${schedule}`, name, schedule, at,
    player: (id, t) => at(t).s.playersById[id],
    priceTenths: (id, t) => toTenths(at(t).s.playersById[id].price),
    projections: t => at(t).projections,
    candidates: t => at(t).s.players,
    ftTopUp: t => FT_TOPUPS[name]?.[t] ?? null,
    actual: (id, t) => actual.get(`${t}|${id}`) ?? NONE,
    old: old && memo(t => oldContext(old, at(t).raw, t), t => t),
  };
}

/** The squad-dependent parts of a world, kept per task so memory stays bounded. */
function forTask(world, variants) {
  const lineup = (ids, t) => squadValue(ids, t, world.at(t).projections);
  const configs = new Map(Object.entries(variants).map(([name, overrides]) => [name, configWith(overrides)]));
  // V depends on the week's projections and the squad, not on the bank, the
  // free transfers or a config's gates and weights: every policy holding the
  // same squad (in the same order) that week shares one cache. Weeks run in
  // lockstep (lib.js simulateAll), so a past week's caches are dropped.
  let week = null;
  let caches = new Map();
  const decisionCache = (t, ids) => {
    if (t !== week) {
      week = t;
      caches = new Map();
    }
    const k = ids.join(',');
    if (!caches.has(k)) caches.set(k, createDecisionCache());
    return caches.get(k);
  };
  return {
    ...world,
    gwPoints: memo((ids, t) => scoreGameweek(lineup(ids, t), world.at(t).positions, id => world.actual(id, t)).points,
      (ids, t) => `${t}|${idsKey(ids)}`),
    expectedPoints: memo((ids, gw, t) => squadValue(ids, gw, world.at(t).projections).value,
      (ids, gw, t) => `${t}|${gw}|${idsKey(ids)}`),
    // Only each mode's call and moves are kept: a full result per state would fill memory.
    engine: memo((variant, t, state, locks) => calls(runDecisionEngine(engineInput(world.at(t), t, state, locks), configs.get(variant),
      decisionCache(t, state.squad.map(p => p.id)))),
    (variant, t, state, locks) => `${variant}|${t}|${stateKey(state)}|${idsKey(locks)}`),
  };
}

const moveOf = m => m && { outId: m.outId, inId: m.inId, chained: moveOf(m.chained) };
const calls = result => ({
  modes: Object.fromEntries(Object.entries(result.modes).map(([id, m]) => [id, { call: m.call, root: moveOf(m.root) }])),
});

/** runDecisionEngine's input as the planner builds it (modules/planner.js runEngine), with no chips, bans or price signals. */
function engineInput({ s, projections }, t, state, locks) {
  return {
    planningGw: t,
    squad: state.squad.map(p => {
      const player = s.playersById[p.id];
      return { playerId: p.id, name: player.name, position: player.position, teamId: player.teamId,
        priceTenths: toTenths(player.price), purchaseTenths: p.purchaseTenths };
    }),
    bankTenths: state.bankTenths, freeTransfers: state.ft, chipPlan: {}, chipsUsed: [],
    locks, bans: new Set(), projections, candidates: s.players, priceSignals: null, hoursToDeadline: null,
  };
}

// ─── The old engine, from its commit ─────────────────────────────────────────

async function loadOldEngine(dir) {
  const load = file => import(pathToFileURL(path.join(dir, 'js', file)).href);
  const [normalise, composite, transfers, strategy, chips, config] = await Promise.all(
    ['engine/normalise.js', 'engine/composite.js', 'engine/transfers.js', 'engine/strategy.js', 'engine/chips.js', 'config.js']
      .map(load));
  return {
    normaliseSeason: normalise.normaliseSeason, buildScoreContext: composite.buildScoreContext,
    rankPlayers: composite.rankPlayers, attachRankTiers: composite.attachRankTiers,
    enumerateSwaps: transfers.enumerateSwaps, calcSquadFlexibility: transfers.calcSquadFlexibility,
    buildVerdict: strategy.buildVerdict, chips, benchSize: config.BENCH_SIZE, horizon: config.HORIZONS[OLD_HORIZON],
  };
}

/**
 * The old planner's context for a week (its computeBoards and computeChipRecs):
 * its own season, scores cached across squads, rank tiers, and the league-wide
 * Wildcard and Free Hit weeks.
 */
function oldContext(old, raw, t) {
  const s = old.normaliseSeason(raw.bootstrap, raw.fixtures);
  const ctx = old.buildScoreContext(s, { currentGw: t });
  const rankTiers = new Map(old.attachRankTiers(old.rankPlayers(s.players, old.horizon, ctx)).map(r => [r.player.id, r.rankTier]));
  return {
    s, ctx, rankTiers, caches: { long: new Map(), now1: new Map(), far: new Map() },
    wildcard: old.chips.scoreWildcardTiming(old.horizon, ctx)[0] ?? null,
    freehit: old.chips.scoreFreeHitTiming(old.horizon, ctx),
  };
}

/** The old planner's chip weeks for a squad (computeChipRecs): its verdict promotes a lane near one. */
function oldChipRecs(old, o, ids) {
  const scores = o.caches.long;
  const bench = [...ids].sort((a, b) => (scores.get(a)?.value ?? 0) - (scores.get(b)?.value ?? 0)).slice(0, old.benchSize);
  const captain = ids.reduce((best, id) => ((scores.get(id)?.expectedPoints?.value ?? -Infinity)
    > (scores.get(best)?.expectedPoints?.value ?? -Infinity) ? id : best), ids[0]);
  return {
    wildcard: o.wildcard,
    freehit: o.freehit,
    benchboost: old.chips.scoreBenchBoostTiming(old.horizon, { ...o.ctx, benchPlayerIds: bench }),
    triplecaptain: old.chips.scoreTripleCaptainTiming(o.s.playersById[captain], old.horizon, o.ctx),
  };
}

/**
 * The old engine's verdict move. It budgets on current prices and ignores
 * the club limit, so its verdict is taken over the swaps that are legal FPL
 * moves - what it would have said had it checked - and the weeks its
 * unchecked verdict would have named an illegal move are counted.
 */
function oldPolicy(old) {
  const counts = { verdicts: 0, illegal: 0 };
  return {
    counts,
    decide({ t, state, world }) {
      const o = world.old(t);
      const { s, ctx, rankTiers, caches } = o;
      const ids = state.squad.map(p => p.id);
      const swaps = old.enumerateSwaps(ids, s.players, ctx, {
        horizon: old.horizon, budget: fromTenths(state.bankTenths), freeTransfers: state.ft, caches, rankTierByPlayerId: rankTiers,
      });
      const verdictState = {
        flexibility: old.calcSquadFlexibility(ids.map(id => s.playersById[id]), caches.long),
        freeTransfers: state.ft, chipRecs: oldChipRecs(old, o, ids),
      };
      const current = squadState(state, world, t);
      const legal = sw => checkSwap(current, sw.outPlayer.id, sw.inPlayer).ok;
      const unchecked = old.buildVerdict(swaps, verdictState, ctx);
      if (unchecked.bestSwap && !legal(unchecked.bestSwap)) counts.illegal += 1;
      const verdict = old.buildVerdict(swaps.filter(legal), verdictState, ctx);
      if (verdict.lane === 'roll' || !verdict.bestSwap) return { moves: [] };
      counts.verdicts += 1;
      return { moves: [{ outId: verdict.bestSwap.outPlayer.id, inId: verdict.bestSwap.inPlayer.id }] };
    },
  };
}

// ─── A task: one squad's season under every policy ───────────────────────────

function policyFor(spec, old) {
  if (spec.kind === 'none') return { decide: () => ({ moves: [] }) };
  if (spec.kind === 'roll') return rollPolicy({ ...ROLL, maxBankedFt: DECISION_ENGINE.maxBankedFt, maxPicks: spec.picks });
  if (spec.kind === 'old') return oldPolicy(old);
  return enginePolicy(spec.mode, ({ t, state, world, locks }) => world.engine(spec.variant, t, state, locks), { maxPicks: spec.picks });
}

/**
 * Which move, on the same squads: each week of the roll baseline's season,
 * every mode is also asked for its pick on roll's squad, and both picks are
 * scored on what happened over the next five GWs (cut at the season's end)
 * against keeping the squad, less hits; a roll scores 0. Also each pick's
 * gain on that week's projections (V) and on its players' own points.
 */
function shadowOf(world, run, toGw) {
  const hitCost = DECISION_ENGINE.hitCost;
  return run.gws.map(g => {
    const window = Array.from({ length: Math.min(5, toGw - g.t + 1) }, (_, i) => g.t + i);
    const own = id => sum(world.at(g.t).projections.get(id).gws.slice(0, window.length).map(x => x.xpts));
    const score = moves => {
      const after = moves.reduce((ids, m) => ids.map(id => (id === m.outId ? m.inId : id)), g.before);
      const hits = Math.max(0, moves.length - g.ft) * hitCost;
      return {
        moves: moves.length,
        realised: sum(window.map(u => world.gwPoints(after, u) - world.gwPoints(g.before, u))) - hits,
        expected: sum(window.map(u => world.expectedPoints(after, u, g.t) - world.expectedPoints(g.before, u, g.t))) - hits,
        own: sum(moves.map(m => own(m.inId) - own(m.outId))),
        key: moves.map(m => `${m.outId}>${m.inId}`).join(','),
      };
    };
    const result = world.engine('asWritten', g.t, { ...g.stateBefore, ft: g.ft }, new Set());
    return {
      t: g.t, ft: g.ft, roll: score(g.moves),
      modes: Object.fromEntries(MODES.map(mode => {
        const m = result.modes[mode];
        return [mode, score(m.call === 'move' ? [m.root, m.root.chained].filter(Boolean) : [])];
      })),
    };
  });
}

function runTask(world, task, old) {
  const started = Date.now();
  const taskWorld = forTask(world, task.variants);
  const start = {
    squad: task.squad.ids.map(id => ({ id, purchaseTenths: world.priceTenths(id, START_GW) })),
    bankTenths: BUDGET_TENTHS - task.squad.costTenths,
    ft: 1,
  };
  const opts = { fromGw: START_GW, toGw: task.toGw, maxBankedFt: DECISION_ENGINE.maxBankedFt, hitCost: DECISION_ENGINE.hitCost };
  const policies = Object.fromEntries(task.policies.map(spec => [spec.name, policyFor(spec, old)]));
  const runs = simulateAll(taskWorld, start, policies, opts);
  const out = {};
  for (const [name, run] of Object.entries(runs)) {
    out[name] = {
      total: run.total,
      gws: run.gws.map(g => ({ t: g.t, points: g.points, hits: g.hits, ft: g.ft, moves: g.moves.length, lostFt: g.lostFt })),
      metrics: moveMetrics(run, taskWorld, opts).map(m => ({ ...m, moves: m.moves.length })),
      counts: policies[name].counts ?? null,
    };
  }
  const shadow = task.shadow && runs.roll ? shadowOf(taskWorld, runs.roll, task.toGw) : null;
  return { season: task.season, schedule: task.schedule, squad: task.squad.index, label: task.squad.label, out, shadow,
    ms: Date.now() - started };
}

// ─── Workers ─────────────────────────────────────────────────────────────────

async function workerMain({ oldDir }) {
  const seasons = await Promise.all(SEASONS.map(n => loadSeason(n)));
  const old = await loadOldEngine(oldDir);
  let world = null;
  parentPort.on('message', task => {
    try {
      if (world?.key !== `${task.season}|${task.schedule}`) world = buildWorld(seasons, task.season, task.schedule, old);
      parentPort.postMessage({ ok: true, result: runTask(world, task, old) });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err.stack ?? String(err) });
    }
  });
  parentPort.postMessage({ ready: true });
}

/** Runs the tasks on `threads` workers; onResult sees each result as it lands. */
function runPool(tasks, oldDir, threads, onResult = () => {}) {
  if (!tasks.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const queue = [...tasks];
    const results = [];
    const finished = new Set();
    let live = 0;
    const started = Date.now();
    const next = worker => {
      const task = queue.shift();
      if (!task) {
        // terminate() exits with code 1: marked first, so the exit handler knows it was asked for.
        finished.add(worker);
        worker.terminate();
        if (--live === 0) resolve(results);
        return;
      }
      worker.postMessage(task);
    };
    for (let i = 0; i < Math.min(threads, tasks.length); i++) {
      live += 1;
      const worker = new Worker(new URL(import.meta.url), { workerData: { oldDir } });
      worker.on('message', msg => {
        if (msg.ready) return next(worker);
        if (!msg.ok) return reject(new Error(msg.error));
        results.push(msg.result);
        onResult(msg.result);
        const r = msg.result;
        console.log(`[${results.length}/${tasks.length}] ${r.season} ${r.schedule} ${r.label}: ${Math.round(r.ms / 1000)}s`
          + ` (${Math.round((Date.now() - started) / 60000)} min)`);
        return next(worker);
      });
      worker.on('error', reject);
      worker.on('exit', code => {
        if (!finished.has(worker)) reject(new Error(`run.js: a worker exited with code ${code} before its work was done`));
      });
    }
  });
}

// ─── The report ──────────────────────────────────────────────────────────────

const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const signed = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}` : '-');
const ci = (r, scale = 1, d = 1) => `${signed(r.mean * scale, d)} [${signed(r.lo * scale, d)}, ${signed(r.hi * scale, d)}]`;
const verdictOf = r => (r.lo > 0 ? 'better' : (r.hi < 0 ? 'worse' : 'no clear difference'));
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => (xs.length ? sum(xs) / xs.length : NaN);
const net = run => run.gws.map(g => g.points - g.hits);

function of(results, season, schedule) {
  return results.filter(r => r.season === season && r.schedule === schedule).sort((a, b) => a.squad - b.squad);
}

/** Paired per-GW differences (a - b), one squads x GWs matrix per season, bootstrapped together. */
function paired(results, seasons, schedule, a, b, boot = BOOT) {
  const strata = seasons.map(season => of(results, season, schedule).filter(r => r.out[a] && r.out[b])
    .map(r => net(r.out[a]).map((x, i) => x - net(r.out[b])[i]))).filter(m => m.length);
  return strata.length ? { ...pairedBootstrap(strata, boot), gws: strata[0][0].length } : null;
}

function seasonTable(results, season, schedule, policies) {
  const rows = of(results, season, schedule);
  const lines = policies.filter(p => rows[0]?.out[p]).map(p => {
    const runs = rows.map(r => r.out[p]);
    return `| ${p} | ${f(mean(runs.map(r => r.total)))} | ${f(mean(runs.map(r => r.gws.reduce((a, g) => a + g.moves, 0))))}`
      + ` | ${f(mean(runs.map(r => r.gws.reduce((a, g) => a + g.hits, 0))))}`
      + ` | ${f(mean(runs.map(r => r.gws.filter(g => g.ft >= DECISION_ENGINE.maxBankedFt).length)))}`
      + ` | ${f(mean(runs.map(r => r.gws.filter(g => g.lostFt).length)))} |`;
  });
  return ['| policy | points (net of hits) | transfers | hit points | weeks at the free-transfer cap | free transfers lost |',
    '|---|---|---|---|---|---|', ...lines].join('\n');
}

function pairedTable(results, seasons, schedule, policies, against) {
  const header = `| policy | ${against.map(b => `vs ${b}`).join(' | ')} |`;
  const lines = policies.map(p => {
    const cells = against.map(b => {
      if (p === b) return '';
      const r = paired(results, seasons, schedule, p, b);
      return r ? `${ci(r, r.gws)} ${verdictOf(r) === 'no clear difference' ? '' : `**${verdictOf(r)}**`}` : '-';
    });
    return `| ${p} | ${cells.join(' | ')} |`;
  });
  return [header, `|---|${against.map(() => '---').join('|')}|`, ...lines].join('\n');
}

function moveTable(results, seasons, schedule, policies) {
  const lines = policies.flatMap(p => {
    const ms = seasons.flatMap(s => of(results, s, schedule)).flatMap(r => r.out[p]?.metrics ?? []);
    if (!ms.length) return [];
    const iid = values => pairedBootstrap([[values]], { ...BOOT, block: 1 });
    const rtg = Object.fromEntries(GAIN_WINDOWS.map(k => [k, iid(ms.map(m => m.realised[k]))]));
    // Before hits: a hit taken off both sides would pull the slope towards 1.
    const fit = slopeInterval(ms.map(m => m.expected[5] + m.hits), ms.map(m => m.realised[5] + m.hits), BOOT);
    const regrets = ms.map(m => m.sellRegret).filter(x => x !== null);
    const hitWeeks = ms.filter(m => m.free === 0);
    const freeWeeks = ms.filter(m => m.hit === 0);
    return [`| ${p} | ${ms.length} | ${GAIN_WINDOWS.map(k => ci(rtg[k], 1, 2)).join(' | ')} | ${f(mean(ms.map(m => m.expected[5])), 2)}`
      + ` | ${f(fit.slope, 2)} [${f(fit.lo, 2)}, ${f(fit.hi, 2)}] | ${f(mean(regrets), 2)} | ${hitWeeks.length}`
      + ` | ${hitWeeks.length ? f(mean(hitWeeks.map(m => (m.realised[5] + m.hits) / m.hits)), 2) : '-'}`
      + ` | ${f(freeWeeks.reduce((a, m) => a + m.realised[5], 0) / freeWeeks.reduce((a, m) => a + m.free, 0), 2)} |`];
  });
  return ['| policy | weeks with moves | realised gain, 1 GW | 3 GWs | 5 GWs | expected, 5 GWs | slope of realised on expected (5 GWs)'
    + ' | sell regret | weeks of hits only | hit return per point | points per free transfer |',
  '|---|---|---|---|---|---|---|---|---|---|---|', ...lines].join('\n');
}

const AGAINST = { roll: 'the roll baseline', 'roll+': 'roll+ (the roll baseline, several moves a week)', old: 'the old engine',
  none: 'no transfers' };

/** One line per baseline: each mode's paired season difference and its verdict; then any verdict longer blocks change. */
const labelOf = name => (name.endsWith('+') ? `${DECISION_ENGINE.modes[name.slice(0, -1)]?.label ?? name}+`
  : DECISION_ENGINE.modes[name]?.label ?? name);

/** Each row's paired season difference against each baseline, with a tally and the longer-block check. */
function verdictLines(results, seasons, schedule, rows = MODES, against = ['old', 'roll', 'none']) {
  const changed = [];
  const tally = against.map(b => {
    const verdicts = rows.map(row => paired(results, seasons, schedule, row, b)).filter(Boolean).map(verdictOf);
    const count = v => verdicts.filter(x => x === v).length;
    return verdicts.length ? `against ${AGAINST[b]} ${count('better')} of ${verdicts.length} modes better and ${count('worse')} worse` : null;
  }).filter(Boolean);
  const summary = tally.length ? [`In short: ${tally.join('; ')}.`, ''] : [];
  const lines = against.map(b => `- **Against ${AGAINST[b]}:** ${rows.map(row => {
    const r = paired(results, seasons, schedule, row, b);
    if (!r) return null;
    const long = paired(results, seasons, schedule, row, b, { ...BOOT, block: LONG_BLOCK });
    if (verdictOf(long) !== verdictOf(r)) changed.push(`${labelOf(row)} against ${AGAINST[b]} (${verdictOf(long)})`);
    return `${labelOf(row)} ${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}`;
  }).filter(Boolean).join('; ')}.`);
  lines.push(changed.length ? `- With ${LONG_BLOCK}-week blocks these verdicts change: ${changed.join('; ')}.`
    : `- With ${LONG_BLOCK}-week blocks every verdict stands.`);
  const units = RISK8.map(r => {
    const d = paired(results, seasons, schedule, r.name, r.mode);
    return d ? `${r.name} ${ci(d, d.gws)}${verdictOf(d) === 'no clear difference' ? '' : ` **${verdictOf(d)}**`}` : null;
  }).filter(Boolean);
  if (units.length && rows === MODES) lines.push(`- **Risk 8, each preset in the other unit, less as written:** ${units.join('; ')}.`);
  return [...summary, ...lines].join('\n');
}

/** The several-moves policies: each against its one-move version, the several-moves roll baseline and the old engine. */
function multiTable(results, seasons, schedule) {
  const cell = (a, b) => {
    const r = paired(results, seasons, schedule, a, b);
    return r ? `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}` : '-';
  };
  const lines = MULTI.map(p => `| ${p.name} | ${cell(p.name, p.name.slice(0, -1))} | ${p.name === 'roll+' ? '' : cell(p.name, 'roll+')}`
    + ` | ${cell(p.name, 'old')} |`);
  return ['| policy | less its one-move version | less roll+ | less the old engine |', '|---|---|---|---|', ...lines].join('\n');
}

/**
 * Which move, on the same squads (shadowOf): per mode, on the roll baseline's
 * own path, its pick's realised five-GW gain less roll's pick's, a week each.
 */
function shadowTable(results, seasons) {
  const rows = seasons.flatMap(season => of(results, season, 'asItStood')).filter(r => r.shadow);
  if (!rows.length) return '';
  const cap = DECISION_ENGINE.maxBankedFt;
  const lines = MODES.map(mode => {
    const strata = seasons.map(season => of(results, season, 'asItStood').filter(r => r.shadow)
      .map(r => r.shadow.map(w => w.modes[mode].realised - w.roll.realised))).filter(m => m.length);
    const all = pairedBootstrap(strata, BOOT);
    const weeks = rows.flatMap(r => r.shadow);
    const part = keep => mean(weeks.filter(keep).map(w => w.modes[mode].realised - w.roll.realised));
    const same = weeks.filter(w => w.modes[mode].key === w.roll.key).length / weeks.length;
    return `| ${labelOf(mode)} | ${weeks.length} | ${f(same * PERCENT, 0)}% | ${ci(all, 1, 2)}${verdictOf(all) === 'no clear difference' ? '' : ` **${verdictOf(all)}**`}`
      + ` | ${signed(part(w => w.ft < cap), 2)} | ${signed(part(w => w.ft >= cap), 2)}`
      + ` | ${signed(mean(weeks.map(w => w.modes[mode].expected - w.roll.expected)), 2)}`
      + ` | ${signed(mean(weeks.map(w => w.modes[mode].own - w.roll.own)), 2)} |`;
  });
  return ['| mode | weeks | same pick as roll | its pick less roll\'s, realised over 5 GWs | below the cap | at the cap'
    + ' | expected (V) | own projected points |', '|---|---|---|---|---|---|---|---|', ...lines].join('\n');
}

/** Ceiling on its upper tail less on its mean: season points, and each squad's five best weeks. */
function ceilingLines(results, seasons) {
  const season = paired(results, seasons, 'asItStood', 'ceiling', CEILING_MEAN.name);
  const runs = seasons.flatMap(s => of(results, s, 'asItStood')).filter(r => r.out.ceiling && r.out[CEILING_MEAN.name]);
  if (!season || !runs.length) return '';
  const best = run => net(run).sort((a, b) => b - a).slice(0, CEILING_BEST_WEEKS).reduce((a, x) => a + x, 0);
  const top = pairedBootstrap([[runs.map(r => best(r.out.ceiling) - best(r.out[CEILING_MEAN.name]))]], { ...BOOT, block: 1 });
  return `- Season points: ${ci(season, season.gws)} - ${verdictOf(season)}.\n`
    + `- Each squad's ${CEILING_BEST_WEEKS} best weeks: ${ci(top)} - ${verdictOf(top)} (squad-seasons resampled).`;
}

/** The brief's alternative preset for Long term, less the preset as written and less the roll baseline. */
function altSection(alt) {
  if (!alt) return '';
  const cell = (seasons, a, b) => {
    const r = paired(alt, seasons, 'asItStood', a, b);
    return r ? `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}` : '-';
  };
  const rows = [[HELD_OUT], RUN_SEASONS].flatMap(ss => [
    `| ${ss.join(' and ')} | one move | ${cell(ss, 'longterm (decay)', 'longterm')} | ${cell(ss, 'longterm (decay)', 'roll')} |`,
    `| ${ss.join(' and ')} | several | ${cell(ss, 'longterm+ (decay)', 'longterm+')} | ${cell(ss, 'longterm+ (decay)', 'roll')} |`]);
  return `## Long term's alternative: decay 0.85 over five GWs

The brief gives Long term "[1,1,1,0,0] / 3, or decay 0.85"; the preset is the first (Q6). The second, as a per-GW
average like the first, run on the same squads (points a season):

| seasons | moves a week | less the preset as written | less the roll baseline |
|---|---|---|---|
${rows.join('\n')}
`;
}

/** The tuning sweep (2024-25) and the chosen values' test on the held-out season. */
function tuningSection(tune, tuned) {
  if (!tune) return '';
  const { rows, chosen } = tuningChoices(tune);
  const widths = TUNING.flatMap(t => t.modes.map(mode => paired(tune, [TUNE_SEASON], 'asItStood', `${mode} @ ${t.variant}`, mode)))
    .filter(Boolean).map(r => ((r.hi - r.lo) / 2) * r.gws).sort((a, b) => a - b);
  const halfWidth = widths[Math.floor(widths.length / 2)];
  const sweep = rows.map(r => `| ${r.param} | ${r.value} | ${r.modes.map(labelOf).join(', ')} | ${signed(r.gain)}`
    + ` | ${r.gains.map(g => signed(g, 0)).join(', ')} |`);
  const test = !tuned ? '' : `\n\nThe chosen values together, on ${HELD_OUT} (held out), less the presets as written (points a season):\n\n`
    + `| mode | one move a week | several a week |\n|---|---|---|\n${MODES.map(mode => {
      const cell = (a, b) => {
        const r = paired(tuned, [HELD_OUT], 'asItStood', a, b);
        return r ? `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}` : '-';
      };
      return `| ${labelOf(mode)} | ${cell(`${mode} (tuned)`, mode)} | ${cell(`${mode}+ (tuned)`, `${mode}+`)} |`;
    }).join('\n')}`;
  return `## Tuning: chosen on ${TUNE_SEASON}, tested on ${HELD_OUT}

Each value below replaced its preset alone, one move a week, on ${TUNE_SEASON}; the gain is the paired season
difference against the presets as written, averaged over the modes it touches (each mode's own in the last
column). A value is chosen if its gain is at least ${TUNE_MATERIAL} points a season. The mode weights are not tuned (Q6).
For scale, one value on one mode carries a 95% interval of about ${f(halfWidth)} points either way (the median over
the sweep), so the sweep can show only a large effect.

| parameter | value | modes | mean gain | per mode |
|---|---|---|---|---|
${sweep.join('\n')}

Chosen: ${chosen.length ? chosen.map(c => `${c.param} ${c.value} (${signed(c.gain)})`).join('; ') : 'nothing clears the bar; the presets stand'}.${test}
`;
}

function report(results, squadsBySeason, { tune = null, tuned = null, alt = null } = {}) {
  const both = RUN_SEASONS;
  const other = RUN_SEASONS.filter(s => s !== HELD_OUT);
  const oldCounts = ['asItStood'].flatMap(sch => RUN_SEASONS.flatMap(s => of(results, s, sch))).map(r => r.out.old?.counts).filter(Boolean);
  const sumCount = key => oldCounts.reduce((a, c) => a + c[key], 0);
  const gwsLabel = `GW${START_GW}-${SEASON_GWS}`;
  return `# Decision engine backtest

Generated by \`node tools/backtest/run.js\` (docs/decision-engine-plan.md,
Phase 7a). Do not edit by hand: change the tool and run it again.

## Verdict

On ${HELD_OUT}, held out, with the fixture schedule as it stood. Each figure is
the new engine in one mode against a baseline: the points it scored over the
season less theirs (net of hits), the same squad and week paired, averaged
over ${squadsBySeason[HELD_OUT].length} starting squads, with a 95% interval
that resamples the squads and five-week blocks of the season. "better" or
"worse" only where the interval excludes zero.

${verdictLines(results, [HELD_OUT], 'asItStood')}

Both seasons together (${both.join(' and ')}):

${verdictLines(results, both, 'asItStood')}

Several moves a week (each mode asking again on its new squad until it rolls; see below), on ${HELD_OUT}:

${verdictLines(results, [HELD_OUT], 'asItStood', MULTI.filter(p => p.kind === 'engine').map(p => p.name), ['old', 'roll+', 'none'])}

## What was run

- **Seasons.** ${both.join(', ')}, planning ${gwsLabel}. ${HELD_OUT} is held out; ${other.join(', ')}'s
  projection choices and minutes model were fitted on it (Phase 4, Phase 6b), so it is shown, not judged on.
- **What each week knew.** vaastav as it stood before that week's deadline (tools/backtest/history.js): totals
  from earlier weeks, prices at that week, results only of earlier fixtures, no status flags, neutral FDR and club
  strengths; the points model rebuilt as Phase 6b's test built it for that season (constants and club priors from the
  seasons before it, defensive contributions from its own weeks so far). The schedule as it stood: a fixture sits in its
  original week until its new week arrives, and a postponed one has no date from its original week until then; the final
  schedule is a sensitivity below.
- **Squads.** ${squadsBySeason[HELD_OUT].length} per season at GW${START_GW} prices within £${f(BUDGET_TENTHS / 10)}m,
  1 free transfer at GW${START_GW}: the template (greedily by GW${START_GW - 1} ownership), a value squad (the template with nobody above
  £${f(VALUE_PRICE_CAP_TENTHS / 10)}m) and ${RANDOM_SQUADS} random squads (players who had appeared, drawn by price squared, spending at least
  £${f(RANDOM_MIN_SPEND_TENTHS / 10)}m). Costs: ${both.map(s => `${s} ${squadsBySeason[s].map(q => f(q.costTenths / 10)).join(', ')}`).join('; ')}.
- **Rules.** Free transfers bank to ${DECISION_ENGINE.maxBankedFt} (${HELD_OUT}'s AFCON top-up to 5 before GW16 included);
  each extra transfer costs ${DECISION_ENGINE.hitCost}; a sale goes at its sell price on what that policy paid; no chips for anyone.
- **Fielding.** Every policy's XI, bench order, captain and vice come from the same rule (squadValue on that week's
  projections), scored on actual points with FPL's autosubs and the vice's armband when the captain did not play.
- **Policies.** none: no transfers. roll: the free move whose buy out-projects his sale by most over ${ROLL.horizon} GWs on their
  own points, made when that clears ${ROLL.gain} (any gain at the cap), never a hit. old: the old engine at \`3aa8f3a\`
  (its planner's default ${OLD_HORIZON} window, budget the bank), its verdict's move. The six modes: the new engine's root move
  in that mode, and Funds' chained second move; Ceiling on its upper tail (and, as \`ceiling (mean)\`, on its mean).
  A name ending + makes several moves a week (below).

## Season points

${both.map(s => `### ${s}${s === HELD_OUT ? ' (held out)' : ''}\n\nMeans over the squads.\n\n${seasonTable(results, s, 'asItStood', ALL)}`).join('\n\n')}

## Paired differences (points a season)

The row's policy less the column's, net of hits, paired by squad and week; 95% interval.

${[[HELD_OUT], other, both].map(ss => `### ${ss.join(' and ')}\n\n${pairedTable(results, ss, 'asItStood', HEADLINE, BASELINES)}`).join('\n\n')}

## The moves

Both seasons. A week's moves against keeping the squad as it was, both held for the window (cut at GW${SEASON_GWS}),
less that week's hits: realised on actual points; expected on the projections made that week, whose slope against
the realised gain should be near 1. Sell regret: the most the same buy would have gained over five GWs with any
other legal sale, less this sale's (weeks with one move). Hit return: the gain before hits per point of hits, in
weeks whose every move was a hit. Points per free transfer: weeks without a hit. The slope is taken before hits.
These intervals treat each week's moves as independent, which they are not (the same buys recur across squads and
neighbouring weeks), so they are narrower than the truth; the paired season totals above are the verdict.

${moveTable(results, both, 'asItStood', ALL)}

## Risk 8: the mixed weight units

Long term and Future prep weigh a per-GW average and Funds and Structure a horizon total, yet all four are compared
against the same free-transfer value and hit (plan risk 8). Each re-run in the other unit, its gates in that unit
too, while the one-off terms stay as written (the free-transfer value, the hit, and lambda's money terms), less the
preset as written (points a season). The intervals are wide (about 50-100 points either way), so "no clear
difference" is not "no difference":

${[[HELD_OUT], both].map(ss => `### ${ss.join(' and ')}\n\n| variant | less the preset |\n|---|---|\n${RISK8.map(r => {
    const d = paired(results, ss, 'asItStood', r.name, r.mode);
    return `| ${r.name} | ${d ? `${ci(d, d.gws)} ${verdictOf(d) === 'no clear difference' ? '' : `**${verdictOf(d)}**`}` : '-'} |`;
  }).join('\n')}`).join('\n\n')}

## Several moves a week

Each mode, and the roll baseline, made a pick and then asked again on the new squad with one free transfer
fewer, until it rolled (at most ${MAX_PICKS} a week): the planner's cards used one after another. The engine's own
costs stop it - the free transfer's value, then the hit and its margin - so banked free transfers, and hits, come
into play (roll+ never takes a hit). Points a season:

${[[HELD_OUT], both].map(ss => `### ${ss.join(' and ')}\n\n${multiTable(results, ss, 'asItStood')}`).join('\n\n')}

## Which move, on the same squads

The verdict above mixes which move is made with whether one is made, and each policy's squad drifts its own way.
Here every week of the roll baseline's season, on roll's squad, each mode was asked for its one-move pick, and both
picks were scored over the next five GWs against keeping the squad (a roll scores 0). Per week; the interval
resamples squads and five-week blocks, both seasons. Expected (V) and own projected points: the same difference on
that week's projections, by the engine's measure and by roll's.

${shadowTable(results, both)}

## Ceiling's upper tail

Ceiling now scores a swap at its target GW by the change to the squad's 90th-percentile score over Monte Carlo draws
of the points model's parts (engine/ceiling.js), not by its expected points. Less Ceiling on the mean, both seasons:

${ceilingLines(results, both)}

${tuningSection(tune, tuned)}
${altSection(alt)}
## Sensitivity: the final schedule

The same runs with vaastav's final schedule, which knows every blank and double from the start (more than a manager
knew; the schedule as it stood knows less). Both seasons:

${pairedTable(results, both, 'final', HEADLINE, BASELINES)}

## The old engine

It budgets on current prices, not sell prices, and does not check the club limit, so its verdict was taken over the
legal swaps only, as if it had checked. It made ${sumCount('verdicts')} moves (both seasons, as it stood); in ${sumCount('illegal')} weeks its
unchecked verdict would have named a move FPL refuses. Its chip weeks (computeChipRecs), which can promote a lane,
were computed as its planner did, though no chip was played.

## Known handicaps

- Neither engine had Understat, which this environment cannot reach. The old engine read Understat's team and player
  xG in the live app; the new one reads none, so this costs the old engine more.
- No FPL status flags exist for past weeks, so every player reads available: Structure runs without its main signal,
  and both engines miss injury news a manager had.
- No price signals: vaastav's weekly transfer counts are recorded after the deadline. PriceTerm is zero for every move.
- No chips, for anyone.
- Every policy makes at most one move a week (Funds two, with its chained move), so free transfers banked past one go
  unused: in ${HELD_OUT}, after the AFCON top-up, every policy sits at the cap of five from GW16, where a move costs
  nothing and a threshold of zero is all it must clear. With one free transfer always in hand, no policy can take a
  hit except Funds' second move.
- A player whose club has no fixture in a week has no vaastav row for it, so his price that week is his last one.

Worker time: ${f(sum(results.map(r => r.ms)) / 60000)} minutes over ${results.length} tasks.
`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const seasons = await Promise.all(SEASONS.map(n => loadSeason(n)));
  const squadsBySeason = Object.fromEntries(RUN_SEASONS.map(n => [n, startingSquads(seasons.find(s => s.name === n))]));
  if (argv.includes('--report')) {
    await writeReport(squadsBySeason);
    return;
  }
  const oldAt = argv.indexOf('--old');
  if (oldAt < 0 || !argv[oldAt + 1]) {
    throw new Error('run.js: pass --old <worktree>/projects/apps/gaffer-iq (git worktree add --detach <worktree> 3aa8f3a)');
  }
  const oldDir = path.resolve(argv[oldAt + 1]);
  const quick = argv.includes('--quick');
  const tasks = [];
  for (const schedule of SCHEDULES) {
    for (const season of RUN_SEASONS) {
      for (const squad of squadsBySeason[season]) {
        tasks.push({
          season, schedule, squad, toGw: SEASON_GWS, variants: VARIANTS, shadow: schedule === 'asItStood',
          policies: schedule === 'final' ? ALL_POLICIES.filter(p => HEADLINE.includes(p.name)) : ALL_POLICIES,
        });
      }
    }
  }
  let stage = 'results';
  let stageTasks = tasks;
  if (argv.includes('--tune')) {
    const variants = { ...VARIANTS, ...Object.fromEntries(TUNING.map(t => [t.variant, t.overrides])) };
    stage = 'tune';
    stageTasks = squadsBySeason[TUNE_SEASON].map(squad => ({
      season: TUNE_SEASON, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants, shadow: false,
      policies: [...SINGLE, ...tuningPolicies()],
    }));
  } else if (argv.includes('--alt')) {
    stage = 'alt';
    stageTasks = RUN_SEASONS.flatMap(season => squadsBySeason[season].map(squad => ({
      season, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants: VARIANTS, shadow: false,
      policies: [...BASE.filter(p => p.name === 'roll'), ...ALL_POLICIES.filter(p => p.name === 'longterm' || p.name === 'longterm+'), ...ALT],
    })));
  } else if (argv.includes('--test-tuned')) {
    const tune = await readStage('tune');
    if (!tune) throw new Error('run.js: run --tune first');
    const { overrides, chosen } = tuningChoices(tune.results);
    if (!chosen.length) {
      console.log('run.js: the sweep chose nothing, so the tuned presets are the presets as written: nothing to test');
      return;
    }
    const asWritten = [...SINGLE, ...MULTI.filter(p => p.kind === 'engine')];
    stage = 'tuned';
    stageTasks = squadsBySeason[HELD_OUT].map(squad => ({
      season: HELD_OUT, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants: { ...VARIANTS, tuned: overrides }, shadow: false,
      policies: [...asWritten, ...asWritten.map(p => ({ ...p, name: `${p.name} (tuned)`, variant: 'tuned' }))],
    }));
  }
  if (quick) {
    // Two squads on two workers, so the pool's hand-over and shutdown run too.
    const short = stageTasks.filter(t => t.schedule === 'asItStood' && (stage !== 'results' || t.season === HELD_OUT)).slice(0, 2)
      .map(t => ({ ...t, toGw: START_GW + QUICK_GWS - 1 }));
    const [result] = (await runPool(short, oldDir, short.length)).sort((a, b) => a.squad - b.squad);
    for (const [name, run] of Object.entries(result.out)) {
      console.log(name.padEnd(36), String(run.total).padStart(5), run.gws.map(g => `${g.points}-${g.hits}/${g.moves}`).join(' '),
        run.counts ? JSON.stringify(run.counts) : '');
    }
    // The report's own code on these few weeks, so a full run cannot die at its end.
    const md = stage === 'results' ? report([result], squadsBySeason)
      : stage === 'alt' ? altSection([result])
        : tuningSection(stage === 'tune' ? [result] : (await readStage('tune')).results, stage === 'tuned' ? [result] : null);
    console.log(stage === 'results' ? md.slice(md.indexOf('## Several moves'), md.indexOf('## Sensitivity')) : md);
    console.log(`${Math.round(result.ms / 1000)}s, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB (main)`);
    return;
  }
  await runStage(stage, stageTasks, oldDir, argv);
  await writeReport(squadsBySeason);
}

/**
 * A stage's tasks on the worker pool: each result appended to
 * data/<stage>-partial.jsonl as it lands (so a run that dies keeps them, and
 * --resume runs only the rest), then all saved to data/<stage>.json.
 */
async function runStage(stage, tasks, oldDir, argv) {
  const resume = argv.includes('--resume');
  const done = resume ? await readPartial(stage) : [];
  const keyOf = t => `${t.season}|${t.schedule}|${t.squad.index ?? t.squad}`;
  const have = new Set(done.map(keyOf));
  if (!resume) await writeFile(partialOf(stage), '');
  const fresh = await runPool(tasks.filter(t => !have.has(keyOf(t))), oldDir, os.availableParallelism(),
    r => appendFileSync(partialOf(stage), `${JSON.stringify(r)}\n`));
  await writeFile(stageFile(stage), JSON.stringify({ results: [...done, ...fresh] }));
}

const stageFile = stage => new URL(`./data/${stage}.json`, import.meta.url);
const partialOf = stage => new URL(`./data/${stage}-partial.jsonl`, import.meta.url);
const readStage = async stage => JSON.parse(await readFile(stageFile(stage), 'utf8').catch(() => 'null'));

async function readPartial(stage) {
  const text = await readFile(partialOf(stage), 'utf8').catch(() => '');
  // A run killed mid-write leaves a last line cut short: that task runs again.
  return text.split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function writeReport(squadsBySeason) {
  const [main, tune, tuned, alt] = await Promise.all(['results', 'tune', 'tuned', 'alt'].map(readStage));
  if (!main) throw new Error('run.js: no data/results.json yet - run the backtest first');
  const md = report(main.results, squadsBySeason,
    { tune: tune?.results ?? null, tuned: tuned?.results ?? null, alt: alt?.results ?? null });
  await writeFile(new URL('../../docs/decision-engine-backtest.md', import.meta.url), md);
  console.log(md.slice(0, md.indexOf('## What was run')));
}

if (isMainThread) await main();
else await workerMain(workerData);
