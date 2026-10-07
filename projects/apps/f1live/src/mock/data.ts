// Dev-only mock source: a TypeScript port of reference/design-6e/shared/f1mock.js (simulation -> snapshot).
// Times are seconds since lights-out. Nothing here touches the DOM; the only side effect is the reference's own
// prevPos/changedAt bookkeeping on the state object passed to mockSnapshot. Never import this outside import.meta.env.DEV.
import { SPEEDS } from '../race.ts';
import type { Series } from '../race.ts';
import type { MapScene } from '../paint.ts';
import type {
  Banner, Charts, Compound, EventBand, LegendItem, PickerItem, RcItem, Row, SectorClass, SectorRow, Sectors3,
  Snapshot, StandKind, StandingRow, StintBar, Tab, TabId, TelemetryCard, TrackStatus, TyreLetter, TyreRow,
} from '../snapshot.ts';

export const TOTAL = 53;
export const SCENARIOS = ['live', 'safety-car', 'vsc', 'red-flag', 'feed-dropped', 'retirements', 'chequered', 'qualifying', 'loading', 'no-session'];

/** Reference `Replay` typedef minus `vw`. */
export type MockState = {
  t: number; playing: boolean; speedIdx: number; labels: boolean; drs: boolean; events: boolean; selected: Set<number>;
  tab: TabId; standKind: StandKind; scenario: string; forcedRed: boolean; feedLost: boolean; loading: boolean;
  noSession: boolean; quali: boolean; prevPos: Map<number, number>; changedAt: Map<number, number>;
};
export const newMockState = (selected: number[]): MockState => ({
  t: 0, playing: true, speedIdx: 3, labels: true, drs: true, events: true, selected: new Set(selected), tab: 'telemetry',
  standKind: 'drivers', scenario: 'live', forcedRed: false, feedLost: false, loading: false, noSession: false, quali: false,
  prevPos: new Map(), changedAt: new Map(),
});

type Driver = { driver_number: number; name_acronym: string; first_name: string; last_name: string; team_name: string; team_colour: string; points_start: number };
type Lap = { driver_number: number; lap_number: number; lap_duration: number; duration_sector_1: number; duration_sector_2: number; duration_sector_3: number; is_pit_out_lap: boolean; t: number; end: number };
type Stint = { driver_number: number; stint_number: number; compound: Compound; lap_start: number; lap_end: number; tyre_age_at_start: number };
type Pit = { driver_number: number; pit_duration: number; t: number };
type RaceControl = { category: string; flag: string | null; message: string; t: number };
type RcRow = { t: number; message: string; flag: string; category: string };

const BASE = 82.6, SC_LAPS = [19, 20, 21], VSC_LAP = 40, RETIRE_D = 27, RETIRE_AFTER = 31;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAMS: Record<string, [string, string]> = {
  MCL: ['McLaren', 'F47600'], FER: ['Ferrari', 'ED1131'], RBR: ['Red Bull Racing', '4781D7'], MER: ['Mercedes', '00D7B6'],
  AMR: ['Aston Martin', '229971'], ALP: ['Alpine', '00A1E8'], WIL: ['Williams', '1868DB'], RB: ['Racing Bulls', '6C98FF'],
  HAA: ['Haas F1 Team', '9C9FA2'], SAU: ['Kick Sauber', '01C00E'],
};
/** grid order = base pace order: [number, acronym, name, team, points before this round] */
const GRID: [number, string, string, string, number][] = [
  [1, 'VER', 'Max Verstappen', 'RBR', 205], [4, 'NOR', 'Lando Norris', 'MCL', 275], [81, 'PIA', 'Oscar Piastri', 'MCL', 309],
  [16, 'LEC', 'Charles Leclerc', 'FER', 151], [63, 'RUS', 'George Russell', 'MER', 184], [44, 'HAM', 'Lewis Hamilton', 'FER', 109],
  [12, 'ANT', 'Andrea Kimi Antonelli', 'MER', 64], [23, 'ALB', 'Alexander Albon', 'WIL', 64], [55, 'SAI', 'Carlos Sainz', 'WIL', 16],
  [14, 'ALO', 'Fernando Alonso', 'AMR', 30], [6, 'HAD', 'Isack Hadjar', 'RB', 38], [87, 'BEA', 'Oliver Bearman', 'HAA', 16],
  [22, 'TSU', 'Yuki Tsunoda', 'RBR', 12], [30, 'LAW', 'Liam Lawson', 'RB', 20], [10, 'GAS', 'Pierre Gasly', 'ALP', 20],
  [5, 'BOR', 'Gabriel Bortoleto', 'SAU', 18], [27, 'HUL', 'Nico Hülkenberg', 'SAU', 37], [18, 'STR', 'Lance Stroll', 'AMR', 32],
  [31, 'OCO', 'Esteban Ocon', 'HAA', 27], [43, 'COL', 'Franco Colapinto', 'ALP', 0],
];
const drivers: Driver[] = GRID.map(([n, code, name, team, pts]) => {
  const parts = name.split(' ');
  const last = parts.pop() as string;
  return {
    driver_number: n, name_acronym: code, first_name: parts.join(' '), last_name: last,
    team_name: TEAMS[team][0], team_colour: TEAMS[team][1], points_start: pts,
  };
});

const DEG: Record<Compound, number> = { SOFT: 0.07, MEDIUM: 0.04, HARD: 0.025, INTERMEDIATE: 0.05, WET: 0.05 };
type StintPlan = Omit<Stint, 'driver_number' | 'stint_number'>;
function plan(i: number): StintPlan[] {
  const st = (compound: Compound, lap_start: number, lap_end: number, tyre_age_at_start: number): StintPlan => ({ compound, lap_start, lap_end, tyre_age_at_start });
  if (i === 13) return [st('SOFT', 1, 15, 3), st('HARD', 16, 36, 0), st('SOFT', 37, TOTAL, 0)];
  const first: Compound = i < 10 ? 'MEDIUM' : i % 3 === 0 ? 'SOFT' : 'HARD';
  const second: Compound = first === 'HARD' ? 'MEDIUM' : 'HARD';
  const pit = i % 4 === 1 ? 19 : 24 + ((i * 3) % 9);
  return [st(first, 1, pit, first === 'SOFT' ? 3 : 0), st(second, pit + 1, TOTAL, 0)];
}
const stintsBy: Stint[][] = drivers.map((d, i) => plan(i).map((s, k) => ({ driver_number: d.driver_number, stint_number: k + 1, ...s })));
const stintFor = (i: number, lap: number) => stintsBy[i].find((s) => s.lap_start <= lap && lap <= s.lap_end) ?? stintsBy[i][stintsBy[i].length - 1];

// ---- Simulation -------------------------------------------------------------
const R = rng(20250907);
const lapsBy: Lap[][] = drivers.map(() => []);
{
  const ends = drivers.map((_, i) => [i * 0.04]);
  let chequer = Infinity;
  for (let n = 1; n <= TOTAL; n++) {
    const running = drivers.map((_, i) => i)
      .filter((i) => ends[i].length === n && !(drivers[i].driver_number === RETIRE_D && n > RETIRE_AFTER));
    running.sort((a, b) => ends[a][n - 1] - ends[b][n - 1]);
    let scLead = 0;
    running.forEach((i, r) => {
      const start = ends[i][n - 1];
      if (start >= chequer) return;
      const s = stintFor(i, n), age = s.tyre_age_at_start + n - s.lap_start;
      const pitIn = s.lap_end === n && n < TOTAL, outLap = s.lap_start === n && n > 1;
      let end: number;
      if (SC_LAPS.includes(n)) {
        if (r === 0) scLead = start + BASE * 1.42;
        end = Math.max(start + BASE * 1.06, scLead + r * 0.85) + (pitIn ? 12 : 0);
      } else {
        end = start + BASE + i * 0.11 + DEG[s.compound] * age - 0.055 * n + (R() - 0.5) * 0.5
          + (n === 1 ? 3.5 + r * 0.3 : 0) + (outLap ? 0.8 : 0) + (n === VSC_LAP ? 14 : 0) + (pitIn ? 21.5 : 0);
      }
      ends[i].push(end);
      const dur = end - start, a = r3(dur * (0.315 + (R() - 0.5) * 0.008)), b = r3(dur * (0.37 + (R() - 0.5) * 0.008));
      lapsBy[i].push({
        driver_number: drivers[i].driver_number, lap_number: n, lap_duration: r3(dur),
        duration_sector_1: a, duration_sector_2: b, duration_sector_3: r3(dur - a - b), is_pit_out_lap: outLap, t: start, end,
      });
      if (n === TOTAL && r === 0) chequer = end;
    });
  }
  const hul = drivers.findIndex((d) => d.driver_number === RETIRE_D);
  const last = stintsBy[hul][stintsBy[hul].length - 1];
  last.lap_end = RETIRE_AFTER;
}
/** Start time of the first car to begin lap n. */
export const LS = (n: number) => Math.min(...lapsBy.map((L) => L[n - 1]?.t ?? Infinity));
export const T1 = Math.max(...lapsBy.map((L) => L[L.length - 1].end));
const CHEQUER = Math.min(...lapsBy.map((L) => L[TOTAL - 1]?.end ?? Infinity));
const SC_START = LS(19) - 35, SC_IN = LS(21) + 4, SC_END = LS(22);
export const VSC_START = LS(VSC_LAP) + 20;
const VSC_END = LS(VSC_LAP) + 72;

const pits: Pit[] = stintsBy.flatMap((S, i) => S.filter((s) => s.lap_end < TOTAL && !(drivers[i].driver_number === RETIRE_D && s.lap_end === RETIRE_AFTER)).map((s) => {
  const t = lapsBy[i][s.lap_end - 1].end - 18;
  return { driver_number: drivers[i].driver_number, pit_duration: 22.4, t };
}));

const RC_RAW: [number, string, string | null, string][] = [
  [-300, 'Flag', 'GREEN', 'GREEN LIGHT - PIT EXIT OPEN'],
  [-240, 'Other', null, 'RISK OF RAIN FOR F1 RACE IS 10%'],
  [-20, 'Other', null, 'PIT EXIT CLOSED'],
  [LS(3), 'Drs', null, 'DRS ENABLED'],
  [LS(7) + 31, 'Other', null, 'CAR 43 (COL) TIME 1:24.910 DELETED - TRACK LIMITS AT TURN 8 LAP 6'],
  [LS(12) + 40, 'Flag', 'YELLOW', 'YELLOW IN TRACK SECTOR 7'],
  [LS(12) + 58, 'Flag', 'CLEAR', 'CLEAR IN TRACK SECTOR 7'],
  [LS(15) + 12, 'Other', null, 'TURN 4 INCIDENT INVOLVING CARS 87 (BEA) AND 5 (BOR) NOTED'],
  [SC_START - 22, 'Flag', 'DOUBLE YELLOW', 'DOUBLE YELLOW IN TRACK SECTOR 12'],
  [SC_START - 4, 'Other', null, 'DEBRIS ON TRACK AT TURN 11'],
  [SC_START, 'SafetyCar', null, 'SAFETY CAR DEPLOYED'],
  [SC_START + 2, 'Drs', null, 'DRS DISABLED'],
  [LS(20) + 30, 'Other', null, 'LAPPED CARS WILL NOT BE ALLOWED TO OVERTAKE'],
  [SC_IN, 'SafetyCar', null, 'SAFETY CAR IN THIS LAP'],
  [SC_END, 'Flag', 'GREEN', 'TRACK CLEAR'],
  [LS(24), 'Drs', null, 'DRS ENABLED'],
  [LS(25) + 10, 'Other', null, 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 87 (BEA) - CAUSING A COLLISION'],
  [LS(31) + 70, 'Other', null, 'CAR 27 (HUL) STOPPED IN THE GARAGE'],
  [VSC_START, 'SafetyCar', null, 'VIRTUAL SAFETY CAR DEPLOYED'],
  [VSC_END - 8, 'SafetyCar', null, 'VIRTUAL SAFETY CAR ENDING'],
  [LS(45) + 20, 'Flag', 'BLUE', 'WAVED BLUE FLAG FOR CAR 43 (COL) TIMED AT 15:21:04'],
  [CHEQUER, 'Flag', 'CHEQUERED', 'CHEQUERED FLAG'],
];
const raceControl: RaceControl[] = RC_RAW.map(([t, category, flag, message]) => ({ category, flag, message, t }));
type Weather = { t: number; air_temperature: number; track_temperature: number; humidity: number; wind_speed: number; rainfall: number };
const weather: Weather[] = Array.from({ length: Math.ceil((T1 + 300) / 60) }, (_, k) => {
  const t = -300 + k * 60, f = Math.max(0, t) / T1;
  return { t, air_temperature: r1(26.1 + 1.3 * f), track_temperature: r1(41.2 + 3.1 * f + Math.sin(k / 7) * 0.4), humidity: Math.round(44 - 6 * f), wind_speed: r1(1.4 + Math.abs(Math.sin(k / 5))), rainfall: 0 };
});

/** position at each lap end (1-based, index = lap number; index 0 unused) */
const posAtLap: number[][] = drivers.map(() => []);
for (let n = 1; n <= TOTAL; n++) {
  lapsBy.flatMap((L, i): [number, number][] => (L[n - 1] ? [[i, L[n - 1].end]] : []))
    .sort((a, b) => a[1] - b[1]).forEach(([i], r) => { posAtLap[i][n] = r + 1; });
}

// ---- Pure helpers (ports) -----------------------------------------------------
const formatClock = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 3600)}:${String(Math.floor(v / 60) % 60).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
const formatLap = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const formatSector = (s: number) => (s < 60 ? s.toFixed(3) : formatLap(s));
const lapIndex = (L: Lap[], t: number) => { let k = 0; while (k < L.length && L[k].end <= t) k++; return k; };
const tyreAge = (s: Stint, lap: number) => (s.tyre_age_at_start ?? 0) + lap - s.lap_start;
const statusAt = (t: number): TrackStatus => (t >= SC_START && t < SC_END ? 'sc' : t >= VSC_START && t < VSC_END ? 'vsc' : 'green');
function theilSen(pts: { x: number; y: number }[]) {
  const s: number[] = [];
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) if (pts[b].x !== pts[a].x) s.push((pts[b].y - pts[a].y) / (pts[b].x - pts[a].x));
  if (!s.length) return null;
  s.sort((p, q) => p - q);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function tyreWear(L: Lap[], stint: Stint, t: number) {
  const done = L.filter((l) => l.end <= t && l.lap_number >= stint.lap_start && l.lap_number <= stint.lap_end && l.lap_number > 1 && !l.is_pit_out_lap);
  if (!done.length) return null;
  const med = [...done.map((l) => l.lap_duration)].sort((a, b) => a - b)[Math.floor(done.length / 2)];
  const clean = done.filter((l) => l.lap_duration <= med * 1.07);
  if (clean.length < 3) return null;
  const rate = theilSen(clean.map((l) => ({ x: l.lap_number, y: l.lap_duration + 0.06 * l.lap_number })));
  return rate === null ? null : { rate, n: clean.length };
}

// ---- Telemetry profile over lap fraction (car_data-like sample) ------------------
// ---- Track geometry (normalised 0..1; Catmull-Rom through CTRL, closed) -----------------------
const CTRL = [[0.16, 0.86], [0.42, 0.88], [0.66, 0.87], [0.8, 0.82], [0.84, 0.68], [0.72, 0.56], [0.76, 0.4], [0.9, 0.26], [0.8, 0.1], [0.56, 0.12], [0.4, 0.27], [0.24, 0.31], [0.1, 0.47], [0.08, 0.7]];
type XY = { x: number; y: number };
const OUTLINE: XY[] = [];
for (let k = 0; k < CTRL.length; k++) {
  const p0 = CTRL[(k - 1 + CTRL.length) % CTRL.length], p1 = CTRL[k], p2 = CTRL[(k + 1) % CTRL.length], p3 = CTRL[(k + 2) % CTRL.length];
  for (let s = 0; s < 24; s++) {
    const u = s / 24, u2 = u * u, u3 = u2 * u;
    const f = (j: 0 | 1) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * u + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * u2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * u3);
    OUTLINE.push({ x: f(0), y: f(1) });
  }
}
const CUM = [0];
for (let k = 1; k <= OUTLINE.length; k++) { const a = OUTLINE[k - 1], b = OUTLINE[k % OUTLINE.length]; CUM.push(CUM[k - 1] + Math.hypot(b.x - a.x, b.y - a.y)); }
/** point at lap fraction f along the outline */
function pointAt(f: number): XY {
  const d = (((f % 1) + 1) % 1) * CUM[CUM.length - 1];
  let k = 1; while (k < CUM.length - 1 && CUM[k] < d) k++;
  const a = OUTLINE[k - 1], b = OUTLINE[k % OUTLINE.length], u = (d - CUM[k - 1]) / (CUM[k] - CUM[k - 1] || 1);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

const DRS_ZONES = [[0.93, 0.13], [0.36, 0.45]];
const inDrs = (f: number) => DRS_ZONES.some(([a, b]) => (a < b ? f >= a && f <= b : f >= a || f <= b));
const CORNERS = [[0.15, 82], [0.27, 192], [0.47, 128], [0.56, 186], [0.62, 168], [0.74, 206], [0.89, 214]];
function profile(f: number, k: number) {
  let v = 346 * k, braking = false, accel = false;
  for (const [c, m] of CORNERS) {
    let d = f - c; d -= Math.round(d);
    const lim = m * k + Math.abs(d) * (d > 0 ? 1850 : 9000);
    if (lim < v) { v = lim; braking = d < 0; accel = d > 0; }
  }
  return { speed: Math.round(v), throttle: braking ? 0 : accel ? Math.round(Math.min(100, 55 + (v / 346) * 50)) : 100, brake: braking ? 100 : 0, n_gear: Math.max(1, Math.min(8, Math.ceil(v / 44))) };
}

// ---- Qualifying table (static mock for the qualifying preview) ------------------
const QR = rng(77);
const quali = drivers.map((_, i) => ({ i, best: 79.21 + i * 0.085 + (QR() - 0.5) * 0.22 })).sort((a, b) => a.best - b.best);

// ---- Snapshot -------------------------------------------------------------------
const TYRE_LETTER: Record<string, TyreLetter> = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const flagOf = (r: RaceControl) => (r.category === 'SafetyCar' ? 'sc' : (r.flag ?? '').toLowerCase().replace(/\s+/g, '-'));
const idxOf = (n: number) => drivers.findIndex((d) => d.driver_number === n);
const tri = <T>(f: (s: 0 | 1 | 2) => T): [T, T, T] => [f(0), f(1), f(2)];
const noSectors = (v: string): Sectors3 => tri(() => ({ v, c: 'none' as SectorClass }));

/** highest timing point passed (3 per lap) */
function passed(i: number, t: number) {
  const L = lapsBy[i], k = lapIndex(L, t), cur = L[k];
  let j = 3 * k;
  if (cur && t >= cur.t + cur.duration_sector_1) j++;
  if (cur && t >= cur.t + cur.duration_sector_1 + cur.duration_sector_2) j++;
  return j;
}
function pointTime(i: number, j: number): number | undefined {
  if (j === 0) return lapsBy[i][0]?.t;
  if (j % 3 === 0) return lapsBy[i][j / 3 - 1]?.end;
  const lap = lapsBy[i][Math.floor(j / 3)];
  return lap ? lap.t + lap.duration_sector_1 + (j % 3 === 2 ? lap.duration_sector_2 : 0) : undefined;
}
/** a = behind, b = ahead */
function gapBetween(a: number, b: number, t: number) {
  const j = passed(a, t);
  if (j < 1) return '';
  const ta = pointTime(a, j), tb = pointTime(b, j);
  if (ta === undefined || tb === undefined) return '';
  let down = 0;
  for (let m = 1; m < 4; m++) { const x = pointTime(b, j + 3 * m); if (x !== undefined && x <= ta) down = m; }
  return down ? `+${down} LAP${down > 1 ? 'S' : ''}` : `+${(ta - tb).toFixed(3)}`;
}

export function mockSnapshot(rp: MockState): Snapshot {
  const t = rp.t;
  const status: TrackStatus = rp.forcedRed ? 'red' : statusAt(t);
  const finished = t >= CHEQUER;
  const D = drivers.map((d, i) => {
    const L = lapsBy[i], k = lapIndex(L, t), cur = L[k], lastEnd = L[L.length - 1].end;
    const frac = cur ? Math.max(0, Math.min(1, (t - cur.t) / (cur.end - cur.t))) : 0;
    const out = lastEnd < CHEQUER - 30 && t > lastEnd + 30;
    return { i, d, k, frac, done: !cur, out, lastEnd, lap: cur ? cur.lap_number : L[k - 1]?.lap_number ?? 1 };
  });
  const ranked = [...D].sort((a, b) => (a.out !== b.out ? (a.out ? 1 : -1) : a.out ? b.lastEnd - a.lastEnd : (b.k + b.frac) - (a.k + a.frac) || (a.done && b.done ? a.lastEnd - b.lastEnd : 0)));
  // sector bests over finished laps
  const overall = [Infinity, Infinity, Infinity];
  const personal = drivers.map(() => [Infinity, Infinity, Infinity]);
  let fastest = { v: Infinity, i: -1 };
  lapsBy.forEach((L, i) => L.forEach((l) => {
    if (l.end > t) return;
    [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3].forEach((v, s) => { overall[s] = Math.min(overall[s], v); personal[i][s] = Math.min(personal[i][s], v); });
    if (l.lap_duration < fastest.v) fastest = { v: l.lap_duration, i };
  }));
  const secClass = (i: number, s: number, v: number): SectorClass => (v <= overall[s] ? 'purple' : v <= personal[i][s] ? 'green' : 'yellow');
  const cells = (i: number, l: Lap): Sectors3 => {
    const v = [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3];
    return tri((s) => ({ v: formatSector(v[s]), c: secClass(i, s, v[s]) }));
  };
  const leader = ranked[0];

  const order = rp.quali ? quali.map((q) => D[q.i]) : ranked;
  const rows: Row[] = order.map((x, idx) => {
    const d = x.d, stint = stintFor(x.i, x.lap), lastLap = lapsBy[x.i][x.k - 1];
    const inPit = pits.some((p) => p.driver_number === d.driver_number && t >= p.t && t <= p.t + p.pit_duration);
    let gap = '', int = '';
    if (rp.quali) {
      const q = quali.find((qq) => qq.i === x.i) as { i: number; best: number };
      const knocked = idx >= 15 ? 'Q1' : idx >= 10 ? 'Q2' : '';
      gap = formatLap(q.best);
      int = knocked || (idx === 0 ? '' : `+${(q.best - quali[0].best).toFixed(3)}`);
    } else {
      gap = x.out ? 'OUT' : idx === 0 ? 'Leader' : gapBetween(x.i, leader.i, t);
      int = inPit ? 'PIT' : idx && !x.out ? gapBetween(x.i, ranked[idx - 1].i, t) : '';
    }
    const pos = idx + 1;
    const prev = rp.prevPos.get(d.driver_number);
    if (prev !== undefined && prev !== pos) rp.changedAt.set(d.driver_number, t);
    rp.prevPos.set(d.driver_number, pos);
    const compound = rp.quali ? 'SOFT' : stint.compound;
    return {
      d: d.driver_number, idx, pos, code: d.name_acronym, name: `${d.first_name} ${d.last_name}`, first: d.first_name, last: d.last_name,
      team: d.team_name, colour: `#${d.team_colour}`, gap, int,
      compound, tyre: TYRE_LETTER[compound] ?? '–', age: rp.quali ? String(2 + (x.i % 3)) : String(tyreAge(stint, x.lap)),
      out: !rp.quali && x.out, pit: !rp.quali && inPit, selected: rp.selected.has(d.driver_number), fastest: !rp.quali && fastest.i === x.i,
      changed: (rp.changedAt.get(d.driver_number) ?? -1e9) > t - 6,
      lastLap: lastLap ? formatLap(lastLap.lap_duration) : '',
      sectors: lastLap ? cells(x.i, lastLap) : noSectors(''),
    };
  });
  const stable = [...rows].sort((a, b) => idxOf(a.d) - idxOf(b.d));

  const leaderLap = Math.min(leader.lap, TOTAL);
  const w = [...weather].reverse().find((r) => r.t <= t) ?? weather[0];
  let rcRows: RcRow[] = rp.quali
    ? [{ t: -600, message: 'GREEN LIGHT - PIT EXIT OPEN', flag: 'green', category: 'Flag' }, { t: 1080, message: 'CHEQUERED FLAG', flag: 'chequered', category: 'Flag' }, { t: 1700, message: 'CAR 43 (COL) TIME 1:20.811 DELETED - TRACK LIMITS AT TURN 11', flag: '', category: 'Other' }, { t: 2100, message: 'CHEQUERED FLAG', flag: 'chequered', category: 'Flag' }, { t: 2690, message: 'GREEN LIGHT - PIT EXIT OPEN', flag: 'green', category: 'Flag' }]
    : raceControl.filter((r) => r.t <= t).map((r) => ({ t: r.t, message: r.message, flag: flagOf(r), category: r.category }));
  if (rp.forcedRed) rcRows = [...rcRows, { t, message: 'RED FLAG', flag: 'red', category: 'Flag' }];
  const rc: RcItem[] = rcRows.slice(-50).reverse().map((r, n) => ({ n: rcRows.length - n, time: r.t < 0 ? 'Pre-start' : formatClock(r.t), message: r.message, flag: r.flag || 'none' }));

  const ids = rp.selected.size ? [...rp.selected] : ranked.slice(0, 3).map((x) => x.d.driver_number);
  const seenTeams = new Set<string>();
  const legend: LegendItem[] = ids.map((n) => { const d = drivers[idxOf(n)]; const dashed = seenTeams.has(d.team_name); seenTeams.add(d.team_name); return { d: n, code: d.name_acronym, colour: `#${d.team_colour}`, dashed }; });

  const telemetry: TelemetryCard[] = [...rp.selected].map((n) => {
    const i = idxOf(n), x = D[i], d = drivers[i];
    const c = x.done || x.out ? null : profile(x.frac, 1 - i * 0.0009);
    const drsOn = !!c && status === 'green' && leaderLap >= 3 && inDrs(x.frac) && c.throttle === 100;
    const stint = stintFor(i, x.lap), wear = tyreWear(lapsBy[i], stint, t);
    const loss = wear ? Math.max(0, wear.rate) * tyreAge(stint, x.lap) : 0;
    return {
      d: n, code: d.name_acronym, name: `${d.first_name} ${d.last_name}`, colour: `#${d.team_colour}`,
      speed: c ? String(c.speed) : '–', gear: c ? String(c.n_gear) : '–', throttle: c?.throttle ?? 0, brake: c?.brake ?? 0, drs: drsOn,
      wearText: wear ? `+${wear.rate.toFixed(2)} s/lap · ~${loss.toFixed(1)} s lost` : 'Wear: after 3 laps',
      wearPct: Math.min(100, (loss / 2) * 100), compound: stint.compound, tyre: TYRE_LETTER[stint.compound], age: String(tyreAge(stint, x.lap)),
    };
  });

  const sectors: SectorRow[] = ranked.map((x, idx) => {
    const l = lapsBy[x.i][x.k - 1];
    return {
      d: x.d.driver_number, pos: idx + 1, code: x.d.name_acronym, colour: `#${x.d.team_colour}`, lap: l ? String(l.lap_number) : '–',
      s: l ? cells(x.i, l) : noSectors('–'), time: l ? formatLap(l.lap_duration) : '–',
    };
  });

  const tyres: TyreRow[] = ranked.map((x) => ({
    d: x.d.driver_number, code: x.d.name_acronym, colour: `#${x.d.team_colour}`,
    bars: stintsBy[x.i].filter((s) => s.lap_start <= x.lap).map((s): StintBar => {
      const to = Math.min(s.lap_end, x.lap);
      return { compound: s.compound, tyre: TYRE_LETTER[s.compound], from: s.lap_start, to, laps: to - s.lap_start + 1, left: ((s.lap_start - 1) / TOTAL) * 100, width: ((to - s.lap_start + 1) / TOTAL) * 100 };
    }),
  }));

  const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  const gained = new Map(ranked.filter((x) => !x.out).slice(0, 10).map((x, k): [number, number] => [x.d.driver_number, PTS[k]]));
  const gl = (gain: number) => (gain ? `+${gain}` : '');
  const sd = drivers
    .map((d) => ({ label: `${d.first_name} ${d.last_name}`, team: d.team_name, colour: `#${d.team_colour}`, start: d.points_start, gain: gained.get(d.driver_number) ?? 0 }))
    .map((r) => ({ ...r, total: r.start + r.gain })).sort((a, b) => b.total - a.total || b.start - a.start)
    .map((r, k) => ({ ...r, pos: k + 1, gainLabel: gl(r.gain) }));
  const teamMap = new Map<string, { label: string; colour: string; start: number; gain: number }>();
  for (const r of sd) {
    const e = teamMap.get(r.team) ?? { label: r.team, colour: r.colour, start: 0, gain: 0 };
    e.start += r.start; e.gain += r.gain; teamMap.set(r.team, e);
  }
  const st = [...teamMap.values()].map((r) => ({ ...r, total: r.start + r.gain })).sort((a, b) => b.total - a.total)
    .map((r, k) => ({ ...r, pos: k + 1, gainLabel: gl(r.gain) }));
  const standOut = (list: StandingRow[]): StandingRow[] => list.map(({ label, colour, start, gain, total, pos, gainLabel }) => ({ label, colour, start, gain, total, pos, gainLabel }));

  const evs: EventBand[] = rp.quali ? [] : ([['sc', SC_START, SC_END], ['vsc', VSC_START, VSC_END]] as const)
    .map(([kind, a, b]) => ({ kind, left: (a / T1) * 100, width: ((b - a) / T1) * 100, label: kind === 'sc' ? 'Safety car' : 'Virtual safety car' }));

  const statusLabel = finished && !rp.quali ? 'Chequered flag' : { green: 'Track clear', sc: 'Safety car', vsc: 'Virtual safety car', red: 'Red flag' }[status];
  let banner: Banner | null = null;
  if (rp.feedLost) banner = { kind: 'feed', title: 'Feed lost', detail: `Showing data from ${formatClock(t)} · retrying every 5 s` };
  else if (status === 'red') banner = { kind: 'red', title: 'Red flag', detail: 'Session suspended · cars to the pit lane' };
  else if (status === 'sc') banner = { kind: 'sc', title: 'Safety car', detail: `Deployed lap 18 · DRS disabled${t >= SC_IN ? ' · in this lap' : ''}` };
  else if (status === 'vsc') banner = { kind: 'vsc', title: 'Virtual safety car', detail: 'Hold delta · DRS disabled' };
  else if (finished && !rp.quali) banner = { kind: 'chequered', title: 'Chequered flag', detail: `${ranked[0].d.name_acronym} wins · classification provisional` };

  const TABS: [TabId, string][] = [['telemetry', 'Telemetry'], ['laps', 'Lap times'], ['positions', 'Positions'], ['sectors', 'Sectors'], ['tyres', 'Tyres'], ['fastest', 'Fastest lap']];
  const tabs: Tab[] = TABS.filter(([id]) => !(rp.quali && id === 'positions')).map(([id, label]) => ({ id, label, selected: rp.tab === id }));
  const panelHidden = Object.fromEntries(TABS.map(([id]) => [id, rp.tab !== id])) as Record<TabId, boolean>;
  const picker: PickerItem[] = ranked.map((x) => ({ d: x.d.driver_number, code: x.d.name_acronym, colour: `#${x.d.team_colour}`, selected: rp.selected.has(x.d.driver_number) }));
  const opt = (v: string) => ({ value: v, label: v });

  return {
    loading: rp.loading, noSession: rp.noSession, stale: rp.feedLost, quali: rp.quali, practice: false, playing: rp.playing,
    buffering: false, finished, sourceLabel: 'Mock data',
    session: { short: 'Italian GP', circuit: 'Monza', name: rp.quali ? 'Qualifying' : 'Race' },
    lap: String(leaderLap), totalLaps: String(TOTAL), segment: 'Q3',
    clock: formatClock(rp.quali ? 2840 + t / 10 : t), status, statusLabel, banner,
    weather: { air: `${w.air_temperature}°`, track: `${w.track_temperature}°` },
    mapNote: rp.loading ? 'Loading timing data…' : '',
    rows, stable, rc, events: evs, legend, fastestText: [], telemetry, sectors, tyres,
    standings: standOut(rp.standKind === 'drivers' ? sd : st), standKind: rp.standKind,
    standNote: rp.quali ? 'Standings change only in races and sprints. Showing points before this session.' : 'Live: points before the race plus points for the running order now.',
    tabs, panelHidden, picker,
    scrubMax: Math.round(T1), scrubVal: Math.round(Math.max(0, t)), progress: Math.max(0, t) / T1 * 100,
    speeds: SPEEDS.map((s, k) => ({ value: String(k), label: `${s}×` })), speedValue: String(rp.speedIdx), speedLabel: `${SPEEDS[rp.speedIdx]}×`,
    labels: rp.labels, drs: rp.drs, eventsOn: rp.events,
    years: ['2026', '2025', '2024', '2023'].map(opt), yearValue: '2025',
    sessions: ['Italian GP · Race', 'Italian GP · Qualifying', 'Italian GP · Practice 3', 'Dutch GP · Race', 'Dutch GP · Qualifying', 'Hungarian GP · Race'].map(opt),
    sessionValue: rp.quali ? 'Italian GP · Qualifying' : 'Italian GP · Race',
    nextSession: { title: 'Azerbaijan Grand Prix', name: 'Practice 1', when: 'Fri 19 Sep · 10:30 BST', countdown: '4d 21h 07m' },
    skeleton: Array.from({ length: 20 }, (_, k) => ({ k, w: 40 + ((k * 37) % 45) })),
    reduced: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    charts: mockCharts(rp),
  };
}

/** Map geometry in canvas pixels for the painter: the square track box centred in w x h, `pad` inside the edge. */
export function mockScene(rp: MockState): (w: number, h: number, pad: number) => MapScene {
  return (w, h, pad) => {
    const t = rp.t, status: TrackStatus = rp.forcedRed ? 'red' : statusAt(t);
    const side = Math.min(w - pad * 2, h - pad * 2), ox = (w - side) / 2, oy = (h - side) / 2;
    const P = (p: XY): [number, number] => [ox + p.x * side, oy + p.y * side];
    const scene: MapScene = {
      outline: [...OUTLINE, OUTLINE[0]].map(P), status, cars: [], sc: null,
      drs: DRS_ZONES.map(([a, b]) => { const span = (b - a + 1) % 1; return Array.from({ length: 31 }, (_, k) => P(pointAt(a + (span * k) / 30))); }),
    };
    if (rp.loading || rp.noSession) return scene;
    let leaderFrac: number | null = null, leaderProg = -1;
    for (const [i, d] of drivers.entries()) {
      const L = lapsBy[i], k = lapIndex(L, t), cur = L[k];
      if (!cur) continue;
      const f = Math.max(0, Math.min(1, (t - cur.t) / (cur.end - cur.t)));
      if (k + f > leaderProg) { leaderProg = k + f; leaderFrac = f; }
      const [x, y] = P(pointAt(f));
      scene.cars.push({
        code: d.name_acronym, colour: `#${d.team_colour}`, x, y, selected: rp.selected.has(d.driver_number),
        inPit: pits.some((p) => p.driver_number === d.driver_number && t >= p.t && t <= p.t + p.pit_duration),
      });
    }
    if (status === 'sc' && leaderFrac !== null) {
      const [x, y] = P(pointAt(leaderFrac + 0.1));
      scene.sc = { x, y, alpha: Math.min(1, (t - SC_START) / 3, (SC_END - t) / 3) };
    }
    return scene;
  };
}

// ---- Chart series (series-building half of the reference drawCharts; painting is Task 8) --------
/** driver numbers in running order at t (order() port) */
function snapshotOrder(t: number) {
  return drivers.map((d, i) => { const L = lapsBy[i], k = lapIndex(L, t), cur = L[k]; return { n: d.driver_number, p: k + (cur ? Math.max(0, Math.min(1, (t - cur.t) / (cur.end - cur.t))) : 0) }; })
    .sort((a, b) => b.p - a.p).map((x) => x.n);
}

export function mockCharts(rp: MockState): Charts {
  const charts: Charts = { laps: [], lapsY: null, positions: [], posMax: 0, fastest: { speed: [], throttle: [], brake: [], gear: [] } };
  if (rp.loading || rp.noSession) return charts;
  const t = rp.t;
  const ids = rp.selected.size ? [...rp.selected] : snapshotOrder(t).slice(0, 3);
  const teams = new Set<string>();
  const meta = ids.map((n) => { const d = drivers[idxOf(n)]; const dashed = teams.has(d.team_name); teams.add(d.team_name); return { i: idxOf(n), label: d.name_acronym, colour: `#${d.team_colour}`, dashed }; });
  if (rp.tab === 'laps') {
    charts.laps = meta.map((m): Series => ({ label: m.label, colour: m.colour, dashed: m.dashed, dim: false, points: lapsBy[m.i].filter((l) => l.end <= t).map((l) => ({ x: l.lap_number, y: l.lap_duration })) }));
    const all = charts.laps.flatMap((s) => s.points.map((p) => p.y)).sort((a, b) => a - b);
    charts.lapsY = all.length ? [all[0], all[Math.floor(all.length / 2)] * 1.12] : null;
  } else if (rp.tab === 'positions') {
    charts.positions = drivers.map((d, i): Series => ({
      label: d.name_acronym, colour: `#${d.team_colour}`, dashed: false, dim: rp.selected.size > 0 && !rp.selected.has(d.driver_number),
      points: posAtLap[i].flatMap((y, n) => (y !== undefined && lapsBy[i][n - 1]?.end <= t ? [{ x: n, y }] : [])),
    }));
    charts.posMax = 20;
  } else if (rp.tab === 'fastest') {
    const two = rp.selected.size ? meta : meta.slice(0, 2);
    const traces = two.map((m) => {
      const best = lapsBy[m.i].some((l) => l.end <= t);
      const k = 1 - m.i * 0.0009;
      return { ...m, pts: best ? Array.from({ length: 101 }, (_, x) => ({ x, ...profile(x / 100, k) })) : [] };
    });
    const keys = [['speed', 'speed'], ['throttle', 'throttle'], ['brake', 'brake'], ['gear', 'n_gear']] as const;
    for (const [name, key] of keys) {
      charts.fastest[name] = traces.map((tr): Series => ({ label: tr.label, colour: tr.colour, dashed: tr.dashed, dim: false, points: tr.pts.map((p) => ({ x: p.x, y: p[key] })) }));
    }
  }
  return charts;
}
