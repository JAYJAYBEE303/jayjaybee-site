/**
 * js/engine/squad-value.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * The squad value V_t(S) (brief §4): what a 15-man squad is expected to score
 * in gameweek t - the best XI, the captain's extra points, the expected
 * autosub recovery, and under Bench Boost the whole bench. Every
 * recommendation the decision engine makes is a difference of this function,
 * so a sale is scored by what it does to the whole squad rather than by the
 * player's own points.
 *
 * Reads projections only (engine/projections.js). Their xpts already includes
 * minutes, so nothing here multiplies by a start probability again.
 *
 * See docs/decision-engine-plan.md §5.2 and Phase 2.
 */

import {
  DECISION_ENGINE, XI_FORMATION_MIN, CAPTAIN_MULTIPLIER, TRIPLE_CAPTAIN_MULTIPLIER,
} from '../config.js';
import { pickStartingXI } from './lineup.js';

// FPL processes absent starters in team-sheet order: defenders, then
// midfielders, then forwards. The keeper is a separate slot.
const OUTFIELD = ['DEF', 'MID', 'FWD'];

/**
 * V_t(S) for one gameweek.
 *
 * @param {number[]} squad  15 player ids; each needs an entry in `projections`
 *   (the decision engine adds its ghost there for KeepValue)
 * @param {number} t        the gameweek
 * @param {Map<number, {position: string, gws: object[]}>} projections  buildProjections output
 * @param {object} [opts]
 * @param {null|'benchboost'|'triplecaptain'} [opts.chip]
 * @param {'linear'|'probability'} [opts.autosubMode]  DECISION_ENGINE.autosubMode by default
 * @param {{s1: number, s2: number, s3: number, gk: number}} [opts.benchWeightsLinear]
 * @returns {{ value: number, xi: number[], bench: number[], captainId: number|null,
 *   viceId: number|null, components: { xi: number, captain: number, autosub: number,
 *   benchBoost: number } }}
 *   bench: outfield in DECISION_ENGINE.benchOrder, reserve keeper last.
 *   components sum to value; benchBoost is the bench's xpts less the autosub
 *   recovery already credited, so a boosted week never counts a sub twice.
 */
export function squadValue(squad, t, projections, {
  chip = null,
  autosubMode = DECISION_ENGINE.autosubMode,
  benchWeightsLinear = DECISION_ENGINE.benchWeightsLinear,
} = {}) {
  const entries = squad.map(id => {
    const gw = gameweekOf(projections, id, t);
    return { player: { id, position: gw.position }, gw };
  });
  const { xi, bench } = pickStartingXI(entries, e => e.gw.xpts);
  const xiGws    = xi.map(e => e.gw);
  const benchGws = orderBench(bench.map(e => e.gw));

  const captain = pickCaptain(xiGws);
  const multiplier = chip === 'triplecaptain' ? TRIPLE_CAPTAIN_MULTIPLIER : CAPTAIN_MULTIPLIER;
  const xiValue = sum(xiGws, g => g.xpts);
  const captainValue = (multiplier - 1) * captain.bonus;
  const autosub = recovery(xiGws, benchGws, autosubMode, benchWeightsLinear);
  const benchBoost = chip === 'benchboost' ? sum(benchGws, g => g.xpts) - autosub : 0;

  return {
    value: xiValue + captainValue + autosub + benchBoost,
    xi:    xiGws.map(g => g.playerId),
    bench: benchGws.map(g => g.playerId),
    captainId: captain.captainId,
    viceId:    captain.viceId,
    components: { xi: xiValue, captain: captainValue, autosub, benchBoost },
  };
}

/**
 * Expected points the bench adds through autosubs, for a fixed XI and bench.
 * Exported so formation and absent-starter cases can be tested without the
 * XI being re-picked around them.
 *
 * 'probability' (brief §4.3): exact under independent absences. A bench
 * player comes on only if he plays, at most once, in bench order, when the
 * swap keeps a legal formation (XI_FORMATION_MIN); the reserve keeper covers
 * only the keeper. 'linear': fixed weights per bench slot on each sub's xpts.
 *
 * @param {number[]} xi          11 player ids
 * @param {number[]} benchOrder  bench ids in priority order; the reserve
 *   keeper is found by position, wherever he sits
 * @param {number} t
 * @param {Map} projections
 * @param {'linear'|'probability'} mode
 * @param {object} [weights]  DECISION_ENGINE.benchWeightsLinear by default
 * @returns {number}
 */
export function autosubRecovery(xi, benchOrder, t, projections, mode,
  weights = DECISION_ENGINE.benchWeightsLinear) {
  return recovery(
    xi.map(id => gameweekOf(projections, id, t)),
    benchOrder.map(id => gameweekOf(projections, id, t)),
    mode, weights);
}

function recovery(xiGws, benchGws, mode, weights) {
  const benchKeeper = benchGws.find(g => g.position === 'GKP') ?? null;
  const subs = benchGws.filter(g => g.position !== 'GKP');

  if (mode === 'linear') {
    const slotWeights = [weights.s1, weights.s2, weights.s3];
    return subs.reduce((total, g, i) => total + ((slotWeights[i] ?? 0) * g.xpts), 0)
      + (benchKeeper ? weights.gk * benchKeeper.xpts : 0);
  }
  if (mode !== 'probability') throw new TypeError(`autosubRecovery: unknown mode '${mode}'`);

  const keeper = xiGws.find(g => g.position === 'GKP');
  const keeperCover = keeper && benchKeeper ? keeper.pZero * benchKeeper.xpts : 0;
  return keeperCover + outfieldRecovery(xiGws.filter(g => g.position !== 'GKP'), subs);
}

/**
 * Expected outfield recovery, exact. The result depends only on how many
 * starters are absent at each position (they are processed in OUTFIELD order
 * and are interchangeable within one) and on which subs play. With c subs
 * playing, absences past c at one position change nothing: each further one
 * either finds no sub left or fails exactly as the one before it did. So each
 * position's count is capped at c, the tail probability folded into the cap:
 * at most (c + 1)^3 absence states per play/miss outcome of the subs, and none
 * at all when no sub plays.
 */
function outfieldRecovery(starters, subs) {
  const formation = OUTFIELD.map(pos => starters.filter(g => g.position === pos).length);
  const subPositions = subs.map(g => OUTFIELD.indexOf(g.position));
  const absences = OUTFIELD.map(pos => absenceDistribution(
    starters.filter(g => g.position === pos).map(g => g.pZero), subs.length));
  const statesByCap = new Map();

  let expected = 0;
  for (let plays = 1; plays < (1 << subs.length); plays++) {
    let pPlays = 1;
    let playing = 0;
    for (let j = 0; j < subs.length; j++) {
      if (plays & (1 << j)) {
        pPlays *= 1 - subs[j].pZero;
        playing++;
      } else {
        pPlays *= subs[j].pZero;
      }
    }
    if (pPlays === 0) continue;

    if (!statesByCap.has(playing)) statesByCap.set(playing, absenceStates(absences, playing));
    for (const { counts, p } of statesByCap.get(playing)) {
      expected += pPlays * p * replayAutosubs(formation, counts, subPositions, subs, plays);
    }
  }
  return expected;
}

/**
 * Every combination of absence counts across OUTFIELD with a non-zero chance,
 * each position's count capped at `cap` with its tail folded in.
 * @returns {Array<{counts: number[], p: number}>}
 */
function absenceStates(absences, cap) {
  let states = [{ counts: [], p: 1 }];
  for (const dist of absences) {
    const folded = [...dist.slice(0, cap), dist.slice(cap).reduce((sum, p) => sum + p, 0)];
    states = states.flatMap(s => folded
      .map((p, k) => ({ counts: [...s.counts, k], p: s.p * p }))
      .filter(next => next.p > 0));
  }
  return states;
}

/**
 * FPL's autosubs for one outcome: each absent starter, in OUTFIELD order,
 * takes the first unused sub who played and keeps the formation legal.
 * Positions are OUTFIELD indices; `used` and `plays` are bitmasks over subs.
 * @returns {number}  the subs' points, each at his xptsIfPlays
 */
function replayAutosubs(formation, absentCounts, subPositions, subs, plays) {
  const current = formation.slice();
  let used = 0;
  let gained = 0;
  for (let pos = 0; pos < OUTFIELD.length; pos++) {
    for (let n = 0; n < absentCounts[pos]; n++) {
      let pick = -1;
      for (let j = 0; j < subs.length && pick < 0; j++) {
        const free = (plays & (1 << j)) && !(used & (1 << j));
        if (free && legalAfterSwap(current, pos, subPositions[j])) pick = j;
      }
      // The formation is unchanged by a failed search, so every further
      // absence at this position would fail the same way.
      if (pick < 0) break;
      used |= 1 << pick;
      current[pos]--;
      current[subPositions[pick]]++;
      gained += subs[pick].xptsIfPlays;
    }
  }
  return gained;
}

/**
 * Whether swapping a starter at outPos for a sub at inPos keeps the XI legal.
 * Only the position losing a player can fall below its minimum, and the
 * squad's own limits (5 DEF, 5 MID, 3 FWD) are the formation maximums.
 */
function legalAfterSwap(formation, outPos, inPos) {
  return outPos === inPos || formation[outPos] - 1 >= XI_FORMATION_MIN[OUTFIELD[outPos]];
}

/**
 * The chance that exactly k of these starters are absent, for k below `cap`,
 * and that `cap` or more are, in the last slot (Poisson-binomial).
 * @returns {number[]}  length cap + 1
 */
function absenceDistribution(pZeros, cap) {
  let dist = [1, ...Array(cap).fill(0)];
  for (const pZero of pZeros) {
    const next = dist.map(() => 0);
    dist.forEach((p, k) => {
      next[k] += p * (1 - pZero);
      next[Math.min(cap, k + 1)] += p * pZero;
    });
    dist = next;
  }
  return dist;
}

/**
 * The captain and vice maximising the captain's extra points: his own xpts,
 * plus the vice's xpts when he does not play (brief §4.2). xpts_v is the
 * vice's unconditional figure, his own absence included.
 */
function pickCaptain(xiGws) {
  let best = { captainId: null, viceId: null, bonus: 0 };
  for (const c of xiGws) {
    let vice = null;
    for (const v of xiGws) {
      if (v !== c && (!vice || v.xpts > vice.xpts)) vice = v;
    }
    const bonus = c.xpts + (vice ? c.pZero * vice.xpts : 0);
    if (best.captainId === null || bonus > best.bonus) {
      best = { captainId: c.playerId, viceId: vice?.playerId ?? null, bonus };
    }
  }
  return best;
}

/** Outfield subs by DECISION_ENGINE.benchOrder, descending; the reserve keeper last. */
function orderBench(benchGws) {
  const key = DECISION_ENGINE.benchOrder;
  return [
    ...benchGws.filter(g => g.position !== 'GKP').sort((a, b) => b[key] - a[key]),
    ...benchGws.filter(g => g.position === 'GKP'),
  ];
}

/** A player's projection for gameweek t, with his id and position on it. */
function gameweekOf(projections, playerId, t) {
  const projection = projections.get(playerId);
  const gw = projection?.gws.find(g => g.gw === t);
  if (!gw) throw new TypeError(`squadValue: no projection for player ${playerId} in GW${t}`);
  return { ...gw, playerId, position: projection.position };
}

function sum(items, valueOf) {
  return items.reduce((total, item) => total + valueOf(item), 0);
}
