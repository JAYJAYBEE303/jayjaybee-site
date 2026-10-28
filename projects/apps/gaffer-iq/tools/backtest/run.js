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
 * the values it chose on 2025-26 (data/tuned.json); --tune-multi runs the
 * sweep several moves a week (data/tune-multi.json); --alt runs Long term's
 * alternative preset (data/alt.json); --merge re-runs MERGE's policies into
 * data/results.json; --milp runs the MILP referee (Phase 8, data/milp.json);
 * --solver-repro runs the app's own solver path set as that referee was
 * (solver plan Phase 3, data/solver-repro.json). The report includes each once it exists.
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
import { readFile, rm, writeFile } from 'node:fs/promises';
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
  GAIN_WINDOWS, engineInput, enginePolicy, moveMetrics, pairedBootstrap, pickSquad, randomSquad, rollPolicy, scoreGameweek,
  simulateAll, slopeInterval, squadState,
} from './lib.js';
import { pointsModelAt } from '../points/model.js';
import { RETRY_TIME, loadSolver, milpPolicy, milpProblem, newCounts, orderMoves, solvePlan } from './milp.js';
import { REPRO, agrees, solverPolicy } from './solver.js';

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

// The units. Since the solver plan's scale fix (its Phase 1) every preset is a
// horizon total. `averaged` is Long term and Future prep as they were before
// it: the brief's per-GW averages (÷ 3, ÷ 4.25), with lambda and Future prep's
// deferral epsilon on that scale (0.10, 0.15, 0.1), so the fix is judged
// against them on the same squads. `normalised` is plan risk 8's other unit for
// Funds and Structure: their weights summing to 1, a gate stated in the mode's
// own units (Funds' tau and eps) moving with them and the one-off terms (the
// free-transfer value, the hit, lambda's money terms) as written. Structure's
// dead-slot penalty never fires here (no status flags), so it is left alone.
const DM = DECISION_ENGINE.modes;
const decayWeights = DM.now.weights.map((_, k) => DECISION_ENGINE.decayBase ** k);
const largest = ws => Math.max(...ws);
const total = ws => ws.reduce((a, w) => a + w, 0);
const toNormalised = 1 / total(decayWeights);

/** DECISION_ENGINE with plain-JSON overrides laid over it, each mode merged on its own (tasks carry them to workers). */
const configWith = (overrides = {}) => ({
  ...DECISION_ENGINE, ...overrides,
  modes: Object.fromEntries(Object.entries(DECISION_ENGINE.modes).map(([id, m]) => [id, { ...m, ...overrides.modes?.[id] }])),
});
const VARIANTS = {
  asWritten: {},
  averaged: { modes: {
    longterm: { weights: DM.longterm.weights.map(w => w / total(DM.longterm.weights)), lambda: DM.longterm.lambda / total(DM.longterm.weights) },
    future: { weights: DM.future.weights.map(w => w / total(DM.future.weights)), lambda: DM.future.lambda / total(DM.future.weights),
      deferralEpsilon: DM.future.deferralEpsilon / total(DM.future.weights) },
  } },
  normalised: { modes: {
    funds: { weights: decayWeights.map(w => w * toNormalised), tau: DM.funds.tau * toNormalised, eps: DM.funds.eps * toNormalised },
    structure: { weights: DM.structure.weights.map(w => w / total(DM.structure.weights)) },
  } },
  ceilingMean: { modes: { ceiling: { tail: null } } },
  // The brief's alternative for Long term (§6): decay 0.85 over five GWs, as a per-GW average like the preset was
  // when --alt ran (before the solver plan's scale fix).
  longtermDecay: { modes: { longterm: { weights: decayWeights.map(w => w * toNormalised) } } },
};

// A policy: kind none | roll | old | engine; an engine policy plays one mode
// of one config variant; picks above one ask again on the new squad (lib.js).
const MAX_PICKS = 5;
const policy = (name, kind, extra = {}) => ({ name, kind, variant: 'asWritten', picks: 1, ...extra });
const BASE = [policy('none', 'none'), policy('roll', 'roll'), policy('old', 'old')];
const SINGLE = MODES.map(mode => policy(mode, 'engine', { mode }));
const RISK8 = [
  policy('longterm (averaged)', 'engine', { variant: 'averaged', mode: 'longterm', preset: 'longterm' }),
  policy('future (averaged)', 'engine', { variant: 'averaged', mode: 'future', preset: 'future' }),
  policy('funds (normalised)', 'engine', { variant: 'normalised', mode: 'funds', preset: 'funds' }),
  policy('structure (normalised)', 'engine', { variant: 'normalised', mode: 'structure', preset: 'structure' }),
];
// The scale fix's "before", several moves a week too.
const AVERAGED_MULTI = ['longterm', 'future'].map(mode => policy(`${mode}+ (averaged)`, 'engine',
  { variant: 'averaged', mode, preset: `${mode}+`, picks: MAX_PICKS }));
// Several moves a week: the roll baseline and each mode, as the planner is used.
const MULTI = [policy('roll+', 'roll', { picks: MAX_PICKS }),
  ...MODES.map(mode => policy(`${mode}+`, 'engine', { mode, picks: MAX_PICKS }))];
// Ceiling on its mean at t*, as before Phase 7b's upper tail.
const CEILING_MEAN = policy('ceiling (mean)', 'engine', { variant: 'ceilingMean', mode: 'ceiling' });
const BASELINES = BASE.map(p => p.name);
const HEADLINE = [...BASELINES, ...MODES];
const ALL_POLICIES = [...BASE, ...SINGLE, ...RISK8, ...MULTI, ...AVERAGED_MULTI, CEILING_MEAN];
const ALL = ALL_POLICIES.map(p => p.name);
// What --merge re-runs after a change that touches only these: the solver plan's Phase 2 (Ceiling reads its upper tail
// only in a big week), one move and several, and the shadow on roll's path. Phase 1's scale fix was merged the same way.
const MERGE = new Set(['ceiling', 'ceiling+']);
// The brief's alternative preset for Long term, one move and several (--alt), beside the preset as written.
const ALT = [policy('longterm (decay)', 'engine', { mode: 'longterm', variant: 'longtermDecay' }),
  policy('longterm+ (decay)', 'engine', { mode: 'longterm', variant: 'longtermDecay', picks: MAX_PICKS })];

// ─── The MILP referee (Phase 8) ──────────────────────────────────────────────

// Funds' decay over five GWs, as a horizon total: points and hits in one unit. Per position, the 20 best others by
// weighted points and the 10 best by weighted points a tenth. A solve stops within MILP_TIE points of its bound
// (closing the rest takes several times as long here), or at its time limit with its best plan, flagged.
const MILP = { weights: decayWeights, pool: { points: 20, pointsPerTenth: 10 } };
const MILP_TIE = 0.5;   // points: two plans closer than the solver's tolerance are a tie
const SOLVER = { time_limit: 10, mip_abs_gap: MILP_TIE };
// Chip timing over the engine's own chip window (chipHints), every week weighted alike as the hints are.
const CHIP_MILP = { ...MILP, weights: Array.from({ length: DECISION_ENGINE.horizonGws }, () => 1) };
const CHIPS = ['benchboost', 'triplecaptain'];
const HELD = { points: 0, pointsPerTenth: 0 };   // a pool of none: the squad as it stands
// A solve takes seconds, so the referee reads one week in three of roll's season, and the chips one in six.
// The referee's measures over those weeks resample them in blocks of BOOT.block entries (fifteen GWs).
const REFEREE_EVERY = 3;
const CHIP_EVERY = 6;
const MILP_POLICIES = [policy('milp', 'milp')];
// The app's solver path set as the referee was (solver.js), on the same squads, to be paired with data/milp.json.
const SOLVER_REPRO = 'solver-repro';
const REPRO_POLICIES = [policy(SOLVER_REPRO, 'solver')];
const REFEREE_RIVALS = ['roll+', ...MODES.map(m => `${m}+`)];

// ─── Tuning (Phase 7b) ───────────────────────────────────────────────────────
//
// One-at-a-time departures from the presets as written, each run on the modes
// it touches, one move a week, over TUNE_SEASON; a value is chosen when it
// gains at least TUNE_MATERIAL points a season on average over those modes,
// and the choices together are then tested on the held-out season. The mode
// weights stay as written (Q6).
const TUNE_SEASON = '2024-25';
const TUNE_MATERIAL = 10;
const TUNE_MULTI = new Set(['free-transfer value', 'hit margin']);
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
].map(t => ({ ...t, variant: `${t.param} ${t.value}`, multiModes: TUNE_MULTI.has(t.param) ? MODES : [] }));
const tuningPolicies = () => TUNING.flatMap(t => t.modes.map(mode => policy(`${mode} @ ${t.variant}`, 'engine', { mode, variant: t.variant })));
// The same sweep, several moves a week (--tune-multi), for the values that act through several moves: the
// free transfer's value and the hit's margin (one move a week takes a hit only in Funds' chain).
const tuningMultiPolicies = () => [...MULTI.filter(p => p.kind === 'engine'), ...TUNING.flatMap(t => t.multiModes.map(mode =>
  policy(`${mode}+ @ ${t.variant}`, 'engine', { mode, variant: t.variant, picks: MAX_PICKS })))];

/** Two overrides objects as one, modes merged. */
const merged = (a, b) => ({ ...a, ...b, modes: Object.fromEntries([...new Set([...Object.keys(a.modes ?? {}), ...Object.keys(b.modes ?? {})])]
  .map(m => [m, { ...a.modes?.[m], ...b.modes?.[m] }])) });

/**
 * Each sweep value's mean paired gain over the policies it touches - its
 * modes one move a week, and several a week where swept - and the choice per parameter.
 */
function tuningChoices(tune, tuneMulti = null) {
  const gainOf = (results, a, b) => {
    const r = paired(results, [TUNE_SEASON], 'asItStood', a, b);
    return r ? r.mean * r.gws : NaN;
  };
  const rows = TUNING.map(t => {
    const gains = t.modes.map(mode => gainOf(tune, `${mode} @ ${t.variant}`, mode));
    const multiGains = tuneMulti ? t.multiModes.map(mode => gainOf(tuneMulti, `${mode}+ @ ${t.variant}`, `${mode}+`)) : [];
    return { ...t, gains, multiGains, gain: mean([...gains, ...multiGains]) };
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
    engine: memo((variant, t, state, locks, bans) => calls(runDecisionEngine(engineInput(world.at(t), t, state, locks, bans),
      configs.get(variant), decisionCache(t, state.squad.map(p => p.id)))),
    (variant, t, state, locks, bans) => `${variant}|${t}|${stateKey(state)}|${idsKey(locks)}|${idsKey(bans)}`),
  };
}

const moveOf = m => m && { outId: m.outId, inId: m.inId, chained: moveOf(m.chained) };
const calls = result => ({
  modes: Object.fromEntries(Object.entries(result.modes).map(([id, m]) => [id, { call: m.call, root: moveOf(m.root) }])),
  chips: Object.fromEntries(Object.entries(result.chipHints).map(([chip, hint]) => [chip, hint?.gw ?? null])),
});

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

function policyFor(spec, old, solver) {
  if (spec.kind === 'none') return { decide: () => ({ moves: [] }) };
  if (spec.kind === 'roll') return rollPolicy({ ...ROLL, maxBankedFt: DECISION_ENGINE.maxBankedFt, maxPicks: spec.picks });
  if (spec.kind === 'old') return oldPolicy(old);
  if (spec.kind === 'milp') return milpPolicy(solver, MILP);
  if (spec.kind === 'solver') return solverPolicy(solver.highs, REPRO);
  return enginePolicy(spec.mode, ({ t, state, world, locks, bans }) => world.engine(spec.variant, t, state, locks, bans),
    { maxPicks: spec.picks });
}

/**
 * A week's moves on roll's squad that week (a week of its run, g), scored on
 * what happened over the next five GWs (cut at the season's end) against
 * keeping the squad, less hits; also on that week's projections (V), and on
 * the players' own projected points.
 */
function scoreMoves(world, g, toGw, moves) {
  const window = Array.from({ length: Math.min(5, toGw - g.t + 1) }, (_, i) => g.t + i);
  const own = id => sum(world.at(g.t).projections.get(id).gws.slice(0, window.length).map(x => x.xpts));
  const after = moves.reduce((ids, m) => ids.map(id => (id === m.outId ? m.inId : id)), g.before);
  const hits = Math.max(0, moves.length - g.ft) * DECISION_ENGINE.hitCost;
  return {
    moves: moves.length,
    realised: sum(window.map(u => world.gwPoints(after, u) - world.gwPoints(g.before, u))) - hits,
    expected: sum(window.map(u => world.expectedPoints(after, u, g.t) - world.expectedPoints(g.before, u, g.t))) - hits,
    own: sum(moves.map(m => own(m.inId) - own(m.outId))),
    key: moves.map(m => `${m.outId}>${m.inId}`).join(','),
  };
}

/**
 * Which move, on the same squads: each week of the roll baseline's season,
 * every mode is also asked for its pick on roll's squad, and both picks are
 * scored on what happened over the next five GWs (cut at the season's end)
 * against keeping the squad, less hits; a roll scores 0. Also each pick's
 * gain on that week's projections (V) and on its players' own points.
 */
function shadowOf(world, run, toGw) {
  return run.gws.map(g => {
    const score = moves => scoreMoves(world, g, toGw, moves);
    const result = world.engine('asWritten', g.t, { ...g.stateBefore, ft: g.ft }, new Set(), new Set());
    return {
      t: g.t, ft: g.ft, roll: score(g.moves),
      modes: Object.fromEntries(MODES.map(mode => {
        const m = result.modes[mode];
        return [mode, score(m.call === 'move' ? [m.root, m.root.chained].filter(Boolean) : [])];
      })),
    };
  });
}

/** The same sales and the same buys, however they are paired. */
const setKey = moves => ['outId', 'inId'].map(side => moves.map(m => m[side]).sort((a, b) => a - b).join(',')).join('|');

/**
 * The MILP referee on the same squads (Phase 8): every REFEREE_EVERY-th week
 * of the roll baseline's season, on its squad, the first week of the
 * referee's plan against each several-moves policy's week (roll+ and every
 * mode+), scored as scoreMoves does, with what that week costs on the
 * referee's own objective (its best plan with that first week fixed, less its
 * free plan). Every CHIP_EVERY-th week, the chips: for each, the referee's
 * best plan with the chip in each GW of the window (so its best week, and
 * what the engine's chipHints week costs), and the weeks it picks for both
 * with the squad held as it is.
 */
function refereeOf(world, run, toGw, solver) {
  const counts = newCounts();
  const engine = ({ t, state, locks, bans }) => world.engine('asWritten', t, state, locks, bans);
  const rivals = {
    'roll+': rollPolicy({ ...ROLL, maxBankedFt: DECISION_ENGINE.maxBankedFt, maxPicks: MAX_PICKS }),
    ...Object.fromEntries(MODES.map(mode => [`${mode}+`, enginePolicy(mode, engine, { maxPicks: MAX_PICKS })])),
  };
  const weeks = run.gws.filter(g => (g.t - START_GW) % REFEREE_EVERY === 0).map(g => {
    const state = { ...g.stateBefore, ft: g.ft };
    const stoppedBefore = counts.stopped;
    const plan = opts => solvePlan(solver, milpProblem(world, g.t, state, opts), counts);
    // Each chip in each GW of the window in turn: its best week, and what the hint's week costs.
    const chipCheck = (hints, gws, chip, pool) => {
      const values = gws.map(gw => plan({ ...CHIP_MILP, pool, chips: { [chip]: true }, fixed: { [chip]: gw } }).objective);
      const best = Math.max(...values);
      const hinted = gws.indexOf(hints[chip]);
      return { week: gws[values.indexOf(best)], cost: hinted < 0 ? null : best - values[hinted] };
    };
    const chips = () => {
      const stoppedAt = counts.stopped;
      const hints = engine({ t: g.t, state, locks: new Set(), bans: new Set() }).chips;
      const gws = CHIP_MILP.weights.map((_, k) => g.t + k).filter(gw => gw <= toGw);
      const out = Object.fromEntries(CHIPS.map(chip => {
        const withTransfers = chipCheck(hints, gws, chip, CHIP_MILP.pool);
        const held = chipCheck(hints, gws, chip, HELD);
        return [chip, { engine: hints[chip], milp: withTransfers.week, cost: withTransfers.cost, held: held.week, heldCost: held.cost }];
      }));
      return { ...out, stopped: counts.stopped > stoppedAt };
    };
    // Every policy's buys join the referee's pool, so its free plan and each policy's fixed week choose from the same players.
    const moves = Object.fromEntries(Object.entries(rivals).map(([name, p]) => [name, p.decide({ t: g.t, state, world }).moves]));
    const include = [...new Set(Object.values(moves).flatMap(ms => ms.map(m => m.inId)))];
    const free = plan({ ...MILP, include });
    const mine = orderMoves(state, free.weeks[0].in, free.weeks[0].out, world, g.t);
    if (mine.length < free.weeks[0].in.length) counts.unordered += 1;
    const rivalsOut = Object.fromEntries(Object.entries(moves).map(([name, ms]) => {
      const same = setKey(ms) === setKey(mine);
      const fixed = { first: { in: ms.map(m => m.inId), out: ms.map(m => m.outId) } };
      const cost = same ? 0 : free.objective - plan({ ...MILP, include, fixed }).objective;
      return [name, { ...scoreMoves(world, g, toGw, ms), same, cost }];
    }));
    return {
      t: g.t, ft: g.ft,
      milp: { ...scoreMoves(world, g, toGw, mine), plan: free.weeks.map(w => w.in.length) },
      rivals: rivalsOut,
      stopped: counts.stopped > stoppedBefore,
      chips: (g.t - START_GW) % CHIP_EVERY === 0 ? chips() : null,
    };
  });
  return { weeks, counts };
}

function runTask(world, task, old, solver) {
  const started = Date.now();
  const taskWorld = forTask(world, task.variants);
  const start = {
    squad: task.squad.ids.map(id => ({ id, purchaseTenths: world.priceTenths(id, START_GW) })),
    bankTenths: BUDGET_TENTHS - task.squad.costTenths,
    ft: 1,
  };
  const opts = { fromGw: START_GW, toGw: task.toGw, maxBankedFt: DECISION_ENGINE.maxBankedFt, hitCost: DECISION_ENGINE.hitCost };
  const policies = Object.fromEntries(task.policies.map(spec => [spec.name, policyFor(spec, old, solver)]));
  const runs = simulateAll(taskWorld, start, policies, opts);
  const out = {};
  for (const [name, run] of Object.entries(runs)) {
    out[name] = {
      total: run.total,
      gws: run.gws.map(g => ({ t: g.t, points: g.points, hits: g.hits, ft: g.ft, moves: g.moves.length, lostFt: g.lostFt })),
      metrics: moveMetrics(run, taskWorld, opts).map(m => ({ ...m, moves: m.moves.length })),
      counts: policies[name].counts ?? null,
      log: policies[name].log ?? null,
    };
  }
  const shadow = task.shadow && runs.roll ? shadowOf(taskWorld, runs.roll, task.toGw) : null;
  const referee = task.referee && runs.roll ? refereeOf(taskWorld, runs.roll, task.toGw, solver) : null;
  return { season: task.season, schedule: task.schedule, squad: task.squad.index, label: task.squad.label, out, shadow, referee,
    ms: Date.now() - started };
}

// ─── Workers ─────────────────────────────────────────────────────────────────

async function workerMain({ oldDir }) {
  const seasons = await Promise.all(SEASONS.map(n => loadSeason(n)));
  const old = await loadOldEngine(oldDir);
  const solver = await loadSolver(SOLVER);
  let world = null;
  parentPort.on('message', task => {
    try {
      if (world?.key !== `${task.season}|${task.schedule}`) world = buildWorld(seasons, task.season, task.schedule, old);
      parentPort.postMessage({ ok: true, result: runTask(world, task, old, solver) });
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
    const hitWeeks = ms.filter(m => m.hit > 0);
    const freeWeeks = ms.filter(m => m.hit === 0);
    return [`| ${p} | ${ms.length} | ${GAIN_WINDOWS.map(k => ci(rtg[k], 1, 2)).join(' | ')} | ${f(mean(ms.map(m => m.expected[5])), 2)}`
      + ` | ${f(fit.slope, 2)} [${f(fit.lo, 2)}, ${f(fit.hi, 2)}] | ${f(mean(regrets), 2)} | ${hitWeeks.length}`
      + ` | ${hitWeeks.length ? f(mean(hitWeeks.map(m => (m.realised[5] + m.hits) / m.hits)), 2) : '-'}`
      + ` | ${f(freeWeeks.reduce((a, m) => a + m.realised[5], 0) / freeWeeks.reduce((a, m) => a + m.free, 0), 2)} |`];
  });
  return ['| policy | weeks with moves | realised gain, 1 GW | 3 GWs | 5 GWs | expected, 5 GWs | slope of realised on expected (5 GWs)'
    + ' | sell regret | weeks with a hit | return per hit point | points per free transfer |',
  '|---|---|---|---|---|---|---|---|---|---|---|', ...lines].join('\n');
}

const AGAINST = { roll: 'the roll baseline', 'roll+': 'roll+ (the roll baseline, several moves a week)', old: 'the old engine',
  none: 'no transfers' };

/** One line per baseline: each mode's paired season difference and its verdict; then any verdict longer blocks change. */
const labelOf = name => (name.endsWith('+') ? `${DECISION_ENGINE.modes[name.slice(0, -1)]?.label ?? name.slice(0, -1)}+`
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
  if (units.length && rows === MODES) lines.push(`- **Each preset in the other unit, less as it is now** (Long term and Future prep averaged as before the scale fix; Funds and Structure normalised): ${units.join('; ')}.`);
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
  return [[HELD_OUT], seasons].map(ss => {
    const lines = ceilingFor(results, ss);
    return lines ? `${ss.join(' and ')}:\n\n${lines}` : '';
  }).filter(Boolean).join('\n\n');
}

function ceilingFor(results, seasons) {
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
    `| ${ss.join(' and ')} | several | ${cell(ss, 'longterm+ (decay)', 'longterm+')} | ${cell(ss, 'longterm+ (decay)', 'roll+')} |`]);
  return `## Long term's alternative: decay 0.85 over five GWs

Run before the solver plan's scale fix, on the averaged presets of the time (data/alt.json).
The brief gives Long term "[1,1,1,0,0] / 3, or decay 0.85"; the preset is the first (Q6). The second, as a per-GW
average like the first, run on the same squads (points a season):

| seasons | moves a week | less the preset as written | less the roll baseline (roll+ for several) |
|---|---|---|---|
${rows.join('\n')}
`;
}

/**
 * The scale fix (solver plan Phase 1), after less before: each changed mode as a total less its averaged preset, one
 * move a week and several, points a season paired, on 2025-26 and both seasons; then every mode's transfers a
 * season (the four the fix does not touch are the same runs either side).
 */
function scaleFixSection(results) {
  const pairs = [['longterm', 'longterm (averaged)'], ['future', 'future (averaged)'],
    ['longterm+', 'longterm+ (averaged)'], ['future+', 'future+ (averaged)']];
  const cell = (ss, a, b) => {
    const r = paired(results, ss, 'asItStood', a, b);
    return r ? `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}` : '-';
  };
  const transfers = (season, name) => {
    const runs = of(results, season, 'asItStood').map(r => r.out[name]).filter(Boolean);
    return runs.length ? f(mean(runs.map(r => r.gws.reduce((a, g) => a + g.moves, 0)))) : '-';
  };
  const before = name => pairs.find(([a]) => a === name)?.[1] ?? name;
  const rows = [...MODES, ...MODES.map(m => `${m}+`)];
  return [
    `After less before (points a season; "worse" only where the interval is wholly below zero):`, '',
    `| mode | ${HELD_OUT} | ${RUN_SEASONS.join(' and ')} |`, '|---|---|---|',
    ...pairs.map(([a, b]) => `| ${labelOf(a)} | ${cell([HELD_OUT], a, b)} | ${cell(RUN_SEASONS, a, b)} |`), '',
    'Transfers a season, before and after (means over the squads):', '',
    `| mode | ${RUN_SEASONS.map(s => `${s} before | ${s} after`).join(' | ')} |`,
    `|---|${RUN_SEASONS.map(() => '---|---').join('|')}|`,
    ...rows.map(m => `| ${labelOf(m)} | ${RUN_SEASONS.map(s => `${transfers(s, before(m))} | ${transfers(s, m)}`).join(' | ')} |`),
  ].join('\n');
}

/** data/milp.json laid over data/results.json, task by task: the referee's season beside the others, and its weeks. */
function withMilp(results, milp) {
  const key = r => `${r.season}|${r.schedule}|${r.squad}`;
  const byKey = new Map(milp.map(r => [key(r), r]));
  return results.filter(r => byKey.has(key(r))).map(r => {
    const m = byKey.get(key(r));
    // Its roll re-ran the main run's: if they differ, the two files are from different code.
    if (m.out.roll.total !== r.out.roll.total) throw new Error(`run.js: ${key(r)}: data/milp.json's roll is not data/results.json's`);
    return { ...r, out: { ...r.out, milp: m.out.milp }, referee: m.referee, ms: m.ms };
  });
}

const refereeWeeks = (results, seasons) => seasons.flatMap(s => of(results, s, 'asItStood')).flatMap(r => r.referee?.weeks ?? []);
const share = (xs, keep) => (xs.length ? `${f((xs.filter(keep).length / xs.length) * PERCENT, 0)}%` : '-');

/**
 * The referee's first week against each several-moves policy's, on roll's squads (refereeOf): how often they make
 * the same moves, the weeks it makes two or more, what the policy's week costs on the referee's objective (over the
 * weeks whose solves all reached the tolerance) and how often that is within it, and the two weeks realised over
 * five GWs (per week; squads and blocks of referee weeks resampled).
 */
function refereeTable(results, seasons) {
  const weeks = refereeWeeks(results, seasons);
  if (!weeks.length) return '';
  const solved = weeks.filter(w => !w.stopped);
  const lines = REFEREE_RIVALS.map(name => {
    const strata = seasons.map(season => of(results, season, 'asItStood').filter(r => r.referee)
      .map(r => r.referee.weeks.map(w => w.milp.realised - w.rivals[name].realised))).filter(m => m.length);
    const realised = pairedBootstrap(strata, BOOT);
    const several = weeks.filter(w => w.milp.moves >= 2);
    return `| ${labelOf(name)} | ${weeks.length} | ${share(weeks, w => w.rivals[name].same)}`
      + ` | ${f(mean(weeks.map(w => w.milp.moves)), 2)} / ${f(mean(weeks.map(w => w.rivals[name].moves)), 2)}`
      + ` | ${several.length} (${share(several, w => w.rivals[name].moves >= 2)})`
      + ` | ${f(mean(solved.map(w => w.rivals[name].cost)), 2)} | ${share(solved, w => w.rivals[name].cost <= MILP_TIE)}`
      + ` | ${ci(realised, 1, 2)}${verdictOf(realised) === 'no clear difference' ? '' : ` **${verdictOf(realised)}**`}`
      + ` | ${signed(mean(weeks.map(w => w.milp.expected - w.rivals[name].expected)), 2)} |`;
  });
  return [`${solved.length} of the ${weeks.length} weeks had every solve reach the tolerance; the cost columns read those.`, '',
    '| policy | weeks | same moves as the referee | moves a week (referee / policy) | weeks the referee makes 2+'
    + ' (the policy too) | the policy\'s week costs the referee\'s plan | within the tolerance | referee\'s week less the'
    + ' policy\'s, realised over 5 GWs | expected (V) |', '|---|---|---|---|---|---|---|---|---|', ...lines].join('\n');
}

/**
 * Bench Boost and Triple Captain (refereeOf's chip weeks whose solves all reached the tolerance): how often the
 * hint's week is as good as the referee's best, planned with transfers and with the squad held, how far apart they
 * are, and what the hint's week costs.
 */
function chipTable(results, seasons) {
  const all = refereeWeeks(results, seasons).filter(w => w.chips);
  const weeks = all.filter(w => !w.chips.stopped);
  if (!all.length) return '';
  const lines = CHIPS.map(chip => {
    const hinted = weeks.map(w => w.chips[chip]).filter(c => c.engine !== null);
    return `| ${CHIP_LABEL[chip]} | ${hinted.length} | ${share(hinted, c => c.cost <= MILP_TIE)} | ${f(mean(hinted.map(c => c.cost)), 2)}`
      + ` | ${signed(mean(hinted.map(c => c.milp - c.engine)), 2)} | ${share(hinted, c => c.heldCost <= MILP_TIE)}`
      + ` | ${f(mean(hinted.map(c => c.heldCost)), 2)} |`;
  });
  return [`${weeks.length} of the ${all.length} chip weeks had every solve reach the tolerance; the table reads those.`, '',
    '| chip | weeks with a hint | with transfers: the hint\'s week as good as the referee\'s | what it costs | the referee\'s'
    + ' week less the hint\'s, GWs | with the squad held: as good | what it costs |', '|---|---|---|---|---|---|---|', ...lines]
    .join('\n');
}
const CHIP_LABEL = { benchboost: 'Bench Boost', triplecaptain: 'Triple Captain' };

/** The MILP referee (Phase 8): its own season, its plans against the engine's on the same squads, and chip timing. */
function milpSection(results) {
  if (!results?.some(r => r.out.milp)) return '';
  const both = RUN_SEASONS;
  const cell = (ss, b) => {
    const r = paired(results, ss, 'asItStood', 'milp', b);
    return r ? `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}` : '-';
  };
  const rivals = ['roll+', 'old', 'none', ...MODES.map(m => `${m}+`)].filter(b => results[0].out[b]);
  const counts = results.flatMap(r => [r.out.milp.counts, r.referee?.counts]).filter(Boolean);
  const total = k => sum(counts.map(c => c[k]));
  return `## The MILP referee

A mixed-integer program (\`js/engine/solver/model.js\`, solved by HiGHS, npm \`highs\`, MIT) plans transfers over the next
${MILP.weights.length} GWs on the engine's own projections: each week's squad (2/5/5/3, three a club), XI, captain and bench
order, the bank at sell prices, free transfers banked to the cap and hits past them. It maximises the weighted expected
points of the XI and captain plus the bench at the engine's linear autosub weights, less hits, with Funds' decay
(${DECISION_ENGINE.decayBase} a GW) as a horizon total, so points and hits share a unit. It sees a chain of moves across
weeks, which the pairwise engine does not. Its candidates are the owned squad plus, per position, the
${MILP.pool.points} best others by weighted points and the ${MILP.pool.pointsPerTenth} best by weighted points a tenth.
The formulation follows the shape of open-fpl-solver (Sertalp B. Cay, Apache-2.0); no code is taken from it. HiGHS
stops each solve within ${MILP_TIE} points of the best plan, or at ${SOLVER.time_limit} s with the best plan it has found
(counted below). It is a second opinion, not the truth: it trusts the projections fully, plans the bench linearly and
knows nothing of 2025-26's free-transfer top-up before it happens (nor does the engine).

### Its own season, several moves a week (${HELD_OUT})

Each week it made the first week of its plan, re-planned the next. On the same squads as the main run:

${seasonTable(results, HELD_OUT, 'asItStood', ['milp', ...rivals])}

The referee less each policy, points a season:

| policy | ${HELD_OUT} | ${both.join(' and ')} |
|---|---|---|
${rivals.map(b => `| ${b} | ${cell([HELD_OUT], b)} | ${cell(both, b)} |`).join('\n')}

### Its first week against each policy's, on the same squads

One week in ${REFEREE_EVERY} of the roll baseline's season, on roll's squad, the first week of the referee's plan against the moves each
several-moves policy made from the same state. "Same moves": the same sales and the same buys. "Costs the referee's
plan": the referee's best plan with that policy's week fixed, less its free plan, on its own objective (expected
points; zero where they agree; every policy's buys are in the referee's pool that week, so both plans choose from the
same players), and how often that is within the solver's tolerance. Realised: both weeks held for five GWs against
keeping the squad, less hits, per week. Both seasons:

${refereeTable(results, both)}

### Chip timing

One week in ${CHIP_EVERY}, on roll's squads, the engine's Bench Boost and Triple Captain hints (the planning GW's
\`chipHints\`, for the squad as it stands) against the week the referee picks for each over the same
${DECISION_ENGINE.horizonGws} GWs, every GW weighted alike as the hints are: its best plan with the chip in each GW in
turn, with transfers and with the squad held as it is (which separates the model's linear bench from planning
transfers round the chip). "Costs": the referee's best plan with the chip in the hint's week, less with it in its own
best week; "as good" is within ${MILP_TIE} points, the solver's tolerance. Both seasons; no chip was played in any
season above.

${chipTable(results, both)}

${total('solves')} solves, ${f(total('ms') / Math.max(1, total('solves')), 0)} ms each on average; ${total('stopped')} stopped at
the ${SOLVER.time_limit} s limit with the best plan found. In ${total('unordered')} week${total('unordered') === 1 ? '' : 's'} (its own
season and the same-squad weeks) some of the referee's moves had no order FPL takes one at a time and were left out.
`;
}

/** data/milp.json's tasks with data/solver-repro.json's policy laid over, task by task: the same squads, so the same roll. */
function withSolverRepro(milp, repro) {
  const key = r => `${r.season}|${r.schedule}|${r.squad}`;
  const byKey = new Map(repro.map(r => [key(r), r]));
  return milp.filter(r => byKey.has(key(r))).map(r => {
    const x = byKey.get(key(r));
    if (x.out.roll.total !== r.out.roll.total) throw new Error(`run.js: ${key(r)}: data/solver-repro.json's roll is not data/milp.json's`);
    return { ...r, out: { ...r.out, [SOLVER_REPRO]: x.out[SOLVER_REPRO] } };
  });
}

const movesText = moves => (moves.length ? moves.map(m => `${m.outId}>${m.inId}`).join(', ') : 'none');
const DIFFERING_WEEKS = 5;   // weeks listed, for each mode, where its root differs from the solver's first week

/**
 * The app's solver path against the offline planner (solver.js; rows are data/milp.json's tasks with the policy laid over,
 * withSolverRepro): the paired season gap, the solves, and where the solver's first week and the modes' moves differ.
 */
function solverReproSection(rows) {
  if (!rows) return '';
  const seasons = RUN_SEASONS.filter(s => of(rows, s, 'asItStood').some(r => r.out[SOLVER_REPRO]));
  if (!seasons.length) return '';
  const tasks = ss => ss.flatMap(s => of(rows, s, 'asItStood')).filter(r => r.out[SOLVER_REPRO]);
  const gap = ss => {
    const r = paired(rows, ss, 'asItStood', SOLVER_REPRO, 'milp');
    return `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}`;
  };
  const seasonRow = (label, ss) => `| ${label} | ${tasks(ss).length} | ${f(mean(tasks(ss).map(r => r.out.milp.total)))}`
    + ` | ${f(mean(tasks(ss).map(r => r.out[SOLVER_REPRO].total)))} | ${gap(ss)} |`;
  const countsRow = (label, ss) => {
    const counts = tasks(ss).map(r => r.out[SOLVER_REPRO].counts);
    const total = k => sum(counts.map(c => c[k]));
    return `| ${label} | ${total('solves')} | ${f(total('ms') / Math.max(1, total('solves')), 0)} | ${total('stopped')}`
      + ` | ${total('noPlan')} | ${total('unordered')} |`;
  };
  const weeks = tasks(seasons).flatMap(r => r.out[SOLVER_REPRO].log.map(w => ({ ...w, season: r.season, squad: r.label })));
  const agreement = MODES.map(mode => `| ${labelOf(mode)} | ${weeks.length} | ${share(weeks, w => agrees(w, mode))} |`);
  const listed = MODES.flatMap(mode => weeks.filter(w => !agrees(w, mode)).slice(0, DIFFERING_WEEKS)
    .map(w => `| ${labelOf(mode)} | ${w.season} | ${w.squad} | ${w.t} | ${movesText(w.first)} | ${movesText(w.engine[mode])} |`));
  const names = seasons.length > 1 ? [...seasons.map(s => [s, [s]]), ['both', seasons]] : [[seasons[0], seasons]];
  return `## The app's solver against the offline planner

The reproduction check (solver plan, Phase 3). The app's solver path - \`js/engine/solver/\`'s problem, HiGHS and
ordering, through \`tools/backtest/solver.js\` - is run as the app runs it, but set as Phase 8's offline planner was:
Funds' decay (${DECISION_ENGINE.decayBase} a GW) over ${MILP.weights.length} GWs as a horizon total, cut at the season's end;
hits at ${DECISION_ENGINE.hitCost}; no value on the free transfers or the bank at the horizon's end, no hit margin, no
kept players, dead slots, sale points or chips; a pool of ${REPRO.config.solver.pool.points} others a position by weighted
points and ${REPRO.config.solver.pool.pointsPerTenth} by weighted points a tenth. Each week it takes the engine's result, solves,
and makes the plan's first week one move at a time. It plays the same squads as data/milp.json and is paired with its
\`milp\` policy, squad by squad.

It differs from that planner in two ways. HiGHS stops at ${REPRO.options.time_limit} s, the app's limit, against
${SOLVER.time_limit} s (the app's within ${REPRO.options.mip_abs_gap} points of the bound, the planner's within
${SOLVER.mip_abs_gap}). And a solve that stops before it has any plan is solved again by the planner at ${RETRY_TIME} times
its limit, and the run stops if there is still none; the app's path, which keeps the engine's card when there is no plan,
makes no move that week and counts it under "no plan" below. In the rest it is the planner's: the pool is the planner's
alone (the buys the engine itself makes, which the app adds to it, are left out here), and a first week some of whose moves
have no legal order one at a time (FPL takes them one at a time) makes the legal ones, as the planner did, and is counted
below.

### The gap, points a season

The app's solver less the offline planner (paired, squads and blocks of weeks resampled; no clear difference unless the
interval excludes zero):

| season | squads | offline planner | app's solver | the app's solver less the planner |
|---|---|---|---|---|
${names.map(([label, ss]) => seasonRow(label, ss)).join('\n')}

The gap's explanation (the ${REPRO.options.time_limit} s limit against the planner's ${SOLVER.time_limit} s, a run of the widest squads alone at each, and
the run-to-run noise in a squad's season) is in docs/decision-engine-solver-plan.md, "Phase 3 as built".

### Solves

| season | solves | ms each | stopped at the limit | no plan | some moves with no legal order |
|---|---|---|---|---|---|
${names.map(([label, ss]) => countsRow(label, ss)).join('\n')}

### Its first week against each mode's move

The share of weeks (every squad, every week, ${seasons.join(' and ')}) in which the solver's first week is the same sales
and the same buys as the mode's move (nothing for a mode that rolls), however they are paired or ordered. A mode's move is
its root and, for Funds & flexibility, the second move the root pays for when it has one.

| mode | weeks | same as the solver's first week |
|---|---|---|
${agreement.join('\n')}

For each mode, the first ${DIFFERING_WEEKS} weeks where its move differs from the solver's first week (player ids, sold >
bought):

| mode | season | squad | GW | the solver's moves | the mode's moves |
|---|---|---|---|---|---|
${listed.join('\n')}
`;
}

/** The tuning sweep (2024-25) and the chosen values' test on the held-out season. */
function tuningSection(tune, tuned, tuneMulti = null) {
  if (!tune) return '';
  const { rows, chosen } = tuningChoices(tune, tuneMulti);
  const widths = TUNING.flatMap(t => t.modes.map(mode => paired(tune, [TUNE_SEASON], 'asItStood', `${mode} @ ${t.variant}`, mode)))
    .filter(Boolean).map(r => ((r.hi - r.lo) / 2) * r.gws).sort((a, b) => a - b);
  const halfWidth = widths[Math.floor(widths.length / 2)];
  const modesOf = r => `${r.modes.length === MODES.length ? 'all six' : r.modes.map(labelOf).join(', ')}`
    + `${r.multiModes.length && tuneMulti ? `; several a week: ${r.multiModes.length === MODES.length ? 'all six' : r.multiModes.map(labelOf).join(', ')}` : ''}`;
  const sweep = rows.map(r => `| ${r.param} | ${r.value} | ${modesOf(r)} | ${signed(r.gain)}`
    + ` | ${r.gains.map(g => signed(g, 0)).join(', ')} | ${r.multiGains.length ? r.multiGains.map(g => signed(g, 0)).join(', ') : '-'} |`);
  const test = !tuned ? '' : `\n\nThe chosen values together, on ${HELD_OUT} (held out), less the presets as written (points a season):\n\n`
    + `| mode | one move a week | several a week |\n|---|---|---|\n${MODES.map(mode => {
      const cell = (a, b) => {
        const r = paired(tuned, [HELD_OUT], 'asItStood', a, b);
        return r ? `${ci(r, r.gws)}${verdictOf(r) === 'no clear difference' ? '' : ` **${verdictOf(r)}**`}` : '-';
      };
      return `| ${labelOf(mode)} | ${cell(`${mode} (tuned)`, mode)} | ${cell(`${mode}+ (tuned)`, `${mode}+`)} |`;
    }).join('\n')}`;
  return `## Tuning: chosen on ${TUNE_SEASON}, tested on ${HELD_OUT}

Run before the solver plan's scale fix, on the averaged presets of the time (data/tune.json, data/tune-multi.json).
Each value below replaced its preset alone on ${TUNE_SEASON}, one move a week and, for the free-transfer value and
the hit margin, several a week as well (all six modes; one move a week takes a hit only in Funds' chain). The gain
is the paired season difference against the presets as written, averaged over every policy it touches (each one's
own in the last two columns, modes in order). A value is chosen if its gain is at least ${TUNE_MATERIAL} points a
season. The mode weights are not tuned (Q6).
For scale, one value on one mode carries a 95% interval of about ${f(halfWidth)} points either way (the median over
the sweep), so the sweep can show only a large effect.

| parameter | value | modes | mean gain | per mode, one move | per mode, several |
|---|---|---|---|---|---|
${sweep.join('\n')}

Chosen: ${chosen.length ? chosen.map(c => `${c.param} ${c.value} (${signed(c.gain)})`).join('; ') : 'nothing clears the bar; the presets stand'}.${test}
`;
}

function report(results, squadsBySeason,
  { tune = null, tuned = null, alt = null, tuneMulti = null, milp = null, solverRepro = null } = {}) {
  const both = RUN_SEASONS;
  const other = RUN_SEASONS.filter(s => s !== HELD_OUT);
  const oldCounts = ['asItStood'].flatMap(sch => RUN_SEASONS.flatMap(s => of(results, s, sch))).map(r => r.out.old?.counts).filter(Boolean);
  const sumCount = key => oldCounts.reduce((a, c) => a + c[key], 0);
  const gwsLabel = `GW${START_GW}-${SEASON_GWS}`;
  const reproMd = solverReproSection(solverRepro);
  return `# Decision engine backtest

Generated by \`node tools/backtest/run.js\` (docs/decision-engine-plan.md,
Phase 7). Do not edit by hand: change the tool and run it again.

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
other legal sale, less this sale's (weeks with one move). Return per hit point: the week's gain before hits per point
of hits, its free moves included (a week always starts with a free transfer). Points per free transfer: weeks
without a hit. The slope is taken before hits.
These intervals treat each week's moves as independent, which they are not (the same buys recur across squads and
neighbouring weeks), so they are narrower than the truth; the paired season totals above are the verdict.

${moveTable(results, both, 'asItStood', ALL)}

## The weight units

Every mode now weighs its window as a horizon total (the solver plan's scale fix, its Phase 1): before it, Long term
and Future prep weighed a per-GW average (÷ 3 and ÷ 4.25) against the same free-transfer value and hit as the
others (plan risk 8). The fix also moved lambda and Future prep's deferral epsilon by the same sums (Long term
0.10 to 0.30, Future prep 0.15 to 0.6375 and 0.1 to 0.425), so money and the wait weigh against points as before.

${scaleFixSection(results)}

Funds and Structure in the other unit as well, normalised to sum to 1 (their gates in that unit too, the one-off terms
as written), less the preset (points a season). The intervals are wide (about 50-100 points either way), so "no clear
difference" is not "no difference":

${[[HELD_OUT], both].map(ss => `### ${ss.join(' and ')}\n\n| variant | less the preset |\n|---|---|\n${RISK8.filter(r => r.variant === 'normalised').map(r => {
    const d = paired(results, ss, 'asItStood', r.name, r.mode);
    return `| ${r.name} | ${d ? `${ci(d, d.gws)} ${verdictOf(d) === 'no clear difference' ? '' : `**${verdictOf(d)}**`}` : '-'} |`;
  }).join('\n')}`).join('\n\n')}

## Several moves a week

Each mode, and the roll baseline, made a pick and then asked again on the new squad with one free transfer
fewer, until it rolled (at most ${MAX_PICKS} picks a week; Funds' pick is two moves): the planner's cards used one
after another, never selling a player bought that week nor buying back one sold. The engine's own
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

In a big week - its target GW a double for a squad player or a replacement its tail shortlists, or Bench Boost or
Triple Captain planned there (none is, here) - Ceiling scores a swap at that GW by the change to the squad's
90th-percentile score over Monte Carlo draws of the points model's parts (engine/ceiling.js); in every other week by
its expected points (the solver plan's Phase 2; before it, the tail ran every week). Less Ceiling on the mean every
week:

${ceilingLines(results, both)}

${tuningSection(tune, tuned, tuneMulti)}
${altSection(alt)}
${milpSection(milp)}${reproMd && `\n${reproMd}`}
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
- The one-move policies make at most one move a week (Funds two, with its chained move), so free transfers banked past
  one go unused: in ${HELD_OUT}, after the AFCON top-up, every one of them sits at the cap of five from GW16, where a
  move costs nothing and a threshold of zero is all it must clear; with one free transfer always in hand, none can
  take a hit except Funds' second move. The several-moves policies (names ending +) use the banked transfers and can.
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
  } else if (argv.includes('--tune-multi')) {
    const variants = { ...VARIANTS, ...Object.fromEntries(TUNING.map(t => [t.variant, t.overrides])) };
    stage = 'tune-multi';
    stageTasks = squadsBySeason[TUNE_SEASON].map(squad => ({
      season: TUNE_SEASON, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants, shadow: false, policies: tuningMultiPolicies(),
    }));
  } else if (argv.includes('--merge')) {
    // Re-runs only MERGE's policies (and the shadow, on roll's path) and lays them over data/results.json.
    stage = 'merge';
    stageTasks = tasks.map(t => ({ ...t, policies: t.policies.filter(p => MERGE.has(p.name) || (t.shadow && p.name === 'roll')) }));
  } else if (argv.includes('--alt')) {
    stage = 'alt';
    stageTasks = RUN_SEASONS.flatMap(season => squadsBySeason[season].map(squad => ({
      season, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants: VARIANTS, shadow: false,
      policies: [...ALL_POLICIES.filter(p => ['roll', 'roll+', 'longterm', 'longterm+'].includes(p.name)), ...ALT],
    })));
  } else if (argv.includes('--milp')) {
    // The referee's own season and, on roll's path, its plans against the engine's: paired at report time with
    // data/results.json, whose roll it re-runs.
    stage = 'milp';
    stageTasks = RUN_SEASONS.flatMap(season => squadsBySeason[season].map(squad => ({
      season, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants: VARIANTS, shadow: false, referee: true,
      policies: [...BASE.filter(p => p.name === 'roll'), ...MILP_POLICIES],
    })));
  } else if (argv.includes('--solver-repro')) {
    // The app's solver path on the squads data/milp.json used, paired with its referee at report time; roll is re-run
    // as in --milp, so the two files can be checked to be from the same code.
    stage = 'solver-repro';
    stageTasks = RUN_SEASONS.flatMap(season => squadsBySeason[season].map(squad => ({
      season, schedule: 'asItStood', squad, toGw: SEASON_GWS, variants: VARIANTS, shadow: false,
      policies: [...BASE.filter(p => p.name === 'roll'), ...REPRO_POLICIES],
    })));
  } else if (argv.includes('--test-tuned')) {
    const tune = await readStage('tune');
    if (!tune) throw new Error('run.js: run --tune first');
    const { overrides, chosen } = tuningChoices(tune.results, (await readStage('tune-multi'))?.results ?? null);
    if (!chosen.length) {
      // An earlier test of an earlier choice must not stay in the report.
      await rm(stageFile('tuned'), { force: true });
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
        : stage === 'milp' ? milpSection([result])
          // No data/milp.json for a few weeks: the section's own code is run with roll in the planner's place.
          : stage === 'solver-repro' ? solverReproSection([{ ...result, out: { ...result.out, milp: result.out.roll } }])
            : tuningSection(stage === 'tune' ? [result] : (await readStage('tune')).results, stage === 'tuned' ? [result] : null);
    console.log(stage === 'results' ? md.slice(md.indexOf('## Several moves'), md.indexOf('## Sensitivity')) : md);
    console.log(`${Math.round(result.ms / 1000)}s, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB (main)`);
    return;
  }
  await runStage(stage, stageTasks, oldDir, argv);
  if (stage === 'merge') await mergeIntoResults();
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

/** Lays data/merge.json's policies (and shadows) over data/results.json, task by task. */
async function mergeIntoResults() {
  const [main, merge] = await Promise.all([readStage('results'), readStage('merge')]);
  const key = r => `${r.season}|${r.schedule}|${r.squad}`;
  const fresh = new Map(merge.results.map(r => [key(r), r]));
  const results = main.results.map(r => {
    const m = fresh.get(key(r));
    return m ? { ...r, out: { ...r.out, ...m.out }, shadow: m.shadow ?? r.shadow } : r;
  });
  await writeFile(stageFile('results'), JSON.stringify({ results }));
}
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
  const [main, tune, tuned, alt, tuneMulti, milp, repro] = await Promise.all(['results', 'tune', 'tuned', 'alt', 'tune-multi', 'milp',
    SOLVER_REPRO].map(readStage));
  if (!main) throw new Error('run.js: no data/results.json yet - run the backtest first');
  const md = report(main.results, squadsBySeason, { tune: tune?.results ?? null, tuned: tuned?.results ?? null,
    alt: alt?.results ?? null, tuneMulti: tuneMulti?.results ?? null, milp: milp ? withMilp(main.results, milp.results) : null,
    solverRepro: milp && repro ? withSolverRepro(milp.results, repro.results) : null });
  await writeFile(new URL('../../docs/decision-engine-backtest.md', import.meta.url), md);
  console.log(md.slice(0, md.indexOf('## What was run')));
}

if (isMainThread) await main();
else await workerMain(workerData);
