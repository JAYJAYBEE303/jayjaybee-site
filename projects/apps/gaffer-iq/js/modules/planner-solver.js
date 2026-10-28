/**
 * js/modules/planner-solver.js
 * Layer: module. The Planner's solver runner (docs/decision-engine-solver-plan.md §1 and §3). It owns the module
 * workers that solve each mode's problem (engine/solver/worker.js) and the one that re-scores a pick
 * (engine/robustness-worker.js), the order they solve in, and the card each mode shows at each step; it does no
 * rendering and touches no DOM. The planner hands it the engine's input and result on every run and paints the cards it
 * hands back.
 * Side effects: Workers, timers, console warnings. Workers are made on the first solve, never at page load.
 *
 * A card goes engine's move (refining) -> the solver's move (ready) -> its figures as they land, or, when the solver
 * has no plan inside its cap, errors, times out or cannot start, the engine's move (ready), marked as the engine's.
 * A pick that moves settles only once its rolling solve has landed: a move that gains no more over rolling than the
 * solver's tolerance (absGap) is within the solve's own noise, and the card is a roll (money alone, or nothing, is not
 * a reason to move). Where the rolling solve fails, the card is the engine's.
 * Every figure on a solver card is keyed to the card it was computed for (engine/solver/plan.js: withFigure), so one
 * for another move set or an older input is dropped, and the run itself is dropped the moment a newer one starts.
 */

import { createDecisionCache, describePlan, moveSetKey } from '../engine/decision.js';
import { modeSetting, solverProblem } from '../engine/solver/problem.js';
import {
  alternativesOf, callOf, checkProtected, gainOverRolling, orderMoves, rollingProblem, solverCard, withFigure,
} from '../engine/solver/plan.js';

/** Seconds to ms: the config states every wait in seconds. */
const MS_PER_S = 1000;

/** What a queued solve resolves with when a newer run made it pointless. */
const STALE = Symbol('stale');

/**
 * The queue's tiers: every solve a card's move waits on (its pick, and its rolling twin when it moves) before any
 * follow-up, so a card's move is never waiting on another card's figures.
 */
const PICK = 0;
const BACKGROUND = 1;

/** A message to a worker and its answer, matched by id; a worker that dies or ends rejects what it still owed. */
function connect(make) {
  const worker = make();
  const waiting = new Map();
  let last = 0;
  const fail = error => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };
  worker.onmessage = ({ data }) => {
    const owed = waiting.get(data?.id);
    if (!owed) return;
    waiting.delete(data.id);
    owed.resolve(data);
  };
  worker.onerror = event => fail(new Error(event?.message || 'the worker did not load'));
  worker.onmessageerror = () => fail(new Error('the worker sent an answer that could not be read'));
  return {
    call: message => new Promise((resolve, reject) => {
      const id = ++last;
      waiting.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...message });
      } catch (error) {
        waiting.delete(id);
        reject(error);
      }
    }),
    kill: () => {
      worker.terminate();
      fail(new Error('the worker was ended'));
    },
  };
}

/** A promise that rejects if it has not settled in `ms`. */
const within = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${ms / MS_PER_S} s`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const idsOf = ({ outId, inId }) => ({ outId, inId });

/** The engine's whole recommendation for a mode: its root and the second move Funds chains to it; none for a roll. */
const engineMovesOf = engine => (engine.root ? [engine.root, engine.root.chained].filter(Boolean) : []);

/**
 * @param {object} p
 * @param {object} p.config  DECISION_ENGINE; nothing runs unless `solver.enabled`
 * @param {() => object} p.makeWorker         a module worker on engine/solver/worker.js; throws where there is no Worker
 * @param {() => object} p.makeRescoreWorker  a module worker on engine/robustness-worker.js
 * @param {() => boolean} p.isPhone           a phone solves with one worker, and only the cards that were viewed
 * @param {(modeId: string, card: object) => void} p.onCard  each card the planner shows, as it changes
 * @param {(entry: object) => void} [p.onLog]  each settled card, and again as its figures land (the decision log's entry)
 * @param {number} [p.hardwareConcurrency]  logical cores, for the pool's size
 * @returns {{refresh: (input: object, result: object, inputVersion: number, cache?: object) => void,
 *   view: (modeId: string) => void, stop: () => void}}
 */
export function createSolverRunner({
  config, makeWorker, makeRescoreWorker, isPhone = () => false, onCard, onLog = () => {},
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
}) {
  const { solver } = config;
  const wasm = { wasmUrl: new URL(`../../${solver.vendor.dir}highs.wasm`, import.meta.url).href, integrity: `sha256-${solver.vendor.wasm}` };
  const options = { time_limit: solver.timeLimitS, mip_abs_gap: solver.absGap };
  const solveMs = (solver.timeLimitS + solver.timeoutMarginS) * MS_PER_S;
  const initMs = solver.initTimeoutS * MS_PER_S;
  const modeIds = ['now', ...Object.keys(config.modes).filter(id => id !== 'now')];

  let run = null;            // the newest refresh: everything else is stale
  let phone = false;
  let off = null;            // why the solver is off for the session, once it is
  let slots = null;          // the solver workers, once made: { worker, ready, busy }
  let rescorer = null;       // the robustness worker, once made: { worker, waiting }
  const queue = [];          // solves waiting for a worker: { tier, problem, resolve, reject }
  const viewed = new Set();  // the cards a phone has shown, in the order they were

  // ─── The pool ──────────────────────────────────────────────────────────────

  function turnOff(error) {
    if (off) return;
    off = error instanceof Error ? error : new Error(String(error));
    console.warn(`[planner] solver off: ${off.message}`);
    endWorkers();
    for (const task of queue.splice(0)) task.reject(off);
  }

  function endWorkers() {
    for (const slot of slots ?? []) {
      slot.worker?.kill();
      slot.worker = null;
    }
    slots = null;
    endRescorer(null);
  }

  /** (Re)starts a slot's worker; HiGHS loads in it, and the slot takes solves once that has. */
  function boot(slot) {
    slot.ready = false;
    slot.busy = false;
    let worker;
    try {
      worker = connect(makeWorker);
    } catch (error) {
      return turnOff(error);
    }
    slot.worker = worker;
    within(worker.call({ kind: 'init', ...wasm }), initMs, 'the solver worker').then(answer => {
      if (!answer.ok) throw new Error(answer.error);
    }).then(() => {
      if (slot.worker !== worker) return;
      slot.ready = true;
      pump();
    }, error => {
      if (slot.worker === worker) turnOff(error);
    });
  }

  function ensurePool() {
    if (slots) return;
    const size = phone ? 1 : Math.min(solver.workers, Math.max(1, (hardwareConcurrency ?? Infinity) - 1));
    slots = Array.from({ length: size }, () => ({ worker: null, ready: false, busy: false }));
    slots.forEach(boot);
  }

  /** Gives each idle worker the next solve: the lowest tier first, then the order they were asked for. */
  function pump() {
    if (off || !slots) return;
    for (const slot of slots) {
      if (!slot.ready || slot.busy || !queue.length) continue;
      const next = queue.reduce((best, task, i) => (task.tier < queue[best].tier ? i : best), 0);
      dispatch(slot, queue.splice(next, 1)[0]);
    }
  }

  function dispatch(slot, task) {
    const { worker } = slot;
    slot.busy = true;
    within(worker.call({ kind: 'solve', problem: task.problem, options }), solveMs, 'the solver').then(answer => {
      slot.busy = false;
      if (answer.ok) task.resolve({ plan: answer.plan, stopped: Boolean(answer.stopped) });
      else task.reject(new Error(answer.error));
      pump();
    }, error => {
      task.reject(error);
      // A solve is synchronous and cannot be interrupted: end this worker and start another, or the next solve
      // would wait behind the stuck one.
      if (slot.worker !== worker) return;
      worker.kill();
      boot(slot);
    });
  }

  /**
   * A solve for a run's own flow: nothing is queued, dispatched or pooled for a run that a newer refresh (or stop) has
   * replaced, wherever in its flow it asks.
   * @returns {Promise<{plan: object|null, stopped: boolean}|symbol>} the plan (null when there is none inside the cap) and
   *   whether the solve stopped at its limit, or STALE when the run is over
   */
  function solve(mine, problem, tier) {
    return new Promise((resolve, reject) => {
      if (mine !== run) return resolve(STALE);
      if (off) return reject(off);
      ensurePool();
      if (off) return reject(off);
      queue.push({ tier, problem, resolve, reject });
      pump();
    });
  }

  // ─── The robustness worker ─────────────────────────────────────────────────

  function endRescorer(share) {
    if (!rescorer) return;
    for (const resolve of rescorer.waiting.values()) resolve(share);
    rescorer.worker.terminate();
    rescorer = null;
  }

  /** The pick's share against its alternatives, or null where it cannot be had. Made on first use. */
  function rescore(message) {
    return new Promise(resolve => {
      try {
        if (!rescorer) {
          const worker = makeRescoreWorker();
          const mine = { worker, waiting: new Map() };
          worker.onmessage = ({ data }) => {
            if (data?.kind !== 'rescore') return;
            mine.waiting.get(data.key)?.(data.share);
            mine.waiting.delete(data.key);
          };
          // A rescore that throws sends no reply, only this: its figure then reads as unavailable.
          worker.onerror = () => { if (rescorer === mine) endRescorer(null); };
          rescorer = mine;
        }
        rescorer.waiting.set(message.key, resolve);
        rescorer.worker.postMessage(message);
      } catch (error) {
        console.warn('[planner] robustness not computed:', error?.message ?? error);
        resolve(null);
      }
    });
  }

  // ─── Cards ─────────────────────────────────────────────────────────────────

  function emit(mine, modeId, card) {
    if (mine !== run) return;
    mine.cards[modeId] = card;
    try {
      onCard(modeId, card);
    } catch (error) {
      console.error(`[planner] ${modeId} card not painted:`, error);
    }
  }

  /**
   * The decision log's entry for a card as it stands (Task 8 keys and updates it). The gain of a solver card is the one
   * that landed on it, null until then; an engine card's is its root's score, and a roll has none.
   */
  function log(mine, modeId, card) {
    const engine = mine.result.modes[modeId];
    const engineFirst = engineMovesOf(engine).map(idsOf);
    const moves = card.moves ? card.moves.map(idsOf) : engineFirst;
    try {
      onLog({
        gw: mine.input.planningGw, at: Date.now(), mode: modeId, source: card.source, call: card.call,
        stopped: card.stopped === true, moves,
        gain: card.source === 'solver' ? card.gain?.value ?? null : card.root?.outScore ?? null,
        robustness: card.robustness?.value ?? null, engineFirst,
        agrees: card.call === engine.call && moveSetKey(moves) === moveSetKey(engineFirst),
      });
    } catch (error) {
      console.error(`[planner] ${modeId} not logged:`, error);
    }
  }

  /** The engine's card for a mode, settled: the solver has nothing to say, or nothing it could say in time. */
  function settleEngine(mine, modeId, source = 'engine') {
    if (mine !== run) return;
    const card = { ...mine.result.modes[modeId], source, state: 'ready' };
    emit(mine, modeId, card);
    log(mine, modeId, card);
  }

  /** A figure landing: kept only on the card it was computed for. */
  function land(mine, modeId, name, key, value) {
    if (mine !== run) return;
    const card = mine.cards[modeId];
    const next = withFigure(card, name, key, value);
    if (next === card) return;
    emit(mine, modeId, next);
    if (name !== 'alternatives') log(mine, modeId, next);
  }

  const positionOf = mine => {
    mine.positions ??= new Map([...mine.input.squad.map(s => [s.playerId, s.position]),
      ...(mine.input.candidates ?? []).map(c => [c.id, c.position])]);
    return id => mine.positions.get(id);
  };

  /**
   * The card a solved plan makes: marked updated, naming the engine's move, when it is not the engine's move. `rolled`:
   * the plan's move gains no more than the tolerance over rolling, so the card rolls and keeps the plan's later weeks.
   */
  function pickCard(mine, modeId, plan, rolled = false) {
    const engine = mine.result.modes[modeId];
    const call = rolled ? 'roll' : callOf(plan);
    const { moves, unordered } = rolled ? { moves: [], unordered: false }
      : orderMoves(mine.input, mine.result, call === 'wait' ? plan.weeks[1] : plan.weeks[0]);
    // The plan's figures are for all its moves: a part of it, the moves that happen to be legal one at a time, is not it.
    if (unordered) throw new Error(`${call === 'wait' ? 'next week\'s' : 'this week\'s'} moves have no legal order, one at a time`);
    const describe = describePlan(mine.input, config, mine.cache, modeId, moves);
    const solved = solverCard(engine, { plan, moves, describe, inputVersion: mine.version, positionOf: positionOf(mine), call });
    const same = solved.call === engine.call && moveSetKey(moves) === moveSetKey(engineMovesOf(engine));
    // The engine's own explanation stays when the move is its own: the solver adds only what it computes.
    return same
      ? { ...solved, root: engine.root, deferral: engine.deferral, waitForNews: engine.waitForNews, state: 'ready', updated: false }
      : { ...solved, state: 'ready', updated: true, replaced: engine.root, engineCall: engine.call };
  }

  // ─── One mode's solves ─────────────────────────────────────────────────────

  async function pickFlow(mine, modeId) {
    const problem = solverProblem(mine.input, mine.result, mine.modes[modeId].setting, config);
    let answer;
    try {
      answer = await solve(mine, problem, PICK);
    } catch (error) {
      if (error !== off) console.warn(`[planner] solver: ${modeId} keeps the engine's move:`, error.message);
      return settleEngine(mine, modeId);
    }
    if (answer === STALE || mine !== run) return;
    const { plan, stopped } = answer;
    if (!plan) return settleEngine(mine, modeId);   // no plan inside the cap

    let card;
    try {
      checkProtected(modeId, plan.weeks[0], mine.result);
    } catch (error) {
      console.error(`[planner] ${error.message}`);
      return settleEngine(mine, modeId);
    }
    // The lock, protection or hold is the first week's by spec, so a wait is checked in the week it is made: a plan that
    // sells a locked player next week is not a model bug, but not a wait to show either. It rolls, keeping its later weeks.
    let rolled = false;
    if (callOf(plan) === 'wait') {
      try {
        checkProtected(modeId, plan.weeks[1], mine.result, 'the week it waits for');
      } catch (error) {
        console.warn(`[planner] ${error.message}: the card rolls`);
        rolled = true;
      }
    }
    try {
      card = { ...pickCard(mine, modeId, plan, rolled), stopped };
    } catch (error) {
      console.warn(`[planner] solver: ${modeId} keeps the engine's move:`, error.message);
      return settleEngine(mine, modeId);
    }
    if (rolled) {
      emit(mine, modeId, card);
      return log(mine, modeId, card);
    }

    // A wait or a roll has no move this week, so it is its own rolling twin.
    if (callOf(plan) !== 'move') {
      emit(mine, modeId, card);
      log(mine, modeId, card);
      return Promise.all([gainFlow(mine, modeId, problem, plan, card), alternativesFlow(mine, modeId, problem, plan, card)]);
    }

    // A move is worth making only if it beats rolling by more than the solve's own tolerance, so its card waits for the
    // rolling twin: the gain lands with the card.
    let rolling;
    try {
      rolling = await solve(mine, rollingProblem(problem), PICK);
    } catch (error) {
      if (error !== off) console.warn(`[planner] solver: ${modeId} keeps the engine's move: gain over rolling not computed:`, error.message);
      return settleEngine(mine, modeId);
    }
    if (rolling === STALE || mine !== run) return;
    if (!rolling.plan) return settleEngine(mine, modeId);
    const gain = gainOverRolling(plan, rolling.plan);
    if (!(gain > solver.absGap)) {
      try {
        card = { ...pickCard(mine, modeId, plan, true), stopped };
      } catch (error) {
        console.warn(`[planner] solver: ${modeId} keeps the engine's move:`, error.message);
        return settleEngine(mine, modeId);
      }
      emit(mine, modeId, card);
      return log(mine, modeId, card);
    }
    card = withFigure(card, 'gain', card.key, gain);
    emit(mine, modeId, card);
    log(mine, modeId, card);
    return alternativesFlow(mine, modeId, problem, plan, card);
  }

  /** The gain over rolling of a pick that does not move this week: the pick less the same problem with that week held to no moves. */
  async function gainFlow(mine, modeId, problem, plan, card) {
    let value = null;
    try {
      const rolling = await solve(mine, rollingProblem(problem), BACKGROUND);
      if (rolling === STALE) return;
      if (rolling.plan) value = gainOverRolling(plan, rolling.plan);
    } catch (error) {
      console.warn(`[planner] solver: ${modeId} gain over rolling not computed:`, error.message);
    }
    land(mine, modeId, 'gain', card.key, value);
  }

  /** The alternatives, then the pick re-scored against them. */
  async function alternativesFlow(mine, modeId, problem, plan, card) {
    let found;
    try {
      found = await alternativesOf(problem, plan, async other => {
        const alt = await solve(mine, other, BACKGROUND);
        return alt === STALE ? null : alt.plan;
      }, config);
    } catch (error) {
      console.warn(`[planner] solver: ${modeId} alternatives not computed:`, error.message);
      land(mine, modeId, 'alternatives', card.key, null);
      return land(mine, modeId, 'robustness', card.key, null);
    }
    if (mine !== run) return;

    // An alternative is FPL's own move set too: re-ordered for showing and re-scoring, and held to the same rules.
    const alternatives = [];
    try {
      for (const alt of found) {
        const week = { in: alt.moves.map(m => m.inId), out: alt.moves.map(m => m.outId) };
        checkProtected(modeId, week, mine.result);
        const { moves, unordered } = orderMoves(mine.input, mine.result, week);
        // No legal order one at a time: not an alternative the app can offer, and not a part of one either.
        if (unordered) {
          console.warn(`[planner] solver: an alternative for ${modeId} has moves with no legal order, one at a time: left out`);
          continue;
        }
        alternatives.push({ moves, key: moveSetKey(moves), gain: alt.gain });
      }
    } catch (error) {
      console.error(`[planner] ${error.message}`);
      return settleEngine(mine, modeId);
    }
    land(mine, modeId, 'alternatives', card.key, alternatives);

    const engine = mine.result.modes[modeId];
    const own = card.call === 'move' ? card.moves.map(idsOf) : [];
    const theirs = engine.call === 'move' ? engineMovesOf(engine).map(idsOf) : [];
    const candidates = [
      { key: moveSetKey(own), moves: own },
      ...alternatives.map(({ key, moves }) => ({ key, moves: moves.map(idsOf) })),
      { key: moveSetKey(theirs), moves: theirs },
      { key: '', moves: [] },
    ];
    // Several modes can make the same move: the reply's key is the card's, and the mode's with it.
    const { planningGw, squad, freeTransfers, chipPlan, projections } = mine.input;
    const share = await rescore({
      kind: 'rescore', input: { planningGw, squad, freeTransfers, chipPlan, projections }, modeId,
      weights: engine.weights, candidates, pickKey: candidates[0].key, key: `${modeId}|${card.key}`,
    });
    land(mine, modeId, 'robustness', card.key, share);
  }

  /** Begins a mode's pick if it has not begun: the card shows the engine's move, refining, until the plan lands. */
  function queuePick(mine, modeId) {
    const m = mine.modes[modeId];
    if (mine !== run || !m || m.queued) return;
    m.queued = true;
    if (mine.cards[modeId].state !== 'refining') emit(mine, modeId, { ...mine.result.modes[modeId], source: 'engine', state: 'refining' });
    pickFlow(mine, modeId).catch(error => {
      console.error(`[planner] solver: ${modeId} failed:`, error);
      settleEngine(mine, modeId);
    });
  }

  // ─── The runner ────────────────────────────────────────────────────────────

  return {
    /**
     * A new run of the engine's input: everything queued for an older one goes, answers still owed to it are ignored,
     * and each mode's card starts again from the engine's move.
     * @param {object} input         runDecisionEngine's input
     * @param {object} result        its DecisionResult
     * @param {number} inputVersion  which run this is; part of every key
     * @param {object} [cache]       the decision cache that run used: V values describePlan reads
     */
    refresh(input, result, inputVersion, cache = createDecisionCache()) {
      if (!solver.enabled) return;
      for (const task of queue.splice(0)) task.resolve(STALE);
      // A robustness run still going is for a card that is gone: end it rather than queue the new ones behind it.
      if (rescorer?.waiting.size) endRescorer(null);
      phone = isPhone();
      const mine = { input, result, version: inputVersion, cache, phone, modes: {}, cards: {}, positions: null };
      run = mine;
      for (const modeId of modeIds) {
        const engine = result.modes[modeId];
        if (!engine) continue;
        let setting;
        try {
          setting = off ? null : modeSetting(input, result, modeId, config);
        } catch (error) {
          console.warn(`[planner] solver: ${modeId} keeps the engine's move:`, error?.message ?? error);
          setting = null;
        }
        // No weeks to weigh: it rolls as the engine has it, with no solve. Ceiling in a big week is the engine's
        // upper tail, which expected points cannot reproduce.
        if (setting === null || setting.source === 'engine-tail') {
          settleEngine(mine, modeId, setting?.source ?? 'engine');
          continue;
        }
        mine.modes[modeId] = { setting, queued: false };
        emit(mine, modeId, { ...engine, source: 'engine', state: phone && !viewed.has(modeId) ? 'ready' : 'refining' });
      }
      for (const modeId of phone ? viewed : modeIds) queuePick(mine, modeId);
    },

    /** A card came into view. On a phone it is solved now, behind the ones viewed before it. */
    view(modeId) {
      viewed.add(modeId);
      if (run?.phone) queuePick(run, modeId);
    },

    /** Ends every worker and drops what was queued. A later refresh starts afresh. */
    stop() {
      run = null;
      for (const task of queue.splice(0)) task.resolve(STALE);
      endWorkers();
    },
  };
}
