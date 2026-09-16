import { useEffect, useRef, useState } from 'react';
import { createHistoricalAdapter } from '../lib/historicalAdapter';
import { TelemetryChart } from '../components/TelemetryChart';
import { TrackMap } from '../components/TrackMap';
import { SectorIndicator } from '../components/SectorIndicator';

const MAX_SAMPLES = 40;

/**
 * Replay mode — steps through a real recorded lap (fetched by
 * historicalAdapter from /public/data/, produced via pipeline/fetch_session.py)
 * on a timer. Lap selection and scrubbing controls arrive later; for now
 * historicalAdapter always replays its one default lap.
 */
export default function Historical() {
  const [samples, setSamples] = useState([]);
  const [trackPoints, setTrackPoints] = useState([]);
  const lastDistanceRef = useRef(0);

  useEffect(() => {
    const adapter = createHistoricalAdapter();
    adapter.subscribe((update) => {
      setSamples((prev) => [...prev, update].slice(-MAX_SAMPLES));

      // Rebuild the track path from scratch each time the lap loops
      // (lapDistance drops back to ~0) so the map redraws per lap instead
      // of growing forever across an indefinite replay loop.
      const looped = update.lapDistance < lastDistanceRef.current;
      lastDistanceRef.current = update.lapDistance;
      setTrackPoints((prev) => [...(looped ? [] : prev), { x: update.x, y: update.y }]);
    });
    return () => adapter.unsubscribe();
  }, []);

  const latest = samples.at(-1);

  return (
    <section>
      <h1>Replay</h1>
      <p>Historical lap, replayed sample by sample from historicalAdapter.</p>
      {samples.length === 0 ? (
        <p>Waiting for the first sample…</p>
      ) : (
        <>
          <SectorIndicator sector={latest.sector} />
          <div className="chart-grid">
            <TrackMap points={trackPoints} current={latest} />
            <TelemetryChart channel="speed" samples={samples} />
            <TelemetryChart channel="throttle" samples={samples} />
            <TelemetryChart channel="brake" samples={samples} />
            <TelemetryChart channel="rpm" samples={samples} />
          </div>
        </>
      )}
    </section>
  );
}
