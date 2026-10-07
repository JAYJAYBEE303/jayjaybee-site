// Self-check for replay.js: `node check.mjs` (no deps).
import assert from 'node:assert/strict';
import { indexAt, lastAt, byDriver, sampleAt, lapOutline, formatGap, formatClock } from './replay.js';

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

assert.equal(formatGap(null), '');
assert.equal(formatGap(3.456), '+3.5');
assert.equal(formatGap('+1 LAP'), '+1 LAP');
assert.equal(formatClock(3723e3), '1:02:03');

console.log('replay.js ok');
