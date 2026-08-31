/**
 * js/engine/transfers.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * Enumerates every legal transfer for a squad and scores each one on five
 * independent lanes. One enumeration pass, not five: the lanes must be
 * comparable for engine/strategy.js to state a margin between them, and a
 * single pass over a shared spine is what makes that honest.
 *
 * The spine is engine/lineup.js. A swap's worth is the change in the squad's
 * projected XI expected points — which is why bench-for-bench churn scores
 * near zero here however large the composite gap between the two players is.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md.
 */

import { scorePlayer as defaultScorePlayer } from './composite.js';
import { pickStartingXI, calcXiExpectedPoints } from './lineup.js';
import {
  SQUAD_TOTAL, HIT_PENALTY, CANDIDATE_POOL_PER_POS,
  FUTURE_WINDOW_START, FUTURE_WINDOW_GWS,
} from '../config.js';

/**
 * Memoised scoring. The Planner re-renders on every budget keystroke, and a
 * naive implementation re-scores ~2,000 players each time; two windows would
 * double that. The cache is created per enumerateSwaps call and handed back to
 * the caller so it can survive across renders (see spec §11).
 */
function memoScore(cache, player, horizon, ctx, scoreFn) {
  const cached = cache.get(player.id);
  if (cached) return cached;
  let score;
  try {
    score = scoreFn(player, horizon, ctx);
  } catch {
    return null;
  }
  cache.set(player.id, score);
  return score;
}

/**
 * The top CANDIDATE_POOL_PER_POS players per position, by near-window score,
 * excluding anyone already in the squad.
 *
 * Scores every eligible player through the caller's memoised `scoreNear`
 * closure rather than calling rankPlayers separately — rankPlayers would score
 * the same ~626 players a second time under a cache the enumeration loop below
 * can't see, doubling the near-window scoring cost for no benefit. Routing
 * through the shared cache means every player is scored at most once, and the
 * cache is warm by the time the enumeration loop asks for these same
 * candidates again.
 *
 * MODEL: bounding the pool by rank rather than scoring all ~700 players is what
 * keeps the enumeration affordable. A transfer target outside the top 40 of its
 * position is not a recommendation this tool would ever make, so nothing of
 * value is lost — but the bound is config, not a hard-coded assumption.
 *
 * @param {Player[]} allPlayers   the full player pool
 * @param {number[]} squadIds     the user's 15 player ids, excluded from pools
 * @param {(player: Player) => (object|null)} scoreNear  memoised near-window
 *   scorer; returns null (and the player is skipped) if scoring fails
 * @returns {Object<string, Player[]>}  keyed by position, each sorted by
 *   score.value descending
 */
function buildCandidatePools(allPlayers, squadIds, scoreNear) {
  const squadSet = new Set(squadIds);
  const pools = { GKP: [], DEF: [], MID: [], FWD: [] };
  const scored = { GKP: [], DEF: [], MID: [], FWD: [] };

  for (const player of allPlayers) {
    const bucket = scored[player?.position];
    if (!bucket || squadSet.has(player.id)) continue;
    const score = scoreNear(player);
    if (!score) continue;
    bucket.push({ player, score });
  }

  for (const pos of Object.keys(scored)) {
    scored[pos].sort((a, b) => b.score.value - a.score.value);
    pools[pos] = scored[pos].slice(0, CANDIDATE_POOL_PER_POS).map(row => row.player);
  }
  return pools;
}

/** Replace one entry in a scored squad, returning a new array. */
function withSwap(entries, outId, inEntry) {
  return entries.map(e => (e.player.id === outId ? inEntry : e));
}

/**
 * Enumerate every legal single transfer and score it.
 *
 * @param {number[]} squadIds        the user's 15 player ids
 * @param {Player[]} allPlayers      the full player pool
 * @param {object}   ctx             from buildScoreContext()
 * @param {object}   opts            { horizon, budget, freeTransfers,
 *                                     allowExtraHit, scorePlayerFn?, caches? }
 * @returns {Array<Swap>}  unsorted; callers sort by whichever lane they render
 */
export function enumerateSwaps(squadIds, allPlayers, ctx, opts = {}) {
  const {
    horizon, budget = 0, freeTransfers = 1, allowExtraHit = false,
    scorePlayerFn = defaultScorePlayer, caches = null,
  } = opts;

  if (!Array.isArray(squadIds) || squadIds.length < SQUAD_TOTAL) return [];
  if (!horizon || !ctx) return [];

  const nearCache = caches?.near ?? new Map();
  const farCache  = caches?.far  ?? new Map();

  // The far window shifts the START of the fixture window, not the whole model.
  // MODEL: form terms stay measured from today because future form is not
  // knowable; only the fixtures being scored move forward.
  const farCtx = { ...ctx, currentGw: (ctx.currentGw ?? 1) + FUTURE_WINDOW_START };
  const farHorizon = { label: 'Future', gws: FUTURE_WINDOW_GWS };

  const byId = new Map(allPlayers.map(p => [p.id, p]));
  const scoreNear = p => memoScore(nearCache, p, horizon, ctx, scorePlayerFn);
  const scoreFar  = p => memoScore(farCache, p, farHorizon, farCtx, scorePlayerFn);

  // Baseline: the squad as it stands, in both windows.
  const nearEntries = [];
  const farEntries  = [];
  for (const id of squadIds) {
    const player = byId.get(id);
    if (!player) continue;
    const near = scoreNear(player);
    const far  = scoreFar(player);
    if (!near || !far) continue;
    nearEntries.push({ player, score: near });
    farEntries.push({ player, score: far });
  }
  if (nearEntries.length < SQUAD_TOTAL) return [];

  const baseNear = calcXiExpectedPoints(nearEntries);
  const baseFar  = calcXiExpectedPoints(farEntries);
  const baseXiIds = new Set(pickStartingXI(nearEntries).xi.map(e => e.player.id));

  const pools = buildCandidatePools(allPlayers, squadIds, scoreNear);
  // A single transfer is free whenever at least one FT is available. The hit
  // only ever applies to a SECOND move, which computeBestTwoSwap models — so a
  // single swap carries a cost of 0 in every normal state of this page.
  const hitCost = freeTransfers >= 1 ? 0 : HIT_PENALTY;
  const swaps = [];

  for (const outEntry of nearEntries) {
    const outPlayer = outEntry.player;
    for (const inPlayer of pools[outPlayer.position] ?? []) {
      const priceDiff = (inPlayer.price ?? 0) - (outPlayer.price ?? 0);
      if (priceDiff > budget) continue;

      const inNear = scoreNear(inPlayer);
      const inFar  = scoreFar(inPlayer);
      if (!inNear || !inFar) continue;

      const nearAfter = withSwap(nearEntries, outPlayer.id, { player: inPlayer, score: inNear });
      const farAfter  = withSwap(farEntries,  outPlayer.id, { player: inPlayer, score: inFar });

      const nearXiDelta = calcXiExpectedPoints(nearAfter).value - baseNear.value;
      const farXiDelta  = calcXiExpectedPoints(farAfter).value  - baseFar.value;

      const afterXiIds = new Set(pickStartingXI(nearAfter).xi.map(e => e.player.id));

      swaps.push({
        outId: outPlayer.id,
        inId:  inPlayer.id,
        outPlayer,
        inPlayer,
        outScore: outEntry.score,
        inScore:  inNear,
        outFarScore: farEntries.find(e => e.player.id === outPlayer.id)?.score ?? null,
        inFarScore:  inFar,
        priceDiff,
        nearXiDelta,
        farXiDelta,
        lanes: {
          now: {
            value: nearXiDelta - hitCost,
            components: { nearXiDelta, hitCost },
            estimated: Boolean(inNear.expectedPoints?.estimated),
            reasoning: buildNowReasoning(outPlayer, inPlayer, nearXiDelta, hitCost),
          },
          future:    null,   // Task 4
          funds:     null,   // Task 4
          ceiling:   null,   // Task 4
          structure: null,   // Task 4
        },
        flags: {
          outInXi:      baseXiIds.has(outPlayer.id),
          inEntersXi:   afterXiIds.has(inPlayer.id),
          outUnavailable: outPlayer.status !== 'available',
        },
      });
    }
  }

  return swaps;
}

/**
 * Plain-language explanation of a Now-lane score. Built in the engine so the
 * module only renders it — the same contract engine/chips.js already follows.
 *
 * @returns {string}
 */
function buildNowReasoning(outPlayer, inPlayer, nearXiDelta, hitCost) {
  const gain = nearXiDelta.toFixed(1);
  const hit  = hitCost > 0 ? ` after a −${hitCost}pt hit` : '';
  if (Math.abs(nearXiDelta) < 0.2) {
    return `${inPlayer.name} for ${outPlayer.name} barely changes your XI — `
         + 'both would be substitutes, so the projected points are almost identical.';
  }
  return `${inPlayer.name} for ${outPlayer.name} is worth ${gain} points to your `
       + `starting XI over this horizon${hit}.`;
}
