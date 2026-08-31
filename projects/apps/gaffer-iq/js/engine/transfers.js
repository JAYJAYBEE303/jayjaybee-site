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

import { scorePlayer as defaultScorePlayer, applyDgwUplift, calcExpectedPoints }
  from './composite.js';
import { pickStartingXI, calcXiExpectedPoints } from './lineup.js';
import { groupPerGwSlots } from './fixtures.js';
import { calcPriceChangeRisk } from './prices.js';
import { clamp } from '../util.js';
import {
  SQUAD_TOTAL, BENCH_SIZE, HIT_PENALTY, CANDIDATE_POOL_PER_POS,
  FUTURE_WINDOW_START, FUTURE_WINDOW_GWS, FUTURE_MIN_FAR_GAIN,
  FLEX_W_SPREAD, FLEX_W_HEADROOM, FLEX_CLUMP_BAND, FLEX_HEADROOM_TARGET,
  CEILING_W_PEAK, CEILING_W_HAUL, HAUL_POINTS_THRESHOLD,
  STRUCTURE_PLAYTIME_FLOOR,
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
 * Cheap, no-scoring proxy used only to SELECT which players are worth a full
 * composite score, never to rank them against each other for real. A rough
 * season-points-per-gameweek approximation — NOT the same computation as
 * `calcAvgPointsPerGw`, which prefers real per-GW summary history when it is
 * loaded and otherwise divides by `ctx.playedFixtures`, not `ctx.elapsedGws`.
 * This proxy is deliberately cruder: it exists purely to avoid a `scorePlayer`
 * call before the pool is narrowed, not to match the real average.
 *
 * MODEL: candidate SELECTION uses this cheap historical proxy; candidate
 * RANKING within every lane still runs the full composite via `scoreNear` /
 * `scoreFar`. A mis-ranked pre-filter therefore costs breadth (a good player
 * with a slow start might be excluded from the pool) rather than correctness
 * (nothing that DOES make the pool is ever ordered by this proxy).
 *
 * @param {Player} player
 * @param {object} ctx  from buildScoreContext(); reads ctx.elapsedGws
 * @returns {number}  points-per-gw scale, higher = better; falls back to raw
 *   season points (not a rate) when ctx.elapsedGws is unavailable
 */
function candidateProxyScore(player, ctx) {
  const points = player?.totals?.points ?? 0;
  const elapsedGws = ctx?.elapsedGws;
  if (typeof elapsedGws === 'number' && elapsedGws > 0) {
    return points / Math.max(1, elapsedGws);
  }
  // Fallback: elapsedGws not on this ctx (e.g. a stub in tests). Raw season
  // points is not a rate, but it is still a defensible relative ordering and
  // keeps the pre-filter functioning rather than throwing.
  return points;
}

/**
 * The top CANDIDATE_POOL_PER_POS players per position, excluding anyone
 * already in the squad.
 *
 * Selection is two-staged to stay affordable: first a cheap proxy
 * (`candidateProxyScore`, season points per elapsed gameweek — no
 * `scorePlayer` call) narrows ~626 players down to CANDIDATE_POOL_PER_POS per
 * position, THEN only that narrowed set is scored through the caller's
 * memoised `scoreNear` closure. Scoring the full pool first (as an earlier
 * version of this function did, via rankPlayers) was exactly the cost
 * CANDIDATE_POOL_PER_POS exists to avoid — see spec rationale below.
 *
 * MODEL: bounding the pool by rank rather than scoring all ~700 players is what
 * keeps the enumeration affordable. A transfer target outside the top 40 of its
 * position is not a recommendation this tool would ever make, so nothing of
 * value is lost — but the bound is config, not a hard-coded assumption.
 *
 * @param {Player[]} allPlayers   the full player pool
 * @param {number[]} squadIds     the user's 15 player ids, excluded from pools
 * @param {object}   ctx          from buildScoreContext(); read for elapsedGws
 * @param {(player: Player) => (object|null)} scoreNear  memoised near-window
 *   scorer; returns null (and the player is skipped) if scoring fails
 * @returns {Object<string, Player[]>}  keyed by position, each sorted by
 *   score.value descending
 */
function buildCandidatePools(allPlayers, squadIds, ctx, scoreNear) {
  const squadSet = new Set(squadIds);
  const pools = { GKP: [], DEF: [], MID: [], FWD: [] };
  const shortlisted = { GKP: [], DEF: [], MID: [], FWD: [] };

  for (const player of allPlayers) {
    const bucket = shortlisted[player?.position];
    if (!bucket || squadSet.has(player.id)) continue;
    bucket.push(player);
  }

  for (const pos of Object.keys(shortlisted)) {
    // Cheap proxy narrows the field first; price-descending breaks ties (a
    // pricier player at the same points rate is the stronger transfer target).
    shortlisted[pos].sort((a, b) => {
      const proxyDiff = candidateProxyScore(b, ctx) - candidateProxyScore(a, ctx);
      if (proxyDiff !== 0) return proxyDiff;
      return (b.price ?? 0) - (a.price ?? 0);
    });
    const shortlist = shortlisted[pos].slice(0, CANDIDATE_POOL_PER_POS);

    const scored = [];
    for (const player of shortlist) {
      const score = scoreNear(player);
      if (!score) continue;
      scored.push({ player, score });
    }
    scored.sort((a, b) => b.score.value - a.score.value);
    pools[pos] = scored.map(row => row.player);
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

  const pools = buildCandidatePools(allPlayers, squadIds, ctx, scoreNear);
  // A single transfer is free whenever at least one FT is available. The hit
  // only ever applies to a SECOND move, which computeBestTwoSwap models — so a
  // single swap carries a cost of 0 in every normal state of this page.
  const hitCost = freeTransfers >= 1 ? 0 : HIT_PENALTY;
  const swaps = [];

  const squadPlayers = nearEntries.map(e => e.player);
  const scoresById   = new Map(nearEntries.map(e => [e.player.id, e.score]));
  const flexBefore   = calcSquadFlexibility(squadPlayers, scoresById);

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

      // Keep the full { value, estimated } shape rather than just .value — the
      // aggregate already accounts for every XI/bench member's own estimated
      // flag, and throwing it away under-reports how much of the swap's score
      // rests on estimated data (see lanes.now.estimated below).
      const nearAfterXi = calcXiExpectedPoints(nearAfter);
      const farAfterXi  = calcXiExpectedPoints(farAfter);
      const nearXiDelta = nearAfterXi.value - baseNear.value;
      const farXiDelta  = farAfterXi.value  - baseFar.value;

      const afterXiIds = new Set(pickStartingXI(nearAfter).xi.map(e => e.player.id));

      const afterPlayers = squadPlayers.map(p => (p.id === outPlayer.id ? inPlayer : p));
      const afterScores  = new Map(scoresById);
      afterScores.delete(outPlayer.id);
      afterScores.set(inPlayer.id, inNear);
      const flexAfter = calcSquadFlexibility(afterPlayers, afterScores);
      const priceRisk = calcPriceChangeRisk(inPlayer);

      const swap = {
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
        // Aggregated far-window estimated flag, exposed for Task 4's Future
        // lane to consume without re-running calcXiExpectedPoints(farAfter).
        farEstimated: Boolean(farAfterXi.estimated || inFar.expectedPoints?.estimated),
        lanes: {
          now: {
            value: nearXiDelta - hitCost,
            components: { nearXiDelta, hitCost },
            // True if EITHER the aggregated after-XI estimate is estimated
            // (any XI/bench member, not just the incoming player) OR the
            // incoming player's own expected points are — under-reporting
            // this bit would let the weekly verdict (Task 5) overstate its
            // confidence when the win rests on estimated data.
            estimated: Boolean(nearAfterXi.estimated || inNear.expectedPoints?.estimated),
            reasoning: buildNowReasoning(outPlayer, inPlayer, nearXiDelta, hitCost),
          },
          future:    null,   // filled below
          funds:     null,   // filled below
          ceiling:   null,   // filled below
          structure: null,   // filled below
        },
        flags: {
          outInXi:      baseXiIds.has(outPlayer.id),
          inEntersXi:   afterXiIds.has(inPlayer.id),
          outUnavailable: outPlayer.status !== 'available',
        },
      };

      swap.lanes.future    = scoreFutureLane(swap);
      swap.lanes.funds     = scoreFundsLane(swap, flexBefore, flexAfter, priceRisk);
      swap.lanes.ceiling   = scoreCeilingLane(swap, ctx);
      swap.lanes.structure = scoreStructureLane(swap);
      swaps.push(swap);
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

/**
 * How freely a squad can be restructured, 0–100, higher = more flexible.
 *
 * Two components, weighted by config:
 *
 *  • SPREAD — how much of the squad sits clumped inside one narrow price band.
 *    A squad with six players between 7.0m and 7.6m cannot upgrade any of them
 *    without selling two, which is exactly the trap this measures.
 *  • HEADROOM — how much cash the four most disposable outfield players would
 *    raise, as a fraction of FLEX_HEADROOM_TARGET.
 *
 * MODEL: both components are kept because the constraint has two readings and
 * live use has not settled which dominates. See spec §7.1 — resolving it is a
 * weight change in config.js, not a rewrite here.
 *
 * @param {Player[]} squadPlayers
 * @param {Map<number, object>} scoresById  scorePlayer results, for disposability
 * @returns {{ value: number, components: {spread: number, headroom: number},
 *             estimated: boolean }}
 */
export function calcSquadFlexibility(squadPlayers, scoresById) {
  const players = (squadPlayers ?? []).filter(p => typeof p?.price === 'number');
  if (players.length < 2) {
    return { value: 50, components: { spread: 50, headroom: 50 }, estimated: true };
  }

  // Spread: the average share of the squad sitting within FLEX_CLUMP_BAND of
  // each player. All-identical prices → clumpiness 1 → spread 0.
  let clumpTotal = 0;
  for (const a of players) {
    const near = players.filter(b =>
      b.id !== a.id && Math.abs((b.price ?? 0) - (a.price ?? 0)) <= FLEX_CLUMP_BAND);
    clumpTotal += near.length / (players.length - 1);
  }
  const clumpiness = clumpTotal / players.length;
  const spread = clamp(0, 100, (1 - clumpiness) * 100);

  // Headroom: cash raisable from the four most disposable outfield players,
  // "disposable" being lowest expected points.
  const outfield = players
    .filter(p => p.position !== 'GKP')
    .sort((a, b) =>
      (scoresById?.get(a.id)?.expectedPoints?.value ?? 0)
      - (scoresById?.get(b.id)?.expectedPoints?.value ?? 0));
  const raisable = outfield.slice(0, BENCH_SIZE)
    .reduce((sum, p) => sum + (p.price ?? 0), 0);
  const headroom = clamp(0, 100, (raisable / FLEX_HEADROOM_TARGET) * 100);

  return {
    value: clamp(0, 100, (FLEX_W_SPREAD * spread) + (FLEX_W_HEADROOM * headroom)),
    components: { spread, headroom },
    estimated: !scoresById || scoresById.size === 0,
  };
}

/**
 * Future Prep — ranked by SWING, the amount by which a player's deferred window
 * beats their near one.
 *
 * MODEL: ranking the far window by raw projection would mostly re-list the Now
 * board, because a genuinely good player is good in both windows. Swing isolates
 * the move that is specifically about the future: rough next two, green
 * following four — the buy-before-the-price-rises decision this board exists for.
 *
 * @param {object} swap  a swap object from enumerateSwaps (near-complete; read
 *   before .lanes.future is assigned)
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value on the same points scale as
 *   nearXiDelta/farXiDelta, higher = stronger future-prep candidate
 */
function scoreFutureLane(swap) {
  const swing = swap.farXiDelta - swap.nearXiDelta;
  const qualifies = swap.farXiDelta > FUTURE_MIN_FAR_GAIN;
  return {
    value: qualifies ? swing : 0,
    components: { swing, farXiDelta: swap.farXiDelta, nearXiDelta: swap.nearXiDelta },
    // True if EITHER the aggregated after-XI far estimate is estimated (see
    // swap.farEstimated, exposed by enumerateSwaps for exactly this) OR the
    // incoming player's own far-window expected points are — mirrors the Now
    // lane's pattern above so this lane cannot understate estimated inputs.
    estimated: Boolean(swap.farEstimated || swap.inFarScore?.expectedPoints?.estimated),
    reasoning: qualifies
      ? `${swap.inPlayer.name}'s fixtures improve later: worth `
        + `${swap.farXiDelta.toFixed(1)} points over the deferred window versus `
        + `${swap.nearXiDelta.toFixed(1)} right now — a swing of ${swing.toFixed(1)}.`
      : `${swap.inPlayer.name} does not improve enough later to be a future-prep buy.`,
  };
}

/**
 * Funds & Flexibility — flexibility gained per expected point given up.
 * A move that frees cash and unclumps the squad while costing almost nothing
 * in points scores highest.
 *
 * @param {object} swap
 * @param {{value: number, estimated: boolean}} flexBefore  calcSquadFlexibility on the current squad
 * @param {{value: number, estimated: boolean}} flexAfter   calcSquadFlexibility after this swap
 * @param {{direction: string, confidence: number, reasoning: string}} priceRisk
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value = flexibility points gained per
 *   projected point given up; higher = more efficient flexibility gain
 */
function scoreFundsLane(swap, flexBefore, flexAfter, priceRisk) {
  const flexGain    = flexAfter.value - flexBefore.value;
  const cashFreed   = -swap.priceDiff;
  const pointsGiven = Math.max(0, -swap.nearXiDelta);
  // +1 keeps a free move from dividing by zero and reporting infinite value.
  const value = flexGain / (pointsGiven + 1);
  return {
    value,
    components: {
      flexGain, cashFreed, pointsGiven,
      priceRisk: priceRisk?.direction ?? 'stable',
      // Exposed alongside the direction so consumers (engine/strategy.js's
      // priceDeadline trigger) can gate on how confident the signal is rather
      // than firing on any net-positive transfer flow, however thin.
      priceRiskConfidence: priceRisk?.confidence ?? 0,
    },
    estimated: flexBefore.estimated || flexAfter.estimated,
    reasoning: `Frees £${cashFreed.toFixed(1)}m and moves squad flexibility by `
             + `${flexGain.toFixed(0)} points, at a cost of ${pointsGiven.toFixed(1)} `
             + 'projected points.',
  };
}

/**
 * Ceiling — the best SINGLE gameweek in the window, blended with how often the
 * player has actually hauled.
 *
 * MODEL: FPL exposes no variance data. Haul rate from per-GW history is a
 * backward-looking proxy, thin for players with few starts, and summaries load
 * lazily so it is often absent entirely. This lane flags itself estimated
 * whenever the summary is missing and must never present as being as solid as
 * the Now lane. See spec §7.1.
 *
 * @param {object} swap
 * @param {object} ctx  from buildScoreContext(); reads ctx.playerSummariesById
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value on the same points scale as a
 *   single-gameweek projection, higher = higher ceiling
 */
function scoreCeilingLane(swap, ctx) {
  const score   = swap.inScore;
  const summary = ctx?.playerSummariesById?.[swap.inId] ?? null;

  // A blank slot is scored BLANK_GW_VALUE by groupPerGwSlots/fixtures.js, which
  // is high enough to beat a genuinely hard fixture in a naive max() — the
  // team does not play that week, so it can never be the "peak" week. Blanks
  // are excluded before taking the max; if every slot in the window is blank
  // there is no week to peak in at all, and the lane reports 0 while flagging
  // itself estimated rather than a confident zero.
  const slots = groupPerGwSlots(score?.perGw ?? []);
  const playableSlots = slots.filter(slot => !slot.isBlank);
  const allBlank = playableSlots.length === 0;
  let peakGwValue = 0;
  for (const slot of playableSlots) {
    const raw = slot.fixtures.reduce((s, f) => s + (f.value ?? 0), 0)
              / Math.max(1, slot.fixtures.length);
    peakGwValue = Math.max(peakGwValue, applyDgwUplift(raw, slot.fixtures.length));
  }

  const peak = allBlank
    ? { value: 0, estimated: true }
    : calcExpectedPoints(
        score?.avgPointsPerGw ?? { value: 0, estimated: true },
        { value: peakGwValue },
        score?.breakdown?.minutes ?? { value: 50, estimated: true },
        1,
      );

  const history = summary?.history ?? [];
  const played  = history.filter(h => (h.minutes ?? 0) > 0);
  const hauls   = played.filter(h => (h.points ?? 0) >= HAUL_POINTS_THRESHOLD);
  const haulRate = played.length > 0 ? hauls.length / played.length : 0;

  const value = (CEILING_W_PEAK * peak.value) + (CEILING_W_HAUL * haulRate * peak.value);

  return {
    value,
    components: { peak: peak.value, haulRate, hauls: hauls.length, played: played.length },
    estimated: played.length === 0 || peak.estimated,
    reasoning: allBlank
      ? `${swap.inPlayer.name} has no fixture in this window, so no ceiling can `
        + 'be projected.'
      : played.length === 0
        ? `${swap.inPlayer.name}'s peak week projects at ${peak.value.toFixed(1)} points, `
          + 'but no gameweek history has loaded yet — treat this as a rough estimate.'
        : `${swap.inPlayer.name} has hauled in ${hauls.length} of ${played.length} `
          + `appearances, with a peak week projecting ${peak.value.toFixed(1)} points.`,
  };
}

/**
 * Structure Fix — repairs a broken slot in the STARTING XI. Silent otherwise:
 * a swap involving a healthy bench player is not a structure problem, and the
 * board says "nothing broken" rather than padding itself.
 *
 * @param {object} swap
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value on the same points scale as
 *   nearXiDelta, 0 when there is nothing to repair, higher = more urgent fix
 */
function scoreStructureLane(swap) {
  if (!swap.flags.outInXi) {
    return {
      value: 0, components: {}, estimated: false,
      reasoning: `${swap.outPlayer.name} is not in your projected XI, so this is `
               + 'not a structural repair.',
    };
  }

  const unavailable = swap.outPlayer.status !== 'available';
  // composite.js's no-team fallback branch omits `breakdown.playtime` entirely
  // (see scorePlayer). The `?? 1` below keeps this function total rather than
  // throwing, but that fallback must not be silent — playtimeMissing feeds
  // into `estimated` below in both return branches.
  const playtimeMissing = !swap.outScore?.breakdown?.playtime;
  const playtime    = swap.outScore?.breakdown?.playtime?.value ?? 1;
  const lowPlaytime = playtime < STRUCTURE_PLAYTIME_FLOOR;

  if (!unavailable && !lowPlaytime) {
    return {
      value: 0, components: { playtime }, estimated: playtimeMissing,
      reasoning: `${swap.outPlayer.name} is fit and starting — nothing to repair.`,
    };
  }

  const cause = unavailable
    ? `${swap.outPlayer.name} is flagged ${swap.outPlayer.status}`
    : `${swap.outPlayer.name} is barely starting (playtime ${(playtime * 100).toFixed(0)}%)`;

  return {
    value: Math.max(0, swap.nearXiDelta),
    components: { playtime, unavailable },
    estimated: Boolean(swap.outScore?.breakdown?.playtime?.estimated) || playtimeMissing,
    reasoning: `${cause}. Replacing him with ${swap.inPlayer.name} restores `
             + `${Math.max(0, swap.nearXiDelta).toFixed(1)} points to your XI.`,
  };
}
