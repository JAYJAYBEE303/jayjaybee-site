/**
 * tools/minutes/lib.js
 * The offline minutes model's data and maths (docs/decision-engine-plan.md
 * Phase 4), free of file and network access so the tests can drive it.
 * Features come from js/engine/minutes.js, the module the app runs, so a
 * training row and a live projection read a player the same way.
 */

import { DECISION_ENGINE, MATCH_MINUTES, XI_SIZE } from '../../js/config.js';
import { clamp, mean } from '../../js/util.js';
import { excusedAbsence, minutesFeatures, startShare } from '../../js/engine/minutes.js';

// The seasons of vaastav's data the model is fitted on, the one its penalty
// is chosen on, and the one held out to test it (brief §7 Phase 4). 2022-23
// is left out: FPL recorded no starts before its GW16.
export const SPLITS = { train: ['2023-24'], validate: ['2024-25'], test: ['2025-26'] };

// The app's four positions; vaastav writes keepers as GK. Anything else
// (2024-25's assistant managers, AM) is not a player.
const POSITIONS = { GK: 'GKP', GKP: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD' };

// The last-5-starts baseline (brief §7 Phase 4) reads this many gameweeks.
const BASELINE_GWS = 5;

// Two club measures the rows also carry, so the fit can test them against the
// player's own record (REPORT.md, ablation). The app does not compute them.
// Rest beyond this many days (an international break, the season's first
// match) counts as this many; a club's XI changes average over this many
// gameweeks.
const REST_DAYS_CAP = 14;
const ROTATION_WINDOW = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Log loss clips a probability this far off 0 and 1, so a 0/1 baseline that
// misses scores a large finite loss instead of an infinite one.
const LOG_LOSS_CLIP = 1e-3;

// ─── Reading the data ────────────────────────────────────────────────────────

/** RFC 4180 CSV, as rows keyed by the header line. */
export function parseCsv(text) {
  const lines = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      lines.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    lines.push(row);
  }
  const [header, ...rows] = lines;
  return rows
    .filter(r => r.length > 1 || r[0] !== '')
    .map(r => Object.fromEntries(header.map((name, i) => [name, r[i]])));
}

/**
 * One season of vaastav's merged_gw.csv (one row per player per fixture),
 * indexed for buildRows.
 *
 * @param {object[]} rows  parseCsv output
 * @returns {{players: Map<number, {position: string, records: object[]}>,
 *            teams: Map<string, {kickoffs: string[], xis: Array<[number, Set<number>]>}>}}
 *   records: the gameweeks his club played, ascending - a GwRecord plus
 *   points, value (price in tenths), team and kickoff (the gameweek's first);
 *   xis: each club's starters in its single-fixture gameweeks, ascending
 */
export function seasonData(rows, settings = DECISION_ENGINE.minutesFeatures) {
  const byPlayer = new Map();
  const byTeam = new Map();
  for (const row of rows) {
    const position = POSITIONS[row.position];
    if (!position) continue;
    const playerId = Number(row.element);
    const gw = Number(row.GW);
    const minutes = Number(row.minutes);
    const starts = row.starts === undefined || row.starts === '' ? null : Number(row.starts);

    const team = byTeam.get(row.team) ?? { fixtures: new Map(), starters: new Map() };
    byTeam.set(row.team, team);
    team.fixtures.set(row.fixture, { gw, kickoff: row.kickoff_time });
    if (starts === null ? minutes >= settings.playedMinutes : starts > 0) {
      const xi = team.starters.get(gw) ?? new Set();
      team.starters.set(gw, xi.add(playerId));
    }

    const player = byPlayer.get(playerId) ?? { position, gws: new Map() };
    byPlayer.set(playerId, player);
    const record = player.gws.get(gw)
      ?? { gw, fixtures: 0, minutes: 0, starts: 0, points: 0, value: 0, team: row.team, kickoff: row.kickoff_time };
    player.gws.set(gw, record);
    record.fixtures += 1;
    record.minutes += minutes;
    record.starts = record.starts === null || starts === null ? null : record.starts + starts;
    record.points += Number(row.total_points);
    record.value = Number(row.value);
    record.team = row.team;
    // ISO kickoffs in one format sort as text.
    if (row.kickoff_time < record.kickoff) record.kickoff = row.kickoff_time;
  }

  const players = new Map();
  for (const [playerId, { position, gws }] of byPlayer) {
    players.set(playerId, { position, records: [...gws.values()].sort((a, b) => a.gw - b.gw) });
  }
  const teams = new Map();
  for (const [name, { fixtures, starters }] of byTeam) {
    const perGw = new Map();
    for (const { gw } of fixtures.values()) perGw.set(gw, (perGw.get(gw) ?? 0) + 1);
    teams.set(name, {
      kickoffs: [...fixtures.values()].map(f => f.kickoff),
      xis: [...starters].filter(([gw]) => perGw.get(gw) === 1).sort(([a], [b]) => a - b),
    });
  }
  return { players, teams };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/**
 * One row per player per single-fixture gameweek he has features for, read
 * `lead` gameweeks ahead: his record stops before gameweek gw - lead, as a
 * projection made then would see it. Nothing from that gameweek on is read
 * but the row's outcome and its kickoff (the schedule is published in
 * advance); the price is his at the time.
 *
 * No history of FPL's flags exists, so no running absence is excused as
 * flagged: it counts, as it does in the app for a player who is not flagged.
 * Besides minutesFeatures, a row's features hold rest and rotation (see
 * REST_DAYS_CAP).
 *
 * @returns {object[]}  { playerId, gw, lead, features, appear, start, p60,
 *   points, baseline: {appear, start}, v1: {appear, start, p60} | null }
 */
export function buildRows(season, { lead = 0, settings = DECISION_ENGINE.minutesFeatures } = {}) {
  const rows = [];
  const rotations = new Map();
  for (const [playerId, { position, records }] of season.players) {
    for (const target of records) {
      if (target.fixtures !== 1) continue;
      const planningGw = target.gw - lead;
      const history = records.filter(r => r.gw < planningGw);
      if (history.length === 0) continue;
      const excused = excusedAbsence(history, false);
      const contention = history.filter(r => !excused.has(r.gw));
      const team = season.teams.get(target.team);
      const own = minutesFeatures(contention,
        { position, priceTenths: records.findLast(r => r.gw <= planningGw).value }, settings);
      if (!own) continue;
      const features = {
        ...own,
        rest: Math.min(restDays(team.kickoffs, target.kickoff) ?? REST_DAYS_CAP, REST_DAYS_CAP),
        rotation: rotationAt(team, `${target.team}|${planningGw}`, planningGw, rotations),
      };

      const recent = history.slice(-BASELINE_GWS);
      rows.push({
        playerId,
        gw: target.gw,
        lead,
        features,
        appear: target.minutes > 0 ? 1 : 0,
        start:  startShare(target, settings) > 0 ? 1 : 0,
        p60:    target.minutes >= settings.playedMinutes ? 1 : 0,
        points: target.points,
        baseline: {
          appear: mean(recent.map(r => (r.minutes > 0 ? 1 : 0))),
          start:  mean(recent.map(r => startShare(r, settings))),
        },
        v1: v1Rates(contention),
      });
    }
  }
  return rows;
}

function rotationAt(team, key, planningGw, cache) {
  if (!cache.has(key)) cache.set(key, teamRotation(team.xis.filter(([gw]) => gw < planningGw).map(([, xi]) => xi)));
  return cache.get(key);
}

/**
 * Days from his club's latest kickoff before `kickoff` to `kickoff`.
 * @param {string[]} kickoffs  his club's kickoffs (ISO), in any order
 * @param {string} kickoff
 * @returns {number|null}  null when none is earlier
 */
export function restDays(kickoffs, kickoff) {
  const at = new Date(kickoff).getTime();
  let latest = -Infinity;
  for (const k of kickoffs) {
    const time = new Date(k).getTime();
    if (time < at && time > latest) latest = time;
  }
  return latest === -Infinity ? null : (at - latest) / DAY_MS;
}

/**
 * How much a club rotates: the share of its XI changed from one gameweek to
 * the next, averaged over the last `window` changes.
 * @param {Set<number>[]} starterSets  ascending; single-fixture gameweeks only,
 *   as a double's starters span two XIs
 * @returns {number|null}  null with fewer than two gameweeks
 */
export function teamRotation(starterSets, window = ROTATION_WINDOW) {
  const sets = starterSets.slice(-(window + 1));
  if (sets.length < 2) return null;
  const changes = sets.slice(1).map((xi, i) => [...xi].filter(id => !sets[i].has(id)).length);
  return Math.min(1, mean(changes) / XI_SIZE);
}

/**
 * The per-fixture rates projections.js used before this model (plan §2.2),
 * at full availability. Null below minContentionGws, where v1 fell back to a
 * price prior this tool does not rebuild.
 */
function v1Rates(contention) {
  const span = contention.length;
  if (span < DECISION_ENGINE.minContentionGws) return null;
  const appearances = contention.filter(r => r.minutes > 0).length;
  const starts = contention.reduce((sum, r) => sum + (r.starts ?? 0), 0);
  const minutes = contention.reduce((sum, r) => sum + r.minutes, 0);
  const appear = clamp(0, 1, appearances / span);
  const start = Math.min(appear, clamp(0, 1, starts / span));
  const completion = starts > 0 ? clamp(0, 1, minutes / (starts * MATCH_MINUTES)) : 0;
  return { appear, start, p60: start * completion };
}

// ─── Fit and scores ──────────────────────────────────────────────────────────

const logistic = z => 1 / (1 + Math.exp(-z));

/** log(1 + e^z) without overflow. */
const softplus = z => (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)));

function linear(beta, x) {
  let z = beta[0];
  for (let j = 0; j < x.length; j++) z += beta[j + 1] * x[j];
  return z;
}

function objective(X, y, beta, lambda) {
  let total = 0;
  for (let i = 0; i < X.length; i++) {
    const z = linear(beta, X[i]);
    total += (y[i] * z) - softplus(z);
  }
  for (let j = 1; j < beta.length; j++) total -= (lambda / 2) * beta[j] * beta[j];
  return total;
}

/**
 * Ridge-penalised logistic regression by Newton's method (IRLS), each step
 * halved until it no longer lowers the penalised likelihood.
 *
 * @param {number[][]} X  feature rows, no intercept column
 * @param {number[]} y    outcomes, 0 or 1
 * @param {{lambda?: number, maxIterations?: number, tolerance?: number}} [opts]
 *   lambda: the L2 penalty on the weights; the intercept is never penalised
 * @returns {number[]}  [intercept, ...weights]
 */
export function fitLogistic(X, y, { lambda = 0, maxIterations = 100, tolerance = 1e-9 } = {}) {
  const p = X[0].length + 1;
  let beta = new Array(p).fill(0);
  let current = objective(X, y, beta, lambda);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const gradient = new Array(p).fill(0);
    const hessian = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = [1, ...X[i]];
      const mu = logistic(linear(beta, X[i]));
      const w = mu * (1 - mu);
      for (let a = 0; a < p; a++) {
        gradient[a] += (y[i] - mu) * x[a];
        for (let b = a; b < p; b++) hessian[a][b] += w * x[a] * x[b];
      }
    }
    for (let a = 1; a < p; a++) {
      gradient[a] -= lambda * beta[a];
      hessian[a][a] += lambda;
    }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) hessian[a][b] = hessian[b][a];

    const step = solve(hessian, gradient);
    let scale = 1;
    let next = beta.map((b, j) => b + step[j]);
    let nextObjective = objective(X, y, next, lambda);
    while (nextObjective < current && scale > tolerance) {
      scale /= 2;
      next = beta.map((b, j) => b + (scale * step[j]));
      nextObjective = objective(X, y, next, lambda);
    }
    const moved = Math.max(...step.map(s => Math.abs(s * scale)));
    beta = next;
    current = nextObjective;
    if (moved < tolerance) return beta;
  }
  throw new Error(`fitLogistic: no convergence in ${maxIterations} iterations`);
}

/** Gaussian elimination with partial pivoting: x with A x = b. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Mean squared error of probabilities against 0/1 outcomes. */
export function brier(p, y) {
  return mean(p.map((q, i) => (q - y[i]) ** 2));
}

/** Mean negative log-likelihood, each probability clipped into [clip, 1 - clip]. */
export function logLoss(p, y, clip = LOG_LOSS_CLIP) {
  return -mean(p.map((q, i) => {
    const c = clamp(clip, 1 - clip, q);
    return y[i] ? Math.log(c) : Math.log(1 - c);
  }));
}
