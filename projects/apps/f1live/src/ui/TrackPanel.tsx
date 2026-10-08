import type { RefObject } from 'react';
import type { Actions } from '../snapshot.ts';
import type { ViewModel } from '../viewModel.ts';
import './TrackPanel.css';

export function TrackPanel({ vm, actions, mapRef, onStandings, onHelp }: {
  vm: ViewModel; actions: Actions; mapRef: RefObject<HTMLCanvasElement | null>; onStandings: () => void; onHelp: () => void;
}) {
  const layers = [
    { label: 'Names', on: vm.labels, fg: vm.labelsFg, bar: vm.labelsBar, toggle: actions.toggleLabels },
    { label: 'DRS', on: vm.drs, fg: vm.drsFg, bar: vm.drsBar, toggle: actions.toggleDrs },
    { label: 'Events', on: vm.eventsOn, fg: vm.eventsFg, bar: vm.eventsBar, toggle: actions.toggleEvents },
  ];
  return (
    <>
      <section aria-label="Track map" className="tp-map">
        <div className="tp-map-head mono-label">
          <span>{vm.session.circuit}</span>
          <span className="tp-legend">
            <span className="tp-legend-drs">━ DRS</span>
            <span className="tp-legend-sc">■ SC</span>
            <span className="tp-legend-ring">○ Selected</span>
          </span>
        </div>
        <div className="tp-map-body">
          <canvas ref={mapRef} role="img" aria-label="Track map showing each car's position" className="tp-canvas" />
          {vm.mapNote !== '' && <p role="status" className="tp-loading mono-label">{vm.mapNote}</p>}
        </div>
      </section>
      <section aria-label="Playback" className="tp-bar">
        <button type="button" onClick={actions.togglePlay} aria-label={vm.playLabel} className="btn-primary tp-play">
          <span className="tp-play-text">{vm.playText}</span>
        </button>
        <div className="tp-scrub">
          <input type="range" min={0} max={vm.scrubMax} step={1} value={vm.scrubVal} onChange={(e) => actions.scrub(Number(e.target.value))} aria-label="Race time" className="tp-range" />
          {vm.eventsOn && (
            <div aria-hidden="true" className="tp-events">
              {vm.events.map((ev, i) => (
                <span key={i} title={ev.label} className="tp-event" style={{ left: `${ev.left}%`, width: `${ev.width}%`, background: ev.bg }} />
              ))}
            </div>
          )}
        </div>
        <select value={vm.speedValue} onChange={(e) => actions.setSpeed(Number(e.target.value))} aria-label="Playback speed" className="tp-speed">
          {vm.speeds.map((sp) => <option key={sp.value} value={sp.value}>{sp.label}</option>)}
        </select>
        <div role="group" aria-label="Map layers" className="tp-layers">
          {layers.map((l) => (
            <button key={l.label} type="button" onClick={l.toggle} aria-pressed={l.on} className="seg-btn" style={{ color: l.fg }}>
              {l.label}<span aria-hidden="true" className="seg-bar" style={{ background: l.bar }} />
            </button>
          ))}
        </div>
        <button type="button" onClick={onStandings} className="btn-ghost tp-standings"><span>Standings</span></button>
        <button type="button" onClick={onHelp} aria-label="Keyboard shortcuts" className="tp-help">?</button>
      </section>
    </>
  );
}
