// Pure adapter: the real race model (+ the UI state it doesn't hold) -> the view contract in snapshot.ts.
// Reads R, never writes it; every derivation reuses race.ts / replay.ts / loaders.ts.
import {
  formatClock, formatLap, indexAt, lapsDone, lastAt, liveStandings, sectorBests, stintBars, tyreAge, tyreWear,
} from './replay.ts';
import type { Lap } from './replay.ts';
import {
  RACE_PTS, SPEEDS, SPRINT_PTS, boardRows, chunkReady, driverLap, lapsYDomain, order, rcItems, segLabel, segment,
  seriesFor, standingsNote, stintOf,
} from './race.ts';
import type { Race, Series } from './race.ts';
import { carSample, fastestTrace } from './loaders.ts';
import type {
  Banner, Charts, EventBand, LegendItem, Row, SectorCell, SectorClass, Sectors3, SectorRow, SourceUi, StandingRow,
  Snapshot, Tab, TabId, TelemetryCard, TrackStatus, TyreLetter, TyreRow,
} from './snapshot.ts';

const TABS: [TabId, string][] = [
  ['telemetry', 'Telemetry'], ['laps', 'Lap times'], ['positions', 'Positions'],
  ['sectors', 'Sectors'], ['tyres', 'Tyres'], ['fastest', 'Fastest lap'],
];
const STATUS_LABEL: Record<TrackStatus, string> = {
  green: 'Track clear', sc: 'Safety car', vsc: 'Virtual safety car', red: 'Red flag',
};
const EVENT_LABEL = { sc: 'Safety car', vsc: 'Virtual safety car', red: 'Red flag' } as const;
const TYRE_LETTER = new Map<string, TyreLetter>([['SOFT', 'S'], ['MEDIUM', 'M'], ['HARD', 'H'], ['INTERMEDIATE', 'I'], ['WET', 'W']]);
const WEAR_FULL_S = 2; // time lost vs new tyres at which the wear bar is full
const CHANGE_MS = 6000; // a position change reads as "just moved" for this long
const KEYS = ['speed', 'throttle', 'brake', 'gear'] as const;

export const tyreLetter = (compound: string | null | undefined): TyreLetter =>
  TYRE_LETTER.get((compound ?? '').toUpperCase()) ?? '–';

const fullName = (d: { first: string; last: string }) => `${d.first} ${d.last}`.trim();

/** The driver holding the fastest lap finished by R.t (first one on a tie), or undefined. */
function fastestDriver(R: Race) {
  let best: { d: number; dur: number } | undefined;
  for (const d of R.drivers.keys()) {
    for (const l of lapsDone(R.laps.get(d), R.t)) if (!best || l.lap_duration < best.dur) best = { d, dur: l.lap_duration };
  }
  return best?.d;
}

/** Latest position row at t differs from the one before it, and is under 6 s old. */
function justMoved(R: Race, d: number) {
  const rows = R.pos.get(d);
  const i = rows ? indexAt(rows, R.t) : -1;
  return !!rows && i > 0 && rows[i].position !== rows[i - 1].position && rows[i].t > R.t - CHANGE_MS;
}

/** The lap the leader-most car was on when a safety-car period began. */
function scDeployLap(R: Race, start: number) {
  let n = 1;
  for (const laps of R.laps.values()) for (const l of laps) if (l.t <= start && l.lap_number > n) n = l.lap_number;
  return n;
}

const fmtSector = (s: number) => (s < 60 ? s.toFixed(3) : formatLap(s, 3));

function sectorCells(R: Race, d: number, lap: Lap | undefined, bests: ReturnType<typeof sectorBests>, missing: string): Sectors3 {
  const cell = (s: number | null | undefined, k: number): SectorCell => {
    if (!s) return { v: missing, c: 'none' };
    const c: SectorClass = s <= bests.overall[k] ? 'purple' : s <= (bests.personal.get(d)?.[k] ?? Infinity) ? 'green' : 'yellow';
    return { v: fmtSector(s), c };
  };
  return [cell(lap?.duration_sector_1, 0), cell(lap?.duration_sector_2, 1), cell(lap?.duration_sector_3, 2)];
}

function bannerOf(R: Race, ui: SourceUi, clock: string, finished: boolean, status: TrackStatus): Banner | null {
  if (ui.error) return { kind: 'feed', title: 'Feed lost', detail: `${ui.error} · showing data from ${clock}` };
  if (status === 'red') return { kind: 'red', title: 'Red flag', detail: 'Session suspended · cars to the pit lane' };
  if (status === 'sc') {
    const p = R.periods.sc.findLast((x) => x.start <= R.t);
    const inLap = !!p && R.rc.some((r) => r.category === 'SafetyCar' && (r.message ?? '').toUpperCase().includes('IN THIS LAP')
      && r.t >= p.start && r.t <= R.t);
    return {
      kind: 'sc', title: 'Safety car',
      detail: `Deployed lap ${scDeployLap(R, p?.start ?? R.t)} · DRS disabled${inLap ? ' · in this lap' : ''}`,
    };
  }
  if (status === 'vsc') return { kind: 'vsc', title: 'Virtual safety car', detail: 'Hold delta · DRS disabled' };
  if (finished) return { kind: 'chequered', title: 'Chequered flag', detail: `${R.drivers.get(order(R)[0])?.code ?? '–'} wins` };
  return null;
}

function eventBands(R: Race): EventBand[] {
  const span = R.t1 - R.t0;
  if (span <= 0) return [];
  return (['sc', 'vsc', 'red'] as const).flatMap((kind) => R.periods[kind].flatMap((p) => {
    const a = Math.max(p.start, R.t0), b = Math.min(p.end, R.t1);
    return b > a ? [{ kind, left: ((a - R.t0) / span) * 100, width: ((b - a) / span) * 100, label: EVENT_LABEL[kind] }] : [];
  }));
}

function standingRows(R: Race, ui: SourceUi): StandingRow[] {
  if (!R.isRace || !R.standings) return [];
  const pts = R.session.session_name === 'Sprint' ? SPRINT_PTS : RACE_PTS;
  const byDrv = new Map(order(R).map((d, i) => [d, pts[i] ?? 0]));
  const colourOf = new Map<string, string>();
  let ranked;
  if (ui.standKind === 'drivers') {
    const rows = R.standings.drivers.map((r) => {
      const car = R.drivers.get(r.driver_number);
      const label = car ? fullName(car) : `#${r.driver_number}`;
      colourOf.set(label, car?.colour ?? 'transparent');
      return { key: r.driver_number, label, start: r.points_start ?? 0 };
    });
    ranked = liveStandings(rows, byDrv);
  } else {
    const gained = new Map<string | null | undefined, number>();
    for (const [d, p] of byDrv) { const t = R.drivers.get(d)?.team; gained.set(t, (gained.get(t) ?? 0) + p); }
    const rows = R.standings.teams.map((r) => {
      const label = r.team_name ?? '–';
      colourOf.set(label, [...R.drivers.values()].find((c) => c.team === r.team_name)?.colour ?? 'transparent');
      return { key: r.team_name, label, start: r.points_start ?? 0 };
    });
    ranked = liveStandings(rows, gained);
  }
  return ranked.map((r, k) => ({ ...r, colour: colourOf.get(r.label) ?? 'transparent', pos: k + 1, gainLabel: r.gain ? `+${r.gain}` : '' }));
}

function telemetryCards(R: Race): TelemetryCard[] {
  return [...R.selected].flatMap((d) => {
    const car = R.drivers.get(d);
    if (!car) return [];
    const c = carSample(R, d), lap = driverLap(R, d), stint = stintOf(R, d, lap);
    const wear = stint && tyreWear(R.laps.get(d), stint, R.t);
    const loss = stint && wear ? Math.max(0, wear.rate) * tyreAge(stint, lap) : 0;
    return [{
      d, code: car.code, name: fullName(car), colour: car.colour,
      speed: c?.speed != null ? String(c.speed) : '–', gear: c?.n_gear != null ? String(c.n_gear) : '–',
      throttle: c?.throttle ?? 0, brake: c?.brake ?? 0, drs: (c?.drs ?? 0) >= 10,
      wearText: wear ? `${wear.rate >= 0 ? '+' : ''}${wear.rate.toFixed(2)} s/lap · ~${loss.toFixed(1)} s lost` : 'Wear: after 3 laps',
      wearPct: Math.min(100, (loss / WEAR_FULL_S) * 100),
      compound: stint?.compound ?? '', tyre: tyreLetter(stint?.compound), age: stint ? String(tyreAge(stint, lap)) : '',
    }];
  });
}

const emptyCharts = (): Charts => ({
  laps: [], lapsY: null, positions: [], posMax: 0, fastest: { speed: [], throttle: [], brake: [], gear: [] },
});

function chartsFor(R: Race, tab: TabId, legendIds: number[], fastestIds: number[]): Charts {
  const charts = emptyCharts();
  if (tab === 'laps') {
    charts.laps = seriesFor(R, legendIds, (d) => lapsDone(R.laps.get(d), R.t).map((l) => ({ x: l.lap_number, y: l.lap_duration })));
    charts.lapsY = lapsYDomain(charts.laps) ?? null;
  } else if (tab === 'positions') {
    charts.positions = seriesFor(R, order(R), (d) => lapsDone(R.laps.get(d), R.t).flatMap((l) => {
      const y = lastAt(R.pos.get(d), l.t + l.lap_duration * 1000)?.position;
      return y ? [{ x: l.lap_number, y }] : [];
    }));
    charts.posMax = R.drivers.size;
  } else if (tab === 'fastest') {
    const base: Series[] = seriesFor(R, fastestIds, () => []).map((s) => ({ ...s, dim: false }));
    const traces = fastestIds.map((d) => fastestTrace(R, d).points);
    for (const k of KEYS) {
      charts.fastest[k] = base.map((s, i) => ({
        ...s, points: traces[i].flatMap((p) => (p[k] == null ? [] : [{ x: p.x, y: p[k] }])),
      }));
    }
  }
  return charts;
}

// Everything that comes from UI state alone, so the no-race snapshot shares it.
function fromUi(ui: SourceUi) {
  return {
    sourceLabel: 'OpenF1' as const, mapNote: ui.mapNote, reduced: ui.reduced, noSession: false,
    speeds: SPEEDS.map((s, k) => ({ value: String(k), label: `${s}×` })),
    speedValue: String(SPEEDS.indexOf(ui.prefs.speed)), speedLabel: `${ui.prefs.speed}×`,
    labels: ui.prefs.names, drs: ui.prefs.drs, eventsOn: ui.prefs.events,
    years: ui.years.map((y) => ({ value: String(y), label: String(y) })),
    sessions: ui.sessions, sessionValue: ui.sessionValue, standKind: ui.standKind,
    nextSession: { title: '', name: '', when: '', countdown: '' },
    skeleton: Array.from({ length: 20 }, (_, k) => ({ k, w: 40 + ((k * 37) % 45) })),
  };
}

export function toSnapshot(R: Race | null, ui: SourceUi): Snapshot {
  const tabsFor = (hidePositions: boolean): Tab[] => TABS
    .filter(([id]) => !(hidePositions && id === 'positions')).map(([id, label]) => ({ id, label, selected: ui.tab === id }));
  const panelHidden = Object.fromEntries(TABS.map(([id]) => [id, ui.tab !== id])) as Record<TabId, boolean>;
  const shared = { ...fromUi(ui), panelHidden };

  if (!R) {
    return {
      ...shared, loading: !ui.error, stale: !!ui.error, quali: false, practice: false, playing: false, buffering: false, finished: false,
      session: { short: '', circuit: '', name: '' }, lap: '–', totalLaps: '–', segment: '', clock: formatClock(0),
      status: 'green', statusLabel: STATUS_LABEL.green,
      banner: ui.error ? { kind: 'feed', title: 'Feed lost', detail: `${ui.error} · showing data from ${formatClock(0)}` } : null,
      weather: { air: '–', track: '–' }, rows: [], stable: [], rc: [], events: [], legend: [], fastestText: [], telemetry: [],
      sectors: [], tyres: [], standings: [], standNote: ui.standingsMsg ?? '', tabs: tabsFor(false), picker: [],
      scrubMax: 0, scrubVal: 0, progress: 0, charts: emptyCharts(),
    };
  }

  const ranked = order(R);
  const clock = formatClock(R.t - R.t0);
  const finished = R.isRace && R.t >= R.chequer;
  const status = lastAt(R.status, R.t)?.status ?? 'green';
  const bests = sectorBests(R.laps, R.t);
  const fastest = R.isRace ? fastestDriver(R) : undefined;

  const rows: Row[] = boardRows(R).map((b, idx) => {
    const car = R.drivers.get(b.d)!;
    const last = lapsDone(R.laps.get(b.d), R.t).at(-1);
    return {
      d: b.d, idx, pos: idx + 1, code: b.code, name: fullName(car), first: car.first, last: car.last, team: car.team,
      colour: b.colour, gap: b.gap, int: b.int, compound: b.compound, tyre: tyreLetter(b.compound), age: b.age === '' ? '' : String(b.age),
      out: b.out, pit: b.pit, selected: b.selected, fastest: b.d === fastest, changed: justMoved(R, b.d),
      lastLap: last ? formatLap(last.lap_duration, 3) : '', sectors: sectorCells(R, b.d, last, bests, ''),
    };
  });
  const rank = new Map(ui.pickOrder.map((d, i) => [d, i]));
  const stable = [...rows].sort((a, b) => (rank.get(a.d) ?? Infinity) - (rank.get(b.d) ?? Infinity));

  const legendIds = R.selected.size ? [...R.selected] : ranked.slice(0, 3);
  const fastestIds = R.selected.size ? [...R.selected] : ranked.slice(0, 2);
  const legend: LegendItem[] = seriesFor(R, legendIds, () => [])
    .map((s, i) => ({ d: legendIds[i], code: s.label, colour: s.colour, dashed: s.dashed }));
  const fastestText = fastestIds.map((d) => {
    const code = R.drivers.get(d)!.code, l = fastestTrace(R, d).lap;
    return l ? `${code} ${formatLap(l.lap_duration, 3)} (lap ${l.lap_number})` : `${code} –`;
  });

  const sectors: SectorRow[] = ranked.map((d, i) => {
    const car = R.drivers.get(d)!, last = lapsDone(R.laps.get(d), R.t).at(-1);
    return {
      d, pos: i + 1, code: car.code, colour: car.colour, lap: last ? String(last.lap_number) : '–',
      s: sectorCells(R, d, last, bests, '–'), time: last ? formatLap(last.lap_duration, 3) : '–',
    };
  });

  const totalLaps = R.totalLaps || 1;
  const tyres: TyreRow[] = ranked.map((d) => {
    const car = R.drivers.get(d)!;
    return {
      d, code: car.code, colour: car.colour,
      bars: stintBars(R.stints.get(d), driverLap(R, d)).map((b) => {
        const laps = b.to - b.from + 1;
        return {
          compound: b.compound, tyre: tyreLetter(b.compound), from: b.from, to: b.to, laps,
          left: ((b.from - 1) / totalLaps) * 100, width: (laps / totalLaps) * 100,
        };
      }),
    };
  });

  const standings = standingRows(R, ui);
  const rcAll = rcItems(R), rcTop = indexAt(R.rc, R.t) + 1;
  const span = R.t1 - R.t0;
  const w = lastAt(R.weather, R.t);
  const temp = (v: number | undefined) => (v == null ? '–' : `${v}°`);

  return {
    ...shared,
    loading: false, stale: !!ui.error, quali: R.quali, practice: !R.isRace && !R.quali, playing: R.playing,
    buffering: !chunkReady(R), finished,
    session: { short: ui.meetingShort || R.session.location, circuit: R.session.circuit_short_name ?? R.session.location, name: R.session.session_name },
    lap: R.isRace ? String(Math.min(driverLap(R, ranked[0] ?? 0), R.totalLaps || Infinity)) : '–',
    totalLaps: R.isRace && R.totalLaps ? String(R.totalLaps) : '–',
    segment: R.quali ? segLabel(R, segment(R)) : '', clock,
    status, statusLabel: finished ? 'Chequered flag' : STATUS_LABEL[status],
    banner: bannerOf(R, ui, clock, finished, status),
    weather: { air: temp(w?.air_temperature), track: temp(w?.track_temperature) },
    rows, stable,
    rc: rcAll.map((r, i) => ({ n: rcTop - i, time: r.time, message: r.message, flag: r.flag || 'none' })),
    events: eventBands(R), legend, fastestText, telemetry: telemetryCards(R), sectors, tyres,
    standings,
    standNote: standings.length ? 'Live: points before the race plus points for the running order now.'
      : ui.standingsMsg ?? standingsNote(R, ui.standKind),
    tabs: tabsFor(!R.isRace),
    picker: ui.pickOrder.flatMap((d) => {
      const car = R.drivers.get(d);
      return car ? [{ d, code: car.code, colour: car.colour, selected: R.selected.has(d) }] : [];
    }),
    scrubMax: Math.round(span / 1000), scrubVal: Math.round((R.t - R.t0) / 1000),
    progress: span > 0 ? Math.min(100, Math.max(0, ((R.t - R.t0) / span) * 100)) : 0,
    charts: chartsFor(R, ui.tab, legendIds, fastestIds),
  };
}
