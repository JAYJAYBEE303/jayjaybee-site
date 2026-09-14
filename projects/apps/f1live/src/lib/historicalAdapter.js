import { createTelemetryUpdate } from './telemetryShape';

/**
 * Small demo lap used for Chapter 0 scaffolding only — enough samples to
 * prove the adapter → component wiring works. Replace with a real
 * session/lap loader (CSV, FastF1 export, API fetch, etc.) in a later
 * chapter; the shape it must produce is fixed by telemetryShape.js.
 */
const DEMO_LAP = [
  { t: 0, speed: 92, throttle: 45, brake: 0, gear: 3, rpm: 9800, drs: false, dist: 0 },
  { t: 500, speed: 138, throttle: 100, brake: 0, gear: 4, rpm: 11200, drs: false, dist: 24 },
  { t: 1000, speed: 187, throttle: 100, brake: 0, gear: 5, rpm: 11900, drs: true, dist: 58 },
  { t: 1500, speed: 221, throttle: 100, brake: 0, gear: 6, rpm: 12100, drs: true, dist: 102 },
  { t: 2000, speed: 244, throttle: 60, brake: 0, gear: 7, rpm: 11400, drs: true, dist: 156 },
  { t: 2500, speed: 198, throttle: 0, brake: 85, gear: 5, rpm: 9200, drs: false, dist: 208 },
  { t: 3000, speed: 121, throttle: 0, brake: 100, gear: 3, rpm: 7600, drs: false, dist: 244 },
  { t: 3500, speed: 96, throttle: 30, brake: 0, gear: 2, rpm: 8400, drs: false, dist: 268 },
];

/**
 * Creates a TelemetryAdapter that replays a fixed historical lap on an
 * interval, standing in for "load a recorded session and step through it".
 *
 * @param {{ intervalMs?: number }} [options]
 * @returns {import('./telemetryShape').TelemetryAdapter}
 */
export function createHistoricalAdapter({ intervalMs = 500 } = {}) {
  let timerId = null;
  let index = 0;
  const startedAt = Date.now();

  return {
    subscribe(callback) {
      timerId = setInterval(() => {
        const sample = DEMO_LAP[index % DEMO_LAP.length];
        callback(
          createTelemetryUpdate({
            timestamp: startedAt + sample.t,
            speed: sample.speed,
            throttle: sample.throttle,
            brake: sample.brake,
            gear: sample.gear,
            rpm: sample.rpm,
            drs: sample.drs,
            lapDistance: sample.dist,
          }),
        );
        index += 1;
      }, intervalMs);
    },
    unsubscribe() {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  };
}
