import { useState } from 'react';
import type { RefObject } from 'react';
import type { Actions } from '../snapshot.ts';
import type { ViewModel } from '../viewModel.ts';
import './Dialogs.css';

interface DialogProps { vm: ViewModel; actions: Actions; dialogRef: RefObject<HTMLDialogElement | null>; onClose: () => void }

export function HelpDialog({ vm, actions, dialogRef, onClose }: DialogProps) {
  const [forgotten, setForgotten] = useState(false);
  const forget = async () => { await actions.clearCache(); setForgotten(true); };
  return (
    <dialog ref={dialogRef} aria-labelledby="hl-help-title" className="dlg dlg-help">
      <h2 id="hl-help-title" className="section-title dlg-title-help">Keyboard shortcuts</h2>
      <dl className="dlg-list">
        {vm.shortcuts.map((sc) => (
          <div key={sc.k} className="dlg-key-row"><dt className="dlg-key">{sc.k}</dt><dd className="dlg-key-desc">{sc.v}</dd></div>
        ))}
      </dl>
      <p className="dlg-help-note">Speed, names, DRS and event-bar choices are remembered. Opened races reload instantly from this browser.</p>
      <div className="dlg-actions dlg-actions-help">
        <button type="button" onClick={() => { void forget(); }} className="btn-ghost dlg-btn dlg-btn-forget">{forgotten ? 'Saved races forgotten' : 'Forget saved races'}</button>
        <button type="button" onClick={onClose} className="btn-primary dlg-btn dlg-btn-close">Close</button>
      </div>
    </dialog>
  );
}

export function StandingsDialog({ vm, actions, dialogRef, onClose }: DialogProps) {
  return (
    <dialog ref={dialogRef} aria-labelledby="hl-st-title" className="dlg dlg-standings">
      <div className="dlg-head">
        <div>
          <p className="mono-label dlg-eyebrow">Live championship</p>
          <h2 id="hl-st-title" className="section-title">Standings</h2>
        </div>
        <div role="group" aria-label="Championship" className="dlg-seg">
          <button type="button" onClick={() => actions.showStandings('drivers')} aria-pressed={vm.isDrivers} className="seg-btn dlg-seg-btn" style={{ background: vm.drvBg, color: vm.drvFg }}>Drivers<span aria-hidden="true" className="seg-bar" style={{ background: vm.drvBar }} /></button>
          <button type="button" onClick={() => actions.showStandings('teams')} aria-pressed={vm.isTeams} className="seg-btn dlg-seg-btn" style={{ background: vm.teamBg, color: vm.teamFg }}>Constructors<span aria-hidden="true" className="seg-bar" style={{ background: vm.teamBar }} /></button>
        </div>
      </div>
      <div className="dlg-scroll">
        {vm.standings.map((st, i) => (
          <div key={`${st.label}-${i}`} className="dlg-st-row">
            <span className="dlg-st-pos">{st.pos}</span>
            <span className="dlg-st-name"><span className="swatch" style={{ background: st.colour }} /><span className="dlg-st-label" title={st.label}>{st.label}</span></span>
            <span className="dlg-st-gain">{st.gainLabel}</span>
            <span className="dlg-st-total">{st.total}</span>
          </div>
        ))}
      </div>
      <p className="dlg-st-note">{vm.standNote}</p>
      <div className="dlg-actions"><button type="button" onClick={onClose} className="btn-primary dlg-btn dlg-btn-close">Close</button></div>
    </dialog>
  );
}
