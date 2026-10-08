import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { cssVar, paintChart } from '../paint.ts';
import type { ChartOpts } from '../paint.ts';
import type { Series } from '../race.ts';

type Hover = { x: number; cx: number; cy: number };
type Props = ChartOpts & {
  series: Series[];
  tipRef: RefObject<HTMLDivElement | null>;
  className?: string;
  style?: CSSProperties;
  label: string;
  discrete?: boolean; // lap numbers: hover snaps to whole x; otherwise nearest point per series
};

// Painted by paintChart on every render (the 4 Hz tick) and while hovered. Hover adds a crosshair and
// fills the shared tooltip (`.tip`, owned by Page).
export function LineChart({ series, tipRef, className, style, label, discrete = true, ...opts }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current!, tip = tipRef.current!;
    const geom = paintChart(canvas, series, opts);
    if (!geom || !hover) return; // another chart may own the tooltip
    const { x0, x1, left, width, top, height, sx } = geom;
    const xv = x0 + ((hover.x - left) / (width || 1)) * (x1 - x0);
    const at = discrete ? Math.round(xv) : xv;
    if (at < x0 || at > x1) { tip.hidden = true; return; }
    const ctx = canvas.getContext('2d')!;
    ctx.strokeStyle = cssVar(canvas, '--chart-text', 'currentColor'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx(at), top); ctx.lineTo(sx(at), top + height); ctx.stroke();
    type P = Series['points'][number];
    const nearest = (ps: P[]) => ps.reduce<P | null>((m, p) => (!m || Math.abs(p.x - at) < Math.abs(m.x - at) ? p : m), null);
    const yFmt = opts.yFmt ?? String, xFmt = opts.xFmt ?? ((x: number) => `Lap ${x}`);
    const rows = series.filter((s) => !s.dim)
      .map((s) => [s.label, discrete ? s.points.find((p) => p.x === at) : nearest(s.points)] as const)
      .filter((r): r is readonly [string, P] => !!r[1])
      .sort((a, b) => a[1].y - b[1].y)
      .map(([lbl, p]) => `${lbl.padEnd(4)} ${yFmt(p.y)}`);
    tip.textContent = [xFmt(discrete ? at : Math.round(at)), ...rows].join('\n');
    tip.hidden = false;
    tip.style.left = `${Math.min(hover.cx + 14, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${hover.cy + 14}px`;
  });
  return (
    <canvas
      ref={ref} className={className} style={style} role="img" aria-label={label}
      onPointerMove={(e) => setHover({ x: e.nativeEvent.offsetX, cx: e.clientX, cy: e.clientY })}
      onPointerLeave={() => { setHover(null); tipRef.current!.hidden = true; }}
    />
  );
}
