import type { PointerEvent } from 'react';
import { formatClock } from '../replay.ts';
import { boardRows, lapLabel, rcItems, weatherText } from '../race.ts';
import type { BoardRow, Race } from '../race.ts';

function DriverRow({ row, pos }: { row: BoardRow; pos: number }) {
  return (
    <li data-driver={row.d} className={[row.out && 'out', row.selected && 'selected'].filter(Boolean).join(' ')}>
      <span className="pos">{pos}</span>
      <span className="team" style={{ background: row.colour }} />
      <span className="code">{row.code}</span>
      <span className="gap">{row.gap}</span>
      <span className="int">{row.int}</span>
      <span className={`tyre tyre-${row.compound.toLowerCase() || 'unknown'}`} title={row.hasStint ? row.compound : undefined}>{row.tyre}</span>
      <span className="age">{row.age}</span>
    </li>
  );
}

// Leaderboard, weather and race-control feed.
export function Tower({ race, onPick }: { race: Race | null; onPick: (d: number, add: boolean) => void }) {
  // Rows re-render every 250 ms, so use pointerdown (a click can straddle a re-render).
  const pointerDown = (e: PointerEvent<HTMLOListElement>) => {
    const li = (e.target as Element).closest<HTMLElement>('li[data-driver]');
    if (li) onPick(Number(li.dataset.driver), e.shiftKey);
  };
  return (
    <aside className="tower" aria-label="Leaderboard">
      <div className="tower-head">
        <span>{race ? lapLabel(race) : 'Lap –'}</span>
        <span>{formatClock(race ? race.t - race.t0 : 0)}</span>
      </div>
      <p className="weather">{race && weatherText(race)}</p>
      <ol className="board" onPointerDown={pointerDown}>
        {race && boardRows(race).map((row, i) => <DriverRow key={row.d} row={row} pos={i + 1} />)}
      </ol>
      <h2 className="rc-head">Race control</h2>
      <ol className="rc">
        {race && rcItems(race).map((r) => (
          <li key={r.key} data-flag={r.flag}><span className="rc-time">{r.time}</span>{` ${r.message}`}</li>
        ))}
      </ol>
    </aside>
  );
}
