// Pure replay helpers — no DOM, no network — so check.mjs can run them in node.

export const toMs = (iso) => Date.parse(iso);

// Index of the last row (sorted by .t) with t <= time, or -1.
export function indexAt(rows, time) {
  let lo = 0, hi = rows.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= time) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return hit;
}

export const lastAt = (rows, time) => (rows ? rows[indexAt(rows, time)] : undefined);

// OpenF1 rows -> Map<driver_number, rows sorted by t (ms)>. Rows without a usable date are dropped.
export function byDriver(rows, dateKey = 'date', pick = (r) => r) {
  const out = new Map();
  for (const r of rows) {
    const t = toMs(r[dateKey]);
    if (Number.isNaN(t)) continue;
    let list = out.get(r.driver_number);
    if (!list) out.set(r.driver_number, (list = []));
    list.push({ ...pick(r), t });
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

// Linearly interpolated {x, y} at time, or null outside the samples' range.
export function sampleAt(samples, time) {
  if (!samples?.length || time < samples[0].t || time > samples.at(-1).t) return null;
  const i = indexAt(samples, time);
  const a = samples[i], b = samples[i + 1];
  if (!b || b.t === a.t) return { x: a.x, y: a.y };
  const k = (time - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

// Points of one clean racing lap (not lap 1, no pit in/out) found inside the loaded samples,
// used to draw the circuit. Falls back to the longest trace if no full lap fits.
export function lapOutline(locByDriver, lapsByDriver) {
  for (const [d, samples] of locByDriver) {
    const laps = lapsByDriver.get(d) ?? [];
    for (let i = 0; i + 1 < laps.length; i++) {
      const lap = laps[i], next = laps[i + 1];
      if (lap.lap_number < 2 || lap.is_pit_out_lap || next.is_pit_out_lap) continue;
      if (lap.t >= samples[0].t && next.t <= samples.at(-1).t) {
        return samples.filter((s) => s.t >= lap.t && s.t <= next.t);
      }
    }
  }
  let best = [];
  for (const s of locByDriver.values()) if (s.length > best.length) best = s;
  return best;
}

export function formatGap(gap) {
  if (gap == null || gap === 0) return '';
  return typeof gap === 'number' ? `+${gap.toFixed(1)}` : String(gap);
}

export function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
