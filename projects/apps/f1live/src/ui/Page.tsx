import { useRef } from 'react';
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
  // Task 7 replaces these refs with useDialogs.
  const helpRef = useRef<HTMLDialogElement>(null);
  const standingsRef = useRef<HTMLDialogElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const open = (ref: typeof helpRef) => { const d = ref.current; if (d && !d.open) d.showModal(); };
  const close = (ref: typeof helpRef) => () => ref.current?.close();

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
                onStandings={() => { actions.showStandings(vm.isTeams ? 'teams' : 'drivers'); open(standingsRef); }}
                onHelp={() => open(helpRef)}
              />
            </div>
          </div>
          <Timing vm={vm} actions={actions} />
          <Analysis vm={vm} actions={actions} tipRef={tipRef} />
        </main>
      )}
      <Footer vm={vm} />
      <HelpDialog vm={vm} actions={actions} dialogRef={helpRef} onClose={close(helpRef)} />
      <StandingsDialog vm={vm} actions={actions} dialogRef={standingsRef} onClose={close(standingsRef)} />
      <div className="tip" ref={tipRef} hidden />
    </div>
  );
}
