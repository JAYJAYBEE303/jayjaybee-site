// Self-check for replay.js: `node check.mjs` (no deps).
import assert from 'node:assert/strict';
import {
  indexAt, lastAt, byDriver, sampleAt, lapOutline, formatGap, formatClock,
  timed, trackStatusTimeline, periods, cumulative, pointAhead, drsRuns, tyreAge,
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

assert.equal(formatGap(null), '');
assert.equal(formatGap(3.456), '+3.5');
assert.equal(formatGap('+1 LAP'), '+1 LAP');
assert.equal(formatClock(3723e3), '1:02:03');

console.log('replay.js ok');
