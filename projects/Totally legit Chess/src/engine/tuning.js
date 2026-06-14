/**
 * Tuning constants and per-difficulty modifiers for the cheat scoring engine (Phase 5).
 *
 * Pure data + one pure accessor.  No DOM, headless-safe.
 *
 * Weights (SPEC.md §4):
 *   W_THREAT    desperation: weight of normalised threat
 *   W_SCARCITY  desperation: weight of category-budget scarcity
 *   W_APP       score: weight of blatancy↔desperation appropriateness
 *   W_ADV       score: weight of advantage term (easy/hard add +0.3)
 *   W_QTY       score: weight of remaining-vehicle-quantity factor
 */

// Threat drives desperation more aggressively than budget exhaustion.
export const W_THREAT   = 0.8;
// Budget scarcity is a secondary signal — real threat dominates.
export const W_SCARCITY = 0.2;
// Approp alone cannot clear the threshold; desperation (via Adv) must contribute.
export const W_APP      = 0.7;
// High-advantage cheats score sharply higher under pressure, driving escalation.
export const W_ADV      = 1.2;
// Qty factor is a tiebreaker nudge only.
export const W_QTY      = 0.1;

/**
 * Intermittency gate (resolution G): the top-scoring cheat fires only if its
 * score ≥ the difficulty's threshold, else the CPU plays honest.
 *
 * Threshold design:
 *   medium (1.20) — rare in the opening, occasional once threatened, common endgame.
 *   easy / hard (0.85) — fires a few times in the opening, often in middlegame;
 *     wAdvBonus=0.3 in getDifficultyModifiers also boosts their scores independently.
 *   Gap of 0.35 between easy/hard and medium produces a clearly different frequency.
 */
export const fireThreshold = {
  easy:   0.85,
  medium: 1.20,
  hard:   0.85,
};

/**
 * Per-difficulty modifiers vs the medium baseline (SPEC.md §4).
 *   easy / hard:  W_ADV +0.3,  MxBen ceiling +1,  MnThrt floor -1
 *   medium:       baseline (all zero)
 *
 * Imported by scoring.js (wAdvBonus) and eligibility.js (mxBenDelta / mnThrtDelta).
 * Returns a fresh object; never mutate catalogue or threshold data with it.
 *
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {{ wAdvBonus: number, mxBenDelta: number, mnThrtDelta: number }}
 */
export function getDifficultyModifiers(difficulty) {
  if (difficulty === 'easy' || difficulty === 'hard') {
    return { wAdvBonus: 0.3, mxBenDelta: +1, mnThrtDelta: -1 };
  }
  // medium (and any unrecognised value) → baseline
  return { wAdvBonus: 0, mxBenDelta: 0, mnThrtDelta: 0 };
}
