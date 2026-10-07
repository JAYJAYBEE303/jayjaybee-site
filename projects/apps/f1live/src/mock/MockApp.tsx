// Dev-only (see main.tsx): the mock controller feeding <Page>, driven by one rAF loop.
import { useEffect, useRef, useState } from 'react';
import type { Actions, Snapshot, Source } from '../snapshot.ts';
import { Page } from '../ui/Page.tsx';
import { createMockController } from './controller.ts';

type Controller = ReturnType<typeof createMockController>;
const EMIT_MS = 250; // state reaches React at <= 4 Hz; the canvas redraws every frame

/** Actions that do nothing once the source is disposed (a fake load could otherwise outlive the controller). */
function guard(actions: Actions, alive: () => boolean): Actions {
  const out = { ...actions };
  for (const k of Object.keys(out) as (keyof Actions)[]) {
    const f = actions[k] as (...a: never[]) => unknown;
    (out as Record<keyof Actions, unknown>)[k] = (...a: never[]) => (alive() ? f(...a) : undefined);
  }
  return out;
}

/** `null` until the controller's first tick. `drawMap` is the Task 8 hook-up point, called each frame. */
function useMockSource(scenario: string, drawMap: (c: Controller, canvas: HTMLCanvasElement | null) => void = () => {}): Source | null {
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
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      ticking = true;
      c.tick(dt);
      ticking = false;
      draw.current(c, mapRef.current); // Task 8: paint the map here
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
