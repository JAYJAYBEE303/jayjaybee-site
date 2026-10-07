// Canvas painters for the track map and the line charts. Colours, fonts and sizes come from CSS custom
// properties on the canvas (--map-*, --chart-* in tokens.css), so the stylesheet themes the drawing.
// Nothing here touches the DOM at import time.
import type { Series } from './race.ts';
import type { TrackStatus } from './snapshot.ts';

export interface MapCar { code: string; colour: string; x: number; y: number; selected: boolean; inPit: boolean }
export interface MapScene {
  outline: [number, number][]; drs: [number, number][][]; status: TrackStatus;
  cars: MapCar[]; // paint order, last on top
  sc: { x: number; y: number; alpha: number } | null;
}

/** Computed value of custom property `name` on `el`, or `fallback` when unset. */
export const cssVar = (el: Element, name: string, fallback: string) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/** Size the backing store to the element (dpr <= 2) and return a ready context, or null while it has no size. */
export function fit(c: HTMLCanvasElement) {
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function carShape(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
  else if (shape === 'diamond') {
    ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.3, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r * 1.3, y); ctx.closePath();
  } else ctx.arc(x, y, r, 0, Math.PI * 2);
}

const TRACK_VAR: Record<TrackStatus, string> = {
  green: '--map-track', sc: '--map-track-sc', vsc: '--map-track-vsc', red: '--map-track-red',
};

/** `build` gets the canvas size and `--map-pad` and returns the scene in canvas pixels (null: nothing to draw). */
export function paintMap(
  canvas: HTMLCanvasElement,
  build: (w: number, h: number, pad: number) => MapScene | null,
  layers: { labels: boolean; drs: boolean },
) {
  const g = fit(canvas);
  if (!g) return;
  const { ctx, w, h } = g;
  const v = (name: string, fb: string) => cssVar(canvas, name, fb);
  ctx.clearRect(0, 0, w, h);
  const scene = build(w, h, Number(v('--map-pad', '26')));
  if (!scene) return;
  const tw = Number(v('--map-width', '6'));
  const trace = (pts: readonly [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  };
  ctx.lineJoin = ctx.lineCap = 'round';
  trace(scene.outline);
  ctx.strokeStyle = v('--map-edge', 'currentColor'); ctx.lineWidth = tw + 4; ctx.stroke();
  ctx.strokeStyle = v(TRACK_VAR[scene.status], 'currentColor'); ctx.lineWidth = tw; ctx.stroke();
  if (layers.drs) {
    ctx.strokeStyle = v('--map-drs', 'currentColor'); ctx.lineWidth = Math.max(2, tw / 2.5);
    for (const run of scene.drs) { trace(run); ctx.stroke(); }
  }
  const label = v('--map-label', 'currentColor');
  const [a, b] = scene.outline;
  if (a && b) { // start/finish line, square to the first segment
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2, d = tw + 4;
    ctx.strokeStyle = label; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(a[0] - Math.cos(ang) * d, a[1] - Math.sin(ang) * d); ctx.lineTo(a[0] + Math.cos(ang) * d, a[1] + Math.sin(ang) * d); ctx.stroke();
  }

  const shape = v('--map-car', 'circle'), r = Number(v('--map-car-size', '5')), glow = v('--map-glow', '0') === '1';
  ctx.font = v('--map-font', '600 11px monospace'); ctx.textBaseline = 'middle';
  const ring = v('--map-ring', 'currentColor'), stroke = v('--map-car-stroke', 'currentColor');
  for (const c of scene.cars) {
    ctx.globalAlpha = c.inPit ? 0.45 : 1;
    if (glow) { ctx.shadowColor = c.colour; ctx.shadowBlur = 8; }
    carShape(ctx, shape, c.x, c.y, r);
    ctx.fillStyle = c.colour; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.shadowBlur = 0;
    if (c.selected) { carShape(ctx, 'circle', c.x, c.y, r + 5); ctx.strokeStyle = ring; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (layers.labels) { ctx.fillStyle = label; ctx.fillText(c.code, c.x + r + 5, c.y); }
    ctx.globalAlpha = 1;
  }
  if (scene.sc) {
    ctx.globalAlpha = Math.max(0, scene.sc.alpha);
    carShape(ctx, 'square', scene.sc.x, scene.sc.y, r + 1); ctx.fillStyle = v('--map-sc', 'currentColor'); ctx.fill();
    ctx.fillStyle = label; ctx.fillText('SC', scene.sc.x + r + 6, scene.sc.y); ctx.globalAlpha = 1;
  }
}

export interface ChartOpts {
  invert?: boolean;
  yDomain?: [number, number];
  yFmt?: (v: number) => string;
  xFmt?: (x: number) => string;
  empty?: string;
}
/** Plot geometry of a painted chart, for the hover layer. */
export interface ChartGeom { x0: number; x1: number; left: number; width: number; top: number; height: number; sx: (x: number) => number }

const PAD = { l: 56, r: 12, t: 10, b: 24 };

/** Paints `series` (dimmed ones first, at 25 % alpha) and returns the plot geometry; null when hidden or empty. */
export function paintChart(canvas: HTMLCanvasElement, series: Series[], o: ChartOpts): ChartGeom | null {
  const g = fit(canvas);
  if (!g) return null;
  const { ctx, w, h } = g;
  const v = (name: string, fb: string) => cssVar(canvas, name, fb);
  ctx.clearRect(0, 0, w, h);
  ctx.font = v('--chart-font', '11px monospace'); ctx.fillStyle = v('--chart-text', 'currentColor');
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(o.empty ?? 'No finished laps yet', w / 2, h / 2); ctx.textAlign = 'left';
    return null;
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let [y0, y1] = o.yDomain ?? [Math.min(...ys), Math.max(...ys)];
  if (y1 <= y0) y1 = y0 + 1;
  const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0 || 1)) * pw;
  const sy = (y: number) => {
    const f = (Math.min(y1, Math.max(y0, y)) - y0) / (y1 - y0);
    return o.invert ? PAD.t + f * ph : h - PAD.b - f * ph;
  };
  const xFmt = o.xFmt ?? ((x: number) => `Lap ${x}`);
  ctx.strokeStyle = v('--chart-grid', 'currentColor'); ctx.lineWidth = 1; ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const y = y0 + ((y1 - y0) * k) / 4, py = sy(y);
    ctx.beginPath(); ctx.moveTo(PAD.l, py); ctx.lineTo(w - PAD.r, py); ctx.stroke();
    ctx.fillText((o.yFmt ?? String)(y), 4, py);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(xFmt(x0), PAD.l, h - 6);
  ctx.textAlign = 'right'; ctx.fillText(xFmt(x1), w - PAD.r, h - 6); ctx.textAlign = 'left';
  ctx.lineWidth = Number(v('--chart-width', '1.75'));
  for (const s of [...series].sort((a, b) => Number(b.dim) - Number(a.dim))) {
    ctx.globalAlpha = s.dim ? 0.25 : 1;
    ctx.setLineDash(s.dashed ? [5, 4] : []);
    ctx.strokeStyle = s.colour;
    ctx.beginPath();
    s.points.forEach((p, k) => (k ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.setLineDash([]);
  return { x0, x1, left: PAD.l, width: pw, top: PAD.t, height: ph, sx };
}
