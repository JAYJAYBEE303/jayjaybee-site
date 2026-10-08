// The view contract: everything the page renders, as plain data. Types only — no runtime code.
// Built from the real race by toSnapshot() and from the simulation by the mock source.
import type { RefObject } from 'react';
import type { Status } from './replay.ts';
import type { Kind, Series } from './race.ts';
import type { Prefs } from './useReplay.ts';

export type Compound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET';
export type TyreLetter = 'S' | 'M' | 'H' | 'I' | 'W' | '–';
export type TrackStatus = Status;
export type SectorClass = 'purple' | 'green' | 'yellow' | 'none';
export type TabId = 'telemetry' | 'laps' | 'positions' | 'sectors' | 'tyres' | 'fastest';
export type StandKind = Kind;
/** 'sc' for SafetyCar rows, else the race-control flag in lower-kebab ('double-yellow', …); 'none' when empty. Open set from real data. */
export type RcFlag = string;

export interface SectorCell { v: string; c: SectorClass }
export type Sectors3 = readonly [SectorCell, SectorCell, SectorCell];
export interface Option { value: string; label: string }

export interface Row {
  d: number; idx: number; pos: number;
  code: string; name: string; first: string; last: string; team: string;
  colour: string; // '#RRGGBB'
  gap: string; int: string; // race: '+1.234' | '+1 LAP' | 'Leader' | 'OUT' / 'PIT'; other sessions: best lap / delta or 'Q1'|'Q2'
  compound: Compound | string; tyre: TyreLetter; age: string;
  out: boolean; pit: boolean; selected: boolean; fastest: boolean; changed: boolean;
  lastLap: string;
  sectors: Sectors3;
}
export interface RcItem { n: number; time: string; message: string; flag: RcFlag }
export interface EventBand { kind: 'sc' | 'vsc' | 'red'; left: number; width: number; label: string }
export interface LegendItem { d: number; code: string; colour: string; dashed: boolean }
export interface TelemetryCard {
  d: number; code: string; name: string; colour: string;
  speed: string; gear: string; throttle: number; brake: number; drs: boolean;
  wearText: string; wearPct: number; compound: Compound | string; tyre: TyreLetter; age: string;
}
export interface SectorRow { d: number; pos: number; code: string; colour: string; lap: string; s: Sectors3; time: string }
export interface StintBar { compound: Compound | string; tyre: TyreLetter; from: number; to: number; laps: number; left: number; width: number }
export interface TyreRow { d: number; code: string; colour: string; bars: StintBar[] }
export interface StandingRow { label: string; colour: string; start: number; gain: number; total: number; pos: number; gainLabel: string }
export interface Banner { kind: 'feed' | 'red' | 'sc' | 'vsc' | 'chequered'; title: string; detail: string }
export interface Tab { id: TabId; label: string; selected: boolean }
export interface PickerItem { d: number; code: string; colour: string; selected: boolean }

export interface Charts {
  laps: Series[]; lapsY: [number, number] | null;
  positions: Series[]; posMax: number;
  fastest: Record<'speed' | 'throttle' | 'brake' | 'gear', Series[]>;
}

export interface Snapshot {
  loading: boolean; noSession: boolean; stale: boolean; quali: boolean; practice: boolean;
  playing: boolean; buffering: boolean; finished: boolean;
  sourceLabel: 'OpenF1' | 'Mock data';
  session: { short: string; circuit: string; name: string };
  lap: string; totalLaps: string; segment: string; clock: string;
  status: TrackStatus; statusLabel: string; banner: Banner | null;
  weather: { air: string; track: string };
  mapNote: string; // map overlay text; '' = hidden
  rows: Row[]; // running order
  stable: Row[]; // fixed driver order (DOM-stable tiles + ribbon; CSS `order` sorts visually)
  rc: RcItem[]; // newest first, ≤ 50
  events: EventBand[]; legend: LegendItem[];
  fastestText: string[]; // legend2 labels, index-aligned with legend; [] = use codes
  telemetry: TelemetryCard[];
  sectors: SectorRow[]; tyres: TyreRow[];
  standings: StandingRow[]; standKind: StandKind; standNote: string;
  tabs: Tab[]; panelHidden: Record<TabId, boolean>;
  picker: PickerItem[];
  scrubMax: number; scrubVal: number; progress: number;
  speeds: Option[]; speedValue: string; speedLabel: string;
  labels: boolean; drs: boolean; eventsOn: boolean;
  years: Option[]; yearValue: string; sessions: Option[]; sessionValue: string;
  nextSession: { title: string; name: string; when: string; countdown: string };
  skeleton: { k: number; w: number }[];
  reduced: boolean;
  charts: Charts;
}

export interface Actions {
  togglePlay(): void; seekBy(sec: number): void; restart(): void; scrub(sec: number): void;
  setSpeed(idx: number): void; stepSpeed(by: 1 | -1): void;
  toggleLabels(): void; toggleDrs(): void; toggleEvents(): void;
  select(d: number, add: boolean): void; toggleDriver(d: number): void;
  setTab(t: TabId): void; showStandings(k: StandKind): void;
  setYear(v: string): void; setSession(v: string): void;
  retry(): void; replayLast(): void; clearCache(): Promise<void>;
}

export interface Source { snap: Snapshot; actions: Actions; mapRef: RefObject<HTMLCanvasElement | null> }

/** UI state the adapter needs beyond the Race itself. */
export interface SourceUi {
  tab: TabId; standKind: StandKind; prefs: Prefs; reduced: boolean; pickOrder: number[];
  years: number[]; year: number; sessions: Option[]; sessionValue: string;
  mapNote: string; error: string | null; standingsMsg: string | null; meetingShort: string;
}
