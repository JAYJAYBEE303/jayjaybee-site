/**
 * tools/points/fit.js
 * Fits DECISION_ENGINE.pointsModel on vaastav's seasons and scores the
 * projections it gives against the v1 basis the app used before
 * (docs/decision-engine-plan.md, Phase 6b). Writes tools/points/REPORT.md and
 * prints the config block to paste.
 *
 *   node tools/backtest/download.js && node tools/points/fit.js
 *
 * Every projection runs the app's own path - normaliseSeason,
 * buildScoreContext, buildProjections - on the season as it stood before each
 * planning gameweek (tools/backtest/history.js). Splits: the constants are
 * fitted on 2023-24; the prior weights, the clubs' prior weight, how much of
 * last season's club ratings carries over and the fixture engine's weight are
 * chosen on 2024-25; then the constants are refitted on both and the
 * projections tested on 2025-26, which no fit saw. 2022-23 serves only as
 * 2023-24's club priors (vaastav has its xG from GW16 on). Defensive
 * contributions exist from 2025-26: in the test their prior and spread come,
 * gameweek by gameweek, from the 2025-26 matches before the planning one.
 * vaastav's xP column is recorded after each gameweek, so it is reported as
 * that, not as a benchmark (xpCheck).
 */

import { writeFile } from 'node:fs/promises';

import { DECISION_ENGINE, FIXTURE_SCORE_EVEN, SEASON_GWS } from '../../js/config.js';
import { normaliseSeason } from '../../js/engine/normalise.js';
import { buildScoreContext, scoreFixture } from '../../js/engine/composite.js';
import { buildProjections } from '../../js/engine/projections.js';
import { teamRates, teamStrengths, fixtureGoals } from '../../js/engine/team-goals.js';
import { actualPoints, gwTablesBefore, loadSeason, rawSeasonAt } from '../backtest/history.js';
import { blockBootstrap, promotedPrior, summarise, windowErrors } from './lib.js';
import { constantsFrom, defconBefore, modelOf, POSITIONS } from './model.js';

const DECISIONS = range(4, 34);          // planning gameweeks; each scores its five-gameweek window
const WINDOW = 5;
const RECENT_GWS = 5;                    // a player is scored if he appeared in the five gameweeks before
const BANDS = [['early (GW4-10)', 4, 10], ['mid (GW11-24)', 11, 24], ['late (GW25-34)', 25, 34]];
const BOOTSTRAP = { block: 5, draws: 2000, seed: 1 };
const TOP = 10;                          // the top projected per position, for overstatement and pick quality
const GRID = {
  share: [1, 2, 4, 8, 16],
  per90: [2, 5, 10, 20],
  saves: [2, 5, 10, 20, 40, 80],
  priorMatches: [1, 2, 4, 8, 16, 32, 64],
  regression: [0, 0.25, 0.5, 0.75, 1],
};
const START = { share: 4, per90: 5, saves: 5, priorMatches: 4, regression: 0.5 };
const RATING_WEIGHTS = [-0.4, -0.2, 0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1];
// The fixture engine joins the xG ratings only if it cuts the choice season's
// MSE by at least this share: less is one season's noise, and not worth tying
// the projections to the scorer.
const RATING_MATERIAL = 0.001;
const PASSES = 2;
const LITERAL_WIDTH = 100;               // the config block keeps an object this short on one line

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, digits = 4) => (Number.isFinite(x) ? Number(x.toPrecision(digits)) : x);
const log = (...parts) => console.log(...parts);

// ─── The season as it stood at each planning gameweek ────────────────────────

function contexts(season, { hindsight = false } = {}) {
  const cache = new Map();
  return t => {
    if (!cache.has(t)) {
      const { bootstrap, fixtures } = rawSeasonAt(season, t, { hindsight });
      const s = normaliseSeason(bootstrap, fixtures);
      const ctx = buildScoreContext(s, { currentGw: t });
      const recent = new Set(season.rows.filter(r => r.gw < t && r.gw >= t - RECENT_GWS && r.minutes > 0).map(r => r.element));
      cache.set(t, { s, ctx, gwTable: gwTablesBefore(season, t), population: [...recent].filter(id => s.playersById[id]) });
    }
    return cache.get(t);
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function run(season, ctxAt, pointsModelAt) {
  const actual = actualPoints(season);
  return DECISIONS.map(t => {
    const { s, ctx, gwTable, population } = ctxAt(t);
    const projections = buildProjections(s.players, ctx, { planningGw: t, gwTable, pointsModel: pointsModelAt(t) });
    const errors = windowErrors(projections, actual, population, range(t, t + WINDOW - 1));
    const position = new Map(population.map(id => [id, s.playersById[id].position]));
    return { t, errors, position };
  });
}

const objective = runs => mean(runs.map(r => summarise(r.errors).mse));

/** Per position, the top projected over the window: their overstatement and what they scored. */
function topOfRun({ errors, position }) {
  const byPlayer = new Map();
  for (const e of errors) {
    const p = byPlayer.get(e.playerId) ?? { projected: 0, actual: 0 };
    p.projected += e.projected;
    p.actual += e.actual;
    byPlayer.set(e.playerId, p);
  }
  const over = [];
  const scored = [];
  for (const pos of POSITIONS) {
    const top = [...byPlayer].filter(([id]) => position.get(id) === pos)
      .sort(([, a], [, b]) => b.projected - a.projected).slice(0, TOP).map(([, p]) => p);
    over.push(...top.map(p => p.projected - p.actual));
    scored.push(...top.map(p => p.actual));
  }
  return { over: mean(over), scored: mean(scored) };
}

function report(runs) {
  const all = summarise(runs.flatMap(r => r.errors));
  const tops = runs.map(topOfRun);
  return { ...all, over: mean(tops.map(x => x.over)), scored: mean(tops.map(x => x.scored)) };
}

/** Paired per-decision differences in MSE (a - b: positive means b is better), with block-bootstrap intervals per band. */
function paired(a, b) {
  const diff = a.map((r, i) => ({ t: r.t, d: summarise(r.errors).mse - summarise(b[i].errors).mse }));
  const rows = [['all (GW4-34)', 4, 34], ...BANDS].map(([label, from, to]) => {
    const values = diff.filter(x => x.t >= from && x.t <= to).map(x => x.d);
    return { label, ...blockBootstrap(values, BOOTSTRAP), better: values.filter(d => d > 0).length, of: values.length };
  });
  return rows;
}

/**
 * Whether vaastav's xP column is a forecast: a gameweek's figure against that
 * gameweek's points and the next one's, and the next gameweek's figure against
 * this one's points. A forecast made before a gameweek cannot track its
 * points much better than the next gameweek's.
 */
function xpCheck(season) {
  const xp = new Map();
  const points = new Map();
  for (const r of season.rows) {
    const k = `${r.element}|${r.gw}`;
    if (!xp.has(k)) xp.set(k, r.fplXp);   // a double's rows repeat the gameweek's figure
    points.set(k, (points.get(k) ?? 0) + r.points);
  }
  const corr = (xpShift, pointsShift) => {
    const xs = [];
    const ys = [];
    for (const k of xp.keys()) {
      const [id, gw] = k.split('|').map(Number);
      const x = xp.get(`${id}|${gw + xpShift}`);
      const y = points.get(`${id}|${gw + pointsShift}`);
      if (!x || y === undefined) continue;
      xs.push(x);
      ys.push(y);
    }
    const mx = mean(xs);
    const my = mean(ys);
    const sxy = xs.reduce((a, x, i) => a + ((x - mx) * (ys[i] - my)), 0);
    const sxx = xs.reduce((a, x) => a + ((x - mx) ** 2), 0);
    const syy = ys.reduce((a, y) => a + ((y - my) ** 2), 0);
    return sxy / Math.sqrt(sxx * syy);
  };
  return { same: corr(0, 0), next: corr(0, 1), later: corr(1, 0) };
}

/** Team goals one week ahead: Poisson deviance of each side's goals under the league's level, xG ratings, and xG ratings with the fixture engine. */
function goalsCheck(season, ctxAt, model, weights) {
  const deviance = (y, mu) => 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));
  const sides = [];
  for (const t of DECISIONS) {
    const { s, ctx } = ctxAt(t);
    const rates = teamRates(s.players);
    for (const team of s.teams) if (!rates.has(team.id)) rates.set(team.id, { xgFor90: 0, xgAgainst90: 0, matches: 0 });
    const priors = new Map(s.teams.filter(team => model.teamPriors[team.code]).map(team => [team.id, model.teamPriors[team.code]]));
    const strengths = teamStrengths(rates, priors, model.teams);
    for (const f of season.fixtures.filter(x => x.gw === t)) {
      const fixture = s.fixturesById[f.id];
      const g = fixtureGoals(strengths, f.home, f.away, model.teams);
      const home = scoreFixture(s.teamsById[f.home], fixture, ctx).value;
      const away = scoreFixture(s.teamsById[f.away], fixture, ctx).value;
      sides.push({ y: f.homeGoals, x: g.home, s: home }, { y: f.awayGoals, x: g.away, s: away });
    }
  }
  const at = w => mean(sides.map(z => deviance(z.y, model.goalsPerXg * z.x * Math.exp(w * ((z.s - FIXTURE_SCORE_EVEN) / FIXTURE_SCORE_EVEN)))));
  const league = mean(sides.map(z => deviance(z.y, model.goalsPerXg * model.teams.leagueXg)));
  return { sides: sides.length, league, byWeight: weights.map(w => ({ w, deviance: at(w) })) };
}

// ─── The fit ─────────────────────────────────────────────────────────────────

const started = Date.now();
const [s22, s23, s24, s25] = await Promise.all(['2022-23', '2023-24', '2024-25', '2025-26'].map(n => loadSeason(n)));
log('loaded in', Date.now() - started, 'ms');

// Choices on 2024-25, constants from 2023-24.
const trainConstants = constantsFrom([s23]);
const validate = { previous: s23, promoted: promotedPrior([[s22, s23]]) };
const ctx24 = contexts(s24);
const scoreOn24 = hyper => objective(run(s24, ctx24, () => modelOf(trainConstants, hyper, validate)));
let best = { ...START, rating: 0 };
let bestScore = scoreOn24(best);
log('start', best, bestScore.toFixed(4));
for (let pass = 0; pass < PASSES; pass++) {
  for (const [key, values] of Object.entries(GRID)) {
    for (const value of values) {
      if (value === best[key]) continue;
      const candidate = { ...best, [key]: value };
      const score = scoreOn24(candidate);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    log(`pass ${pass + 1} ${key}:`, best[key], bestScore.toFixed(4), `${Math.round((Date.now() - started) / 1000)}s`);
  }
}

// The fixture engine's weight, as far as it can be replayed offline, without and with hindsight.
const ctx24h = contexts(s24, { hindsight: true });
const ratingChoice = ctxAt => RATING_WEIGHTS.map(w => ({
  w, mse: objective(run(s24, ctxAt, () => modelOf(trainConstants, { ...best, rating: w }, validate))),
}));
const ratingNeutral = ratingChoice(ctx24);
const ratingHindsight = ratingChoice(ctx24h);
const ratingBest = ratingNeutral.reduce((a, b) => (b.mse < a.mse ? b : a));
const ratingPlain = ratingNeutral.find(x => x.w === 0).mse;
const chosenRating = ratingPlain - ratingBest.mse >= RATING_MATERIAL * ratingPlain ? ratingBest.w : 0;
log('fixture-rating weight (neutral):', ratingNeutral.map(x => `${x.w}:${x.mse.toFixed(4)}`).join(' '));
log('fixture-rating weight (hindsight):', ratingHindsight.map(x => `${x.w}:${x.mse.toFixed(4)}`).join(' '));
best = { ...best, rating: chosenRating };

// The test: constants from 2023-24 and 2024-25, 2025-26 unseen.
const testConstants = constantsFrom([s23, s24]);
const test = { previous: s24, promoted: promotedPrior([[s22, s23], [s23, s24]]) };
const ctx25 = contexts(s25);
const ctx25h = contexts(s25, { hindsight: true });
const defcon25 = new Map(DECISIONS.map(t => [t, defconBefore(s25, t)]));
const partsAt = hyper => t => modelOf(testConstants, hyper, { ...test, defcon: defcon25.get(t) });
const runs = {
  v1: run(s25, ctx25, () => null),
  v1Hindsight: run(s25, ctx25h, () => null),
  parts: run(s25, ctx25, partsAt(best)),
};
const results = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, report(r)]));
const versusV1 = paired(runs.v1, runs.parts);
const versusV1Hindsight = paired(runs.v1Hindsight, runs.parts);
const goals25 = goalsCheck(s25, ctx25, modelOf(testConstants, best, test), RATING_WEIGHTS);
const goals25h = goalsCheck(s25, ctx25h, modelOf(testConstants, best, test), RATING_WEIGHTS);
const xp = Object.fromEntries([s23, s24].map(s => [s.name, xpCheck(s)]));

// The shipped model: constants from all three seasons, defensive contributions from 2025-26,
// clubs' priors from 2025-26's ratings for 2026-27.
const shipConstants = constantsFrom([s23, s24, s25]);
const shipped = modelOf(shipConstants, best, {
  previous: s25, promoted: promotedPrior([[s22, s23], [s23, s24], [s24, s25]]), defcon: defconBefore(s25, SEASON_GWS + 1),
});
log('done in', Math.round((Date.now() - started) / 1000), 's');

// ─── The report ──────────────────────────────────────────────────────────────

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const ci = r => `${f(r.mean)} [${f(r.lo)}, ${f(r.hi)}]`;
const line = (label, r) => `| ${label} | ${r.n} | ${f(r.mse)} | ${f(r.mae)} | ${f(r.bias)} | ${f(r.over, 2)} | ${f(r.scored, 2)} |`;
const bestRow = rows => rows.reduce((a, b) => (b.deviance < a.deviance ? b : a));

const md = `# Points model: fit and held-out test

Generated by \`node tools/points/fit.js\` (docs/decision-engine-plan.md,
Phase 6b). Do not edit by hand: change the tool and run it again.

## What is fitted

A player's expected points in a fixture he plays are built from the parts
FPL pays for (js/engine/points.js): playing time; goals and assists as his
shares of his club's expected goals in it; clean sheet, goals conceded and
saves from his club's expected goals against; defensive contributions; bonus;
cards. His shares and rates are his season so far pulled towards a prior for
his position and price. Each club's expected goals for and against come from
its players' season xG and xGC against the league's, pulled towards last
season's rating (js/engine/team-goals.js), with home advantage; optionally
scaled by the fixture engine's 0-100 score for that side.

Every projection here runs the app's own path (normaliseSeason,
buildScoreContext, buildProjections) on the season as it stood before each
planning gameweek: totals, results and prices from before it only, everyone
available (no history of FPL's flags exists). Each of the planning gameweeks
GW${DECISIONS[0]}-${DECISIONS.at(-1)} scores its five-gameweek window, for every player who
appeared in the five gameweeks before it (0 points when he did not play).

Splits: constants fitted on 2023-24; the prior weights, the clubs' prior
weight, how much of last season's ratings carries over and the fixture
engine's weight chosen on 2024-25; constants refitted on both and everything
tested on 2025-26, which no fit saw. 2022-23 serves only as 2023-24's club
priors: vaastav has its xG from GW16 on. Defensive contributions exist from
2025-26: in the test, their prior and spread come from the 2025-26 matches
before each planning gameweek.

The score is mean squared error per player-gameweek: the right score for an
expected value. Mean absolute error rewards guessing low on points this
skewed, so it is shown but not judged on. "Top-10 over" is how far each
gameweek's ten best-projected players per position were projected above what
they then scored over the window; "top-10 scored" is what they scored.

**v1** is the basis the app used before (plan §2.2): his raw points per
appearance times the fixture multiplier. Offline the fixture engine runs
without Understat (its xG-matchup metric needs history this environment cannot
reach) and, without hindsight, with every FDR and club strength neutral;
**with hindsight** it reads vaastav's end-of-season FDR and strengths, which
flatter it.

## Acceptance: 2025-26, held out

| Projection | Player-GWs | MSE | MAE | Bias | Top-10 over | Top-10 scored |
|---|---|---|---|---|---|---|
${line('v1', results.v1)}
${line('v1, with hindsight', results.v1Hindsight)}
${line(`points model${best.rating ? ` (fixture engine weight ${best.rating})` : ''}`, results.parts)}

MSE of v1 less the points model's, per planning gameweek: mean and 95%
circular block-bootstrap interval (blocks of ${BOOTSTRAP.block} gameweeks, ${BOOTSTRAP.draws} draws), and the
number of planning gameweeks it was better in. Above 0 means the points model
is better.

| Planning GWs | v1 less points model | Better in | v1 with hindsight less points model | Better in |
|---|---|---|---|---|
${versusV1.map((r, i) => `| ${r.label} | ${ci(r)} | ${r.better} of ${r.of} | ${ci(versusV1Hindsight[i])} | ${versusV1Hindsight[i].better} of ${versusV1Hindsight[i].of} |`).join('\n')}

With few planning gameweeks in a band (seven early on) the interval rests on
few distinct resamples; the count says the same thing without it.

## FPL's own expected points: not a benchmark here

vaastav's xP column is recorded after each gameweek. A gameweek's figure
tracks that gameweek's points far more closely than the next one's, which a
forecast made before it could not (correlations; the next gameweek's figure,
made after this one, against this one's points for comparison):
${Object.entries(xp).map(([name, c]) => `${name}: ${f(c.same)} against ${f(c.next)} (next gameweek's figure: ${f(c.later)})`).join('; ')}.
So it is not compared with the projections, which see only what came before.

## Team goals, one week ahead (2025-26)

Mean Poisson deviance of each side's goals (${goals25.sides} sides; lower is better):
the league's level for every side ${f(goals25.league)}; the xG ratings ${f(goals25.byWeight.find(x => x.w === 0).deviance)};
with the fixture engine at its best weight ${bestRow(goals25.byWeight).w} ${f(bestRow(goals25.byWeight).deviance)}
(with hindsight: best weight ${bestRow(goals25h.byWeight).w}, ${f(bestRow(goals25h.byWeight).deviance)}).

By weight (neutral): ${goals25.byWeight.map(x => `${x.w}: ${f(x.deviance, 4)}`).join(', ')}.

## Choices (on 2024-25)

Coordinate search, ${PASSES} passes, from ${JSON.stringify(START)}: ${JSON.stringify(best)}.

Fixture-engine weight, MSE on 2024-25 (it is used only if its best weight cuts the MSE at weight 0 by
${RATING_MATERIAL * 100}% or more; best ${ratingBest.w}, ${f(100 * (ratingPlain - ratingBest.mse) / ratingPlain, 3)}% lower, so the weight is ${chosenRating}):
neutral ${ratingNeutral.map(x => `${x.w}: ${f(x.mse, 4)}`).join(', ')};
with hindsight ${ratingHindsight.map(x => `${x.w}: ${f(x.mse, 4)}`).join(', ')}.

## The model to paste into js/config.js

Constants from 2023-24, 2024-25 and 2025-26; defensive contributions from
2025-26; the clubs' priors are 2025-26's ratings, for 2026-27, by FPL club code.

\`\`\`js
  pointsModel: ${literal(roundDeep(shipped), '  ')},
\`\`\`
`;

/** A JS object literal in config.js's style: bare keys, a small object or array on one line. */
function literal(x, indent) {
  const flat = JSON.stringify(x).replace(/"([A-Za-z_][A-Za-z0-9_]*|\d+)":/g, '$1: ').replace(/,(?=\S)/g, ', ')
    .replace(/\{(?=[^}\s])/g, '{ ').replace(/(?<=[^{\s])\}/g, ' }');
  if (flat.length <= LITERAL_WIDTH || !x || typeof x !== 'object' || Array.isArray(x)) return flat;
  const inner = `${indent}  `;
  const key = k => (/^([A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(k) ? k : JSON.stringify(k));
  return `{\n${Object.entries(x).map(([k, v]) => `${inner}${key(k)}: ${literal(v, inner)},`).join('\n')}\n${indent}}`;
}

function roundDeep(x) {
  if (Array.isArray(x)) return x.map(roundDeep);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, roundDeep(v)]));
  return typeof x === 'number' ? round(x) : x;
}

await writeFile(new URL('./REPORT.md', import.meta.url), md);
log(md.slice(md.indexOf('## Acceptance'), md.indexOf('## The model')));
log(JSON.stringify(roundDeep(shipped)));
log('DECISION_ENGINE.pointsModel is', DECISION_ENGINE.pointsModel ? 'set' : 'null');
