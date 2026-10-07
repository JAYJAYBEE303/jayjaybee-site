import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { api } from './openf1.ts';
import type { Kind, Standings } from './race.ts';
import { useReplay } from './useReplay.ts';
import { SessionPicker } from './components/SessionPicker.tsx';
import { Tower } from './components/Tower.tsx';
import { Transport } from './components/Transport.tsx';
import { Insights } from './components/Insights.tsx';
import type { Tab } from './components/Insights.tsx';
import { HelpDialog, StandingsDialog } from './components/Dialogs.tsx';

export function App() {
  const replay = useReplay();
  const { race, current, bump, prefs, setPrefs, setPlaying, seek, stepSpeed } = replay;
  const [tab, setTab] = useState<Tab>('telemetry');
  const [kind, setKind] = useState<Kind>('drivers');
  const [standingsMsg, setStandingsMsg] = useState<string | null>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const standingsRef = useRef<HTMLDialogElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const selectTab = (t: Tab) => {
    setTab(t);
    tipRef.current!.hidden = true;
  };
  // Positions only exist for races and sprints.
  useEffect(() => { if (race && !race.isRace && tab === 'positions') selectTab('telemetry'); });

  const toggleHelp = () => (helpRef.current!.open ? helpRef.current!.close() : helpRef.current!.showModal());

  const showStandings = async (k: Kind) => {
    const R = current();
    if (!R) return;
    setKind(k);
    if (!standingsRef.current!.open) standingsRef.current!.showModal();
    if (!R.standings && R.isRace) {
      const q = `session_key=${R.session.session_key}`;
      setStandingsMsg('Loading…');
      try {
        const [drivers, teams] = await Promise.all([api(`championship_drivers?${q}`), api(`championship_teams?${q}`)]);
        if (current() !== R) return;
        R.standings = { drivers, teams } as Standings;
      } catch (err) {
        if (current() === R) setStandingsMsg(`Couldn't load standings (${(err as Error).message}).`);
        return;
      }
    }
    bump();
  };

  // Leaderboard click = just this driver (again = clear); shift-click = add/remove.
  const pick = (d: number, add: boolean) => {
    const R = current();
    if (!R) return;
    if (add) {
      if (R.selected.has(d)) R.selected.delete(d); else R.selected.add(d);
    } else {
      R.selected = new Set(R.selected.size === 1 && R.selected.has(d) ? [] : [d]);
    }
    bump();
  };
  const toggleDriver = (d: number, on: boolean) => {
    const R = current();
    if (!R) return;
    if (on) R.selected.add(d); else R.selected.delete(d);
    bump();
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target as Element;
    if (target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return; // let the button act
    if (e.key.toLowerCase() === 'h') { e.preventDefault(); toggleHelp(); return; }
    const R = current();
    if (!R || helpRef.current!.open) return;
    const keys: Record<string, () => void> = {
      ' ': () => setPlaying(!R.playing),
      ArrowLeft: () => seek(R.t - 10e3),
      ArrowRight: () => seek(R.t + 10e3),
      ',': () => seek(R.t - 1e3),
      '.': () => seek(R.t + 1e3),
      ArrowUp: () => stepSpeed(1),
      ArrowDown: () => stepSpeed(-1),
      r: () => seek(R.t0),
      l: () => setPrefs((p) => ({ ...p, names: !p.names })),
      d: () => setPrefs((p) => ({ ...p, drs: !p.drs })),
      b: () => setPrefs((p) => ({ ...p, events: !p.events })),
      c: () => showStandings('drivers'),
      a: () => showStandings('teams'),
    };
    const fn = keys[e.key] ?? keys[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  return (
    <>
      <SessionPicker
        year={replay.year} onYear={(y) => replay.loadSeason(y)} raceKey={replay.raceKey} onRace={replay.pickRace} options={replay.options}
      />
      <main className="stage">
        <section className="track">
          <canvas ref={replay.mapRef} role="img" aria-label="Track map showing each car's position" />
          <p className="status" role="status" hidden={!replay.status}>{replay.status}</p>
        </section>
        <Tower race={race} onPick={pick} />
      </main>
      <Transport
        race={race} prefs={prefs} setPrefs={setPrefs} setPlaying={setPlaying} seek={seek}
        onStandings={() => showStandings('drivers')} onHelp={toggleHelp}
      />
      <Insights
        race={race} current={current} tipRef={tipRef} pickOrder={replay.pickOrder} onToggle={toggleDriver} tab={tab} onTab={selectTab}
      />
      <div ref={tipRef} className="tip" hidden />
      <p className="credit">
        Press H for shortcuts. Data from <a href="https://openf1.org">OpenF1</a>. Unofficial, not associated with Formula 1.
      </p>
      <HelpDialog dialogRef={helpRef} />
      <StandingsDialog dialogRef={standingsRef} race={race} kind={kind} onKind={showStandings} message={standingsMsg} />
    </>
  );
}
