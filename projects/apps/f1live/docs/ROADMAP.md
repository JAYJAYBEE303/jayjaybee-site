# Roadmap — Chapter 1: real data in, replay out

Two phases, sequential. Phase A feeds Phase B.

## Phase A — Pull data (fastf1)

**A1. Isolate the pipeline from the frontend.**
Python and Node don't mix in one build. New folder at project root, sibling
to `src/`:

```
projects/apps/f1live/
  pipeline/
    requirements.txt   # fastf1, pandas
    fetch_session.py
    .cache/             # fastf1's own cache dir — gitignored
```

Not part of `npm run build`. Runs manually / ahead of time, on a dev
machine, produces static output the frontend just fetches.

**A2. Fetch script.**
`fetch_session.py` takes year/GP/session/driver args, `fastf1.get_session(...).load()`,
pulls `laps.pick_driver(X).pick_fastest()` (or a chosen lap), gets
`.get_car_data().add_distance()`. One script, one lap per run to start —
multi-lap/session is a later expansion, not needed for Chapter 1.

**A3. Field mapping — judgment calls, resolve before building:**

- `Brake`: fastf1 gives boolean in older seasons, analog % in newer ones
  depending on season/format. Script must detect and normalize both to
  0–100 to match [`telemetryShape.js`](../src/lib/telemetryShape.js).
- `DRS`: fastf1 is an enum (0,1,2,8,10,12,14...), not boolean. Needs an
  explicit mapping table → `drs: true` only for the "active" codes
  (10/12/14). Get this wrong and every chart lies about DRS zones.
- `Distance`: fastf1 gives meters already → `lapDistance` direct.
- `nGear`, `RPM`, `Speed`, `Throttle`: direct 1:1, no transform needed.
- `Time`/`Date`: convert to epoch ms → `timestamp`.

Normalize in Python only as far as raw units; final object assembly should
still go through the existing `createTelemetryUpdate()` shape contract —
either mirror its field list exactly in Python, or (cleaner) have the
script emit near-raw columns and do final shaping in a tiny JS transform
step reused by the adapter. Recommended: the latter — one source of truth
for the shape stays in JS.

**A4. Output.**
JSON per lap under `public/data/<year>-<gp>-<driver>-<lapType>.json`.
Static, fetched at runtime (`fetch('/data/...')`), not bundled — keeps the
JS bundle small, lets sessions be swapped without a rebuild.

**A5. Repo hygiene.**
Add to `.gitignore`: `pipeline/.cache/`, `pipeline/.venv/`. Do **not**
ignore the generated JSON in `public/data/` — that's committed output,
same as any static asset.

**A6. Validation gate before anything touches the frontend.**
Small check script (Node or Python) asserting every record has all
required keys, correct types, plausible ranges (throttle/brake 0–100, gear
-1..8). Catches a bad DRS mapping before it becomes a chart bug.

## Phase B — Show data (replay + lock shape)

**B1. Swap the fixture.**
[`historicalAdapter.js`](../src/lib/historicalAdapter.js) currently replays
`DEMO_LAP` (8 hardcoded rows). Replace with: `fetch()` the chosen JSON
once, then the same `setInterval` replay loop, same `subscribe`/`unsubscribe`
contract — route/component code (`Historical.jsx`, `TelemetryChart.jsx`)
doesn't change at all. That's the payoff of having locked the adapter
interface already.

**B2. Timer mechanics.**
"Replay on a timer to simulate live" = step through the real sample array
at a fixed interval, same as now. Playback controls (play/pause/speed/scrub)
are real UX value but not required for this chapter — next-chapter scope
unless pulled forward.

**B3. Lock the shared shape.**
Once real fastf1 data is flowing, freeze `telemetryShape.js` as v1 and
update [`DATA_SHAPE.md`](./DATA_SHAPE.md): confirm units, document the
brake-normalization and DRS-enum-mapping decisions from A3 so
`liveAdapter.js` has zero ambiguity when it's built later — it must match
this exactly, no renegotiating the shape once live is involved.

**B4. Style sheet.**
User-owned. Nothing in this phase requires touching tokens —
`TelemetryChart.jsx` and `AppShell.jsx` already consume `var(--...)` only,
so a new stylesheet drops in without touching component logic.

## Sequencing

| Order | Task | Blocks |
|---|---|---|
| 1 | pipeline/ scaffold + requirements.txt | — |
| 2 | fetch_session.py, one hardcoded lap first | A3 decisions |
| 3 | resolve brake/DRS mapping, validate output | B1 |
| 4 | historicalAdapter.js → fetch real JSON | B3 |
| 5 | lock telemetryShape.js + DATA_SHAPE.md | liveAdapter (later chapter) |

## Open decisions

1. ~~Brake/DRS normalization rules above~~ — **resolved.** Verified against
   2023 Bahrain GP real data: brake bool/analog detection works, and the
   `{10,12,14}` DRS-open code set is confirmed correct. Note: those codes
   are rare across a full race, so a single lap showing `drs: false`
   throughout (especially for a race leader) is expected, not a bug — see
   `pipeline/README.md`.
2. Static JSON per lap vs. a tiny fetch API route — recommended static;
   revisit if multi-lap browsing is wanted sooner.
3. Playback controls now or next chapter.

## Phase A — status: done

`pipeline/` scaffolded (`requirements.txt`, `fetch_session.py`,
`validate_output.mjs`, `README.md`), venv created, `fastf1`/`pandas`
installed. Fetched and validated one real lap:
`public/data/2023-bahrain-r-ver.json` (352 samples, VER's fastest lap,
2023 Bahrain GP Race) + matching `.meta.json`. Passed
`validate_output.mjs` with no errors. Phase B (swap the adapter fixture,
lock the shape doc) is next.
