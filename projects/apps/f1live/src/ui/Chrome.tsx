import type { Actions } from '../snapshot.ts';
import type { ViewModel } from '../viewModel.ts';
import './Chrome.css';

export function Header({ vm, actions }: { vm: ViewModel; actions: Actions }) {
  return (
    <header className="hd">
      <div className="wrap hd-in">
        <div className="hd-brand">
          <span aria-hidden="true" className="hd-logo"><span className="hd-logo-a" /><span className="hd-logo-b" /></span>
          <h1 className="hd-title">Race Replay</h1>
          <span className="mono-label hd-tag">{vm.sourceLabel}</span>
        </div>
        <div className="hd-pickers">
          <label className="mono-label hd-field">Season
            <select className="hd-select" value={vm.yearValue} onChange={(e) => actions.setYear(e.target.value)}>
              {vm.years.map((y) => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
          </label>
          <label className="mono-label hd-field">Session
            <select className="hd-select hd-select-session" value={vm.sessionValue} onChange={(e) => actions.setSession(e.target.value)}>
              {vm.sessions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <div className="hd-chip">
          <span aria-hidden="true" className="hd-chip-dot" style={{ background: vm.chipDot }} />
          <span>{vm.chipText}</span>
        </div>
      </div>
      <div aria-hidden="true" className="hd-progress" style={{ width: `${vm.progress}%` }} />
    </header>
  );
}

export function SessionBar({ vm }: { vm: ViewModel }) {
  return (
    <section aria-label="Session" className="sb">
      <div className="wrap sb-in">
        <div className="sb-hero">
          <span className="sb-hero-main">{vm.heroA} <span className="sb-hero-b">{vm.heroB}</span></span>
          <span className="mono-label">{vm.session.short} · {vm.session.circuit} · {vm.session.name}</span>
        </div>
        <div role="status" className="sb-status">
          <span aria-hidden="true" className="sb-lights">
            {vm.lights.map((l, i) => <span key={i} className="sb-light" style={{ background: l.bg }} />)}
          </span>
          <span className="mono-label sb-status-label" style={{ color: vm.statusColor }}>{vm.statusLabel}</span>
        </div>
        <span className="sb-clock">{vm.clock}</span>
        <span className="sb-weather">Air {vm.weather.air} · Track {vm.weather.track}</span>
        <div aria-live="polite" className="sb-rc" style={{ borderLeftColor: vm.rcMarker }}>
          <span className="mono-label">Race control {vm.rcTime} · {vm.rcChip}</span>
          <span className="sb-rc-latest">{vm.rcLatest}</span>
        </div>
      </div>
    </section>
  );
}

export function Banner({ vm, actions }: { vm: ViewModel; actions: Actions }) {
  return (
    <div role="alert" className="bn" style={{ background: vm.bannerBg, color: vm.bannerFg }}>
      <div className="wrap bn-in">
        <span aria-hidden="true" className="bn-bar" />
        <strong className="bn-title">{vm.banner.title}</strong>
        <span className="bn-detail">{vm.banner.detail}</span>
        {vm.stale && (
          <button type="button" className="btn-primary bn-btn" onClick={actions.retry}><span>Reconnect</span></button>
        )}
      </div>
    </div>
  );
}

export function NoSession({ vm, actions }: { vm: ViewModel; actions: Actions }) {
  const n = vm.nextSession;
  return (
    <main className="wrap ns">
      <div className="ns-col">
        <p className="mono-label ns-label">Between sessions</p>
        <h2 className="ns-title">No session running</h2>
        <p className="ns-next">Next: {n.title}, {n.name} · {n.when}</p>
        <button type="button" className="btn-primary ns-btn" onClick={actions.replayLast}><span>Replay last race</span></button>
      </div>
      <div className="ns-count">{n.countdown}</div>
    </main>
  );
}

export function Footer({ vm }: { vm: ViewModel }) {
  return (
    <footer className="ft">
      <div className="wrap ft-in">
        {vm.sourceLabel === 'Mock data'
          ? <p className="ft-text">Press H for shortcuts · OpenF1 data shape, mock values · Unofficial, not associated with Formula 1</p>
          : <p className="ft-text">Press H for shortcuts · Data from <a href="https://openf1.org">OpenF1</a> · Unofficial, not associated with Formula 1</p>}
      </div>
    </footer>
  );
}
