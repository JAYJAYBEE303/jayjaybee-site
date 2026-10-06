import { createTelemetryUpdate } from './telemetryShape';

/**
 * Default lap: 2023 Bahrain GP, Race, VER's fastest lap — see
 * /pipeline/README.md for how this file was produced and
 * /public/data/2023-bahrain-r-ver.meta.json for lap details.
 */
const DEFAULT_SOURCE = '/data/2023-bahrain-r-ver.json';

/**
 * Creates a TelemetryAdapter that fetches a recorded lap (a plain JSON
 * array of TelemetryUpdate samples, produced by pipeline/fetch_session.py)
 * and replays it on a timer, standing in for "live" delivery.
 *
 * Playback follows the real gaps between recorded samples rather than a
 * fixed tick, scaled by `speedMultiplier` — so a lap replays at a
 * consistent, recognisable pace instead of a uniform-but-wrong one. On
 * reaching the end of the lap it loops back to the start.
 *
 * @param {{ source?: string, speedMultiplier?: number }} [options]
 * @returns {import('./telemetryShape').TelemetryAdapter}
 */
export function createHistoricalAdapter({ source = DEFAULT_SOURCE, speedMultiplier = 4 } = {}) {
  let cancelled = false;
  let timeoutId = null;

  async function run(callback) {
    let samples;
    try {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      samples = await response.json();
    } catch (err) {
      console.error(`historicalAdapter: failed to load "${source}"`, err);
      return;
    }

    if (cancelled || !Array.isArray(samples) || samples.length === 0) {
      return;
    }

    let index = 0;

    const step = () => {
      if (cancelled) return;

      const sample = samples[index];
      callback(createTelemetryUpdate(sample));

      const next = samples[index + 1];
      if (next) {
        const gap = Math.max(0, next.timestamp - sample.timestamp);
        index += 1;
        timeoutId = setTimeout(step, gap / speedMultiplier);
      } else {
        // End of lap — loop back to the start rather than stopping, so
        // "replay" reads as a continuous simulated feed.
        index = 0;
        timeoutId = setTimeout(step, 1000 / speedMultiplier);
      }
    };

    step();
  }

  return {
    subscribe(callback) {
      cancelled = false;
      run(callback);
    },
    unsubscribe() {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
