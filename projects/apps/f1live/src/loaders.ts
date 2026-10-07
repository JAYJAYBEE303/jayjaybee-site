// Background loaders for a loaded race. Each takes the race it was started for plus
// `current()`; once the user switches race, current() !== R and the loader stops writing.
import { api } from './openf1.ts';
import { byDriver, lapOutline, cumulative, toMs, drsRuns, timed, lapTrace, lastAt, bestLap } from './replay.ts';
import type { Sample, CarRow, Lap } from './replay.ts';
import { chunkIndex, windowQuery } from './race.ts';
import type { Race, Session } from './race.ts';

type Current = () => Race | null;
type Loc = { driver_number: number; date: string; x: number; y: number };

// Fetch location windows, always preferring the one at (or just after) the playhead.
export async function loadChunks(R: Race, current: Current, onError: (msg: string) => void) {
  for (;;) {
    let i = R.chunks.findIndex((c, j) => !c && j >= chunkIndex(R, R.t));
    if (i < 0) i = R.chunks.findIndex((c) => !c);
    if (i < 0) return;
    R.chunks[i] = 'loading';
    let rows: Loc[];
    try {
      rows = await api<Loc>(`location?session_key=${R.session.session_key}&${windowQuery(R, i)}`);
    } catch (err) {
      if (current() === R) { R.chunks[i] = undefined; onError(`Couldn't load car positions (${(err as Error).message}).`); }
      return;
    }
    if (current() !== R) return;
    // (0, 0) is OpenF1's "no fix" placeholder.
    R.chunks[i] = byDriver(rows.filter((r) => r.x || r.y), 'date', (r) => ({ x: r.x, y: r.y }));
    if (!R.outline) {
      const pts = lapOutline(R.chunks[i] as Map<number, Sample[]>, R.laps);
      if (pts.length > 10) { R.outline = pts; R.cum = cumulative(pts); }
    }
  }
}

// DRS zones from the meeting's fastest qualifying lap. Optional: any failure just means no layer.
export async function loadDrs(R: Race, current: Current, session: Session) {
  try {
    const [q] = await api<Session>(`sessions?meeting_key=${session.meeting_key}&session_name=Qualifying`);
    if (!q) return;
    const laps = (await api<Lap>(`laps?session_key=${q.session_key}`)).filter((l) => l.lap_duration && l.date_start);
    if (!laps.length) return;
    const best = laps.reduce((a, b) => (b.lap_duration! < a.lap_duration! ? b : a));
    const from = toMs(best.date_start), to = from + best.lap_duration! * 1000;
    const win = `session_key=${q.session_key}&driver_number=${best.driver_number}`
      + `&date>${new Date(from).toISOString()}&date<${new Date(to).toISOString()}`;
    const [loc, car] = await Promise.all([api<Loc>(`location?${win}`), api<CarRow & { date: string }>(`car_data?${win}`)]);
    if (current() !== R) return;
    R.drs = drsRuns(timed(loc.filter((r) => r.x || r.y)), timed(car));
  } catch {
    // no DRS layer
  }
}

// car_data sample at the playhead, from what's loaded (null while loading or unasked).
export function carSample(R: Race, d: number) {
  const rows = R.car.get(`${d}:${chunkIndex(R, R.t)}`);
  return Array.isArray(rows) ? lastAt(rows, R.t) ?? null : null;
}

// Fetch car_data for driver d in the playhead's window on first ask.
export function requestCarData(R: Race, current: Current, d: number) {
  const i = chunkIndex(R, R.t), key = `${d}:${i}`;
  if (R.car.has(key)) return;
  R.car.set(key, 'loading');
  api<CarRow & { date: string }>(`car_data?session_key=${R.session.session_key}&driver_number=${d}&${windowQuery(R, i)}`)
    .then((r) => { if (current() === R) R.car.set(key, timed(r)); })
    .catch(() => { if (current() === R) R.car.set(key, []); }); // cache the failure: no retry loop
}

// Distance trace of a driver's fastest lap finished by the playhead (empty until fetched).
export function fastestTrace(R: Race, d: number) {
  const lap = bestLap(R.laps.get(d), R.t);
  const hit = lap && R.traces.get(`${d}:${lap.lap_number}`);
  return { lap, points: Array.isArray(hit) ? hit : [] };
}

// Fetch the location + car_data for that lap; once per lap.
export function requestTrace(R: Race, current: Current, d: number) {
  const lap = bestLap(R.laps.get(d), R.t);
  if (!lap) return;
  const key = `${d}:${lap.lap_number}`;
  if (R.traces.has(key)) return;
  R.traces.set(key, 'loading');
  const win = `session_key=${R.session.session_key}&driver_number=${d}`
    + `&date>${new Date(lap.t).toISOString()}&date<${new Date(lap.t + lap.lap_duration * 1000).toISOString()}`;
  Promise.all([api<Loc>(`location?${win}`), api<CarRow & { date: string }>(`car_data?${win}`)])
    .then(([loc, car]) => { if (current() === R) R.traces.set(key, lapTrace(timed(loc.filter((r) => r.x || r.y)), timed(car))); })
    .catch(() => { if (current() === R) R.traces.set(key, []); }); // cache the failure: no retry loop
}
