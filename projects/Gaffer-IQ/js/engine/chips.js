/**
 * js/engine/chips.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Scores Wildcard / Free Hit / Bench Boost / Triple Captain timing across the
 * coming gameweek window. All four exports are pure: same inputs → same outputs.
 * See ROADMAP.md Phase 4-3 and FEATURE_ENGINE.md §9 (horizon aggregation —
 * blank/double GW handling is the analytical backbone here).
 *
 * Output direction (all scoring functions): higher score = better chip timing.
 * Each recommendation carries an explicit `reasoning` string so the UI never
 * shows a chip pick without showing why (advisory-only product principle).
 */

import {
  CHIP_PLAN_HORIZON, WC_WINDOW, WC_TOP_TEAMS,
  FH_TOP_TEAMS, FH_BLANK_WEIGHT, FH_BLANK_THRESHOLD,
  BB_MIN_DOUBLES,
  HORIZON_DECAY, W_MEAN, W_MIN, BLANK_GW_VALUE,
  PROJ_FORM, PROJ_FIXTURE, PROJ_COUNTER,
} from '../config.js';
import { clamp } from '../util.js';
import { scoreFixture } from './composite.js';
import { calcPlayerForm } from './form.js';
import { calcCounterMatchup } from './counter.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Memoised scoreFixture. Result depends only on (team, fixture, ctx) — none of
 * which vary across chip-window candidate offsets — so a per-call Map cache
 * collapses ~O(GWs × teams × fixtures) scoreFixture invocations into one per
 * unique (team, fixture) pair. Pure: cache is local to one chip computation.
 */
function makeFxCache() {
  const map = new Map();
  return function cached(team, fixture, ctx) {
    const key = team.id + ':' + fixture.id;
    let s = map.get(key);
    if (!s) {
      s = scoreFixture(team, fixture, ctx);
      map.set(key, s);
    }
    return s;
  };
}

/** All fixtures involving `team` in gameweek `gw`. DGWs yield length === 2. */
function teamFixturesInGw(team, gw, ctx) {
  const out = [];
  for (const f of ctx.fixtures) {
    if (f.gw !== gw) continue;
    if (f.homeTeamId === team.id || f.awayTeamId === team.id) out.push(f);
  }
  return out;
}

/**
 * Aggregate a team's composite scores over [startGw, startGw+windowGws-1].
 * Re-implements the blend used in composite.scoreOverHorizon so chip planning
 * can score arbitrary windows without mutating ctx.currentGw repeatedly.
 * Direction: higher = better fixture run for `team`. Pure.
 *
 * @returns {{ value: number, numBlanks: number, numDoubles: number }}
 */
function aggregateWindow(team, startGw, windowGws, ctx, cached) {
  let wSum = 0;
  let wTotal = 0;
  let minVal = 100;
  let numBlanks = 0;
  let numDoubles = 0;

  for (let i = 0; i < windowGws; i++) {
    const gw = startGw + i;
    const w = Math.pow(HORIZON_DECAY, i);
    const fixtures = teamFixturesInGw(team, gw, ctx);

    if (fixtures.length === 0) {
      // MODEL: blank GW contributes BLANK_GW_VALUE — see FEATURE_ENGINE.md §9.
      wSum   += BLANK_GW_VALUE * w;
      wTotal += w;
      if (BLANK_GW_VALUE < minVal) minVal = BLANK_GW_VALUE;
      numBlanks++;
      continue;
    }

    if (fixtures.length > 1) numDoubles++;
    for (const f of fixtures) {
      const s = cached(team, f, ctx);
      wSum   += s.value * w;
      wTotal += w;
      if (s.value < minVal) minVal = s.value;
    }
  }

  const mean = wTotal === 0 ? 50 : wSum / wTotal;
  // 'blend' aggregation matches composite.scoreOverHorizon's default.
  const value = clamp(0, 100, (W_MEAN * mean) + (W_MIN * minVal));
  return { value, numBlanks, numDoubles };
}

/** Look up a player by id across ctx.playersByTeamId. Returns null if missing. */
function findPlayer(playerId, ctx) {
  for (const arr of Object.values(ctx.playersByTeamId || {})) {
    const p = arr.find(pl => pl.id === playerId);
    if (p) return p;
  }
  return null;
}

// ─── Wildcard timing ─────────────────────────────────────────────────────────

/**
 * Score every candidate Wildcard activation GW in [currentGw, currentGw + CHIP_PLAN_HORIZON).
 * MODEL: a good WC activation is the GW BEFORE a long run of good fixtures —
 * so for each candidate activation `x`, we score the WC_WINDOW-GW run starting
 * at `x + 1`, then take the mean horizon score of the WC_TOP_TEAMS strongest
 * teams (you wildcard *into* the teams whose fixtures look great).
 *
 * @param {{label: string, gws: number}} horizon  the active UI horizon (passed
 *   through for API symmetry; the WC window itself is WC_WINDOW from config).
 * @param {object} ctx  output of composite.buildScoreContext
 * @returns {Array<{ gw, score, windowGws, runStartGw, topTeams, reasoning }>}
 *   Sorted by score descending. score: 0–100, higher = better WC activation.
 */
export function scoreWildcardTiming(horizon, ctx) {
  if (!ctx || !ctx.teamsById) {
    throw new TypeError('scoreWildcardTiming: ctx (from buildScoreContext) is required');
  }
  const cached = makeFxCache();
  const startGw = ctx.currentGw;
  const teams = Object.values(ctx.teamsById);
  const candidates = [];

  for (let off = 0; off < CHIP_PLAN_HORIZON; off++) {
    const activateGw = startGw + off;
    const runStartGw = activateGw + 1;

    const teamScores = [];
    for (const team of teams) {
      const agg = aggregateWindow(team, runStartGw, WC_WINDOW, ctx, cached);
      teamScores.push({ teamId: team.id, shortName: team.shortName, value: agg.value });
    }
    teamScores.sort((a, b) => b.value - a.value);
    const top = teamScores.slice(0, WC_TOP_TEAMS);
    const score = top.reduce((s, t) => s + t.value, 0) / Math.max(1, top.length);
    const topNames = top.slice(0, 3).map(t => t.shortName).filter(Boolean).join(', ');

    candidates.push({
      gw: activateGw,
      windowGws: WC_WINDOW,
      runStartGw,
      score,
      topTeams: top,
      reasoning: `${WC_WINDOW}-GW run from GW${runStartGw} averages ${Math.round(score)} ` +
                 `across top ${top.length} sides (${topNames})`,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ─── Free Hit timing ─────────────────────────────────────────────────────────

/**
 * Pick the single best Free Hit GW.
 * MODEL: FH is best when either (a) lots of teams blank — so a one-week rental
 * of a non-blanking XI is huge — or (b) a single GW has exceptionally strong
 * fixtures across a handful of sides. The composite score blends both signals
 * via FH_BLANK_WEIGHT.
 *
 * @param {{label: string, gws: number}} horizon  passed for API symmetry; unused
 *   internally (FH always evaluates the CHIP_PLAN_HORIZON window).
 * @param {object} ctx
 * @returns {null | { gw, score, blankCount, top, reasoning, candidates }}
 *   score: composite (avg top-team 1-GW score + FH_BLANK_WEIGHT × blanks).
 */
export function scoreFreeHitTiming(horizon, ctx) {
  if (!ctx || !ctx.teamsById) {
    throw new TypeError('scoreFreeHitTiming: ctx (from buildScoreContext) is required');
  }
  const cached = makeFxCache();
  const startGw = ctx.currentGw;
  const teams = Object.values(ctx.teamsById);
  const candidates = [];

  for (let off = 0; off < CHIP_PLAN_HORIZON; off++) {
    const gw = startGw + off;
    let blankCount = 0;
    const teamScores = [];

    for (const team of teams) {
      const fxs = teamFixturesInGw(team, gw, ctx);
      if (fxs.length === 0) { blankCount++; continue; }
      let sum = 0;
      for (const f of fxs) sum += cached(team, f, ctx).value;
      teamScores.push({
        teamId:    team.id,
        shortName: team.shortName,
        value:     sum / fxs.length,
        isDgw:     fxs.length > 1,
      });
    }

    teamScores.sort((a, b) => b.value - a.value);
    const top = teamScores.slice(0, FH_TOP_TEAMS);
    const avgTop = top.reduce((s, t) => s + t.value, 0) / Math.max(1, top.length);
    const score = avgTop + (blankCount * FH_BLANK_WEIGHT);

    candidates.push({ gw, blankCount, avgTop, score, top });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;

  let reasoning;
  if (best.blankCount >= FH_BLANK_THRESHOLD) {
    reasoning = `${best.blankCount} teams blank in GW${best.gw} — Free Hit fields an XI from outside the blank pool`;
  } else {
    const names = best.top.slice(0, 3)
      .map(t => t.shortName + (t.isDgw ? ' (DGW)' : ''))
      .filter(Boolean).join(', ');
    reasoning = `GW${best.gw} has the strongest one-week fixtures available: ${names} ` +
                `avg ${Math.round(best.avgTop)}`;
  }

  return {
    gw:         best.gw,
    score:      best.score,
    blankCount: best.blankCount,
    top:        best.top,
    reasoning,
    candidates,
  };
}

// ─── Bench Boost timing ──────────────────────────────────────────────────────

/**
 * Pick the single best Bench Boost GW.
 * MODEL: BB pays out when as many bench players as possible have DGWs in the
 * activation GW. Bench must be supplied via `ctx.benchPlayerIds` (the planner
 * derives this from the current squad — engine stays pure and squad-agnostic).
 * Tiebreaker on DGW count: the GW where bench fixtures project highest.
 *
 * @returns {null | { gw, dgwCount, totalProjected, reasoning, candidates }}
 *   Returns null when bench is empty (chip cannot be meaningfully scored).
 */
export function scoreBenchBoostTiming(horizon, ctx) {
  if (!ctx || !ctx.teamsById) {
    throw new TypeError('scoreBenchBoostTiming: ctx (from buildScoreContext) is required');
  }
  const benchIds = Array.isArray(ctx.benchPlayerIds) ? ctx.benchPlayerIds : [];
  if (benchIds.length === 0) return null;

  const cached = makeFxCache();
  const startGw = ctx.currentGw;
  const benchPlayers = benchIds.map(id => findPlayer(id, ctx)).filter(Boolean);
  const candidates = [];

  for (let off = 0; off < CHIP_PLAN_HORIZON; off++) {
    const gw = startGw + off;
    let dgwCount = 0;
    let totalProjected = 0;

    for (const p of benchPlayers) {
      const team = ctx.teamsById[p.teamId];
      if (!team) continue;
      const fxs = teamFixturesInGw(team, gw, ctx);
      if (fxs.length >= 2) dgwCount++;
      for (const f of fxs) totalProjected += cached(team, f, ctx).value;
    }

    candidates.push({ gw, dgwCount, totalProjected });
  }

  // Best = most bench DGWs; tiebreak by total projected fixture quality.
  candidates.sort((a, b) =>
    (b.dgwCount - a.dgwCount) || (b.totalProjected - a.totalProjected)
  );
  const best = candidates[0];

  let reasoning;
  if (best.dgwCount >= BB_MIN_DOUBLES) {
    reasoning = `${best.dgwCount} of your ${benchPlayers.length} bench players have double GWs in GW${best.gw}`;
  } else if (best.dgwCount === 1) {
    reasoning = `Only 1 bench DGW available (GW${best.gw}) — Bench Boost is better held for a bigger DGW`;
  } else {
    reasoning = `No bench DGWs in the next ${CHIP_PLAN_HORIZON} GWs — hold Bench Boost`;
  }

  return {
    gw:             best.gw,
    dgwCount:       best.dgwCount,
    totalProjected: best.totalProjected,
    reasoning,
    candidates,
  };
}

// ─── Triple Captain timing ───────────────────────────────────────────────────

/**
 * For a specific player, pick the GW whose projected single-GW score is
 * highest. MODEL: a TC pays out on the player's biggest single-week haul, so
 * for SGW we use the player's projected score for that GW; for a DGW we sum
 * across both fixtures (TC scores both fixtures).
 *
 * Cheap shortcut: calcPlayerForm doesn't vary by GW (already a rolling window),
 * so we evaluate it once and only re-score the fixture component per candidate
 * GW — keeps this function fast enough to run inline on every squad change.
 *
 * @param {Player} player
 * @param {{label: string, gws: number}} horizon  passed for API symmetry; unused.
 * @param {object} ctx
 * @returns {null | { gw, score, dgw, reasoning }}
 *   score: 0–200ish — a DGW sums two fixtures so it can exceed 100 on purpose
 *   (that's the whole point of TC into a DGW).
 */
export function scoreTripleCaptainTiming(player, horizon, ctx) {
  if (!player || !ctx || !ctx.teamsById) {
    throw new TypeError('scoreTripleCaptainTiming: player and ctx are required');
  }
  const team = ctx.teamsById[player.teamId];
  if (!team) return null;

  const cached    = makeFxCache();
  const startGw   = ctx.currentGw;
  const playerForm = calcPlayerForm(player, ctx);

  let best = null;
  for (let off = 0; off < CHIP_PLAN_HORIZON; off++) {
    const gw = startGw + off;
    const fxs = teamFixturesInGw(team, gw, ctx);
    if (fxs.length === 0) continue;

    // Per-fixture player-projection contribution = scorePlayer's blend, but
    // applied to a single fixture rather than a horizon. DGWs sum across both.
    let projected = 0;
    for (const f of fxs) {
      const fxScore = cached(team, f, ctx);
      const opponent = ctx.teamsById[
        f.homeTeamId === team.id ? f.awayTeamId : f.homeTeamId
      ];
      // Player counter-edge for this single fixture, matching scorePlayer's
      // position routing (FWD→fwdVsCb, MID→mean(wm,cam), DEF/GKP→100-oppCm).
      let counterValue = 50;
      if (opponent) {
        if (player.position === 'FWD') {
          counterValue = calcCounterMatchup(team, opponent, ctx).pairings.fwdVsCb?.value ?? 50;
        } else if (player.position === 'MID') {
          const cm = calcCounterMatchup(team, opponent, ctx).pairings;
          counterValue = ((cm.wideMidVsFb?.value ?? 50) + (cm.camVsCbMid?.value ?? 50)) / 2;
        } else {
          counterValue = 100 - calcCounterMatchup(opponent, team, ctx).value;
        }
      }
      const single =
          (PROJ_FORM    * playerForm.value)
        + (PROJ_FIXTURE * fxScore.value)
        + (PROJ_COUNTER * counterValue);
      projected += clamp(0, 100, single);
    }

    if (!best || projected > best.score) {
      best = { gw, score: projected, dgw: fxs.length > 1, fixtureCount: fxs.length };
    }
  }

  if (!best) return null;

  const reasoning = best.dgw
    ? `${player.name} has a double GW in GW${best.gw} — combined projected score ${Math.round(best.score)}`
    : `${player.name}'s strongest single fixture is GW${best.gw} (projected ${Math.round(best.score)})`;

  return { gw: best.gw, score: best.score, dgw: best.dgw, reasoning };
}
