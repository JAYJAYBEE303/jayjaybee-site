import type { CSSProperties, RefObject } from 'react';
import type { Actions } from '../snapshot.ts';
import type { LegendVm, ViewModel } from '../viewModel.ts';
import type { Series } from '../race.ts';
import { formatLap } from '../replay.ts';
import { LineChart } from './LineChart.tsx';
import './Analysis.css';

const Legend = ({ items }: { items: LegendVm[] }) => (
  <div className="an-legend">
    {items.map((lg) => (
      <span key={lg.d} className="an-legend-item">
        <span className="an-legend-line" style={{ borderTop: `2px ${lg.lineStyle} ${lg.colour}` }} />{lg.code}
      </span>
    ))}
  </div>
);

/** Fastest-lap y domains: speed widens [60, 360] to fit the data; the rest are fixed. */
const speedDomain = (ss: Series[]): [number, number] => {
  const ys = ss.flatMap((x) => x.points.map((p) => p.y));
  return [Math.min(60, ...ys), Math.max(360, ...ys)];
};
const MINIS = [
  ['Speed · km/h', "Speed over each driver's fastest lap", 'speed', speedDomain],
  ['Throttle · %', "Throttle over each driver's fastest lap", 'throttle', () => [0, 100]],
  ['Brake', "Brake over each driver's fastest lap", 'brake', () => [0, 100]],
  ['Gear', "Gear over each driver's fastest lap", 'gear', () => [1, 8]],
] as const satisfies readonly (readonly [string, string, 'speed' | 'throttle' | 'brake' | 'gear', (ss: Series[]) => [number, number]])[];

const panel = (id: string) => ({ role: 'tabpanel', id: `panel-${id}`, 'aria-labelledby': `tab-${id}` }) as const;

// tipRef is the shared chart tooltip owned by Page.
export function Analysis({ vm, actions, tipRef }: { vm: ViewModel; actions: Actions; tipRef: RefObject<HTMLDivElement | null> }) {
  return (
    <section aria-labelledby="hl-ins" className="an">
      <div className="an-head">
        <div><h3 id="hl-ins" className="section-title">Analysis</h3></div>
        <div role="tablist" aria-label="Insight views" className="an-tabs">
          {vm.tabs.map((tb) => (
            <button key={tb.id} type="button" role="tab" id={`tab-${tb.id}`} aria-controls={`panel-${tb.id}`} aria-selected={tb.selected}
              onClick={() => actions.setTab(tb.id)} className="seg-btn an-tab"
              style={{ background: tb.bg, '--an-tab-fg': tb.color } as CSSProperties}>
              {tb.label}<span aria-hidden="true" className="seg-bar" style={{ background: tb.bar }} />
            </button>
          ))}
        </div>
      </div>
      <fieldset className="an-picker">
        <legend className="mono-label an-picker-legend">Drivers</legend>
        {vm.picker.map((p) => (
          <button key={p.d} type="button" onClick={() => actions.toggleDriver(p.d)} aria-pressed={p.selected} className="an-pick"
            style={{ background: p.bg, borderColor: p.border, color: p.fg }}>
            <span className="an-pick-swatch" style={{ background: p.colour }} />{p.code}
          </button>
        ))}
      </fieldset>

      <div {...panel('telemetry')} aria-label="Telemetry" hidden={vm.panelHidden.telemetry}>
        {vm.telemetryEmpty && <p className="an-empty">No driver selected. Pick one on the timing board or under Drivers.</p>}
        <ul className="an-tele-list">
          {vm.telemetry.map((tm) => (
            <li key={tm.d} className="card an-tele">
              <div className="an-tele-head"><span className="an-tele-swatch" style={{ background: tm.colour }} /><span className="an-tele-name" title={tm.name}>{tm.name}</span></div>
              <div className="an-tele-top">
                <div className="an-tele-speed"><span className="mono-label">Speed</span><div className="an-tele-row"><span className="an-tele-big">{tm.speed}</span><span className="an-tele-unit">km/h</span></div></div>
                <div className="an-tele-gear"><span className="mono-label">Gear</span><div className="an-tele-big">{tm.gear}</div></div>
              </div>
              <div className="an-bars">
                <span className="an-bar-label">Throttle</span><span className="an-bar-track"><span className="an-bar-fill an-bar-throttle" style={{ width: `${tm.throttle}%` }} /></span><span className="an-bar-val">{tm.throttle}</span>
                <span className="an-bar-label">Brake</span><span className="an-bar-track"><span className="an-bar-fill an-bar-brake" style={{ width: `${tm.brake}%` }} /></span><span className="an-bar-val">{tm.brake}</span>
                <span className="an-bar-label">Wear</span><span className="an-bar-track"><span className="an-bar-fill an-bar-wear" style={{ width: `${tm.wearPct}%` }} /></span><span className="an-bar-val">{tm.tyre}{tm.age}</span>
              </div>
              <div className="an-tele-foot"><span>{tm.wearText}</span><span className="an-drs" style={{ color: tm.drsColor, borderColor: tm.drsBorder }}>DRS {tm.drsText}</span></div>
            </li>
          ))}
        </ul>
      </div>

      <div {...panel('laps')} aria-label="Lap times" hidden={vm.panelHidden.laps} className="card an-chart">
        <Legend items={vm.legend} />
        <LineChart series={vm.charts.laps} tipRef={tipRef} yDomain={vm.charts.lapsY ?? undefined} yFmt={formatLap}
          label="Lap times by lap for the chosen drivers" className="an-canvas an-canvas-laps" />
      </div>

      <div {...panel('positions')} aria-label="Positions" hidden={vm.panelHidden.positions} className="card an-chart">
        <LineChart series={vm.charts.positions} tipRef={tipRef} invert yDomain={[1, vm.charts.posMax]} yFmt={(y) => `P${Math.round(y)}`}
          label="Race position by lap for every driver" className="an-canvas an-canvas-pos" />
      </div>

      <div {...panel('sectors')} aria-label="Sectors" hidden={vm.panelHidden.sectors} className="an-sectors">
        <table className="an-table">
          <thead><tr className="an-thead-row">
            <th scope="col" className="an-th-first">Pos</th><th scope="col" className="an-th">Driver</th>
            <th scope="col" className="an-th an-th-r">Lap</th><th scope="col" className="an-th an-th-r">S1</th>
            <th scope="col" className="an-th an-th-r">S2</th><th scope="col" className="an-th an-th-r">S3</th>
            <th scope="col" className="an-th-last">Time</th>
          </tr></thead>
          <tbody>
            {vm.sectors.map((sr) => (
              <tr key={sr.d} className="an-tr">
                <td className="an-td-pos">{sr.pos}</td>
                <td className="an-td"><span className="an-sw" style={{ background: sr.colour }} /><span className="an-code">{sr.code}</span></td>
                <td className="an-td-lap">{sr.lap}</td>
                {sr.s.map((c, i) => <td key={i} aria-label={c.aria} className="an-td-sec" style={{ color: c.fg }}>{c.mark}{c.v}</td>)}
                <td className="an-td-time">{sr.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="an-note">◆ purple overall best · ● green personal best · plain yellow slower</p>
      </div>

      <div {...panel('tyres')} aria-label="Tyres" hidden={vm.panelHidden.tyres}>
        <ol className="an-tyres">
          {vm.tyres.map((ty) => (
            <li key={ty.d} className="an-tyre-row">
              <span className="an-tyre-code">{ty.code}</span>
              <span className="an-tyre-track">
                {ty.bars.map((b, i) => (
                  <span key={i} className="an-stint" title={`${b.compound} · laps ${b.from}–${b.to}`}
                    style={{ left: `${b.left}%`, width: `${b.width}%`, background: b.bg }}><span>{b.tyre}</span> · <span>{b.laps}</span></span>
                ))}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div {...panel('fastest')} aria-label="Fastest lap" hidden={vm.panelHidden.fastest} className="an-fastest">
        <Legend items={vm.legend2} />
        {MINIS.map(([title, label, key, domain]) => (
          <div key={title} className="card an-mini">
            <h4 className="mono-label an-mini-title">{title}</h4>
            <LineChart series={vm.charts.fastest[key]} tipRef={tipRef} discrete={false} yDomain={domain(vm.charts.fastest[key])}
              xFmt={(x) => `${Math.round(x)}%`} empty="No fastest lap yet" label={label} className="an-canvas an-canvas-mini" />
          </div>
        ))}
      </div>
    </section>
  );
}
