/**
 * tools/minutes/fit.js
 * Fits the minutes model's three heads (appear, start, 60 minutes) on
 * vaastav's history, recalibrates them for each gameweek of the projection
 * horizon, tests them on the held-out season against the last-5-starts
 * baseline (the brief's acceptance) and the v1 rates they replace, and writes
 * REPORT.md beside this file, ending with the block to paste into
 * DECISION_ENGINE.minutesModel.
 *
 *   node tools/minutes/download.js && node tools/minutes/fit.js
 */

import { readFile, writeFile } from 'node:fs/promises';

import { DECISION_ENGINE } from '../../js/config.js';
import { mean } from '../../js/util.js';
import { selectionChances } from '../../js/engine/minutes.js';
import { SPLITS, brier, buildRows, fitLogistic, logLoss, parseCsv, seasonData } from './lib.js';

// The shipped model reads every feature minutesFeatures computes. The rows
// also carry two club measures, tried against them on the validation season
// (the ablation in REPORT.md): neither earned its place in the app.
const FEATURES = ['startShort', 'startLong', 'startSeason', 'appearMid', 'minutesMid', 'startedLast',
  'played60Last', 'zeroRun', 'fullRun', 'history', 'def', 'mid', 'fwd', 'price'];
const CLUB_MEASURES = ['rest', 'rotation'];
const ABLATIONS = [
  ['own record only (shipped)', FEATURES],
  ['+ rest', [...FEATURES, 'rest']],
  ['+ rotation', [...FEATURES, 'rotation']],
  ['+ rest and rotation', [...FEATURES, ...CLUB_MEASURES]],
];

const HEADS = ['appear', 'start', 'p60'];
// Ridge penalties tried, on standardised features; the validation season picks one per head.
const LAMBDAS = [0, 1, 10, 100, 1000, 10000];
// Gameweeks after the planning gameweek, over the projection horizon.
const LEADS = Array.from({ length: DECISION_ENGINE.horizonGws }, (_, k) => k);
// Significant digits shipped per coefficient.
const DIGITS = 4;
const BUCKETS = 10;

// OpenFPL's return categories (github.com/daniegr/OpenFPL): Zeros did not
// play, Blanks scored at most 2, Tickers 3 or 4, Haulers 5 or more.
const CATEGORIES = [
  ['Zeros', r => r.appear === 0],
  ['Blanks', r => r.appear === 1 && r.points <= 2],
  ['Tickers', r => r.appear === 1 && r.points >= 3 && r.points <= 4],
  ['Haulers', r => r.appear === 1 && r.points >= 5],
];

// ─── Data ────────────────────────────────────────────────────────────────────

const seasons = new Map();
for (const name of Object.values(SPLITS).flat()) {
  const text = await readFile(new URL(`./data/${name}/merged_gw.csv`, import.meta.url), 'utf8');
  seasons.set(name, seasonData(parseCsv(text)));
}
const rowsOf = (names, lead = 0) => names.flatMap(name => buildRows(seasons.get(name), { lead }));
const fitSeasons = [...SPLITS.train, ...SPLITS.validate];
const train = rowsOf(SPLITS.train);
const validate = rowsOf(SPLITS.validate);

// ─── Fitting ─────────────────────────────────────────────────────────────────

const logistic = z => 1 / (1 + Math.exp(-z));

/** A head's logit for a row; impute fills a club measure that is null (rotation before a club has changed its XI). */
function linear(coefficients, row, impute = {}) {
  let z = 0;
  for (const [f, w] of Object.entries(coefficients)) z += f === 'intercept' ? w : w * (row.features[f] ?? impute[f]);
  return z;
}

/** One head, fitted on standardised features and returned on the raw scale: { intercept, feature: weight }. */
function fitHead(rows, head, features, lambda, impute = {}) {
  const raw = rows.map(r => features.map(f => r.features[f] ?? impute[f]));
  const centre = features.map((_, j) => mean(raw.map(x => x[j])));
  const spread = features.map((_, j) => Math.sqrt(mean(raw.map(x => (x[j] - centre[j]) ** 2))) || 1);
  const X = raw.map(x => x.map((v, j) => (v - centre[j]) / spread[j]));
  const [b, ...w] = fitLogistic(X, rows.map(r => r[head]), { lambda });
  const weights = Object.fromEntries(features.map((f, j) => [f, w[j] / spread[j]]));
  return { intercept: b - features.reduce((sum, f, j) => sum + (weights[f] * centre[j]), 0), ...weights };
}

function validationScores(coefficients, head, impute) {
  const p = validate.map(r => logistic(linear(coefficients, r, impute)));
  const y = validate.map(r => r[head]);
  return { logLoss: logLoss(p, y), brier: brier(p, y) };
}

const impute = { rotation: mean(train.map(r => r.features.rotation).filter(v => v !== null)) };
const lambdaTables = {};
const lambdaOf = {};
for (const head of HEADS) {
  lambdaTables[head] = LAMBDAS.map(lambda =>
    ({ lambda, ...validationScores(fitHead(train, head, FEATURES, lambda), head, impute) }));
  lambdaOf[head] = lambdaTables[head].reduce((best, t) => (t.logLoss < best.logLoss ? t : best)).lambda;
}
const ablation = ABLATIONS.map(([label, features]) => [label, Object.fromEntries(HEADS.map(head =>
  [head, validationScores(fitHead(train, head, features, lambdaOf[head], impute), head, impute)]))]);

// The shipped heads: both fitting seasons together, rounded as shipped. Then,
// for each gameweek ahead, each head's logit z is recalibrated to a + b z by a
// one-feature logistic fit on rows read that far ahead, in the same seasons.
const round = values => values.map(v => Number(v.toPrecision(DIGITS)));
const fitRows = [...train, ...validate];
const heads = Object.fromEntries(HEADS.map(head => {
  const coefficients = fitHead(fitRows, head, FEATURES, lambdaOf[head]);
  const values = round(Object.values(coefficients));
  return [head, Object.fromEntries(Object.keys(coefficients).map((f, i) => [f, values[i]]))];
}));
const aheadRows = LEADS.slice(1).map(lead => rowsOf(fitSeasons, lead));
const model = {
  ...heads,
  ahead: Object.fromEntries(HEADS.map(head => [head, aheadRows.map(rows =>
    round(fitLogistic(rows.map(r => [linear(heads[head], r)]), rows.map(r => r[head]))))])),
};

// ─── The held-out season ─────────────────────────────────────────────────────

const ahead = LEADS.map(lead => rowsOf(SPLITS.test, lead).map(r => ({
  ...r,
  model: selectionChances(r.features, model, lead),
  unadjusted: selectionChances(r.features, heads, lead),
})));
const test = ahead[0];

// Each head's chance from each source; v1 only where it had rates of its own.
const SOURCES = {
  model:      (r, head) => r.model[head],
  unadjusted: (r, head) => r.unadjusted[head],
  baseline:   (r, head) => (head === 'appear' ? r.baseline.appear : r.baseline.start),
  v1:         (r, head) => r.v1?.[head],
};
function score(rows, head, source) {
  const p = rows.map(r => SOURCES[source](r, head));
  const y = rows.map(r => r[head]);
  return { n: rows.length, brier: brier(p, y), logLoss: logLoss(p, y), mean: mean(p), actual: mean(y) };
}

// ─── Report ──────────────────────────────────────────────────────────────────

const f4 = x => x.toFixed(4);
const pct = x => `${(x * 100).toFixed(1)}%`;
const count = rows => rows.length.toLocaleString('en-GB');
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map(r => `| ${r.join(' | ')} |`),
].join('\n');

const active = test.filter(r => r.baseline.appear > 0);
const covered = test.filter(r => r.v1);
const accept = score(test, 'p60', 'model').brier < score(test, 'p60', 'baseline').brier;
const last = LEADS.at(-1);

const acceptance = table(['Rows', 'n', 'Model Brier', 'Last-5-starts Brier', 'Model log loss', 'Last-5-starts log loss'],
  [['every row', test], ['played in one of his last five', active]].map(([label, rows]) => {
    const m = score(rows, 'p60', 'model');
    const b = score(rows, 'p60', 'baseline');
    return [label, m.n, f4(m.brier), f4(b.brier), f4(m.logLoss), f4(b.logLoss)];
  }));

const everyHead = table(['Head', 'Model Brier', 'Last-5 Brier', 'v1 Brier', 'Model log loss', 'Last-5 log loss', 'v1 log loss'],
  HEADS.map(head => {
    const [m, b, v] = ['model', 'baseline', 'v1'].map(source => score(covered, head, source));
    return [head, f4(m.brier), f4(b.brier), f4(v.brier), f4(m.logLoss), f4(b.logLoss), f4(v.logLoss)];
  }));

function calibration(rows, source) {
  return table(['Predicted', 'n', 'Mean predicted', 'Played 60+'],
    Array.from({ length: BUCKETS }, (_, i) => {
      const label = `${i * BUCKETS}-${(i + 1) * BUCKETS}%`;
      const inBucket = rows.filter(r => Math.min(BUCKETS - 1, Math.floor(SOURCES[source](r, 'p60') * BUCKETS)) === i);
      if (inBucket.length === 0) return [label, 0, '', ''];
      const s = score(inBucket, 'p60', source);
      return [label, s.n, pct(s.mean), pct(s.actual)];
    }));
}

const categories = table(['Category', 'n', 'Played 60+', 'Model mean', 'Last-5 mean', 'Model Brier', 'Last-5 Brier'],
  CATEGORIES.map(([label, inCategory]) => {
    const rows = test.filter(inCategory);
    const m = score(rows, 'p60', 'model');
    const b = score(rows, 'p60', 'baseline');
    return [label, m.n, pct(m.actual), pct(m.mean), pct(b.mean), f4(m.brier), f4(b.brier)];
  }));

// Ever-present starters: started every gameweek of a record of half the long
// window or more, at over 85 minutes a game across the last five - the
// players a squad is built on, by position.
const POSITIONS = [
  ['GKP', r => !r.features.def && !r.features.mid && !r.features.fwd],
  ['DEF', r => r.features.def === 1], ['MID', r => r.features.mid === 1], ['FWD', r => r.features.fwd === 1],
];
const everPresent = test.filter(r => r.features.startSeason === 1 && r.features.history >= 0.5
  && r.features.minutesMid > 0.95);
const nailed = table(['Position', 'n', 'Model appear', 'Appeared', 'Model P(60+)', 'Played 60+'],
  POSITIONS.map(([label, inPosition]) => {
    const rows = everPresent.filter(inPosition);
    const a = score(rows, 'appear', 'model');
    const p = score(rows, 'p60', 'model');
    return [label, a.n, pct(a.mean), pct(a.actual), pct(p.mean), pct(p.actual)];
  }));
const keepers = score(everPresent.filter(POSITIONS[0][1]), 'appear', 'model');

const leads = table(['Gameweeks ahead', 'n', 'Played 60+', 'Model mean', 'Model Brier', 'Not recalibrated', 'Last-5 Brier'],
  ahead.map((rows, k) => {
    const m = score(rows, 'p60', 'model');
    return [k, m.n, pct(m.actual), pct(m.mean), f4(m.brier),
      f4(score(rows, 'p60', 'unadjusted').brier), f4(score(rows, 'p60', 'baseline').brier)];
  }));

const lambdas = table(['Lambda', ...HEADS.map(h => `${h} log loss`)],
  LAMBDAS.map((lambda, i) => [lambda, ...HEADS.map(h => f4(lambdaTables[h][i].logLoss))]));

const ablations = table(['Features', ...HEADS.map(h => `${h} log loss`), ...HEADS.map(h => `${h} Brier`)],
  ablation.map(([label, byHead]) =>
    [label, ...HEADS.map(h => f4(byHead[h].logLoss)), ...HEADS.map(h => f4(byHead[h].brier))]));

// How much the club measures add at best, on any head and either score.
const shipped = ablation[0][1];
const clubGain = Math.max(...ablation.slice(1).flatMap(([, byHead]) =>
  HEADS.flatMap(h => [shipped[h].logLoss - byHead[h].logLoss, shipped[h].brier - byHead[h].brier])));

const coefficients = table(['Feature', ...HEADS], ['intercept', ...FEATURES].map(f => [f, ...HEADS.map(h => model[h][f])]));
const recalibration = table(['Gameweeks ahead', ...HEADS.map(h => `${h} [a, b]`)],
  LEADS.slice(1).map((k, i) => [k, ...HEADS.map(h => `[${model.ahead[h][i].join(', ')}]`)]));

const literal = object => `{ ${Object.entries(object).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
const pairs = list => `[${list.map(pair => `[${pair.join(', ')}]`).join(', ')}]`;
const snippet = [
  '  minutesModel: {',
  ...HEADS.map(head => `    ${head}: ${literal(model[head])},`),
  '    ahead: {',
  ...HEADS.map(head => `      ${head}: ${pairs(model.ahead[head])},`),
  '    },',
  '  },',
].join('\n');

const { windows, minHistoryGws } = DECISION_ENGINE.minutesFeatures;
const report = `# Minutes model: fit and held-out test

Generated by \`node tools/minutes/fit.js\` (docs/decision-engine-plan.md,
Phase 4). Do not edit by hand: change the tool and run it again.

## What is fitted

Three logistic heads give a player's chances, in one fixture he is available
for, of appearing, starting and playing 60 minutes or more. Their features
(js/engine/minutes.js) come from his record before the planning gameweek: his
start share over the last ${windows.short} and ${windows.long} gameweeks and the season, his
appearances and minutes over the last ${windows.mid}, whether he started and played 60
minutes last time, a zero-minute run still going, how much record there is,
his position and his price. For each later gameweek of the horizon a head's
logit z is read as a + b z: the record says less about later gameweeks, so
the chances drift towards the average. The app multiplies them by FPL's
availability (the flag and its recovery), which no history of flags exists to
fit.

A row is a player in a single-fixture gameweek with at least ${minHistoryGws}
gameweek of record before the planning gameweek, read with nothing from that
gameweek on but the outcome and the published kickoff
(tests/tools/minutes.test.js). Data: vaastav's merged_gw.csv. Heads fitted on
${SPLITS.train.join(', ')} (${count(train)} rows), penalty chosen on ${SPLITS.validate.join(', ')} (${count(validate)} rows),
then heads and recalibration fitted on both and tested on ${SPLITS.test.join(', ')}
(${count(test)} rows next gameweek), which no fit saw.

Baselines: **last-5-starts** is his start share over his club's last five
gameweeks, the brief's baseline for P(60+). **v1** is the rate the app used
before this model (plan §2.2): start rate x completion over his contention
gameweeks, scored only where v1 had three or more (below that it used a price
prior). Log loss clips probabilities to [0.001, 0.999].

## Acceptance: P(60+), next gameweek, ${SPLITS.test.join(', ')}

${acceptance}

**${accept ? 'Passes' : 'Fails'}**: the model's Brier score is ${accept ? 'below' : 'not below'} last-5-starts on the held-out season.

## Every head, next gameweek, on the rows v1 covers (${count(covered)})

${everyHead}

## Calibration of P(60+)

Model, next gameweek:

${calibration(test, 'model')}

Last-5-starts, next gameweek:

${calibration(test, 'baseline')}

Model, ${last} gameweeks ahead:

${calibration(ahead[last], 'model')}

Not recalibrated, ${last} gameweeks ahead:

${calibration(ahead[last], 'unadjusted')}

## By return category, next gameweek

${categories}

## Ever-present starters, next gameweek

Players who started every gameweek of a record of five or more, at over 85
minutes a game across the last five:

${nailed}

Keepers are stickier than the model allows: it gives an ever-present keeper a
${pct(1 - keepers.mean)} chance of no minutes where ${pct(1 - keepers.actual)} got none.

## Gameweeks ahead

The app reads each gameweek of the horizon from the record before the
planning gameweek; so do these rows.

${leads}

## Choices made on ${SPLITS.validate.join(', ')}

Ridge penalty (standardised features), validation log loss:

${lambdas}

Chosen: ${HEADS.map(h => `${h} ${lambdaOf[h]}`).join(', ')}.

Club measures - rest days before the match and the share of his club's XI
changed per gameweek over its last five - against his own record alone, at
those penalties:

${ablations}

Adding them improves no head's log loss or Brier by more than ${f4(clubGain)}, so the
app does not compute them.

## Coefficients

${coefficients}

Recalibration by gameweeks ahead:

${recalibration}

Paste into \`DECISION_ENGINE\` in js/config.js:

\`\`\`js
${snippet}
\`\`\`
`;

await writeFile(new URL('./REPORT.md', import.meta.url), report);
console.log(report);
