import type { CSSProperties } from 'react';
import { SPEEDS } from '../race.ts';
import type { Race } from '../race.ts';
import type { Prefs } from '../useReplay.ts';

type Props = {
  race: Race | null;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  setPlaying: (on: boolean) => void;
  seek: (t: number) => void;
  onStandings: () => void;
  onHelp: () => void;
};

// Play/pause, scrubber with the SC / VSC / red-flag bar, speed, layer toggles, dialogs.
export function Transport({ race, prefs, setPrefs, setPlaying, seek, onStandings, onHelp }: Props) {
  const max = race ? Math.round((race.t1 - race.t0) / 1000) : 0;
  const value = race ? Math.round((race.t - race.t0) / 1000) : 0;
  const span = race ? race.t1 - race.t0 || 1 : 1;
  return (
    <footer className="controls">
      <button type="button" aria-label={race?.playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!race?.playing)}>
        {race?.playing ? '❚❚' : '▶'}
      </button>
      <div className="scrub">
        <input
          type="range" min="0" max={max} step="1" value={value} aria-label="Race time"
          // --fill drives the WebKit track gradient.
          style={{ '--fill': `${(value / (max || 1)) * 100}%` } as CSSProperties}
          onChange={(e) => race && seek(race.t0 + Number(e.target.value) * 1000)}
        />
        <div className="events" aria-hidden="true" hidden={!prefs.events}>
          {race && Object.entries(race.periods).flatMap(([kind, list]) => list.map((p) => {
            const start = Math.max(p.start, race.t0), end = Math.min(p.end, race.t1);
            return (
              <div
                key={`${kind}${p.start}`} data-status={kind} title={kind.toUpperCase()}
                style={{ left: `${((start - race.t0) / span) * 100}%`, width: `${(Math.max(0, end - start) / span) * 100}%` }}
              />
            );
          }))}
        </div>
      </div>
      <select aria-label="Playback speed" value={prefs.speed} onChange={(e) => setPrefs({ ...prefs, speed: Number(e.target.value) })}>
        {SPEEDS.map((s) => <option key={s} value={s}>{`${s}×`}</option>)}
      </select>
      <label className="toggle">
        <input type="checkbox" checked={prefs.names} onChange={(e) => setPrefs({ ...prefs, names: e.target.checked })} /> Names
      </label>
      <label className="toggle">
        <input type="checkbox" checked={prefs.drs} onChange={(e) => setPrefs({ ...prefs, drs: e.target.checked })} /> DRS
      </label>
      <button type="button" onClick={onStandings}>Standings</button>
      <button type="button" aria-label="Keyboard shortcuts" onClick={onHelp}>?</button>
    </footer>
  );
}
