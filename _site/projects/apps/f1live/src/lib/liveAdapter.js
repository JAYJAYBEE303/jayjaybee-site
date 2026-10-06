/**
 * Live-telemetry adapter — STUB.
 *
 * Real implementation arrives in a later chapter, once the live backend
 * (Railway) exists: this will open a WebSocket/SSE connection to that
 * service and call `callback` with a `createTelemetryUpdate(...)` object
 * per message, matching the exact shape historicalAdapter produces.
 *
 * The exported shape is the real contract to get right now — routes/
 * components should be able to import this instead of historicalAdapter
 * and work unmodified once it's implemented.
 *
 * @param {{ sessionId?: string }} [options]
 * @returns {import('./telemetryShape').TelemetryAdapter}
 */
export function createLiveAdapter(options = {}) {
  return {
    subscribe(_callback) {
      // TODO(chapter: live backend): connect to the Railway live-telemetry
      // service and forward each message through createTelemetryUpdate().
      console.warn(
        'createLiveAdapter().subscribe() is a stub — live telemetry is not implemented yet.',
        options,
      );
    },
    unsubscribe() {
      // No connection exists yet; nothing to tear down.
    },
  };
}
