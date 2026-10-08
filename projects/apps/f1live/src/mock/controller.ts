// Dev-only mock controller: the reference controller() state machine without DOM, keys or timers (hooks own those).
import { SPEEDS } from '../race.ts';
import type { Actions, Snapshot } from '../snapshot.ts';
import { LS, T1, VSC_START, mockSnapshot, newMockState } from './data.ts';
import type { MockState } from './data.ts';

export function createMockController(opts: { selected?: number[]; onTick: (s: Snapshot) => void }) {
  const rp = newMockState(opts.selected ?? [4, 81]);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const emit = () => opts.onTick(mockSnapshot(rp));
  const update = (f: () => void) => () => { f(); emit(); };

  function setScenario(s: string) {
    Object.assign(rp, { scenario: s, forcedRed: false, feedLost: false, loading: false, noSession: false, quali: false, playing: true } satisfies Partial<MockState>);
    if (s === 'safety-car') rp.t = LS(19) + 20;
    else if (s === 'vsc') rp.t = VSC_START + 15;
    else if (s === 'red-flag') { rp.t = LS(28) + 10; rp.forcedRed = true; rp.playing = false; }
    else if (s === 'feed-dropped') { rp.t = LS(26) + 30; rp.feedLost = true; rp.playing = false; }
    else if (s === 'retirements') rp.t = LS(33);
    else if (s === 'chequered') { rp.t = T1 - 2; rp.playing = false; }
    else if (s === 'loading') { rp.loading = true; rp.playing = false; }
    else if (s === 'no-session') { rp.noSession = true; rp.playing = false; }
    else if (s === 'qualifying') { rp.quali = true; rp.t = LS(14); }
    else rp.t = LS(16) + 40;
    rp.prevPos.clear(); rp.changedAt.clear();
    emit();
  }

  const frozen = () => rp.loading || rp.noSession || rp.feedLost || rp.forcedRed;
  /** Advance the playhead by dtSec of wall time (the caller clamps and throttles) and publish a snapshot. */
  function tick(dtSec: number) {
    if (rp.playing && !frozen()) { rp.t = Math.min(T1, rp.t + dtSec * SPEEDS[rp.speedIdx]); if (rp.t >= T1) rp.playing = false; }
    emit();
  }

  const select = (d: number, add: boolean) => {
    if (add) { if (rp.selected.has(d)) rp.selected.delete(d); else rp.selected.add(d); } else rp.selected = new Set([d]);
    emit();
  };
  const fakeLoad = (then: () => void) => {
    rp.loading = true; emit();
    const h = setTimeout(() => { timers.delete(h); rp.loading = false; then(); emit(); }, 900);
    timers.add(h);
  };
  const speed = (i: number) => Math.max(0, Math.min(SPEEDS.length - 1, i));

  const actions: Actions = {
    togglePlay: update(() => { if (rp.t >= T1) rp.t = 0; rp.playing = !rp.playing; }),
    seekBy: (sec) => update(() => { rp.t = Math.max(0, Math.min(T1, rp.t + sec)); })(),
    restart: update(() => { rp.t = 0; }),
    scrub: (sec) => update(() => { rp.t = sec; })(),
    setSpeed: (idx) => update(() => { rp.speedIdx = speed(idx); })(),
    stepSpeed: (by) => update(() => { rp.speedIdx = speed(rp.speedIdx + by); })(),
    toggleLabels: update(() => { rp.labels = !rp.labels; }),
    toggleDrs: update(() => { rp.drs = !rp.drs; }),
    toggleEvents: update(() => { rp.events = !rp.events; }),
    select,
    toggleDriver: (d) => select(d, true),
    setTab: (t) => update(() => { rp.tab = t; })(),
    showStandings: (k) => update(() => { rp.standKind = k; })(),
    setYear: () => fakeLoad(() => {}),
    setSession: (v) => fakeLoad(() => { rp.quali = v.includes('Qualifying'); if (rp.quali && rp.tab === 'positions') rp.tab = 'telemetry'; }),
    retry: () => fakeLoad(() => { rp.feedLost = false; rp.playing = true; }),
    replayLast: () => fakeLoad(() => { rp.noSession = false; rp.t = LS(16); rp.playing = true; }),
    clearCache: () => Promise.resolve(),
  };

  return {
    state: rp, setScenario, tick, actions,
    /** Cancel a pending fake load. */
    dispose() { timers.forEach(clearTimeout); timers.clear(); },
  };
}
