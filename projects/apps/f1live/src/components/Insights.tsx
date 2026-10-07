import { useEffect } from 'react';
import type { RefObject } from 'react';
import { formatLap, lapsDone, lastAt, sectorBests, stintBars, tyreAge, tyreWear } from '../replay.ts';
import { driverLap, lapsYDomain, order, seriesFor, stintOf } from '../race.ts';
import type { Race, Series } from '../race.ts';
import { carSample, fastestTrace, requestCarData, requestTrace } from '../loaders.ts';
import { LineChart } from './LineChart.tsx';

export type Tab = 'telemetry' | 'laps' | 'positions' | 'sectors' | 'tyres' | 'fastest';
const TABS: [Tab, string][] = [
  ['telemetry', 'Telemetry'], ['laps', 'Lap times'], ['positions', 'Positions'],
  ['sectors', 'Sectors'], ['tyres', 'Tyres'], ['fastest', 'Fastest lap'],
];
const WEAR_FULL_S = 2; // time lost vs new tyres at which the bar is full / red

type Ctx = { race: Race; current: () => Race | null; tipRef: RefObject<HTMLDivElement | null> };
type Props = Omit<Ctx, 'race'> & {
  race: Race | null;
  pickOrder: number[];
  onToggle: (d: number, on: boolean) => void;
  tab: Tab;
  onTab: (t: Tab) => void;
};

// Driver picker plus the insight tabs; every panel shows only what has happened by the playhead.
export function Insights({ race, current, tipRef, pickOrder, onToggle, tab, onTab }: Props) {
  const ctx = race && { race, current, tipRef };
  return (
    <section className="insights" aria-label="Insights">
      <fieldset className="picker">
        <legend>Drivers</legend>
        <div className="picker-list">
          {race && pickOrder.map((d) => {
            const car = race.drivers.get(d)!;
            return (
              <label key={d}>
                <input type="checkbox" value={d} checked={race.selected.has(d)} onChange={(e) => onToggle(d, e.target.checked)} />
                <span className="swatch" style={{ background: car.colour }} />{car.code}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="tabs" role="tablist" aria-label="Insight views">
        {TABS.map(([id, text]) => (
          <button
            key={id} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`}
            hidden={id === 'positions' && !!race && !race.isRace} onClick={() => onTab(id)}
          >{text}</button>
        ))}
      </div>
      <div id="panel-telemetry" className="panel" role="tabpanel" hidden={tab !== 'telemetry'}>
        <ul className="telemetry">{ctx && tab === 'telemetry' && <Telemetry {...ctx} />}</ul>
      </div>
      <div id="panel-laps" className="panel" role="tabpanel" hidden={tab !== 'laps'}>
        {ctx && tab === 'laps' && <Laps {...ctx} />}
      </div>
      <div id="panel-positions" className="panel" role="tabpanel" hidden={tab !== 'positions'}>
        {ctx && tab === 'positions' && <Positions {...ctx} />}
      </div>
      <div id="panel-sectors" className="panel" role="tabpanel" hidden={tab !== 'sectors'}>
        <table className="sectors">
          <thead><tr><th scope="col">Pos</th><th scope="col">Driver</th><th scope="col">Lap</th><th scope="col">S1</th><th scope="col">S2</th><th scope="col">S3</th><th scope="col">Time</th></tr></thead>
          <tbody>{ctx && tab === 'sectors' && <Sectors {...ctx} />}</tbody>
        </table>
      </div>
      <div id="panel-tyres" className="panel" role="tabpanel" hidden={tab !== 'tyres'}>
        <ol className="stints">{ctx && tab === 'tyres' && <Tyres {...ctx} />}</ol>
      </div>
      <div id="panel-fastest" className="panel" role="tabpanel" hidden={tab !== 'fastest'}>
        {ctx && tab === 'fastest' && <Fastest {...ctx} />}
      </div>
    </section>
  );
}

function Meter({ cls, value, title, wear }: { cls: string; value?: number; title?: string; wear?: boolean }) {
  const pct = Math.min(100, Math.max(0, value ?? 0));
  return (
    <span className={`bar-track ${cls}`} title={title ?? `${cls} ${Math.round(pct)}%`}>
      <span className="bar-fill" style={{ width: `${pct}%`, ...(wear && { '--wear': `${pct}%` }) }} />
    </span>
  );
}

// Measured tyre wear on the current stint (port of the original's degradation model, option B).
function Wear({ race, d }: { race: Race; d: number }) {
  const lap = driverLap(race, d), stint = stintOf(race, d, lap);
  const wear = stint && tyreWear(race.laps.get(d), stint, race.t);
  if (!stint || !wear) return <><span className="wear">Wear: after 3 laps</span><span className="" /></>;
  const loss = Math.max(0, wear.rate) * tyreAge(stint, lap);
  const pct = Math.min(100, (loss / WEAR_FULL_S) * 100);
  const sign = wear.rate >= 0 ? '+' : '';
  return (
    <>
      <span className="wear">{`Wear ${sign}${wear.rate.toFixed(2)} s/lap · ~${loss.toFixed(1)} s lost`}</span>
      <Meter cls="wear" value={pct} wear title={`${loss.toFixed(1)} s lost vs new tyres (${wear.n} laps measured)`} />
    </>
  );
}

function Telemetry({ race, current }: Ctx) {
  const ids = [...race.selected];
  useEffect(() => { for (const d of ids) requestCarData(race, current, d); });
  return ids.map((d) => {
    const car = race.drivers.get(d)!, c = carSample(race, d);
    return (
      <li key={d}>
        <span className="swatch" style={{ background: car.colour }} />
        <span className="code">{car.code}</span>
        <span className="speed">{c ? `${c.speed} km/h` : '…'}</span>
        <span className="gear">{c ? `G${c.n_gear}` : ''}</span>
        <Meter cls="throttle" value={c?.throttle} />
        <Meter cls="brake" value={c?.brake} />
        <span className={`drs-badge${(c?.drs ?? 0) >= 10 ? ' on' : ''}`}>DRS</span>
        <Wear race={race} d={d} />
      </li>
    );
  });
}

function Legend({ series, text = (s) => s.label }: { series: Series[]; text?: (s: Series, i: number) => string }) {
  return (
    <div className="legend">
      {series.map((s, i) => (
        <span key={i} className=""><i className={s.dashed ? 'dashed' : ''} style={{ borderColor: s.colour }} />{text(s, i)}</span>
      ))}
    </div>
  );
}

function Laps({ race, tipRef }: Ctx) {
  const ids = race.selected.size ? [...race.selected] : order(race).slice(0, 3);
  const series = seriesFor(race, ids, (d) => lapsDone(race.laps.get(d), race.t).map((l) => ({ x: l.lap_number, y: l.lap_duration })))
    .map((s) => ({ ...s, dim: false }));
  return (
    <>
      <Legend series={series} />
      <LineChart series={series} tipRef={tipRef} yDomain={lapsYDomain(series)} yFmt={formatLap} label="Lap times by lap for the chosen drivers" />
    </>
  );
}

function Positions({ race, tipRef }: Ctx) {
  const series = seriesFor(race, order(race), (d) => lapsDone(race.laps.get(d), race.t)
    .map((l) => ({ x: l.lap_number, y: lastAt(race.pos.get(d), l.t + l.lap_duration * 1000)?.position }))
    .filter((p): p is { x: number; y: number } => !!p.y));
  return (
    <LineChart
      series={series} tipRef={tipRef} invert yDomain={[1, race.drivers.size]} yFmt={(v) => `P${Math.round(v)}`}
      label="Race position by lap for every driver"
    />
  );
}

function Sectors({ race }: Ctx) {
  const { overall, personal } = sectorBests(race.laps, race.t);
  return order(race).map((d, i) => {
    const last = lapsDone(race.laps.get(d), race.t).at(-1);
    const secs = [last?.duration_sector_1, last?.duration_sector_2, last?.duration_sector_3];
    return (
      <tr key={d}>
        <td className="">{i + 1}</td>
        <td className="">{race.drivers.get(d)!.code}</td>
        <td className="">{last?.lap_number ?? ''}</td>
        {secs.map((s, k) => (
          <td key={k} className={!s ? '' : s <= overall[k] ? 'ob' : s <= personal.get(d)![k] ? 'pb' : ''}>{s ? s.toFixed(3) : ''}</td>
        ))}
        <td className="">{last ? formatLap(last.lap_duration) : ''}</td>
      </tr>
    );
  });
}

function Tyres({ race }: Ctx) {
  const total = race.totalLaps || 1;
  return order(race).map((d) => (
    <li key={d}>
      <span className="code">{race.drivers.get(d)!.code}</span>
      <span className="stint-track">
        {stintBars(race.stints.get(d), driverLap(race, d)).map((b) => (
          <span
            key={b.from} className={`tyre-${b.compound.toLowerCase() || 'unknown'}`}
            style={{ left: `${((b.from - 1) / total) * 100}%`, width: `${((b.to - b.from + 1) / total) * 100}%` }}
            title={`${b.compound || 'Unknown'} · laps ${b.from}–${b.to}`}
          >{b.compound[0] ?? ''}</span>
        ))}
      </span>
    </li>
  ));
}

// Port of the qualifying screen's telemetry: speed / throttle / brake / gear over lap distance.
function Fastest({ race, current, tipRef }: Ctx) {
  const ids = race.selected.size ? [...race.selected] : order(race).slice(0, 2);
  useEffect(() => { for (const d of ids) requestTrace(race, current, d); });
  const traces = ids.map((d) => fastestTrace(race, d));
  const base = seriesFor(race, ids, () => []).map((s) => ({ ...s, dim: false }));
  const chart = (key: 'speed' | 'throttle' | 'brake' | 'gear', label: string, opts: object) => (
    <LineChart
      className="chart mini" tipRef={tipRef} label={label} xFmt={(x) => `${Math.round(x)}% of lap`} discrete={false} {...opts}
      series={base.map((s, i) => ({ ...s, points: traces[i].points.map((p) => ({ x: p.x, y: p[key] as number })) }))}
    />
  );
  return (
    <>
      <Legend series={base} text={(s, i) => {
        const lap = traces[i].lap;
        return lap ? `${s.label} ${formatLap(lap.lap_duration, 3)} (lap ${lap.lap_number})` : `${s.label} –`;
      }} />
      <h3 className="mini-title">Speed (km/h)</h3>
      {chart('speed', "Speed over each driver's fastest lap", { yFmt: (v: number) => `${Math.round(v)}` })}
      <h3 className="mini-title">Throttle</h3>
      {chart('throttle', "Throttle over each driver's fastest lap", { yDomain: [0, 100], yFmt: (v: number) => `${Math.round(v)}%` })}
      <h3 className="mini-title">Brake</h3>
      {chart('brake', "Brake over each driver's fastest lap", { yDomain: [0, 100], yFmt: (v: number) => `${Math.round(v)}%` })}
      <h3 className="mini-title">Gear</h3>
      {chart('gear', "Gear over each driver's fastest lap", { yDomain: [0, 8], yFmt: (v: number) => `G${Math.round(v)}` })}
    </>
  );
}
