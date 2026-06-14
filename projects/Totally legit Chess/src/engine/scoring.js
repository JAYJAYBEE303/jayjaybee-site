/**
 * Cheat scoring + selection (Phase 5).
 *
 * Pure logic, headless-safe, no DOM.  Receives pre-computed values via
 * arguments — deliberately does NOT import eligibility.js or metrics.js.
 *
 * Principles (SPEC.md §4):
 *   – subtlety is penalised under desperation        → approp term
 *   – Adv weighted higher under high threat           → advFactor (0.5 + 0.5*threatNorm)
 *   – at most one cheat per CPU turn                   → selectBest returns a single app
 *   – emergent escalation, no scripted ramp            → desperation drives everything
 *   – intermittency via fireThreshold (resolution G)   → engine gates on score ≥ threshold
 */

import {
  W_THREAT, W_SCARCITY, W_APP, W_ADV, W_QTY,
  fireThreshold as FIRE_THRESHOLDS,
  getDifficultyModifiers,
} from './tuning.js';

const MAX_RANK = 10;

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  return n < lo ? lo : (n > hi ? hi : n);
}

/**
 * Score a single eligible application.
 *
 * @param {import('./eligibility.js').Application} app
 * @param {{ threatLevel: number }} metrics       — only threatLevel is read
 * @param {ReturnType<import('./budgets.js').createLedger>} ledger
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {number}
 */
export function score(app, metrics, ledger, difficulty) {
  const { wAdvBonus } = getDifficultyModifiers(difficulty);
  const wAdv = W_ADV + wAdvBonus;

  const blatancy   = (MAX_RANK - app.effectiveSbtlRnk) / MAX_RANK;
  const advNorm    = app.effectiveAdv / 10;
  const threatNorm = Math.min(metrics.threatLevel, 10) / 10;

  const categoryBudget  = ledger.categoryBudget(app.category);
  const categoryInitial = ledger.categoryInitial(app.category);
  const budgetScarc     = 1 - categoryBudget / categoryInitial;

  const desperation = clamp(W_THREAT * threatNorm + W_SCARCITY * budgetScarc, 0, 1);
  const approp      = 1 - Math.abs(blatancy - desperation);

  const qty        = ledger.qty(app.cheatId, app.ctx, app.pieceType);
  const qtyInitial = ledger.qtyInitial(app.cheatId, app.ctx, app.pieceType);
  const qtyFactor  = qty / qtyInitial;

  return W_APP * approp
       + wAdv  * advNorm * (0.5 + 0.5 * threatNorm)
       + W_QTY * qtyFactor;
}

/**
 * Deterministically pick the highest-scoring application.
 * First-seen wins ties, so output is stable for a fixed input order.
 *
 * @param {import('./eligibility.js').Application[]} applications
 * @param {{ threatLevel: number }} metrics
 * @param {ReturnType<import('./budgets.js').createLedger>} ledger
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {import('./eligibility.js').Application | null}  null if list empty
 */
export function selectBest(applications, metrics, ledger, difficulty) {
  if (!applications || applications.length === 0) return null;

  let best      = applications[0];
  let bestScore = score(best, metrics, ledger, difficulty);

  for (let i = 1; i < applications.length; i++) {
    const s = score(applications[i], metrics, ledger, difficulty);
    if (s > bestScore) {
      best      = applications[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * Numeric fire threshold for a difficulty (resolution G).
 * Imported by engine.js in Phase 7 to gate selectBest's winner.
 *
 * @param {'easy'|'medium'|'hard'} difficulty
 * @returns {number}
 */
export function fireThreshold(difficulty) {
  return FIRE_THRESHOLDS[difficulty] ?? FIRE_THRESHOLDS.medium;
}
