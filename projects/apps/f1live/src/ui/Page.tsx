import { useRef } from 'react';
import { useDialogs } from '../useDialogs.ts';
import { useShortcuts } from '../useShortcuts.ts';
import type { Shortcut } from '../useShortcuts.ts';
import '../app.css';
import type { Source } from '../snapshot.ts';
import { toViewModel } from '../viewModel.ts';
import { Banner, Footer, Header, NoSession, SessionBar } from './Chrome.tsx';
import { Focus } from './Focus.tsx';
import { TrackPanel } from './TrackPanel.tsx';
import { Timing } from './Timing.tsx';
import { Analysis } from './Analysis.tsx';
import { HelpDialog, StandingsDialog } from './Dialogs.tsx';

export function Page({ source }: { source: Source }) {
  const { snap, actions, mapRef } = source;
  const vm = toViewModel(snap);
  const dlg = useDialogs();
  const tipRef = useRef<HTMLDivElement>(null);
  const showStandings = (k: 'drivers' | 'teams') => { actions.showStandings(k); dlg.open('standings'); };
  const handlers: Record<Shortcut, () => void> = {
    help: () => dlg.toggle('help'), play: actions.togglePlay,
    back10: () => actions.seekBy(-10), fwd10: () => actions.seekBy(10), back1: () => actions.seekBy(-1), fwd1: () => actions.seekBy(1),
    faster: () => actions.stepSpeed(1), slower: () => actions.stepSpeed(-1), restart: actions.restart,
    labels: actions.toggleLabels, drs: actions.toggleDrs, events: actions.toggleEvents,
    drivers: () => showStandings('drivers'), teams: () => showStandings('teams'),
  };
  useShortcuts((s) => handlers[s](), () => dlg.isOpen('help'));

  return (
    <div className="page">
      <Header vm={vm} actions={actions} />
      <SessionBar vm={vm} />
      {vm.hasBanner && <Banner vm={vm} actions={actions} />}
      {vm.noSession && <NoSession vm={vm} actions={actions} />}
      {vm.hasSession && (
        <main className="page-main">
          <div className="page-grid">
            <Focus vm={vm} />
            <div className="page-col">
              <TrackPanel
                vm={vm} actions={actions} mapRef={mapRef}
                onStandings={() => showStandings(vm.isTeams ? 'teams' : 'drivers')}
                onHelp={() => dlg.open('help')}
              />
            </div>
          </div>
          <Timing vm={vm} actions={actions} />
          <Analysis vm={vm} actions={actions} tipRef={tipRef} />
        </main>
      )}
      <Footer vm={vm} />
      <HelpDialog vm={vm} actions={actions} dialogRef={dlg.helpRef} onClose={() => dlg.close('help')} />
      <StandingsDialog vm={vm} actions={actions} dialogRef={dlg.standingsRef} onClose={() => dlg.close('standings')} />
      <div className="tip" ref={tipRef} hidden />
    </div>
  );
}
