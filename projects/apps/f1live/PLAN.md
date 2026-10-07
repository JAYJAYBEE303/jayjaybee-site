# F1 Race Replay — Foundational Feature Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the browser replay (`projects/apps/f1live/`) up to feature parity with the desktop Python app [f1-race-replay](https://github.com/IAmTomShaw/f1-race-replay), one stage at a time.

**Architecture:** Static page with no build and no backend. `app.js` fetches the public OpenF1 API from the browser, draws on a canvas, and renders the leaderboard and panels in HTML. `replay.js` holds pure, DOM-free helpers that `check.mjs` asserts with plain `node`.

**Tech Stack:** Vanilla ES modules, Canvas 2D, CSS custom properties, OpenF1 REST (`https://api.openf1.org/v1/`).

**Spec:** the feature list of the Python app (README and `src/` of the uploaded `f1-race-replay-main.zip`), as compared in the session.

## Global Constraints

- No npm, no bundler, no framework. Files are served as they are (`vercel.json`: `framework: null`, `outputDirectory: "."`).
- Every API string reaches the DOM via `textContent`, never `innerHTML`.
- Requests go through `api()` in `app.js`: about 400 ms spacing, backoff on `429`.
- Colours live as `--` tokens in `style.css`; canvas reads them with `color('--name')`.
- Relative asset URLs only (the app is proxied under `/projects/apps/f1live/`).
- Environment rule (SentinelOne-safe): no local servers, browsers or test runners from the agent. Verification is by reading. The user runs `node check.mjs` and the browser checks.

## Branch / delivery

- Work branch: `foundational-feature-build` (the requested name "Foundational feature build" with git-legal spelling).
- When each stage is done: commit, push to `origin/foundational-feature-build`, tick the stage here.

## Stages

| # | Stage | Status |
|---|-------|--------|
| 1 | Race view parity | built + reviewed; awaiting user `node check.mjs` + preview check |
| 2 | Driver telemetry + insights panels | in progress |
| 3 | Qualifying, sprint qualifying, practice replays | planned |
| 4 | Championship overlays, settings, caching, map rotation | planned |
| 5 | Optional: pre-2023 seasons via FastF1 export, tyre degradation model | planned |

### Stage 1 — Race view parity

Python reference: `src/interfaces/race_replay.py`, `src/ui_components.py`, `src/f1_data.py`.

- DRS zones drawn on the track (D toggles). Source: fastest qualifying lap of the same meeting, `car_data.drs >= 10` matched to `location` by time.
- Track colour follows track status: green, SC, VSC, red. Source: `race_control`.
- Simulated safety car: a dot about 10 % of a lap ahead of the leader while the SC is out, fading in and out over 3 s. Same idea as the original's "500 m ahead of the leader".
- Weather panel: air and track temperature, humidity, wind, rain. Source: `weather`.
- Leaderboard: gap to leader, interval to the car ahead, tyre compound and age, IN PIT, OUT. Sources: `intervals`, `stints`, `pit`, `laps`.
- Full race-control feed, newest first, coloured by flag.
- Speeds 0.1×–256×; `,` and `.` step 1 s; H opens a shortcuts dialog.
- Event bar under the scrubber showing SC, VSC and red-flag periods (B toggles).

### Stage 2 — Driver telemetry + insights panels

- Click a leaderboard row (shift-click for several) to see live speed, gear, throttle, brake and DRS for those drivers (`car_data`, fetched per selected driver).
- Insight panels, as tabs under the controls: lap time chart, sector times, tyre strategy timeline, track position chart. Race-control history is already covered by the Stage 1 feed.

### Stage 3 — Qualifying / sprint qualifying / practice

- The race picker also lists Q, SQ, FP1–3.
- Session view: fastest-lap table plus a lap replay with a speed, gear, throttle and brake trace over distance (port of `src/interfaces/qualifying.py` and `practice.py`).

### Stage 4 — Championship, settings, caching, rotation

- Drivers' and constructors' standings overlays (C / A). OpenF1 standings endpoints, if they exist; otherwise built from session results.
- Settings dialog (default speed, labels, units) saved in `localStorage`.
- Cache downloaded sessions in IndexedDB for instant reopen.
- Map rotation: per-circuit table (MultiViewer values), keyed by `circuit_key`.

### Stage 5 — Optional

- Pre-2023 seasons: a Python FastF1 export script, run by the user, that writes static JSON in OpenF1's shape.
- Port `bayesian_tyre_model.py` once it has been read and judged worth it.

---

## Stage 1 tasks

### Task 1.1: Track status timeline (pure)

**Files:** Modify `replay.js`, `check.mjs`

**Interfaces:**
- Produces `trackStatusTimeline(rc, leaderLapStarts) -> Array<{t, status}>`, where status is `'green' | 'sc' | 'vsc' | 'red'`, sorted by `t`. `rc` is race-control rows with `t`; `leaderLapStarts` is a sorted array of ms timestamps.
- Produces `periods(timeline, status, endT) -> Array<{start, end}>`.

Rules:
- SafetyCar `VIRTUAL … DEPLOYED` gives `vsc`; `VIRTUAL … ENDING` gives `green`.
- `SAFETY CAR DEPLOYED` gives `sc`; `SAFETY CAR IN THIS LAP` gives `green` at the next leader lap start after the message.
- Flag `RED` gives `red`; Track-scope `GREEN` or `CLEAR` gives `green`.

- [x] Assert in `check.mjs`: an SC deploy at 10 s, "in this lap" at 50 s and a leader lap start at 80 s give `[{10,'sc'},{80,'green'}]`. A VSC deploy and ending pair works the same way. `periods(..., 'sc')` returns `[{start:10, end:80}]`.
- [x] Implement both functions.

### Task 1.2: Track colour, SC dot, event bar

**Files:** Modify `app.js` (draw, loadRace), `index.html` (event bar), `style.css`

**Interfaces:** consumes Task 1.1. Adds `pointAhead(outline, cum, p, frac) -> {x, y}` to `replay.js` (`cum` holds cumulative outline lengths) and a matching assert.

- [x] Track stroke uses `--track-sc` / `--track-vsc` / `--track-red` by status at `S.t`.
- [x] SC dot (`--sc`, "SC" label) at `pointAhead(…, 0.1)` from the leader during `sc` periods, alpha = min(1, (t − start)/3 s, (end − t)/3 s).
- [x] Event bar: absolutely positioned segments under `#scrub`, one per period; B toggles `hidden`.

### Task 1.3: DRS zones

**Files:** Modify `app.js`

- [x] After a race loads, in the background: `sessions?meeting_key=&session_name=Qualifying`, then `laps` of that session, then the fastest `lap_duration`, then `location` and `car_data` for that driver and lap window.
- [x] Store `S.drs` as `[[{x,y}, …], …]`, the runs of points where the nearest `car_data` sample has `drs >= 10`. Draw them in `--drs` at 4 px over the track; D toggles. No qualifying or no DRS (2026+) means nothing is drawn.

### Task 1.4: Leaderboard + weather + race-control feed

**Files:** Modify `app.js` (renderBoard), `index.html`, `style.css`, `replay.js` (`tyreAge`)

- [x] Fetch `weather` and `pit` together with the other session data.
- [x] Row: pos, team, code, gap to leader, interval, tyre letter + age. `IN PIT` when `t` is in [pit.date, pit.date + pit_duration]. `OUT` when the driver's last lap ended at least 30 s before the chequered flag and `t` is past that end + 30 s.
- [x] `tyreAge(stint, lap) = (tyre_age_at_start ?? 0) + lap − lap_start`, with an assert.
- [x] Weather line under the tower head, from `lastAt(weather, t)`.
- [x] `#rc` becomes an `<ol>` of every message up to `t`, newest first, re-rendered only when the count changes.

### Task 1.5: Controls

**Files:** Modify `app.js`, `index.html`, `style.css`

- [x] `SPEEDS = [0.1, 0.2, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256]`.
- [x] `,` / `.` step −1 s / +1 s; D toggles DRS; B toggles the event bar; H opens `<dialog id="help">` listing every shortcut.
- [x] Credit line points to H instead of listing shortcuts.

### Stage 1 done when

- `node check.mjs` prints `replay.js ok` (run by the user).
- On the Vercel preview, a 2024 race with a safety car (e.g. 2024 Australia) shows DRS zones, an amber track and SC dot during the SC period, the event bar, weather, intervals, tyre ages and the race-control feed.
- Pushed to `origin/foundational-feature-build`; the status table above is updated.

## Stage 2 tasks

Rule for every panel: only data up to the playhead `S.t` is shown (no spoilers). Laps count once they have finished.

### Task 2.1: Pure helpers (`replay.js`, `check.mjs`)

- [ ] `lapsDone(laps, t)`: rows (with `t` = lap start) whose `t + lap_duration*1000 <= t`. Laps without a duration are excluded.
- [ ] `sectorBests(lapsByDriver, t) -> { overall: [s1,s2,s3], personal: Map<d, [s1,s2,s3]> }` over finished laps, using `duration_sector_1..3`.
- [ ] `stintBars(stints, lap) -> [{ compound, from, to }]`, clipped to `lap`. Stints that start after `lap` are dropped; `lap_end` null means `lap`.
- [ ] An assert for each in `check.mjs`.

### Task 2.2: Driver selection + telemetry

- [ ] `S.selected: Set<driver_number>`. A leaderboard click selects only that driver; shift-click toggles. A checkbox picker in the insights section shows the same set; it's built once per race so keyboard users keep focus.
- [ ] Selected cars get a ring on the map.
- [ ] Telemetry tab: for each selected driver, speed, gear, throttle bar, brake bar and DRS from `car_data`. Fetched per driver per 5-minute window and cached in `S.car`; a failed fetch caches `[]`, so it never retry-loops.

### Task 2.3: Insight tabs

- [ ] Tabs: Telemetry · Lap times · Positions · Sectors · Tyres (`role="tablist"`, arrow keys not required).
- [ ] Lap times: line chart of finished laps for the selected drivers, or the top 3 when nothing is selected. The y-range is clipped to `[best, median × 1.12]` so pit and SC laps don't flatten it. The second teammate's line is dashed. HTML legend, plus a hover crosshair and tooltip.
- [ ] Positions: bump chart of the position at each lap end for all drivers; unselected ones are dimmed when a selection exists. Same chart function with an inverted y.
- [ ] Sectors: table of each driver's last finished lap S1–S3, purple for the overall best, green for a personal best.
- [ ] Tyres: per-driver stint bars up to the current lap, coloured with the existing tyre tokens.
- [ ] Insights render on the 250 ms board tick, active tab only.

### Stage 2 done when

- `node check.mjs` prints `replay.js ok` (run by the user).
- On the preview: clicking a driver shows live telemetry and a map ring; lap and position charts grow as the race plays and show nothing ahead of the playhead; the sectors table shows purple and green; tyre bars match the leaderboard tyre.

## Review Focus

- A race with no qualifying session (or Q laps without `lap_duration`): DRS silently absent, no error status.
- `race_control` with a deployed SC and no "IN THIS LAP" (red-flagged under SC): the SC period ends at the next `red` or `green` entry, not at race end.
- A driver missing from `intervals`, `stints` or `pit`: the row still renders, with blank cells.
- Seeking backwards: the race-control feed shrinks (the count goes down as well as up).
- 2026 sessions (no DRS on cars): no DRS layer and no console errors.
