/**
 * Shared telemetry update shape.
 *
 * Both `historicalAdapter` and `liveAdapter` must produce objects matching
 * this shape so `components/` can render either mode without caring which
 * one is feeding it. See /docs/DATA_SHAPE.md for field-by-field rationale.
 *
 * @typedef {Object} TelemetryUpdate
 * @property {number}  timestamp   Milliseconds since the Unix epoch.
 * @property {number}  speed       Car speed in km/h.
 * @property {number}  throttle    Throttle position, 0–100 (%).
 * @property {number}  brake       Brake pressure, 0–100 (%).
 * @property {number}  gear        -1 = reverse, 0 = neutral, 1–8 = gear.
 * @property {number}  rpm         Engine speed in rpm.
 * @property {boolean} drs         Whether DRS is currently open.
 * @property {number}  lapDistance Metres travelled along the current lap.
 */

/**
 * Builds a well-formed TelemetryUpdate, filling in safe defaults for any
 * field the caller omits. Adapters should pass their raw values through
 * this factory rather than hand-assembling plain objects, so a field added
 * here only needs updating in one place.
 *
 * @param {Partial<TelemetryUpdate>} fields
 * @returns {TelemetryUpdate}
 */
export function createTelemetryUpdate(fields = {}) {
  return {
    timestamp: fields.timestamp ?? Date.now(),
    speed: fields.speed ?? 0,
    throttle: fields.throttle ?? 0,
    brake: fields.brake ?? 0,
    gear: fields.gear ?? 0,
    rpm: fields.rpm ?? 0,
    drs: fields.drs ?? false,
    lapDistance: fields.lapDistance ?? 0,
  };
}

/**
 * The common adapter interface. Both historicalAdapter and liveAdapter
 * expose a factory that returns an object of this shape, so routes/
 * components can swap one for the other without branching on mode.
 *
 * @typedef {Object} TelemetryAdapter
 * @property {(callback: (update: TelemetryUpdate) => void) => void} subscribe
 *   Register a callback to receive TelemetryUpdate objects.
 * @property {() => void} unsubscribe
 *   Stop delivering updates and release any resources (timers, sockets).
 */
