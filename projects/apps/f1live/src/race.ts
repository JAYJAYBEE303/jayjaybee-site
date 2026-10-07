// Race model and the derived readouts the UI shows — ported from app.js, no DOM, no network.
// Every reader looks at the playhead R.t, so panels only show what has happened so far.
import {
  toMs, byDriver, lastAt, indexAt, formatGap, formatClock, timed, trackStatusTimeline, periods,
  tyreAge, bestLap, formatLap, liveStandings,
} from './replay.ts';
import type { Lap, Stint, RaceControl, Sample, Pt, Period, Status, CarRow, TracePoint } from './replay.ts';

export const CHUNK = 5 * 60e3; // location data is fetched in 5-minute windows
export const PAD = 2e3; // windows overlap so interpolation never gaps at a boundary
export const SPEEDS = [0.1, 0.2, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
export const RACE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];

export type Session = {
  session_key: number;
  session_name: string;
  session_type: string;
  date_start: string;
  date_end: string;
  meeting_key: number;
  circuit_key: number;
  year: number;
  location: string;
  circuit_short_name?: string | null;
};
export type Driver = { code: string; first: string; last: string; team: string; colour: string };
export type Weather = {
  t: number; air_temperature?: number; track_temperature?: number; humidity?: number; wind_speed?: number; rainfall?: number;
};
type Interval = { t: number; gap_to_leader?: number | string | null; interval?: number | string | null };
type Pit = { t: number; driver_number: number; pit_duration?: number | null };
export type Standings = {
  drivers: { driver_number: number; points_start?: number | null }[];
  teams: { team_name?: string | null; points_start?: number | null }[];
};
export type Kind = 'drivers' | 'teams';

// State of the loaded race. Mutable on purpose: the frame loop advances t 60 times a second
// and background loaders fill chunks/car/traces; React reads it on a 4 Hz tick.
export type Race = {
  session: Session;
  t0: number;
  t1: number;
  t: number;
  playing: boolean;
  speed: number;
  drivers: Map<number, Driver>;
  laps: Map<number, Lap[]>;
  totalLaps: number;
  isRace: boolean;
  quali: boolean;
  bounds: number[];
  chequer: number;
  lastEnd: Map<number, number>;
  pos: Map<number, { t: number; position?: number }[]>;
  ints: Map<number, Interval[]>;
  stints: Map<number, Stint[]>;
  pits: Map<number, Pit[]>;
  weather: Weather[];
  rc: RaceControl[];
  status: { t: number; status: Status }[];
  periods: Record<'sc' | 'vsc' | 'red', Period[]>;
  chunks: (Map<number, Sample[]> | 'loading' | undefined)[];
  outline: Sample[] | null;
  cum: number[] | null;
  rot?: number;
  view?: { w: number; h: number; outline: Sample[]; rot?: number; map: (p: Pt) => [number, number] };
  drs: Sample[][] | null;
  selected: Set<number>;
  car: Map<string, CarRow[] | 'loading'>; // `${driver}:${window}` -> car_data rows
  traces: Map<string, TracePoint[] | 'loading'>; // `${driver}:${lap}` -> lapTrace points
  standings?: Standings;
};

// Raw OpenF1 rows for one session, as fetched by loadRace.
export type RaceData = {
  drivers: {
    driver_number: number; name_acronym?: string | null; first_name?: string | null; last_name?: string | null;
    team_name: string; team_colour?: string | null;
  }[];
  laps: Omit<Lap, 't'>[];
  position: { driver_number: number; date: string; position?: number }[];
  stints: Stint[];
  intervals: { driver_number: number; date: string; gap_to_leader?: number | string | null; interval?: number | string | null }[];
  raceControl: Omit<RaceControl, 't'>[];
  weather: (Omit<Weather, 't'> & { date: string })[];
  pit: { driver_number: number; date: string; pit_duration?: number | null }[];
};

// One raw OpenF1 row of a RaceData table, e.g. Row<'laps'>.
export type Row<K extends keyof RaceData> = RaceData[K][number];

export function buildRace(session: Session, data: RaceData, dimColour: string, speed: number): Race {
  const { drivers, laps, position, stints, intervals, raceControl, weather, pit } = data;
  const isRace = session.session_type === 'Race'; // includes sprints
  const lapsBy = byDriver(laps, 'date_start') as Map<number, Lap[]>;
  const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => toMs(l.date_start));
  const lapEnd = (l: Omit<Lap, 't'>) => toMs(l.date_start) + (l.lap_duration ?? 0) * 1000;
  const dated = laps.filter((l) => l.date_start);
  // Races run from lights-out to the last finisher; other sessions use their whole window.
  const t0 = isRace && lap1.length ? Math.min(...lap1) : toMs(session.date_start);
  const t1 = isRace && dated.length ? Math.max(...dated.map(lapEnd)) : Math.max(toMs(session.date_end), ...dated.map(lapEnd));
  const totalLaps = Math.max(0, ...laps.map((l) => l.lap_number));

  // Leader's start of each lap = earliest start of that lap number by anyone.
  const leaderStarts = new Map<number, number>();
  for (const l of dated) leaderStarts.set(l.lap_number, Math.min(leaderStarts.get(l.lap_number) ?? Infinity, toMs(l.date_start)));
  const finals = dated.filter((l) => l.lap_number === totalLaps).map(lapEnd);
  const lastEnd = new Map<number, number>();
  for (const l of dated) lastEnd.set(l.driver_number, Math.max(lastEnd.get(l.driver_number) ?? 0, lapEnd(l)));
  const rc = timed(raceControl as RaceControl[]);
  const status = trackStatusTimeline(rc, [...leaderStarts.values()].sort((a, b) => a - b));

  return {
    session, t0, t1, t: t0, playing: false, speed,
    drivers: new Map(drivers.map((d): [number, Driver] => {
      const code = d.name_acronym ?? String(d.driver_number);
      return [d.driver_number, {
        code,
        first: d.first_name || '',
        last: d.last_name || code,
        team: d.team_name,
        colour: /^[0-9a-f]{6}$/i.test(d.team_colour ?? '') ? `#${d.team_colour}` : dimColour,
      }];
    })),
    laps: lapsBy,
    totalLaps,
    isRace,
    quali: session.session_type === 'Qualifying',
    // Qualifying segment boundaries: every chequered flag but the last one.
    bounds: isRace ? [] : rc.filter((r) => r.flag === 'CHEQUERED').map((r) => r.t).slice(0, -1),
    chequer: isRace ? (finals.length ? Math.min(...finals) : t1) : -Infinity, // -Infinity: no OUT outside races
    lastEnd,
    pos: byDriver(position),
    ints: byDriver(intervals),
    stints: Map.groupBy(stints, (s) => s.driver_number),
    pits: Map.groupBy(timed(pit), (p) => p.driver_number),
    weather: timed(weather),
    rc,
    status,
    periods: { sc: periods(status, 'sc', t1), vsc: periods(status, 'vsc', t1), red: periods(status, 'red', t1) },
    chunks: Array.from({ length: Math.max(1, Math.ceil((t1 - t0) / CHUNK)) }),
    outline: null,
    cum: null,
    drs: null,
    selected: new Set(),
    car: new Map(),
    traces: new Map(),
  };
}

// Date filter for fetch window i (padded so interpolation never gaps at a boundary).
export const windowQuery = (R: Race, i: number) => `date>${new Date(R.t0 + i * CHUNK - PAD).toISOString()}`
  + `&date<${new Date(R.t0 + (i + 1) * CHUNK + PAD).toISOString()}`;

export const chunkIndex = (R: Race, t: number) => Math.min(R.chunks.length - 1, Math.max(0, Math.floor((t - R.t0) / CHUNK)));

export const chunkReady = (R: Race) => R.chunks[chunkIndex(R, R.t)] instanceof Map;

// Running order at the playhead.
export function order(R: Race) {
  return [...R.drivers.keys()].sort((a, b) =>
    (lastAt(R.pos.get(a), R.t)?.position ?? 99) - (lastAt(R.pos.get(b), R.t)?.position ?? 99));
}

export const stintOf = (R: Race, d: number, lap: number) =>
  R.stints.get(d)?.find((s) => s.lap_start <= lap && lap <= (s.lap_end ?? Infinity));
export const driverLap = (R: Race, d: number) => lastAt(R.laps.get(d), R.t)?.lap_number ?? 1;

export const flagOf = (r: RaceControl) => (r.category === 'SafetyCar' ? 'sc' : (r.flag ?? '').toLowerCase().replace(/\s+/g, '-'));

export const segment = (R: Race) => R.bounds.filter((b) => b < R.t).length; // 0-based
export const segLabel = (R: Race, k: number) => `${R.session.session_name.startsWith('Sprint') ? 'SQ' : 'Q'}${k + 1}`;

// Non-race sessions: each driver's best lap in the latest segment they ran in.
function sessionBests(R: Race, ranked: number[]) {
  const seg = segment(R), edges = [-Infinity, ...R.bounds, Infinity];
  const out = new Map<number, { lap: Lap & { lap_duration: number }; seg: number }>();
  for (const d of ranked) {
    for (let k = seg; k >= 0; k--) {
      const lap = bestLap(R.laps.get(d), R.t, edges[k], edges[k + 1]);
      if (lap) { out.set(d, { lap, seg: k }); break; }
    }
  }
  const fastest = Math.min(...[...out.values()].filter((b) => b.seg === seg).map((b) => b.lap.lap_duration));
  return { out, seg, fastest };
}

export type BoardRow = {
  d: number; code: string; colour: string; out: boolean; pit: boolean; selected: boolean;
  gap: string; int: string; compound: string; tyre: string; age: number | ''; hasStint: boolean;
};

// Leaderboard rows. Races: gap to leader + interval; other sessions: best lap + delta
// (or the segment label, e.g. Q1, when the time comes from an earlier segment).
export function boardRows(R: Race): BoardRow[] {
  const ranked = order(R);
  const bests = R.isRace ? null : sessionBests(R, ranked);
  return ranked.map((d, i) => {
    const car = R.drivers.get(d)!;
    const lap = driverLap(R, d);
    const stint = stintOf(R, d, lap);
    const compound = stint?.compound ?? '';
    const end = R.lastEnd.get(d) ?? Infinity;
    const out = end < R.chequer - 30e3 && R.t > end + 30e3;
    const inPit = !!R.pits.get(d)?.some((p) => R.t >= p.t && R.t <= p.t + (p.pit_duration ?? 20) * 1000);
    let gap: string, int: string;
    if (bests) {
      const b = bests.out.get(d);
      if (!b) { gap = ''; int = inPit ? 'PIT' : ''; } else {
        const dur = b.lap.lap_duration;
        const delta = b.seg < bests.seg ? (R.quali ? segLabel(R, b.seg) : '')
          : dur === bests.fastest ? '' : `+${(dur - bests.fastest).toFixed(3)}`;
        gap = formatLap(dur, 3);
        int = inPit ? 'PIT' : delta;
      }
    } else {
      const iv = lastAt(R.ints.get(d), R.t);
      gap = out ? 'OUT' : i ? formatGap(iv?.gap_to_leader) : 'Leader';
      int = inPit ? 'PIT' : i && !out ? formatGap(iv?.interval) : '';
    }
    return {
      d, code: car.code, colour: car.colour, out, pit: inPit, selected: R.selected.has(d), gap, int,
      compound, tyre: compound[0] ?? '–', age: stint ? tyreAge(stint, lap) : '', hasStint: !!stint,
    };
  });
}

export function lapLabel(R: Race) {
  if (R.isRace) return `Lap ${Math.min(driverLap(R, order(R)[0]), R.totalLaps || Infinity)} / ${R.totalLaps || '–'}`;
  return R.quali ? segLabel(R, segment(R)) : R.session.session_name;
}

export function weatherText(R: Race) {
  const w = lastAt(R.weather, R.t);
  return w
    ? `Air ${w.air_temperature}° · Track ${w.track_temperature}° · Hum ${w.humidity}% · Wind ${w.wind_speed} m/s · ${w.rainfall ? 'Rain' : 'Dry'}`
    : '';
}

// Race-control feed at the playhead, newest first, last 50 messages.
export function rcItems(R: Race) {
  const idx = indexAt(R.rc, R.t);
  return R.rc.slice(Math.max(0, idx - 49), idx + 1).reverse().map((r) => ({
    key: `${r.t}:${r.message}`,
    flag: flagOf(r),
    time: r.t < R.t0 ? 'Pre-start' : formatClock(r.t - R.t0),
    message: r.message ?? '',
  }));
}

// Championship before this session plus points for the running order at the playhead.
export function standingsRows(R: Race, kind: Kind) {
  const { drivers, teams } = R.standings ?? { drivers: [], teams: [] };
  const pts = R.session.session_name === 'Sprint' ? SPRINT_PTS : RACE_PTS;
  const byDrv = new Map(order(R).map((d, i) => [d, pts[i] ?? 0]));
  if (kind === 'drivers') {
    const rows = drivers.map((r) => ({
      key: r.driver_number, label: R.drivers.get(r.driver_number)?.code ?? `#${r.driver_number}`, start: r.points_start ?? 0,
    }));
    return liveStandings(rows, byDrv);
  }
  const gained = new Map<string | null | undefined, number>();
  for (const [d, p] of byDrv) { const t = R.drivers.get(d)?.team; gained.set(t, (gained.get(t) ?? 0) + p); }
  const rows = teams.map((r) => ({ key: r.team_name, label: r.team_name ?? '–', start: r.points_start ?? 0 }));
  return liveStandings(rows, gained);
}

export function standingsNote(R: Race, kind: Kind) {
  const list = R.standings?.[kind] ?? [];
  if (!R.isRace) return 'Standings are shown for races and sprints — pick one of those.';
  if (!list.length) return 'No standings published for this session.';
  return 'Live: standings before this session plus points for the current running order.';
}

export type Series = { label: string; colour: string; dashed: boolean; dim: boolean; points: Pt[] };

// Series for drivers; a teammate (same team colour as an earlier series) gets a dashed line.
export function seriesFor(R: Race, ids: number[], pointsOf: (d: number) => Pt[]): Series[] {
  const seen = new Set<string>();
  return ids.map((d) => {
    const car = R.drivers.get(d)!;
    const dashed = seen.has(car.colour);
    seen.add(car.colour);
    return { label: car.code, colour: car.colour, dashed, dim: R.selected.size > 0 && !R.selected.has(d), points: pointsOf(d) };
  });
}

// Lap-time y range: clip pit and SC laps so racing laps aren't flattened.
export function lapsYDomain(series: { points: Pt[] }[]): [number, number] | undefined {
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).sort((a, b) => a - b);
  return ys.length ? [ys[0], Math.min(ys.at(-1)!, ys[Math.floor(ys.length / 2)] * 1.12)] : undefined;
}
