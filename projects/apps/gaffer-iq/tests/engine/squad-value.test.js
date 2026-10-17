/**
 * tests/engine/squad-value.test.js
 * The squad value V_t(S) (brief §4, decision engine plan Phase 2) on hand-built
 * projections, so every expected figure can be worked out on paper. The
 * formation and injured-starter cases run autosubRecovery against a fixed XI:
 * re-picking the XI would simply bench the absent starter and never reach the
 * autosub code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { squadValue, autosubRecovery } from '../../js/engine/squad-value.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

const GW = 10;
const GHOST = 99;

/** One gameweek's projection; xpts follows from pZero and xptsIfPlays, as in projections.js. */
function gwProjection(xptsIfPlays, pZero) {
  return {
    gw: GW, fixtures: 1, xpts: (1 - pZero) * xptsIfPlays, xptsIfPlays, pZero,
    pStart: 1 - pZero, p60: 1 - pZero, p60Approx: true, pP90: null,
    estimated: false, availabilitySource: 'status',
  };
}

/** rows: [id, position, xptsIfPlays, pZero = 0] -> { ids, projections } */
function squadOf(rows) {
  const projections = new Map();
  for (const [id, position, xptsIfPlays, pZero = 0] of rows) {
    projections.set(id, { playerId: id, position, teamId: 1, price: 5, gws: [gwProjection(xptsIfPlays, pZero)] });
  }
  return { ids: rows.map(([id]) => id), projections };
}

/**
 * Everyone plays. The XI by xpts is 4-4-2 - GK 1; DEF 3, 4, 5, 6; MID 8, 9,
 * 10, 11; FWD 13, 14 - and the bench, by xptsIfPlays, is MID 12, FWD 15,
 * DEF 7, then GK 2.
 */
const BASE = [
  [1, 'GKP', 4], [2, 'GKP', 2],
  [3, 'DEF', 5], [4, 'DEF', 5], [5, 'DEF', 4], [6, 'DEF', 3], [7, 'DEF', 2],
  [8, 'MID', 8], [9, 'MID', 7], [10, 'MID', 6], [11, 'MID', 5], [12, 'MID', 2.5],
  [13, 'FWD', 9], [14, 'FWD', 6], [15, 'FWD', 2.2],
];

/** BASE with some rows replaced by id. */
function withRows(...rows) {
  const byId = new Map(BASE.map(row => [row[0], row]));
  for (const row of rows) byId.set(row[0], row);
  return [...byId.values()];
}

/** The squad with one player swapped for another (or for the ghost). */
const swap = (ids, outId, inId) => ids.map(id => (id === outId ? inId : id));

/** KeepValue's zero-points placeholder (plan §5.2). */
function addGhost(projections, position) {
  projections.set(GHOST, { playerId: GHOST, position, teamId: 0, price: 0, gws: [gwProjection(0, 1)] });
}

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} vs ${expected}`);

// ─── The XI, bench and components ────────────────────────────────────────────

test('squadValue picks the XI by xpts and orders the bench, reserve keeper last', () => {
  const { ids, projections } = squadOf(BASE);
  const v = squadValue(ids, GW, projections, { autosubMode: 'linear' });
  assert.deepEqual([...v.xi].sort((a, b) => a - b), [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14]);
  assert.deepEqual(v.bench, [12, 15, 7, 2]);
});

test('the bench is ordered by xptsIfPlays, so a doubtful sub who scores big when he plays goes first', () => {
  // MID 12: 6 when he plays, 25% to play - 1.5 xpts, below FWD 15 and DEF 7.
  const { ids, projections } = squadOf(withRows([12, 'MID', 6, 0.75]));
  assert.deepEqual(squadValue(ids, GW, projections).bench, [12, 15, 7, 2]);
});

test('squadValue is the sum of its components', () => {
  const { ids, projections } = squadOf(BASE);
  for (const chip of [null, 'benchboost', 'triplecaptain']) {
    const { value, components: c } = squadValue(ids, GW, projections, { chip });
    close(value, c.xi + c.captain + c.autosub + c.benchBoost);
  }
});

// ─── Bench weight: the brief's 3rd-sub defender ──────────────────────────────

test('a 3rd-sub defender is worth ~3% of his xpts in a normal week (linear mode)', () => {
  const { ids, projections } = squadOf(BASE);
  addGhost(projections, 'DEF');
  const keep = squadValue(ids, GW, projections, { autosubMode: 'linear' }).value
             - squadValue(swap(ids, 7, GHOST), GW, projections, { autosubMode: 'linear' }).value;
  close(keep / 2, 0.03);
});

test('a 3rd-sub defender is worth all of his xpts in a Bench Boost week', () => {
  const { ids, projections } = squadOf(BASE);
  addGhost(projections, 'DEF');
  for (const autosubMode of ['linear', 'probability']) {
    const opts = { chip: 'benchboost', autosubMode };
    const keep = squadValue(ids, GW, projections, opts).value
               - squadValue(swap(ids, 7, GHOST), GW, projections, opts).value;
    close(keep / 2, 1, `${autosubMode}: ${keep / 2}`);
  }
});

test('Bench Boost counts only the increment over the autosub value already credited', () => {
  // MID 8 (4 xpts, still in the XI) misses half his games, so autosubs are worth something.
  const { ids, projections } = squadOf(withRows([8, 'MID', 8, 0.5]));
  const normal = squadValue(ids, GW, projections);
  const boosted = squadValue(ids, GW, projections, { chip: 'benchboost' });
  const benchXpts = boosted.bench.reduce((sum, id) => sum + projections.get(id).gws[0].xpts, 0);
  assert.ok(normal.components.autosub > 0);
  close(boosted.components.benchBoost, benchXpts - normal.components.autosub);
  close(boosted.value - normal.value, benchXpts - normal.components.autosub);
});

// ─── Autosubs against a fixed XI ─────────────────────────────────────────────

const XI_442 = [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14];
const BENCH  = [12, 15, 7, 2];

test('an injured starter is replaced by the first bench player who plays', () => {
  const { projections } = squadOf(withRows([9, 'MID', 7, 1]));
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'probability'), 2.5);
});

test('a bench player who does not play is skipped for the next one', () => {
  const { projections } = squadOf(withRows([9, 'MID', 7, 1], [12, 'MID', 2.5, 1]));
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'probability'), 2.2);
});

test('with exactly 3 defenders in the XI and one out, only a defender can come in', () => {
  // 3-4-3: a midfielder on for the absent defender would leave two.
  const xi = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15];
  const { projections } = squadOf(withRows([5, 'DEF', 4, 1]));
  close(autosubRecovery(xi, [12, 6, 7, 2], GW, projections, 'probability'), 3);
});

test('two certain absences and one playing sub recover exactly that sub\'s points', () => {
  const { projections } = squadOf(withRows([3, 'DEF', 5, 1], [8, 'MID', 8, 1],
    [15, 'FWD', 2.2, 1], [7, 'DEF', 2, 1]));
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'probability'), 2.5);
});

test('with more absences than subs, subs come on only while the formation allows', () => {
  // All four 4-4-2 defenders out. MID 12 replaces the first (three defenders
  // left), DEF 7 the second; FWD 15 would leave two, so the rest go uncovered.
  const { projections } = squadOf(withRows([3, 'DEF', 5, 1], [4, 'DEF', 5, 1],
    [5, 'DEF', 4, 1], [6, 'DEF', 3, 1]));
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'probability'), 2.5 + 2);
});

test('probability mode credits each bench player by the chance he comes on (hand-computed)', () => {
  // DEF 6 misses half the time. The first sub, MID 12 (plays 80%), comes on
  // for him - 4-4-2 keeps three defenders - else FWD 15, next in bench order:
  // 0.5 x (0.8 x 2.5 + 0.2 x 2.2) = 1.22.
  const { projections } = squadOf(withRows([6, 'DEF', 3, 0.5], [12, 'MID', 2.5, 0.2]));
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'probability'), 1.22);
});

test('the reserve keeper covers only the starting keeper', () => {
  // Keeper 1 misses 30% of the time; keeper 2 then scores his 2. An absent
  // outfielder is never covered by keeper 2.
  const { projections } = squadOf(withRows([1, 'GKP', 4, 0.3], [3, 'DEF', 5, 1],
    [12, 'MID', 2.5, 1], [15, 'FWD', 2.2, 1], [7, 'DEF', 2, 1]));
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'probability'), 0.3 * 2);
});

test('linear mode weights the bench slots 0.30 / 0.10 / 0.03 and the reserve keeper 0.03', () => {
  const { projections } = squadOf(BASE);
  close(autosubRecovery(XI_442, BENCH, GW, projections, 'linear'),
    (0.30 * 2.5) + (0.10 * 2.2) + (0.03 * 2) + (0.03 * 2));
});

// ─── Captain ─────────────────────────────────────────────────────────────────

test('selling the only strong captain option costs more than his raw xpts difference', () => {
  // FWD 13 projects 12, no one else above 8. Selling him for a 6-point
  // forward costs 6 in the XI and the captaincy drop on top.
  const { ids, projections } = squadOf(withRows([13, 'FWD', 12]));
  projections.set(16, { playerId: 16, position: 'FWD', teamId: 2, price: 5, gws: [gwProjection(6, 0)] });
  const loss = squadValue(ids, GW, projections).value
             - squadValue(swap(ids, 13, 16), GW, projections).value;
  assert.ok(loss > 12 - 6, `V fell by ${loss}`);
});

test('the captain maximises his xpts plus his absence times the vice\'s xpts', () => {
  // MID 9 projects 7.9 but misses half his games (15.8 when he plays); FWD 13
  // projects 8 and always plays. Captaining 9 with 13 as vice is worth
  // 7.9 + 0.5 x 8 = 11.9; captaining 13 is worth 8 + 0 = 8.
  const { ids, projections } = squadOf(withRows([9, 'MID', 15.8, 0.5], [13, 'FWD', 8], [8, 'MID', 6]));
  const v = squadValue(ids, GW, projections);
  assert.equal(v.captainId, 9);
  assert.equal(v.viceId, 13);
  close(v.components.captain, 11.9);
});

test('Triple Captain doubles the captain\'s bonus', () => {
  const { ids, projections } = squadOf(withRows([9, 'MID', 15.8, 0.5]));
  const normal = squadValue(ids, GW, projections);
  const tc = squadValue(ids, GW, projections, { chip: 'triplecaptain' });
  close(tc.components.captain, 2 * normal.components.captain);
  close(tc.value - normal.value, normal.components.captain);
});

// ─── Exactness against brute force ───────────────────────────────────────────

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FPL's autosubs replayed for every individual pattern of who plays - 2^10
 * outfield starters x 2^3 subs - with no shortcut, as the reference.
 */
function bruteForceRecovery(xi, bench, projections) {
  const at = id => ({ ...projections.get(id).gws[0], position: projections.get(id).position });
  const order = { DEF: 0, MID: 1, FWD: 2 };
  const starters = xi.map(at).filter(g => g.position !== 'GKP').sort((a, b) => order[a.position] - order[b.position]);
  const subs = bench.map(at).filter(g => g.position !== 'GKP');
  const minimum = { DEF: 3, MID: 2, FWD: 1 };
  let expected = 0;
  for (let absent = 0; absent < (1 << starters.length); absent++) {
    for (let plays = 0; plays < (1 << subs.length); plays++) {
      let p = 1;
      starters.forEach((g, i) => { p *= (absent >> i) & 1 ? g.pZero : 1 - g.pZero; });
      subs.forEach((g, j) => { p *= (plays >> j) & 1 ? 1 - g.pZero : g.pZero; });
      if (p === 0) continue;
      const count = { DEF: 0, MID: 0, FWD: 0 };
      for (const g of starters) count[g.position]++;
      const used = new Set();
      let gained = 0;
      starters.forEach((g, i) => {
        if (!((absent >> i) & 1)) return;
        const j = subs.findIndex((s, k) => !used.has(k) && ((plays >> k) & 1)
          && (s.position === g.position || count[g.position] - 1 >= minimum[g.position]));
        if (j < 0) return;
        used.add(j);
        count[g.position]--;
        count[subs[j].position]++;
        gained += subs[j].xptsIfPlays;
      });
      expected += p * gained;
    }
  }
  const keeper = at(xi.find(id => projections.get(id).position === 'GKP'));
  const reserve = at(bench.find(id => projections.get(id).position === 'GKP'));
  return expected + keeper.pZero * reserve.xpts;
}

test('probability-mode recovery equals brute force over every absence pattern', () => {
  const random = seeded(17);
  const formations = [[3, 4, 3], [3, 5, 2], [4, 4, 2], [4, 3, 3], [4, 5, 1], [5, 3, 2], [5, 4, 1], [5, 2, 3]];
  for (let run = 0; run < 60; run++) {
    const [d, m, f] = formations[run % formations.length];
    // 15 = 2 GKP, 5 DEF, 5 MID, 3 FWD: the XI takes the first d / m / f of each.
    const rows = [[1, 'GKP'], [2, 'GKP'],
      ...[3, 4, 5, 6, 7].map(id => [id, 'DEF']),
      ...[8, 9, 10, 11, 12].map(id => [id, 'MID']),
      ...[13, 14, 15].map(id => [id, 'FWD'])]
      .map(([id, position]) => {
        // A mix of certain, likely, doubtful and absent - and exact zeros.
        const pZero = [0, 0, 0.05, 0.2, 0.5, 0.9, 1][Math.floor(random() * 7)];
        return [id, position, 1 + Math.round(random() * 16) / 2, pZero];
      });
    const { projections } = squadOf(rows);
    const xi = [1, ...[3, 4, 5, 6, 7].slice(0, d), ...[8, 9, 10, 11, 12].slice(0, m), ...[13, 14, 15].slice(0, f)];
    const outfieldBench = rows.map(([id]) => id).filter(id => id !== 2 && !xi.includes(id));
    // Shuffle the bench so priority order is exercised too.
    outfieldBench.sort(() => random() - 0.5);
    const bench = [...outfieldBench, 2];
    close(autosubRecovery(xi, bench, GW, projections, 'probability'),
      bruteForceRecovery(xi, bench, projections), `run ${run} (${d}-${m}-${f})`);
  }
});
