// Self-check for replay.js: `node check.mjs` (no deps).
import assert from 'node:assert/strict';
import {
  indexAt, lastAt, byDriver, sampleAt, lapOutline, formatGap, formatClock,
  timed, trackStatusTimeline, periods, cumulative, pointAhead, drsRuns, tyreAge,
  lapsDone, sectorBests, stintBars, formatLap, bestLap, lapTrace,
} from './replay.js';

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

assert.equal(formatGap(null), '');
assert.equal(formatGap(3.456), '+3.5');
assert.equal(formatGap('+1 LAP'), '+1 LAP');
assert.equal(formatClock(3723e3), '1:02:03');
assert.equal(formatLap(92.345), '1:32.3');
assert.equal(formatLap(59.96), '1:00.0', 'rounding carries into the minute');
assert.equal(formatLap(65.04), '1:05.0');
assert.equal(formatLap(92.3456, 3), '1:32.346');
assert.equal(formatLap(65.0004, 3), '1:05.000');

console.log('replay.js ok');
