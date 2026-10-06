/**
 * js/engine/lineup.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Picks a legal starting XI and bench from a scored 15-man squad, and totals
 * the XI's expected points.
 *
 * Shared by modules/dashboard.js and engine/transfers.js so that both agree on
 * what "your starting XI" means — the transfer lanes are measured as the change
 * in this total, so a disagreement here would silently corrupt every lane.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §6.
 */

import { XI_FORMATION_MIN, XI_SIZE, BENCH_CONTRIBUTION_WEIGHT } from '../config.js';

/**
 * A player's projected points for the window their score was built over.
 *
 * MODEL: expectedPoints, NOT score.value. The composite is a within-position
 * quality index — a 5.0m defender and a 13.0m midfielder can share a composite
 * of 70 while being worlds apart in points. Ordering an XI by the composite
 * therefore benches the wrong players, and measuring a transfer by it ranks a
 * fringe-bench swap above a real upgrade. See FEATURE_ENGINE.md §10.2.
 *
 * @param {{score: object}} entry
 * @returns {number}  points scale, higher = better
 */
function expectedPointsOf(entry) {
  return entry?.score?.expectedPoints?.value ?? 0;
}

/**
 * Select the optimal legal starting XI from a scored squad.
 *
 * Formation rules (FPL): exactly 1 GKP, at least 3 DEF, at least 2 MID, at
 * least 1 FWD, 11 players total. Fill the minimums by expected points
 * descending, then fill remaining outfield slots from the leftover pool.
 * Bench is ordered outfield-by-expected-points descending, reserve GKP last —
 * a keeper can only replace a keeper, so he is never the first substitute.
 *
 * @param {Array<{player: Player, score: object}>} scoredSquad
 * @returns {{ xi: Array<{player, score}>, bench: Array<{player, score}> }}
 */
export function pickStartingXI(scoredSquad) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const entry of scoredSquad ?? []) {
    const pos = entry?.player?.position;
    if (byPos[pos]) byPos[pos].push(entry);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => expectedPointsOf(b) - expectedPointsOf(a));
  }

  const xi = [];
  if (byPos.GKP[0]) xi.push(byPos.GKP[0]);
  const benchGkp = byPos.GKP[1] ?? null;

  xi.push(
    ...byPos.DEF.slice(0, XI_FORMATION_MIN.DEF),
    ...byPos.MID.slice(0, XI_FORMATION_MIN.MID),
    ...byPos.FWD.slice(0, XI_FORMATION_MIN.FWD),
  );

  const pool = [
    ...byPos.DEF.slice(XI_FORMATION_MIN.DEF),
    ...byPos.MID.slice(XI_FORMATION_MIN.MID),
    ...byPos.FWD.slice(XI_FORMATION_MIN.FWD),
  ].sort((a, b) => expectedPointsOf(b) - expectedPointsOf(a));

  const remainingSlots = Math.max(0, XI_SIZE - xi.length);
  xi.push(...pool.slice(0, remainingSlots));

  const benchOutfield = pool.slice(remainingSlots);
  const bench = benchGkp ? [...benchOutfield, benchGkp] : benchOutfield;

  return { xi, bench };
}

/**
 * Total expected points for a squad: the XI in full, plus the bench at
 * BENCH_CONTRIBUTION_WEIGHT.
 *
 * This is the quantity every transfer lane differences. A swap that changes
 * only bench personnel moves it by a fraction of a point; a swap that promotes
 * a player into the XI is credited for the promotion AND for the demotion of
 * whoever they displace, because both fall out of re-picking the XI.
 *
 * @param {Array<{player: Player, score: object}>} scoredSquad
 * @returns {{ value: number, estimated: boolean }}  points scale, higher = better
 */
export function calcXiExpectedPoints(scoredSquad) {
  const { xi, bench } = pickStartingXI(scoredSquad);
  let value = 0;
  let estimated = false;

  for (const entry of xi) {
    value += expectedPointsOf(entry);
    if (entry?.score?.expectedPoints?.estimated) estimated = true;
  }
  for (const entry of bench) {
    value += BENCH_CONTRIBUTION_WEIGHT * expectedPointsOf(entry);
    if (entry?.score?.expectedPoints?.estimated) estimated = true;
  }

  return { value, estimated };
}
