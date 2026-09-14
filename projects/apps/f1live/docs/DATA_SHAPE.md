# Shared data shape

Every telemetry update flowing through the app — whether replayed from a
recorded lap or streamed live — is a plain object matching `TelemetryUpdate`,
defined once in [`src/lib/telemetryShape.js`](../src/lib/telemetryShape.js).
`historicalAdapter.js` and `liveAdapter.js` must both produce this shape;
`components/` are written against it and nothing more specific.

## `TelemetryUpdate`

| Field         | Type      | Units / range                          | Notes |
|---------------|-----------|------------------------------------------|-------|
| `timestamp`   | `number`  | ms since Unix epoch                      | When the sample was taken. |
| `speed`       | `number`  | km/h                                     | |
| `throttle`    | `number`  | 0–100 (%)                                | Pedal position. |
| `brake`       | `number`  | 0–100 (%)                                | Pressure/position, not just on/off — a boolean brake source should map to 0 or 100. |
| `gear`        | `number`  | -1 (reverse), 0 (neutral), 1–8           | |
| `rpm`         | `number`  | engine rpm                               | Expansion beyond the original field list — kept because throttle/brake alone don't tell you engine load, and it's a standard channel in real telemetry tools (e.g. FastF1's car-data channels). **Flagged for review** if it's not wanted. |
| `drs`         | `boolean` | open (`true`) / closed (`false`)         | Expansion beyond the original field list — DRS state is a normal companion to speed/gear in F1 telemetry and cheap to carry through now. **Flagged for review** if it's not wanted. |
| `lapDistance` | `number`  | metres along the current lap             | 0 at the start/finish line, up to the track's lap length. |

Use `createTelemetryUpdate(fields)` from `telemetryShape.js` to construct
one rather than hand-building the object literal — it fills in defaults for
any omitted field, so adding a new field later only means updating that one
factory instead of every call site.

## Adapter contract

Both adapters expose the same `TelemetryAdapter` interface:

```js
const adapter = createHistoricalAdapter(/* or createLiveAdapter */)(options);
adapter.subscribe((update /*: TelemetryUpdate */) => { /* ... */ });
// later
adapter.unsubscribe();
```

- `subscribe(callback)` — registers `callback`, which will be called with a
  `TelemetryUpdate` each time a new sample is available.
- `unsubscribe()` — stops delivery and releases any resources (the
  historical adapter clears its interval timer; the live adapter will close
  its socket once implemented).

A component or route that only calls `subscribe`/`unsubscribe` and reads the
fields above works unmodified whichever adapter it's given — that's the
mechanism that lets Replay and Live share `TelemetryChart` and `AppShell`.

## Out of scope here

`liveAdapter.js` is a stub: `subscribe` currently only logs a warning and
never calls back. Its real implementation — a WebSocket/SSE connection to
the Railway live-telemetry service — is later-chapter work; only the
interface above needs to be stable now.
