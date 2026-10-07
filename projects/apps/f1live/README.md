# F1 Race Replay

Browser replay of any F1 race or sprint from 2023 on: cars moving on the
track map, a live leaderboard (gap to leader and current tyre), the lap
counter, and race-control messages, with play/pause, scrubbing and 0.5×–64×
speed.

It is a web port of the race view from
[f1-race-replay](https://github.com/IAmTomShaw/f1-race-replay), a desktop
Python app. That app pulls data with FastF1 in Python. This one reads the
public [OpenF1](https://openf1.org) API straight from the browser, so it
needs no backend and no build step.

## Files

- `index.html`: page shell
- `style.css`: tokens and layout
- `app.js`: OpenF1 fetching, playback loop, canvas drawing, controls
- `replay.js`: pure helpers (binary search, interpolation, track outline)
- `check.mjs`: `node check.mjs` asserts `replay.js`
- `vercel.json`: static deploy, no framework or build

## Run locally

```
python3 -m http.server 8000   # from this folder, then open http://localhost:8000/
```

ES modules don't load from `file://`, so serve the folder over HTTP.

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
