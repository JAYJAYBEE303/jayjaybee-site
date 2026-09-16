# Architecture

F1 Live is a two-mode telemetry dashboard: **Replay** (historical, recorded
sessions) and **Live** (real-time telemetry from a car on track). Both modes
render the same visual components from the same data shape — only the
source of the data differs.

```
                     ┌───────────────┐
   historicalAdapter │               │
   ───────────────► │  TelemetryUpdate  ◄─── liveAdapter
                     │   (shared shape)  │      (Railway, later phase)
                     └───────┬───────┘
                             │
                     ┌───────▼───────┐
                     │  components/  │  charts, layout — mode-agnostic
                     └───────┬───────┘
                             │
                   ┌─────────┴─────────┐
                   │                   │
             routes/Historical.jsx  routes/Live.jsx
                   │                   │
                    "/"               "/live"
```

## Why one shape, two adapters

`routes/Historical.jsx` and `routes/Live.jsx` are thin: each just wires an
adapter to the shared chart components. Neither route, nor any component
under `components/`, knows or cares whether a `TelemetryUpdate` came from a
replayed lap or a live car — that's the point of fixing the shape in
`lib/telemetryShape.js` up front. See [DATA_SHAPE.md](./DATA_SHAPE.md) for
the shape itself.

This chapter only builds the historical/scaffolding side end-to-end.
`lib/liveAdapter.js` is a stub with the correct exported interface;
implementing it against the live backend (planned on Railway, separate
infrastructure from this Vercel-deployed frontend) is later-chapter work.

## Folder layout

```
src/
  routes/       One file per top-level page/mode.
    Historical.jsx   "/" — replays a recorded lap via historicalAdapter.
    Live.jsx         "/live" — placeholder wired to the liveAdapter stub.
  components/   Shared UI — charts, layout — used by both routes.
    AppShell.jsx      Page frame: header nav (Replay / Live) + <Outlet />.
    TelemetryChart.jsx  Minimal per-channel sparkline.
  lib/          Data adapters, both producing the shared shape.
    telemetryShape.js    The shared TelemetryUpdate shape + factory.
    historicalAdapter.js Fetches a real lap from public/data/ and replays
                          it on a timer paced to the recording's own gaps.
    liveAdapter.js        Stub — real implementation targets Railway later.
  styles/       Design tokens + global CSS (see STYLE_GUIDE.md).
    tokens.css
    global.css
docs/           This file, DATA_SHAPE.md, STYLE_GUIDE.md, ROADMAP.md.
pipeline/       Standalone Python step (fastf1) that produces the JSON
                historicalAdapter.js fetches — see pipeline/README.md.
```

## Routing

Client-side routing via `react-router-dom`'s `<BrowserRouter>` (real paths —
`/`, `/live` — not `#/live` hash routes). Because a static host serves
`index.html` for `/` but not for `/live` on a hard refresh, `vercel.json`
rewrites every path back to `index.html` so the router can take over.

## Deployment

Static Vite build (`npm run build` → `dist/`), deployed to Vercel. The
`vercel.json` rewrite is the only Vercel-specific config needed for a
single-page app like this. The live backend is intentionally separate
infrastructure (Railway) and out of scope here.
