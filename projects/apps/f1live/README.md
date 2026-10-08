# F1 Live

F1 telemetry dashboard — Vite + React, deployed on Vercel. Two data modes,
Replay (`/`) and Live (`/live`), share one data shape and one set of visual
components. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full structure, [`docs/DATA_SHAPE.md`](docs/DATA_SHAPE.md) for the shared
telemetry shape, and [`docs/STYLE_GUIDE.md`](docs/STYLE_GUIDE.md) for the
design tokens.

Replay mode replays a real recorded lap (pulled via
[fastf1](https://docs.fastf1.dev/) — see [`pipeline/README.md`](pipeline/README.md))
on a timer paced to match the recording. Live telemetry
(`src/lib/liveAdapter.js`) is a stub pending a separate live backend
(Railway); the UI is deliberately minimal — richer playback controls and
a real UI pass come in later chapters.

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
