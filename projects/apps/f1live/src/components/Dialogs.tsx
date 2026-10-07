import { useState } from 'react';
import type { RefObject } from 'react';
import { clearCache } from '../openf1.ts';
import { standingsNote, standingsRows } from '../race.ts';
import type { Kind, Race } from '../race.ts';

export function HelpDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  const [cleared, setCleared] = useState(false);
  return (
    <dialog ref={dialogRef} className="help" aria-labelledby="help-title">
      <h2 id="help-title">Keyboard shortcuts</h2>
      <dl>
        <dt>Space</dt><dd>Play / pause</dd>
        <dt>← →</dt><dd>Back / forward 10 s</dd>
        <dt>, .</dt><dd>Back / forward 1 s</dd>
        <dt>↑ ↓</dt><dd>Faster / slower</dd>
        <dt>R</dt><dd>Restart</dd>
        <dt>L</dt><dd>Driver names</dd>
        <dt>D</dt><dd>DRS zones</dd>
        <dt>B</dt><dd>Safety car / red flag bar</dd>
        <dt>C</dt><dd>Drivers' standings</dd>
        <dt>A</dt><dd>Constructors' standings</dd>
        <dt>H</dt><dd>This list</dd>
      </dl>
      <p className="help-note">Your speed, names, DRS and event-bar choices are remembered. Race data you've opened is saved in this browser so it reloads instantly.</p>
      <form method="dialog" className="help-actions">
        <button type="button" onClick={async () => { await clearCache(); setCleared(true); }}>
          {cleared ? 'Saved data cleared' : 'Clear saved data'}
        </button>
        <button>Close</button>
      </form>
    </dialog>
  );
}

type StandingsProps = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  race: Race | null;
  kind: Kind;
  onKind: (k: Kind) => void;
  message: string | null; // 'Loading…' or a load error while standings aren't in yet
};

// Championship before this session plus points for the running order at the playhead.
export function StandingsDialog({ dialogRef, race, kind, onKind, message }: StandingsProps) {
  const ready = race && !(race.isRace && !race.standings);
  return (
    <dialog ref={dialogRef} className="help" aria-labelledby="standings-title">
      <h2 id="standings-title">{ready ? (kind === 'drivers' ? "Drivers' championship" : "Constructors' championship") : 'Standings'}</h2>
      <div className="switch" role="group" aria-label="Championship">
        <button type="button" aria-pressed={kind === 'drivers'} onClick={() => onKind('drivers')}>Drivers</button>
        <button type="button" aria-pressed={kind === 'teams'} onClick={() => onKind('teams')}>Constructors</button>
      </div>
      <table className="sectors">
        <thead><tr><th scope="col">Pos</th><th scope="col">Name</th><th scope="col">Points</th><th scope="col">This session</th></tr></thead>
        <tbody>
          {ready && race.isRace && standingsRows(race, kind).map((r, i) => (
            <tr key={r.label + i}><td>{i + 1}</td><td>{r.label}</td><td>{r.total}</td><td>{r.gain ? `+${r.gain}` : ''}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="help-note">{ready ? standingsNote(race, kind) : message ?? ''}</p>
      <form method="dialog"><button>Close</button></form>
    </dialog>
  );
}
