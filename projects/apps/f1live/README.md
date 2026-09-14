# F1 Live

F1 telemetry dashboard — Vite + React, deployed on Vercel. Two data modes,
Replay (`/`) and Live (`/live`), share one data shape and one set of visual
components. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full structure, [`docs/DATA_SHAPE.md`](docs/DATA_SHAPE.md) for the shared
telemetry shape, and [`docs/STYLE_GUIDE.md`](docs/STYLE_GUIDE.md) for the
design tokens.

This is Chapter 0: scaffolding only. Live telemetry (`src/lib/liveAdapter.js`)
is a stub pending a separate live backend (Railway), and the UI is
deliberately minimal — the barebones interface comes in the next chapter.

## Develop

```
npm install
npm run dev
```

## Build

```
npm run build
```

Outputs a static `dist/` for deployment. `vercel.json` rewrites all routes
to `index.html` so `/live` doesn't 404 on a hard refresh.
