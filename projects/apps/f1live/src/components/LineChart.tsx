import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { color } from '../drawMap.ts';
import type { Series } from '../race.ts';

export type ChartOpts = {
  invert?: boolean;
  yDomain?: [number, number];
  yFmt?: (v: number) => string;
  xFmt?: (x: number) => string;
  discrete?: boolean;
};
type Hover = { x: number; cx: number; cy: number };

type Props = ChartOpts & {
  series: Series[];
  tipRef: RefObject<HTMLDivElement | null>;
  className?: string;
  label: string;
};

// Line chart: series [{ label, colour, dashed, dim, points: [{ x, y }] }]. Redrawn on every render
// (the 4 Hz tick) and while hovered. invert puts low y at the top (positions). Hover draws a
// crosshair and fills the shared tooltip. discrete (lap numbers) snaps hover to whole x,
// otherwise nearest point per series.
export function LineChart({ series, tipRef, className = 'chart', label, ...opts }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  useLayoutEffect(() => draw(ref.current!, series, opts, hover, tipRef.current!));
  return (
    <canvas
      ref={ref} className={className} role="img" aria-label={label}
      onPointerMove={(e) => setHover({ x: e.nativeEvent.offsetX, cx: e.clientX, cy: e.clientY })}
      onPointerLeave={() => { setHover(null); tipRef.current!.hidden = true; }}
    />
  );
}

function draw(canvas: HTMLCanvasElement, series: Series[], opts: ChartOpts, hv: Hover | null, tip: HTMLDivElement) {
  const { invert = false, yDomain, yFmt = String, xFmt = (x: number) => `Lap ${x}`, discrete = true } = opts;
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = `11px ${color('--font-data')}`;
  c.fillStyle = color('--text-dim');
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) { c.fillText('No finished laps yet.', 8, 16); return; }

  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const [y0, y1] = yDomain ?? [Math.min(...ys), Math.max(...ys)];
  const L = 52, R = 12, T = 10, B = 22, pw = w - L - R, ph = h - T - B;
  const sx = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * pw;
  const sy = (y: number) => T + ((invert ? y - y0 : y1 - y) / (y1 - y0 || 1)) * ph;

  c.strokeStyle = color('--border');
  c.lineWidth = 1;
  c.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = y0 + ((y1 - y0) * k) / 4, y = sy(v);
    c.beginPath(); c.moveTo(L, y); c.lineTo(w - R, y); c.stroke();
    c.fillText(yFmt(v), 4, y);
  }
  c.textBaseline = 'top';
  c.fillText(xFmt(x0), L, h - B + 6);
  c.textAlign = 'right';
  c.fillText(xFmt(x1), w - R, h - B + 6);
  c.textAlign = 'left';

  c.save();
  c.beginPath(); c.rect(L, T, pw, ph); c.clip();
  c.lineWidth = 2;
  c.lineJoin = 'round';
  for (const s of [...series].sort((a, b) => Number(b.dim) - Number(a.dim))) { // dimmed lines underneath
    c.globalAlpha = s.dim ? 0.2 : 1;
    c.setLineDash(s.dashed ? [5, 4] : []);
    c.strokeStyle = s.colour;
    c.beginPath();
    s.points.forEach((p, i) => (i ? c.lineTo(sx(p.x), sy(p.y)) : c.moveTo(sx(p.x), sy(p.y))));
    c.stroke();
  }
  c.restore();

  if (!hv) return; // other charts may own the tooltip
  const xv = x0 + ((hv.x - L) / (pw || 1)) * (x1 - x0);
  const at = discrete ? Math.round(xv) : xv;
  if (at < x0 || at > x1) { tip.hidden = true; return; }
  c.strokeStyle = color('--text-dim');
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(sx(at), T); c.lineTo(sx(at), T + ph); c.stroke();
  type P = (typeof series)[number]['points'][number];
  const nearest = (ps: P[]) => ps.reduce<P | null>((m, p) => (!m || Math.abs(p.x - at) < Math.abs(m.x - at) ? p : m), null);
  const rows = series.filter((s) => !s.dim)
    .map((s) => [s.label, discrete ? s.points.find((p) => p.x === at) : nearest(s.points)] as const)
    .filter((r): r is readonly [string, P] => !!r[1])
    .sort((a, b) => a[1].y - b[1].y)
    .map(([lbl, p]) => `${lbl.padEnd(4)} ${yFmt(p.y)}`);
  tip.textContent = [xFmt(discrete ? at : Math.round(at)), ...rows].join('\n');
  tip.hidden = false;
  tip.style.left = `${Math.min(hv.cx + 14, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${hv.cy + 14}px`;
}
