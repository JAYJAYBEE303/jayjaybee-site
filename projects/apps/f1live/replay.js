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

// Rows with a `date` -> same rows plus t (ms), sorted, undated rows dropped.
export function timed(rows) {
  return rows.map((r) => ({ ...r, t: toMs(r.date) })).filter((r) => !Number.isNaN(r.t)).sort((a, b) => a.t - b.t);
}

// Track status over time from race-control rows (with t): [{ t, status }],
// status 'green' | 'sc' | 'vsc' | 'red'. "Safety car in this lap" turns green at the
// leader's next lap start (leaderLapStarts: sorted ms).
export function trackStatusTimeline(rc, leaderLapStarts) {
  const out = [];
  for (const r of rc) {
    const msg = (r.message ?? '').toUpperCase();
    let status = null, t = r.t;
    if (r.category === 'SafetyCar') {
      if (msg.includes('VIRTUAL')) status = msg.includes('DEPLOYED') ? 'vsc' : msg.includes('ENDING') ? 'green' : null;
      else if (msg.includes('DEPLOYED')) status = 'sc';
      else if (msg.includes('IN THIS LAP')) {
        status = 'green';
        t = leaderLapStarts.find((s) => s > r.t) ?? r.t;
      }
    } else if (r.flag === 'RED') status = 'red';
    else if ((r.flag === 'GREEN' || r.flag === 'CLEAR') && r.scope === 'Track') status = 'green';
    if (status) out.push({ t, status });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Spans of the timeline spent in `status`; one still open at the end runs to endT.
export function periods(timeline, status, endT) {
  const out = [];
  let open = null;
  for (const e of timeline) {
    if (e.status === status && !open) out.push((open = { start: e.t, end: endT }));
    else if (e.status !== status && open) { open.end = e.t; open = null; }
  }
  return out;
}

// Cumulative distance along a polyline, cum[0] = 0.
export function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return cum;
}

// Point on a closed lap polyline `frac` of a lap ahead of the point nearest p.
export function pointAhead(points, cum, p, frac) {
  let best = 0, bestD = Infinity;
  points.forEach((q, i) => {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  const total = cum.at(-1);
  const target = (cum[best] + frac * total) % total;
  const j = cum.findIndex((c) => c >= target);
  return points[j < 0 ? 0 : j];
}

// Runs (>= 2 points) of lap points where the car's DRS was open (car_data drs >= 10).
export function drsRuns(points, carData) {
  const runs = [];
  let run = null;
  for (const p of points) {
    if ((lastAt(carData, p.t)?.drs ?? 0) >= 10) {
      if (!run) runs.push((run = []));
      run.push(p);
    } else run = null;
  }
  return runs.filter((r) => r.length > 1);
}

// Laps finished by time t (rows carry t = lap start; lap_duration in s). Undurationed laps excluded.
export const lapsDone = (laps, t) => (laps ?? []).filter((l) => l.lap_duration && l.t + l.lap_duration * 1000 <= t);

// Fastest sector times over laps finished by t: overall [s1, s2, s3] and per driver.
export function sectorBests(lapsByDriver, t) {
  const overall = [Infinity, Infinity, Infinity];
  const personal = new Map();
  for (const [d, laps] of lapsByDriver) {
    const best = [Infinity, Infinity, Infinity];
    for (const l of lapsDone(laps, t)) {
      [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3].forEach((s, i) => {
        if (s && s < best[i]) best[i] = s;
      });
    }
    personal.set(d, best);
    best.forEach((s, i) => { if (s < overall[i]) overall[i] = s; });
  }
  return { overall, personal };
}

// A driver's stints up to their current lap: [{ compound, from, to }].
export const stintBars = (stints, lap) => (stints ?? [])
  .filter((s) => s.lap_start <= lap)
  .map((s) => ({ compound: s.compound ?? '', from: s.lap_start, to: Math.min(s.lap_end ?? lap, lap) }));

// Fastest lap finished by t that started in [from, to), or undefined.
export function bestLap(laps, t, from = -Infinity, to = Infinity) {
  let best;
  for (const l of lapsDone(laps, t)) {
    if (l.t >= from && l.t < to && (!best || l.lap_duration < best.lap_duration)) best = l;
  }
  return best;
}

// car_data samples placed along one lap: [{ x: % of lap distance, speed, throttle, brake, gear }].
// Distance comes from the lap's location trace (cumulative, interpolated by time).
export function lapTrace(loc, car) {
  if (loc.length < 2) return [];
  const cum = cumulative(loc), total = cum.at(-1) || 1;
  return car.map((r) => {
    const i = indexAt(loc, r.t);
    let d = 0;
    if (i >= 0) {
      const a = loc[i], b = loc[i + 1];
      d = cum[i] + (b && b.t > a.t ? ((r.t - a.t) / (b.t - a.t)) * (cum[i + 1] - cum[i]) : 0);
    }
    return { x: Math.min(100, (d / total) * 100), speed: r.speed, throttle: r.throttle, brake: r.brake, gear: r.n_gear };
  });
}

export const tyreAge = (stint, lap) => (stint.tyre_age_at_start ?? 0) + lap - stint.lap_start;

export function formatGap(gap) {
  if (gap == null || gap === 0) return '';
  return typeof gap === 'number' ? `+${gap.toFixed(1)}` : String(gap);
}

// Championship table with points gained so far this session.
// rows: [{ key, label, start }], gained: Map<key, pts> -> sorted [{ label, start, gain, total }].
export function liveStandings(rows, gained) {
  return rows
    .map((r) => {
      const gain = gained.get(r.key) ?? 0;
      return { label: r.label, start: r.start, gain, total: r.start + gain };
    })
    .sort((a, b) => b.total - a.total || b.start - a.start);
}

// Counter-clockwise rotation by deg, as a reusable point mapper.
export function rotator(deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return (p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
}

// Lap time in seconds -> "m:ss.s" (dp decimal places).
export function formatLap(sec, dp = 1) {
  const f = 10 ** dp, t = Math.round(sec * f) / f;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(dp).padStart(dp + 3, '0')}`;
}

export function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
