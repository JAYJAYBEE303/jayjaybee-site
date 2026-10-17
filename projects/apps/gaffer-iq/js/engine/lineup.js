/**
 * js/engine/lineup.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Picks a legal starting XI and bench from a scored 15-man squad.
 *
 * Shared by modules/dashboard.js (its XI) and engine/squad-value.js (the
 * decision engine's V, ranked by a gameweek's xpts through the value
 * accessor), so both pick the XI by the same rules.
 */

import { XI_FORMATION_MIN, XI_SIZE } from '../config.js';

/**
 * A player's projected points for the window their score was built over.
 *
 * MODEL: expectedPoints, NOT score.value. The composite is a within-position
 * quality index - a 5.0m defender and a 13.0m midfielder can share a composite
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
 * least 1 FWD, 11 players total. Fill the minimums by value (expected points
 * unless `valueOf` says otherwise) descending, then fill remaining outfield
 * slots from the leftover pool. Bench is ordered outfield by the same value
 * descending, reserve GKP last - a keeper can only replace a keeper, so he is
 * never the first substitute.
 *
 * Filling the minimums first and then the best of the rest is optimal: the
 * best XI under any formation holds each position's top players, and the
 * squad's own limits (5 DEF, 5 MID, 3 FWD) are the formation maximums. A test
 * checks it against enumerating every formation.
 *
 * @param {Array<{player: Player}>} scoredSquad
 * @param {(entry: object) => number} [valueOf]  what to maximise; defaults to
 *   the entry's score.expectedPoints. The decision engine passes a
 *   gameweek's xpts (engine/squad-value.js).
 * @returns {{ xi: object[], bench: object[] }}  the entries passed in
 */
export function pickStartingXI(scoredSquad, valueOf = expectedPointsOf) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const entry of scoredSquad ?? []) {
    const pos = entry?.player?.position;
    if (byPos[pos]) byPos[pos].push(entry);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => valueOf(b) - valueOf(a));
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
  ].sort((a, b) => valueOf(b) - valueOf(a));

  const remainingSlots = Math.max(0, XI_SIZE - xi.length);
  xi.push(...pool.slice(0, remainingSlots));

  const benchOutfield = pool.slice(remainingSlots);
  const bench = benchGkp ? [...benchOutfield, benchGkp] : benchOutfield;

  return { xi, bench };
}
