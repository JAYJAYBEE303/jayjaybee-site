import type { CSSProperties } from 'react';
import type { Actions } from '../snapshot.ts';
import type { ViewModel } from '../viewModel.ts';
import './Timing.css';

export function Timing({ vm, actions }: { vm: ViewModel; actions: Actions }) {
  return (
    <>
      <section aria-labelledby="tf-gaps">
        <div className="tm-head">
          <div><h3 id="tf-gaps" className="section-title">Gaps on the road</h3></div>
          <span className="tm-note tm-note-52">{vm.spreadNote}</span>
        </div>
        <div className="tm-ribbon">
          {vm.ribbonTicks.map((tk, i) => (
            <span key={i} aria-hidden="true" className="tm-tick" style={{ left: `${tk.left}%` }}>
              <span className="tm-tick-label">{tk.label}</span>
            </span>
          ))}
          {vm.ribbon.map((r) => (
            <button
              key={r.d}
              type="button"
              className="tm-chip"
              onClick={(e) => actions.select(r.d, e.shiftKey || e.metaKey)}
              aria-pressed={r.selected}
              aria-label={r.aria}
              style={{ top: `${r.top}px`, left: `${r.left}%`, transition: vm.ribbonMotion, opacity: r.op, background: r.chipBg, color: r.chipFg }}
            >
              <span className="swatch tm-chip-sw" style={{ background: r.colour }} />
              {r.code}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="gb-title" className="tm-tiles-sec">
        <div className="tm-head tm-head-tiles">
          <div><h3 id="gb-title" className="section-title">{vm.towerTitle}</h3></div>
          <span className="tm-note tm-note-46">Tiles sort by position · red top rule = selected · amber top rule = just changed place · sector marks ◆ overall ● personal – slower</span>
        </div>
        {vm.loading && (
          <div aria-label="Loading timing" className="tm-grid">
            {vm.skeleton.map((k) => <div key={k.k} className="tm-skel" />)}
          </div>
        )}
        {vm.ready && (
          <ol className="tm-grid tm-list">
            {vm.tiles.map((r) => (
              <li key={r.d} style={{ order: r.pos, opacity: r.opacity }}>
                <button
                  type="button"
                  className="tm-tile"
                  onClick={(e) => actions.select(r.d, e.shiftKey || e.metaKey)}
                  aria-pressed={r.selected}
                  aria-label={r.aria}
                  style={{ '--tm-bg': r.bg, borderTopColor: r.edge } as CSSProperties}
                >
                  <span className="tm-tile-top">
                    <span aria-hidden="true" className="tm-pos">{r.pos}</span>
                    <span className="tm-age">
                      {r.age}
                      <span title={r.compound} className="tyre-dot tm-tyre" style={{ borderColor: r.tyreColor }}>{r.tyre}</span>
                    </span>
                  </span>
                  <span className="tm-name">
                    <span className="swatch" style={{ background: r.colour }} />
                    <span className="tm-last">{r.last}</span>
                    {r.fastest && <span title="Fastest lap" className="tm-fl">FL</span>}
                  </span>
                  <span className="tm-gaps">
                    <span className="tm-gap">{r.gapText}</span>
                    <span className="tm-int" style={{ color: r.intColor }}>{r.intShow}</span>
                  </span>
                  <span aria-hidden="true" className="tm-sectors">
                    {r.sectors.map((c, i) => <span key={i} className="tm-sector" style={{ background: c.bar }} />)}
                  </span>
                  <span className="tm-foot"><span>{r.lastLap}</span><span>{r.secMarks}</span></span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="tm-rc-wrap">
        <section aria-labelledby="hl-rc" className="tm-rc">
          <div className="tm-rc-head">
            <h3 id="hl-rc" className="section-title tm-rc-title">Race control</h3>
            <span className="tm-note">{vm.rcCount} messages</span>
          </div>
          <ol aria-live="polite" className="tm-rc-list">
            {vm.rcAll.map((m) => (
              <li key={m.n} className="tm-rc-item">
                <span aria-hidden="true" className="tm-rc-marker" style={{ background: m.marker }} />
                <span className="tm-rc-time">{m.time}</span>
                <span className="tm-rc-chip" style={{ color: m.markerText }}>{m.chip}</span>
                <span className="tm-rc-msg">{m.message}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
