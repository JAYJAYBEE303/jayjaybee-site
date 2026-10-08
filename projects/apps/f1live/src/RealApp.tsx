// The real source: useReplay (OpenF1) + the UI state the race model doesn't hold, adapted to the Snapshot contract.
import { useEffect, useState } from 'react';
import { api, clearCache } from './openf1.ts';
import { SPEEDS } from './race.ts';
import type { Kind, Standings } from './race.ts';
import { useReplay, YEARS } from './useReplay.ts';
import { requestCarData, requestTrace } from './loaders.ts';
import { shownDrivers, toSnapshot } from './toSnapshot.ts';
import type { Actions, Source, TabId } from './snapshot.ts';
import { Page } from './ui/Page.tsx';

const toggle = (sel: Set<number>, d: number) => { if (!sel.delete(d)) sel.add(d); return sel; };

export function useRealSource(): Source {
  const rp = useReplay();
  const { race: R, current, bump, setPrefs, setPlaying, seek } = rp;
  const [tabPick, setTabPick] = useState<TabId>('telemetry');
  const [standKind, setStandKind] = useState<Kind>('drivers');
  const [standingsMsg, setStandingsMsg] = useState<string | null>(null);
  // Positions only exist for races and sprints.
  const tab = R && !R.isRace && tabPick === 'positions' ? 'telemetry' : tabPick;

  // A fetch message belongs to the race it came from.
  useEffect(() => { setStandingsMsg(null); }, [R]);

  // Telemetry (tab + focus card) needs car_data for the selection; the Fastest lap tab needs traces.
  useEffect(() => {
    if (!R) return;
    for (const d of R.selected) requestCarData(R, current, d);
    if (tab === 'fastest') for (const d of shownDrivers(R, 2)) requestTrace(R, current, d);
  });

  // Data part only: Page opens the dialog.
  const showStandings = async (k: Kind) => {
    const R = current();
    if (!R) return;
    setStandingsMsg(null);
    setStandKind(k);
    if (R.standings || !R.isRace) return;
    const q = `session_key=${R.session.session_key}`;
    setStandingsMsg('Loading…');
    try {
      const [drivers, teams] = await Promise.all([
        api<Standings['drivers'][number]>(`championship_drivers?${q}`),
        api<Standings['teams'][number]>(`championship_teams?${q}`),
      ]);
      if (current() !== R) return;
      R.standings = { drivers, teams };
      setStandingsMsg(null);
    } catch (err) {
      if (current() === R) setStandingsMsg(`Couldn't load standings (${(err as Error).message}).`);
      return;
    }
    bump();
  };

  // Change the loaded race's selection, then re-render.
  const onSelection = (fn: (sel: Set<number>) => Set<number>) => {
    const r = current();
    if (r) { r.selected = fn(r.selected); bump(); }
  };
  const actions: Actions = {
    togglePlay: () => { const r = current(); if (r) setPlaying(!r.playing); },
    seekBy: (sec) => { const r = current(); if (r) seek(r.t + sec * 1000); },
    restart: () => { const r = current(); if (r) seek(r.t0); },
    scrub: (sec) => { const r = current(); if (r) seek(r.t0 + sec * 1000); },
    setSpeed: (idx) => setPrefs((p) => ({ ...p, speed: SPEEDS[idx] ?? p.speed })),
    stepSpeed: rp.stepSpeed,
    toggleLabels: () => setPrefs((p) => ({ ...p, names: !p.names })),
    toggleDrs: () => setPrefs((p) => ({ ...p, drs: !p.drs })),
    toggleEvents: () => setPrefs((p) => ({ ...p, events: !p.events })),
    // Click = just this driver (again = clear); shift-click = add/remove.
    select: (d, add) => onSelection((sel) => (add ? toggle(sel, d) : new Set(sel.size === 1 && sel.has(d) ? [] : [d]))),
    toggleDriver: (d) => onSelection((sel) => toggle(sel, d)),
    setTab: (t) => { if (t !== 'positions' || current()?.isRace !== false) setTabPick(t); },
    showStandings: (k) => { showStandings(k); },
    setYear: (v) => rp.pickSeason(Number(v)),
    setSession: rp.pickRace,
    retry: rp.retry,
    replayLast: () => {}, // the no-session hero is mock-only
    clearCache: async () => { await clearCache(); },
  };

  const snap = toSnapshot(R, {
    tab, standKind, prefs: rp.prefs, pickOrder: rp.pickOrder, standingsMsg,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    years: YEARS, year: rp.year, sessions: rp.sessions, sessionValue: rp.raceKey,
    mapNote: rp.status, error: rp.error, meetingShort: R ? rp.meetingShort(R.session.meeting_key) : '',
  });
  return { snap, actions, mapRef: rp.mapRef };
}

export function RealApp() {
  return <Page source={useRealSource()} />;
}
