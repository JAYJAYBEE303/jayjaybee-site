// Replay engine as a hook: the loaded race lives in a ref (the frame loop mutates it 60×/s);
// React re-renders on a 4 Hz tick, the same cadence the original rebuilt its panels at.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, circuitRotation } from './openf1.ts';
import { toMs } from './replay.ts';
import { buildRace, chunkReady, order, SPEEDS } from './race.ts';
import type { Race, Row, Session } from './race.ts';
import { loadChunks, loadDrs } from './loaders.ts';
import { color, drawMap } from './drawMap.ts';

const FIRST_SEASON = 2023; // OpenF1 history starts here
// Session names offered in the picker (testing days and anything else are left out).
const KINDS = ['Practice 1', 'Practice 2', 'Practice 3', 'Sprint Shootout', 'Sprint Qualifying', 'Qualifying', 'Sprint', 'Race'];
const PREFS = 'f1live.prefs';

export const thisYear = new Date().getFullYear();
export const YEARS = Array.from({ length: thisYear - FIRST_SEASON + 1 }, (_, i) => thisYear - i);

export type Prefs = { speed: number; names: boolean; drs: boolean; events: boolean };
export type RaceOptions = { note: string } | { groups: { label: string; sessions: Session[] }[] };

function loadPrefs(): Prefs {
  const p: Prefs = { speed: 1, names: true, drs: true, events: true };
  try {
    const s = JSON.parse(localStorage.getItem(PREFS) ?? '{}') ?? {};
    if (SPEEDS.includes(s.speed)) p.speed = s.speed;
    if (typeof s.names === 'boolean') p.names = s.names;
    if (typeof s.drs === 'boolean') p.drs = s.drs;
    if (typeof s.events === 'boolean') p.events = s.events;
  } catch {
    // corrupt or blocked storage: keep defaults
  }
  return p;
}

export function useReplay() {
  const raceRef = useRef<Race | null>(null);
  const loadId = useRef(0); // bumps on every race switch so stale loaders stop
  const mapRef = useRef<HTMLCanvasElement>(null);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  const [status, setStatus] = useState('');
  const [prefs, setPrefs] = useState(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [year, setYear] = useState(thisYear);
  const [raceKey, setRaceKey] = useState('');
  const [options, setOptions] = useState<RaceOptions>({ note: '' });
  const sessions = useRef<Session[]>([]); // finished sessions of the selected season
  const [pickOrder, setPickOrder] = useState<number[]>([]); // driver picker, in starting order

  useEffect(() => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch {
      // storage blocked: preferences just aren't remembered
    }
    if (raceRef.current) raceRef.current.speed = prefs.speed;
  }, [prefs]);

  const current = useCallback(() => raceRef.current, []);

  const loadRace = useCallback(async (session: Session) => {
    const id = ++loadId.current;
    raceRef.current = null;
    history.replaceState(null, '', `?session=${session.session_key}`);
    setStatus('Loading session…');
    bump();
    const k = `session_key=${session.session_key}`;
    const isRace = session.session_type === 'Race'; // includes sprints
    try {
      const [drivers, laps, position, stints, intervals, raceControl, weather, pit] = await Promise.all([
        api<Row<'drivers'>>(`drivers?${k}`), api<Row<'laps'>>(`laps?${k}`), api<Row<'position'>>(`position?${k}`),
        api<Row<'stints'>>(`stints?${k}`), isRace ? api<Row<'intervals'>>(`intervals?${k}`) : [],
        api<Row<'raceControl'>>(`race_control?${k}`), api<Row<'weather'>>(`weather?${k}`), api<Row<'pit'>>(`pit?${k}`),
      ]);
      if (id !== loadId.current) return;
      const R = buildRace(session, { drivers, laps, position, stints, intervals, raceControl, weather, pit },
        color('--text-dim'), prefsRef.current.speed);
      raceRef.current = R;
      setPickOrder(order(R)); // running order at the start, as the original built its picker
      bump();
      loadChunks(R, current, setStatus);
      loadDrs(R, current, session);
      circuitRotation(session.circuit_key, session.year).then((rot) => {
        if (rot != null && current() === R) R.rot = rot;
      });
    } catch (err) {
      if (id === loadId.current) setStatus(`Couldn't load this race (${(err as Error).message}). Try again shortly.`);
    }
  }, [bump, current]);

  // Returns false when the season has no finished sessions.
  const loadSeason = useCallback(async (y: number, pickKey?: number) => {
    setYear(y);
    setRaceKey('');
    setOptions({ note: 'Loading…' });
    const now = Date.now();
    const list = (await api<Session>(`sessions?year=${y}`))
      .filter((s) => KINDS.includes(s.session_name) && toMs(s.date_end) < now)
      .sort((a, b) => toMs(a.date_start) - toMs(b.date_start));
    sessions.current = list;
    if (!list.length) {
      setOptions({ note: 'No finished sessions' });
      return false;
    }
    setOptions({
      groups: [...Map.groupBy(list, (s) => s.meeting_key).values()].map((g) => ({
        label: `${new Date(g[0].date_start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} · ${g[0].location}`,
        sessions: g,
      })),
    });
    const latest = list.findLast((s) => s.session_name === 'Race') ?? list.at(-1)!;
    const pick = list.find((s) => s.session_key === pickKey) ?? latest;
    setRaceKey(String(pick.session_key));
    loadRace(pick);
    return true;
  }, [loadRace]);

  const pickRace = useCallback((key: string) => {
    setRaceKey(key);
    const s = sessions.current.find((x) => String(x.session_key) === key);
    if (s) loadRace(s);
  }, [loadRace]);

  // Boot: ?session= deep link, else the latest race of this season (or last season early on).
  useEffect(() => {
    const key = new URLSearchParams(location.search).get('session');
    (async () => {
      try {
        const [s] = key ? await api<Session>(`sessions?session_key=${encodeURIComponent(key)}`) : [];
        const y = s ? s.year : thisYear;
        const found = await loadSeason(y, s?.session_key);
        // Early in a season there may be nothing finished yet — fall back a year.
        if (!found && y === thisYear) await loadSeason(thisYear - 1);
      } catch (err) {
        setStatus(`Couldn't reach OpenF1 (${(err as Error).message}).`);
      }
    })();
    return () => { loadId.current++; raceRef.current = null; }; // unmount: stale loaders stop
  }, [loadSeason]);

  // Frame loop: advance the playhead, draw the map every frame, re-render panels at 4 Hz.
  useEffect(() => {
    let raf = 0, last = performance.now(), lastBoard = 0;
    const frame = (now: number) => {
      const R = raceRef.current;
      if (R) {
        const ready = chunkReady(R);
        if (R.playing && ready) R.t = Math.min(R.t1, R.t + (now - last) * R.speed);
        if (R.playing && R.t >= R.t1) R.playing = false;
        setStatus(!R.outline ? 'Loading track…' : !ready ? 'Buffering car positions…' : '');
        if (now - lastBoard > 250) { bump(); lastBoard = now; }
      }
      last = now;
      if (mapRef.current) drawMap(mapRef.current, R, prefsRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [bump]);

  const setPlaying = useCallback((on: boolean) => {
    const R = raceRef.current;
    if (!R) return;
    if (on && R.t >= R.t1) R.t = R.t0;
    R.playing = on;
    bump();
  }, [bump]);

  const seek = useCallback((t: number) => {
    const R = raceRef.current;
    if (!R) return;
    R.t = Math.min(R.t1, Math.max(R.t0, t));
    bump();
  }, [bump]);

  const stepSpeed = useCallback((by: number) => setPrefs((p) => {
    const i = Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(p.speed) + by));
    return { ...p, speed: SPEEDS[i] };
  }), []);

  return {
    race: raceRef.current, current, mapRef, bump, status, prefs, setPrefs, stepSpeed,
    year, loadSeason, raceKey, pickRace, options, pickOrder, setPlaying, seek,
  };
}
