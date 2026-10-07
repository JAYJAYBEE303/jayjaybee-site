// Self-check for the pure logic: `npm test` (node strips the types; no test framework).
import assert from 'node:assert/strict';
import {
  indexAt, lastAt, byDriver, sampleAt, lapOutline, formatGap, formatClock,
  timed, trackStatusTimeline, periods, cumulative, pointAhead, drsRuns, tyreAge,
  lapsDone, sectorBests, stintBars, formatLap, bestLap, lapTrace, liveStandings, rotator,
  theilSen, tyreWear, FUEL_S_PER_LAP,
} from './src/replay.ts';
import {
  buildRace, windowQuery, chunkIndex, order, boardRows, lapLabel, weatherText, rcItems,
  standingsRows, standingsNote, seriesFor, lapsYDomain,
} from './src/race.ts';
import { raceSession, lap, raceData, at, ms } from './test/race-fixture.ts';

const rows = [{ t: 0 }, { t: 10 }, { t: 20 }];
assert.equal(indexAt(rows, -1), -1);
assert.equal(indexAt(rows, 10), 1);
assert.equal(indexAt(rows, 15), 1);
assert.equal(lastAt(rows, 99).t, 20);
assert.equal(lastAt(undefined, 5), undefined);

const iso = (s) => new Date(Date.UTC(2024, 0, 1, 0, 0, s)).toISOString();
const loc = byDriver([
  { driver_number: 1, date: iso(2), x: 20, y: 0 },
  { driver_number: 1, date: iso(0), x: 0, y: 0 },
  { driver_number: 1, date: 'bad', x: 9, y: 9 },
], 'date', (r) => ({ x: r.x, y: r.y }));
const s1 = loc.get(1);
assert.equal(s1.length, 2, 'bad dates dropped');
assert.ok(s1[0].t < s1[1].t, 'sorted by time');
assert.deepEqual(sampleAt(s1, s1[0].t + 1000), { x: 10, y: 0 }, 'midpoint interpolates');
assert.equal(sampleAt(s1, s1[1].t + 1), null, 'past last sample = no car');

// Outline skips lap 1 and pit laps, takes lap 3 -> lap 4.
const samples = Array.from({ length: 41 }, (_, i) => ({ t: i * 1000, x: i, y: 0 }));
const laps = new Map([[1, [
  { lap_number: 1, t: 0 },
  { lap_number: 2, t: 10e3, is_pit_out_lap: false },
  { lap_number: 3, t: 20e3, is_pit_out_lap: true },
  { lap_number: 4, t: 30e3, is_pit_out_lap: false },
]]]);
const out = lapOutline(new Map([[1, samples]]), laps);
// Lap 2 ends into a pit-out lap 3, so it's skipped; lap 3 itself is a pit-out lap: no clean lap -> fallback.
assert.equal(out.length, 41, 'falls back to longest trace');
laps.get(1)[2].is_pit_out_lap = false;
assert.deepEqual([lapOutline(new Map([[1, samples]]), laps).at(0).t, lapOutline(new Map([[1, samples]]), laps).at(-1).t], [10e3, 20e3]);

// Track status: SC deployed at 10 s, "in this lap" at 50 s, leader starts next lap at 80 s.
const sc = trackStatusTimeline([
  { t: 10, category: 'SafetyCar', message: 'SAFETY CAR DEPLOYED' },
  { t: 50, category: 'SafetyCar', message: 'SAFETY CAR IN THIS LAP' },
  { t: 60, category: 'Flag', flag: 'YELLOW', scope: 'Sector', message: 'YELLOW IN TRACK SECTOR 4' },
], [5, 40, 80, 120]);
assert.deepEqual(sc, [{ t: 10, status: 'sc' }, { t: 80, status: 'green' }]);
assert.deepEqual(periods(sc, 'sc', 999), [{ start: 10, end: 80 }]);
const vsc = trackStatusTimeline([
  { t: 5, category: 'SafetyCar', message: 'VIRTUAL SAFETY CAR DEPLOYED' },
  { t: 9, category: 'SafetyCar', message: 'VIRTUAL SAFETY CAR ENDING' },
  { t: 20, category: 'Flag', flag: 'RED', scope: 'Track', message: 'RED FLAG' },
], []);
assert.deepEqual(periods(vsc, 'vsc', 99), [{ start: 5, end: 9 }]);
assert.deepEqual(periods(vsc, 'red', 99), [{ start: 20, end: 99 }], 'open period runs to end');

// pointAhead: square lap of side 10 (total 40); 25 % ahead of (0,0) is (10,0).
const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
const cum = cumulative(square);
assert.deepEqual(cum, [0, 10, 20, 30, 40]);
assert.deepEqual(pointAhead(square, cum, { x: 1, y: -1 }, 0.25), { x: 10, y: 0 });
assert.deepEqual(pointAhead(square, cum, { x: 0, y: 9 }, 0.5), { x: 10, y: 0 }, 'wraps past lap end');

// DRS runs: open (>= 10) from t=2..3 only.
const pts = [0, 1, 2, 3, 4].map((t) => ({ t, x: t, y: 0 }));
const car = [{ t: 0, drs: 8 }, { t: 1.5, drs: 12 }, { t: 3.5, drs: 0 }];
assert.deepEqual(drsRuns(pts, car).map((r) => r.map((p) => p.t)), [[2, 3]]);
assert.deepEqual(drsRuns(pts, []), []);

assert.equal(tyreAge({ lap_start: 10, tyre_age_at_start: 3 }, 15), 8);
assert.equal(tyreAge({ lap_start: 1 }, 1), 0);
assert.deepEqual(timed([{ date: 'x' }, { date: iso(5) }, { date: iso(1) }]).map((r) => r.t), [Date.parse(iso(1)), Date.parse(iso(5))]);

// lapsDone: lap 2 (starts 90 s, 90 s long) only counts from 180 s.
const dl = [
  { lap_number: 1, t: 0, lap_duration: 90, duration_sector_1: 30, duration_sector_2: 31, duration_sector_3: 29 },
  { lap_number: 2, t: 90e3, lap_duration: 90, duration_sector_1: 28, duration_sector_2: null, duration_sector_3: 30 },
  { lap_number: 3, t: 180e3, lap_duration: null },
];
assert.deepEqual(lapsDone(dl, 179e3).map((l) => l.lap_number), [1]);
assert.deepEqual(lapsDone(dl, 999e3).map((l) => l.lap_number), [1, 2], 'no duration = not finished');
assert.deepEqual(lapsDone(undefined, 5), []);

const sb = sectorBests(new Map([[1, dl], [2, [{ t: 0, lap_duration: 95, duration_sector_1: 29, duration_sector_2: 33, duration_sector_3: 33 }]]]), 999e3);
assert.deepEqual(sb.personal.get(1), [28, 31, 29], 'null sector ignored');
assert.deepEqual(sb.overall, [28, 31, 29]);
assert.deepEqual(sectorBests(new Map([[1, dl]]), 0).overall, [Infinity, Infinity, Infinity]);

const st = [{ lap_start: 1, lap_end: 20, compound: 'MEDIUM' }, { lap_start: 21, lap_end: null, compound: 'HARD' }];
assert.deepEqual(stintBars(st, 10), [{ compound: 'MEDIUM', from: 1, to: 10 }], 'future stint hidden, current clipped');
assert.deepEqual(stintBars(st, 30), [{ compound: 'MEDIUM', from: 1, to: 20 }, { compound: 'HARD', from: 21, to: 30 }]);

// bestLap: fastest finished lap, optionally within a start window.
const ql = [
  { lap_number: 1, t: 0, lap_duration: 95 },
  { lap_number: 2, t: 100e3, lap_duration: 88 },
  { lap_number: 3, t: 500e3, lap_duration: 90 },
];
assert.equal(bestLap(ql, 999e3).lap_number, 2);
assert.equal(bestLap(ql, 150e3).lap_number, 1, 'lap 2 not finished yet');
assert.equal(bestLap(ql, 999e3, 400e3).lap_number, 3, 'window excludes earlier laps');
assert.equal(bestLap(ql, 999e3, 0, 50e3).lap_number, 1);
assert.equal(bestLap([], 999e3), undefined);

// lapTrace: straight 20-unit lap over 2 s.
const lt = lapTrace(
  [{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }, { t: 2, x: 20, y: 0 }],
  [{ t: -1, speed: 1, n_gear: 1 }, { t: 0.5, speed: 2, throttle: 50, brake: 0, n_gear: 3 }, { t: 2, speed: 3, n_gear: 8 }],
);
assert.deepEqual(lt.map((p) => p.x), [0, 25, 100]);
assert.deepEqual(lt[1], { x: 25, speed: 2, throttle: 50, brake: 0, gear: 3 });
assert.deepEqual(lapTrace([{ t: 0, x: 0, y: 0 }], [{ t: 0 }]), [], 'needs two points');

// liveStandings: B overtakes A on gained points; ties broken by starting points.
const ls = liveStandings(
  [{ key: 1, label: 'A', start: 100 }, { key: 2, label: 'B', start: 90 }, { key: 3, label: 'C', start: 90 }],
  new Map([[2, 25], [3, 0]]),
);
assert.deepEqual(ls.map((r) => r.label), ['B', 'A', 'C']);
assert.deepEqual(ls[0], { label: 'B', start: 90, gain: 25, total: 115 });
assert.equal(ls[1].gain, 0, 'missing key gains nothing');
assert.deepEqual(liveStandings([{ key: 1, label: 'X', start: 5 }, { key: 2, label: 'Y', start: 9 }], new Map([[1, 4]])).map((r) => r.label), ['Y', 'X'], 'tie on total -> higher start first');

// rotator: 90 deg turns +x into +y; 0 deg is identity.
const r90 = rotator(90)({ x: 1, y: 0 });
assert.deepEqual([Math.round(r90.x * 1e9) / 1e9, Math.round(r90.y * 1e9) / 1e9], [0, 1]);
assert.deepEqual(rotator(0)({ x: 3, y: -2 }), { x: 3, y: -2 });

// theilSen: y = 2x + 1 with one wild point still gives slope 2.
assert.equal(theilSen([1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 1 })).concat({ x: 5, y: 100 })), 2);
assert.equal(theilSen([{ x: 1, y: 1 }]), null);
assert.equal(theilSen([{ x: 1, y: 1 }, { x: 1, y: 5 }]), null, 'same x has no slope');

// tyreWear: true wear 0.1 s/lap hidden under fuel burn; pit-out lap 2 and an SC lap 8 ignored.
const wl = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
  lap_number: n, t: n * 100e3, is_pit_out_lap: n === 2,
  lap_duration: n === 8 ? 120 : 90 + 0.1 * n - FUEL_S_PER_LAP * n,
}));
const tw = tyreWear(wl, { lap_start: 2, lap_end: null }, 999e3);
assert.ok(Math.abs(tw.rate - 0.1) < 1e-9, `rate ${tw.rate}`);
assert.equal(tw.n, 5);
assert.equal(tyreWear(wl, { lap_start: 2, lap_end: null }, 450e3), null, 'too few clean laps done yet');
assert.equal(tyreWear(wl, { lap_start: 9, lap_end: null }, 999e3), null, 'no laps in stint');

assert.equal(formatGap(null), '');
assert.equal(formatGap(3.456), '+3.5');
assert.equal(formatGap('+1 LAP'), '+1 LAP');
assert.equal(formatClock(3723e3), '1:02:03');
assert.equal(formatLap(92.345), '1:32.3');
assert.equal(formatLap(59.96), '1:00.0', 'rounding carries into the minute');
assert.equal(formatLap(65.04), '1:05.0');
assert.equal(formatLap(92.3456, 3), '1:32.346');
assert.equal(formatLap(65.0004, 3), '1:05.000');

console.log('replay ok');

// ---- race.ts: behaviour captured from the original app.js before the port ----------------
const R = buildRace(raceSession, raceData, '#dim', 1);
assert.equal(R.t0, ms(60), 'race starts at lights-out (earliest lap 1)');
assert.equal(R.t1, ms(337), 'race ends at the last lap end');
assert.equal(R.totalLaps, 3);
assert.equal(R.chequer, ms(336), 'chequer = first finisher of the final lap');
assert.deepEqual(R.bounds, []);
assert.equal(R.drivers.get(44)!.colour, '#dim', 'bad team colour falls back');
assert.equal(R.drivers.get(1)!.colour, '#3671C6');
assert.deepEqual([R.drivers.get(1)!.first, R.drivers.get(1)!.last], ['Max', 'Verstappen']);
assert.deepEqual([R.drivers.get(11)!.first, R.drivers.get(11)!.last], ['', 'PER'], 'missing names fall back to the code');
assert.deepEqual(R.periods.sc, [{ start: ms(100), end: ms(155) }], 'SC ends at the leader\'s next lap start');
assert.equal(R.chunks.length, 1);
assert.equal(windowQuery(R, 0), `date>${new Date(ms(58)).toISOString()}&date<${new Date(ms(362)).toISOString()}`);
assert.equal(chunkIndex(R, ms(9999)), 0, 'chunk index clamps');

R.t = ms(250);
assert.deepEqual(order(R), [1, 11, 44]);
assert.deepEqual(boardRows(R).map((r) => [r.d, r.gap, r.int, r.compound, r.tyre, r.age, r.out]), [
  [1, 'Leader', '', 'SOFT', 'S', 2, false],
  [11, '+1.2', 'PIT', 'HARD', 'H', 0, false],
  [44, 'OUT', '', '', '–', '', true],
]);
R.t = ms(250); assert.deepEqual(boardRows(R).map((r) => r.pit), [false, true, false]);
assert.equal(lapLabel(R), 'Lap 3 / 3');
assert.equal(weatherText(R), 'Air 25° · Track 40° · Hum 50% · Wind 1.2 m/s · Dry');
assert.deepEqual(rcItems(R).map((r) => [r.time, r.flag, r.message]), [
  ['0:01:30', 'sc', 'SAFETY CAR IN THIS LAP'],
  ['0:00:40', 'sc', 'SAFETY CAR DEPLOYED'],
  ['Pre-start', 'green', 'GREEN LIGHT'],
]);
R.standings = {
  drivers: [{ driver_number: 1, points_start: 100 }, { driver_number: 44, points_start: 110 }, { driver_number: 11, points_start: 50 }],
  teams: [{ team_name: 'Red Bull', points_start: 150 }, { team_name: 'Mercedes', points_start: 120 }],
};
assert.deepEqual(standingsRows(R, 'drivers'), [
  { label: 'HAM', start: 110, gain: 15, total: 125 },
  { label: 'VER', start: 100, gain: 25, total: 125 },
  { label: 'PER', start: 50, gain: 18, total: 68 },
]);
assert.deepEqual(standingsRows(R, 'teams').map((r) => [r.label, r.total, r.gain]), [['Red Bull', 193, 43], ['Mercedes', 135, 15]]);
R.selected = new Set([1]);
assert.deepEqual(seriesFor(R, [1, 11, 44], () => []).map((s) => [s.label, s.dashed, s.dim]),
  [['VER', false, false], ['PER', true, true], ['HAM', false, true]], 'teammate dashed, unpicked dimmed');
assert.deepEqual(lapsYDomain([{ points: [{ x: 1, y: 90 }, { x: 2, y: 91 }, { x: 3, y: 150 }] }]), [90, 91 * 1.12]);
assert.equal(lapsYDomain([{ points: [] }]), undefined);

const quali = buildRace(
  { ...raceSession, session_name: 'Qualifying', session_type: 'Qualifying', date_start: at(0), date_end: at(400) },
  {
    ...raceData, intervals: [],
    laps: [lap(1, 1, 20, 70), lap(11, 1, 20, 71), lap(1, 2, 110, 75)],
    raceControl: [100, 200, 300].map((s) => ({ date: at(s), category: 'Flag', flag: 'CHEQUERED', message: 'CHEQUERED FLAG' })),
  },
  '#dim', 1,
);
assert.equal(quali.t0, ms(0), 'non-race sessions use their whole window');
assert.equal(quali.t1, ms(400));
assert.deepEqual(quali.bounds, [ms(100), ms(200)], 'every chequer but the last splits segments');
quali.t = ms(150);
assert.equal(lapLabel(quali), 'Q2');
assert.deepEqual(boardRows(quali).slice(0, 2).map((r) => [r.d, r.gap, r.int]), [[1, '1:10.000', 'Q1'], [11, '1:11.000', 'Q1']],
  'earlier-segment times show their segment label');
quali.t = ms(190);
assert.deepEqual(boardRows(quali).slice(0, 2).map((r) => [r.d, r.gap, r.int]), [[1, '1:15.000', ''], [11, '1:11.000', 'Q1']]);
const fp = buildRace({ ...raceSession, session_name: 'Practice 1', session_type: 'Practice' }, { ...raceData, intervals: [] }, '#dim', 1);
assert.equal(lapLabel(fp), 'Practice 1');
assert.equal(fp.chequer, -Infinity, 'no OUT outside races');
assert.equal(standingsNote(fp, 'drivers'), 'Standings are shown for races and sprints — pick one of those.');

console.log('race ok');
