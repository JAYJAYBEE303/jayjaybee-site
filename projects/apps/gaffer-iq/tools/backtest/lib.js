/**
 * tools/backtest/lib.js
 * The decision backtest's season simulator (docs/decision-engine-plan.md,
 * Phase 7): a policy manages its own squad week by week under FPL's rules -
 * free transfers banked to the cap, hits, sales at the sell price - and each
 * week is scored on what actually happened, with FPL's autosubs and armband.
 * Pure: the season comes in as a `world` (run.js builds it from vaastav), so
 * everything here runs on a fake one in the tests.
 *
 * A world answers, for gameweek t:
 *   player(id, t)          {id, position, teamId}
 *   priceTenths(id, t)     his price
 *   gwPoints(ids, t)       a 15's actual points, fielded by the common lineup rule
 *   expectedPoints(ids, gw, t)  its V for gameweek gw on the projections made at t
 *   ftTopUp(t)             free transfers set by the game that week, or null
 *   projections(t), candidates(t)  for the policies that read them
 */

import { CAPTAIN_MULTIPLIER, MAX_PER_CLUB, SQUAD_LIMITS, XI_FORMATION_MIN } from '../../js/config.js';
import { calcSellPrice } from '../../js/engine/prices.js';
import { checkSwap } from '../../js/engine/feasibility.js';
import { fromTenths, seededRandom } from '../../js/util.js';

const OUTFIELD = ['DEF', 'MID', 'FWD'];
export const GAIN_WINDOWS = [1, 3, 5];
const LOWER_TAIL = 0.025;
const UPPER_TAIL = 0.975;
// A random squad's players are drawn with weight price^this, so it spends near
// the budget rather than at a random pool's average.
const RANDOM_PRICE_POWER = 2;
const RANDOM_TRIES = 1000;

const sum = (xs, f = x => x) => xs.reduce((a, x, i) => a + f(x, i), 0);

// ─── FPL's bookkeeping ───────────────────────────────────────────────────────

/** Next week's free transfers: those left after this week's moves plus one, to the cap; a top-up sets them. */
export function nextFreeTransfers(ft, used, { max, topUp = null }) {
  return topUp ?? Math.min(max, Math.max(0, ft - used) + 1);
}

/** The squad as engine/feasibility.js reads it at gameweek t, every sale at its sell price. */
export function squadState(state, world, t) {
  return {
    bankTenths: state.bankTenths,
    players: state.squad.map(p => {
      const { position, teamId } = world.player(p.id, t);
      const priceTenths = world.priceTenths(p.id, t);
      return { playerId: p.id, position, teamId, priceTenths, sellPriceTenths: calcSellPrice(p.purchaseTenths, priceTenths) };
    }),
  };
}

/** A player as checkSwap takes a buy: price in millions. */
function asBuy(world, id, t) {
  const { position, teamId } = world.player(id, t);
  return { id, position, teamId, price: fromTenths(world.priceTenths(id, t)) };
}

/**
 * The state after a week's moves, made in order: each sale at his sell
 * price, each buy at his price, recorded as what he was bought for. An
 * illegal move is a policy's bug, so it throws rather than being skipped.
 */
export function applyMoves(state, moves, world, t) {
  let next = state;
  for (const { outId, inId } of moves) {
    const current = squadState(next, world, t);
    const check = checkSwap(current, outId, asBuy(world, inId, t));
    if (!check.ok) throw new Error(`applyMoves: ${check.reason} (${outId} -> ${inId}) at GW${t}`);
    const priceTenths = world.priceTenths(inId, t);
    const sold = current.players.find(p => p.playerId === outId);
    next = {
      ...next,
      squad: next.squad.map(p => (p.id === outId ? { id: inId, purchaseTenths: priceTenths } : p)),
      bankTenths: next.bankTenths + sold.sellPriceTenths - priceTenths,
    };
  }
  return next;
}

// ─── A gameweek on actual points ─────────────────────────────────────────────

/**
 * What a fielded 15 scored: FPL's autosubs - an absent starter (no minutes)
 * replaced, in team-sheet order, by the first bench player who played and
 * keeps the formation legal, each once, the keeper only by the reserve
 * keeper - and the armband: the captain's points again, or the vice's when
 * the captain did not play and the vice did.
 *
 * @param {{xi: number[], bench: number[], captainId: number, viceId: number}} lineup
 * @param {Map<number, string>} positionOf
 * @param {(id: number) => {points: number, minutes: number}} actualOf
 * @returns {{points: number, xi: number[], captainId: number|null}}  the XI after subs; who wore the armband
 */
export function scoreGameweek({ xi, bench, captainId, viceId }, positionOf, actualOf) {
  const played = id => actualOf(id).minutes > 0;
  const team = [...xi];
  const used = new Set();
  const keeper = team.findIndex(id => positionOf.get(id) === 'GKP');
  const reserve = bench.find(id => positionOf.get(id) === 'GKP');
  if (keeper >= 0 && !played(team[keeper]) && reserve !== undefined && played(reserve)) team[keeper] = reserve;

  const counts = Object.fromEntries(OUTFIELD.map(p => [p, team.filter(id => positionOf.get(id) === p).length]));
  for (const position of OUTFIELD) {
    team.forEach((id, i) => {
      if (positionOf.get(id) !== position || played(id)) return;
      const sub = bench.find(b => {
        const to = positionOf.get(b);
        if (to === 'GKP' || used.has(b) || !played(b)) return false;
        const after = { ...counts, [position]: counts[position] - 1 };
        after[to] += 1;
        return OUTFIELD.every(p => after[p] >= XI_FORMATION_MIN[p]);
      });
      if (sub === undefined) return;
      team[i] = sub;
      used.add(sub);
      counts[position] -= 1;
      counts[positionOf.get(sub)] += 1;
    });
  }
  const armband = played(captainId) ? captainId : (played(viceId) ? viceId : null);
  const points = sum(team, id => actualOf(id).points)
    + (armband === null ? 0 : (CAPTAIN_MULTIPLIER - 1) * actualOf(armband).points);
  return { points, xi: team, captainId: armband };
}

// ─── Starting squads ─────────────────────────────────────────────────────────

/**
 * A squad taken greedily in `order`: a player joins while his position has a
 * slot, his club is under the limit and the money left still covers the
 * cheapest way, within the club limit, to fill every other open slot. Null if
 * the order runs out.
 *
 * @param {Array<{id: number, position: string, teamId: number, priceTenths: number}>} order
 * @returns {{ids: number[], costTenths: number}|null}
 */
export function pickSquad(order, { budgetTenths, maxPerClub = MAX_PER_CLUB, slots = SQUAD_LIMITS }) {
  const open = { ...slots };
  const clubs = new Map();
  const chosen = new Set();
  const byPosition = Object.fromEntries(Object.keys(slots).map(pos => [pos,
    order.filter(p => p.position === pos).sort((a, b) => a.priceTenths - b.priceTenths)]));
  // The cheapest fill of the open slots once `pick` has joined, cheapest first
  // within the club limit: a way to finish the squad, so taking `pick` never
  // leaves one that cannot be finished.
  const fill = pick => {
    const left = { ...open, [pick.position]: open[pick.position] - 1 };
    const count = new Map(clubs).set(pick.teamId, (clubs.get(pick.teamId) ?? 0) + 1);
    let total = 0;
    for (const [pos, n] of Object.entries(left)) {
      let taken = 0;
      for (const p of byPosition[pos]) {
        if (taken === n) break;
        if (chosen.has(p.id) || p.id === pick.id || (count.get(p.teamId) ?? 0) >= maxPerClub) continue;
        count.set(p.teamId, (count.get(p.teamId) ?? 0) + 1);
        total += p.priceTenths;
        taken += 1;
      }
      if (taken < n) return Infinity;
    }
    return total;
  };
  let left = budgetTenths;
  for (const p of order) {
    if (!open[p.position] || (clubs.get(p.teamId) ?? 0) >= maxPerClub) continue;
    if (p.priceTenths + fill(p) > left) continue;
    chosen.add(p.id);
    open[p.position] -= 1;
    clubs.set(p.teamId, (clubs.get(p.teamId) ?? 0) + 1);
    left -= p.priceTenths;
  }
  if (Object.values(open).some(n => n > 0)) return null;
  return { ids: [...chosen], costTenths: budgetTenths - left };
}

/** A seeded random squad: pickSquad on an order drawn by weight price^2, redrawn until it spends minSpendTenths. */
export function randomSquad(pool, random, { budgetTenths, minSpendTenths, maxPerClub = MAX_PER_CLUB, slots = SQUAD_LIMITS }) {
  for (let i = 0; i < RANDOM_TRIES; i++) {
    // Weighted sampling without replacement: sort by u^(1/w).
    const order = pool.map(p => ({ p, key: random() ** (1 / (p.priceTenths ** RANDOM_PRICE_POWER)) }))
      .sort((a, b) => b.key - a.key).map(x => x.p);
    const squad = pickSquad(order, { budgetTenths, maxPerClub, slots });
    if (squad && squad.costTenths >= minSpendTenths) return squad;
  }
  throw new Error('randomSquad: no squad spent the floor');
}

// ─── Policies ────────────────────────────────────────────────────────────────

/**
 * A week's moves made a pick at a time: `pick` sees the squad after the moves
 * so far, a free transfer fewer for each, the players bought this week
 * (locks: never sold again the same week) and those sold (bans: never bought
 * back), and returns its next moves (Funds' pick is two) or none. Stops when
 * it has none or after maxPicks picks.
 */
function pickRepeatedly(ctx, maxPicks, pick) {
  const moves = [];
  let state = ctx.state;
  const locks = new Set();
  const bans = new Set();
  for (let picks = 1; ; picks++) {
    const next = pick({ ...ctx, state, locks, bans });
    moves.push(...next);
    if (!next.length || picks >= maxPicks) return { moves };
    state = { ...applyMoves(state, next, ctx.world, ctx.t), ft: Math.max(0, state.ft - next.length) };
    for (const m of next) {
      locks.add(m.inId);
      bans.add(m.outId);
    }
  }
}

/**
 * The roll baseline: the free move whose buy out-projects his sale by the
 * most over `horizon` GWs on their own points (no squad, no lineup), made
 * only when it clears `gain` - any gain at all once the free transfers are at
 * the cap, where rolling wastes one. Never a hit. With maxPicks above one it
 * keeps going while free transfers last.
 */
export function rollPolicy({ gain, horizon, maxBankedFt, maxPicks = 1 }) {
  return {
    decide(ctx) {
      return pickRepeatedly(ctx, maxPicks, ({ t, state, world, locks, bans }) => {
        if (state.ft <= 0) return [];
        const projections = world.projections(t);
        const own = id => sum(projections.get(id)?.gws.slice(0, horizon) ?? [], g => g.xpts);
        const current = squadState(state, world, t);
        let best = null;
        for (const p of current.players) {
          if (locks.has(p.playerId)) continue;
          const mine = own(p.playerId);
          for (const q of world.candidates(t)) {
            if (q.position !== p.position || bans.has(q.id) || !checkSwap(current, p.playerId, q).ok) continue;
            const g = own(q.id) - mine;
            if (!best || g > best.gain) best = { outId: p.playerId, inId: q.id, gain: g };
          }
        }
        const threshold = state.ft >= maxBankedFt ? 0 : gain;
        return best && best.gain > threshold ? [{ outId: best.outId, inId: best.inId }] : [];
      });
    },
  };
}

/**
 * The new engine in one mode: its root move, and Funds' chained second move
 * after it. `engine({t, state, world, locks, bans})` returns runDecisionEngine's
 * result. With maxPicks above one it asks again on the new squad, as the
 * planner is used, until the engine's own costs make it roll.
 */
export function enginePolicy(modeId, engine, { maxPicks = 1 } = {}) {
  return {
    decide(ctx) {
      return pickRepeatedly(ctx, maxPicks, c => {
        const mode = engine(c).modes[modeId];
        if (mode.call !== 'move') return [];
        return [mode.root, mode.root.chained].filter(Boolean).map(m => ({ outId: m.outId, inId: m.inId }));
      });
    },
  };
}

// ─── The season ──────────────────────────────────────────────────────────────

/**
 * Each policy's season from `start` ({squad: [{id, purchaseTenths}], bankTenths, ft}),
 * a week at a time across them all, so whatever the world caches for a week
 * is shared while it is current. Each week: the policy's moves, the hits past
 * the free transfers, the squad after them scored on that week's actual points.
 *
 * @param {Object<string, {decide: Function}>} policies
 * @returns {Object<string, {gws: object[], total: number}>}  total is net of hits
 */
export function simulateAll(world, start, policies, { fromGw, toGw, maxBankedFt, hitCost }) {
  const runs = Object.fromEntries(Object.keys(policies).map(name => [name,
    { state: { squad: start.squad, bankTenths: start.bankTenths }, ft: start.ft, gws: [] }]));
  for (let t = fromGw; t <= toGw; t++) {
    for (const [name, policy] of Object.entries(policies)) {
      const run = runs[name];
      const { state, ft } = run;
      const decision = policy.decide({ t, state: { ...state, ft }, world });
      const { moves } = decision;
      const next = applyMoves(state, moves, world, t);
      const after = next.squad.map(p => p.id);
      run.gws.push({
        t, ft, moves, note: decision.note ?? null,
        hits: Math.max(0, moves.length - ft) * hitCost,
        points: world.gwPoints(after, t),
        before: state.squad.map(p => p.id), after, stateBefore: state, bankTenths: next.bankTenths,
        // At the cap, a week without a move loses the free transfer it would have banked.
        lostFt: t < toGw && ft >= maxBankedFt && moves.length === 0,
      });
      run.ft = nextFreeTransfers(ft, moves.length, { max: maxBankedFt, topUp: world.ftTopUp(t + 1) });
      run.state = next;
    }
  }
  return Object.fromEntries(Object.entries(runs).map(([name, { gws }]) => [name, { gws, total: sum(gws, g => g.points - g.hits) }]));
}

/** One policy's season: simulateAll with one policy. */
export function simulate(world, start, policy, opts) {
  return simulateAll(world, start, { policy }, opts).policy;
}

/**
 * Per week with moves: the realised gain over 1, 3 and 5 GWs (cut at the
 * season's end) of the squad after them against the squad before, both held
 * as they were, less the week's hits; the same on the projections made that
 * week; and, for a single move, its sell regret - the most the same buy would
 * have gained over five GWs with any other legal sale, less what this sale did.
 */
export function moveMetrics(run, world, { toGw }) {
  return run.gws.filter(g => g.moves.length).map(g => {
    const window = k => Array.from({ length: Math.min(k, toGw - g.t + 1) }, (_, i) => g.t + i);
    const realisedOf = ids => sum(window(Math.max(...GAIN_WINDOWS)), u => world.gwPoints(ids, u) - world.gwPoints(g.before, u));
    const realised = {};
    const expected = {};
    for (const k of GAIN_WINDOWS) {
      realised[k] = sum(window(k), u => world.gwPoints(g.after, u) - world.gwPoints(g.before, u)) - g.hits;
      expected[k] = sum(window(k), u => world.expectedPoints(g.after, u, g.t) - world.expectedPoints(g.before, u, g.t)) - g.hits;
    }
    let sellRegret = null;
    if (g.moves.length === 1) {
      const [{ outId, inId }] = g.moves;
      const current = squadState(g.stateBefore, world, g.t);
      const buy = asBuy(world, inId, g.t);
      const chosen = realisedOf(g.after);
      const others = current.players.filter(p => p.playerId !== outId && checkSwap(current, p.playerId, buy).ok)
        .map(p => realisedOf(g.before.map(id => (id === p.playerId ? inId : id))));
      sellRegret = Math.max(0, ...others.map(alt => alt - chosen));
    }
    const free = Math.min(g.moves.length, g.ft);
    return { gw: g.t, moves: g.moves, realised, expected, sellRegret, free, hit: g.moves.length - free, hits: g.hits };
  });
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * The mean of paired differences with a 95% bootstrap interval. Each stratum
 * (a season) is a squads x gameweeks matrix; each draw resamples its squads
 * and its gameweeks in circular blocks of `block` (neighbouring weeks share
 * squads and fixtures), so the interval covers both the squads drawn and the
 * football played.
 *
 * @param {number[][][]} strata
 * @returns {{mean: number, lo: number, hi: number}}
 */
export function pairedBootstrap(strata, { block, draws, seed }) {
  const random = seededRandom(seed);
  const cells = sum(strata, m => m.length * m[0].length);
  const means = [];
  for (let d = 0; d < draws; d++) {
    let total = 0;
    for (const m of strata) {
      const gws = m[0].length;
      const size = Math.min(block, gws);
      const cols = [];
      while (cols.length < gws) {
        const start = Math.floor(random() * gws);
        for (let i = 0; i < size && cols.length < gws; i++) cols.push((start + i) % gws);
      }
      for (let s = 0; s < m.length; s++) {
        const row = m[Math.floor(random() * m.length)];
        total += sum(cols, c => row[c]);
      }
    }
    means.push(total / cells);
  }
  means.sort((a, b) => a - b);
  return {
    mean: sum(strata, m => sum(m, row => sum(row))) / cells,
    lo: means[Math.floor(LOWER_TAIL * draws)],
    hi: means[Math.ceil(UPPER_TAIL * draws) - 1],
  };
}

/** Ordinary least squares of y on x. */
export function slope(xs, ys) {
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  const sxy = sum(xs, (x, i) => (x - mx) * (ys[i] - my));
  const sxx = sum(xs, x => (x - mx) ** 2);
  const b = sxy / sxx;
  return { slope: b, intercept: my - (b * mx) };
}

/**
 * slope with a 95% interval from resampling the (x, y) pairs; a draw with
 * every x alike has no slope and is redrawn. NaN throughout when the pairs
 * have fewer than two different x.
 */
export function slopeInterval(xs, ys, { draws, seed }) {
  if (new Set(xs).size < 2) return { slope: NaN, lo: NaN, hi: NaN };
  const random = seededRandom(seed);
  const n = xs.length;
  const slopes = [];
  while (slopes.length < draws) {
    const picks = Array.from({ length: n }, () => Math.floor(random() * n));
    const b = slope(picks.map(i => xs[i]), picks.map(i => ys[i])).slope;
    if (Number.isFinite(b)) slopes.push(b);
  }
  slopes.sort((a, b) => a - b);
  return { slope: slope(xs, ys).slope, lo: slopes[Math.floor(LOWER_TAIL * draws)], hi: slopes[Math.ceil(UPPER_TAIL * draws) - 1] };
}
