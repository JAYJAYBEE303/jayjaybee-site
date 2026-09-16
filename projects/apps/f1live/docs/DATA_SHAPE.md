# Shared data shape

**Status: locked v1.** Confirmed against a real fastf1 lap (see
[Provenance](#provenance) below) — the shape isn't speculative anymore.
`liveAdapter`'s real implementation must match it exactly; a field change
here is a breaking change for both adapters, not a local edit.

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
| `brake`       | `number`  | 0–100 (%)                                | Pressure/position, not just on/off. fastf1's raw `Brake` channel is boolean in some seasons and analog in others — `pipeline/fetch_session.py` normalizes both to 0–100 before this shape ever sees it. |
| `gear`        | `number`  | -1 (reverse), 0 (neutral), 1–8           | |
| `rpm`         | `number`  | engine rpm                               | Expansion beyond the original field list — kept because throttle/brake alone don't tell you engine load, and it's a standard channel in real telemetry tools (fastf1's `RPM` car-data column). |
| `drs`         | `boolean` | open (`true`) / closed (`false`)         | Expansion beyond the original field list. fastf1's raw `DRS` channel is a status-code enum (0,1,2,8,10,12,14,...), not a boolean — `pipeline/fetch_session.py` maps only `{10,12,14}` to `true`. Those codes are genuinely rare across a full session, so a lap showing `drs: false` throughout (especially a race leader's, who rarely has a car ahead within a second) is expected, not a mapping bug. |
| `lapDistance` | `number`  | metres along the current lap             | 0 at the start/finish line, up to the track's lap length. fastf1's `add_distance()` gives this directly. |

Use `createTelemetryUpdate(fields)` from `telemetryShape.js` to construct
one rather than hand-building the object literal — it fills in defaults for
any omitted field, so adding a new field later only means updating that one
factory instead of every call site.

## Provenance

This shape was locked after round-tripping real data end-to-end, not
designed in the abstract:

1. `pipeline/fetch_session.py` pulls one lap via fastf1 and normalizes it
   to exactly these 8 fields (see `pipeline/README.md` for the brake/DRS
   mapping detail).
2. `pipeline/validate_output.mjs` checks every sample's types and ranges
   before it's trusted.
3. `historicalAdapter.js` fetches that JSON and replays it unmodified
   through `createTelemetryUpdate()`.
4. `TelemetryChart`/`AppShell` render it with no mode-specific branching.

Default lap: 2023 Bahrain GP, Race, VER's fastest lap — 352 samples, see
`public/data/2023-bahrain-r-ver.meta.json`.

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
- `unsubscribe()` — stops delivery and releases any resources.
  `historicalAdapter` clears its playback timer and stops delivering even
  if its `fetch()` was still in flight; the live adapter will close its
  socket once implemented.

A component or route that only calls `subscribe`/`unsubscribe` and reads the
fields above works unmodified whichever adapter it's given — that's the
mechanism that lets Replay and Live share `TelemetryChart` and `AppShell`.

## Out of scope here

`liveAdapter.js` is a stub: `subscribe` currently only logs a warning and
never calls back. Its real implementation — a WebSocket/SSE connection to
the Railway live-telemetry service — is later-chapter work; it must
produce exactly the locked shape above, no renegotiation.
