import { useEffect, useState } from 'react';
import { createLiveAdapter } from '../lib/liveAdapter';

/**
 * Live mode — placeholder screen wired to liveAdapter's stub.
 * The live backend (Railway) doesn't exist yet, so this only proves the
 * route and adapter import resolve; no telemetry renders here yet.
 */
export default function Live() {
  const [status, setStatus] = useState('not connected');

  useEffect(() => {
    const adapter = createLiveAdapter();
    adapter.subscribe(() => setStatus('receiving'));
    return () => adapter.unsubscribe();
  }, []);

  return (
    <section>
      <h1>Live</h1>
      <p>
        Live telemetry isn't implemented yet — this route exists so the app
        shell and routing are in place before the live backend is built.
      </p>
      <p className="data-value">Status: {status}</p>
    </section>
  );
}
