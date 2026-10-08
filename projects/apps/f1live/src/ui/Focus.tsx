import type { ViewModel } from '../viewModel.ts';
import './Focus.css';

export function Focus({ vm }: { vm: ViewModel }) {
  const { focus, ahead, behind, ft } = vm;
  return (
    <section aria-labelledby="ob-focus" className="card focus">
      <div className="focus-head">
        <p className="mono-label focus-kicker">Following · click a tile or gap chip to change</p>
        <div className="focus-id">
          <span aria-hidden="true" className="focus-pos">{focus.posText}</span>
          <div className="focus-name">
            <h3 id="ob-focus" className="focus-last">{focus.last}</h3>
            <span className="focus-meta"><span className="swatch focus-swatch" style={{ background: focus.colour }} /><span>{focus.first}</span> · <span>{focus.team}</span> · <span>{focus.code}</span></span>
          </div>
        </div>
      </div>
      <div role="group" aria-label="Battle" className="focus-battle">
        <div className="focus-cell focus-cell-ahead">
          <span className="mono-label">Car ahead</span>
          {vm.hasAhead && <><div className="focus-nb"><span className="swatch focus-nb-swatch" style={{ background: ahead.colour }} /><span className="focus-nb-name">{ahead.last}</span></div><div className="focus-val">{ahead.val}</div></>}
          {vm.noAhead && <div className="focus-none">Clear air · leading</div>}
        </div>
        <div className="focus-cell focus-cell-leader">
          <span className="mono-label">To leader</span>
          <div className="focus-val focus-val-leader">{focus.gapText}</div>
        </div>
        <div className="focus-cell">
          <span className="mono-label">Car behind</span>
          {vm.hasBehind && <><div className="focus-nb"><span className="swatch focus-nb-swatch" style={{ background: behind.colour }} /><span className="focus-nb-name">{behind.last}</span></div><div className="focus-val">{behind.val}</div></>}
          {vm.noBehind && <div className="focus-none">Last car</div>}
        </div>
      </div>
      {vm.hasFocusTele && (
        <div className="focus-tele">
          <div className="focus-tele-box focus-tele-speed"><span className="mono-label">Speed · km/h</span><div className="focus-big focus-big-speed">{ft.speed}</div></div>
          <div className="focus-tele-box"><span className="mono-label">Gear</span><div className="focus-big">{ft.gear}</div></div>
          <div className="focus-meter"><span className="mono-label">Thr</span><span aria-label={`Throttle ${ft.throttle}%`} className="focus-meter-track"><span className="focus-meter-fill focus-meter-thr" style={{ height: `${ft.throttle}%` }} /></span></div>
          <div className="focus-meter"><span className="mono-label">Brk</span><span aria-label={`Brake ${ft.brake}%`} className="focus-meter-track"><span className="focus-meter-fill focus-meter-brk" style={{ height: `${ft.brake}%` }} /></span></div>
          <div className="focus-tele-foot"><span>{ft.wearText}</span><span style={{ color: ft.drsColor }}>{ft.drsText}</span></div>
        </div>
      )}
      {vm.noFocusTele && <p className="focus-notele">Live telemetry appears for the driver you follow.</p>}
      <div className="focus-foot">
        <span className="mono-label">Tyre</span>
        <span className="focus-tyre"><span title={focus.compound} className="tyre-dot focus-tyre-dot" style={{ borderColor: focus.tyreColor }}>{focus.tyre}</span><span>{focus.compound}</span> · <span>{focus.age}</span> laps on this set</span>
        <span className="mono-label">Stints</span>
        <span className="focus-stints">
          {vm.focusStints.map((b, i) => (
            <span key={i} title={`${b.compound} · laps ${b.from}–${b.to}`} className="focus-stint" style={{ left: `${b.left}%`, width: `${b.width}%`, background: b.bg }}>{b.tyre}</span>
          ))}
        </span>
        <span className="mono-label">Last lap</span>
        <span className="focus-lap">
          <span>{focus.lastLap}</span>
          {focus.sectors.map((c, i) => <span key={i} aria-label={c.aria} style={{ color: c.fg }}>{c.mark}{c.v}</span>)}
        </span>
      </div>
    </section>
  );
}
