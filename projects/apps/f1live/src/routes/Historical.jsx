import { useEffect, useState } from 'react';
import { createHistoricalAdapter } from '../lib/historicalAdapter';
import { TelemetryChart } from '../components/TelemetryChart';

const MAX_SAMPLES = 40;

/**
 * Replay mode — steps through a recorded lap via historicalAdapter.
 * Chapter 0: proves the adapter → shared-component wiring; lap selection,
 * scrubbing, and real session loading arrive later.
 */
export default function Historical() {
  const [samples, setSamples] = useState([]);

  useEffect(() => {
    const adapter = createHistoricalAdapter({ intervalMs: 500 });
    adapter.subscribe((update) => {
      setSamples((prev) => [...prev, update].slice(-MAX_SAMPLES));
    });
    return () => adapter.unsubscribe();
  }, []);

  return (
    <section>
      <h1>Replay</h1>
      <p>Historical lap, replayed sample by sample from historicalAdapter.</p>
      {samples.length === 0 ? (
        <p>Waiting for the first sample…</p>
      ) : (
        <div className="chart-grid">
          <TelemetryChart channel="speed" samples={samples} />
          <TelemetryChart channel="throttle" samples={samples} />
          <TelemetryChart channel="brake" samples={samples} />
          <TelemetryChart channel="rpm" samples={samples} />
        </div>
      )}
    </section>
  );
}
