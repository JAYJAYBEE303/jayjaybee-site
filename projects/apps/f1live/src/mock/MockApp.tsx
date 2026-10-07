// Dev-only (see main.tsx): the mock controller feeding <Page>. The animation loop arrives in Task 7.
import { StrictMode, useEffect, useRef, useState } from 'react';
import type { Actions, Snapshot, Source } from '../snapshot.ts';
import { Page } from '../ui/Page.tsx';
import { createMockController } from './controller.ts';

/** `null` until the controller's first tick. */
function useMockSource(scenario: string): Source | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [actions, setActions] = useState<Actions | null>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = createMockController({ selected: [4], onTick: setSnap });
    setActions(c.actions);
    c.setScenario(scenario);
    return () => c.dispose();
  }, [scenario]);
  return snap && actions ? { snap, actions, mapRef } : null;
}

export function MockApp({ scenario }: { scenario: string }) {
  const source = useMockSource(scenario);
  return source && <StrictMode><Page source={source} /></StrictMode>;
}
