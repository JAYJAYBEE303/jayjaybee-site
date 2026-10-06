/**
 * Shared telemetry update shape — LOCKED v1.1 (additive since v1).
 *
 * Confirmed against a real fastf1 lap (pipeline/fetch_session.py,
 * public/data/2023-bahrain-r-ver.json) — every field below is populated by
 * real data, not just a guess at what telemetry "should" look like.
 * liveAdapter's real implementation must produce this exact shape; changing
 * a field here is a breaking change for both adapters, not a local edit.
 * v1 -> v1.1 added `sector`, `x`, `y` for the sector indicator and track
 * map — safe as a same-session addition because liveAdapter is still an
 * unimplemented stub with no real consumer yet; this would need an actual
 * version negotiation once live has real traffic depending on the shape.
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
 * @property {1|2|3}   sector      Current track sector (1, 2, or 3).
 * @property {number}  x           Track-relative X position, metres.
 * @property {number}  y           Track-relative Y position, metres.
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
    sector: fields.sector ?? 1,
    x: fields.x ?? 0,
    y: fields.y ?? 0,
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
