// Track map: circuit outline (coloured by track status), DRS zones, simulated safety car, cars.
import { lastAt, pointAhead, rotator, sampleAt } from './replay.ts';
import type { Pt } from './replay.ts';
import { chunkIndex, order } from './race.ts';
import type { Race } from './race.ts';

const SC_LEAD = 0.1; // simulated safety car runs ~10 % of a lap ahead of the leader
const FADE = 3e3; // safety car fade in/out

let css: CSSStyleDeclaration | undefined;
// Token value from style.css (live: the declaration object tracks the stylesheet).
export const color = (name: string) => (css ??= getComputedStyle(document.documentElement)).getPropertyValue(name).trim();

// World -> canvas mapping that fits the (rotated) outline; recomputed when size, outline or rotation change.
function viewOf(R: Race, w: number, h: number) {
  const v = R.view;
  if (v && v.w === w && v.h === h && v.outline === R.outline && v.rot === R.rot) return v.map;
  const pad = 32;
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
  R.view = { w, h, outline: R.outline!, rot: R.rot, map };
  return map;
}

function carAt(R: Race, d: number) {
  const chunk = R.chunks[chunkIndex(R, R.t)];
  return chunk instanceof Map ? sampleAt(chunk.get(d), R.t) : null;
}

export function drawMap(canvas: HTMLCanvasElement, R: Race | null, opts: { names: boolean; drs: boolean }) {
  const ctx = canvas.getContext('2d')!;
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!R?.outline) return;
  const view = viewOf(R, w, h);
  const path = (points: readonly Pt[]) => {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(...view(p)) : ctx.moveTo(...view(p))));
  };

  const status = lastAt(R.status, R.t)?.status ?? 'green';
  ctx.lineJoin = ctx.lineCap = 'round';
  path(R.outline);
  ctx.strokeStyle = color(status === 'green' ? '--track' : `--track-${status}`);
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.strokeStyle = color('--track-line');
  ctx.lineWidth = 1;
  ctx.stroke();

  if (R.drs && opts.drs) {
    ctx.strokeStyle = color('--drs');
    ctx.lineWidth = 4;
    for (const run of R.drs) { path(run); ctx.stroke(); }
  }

  ctx.font = `500 11px ${color('--font-data')}`;
  ctx.textBaseline = 'middle';
  const ranked = order(R);

  const sc = R.periods.sc.find((p) => R.t >= p.start && R.t <= p.end);
  const leader = sc && R.cum && carAt(R, ranked[0]);
  if (leader) {
    const [x, y] = view(pointAhead(R.outline, R.cum!, leader, SC_LEAD));
    ctx.globalAlpha = Math.max(0, Math.min(1, (R.t - sc.start) / FADE, (sc.end - R.t) / FADE));
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color('--sc');
    ctx.fill();
    ctx.fillText('SC', x + 11, y);
    ctx.globalAlpha = 1;
  }

  for (const d of ranked.reverse()) { // leader drawn last, on top
    const p = carAt(R, d);
    if (!p) continue;
    const [x, y] = view(p);
    const car = R.drivers.get(d)!;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = car.colour;
    ctx.fill();
    ctx.strokeStyle = color('--bg');
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (R.selected.has(d)) {
      ctx.beginPath();
      ctx.arc(x, y, 9.5, 0, Math.PI * 2);
      ctx.strokeStyle = color('--text');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (opts.names) {
      ctx.fillStyle = color('--text');
      ctx.fillText(car.code, x + 9, y);
    }
  }
}
