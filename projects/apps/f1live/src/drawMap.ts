// Track map: circuit outline (coloured by track status), DRS zones, simulated safety car, cars.
import { lastAt, pointAhead, rotator, sampleAt } from './replay.ts';
import type { Pt } from './replay.ts';
import { chunkIndex, order } from './race.ts';
import type { Race } from './race.ts';
import { paintMap } from './paint.ts';
import type { MapCar, MapScene } from './paint.ts';

const SC_LEAD = 0.1; // simulated safety car runs ~10 % of a lap ahead of the leader
const FADE = 3e3; // safety car fade in/out

let css: CSSStyleDeclaration | undefined;
// Token value from style.css (live: the declaration object tracks the stylesheet).
export const color = (name: string) => (css ??= getComputedStyle(document.documentElement)).getPropertyValue(name).trim();

// World -> canvas mapping that fits the (rotated) outline; recomputed when size, pad, outline or rotation change.
function viewOf(R: Race, w: number, h: number, pad: number) {
  const v = R.view;
  if (v && v.w === w && v.h === h && v.pad === pad && v.outline === R.outline && v.rot === R.rot) return v.map;
  const turn = rotator(R.rot ?? 0);
  const pts = R.outline!.map(turn);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * scale) / 2, oy = (h - (maxY - minY) * scale) / 2;
  // World y points up, screen y points down.
  const map = (p: Pt): [number, number] => {
    const q = turn(p);
    return [ox + (q.x - minX) * scale, oy + (maxY - q.y) * scale];
  };
  R.view = { w, h, pad, outline: R.outline!, rot: R.rot, map };
  return map;
}

function carAt(R: Race, d: number) {
  const chunk = R.chunks[chunkIndex(R, R.t)];
  return chunk instanceof Map ? sampleAt(chunk.get(d), R.t) : null;
}

/** The race at the playhead as canvas-space geometry; null until the outline is known. */
export function realScene(R: Race, w: number, h: number, pad: number): MapScene | null {
  if (!R.outline) return null;
  const view = viewOf(R, w, h, pad);
  const ranked = order(R);
  const sc = R.periods.sc.find((p) => R.t >= p.start && R.t <= p.end);
  const leader = sc && R.cum && carAt(R, ranked[0]);
  let safety: MapScene['sc'] = null;
  if (leader) {
    const [x, y] = view(pointAhead(R.outline, R.cum!, leader, SC_LEAD));
    safety = { x, y, alpha: Math.max(0, Math.min(1, (R.t - sc.start) / FADE, (sc.end - R.t) / FADE)) };
  }
  const cars: MapCar[] = [];
  for (const d of ranked.reverse()) { // leader drawn last, on top
    const p = carAt(R, d);
    if (!p) continue;
    const [x, y] = view(p);
    cars.push({
      code: R.drivers.get(d)!.code, colour: R.drivers.get(d)!.colour, x, y, selected: R.selected.has(d),
      inPit: !!R.pits.get(d)?.some((q) => R.t >= q.t && R.t <= q.t + (q.pit_duration ?? 20) * 1000),
    });
  }
  return {
    outline: R.outline.map(view), drs: R.drs ? R.drs.map((run) => run.map(view)) : [],
    status: lastAt(R.status, R.t)?.status ?? 'green', cars, sc: safety,
  };
}

export const drawMap = (canvas: HTMLCanvasElement, R: Race | null, prefs: { names: boolean; drs: boolean }) =>
  paintMap(canvas, (w, h, pad) => R && realScene(R, w, h, pad), { labels: prefs.names, drs: prefs.drs });
