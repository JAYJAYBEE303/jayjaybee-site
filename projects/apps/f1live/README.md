# F1 Race Replay

Browser replay of any F1 race or sprint from 2023 on: cars moving on the
track map with DRS zones, track colour that follows SC, VSC and red flags,
and a simulated safety car. A leaderboard shows gap, interval, tyre and age,
plus PIT and OUT. There's also weather, the race-control feed, an event bar
under the scrubber, and play/pause, scrubbing and 0.1×–256× speed. Press H
for shortcuts. Below the map, insight tabs show live telemetry for the
drivers you pick, lap-time and position charts, sector times, and tyre
stints, all limited to what has happened so far in the replay.
Practice, qualifying, sprint qualifying and sprint sessions replay the same
way. Qualifying shows Q1/Q2/Q3 best times, and a Fastest lap tab compares
drivers' speed, throttle, brake and gear over their best lap. C and A
open live championship standings. The Telemetry tab also shows measured
tyre wear (seconds per lap, and time lost against new tyres). The map is rotated to match TV
graphics where the circuit data allows. Playback preferences are
remembered, and session data is saved in the browser so races reopen
instantly. The staged roadmap to full parity is in `PLAN.md`.

It is a web port of the race view from
[f1-race-replay](https://github.com/IAmTomShaw/f1-race-replay), a desktop
Python app. That app pulls data with FastF1 in Python. This one reads the
public [OpenF1](https://openf1.org) API straight from the browser, so it
needs no backend. It's built with Vite, React and TypeScript.

## Files

- `index.html`: page shell (Vite entry)
- `src/main.tsx`: React root; renders the real app, or the mock under `?scenario=` in dev
- `src/RealApp.tsx`: the real data source: `useReplay` plus tab, standings and selection state, as a `Source` for the page
- `src/snapshot.ts`: the view contract (`Snapshot`, `Actions`, `Source`; types only)
- `src/toSnapshot.ts`: pure adapter from the race model to a `Snapshot`
- `src/viewModel.ts`: pure `Snapshot` to view model (colours, labels, layout values the components bind)
- `src/ui/`: page components (header, session bar, focus card, track panel, timing, analysis tabs, line chart, dialogs) and their CSS
- `src/tokens.css`, `src/app.css`: design tokens and shared classes
- `src/useShortcuts.ts`, `src/useDialogs.ts`: keyboard shortcuts and the help/standings dialogs, shared by both sources
- `src/paint.ts`: token-themed canvas painters for the track map and charts
- `src/useReplay.ts`: replay engine hook: season and race loading, load errors and retry, frame loop, playback, preferences
- `src/openf1.ts`: OpenF1 fetching (spacing, `429` backoff, Cache API) and map rotation
- `src/loaders.ts`: background loaders (car positions, DRS zones, telemetry, fastest-lap traces)
- `src/race.ts`: race model and the readouts the panels show (leaderboard, race control, standings)
- `src/replay.ts`: pure helpers (binary search, interpolation, track outline)
- `src/drawMap.ts`: real race to map scene for the painter
- `src/mock/`: dev-only mock source (simulation, controller, `MockApp`); never in the production build
- `check.ts`, `check-design.ts`: `npm test` asserts the race model, adapter, mock, view model, shortcuts and map scenes (plain node, no test framework)
- `test/`: shared race fixture and the design reference's golden output
- `vercel.json`: Vercel builds with `npm run build` and serves `dist/`

## Swapping the data source

The page (`src/ui/Page.tsx`) renders whatever a `Source` gives it: a
`Snapshot` (plain data), `Actions` (play, seek, select, …) and the map
canvas ref. To feed it from somewhere else, implement `Source` from
`src/snapshot.ts`. `src/RealApp.tsx` is the OpenF1 implementation; the mock
in `src/mock/` is the second one.

A `Source` also owns painting its `mapRef` canvas: the real source paints in
`useReplay`'s frame loop via `drawMap`, the mock in `MockApp`'s rAF loop via
`paintMap`.

## Dev scenarios

In `npm run dev`, `?scenario=<name>` swaps OpenF1 for the mock source:
`live`, `safety-car`, `vsc`, `red-flag`, `feed-dropped`, `retirements`,
`chequered`, `qualifying`, `loading`, `no-session`. The mock is reachable
only in dev; `vite build` leaves it out.

## Run locally

```
npm install
npm run dev       # dev server, http://localhost:5173/
npm test          # logic checks
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/ at http://localhost:4173/
```

## Data notes

- Car positions come in 5-minute windows (`/v1/location`), fetched in the
  background starting at the playhead. Playback shows "Buffering" until the
  window under the playhead has arrived.
- Requests are spaced about 400 ms apart to stay under OpenF1's free-tier
  rate limit. A `429` response is retried with backoff.
- OpenF1 has no map rotation field; the broadcast rotation comes from
  MultiViewer's circuit data, and the map stays unrotated if that fails.
- A failed load (session, car positions) shows the Feed lost banner;
  Reconnect re-runs the step that failed.
- Before 2023 there's no OpenF1 data. Supporting older seasons would need a
  FastF1 export to static JSON.
