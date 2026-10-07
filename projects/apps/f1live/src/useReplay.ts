// Replay engine as a hook: the loaded race lives in a ref (the frame loop mutates it 60×/s);
// React re-renders on a 4 Hz tick, the same cadence the original rebuilt its panels at.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, circuitRotation } from './openf1.ts';
import { toMs } from './replay.ts';
import { buildRace, chunkReady, order, sessionLabel, shortMeeting, SPEEDS } from './race.ts';
import type { Race, Row, Session } from './race.ts';
import { loadChunks, loadDrs } from './loaders.ts';
import { color, drawMap } from './drawMap.ts';
import type { Option } from './snapshot.ts';

const FIRST_SEASON = 2023; // OpenF1 history starts here
// Session names offered in the picker (testing days and anything else are left out).
const KINDS = ['Practice 1', 'Practice 2', 'Practice 3', 'Sprint Shootout', 'Sprint Qualifying', 'Qualifying', 'Sprint', 'Race'];
const PREFS = 'f1live.prefs';

export const thisYear = new Date().getFullYear();
export const YEARS = Array.from({ length: thisYear - FIRST_SEASON + 1 }, (_, i) => thisYear - i);

export type Prefs = { speed: number; names: boolean; drs: boolean; events: boolean };
type Meeting = { meeting_key: number; meeting_name: string };
const msg = (err: unknown) => (err as Error).message;

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
  const [sessionOptions, setSessionOptions] = useState<Option[]>([]); // flat session select: 'Italian GP · Race'
  const sessions = useRef<Session[]>([]); // finished sessions of the selected season
  const meetings = useRef(new Map<number, string>()); // meeting_key -> meeting_name, selected season
  // A failed load sets `error` (the feed-lost banner) and keeps the step that failed for retry().
  const [error, setError] = useState<string | null>(null);
  const again = useRef<(() => void) | null>(null);
  const fail = useCallback((message: string, retryStep: () => void) => {
    again.current = retryStep;
    setError(message);
    setStatus('');
  }, []);
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
    again.current = null;
    setError(null);
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
        color('--text-tertiary'), prefsRef.current.speed);
      raceRef.current = R;
      setPickOrder(order(R)); // running order at the start, as the original built its picker
      bump();
      const onChunkError = (m: string) => fail(m, () => loadChunks(R, current, onChunkError));
      loadChunks(R, current, onChunkError);
      loadDrs(R, current, session);
      circuitRotation(session.circuit_key, session.year).then((rot) => {
        if (rot != null && current() === R) R.rot = rot;
      });
    } catch (err) {
      if (id === loadId.current) fail(`Couldn't load this race (${msg(err)})`, () => loadRace(session));
    }
  }, [bump, current, fail]);

  // Returns false when the season has no finished sessions.
  const loadSeason = useCallback(async (y: number, pickKey?: number) => {
    setYear(y);
    setRaceKey('');
    setSessionOptions([]);
    const now = Date.now();
    // Meeting names only shorten the labels: if they fail, labels fall back to the location.
    const [all, named] = await Promise.all([api<Session>(`sessions?year=${y}`), api<Meeting>(`meetings?year=${y}`).catch(() => [])]);
    const list = all
      .filter((s) => KINDS.includes(s.session_name) && toMs(s.date_end) < now)
      .sort((a, b) => toMs(a.date_start) - toMs(b.date_start));
    sessions.current = list;
    meetings.current = new Map(named.map((m) => [m.meeting_key, m.meeting_name]));
    if (!list.length) { setSessionOptions([{ value: '', label: 'No finished sessions' }]); return false; }
    setSessionOptions(list.map((s) => ({ value: String(s.session_key), label: sessionLabel(meetings.current.get(s.meeting_key), s) })));
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

  // Season picked in the header; a failed season fetch is retried as a whole.
  const pickSeason = useCallback((y: number) => {
    setError(null);
    loadSeason(y).catch((err) => fail(`Couldn't reach OpenF1 (${msg(err)})`, () => pickSeason(y)));
  }, [loadSeason, fail]);

  // Boot: ?session= deep link, else the latest race of this season (or last season early on).
  const boot = useCallback(async () => {
    const key = new URLSearchParams(location.search).get('session');
    const id = loadId.current;
    try {
      const [s] = key ? await api<Session>(`sessions?session_key=${encodeURIComponent(key)}`) : [];
      const y = s ? s.year : thisYear;
      const found = await loadSeason(y, s?.session_key);
      // Early in a season there may be nothing finished yet — fall back a year.
      if (!found && y === thisYear) await loadSeason(thisYear - 1);
    } catch (err) {
      if (id === loadId.current) fail(`Couldn't reach OpenF1 (${msg(err)})`, boot); // not over a race the user already picked
    }
  }, [loadSeason, fail]);
  useEffect(() => {
    boot();
    return () => { loadId.current++; raceRef.current = null; }; // unmount: stale loaders stop
  }, [boot]);

  /** Re-run the step that failed and clear the error. */
  const retry = useCallback(() => {
    const step = again.current;
    again.current = null;
    setError(null);
    step?.();
  }, []);

  const meetingShort = useCallback((key: number) => {
    const name = meetings.current.get(key);
    return name ? shortMeeting(name) : '';
  }, []);

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
    year, pickSeason, raceKey, pickRace, sessions: sessionOptions, meetingShort, pickOrder, setPlaying, seek, error, retry,
  };
}
