import { YEARS } from '../useReplay.ts';
import type { RaceOptions } from '../useReplay.ts';

type Props = {
  year: number;
  onYear: (y: number) => void;
  raceKey: string;
  onRace: (key: string) => void;
  options: RaceOptions;
};

export function SessionPicker({ year, onYear, raceKey, onRace, options }: Props) {
  return (
    <header className="bar">
      <h1>F1 Race Replay</h1>
      <label>Season <select value={year} onChange={(e) => onYear(Number(e.target.value))}>
        {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
      </select></label>
      <label className="grow">Race <select value={raceKey} onChange={(e) => onRace(e.target.value)}>
        {'note' in options
          ? (options.note && <option value="">{options.note}</option>)
          : options.groups.map((g) => (
            <optgroup key={g.label + g.sessions[0].session_key} label={g.label}>
              {g.sessions.map((s) => <option key={s.session_key} value={s.session_key}>{s.session_name}</option>)}
            </optgroup>
          ))}
      </select></label>
    </header>
  );
}
