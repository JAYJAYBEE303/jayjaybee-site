// Pure port of design-6e's renderVals(): Snapshot -> presentation values (CSS-var colours, aria labels, motion strings).
// Key names are the reference's so components read what the template bound. Dead renderVals output is not ported.
import type { Charts, Option, RcItem, Row, SectorCell, SectorClass, Snapshot, StandingRow, TabId, TelemetryCard, TyreLetter } from './snapshot.ts';

export interface SectorVm { v: string; fg: string; mark: string; aria: string }
export interface FocusVm {
  posText: string; last: string; first: string; team: string; code: string; colour: string; gapText: string;
  tyre: string; tyreColor: string; compound: string; age: string; lastLap: string; sectors: SectorVm[];
}
export interface NeighbourVm { last: string; colour: string; val: string }
export interface FocusTeleVm { speed: string; gear: string; throttle: number; brake: number; wearText: string; drsText: string; drsColor: string }
export interface StintVm { compound: string; from: number; to: number; left: number; width: number; bg: string; tyre: string }
export interface EventVm { label: string; left: number; width: number; bg: string }
export interface RibbonTickVm { left: number; label: string }
export interface RibbonVm {
  d: number; selected: boolean; aria: string; top: number; left: number; op: number;
  chipBg: string; chipFg: string; colour: string; code: string;
}
export interface TileVm {
  d: number; pos: number; opacity: number; selected: boolean; aria: string; bg: string; edge: string;
  age: string; compound: string; tyreColor: string; tyre: string; colour: string; last: string; fastest: boolean;
  gapText: string; intColor: string; intShow: string; sectors: { bar: string }[]; lastLap: string; secMarks: string;
}
export interface RcVm extends RcItem { chip: string; marker: string; markerText: string }
export interface TabVm { id: TabId; label: string; selected: boolean; color: string; bg: string; bar: string }
export interface PickerVm { d: number; code: string; colour: string; selected: boolean; fg: string; bg: string; border: string }
export interface TelemetryVm extends TelemetryCard { drsText: string; drsColor: string; drsBorder: string }
export interface LegendVm { d: number; code: string; colour: string; lineStyle: 'solid' | 'dashed' }
export interface SectorsRowVm { d: number; pos: number; code: string; colour: string; lap: string; time: string; s: SectorVm[] }
export interface TyreBarVm extends StintVm { laps: number }
export interface TyresRowVm { d: number; code: string; bars: TyreBarVm[] }
export interface Shortcut { k: string; v: string }

export interface ViewModel {
  chipDot: string; chipText: string; progress: number; heroA: string; heroB: string;
  lights: { bg: string }[]; statusColor: string; statusLabel: string; clock: string;
  weather: { air: string; track: string };
  rcTime: string; rcChip: string; rcLatest: string; rcMarker: string;
  hasBanner: boolean; banner: { title: string; detail: string }; bannerBg: string; bannerFg: string;
  stale: boolean; noSession: boolean; nextSession: Snapshot['nextSession']; hasSession: boolean; loading: boolean; ready: boolean;
  focus: FocusVm; hasAhead: boolean; noAhead: boolean; ahead: NeighbourVm; hasBehind: boolean; noBehind: boolean; behind: NeighbourVm;
  hasFocusTele: boolean; noFocusTele: boolean; ft: FocusTeleVm; focusStints: StintVm[];
  session: Snapshot['session']; playText: string; playLabel: string; scrubMax: number; scrubVal: number;
  eventsOn: boolean; events: EventVm[]; speeds: Option[]; speedValue: string;
  labels: boolean; drs: boolean; labelsFg: string; labelsBar: string; drsFg: string; drsBar: string; eventsFg: string; eventsBar: string;
  spreadNote: string; ribbonTicks: RibbonTickVm[]; ribbon: RibbonVm[]; ribbonMotion: string;
  towerTitle: string; skeleton: Snapshot['skeleton']; tiles: TileVm[];
  rcCount: number; rcAll: RcVm[]; tabs: TabVm[]; picker: PickerVm[]; panelHidden: Record<TabId, boolean>;
  telemetryEmpty: boolean; telemetry: TelemetryVm[]; legend: LegendVm[]; legend2: LegendVm[];
  sectors: SectorsRowVm[]; tyres: TyresRowVm[];
  years: Option[]; sessions: Option[]; sessionValue: string;
  standings: StandingRow[]; standNote: string; isDrivers: boolean; isTeams: boolean;
  drvFg: string; drvBg: string; drvBar: string; teamFg: string; teamBg: string; teamBar: string;
  shortcuts: Shortcut[];
  // additions over the reference (real data, mock-only copy, canvases)
  sourceLabel: Snapshot['sourceLabel']; mapNote: string; charts: Charts;
}

const BORDER_STRONG = 'var(--border-strong)';
const TYRE: Record<string, string> = { S: 'var(--tyre-s)', M: 'var(--tyre-m)', H: 'var(--tyre-h)', I: 'var(--tyre-i)', W: 'var(--tyre-w)' };
const tyreColor = (t: TyreLetter | string) => TYRE[t] ?? BORDER_STRONG;
const SEC: Record<SectorClass, [string, string]> = {
  purple: ['var(--sec-purple)', '◆ '], green: ['var(--sec-green)', '● '], yellow: ['var(--sec-yellow)', ''], none: ['var(--text-tertiary)', ''],
};
const ARIA: Record<SectorClass, string> = { purple: 'overall best', green: 'personal best', yellow: 'slower', none: 'no time' };
const MARK: Record<SectorClass, string> = { purple: '◆', green: '●', yellow: '–', none: '·' };
const CHIP: Record<string, [string, string]> = {
  green: ['Green', 'var(--status-green)'], yellow: ['Yellow', 'var(--status-sc)'], 'double-yellow': ['Dbl yellow', 'var(--status-sc)'],
  red: ['Red flag', 'var(--status-red)'], blue: ['Blue', 'var(--status-blue)'], chequered: ['Chequered', 'var(--text-primary)'],
  clear: ['Clear', 'var(--status-green)'], sc: ['Safety car', 'var(--status-sc)'], none: ['Note', BORDER_STRONG],
};
const BANNER: Record<string, [string, string]> = {
  sc: ['var(--status-sc)', 'var(--p-black-950)'], vsc: ['var(--status-sc)', 'var(--p-black-950)'],
  red: ['var(--accent)', 'var(--text-on-accent)'], feed: ['var(--bg-surface-2)', 'var(--text-primary)'],
  chequered: ['var(--text-primary)', 'var(--bg-base)'],
};
const STATUS_COLOR: Record<string, string> = {
  green: 'var(--status-green)', sc: 'var(--status-sc)', vsc: 'var(--status-sc)', red: 'var(--accent-text)',
  feed: 'var(--text-secondary)', chq: 'var(--text-primary)',
};
const SHORTCUTS: Shortcut[] = [
  ['Space', 'Play / pause'], ['← →', 'Back / forward 10 s'], [', .', 'Back / forward 1 s'], ['↑ ↓', 'Faster / slower'], ['R', 'Restart'],
  ['L', 'Driver names'], ['D', 'DRS zones'], ['B', 'Safety car / red flag bar'], ['C', "Drivers' standings"], ['A', "Constructors' standings"], ['H', 'This list'],
].map(([k, v]) => ({ k, v }));

const OFF = { bg: 'var(--light-off)' };
const lit = (bg: string, n = 5) => Array.from({ length: 5 }, (_, i) => (i < n ? { bg } : OFF));
const LIGHTS: Record<string, { bg: string }[]> = {
  green: lit('var(--status-green)', 1), sc: lit('var(--status-sc)'), vsc: lit('var(--status-sc)', 3),
  red: lit('var(--accent)'), feed: lit('var(--light-off)', 0), chq: lit('var(--text-primary)'),
};

const toggle = (on: boolean) => (on ? ['var(--text-primary)', 'var(--accent)'] as const : ['var(--text-tertiary)', 'transparent'] as const);
const tabStyle = (on: boolean) => on
  ? { color: 'var(--text-primary)', bg: 'var(--bg-surface-2)', bar: 'var(--accent)' }
  : { color: 'var(--text-tertiary)', bg: 'transparent', bar: 'transparent' };
const sectorVm = (cells: readonly SectorCell[]): SectorVm[] =>
  cells.map((c) => ({ v: c.v, fg: SEC[c.c][0], mark: SEC[c.c][1], aria: `${c.v} ${ARIA[c.c]}` }));
const numGap = (g: string) => { const v = parseFloat(String(g).replace('+', '')); return Number.isFinite(v) ? v : null; };
const dash = (l: { dashed: boolean }) => (l.dashed ? 'dashed' : 'solid') as 'solid' | 'dashed';

const EMPTY_FOCUS: FocusVm = {
  posText: '–', last: '–', first: '–', team: '–', code: '–', colour: 'transparent', gapText: '–', tyre: '–', tyreColor: BORDER_STRONG,
  compound: '–', age: '–', lastLap: '–',
  sectors: [0, 1, 2].map(() => ({ v: '', fg: 'var(--text-tertiary)', mark: '', aria: 'no time' })),
};

export function toViewModel(s: Snapshot): ViewModel {
  // practice ranks by best lap like qualifying; "Pole" wording stays qualifying-only
  const bests = s.quali || s.practice;
  const key = (r: Row) => (bests ? r.int : r.gap);

  const status = s.stale ? 'feed' : s.finished && !s.quali ? 'chq' : s.status;
  const [bannerBg, bannerFg] = s.banner ? BANNER[s.banner.kind] : ['', ''];
  const [lf, lbar] = toggle(s.labels), [df, dbar] = toggle(s.drs), [ef, ebar] = toggle(s.eventsOn);
  const rcs: RcVm[] = s.rc.map((m) => { const [chip, col] = CHIP[m.flag] ?? CHIP.none; return { ...m, chip, marker: col, markerText: m.flag === 'none' ? 'var(--text-tertiary)' : col }; });
  const dv = tabStyle(s.standKind === 'drivers'), tm = tabStyle(s.standKind === 'teams');

  const fi = Math.max(0, s.rows.findIndex((r) => r.selected));
  const fr: Row | undefined = s.rows[fi], ah: Row | undefined = s.rows[fi - 1], bh: Row | undefined = s.rows[fi + 1];
  const ft = fr && s.telemetry.find((t) => t.d === fr.d);
  const fty = fr && s.tyres.find((t) => t.d === fr.d);

  const gv = new Map(s.rows.map((r) => [r.d, r.idx === 0 ? 0 : /LAP|OUT/.test(key(r)) ? null : numGap(key(r))]));
  const finite = [...gv.values()].filter((v): v is number => v !== null);
  const spread = Math.max(0, ...finite);
  const maxGap = Math.max(bests ? 2 : 10, Math.ceil(spread));

  const aria = (r: Row) => `P${r.pos} ${r.name}, ${r.team}, gap ${r.gap}, interval ${r.int}, ${r.compound} tyre ${r.age} laps${r.fastest ? ', fastest lap' : ''}${r.out ? ', retired' : ''}`;

  const focus: FocusVm = fr ? {
    posText: `P${fr.pos}`, last: fr.last, first: fr.first, team: fr.team, code: fr.code, colour: fr.colour,
    gapText: fr.idx === 0 ? (s.quali ? 'Pole' : 'Leading') : fr.gap,
    tyre: fr.tyre, tyreColor: tyreColor(fr.tyre), compound: fr.compound, age: fr.age, lastLap: fr.lastLap, sectors: sectorVm(fr.sectors),
  } : EMPTY_FOCUS;

  return {
    chipDot: s.stale || !s.playing ? 'var(--text-tertiary)' : 'var(--status-live)',
    chipText: s.stale ? 'Feed lost' : `${s.playing ? (s.buffering ? 'Buffering' : 'Replaying') : 'Paused'} · ${s.speedLabel}`,
    progress: s.progress,
    heroA: s.practice ? s.session.name : s.quali ? 'Segment' : `Lap ${s.lap}`,
    heroB: s.practice ? '' : s.quali ? s.segment : `/ ${s.totalLaps}`,
    lights: LIGHTS[status], statusColor: STATUS_COLOR[status], statusLabel: s.statusLabel, clock: s.clock,
    weather: { air: s.weather.air, track: s.weather.track },
    rcTime: s.rc[0]?.time ?? '', rcChip: rcs[0]?.chip ?? '', rcLatest: rcs[0]?.message ?? 'No race control messages yet', rcMarker: rcs[0]?.marker ?? BORDER_STRONG,
    hasBanner: !!s.banner, banner: s.banner ? { title: s.banner.title, detail: s.banner.detail } : { title: '', detail: '' }, bannerBg, bannerFg,
    stale: s.stale, noSession: s.noSession, nextSession: s.nextSession, hasSession: !s.noSession, loading: s.loading, ready: !s.loading && !s.noSession,
    focus,
    hasAhead: !!ah, noAhead: !ah, ahead: ah ? { last: ah.last, colour: ah.colour, val: fr?.int || '–' } : { last: '', colour: '', val: '' },
    hasBehind: !!bh, noBehind: !bh, behind: bh ? { last: bh.last, colour: bh.colour, val: bh.out ? 'OUT' : bh.int || '–' } : { last: '', colour: '', val: '' },
    hasFocusTele: !!ft, noFocusTele: !ft,
    ft: ft
      ? { speed: ft.speed, gear: ft.gear, throttle: ft.throttle, brake: ft.brake, wearText: ft.wearText, drsText: ft.drs ? 'DRS open' : 'DRS shut', drsColor: ft.drs ? 'var(--status-green)' : 'var(--text-tertiary)' }
      : { speed: '', gear: '', throttle: 0, brake: 0, wearText: '', drsText: '', drsColor: '' },
    focusStints: (fty?.bars ?? []).map((b) => ({ compound: b.compound, from: b.from, to: b.to, left: b.left, width: b.width, bg: tyreColor(b.tyre), tyre: b.tyre })),
    session: s.session, playText: s.playing ? 'Pause' : 'Play', playLabel: s.playing ? 'Pause' : 'Play',
    scrubMax: s.scrubMax, scrubVal: s.scrubVal, eventsOn: s.eventsOn,
    events: s.events.map((e) => ({
      label: e.label, left: e.left, width: e.width,
      bg: e.kind === 'sc' ? 'var(--status-sc)' : e.kind === 'red' ? 'var(--status-red)' : 'repeating-linear-gradient(90deg,var(--status-sc) 0 3px,transparent 3px 6px)',
    })),
    speeds: s.speeds, speedValue: s.speedValue, labels: s.labels, drs: s.drs,
    labelsFg: lf, labelsBar: lbar, drsFg: df, drsBar: dbar, eventsFg: ef, eventsBar: ebar,
    spreadNote: `Front to back on the lead lap: ${spread.toFixed(1)} s · scale 0–${maxGap} s · lapped cars parked at the right edge`,
    ribbonTicks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ left: f * 90, label: f ? `+${(maxGap * f).toFixed(maxGap < 5 ? 1 : 0)} s` : (s.quali ? 'Pole' : 'Leader') })),
    ribbon: s.stable.map((r) => {
      const v = gv.get(r.d) ?? null;
      return {
        d: r.d, selected: r.selected, aria: aria(r), top: (r.idx % 4) * 24 + 10, left: v === null ? 94 : (v / maxGap) * 90, op: r.out ? 0 : 1,
        chipBg: r.selected ? 'var(--accent)' : 'var(--bg-surface-2)', chipFg: r.selected ? 'var(--text-on-accent)' : 'var(--text-primary)', colour: r.colour,
        code: v === null && !r.out ? `${r.code} ${key(r).replace('+', '')}` : r.code,
      };
    }),
    ribbonMotion: s.reduced ? 'none' : 'left 700ms cubic-bezier(.16,1,.3,1), top 300ms ease',
    towerTitle: s.practice ? 'Best laps' : s.quali ? 'Qualifying order' : s.finished ? 'Classification' : 'Running order',
    skeleton: s.skeleton,
    tiles: s.stable.map((r) => ({
      d: r.d, pos: r.pos, opacity: r.out ? 0.45 : 1, selected: r.selected, aria: aria(r),
      bg: r.selected ? 'var(--bg-surface-2)' : 'var(--card-bg)',
      edge: r.selected ? 'var(--accent)' : r.changed ? 'var(--status-sc)' : 'var(--border-subtle)',
      age: r.age, compound: r.compound, tyreColor: tyreColor(r.tyre), tyre: r.tyre, colour: r.colour, last: r.last, fastest: r.fastest,
      gapText: r.out ? 'OUT' : r.gap, intColor: r.pit ? 'var(--status-sc)' : r.out ? 'var(--accent-text)' : 'var(--text-secondary)', intShow: r.pit ? 'PIT' : r.int,
      sectors: r.sectors.map((c) => ({ bar: c.c === 'none' ? 'var(--bg-surface-3)' : SEC[c.c][0] })), lastLap: r.lastLap,
      secMarks: r.sectors.map((c) => MARK[c.c]).join(' '),
    })),
    rcCount: rcs.length, rcAll: rcs,
    tabs: s.tabs.map((t) => ({ ...t, ...tabStyle(t.selected) })),
    picker: s.picker.map((p) => ({
      ...p, fg: p.selected ? 'var(--text-primary)' : 'var(--text-tertiary)', bg: p.selected ? 'var(--bg-surface-2)' : 'transparent',
      border: p.selected ? 'var(--accent)' : 'var(--border-hairline)',
    })),
    panelHidden: s.panelHidden,
    telemetryEmpty: s.telemetry.length === 0,
    telemetry: s.telemetry.map((t) => ({
      ...t, drsText: t.drs ? 'open' : 'shut', drsColor: t.drs ? 'var(--status-green)' : 'var(--text-tertiary)', drsBorder: t.drs ? 'var(--status-green)' : 'var(--border-hairline)',
    })),
    legend: s.legend.map((l) => ({ ...l, lineStyle: dash(l) })),
    legend2: (s.telemetry.length ? s.legend : s.legend.slice(0, 2)).map((l, i) => ({ ...l, code: s.fastestText[i] ?? l.code, lineStyle: dash(l) })),
    sectors: s.sectors.map((r) => ({ d: r.d, pos: r.pos, code: r.code, colour: r.colour, lap: r.lap, time: r.time, s: sectorVm(r.s) })),
    tyres: s.tyres.map((t) => ({
      d: t.d, code: t.code,
      bars: t.bars.map((b) => ({ compound: b.compound, from: b.from, to: b.to, laps: b.laps, left: b.left, width: b.width, bg: tyreColor(b.tyre), tyre: b.tyre })),
    })),
    years: s.years, sessions: s.sessions, sessionValue: s.sessionValue,
    standings: s.standings, standNote: s.standNote, isDrivers: s.standKind === 'drivers', isTeams: s.standKind === 'teams',
    drvFg: dv.color, drvBg: dv.bg, drvBar: dv.bar, teamFg: tm.color, teamBg: tm.bg, teamBar: tm.bar,
    shortcuts: SHORTCUTS,
    sourceLabel: s.sourceLabel, mapNote: s.mapNote, charts: s.charts,
  };
}
