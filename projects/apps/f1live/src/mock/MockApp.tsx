// Dev-only (see main.tsx): the mock controller feeding <Page>, driven by one rAF loop.
import { useEffect, useRef, useState } from 'react';
import type { Actions, Snapshot, Source } from '../snapshot.ts';
import { paintMap } from '../paint.ts';
import { Page } from '../ui/Page.tsx';
import { createMockController } from './controller.ts';
import { mockScene } from './data.ts';

type Controller = ReturnType<typeof createMockController>;
const EMIT_MS = 250; // state reaches React at <= 4 Hz; the canvas redraws every frame

/** Actions that do nothing once the source is disposed (a fake load could otherwise outlive the controller). */
function guard(a: Actions, alive: () => boolean): Actions {
  const g = <A extends unknown[]>(f: (...args: A) => void) => (...args: A): void => { if (alive()) f(...args); };
  return {
    togglePlay: g(a.togglePlay), seekBy: g(a.seekBy), restart: g(a.restart), scrub: g(a.scrub),
    setSpeed: g(a.setSpeed), stepSpeed: g(a.stepSpeed),
    toggleLabels: g(a.toggleLabels), toggleDrs: g(a.toggleDrs), toggleEvents: g(a.toggleEvents),
    select: g(a.select), toggleDriver: g(a.toggleDriver), setTab: g(a.setTab), showStandings: g(a.showStandings),
    setYear: g(a.setYear), setSession: g(a.setSession), retry: g(a.retry), replayLast: g(a.replayLast),
    clearCache: () => (alive() ? a.clearCache() : Promise.resolve()),
  };
}

/** Paint the mock map; like the reference, the outline stays up while loading and cars hide (the scene has none). */
const paintMock = (c: Controller, canvas: HTMLCanvasElement | null) => {
  if (canvas) paintMap(canvas, mockScene(c.state), { labels: c.state.labels, drs: c.state.drs });
};

/** `null` until the controller's first tick. `drawMap` is called each frame (default: paint the mock map). */
function useMockSource(scenario: string, drawMap: (c: Controller, canvas: HTMLCanvasElement | null) => void = paintMock): Source | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [actions, setActions] = useState<Actions | null>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const ctl = useRef<Controller | null>(null);
  const draw = useRef(drawMap);
  draw.current = drawMap;

  useEffect(() => {
    let alive = true;
    let raf = 0;
    let ticking = false;
    let lastEmit = -Infinity;
    const c = createMockController({
      selected: [4],
      onTick: (s) => {
        const now = performance.now();
        if (ticking && now - lastEmit < EMIT_MS) return; // frame ticks are throttled; action emits go straight through
        lastEmit = now;
        setSnap(s);
      },
    });
    ctl.current = c;
    setActions(guard(c.actions, () => alive));
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
      last = now;
      ticking = true;
      c.tick(dt);
      ticking = false;
      draw.current(c, mapRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); c.dispose(); ctl.current = null; };
  }, []);

  useEffect(() => { ctl.current?.setScenario(scenario); }, [scenario]);

  return snap && actions ? { snap, actions, mapRef } : null;
}

export function MockApp({ scenario }: { scenario: string }) {
  const source = useMockSource(scenario);
  return source && <Page source={source} />;
}
