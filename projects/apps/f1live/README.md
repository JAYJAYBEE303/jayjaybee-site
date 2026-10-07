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
- `src/style.css`: tokens and layout
- `src/main.tsx`, `src/App.tsx`: React root, layout, keyboard shortcuts, standings loading
- `src/useReplay.ts`: replay engine hook: season and race loading, frame loop, playback, preferences
- `src/openf1.ts`: OpenF1 fetching (spacing, `429` backoff, Cache API) and map rotation
- `src/loaders.ts`: background loaders (car positions, DRS zones, telemetry, fastest-lap traces)
- `src/race.ts`: race model and the readouts the panels show (leaderboard, race control, standings)
- `src/replay.ts`: pure helpers (binary search, interpolation, track outline)
- `src/drawMap.ts`: track map canvas drawing
- `src/components/`: header, leaderboard, transport bar, insight tabs, line chart, dialogs
- `check.ts`: `npm test` asserts `replay.ts` and `race.ts` (plain node, no test framework)
- `legacy/`: the original plain HTML/JS app, kept until the React port is signed off
- `vercel.json`: Vercel builds with `npm run build` and serves `dist/`

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
- The map isn't rotated to the broadcast orientation; OpenF1 has no rotation
  field.
- Before 2023 there's no OpenF1 data. Supporting older seasons would need a
  FastF1 export to static JSON.
