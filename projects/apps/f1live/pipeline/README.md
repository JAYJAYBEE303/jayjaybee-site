# Pipeline

Standalone Python data-prep step — pulls one lap of car telemetry via
[fastf1](https://docs.fastf1.dev/) and normalizes it to the shared
`TelemetryUpdate` shape (see [`../docs/DATA_SHAPE.md`](../docs/DATA_SHAPE.md)).
Deliberately outside `src/` and outside `npm run build` — Vercel only ever
serves the static JSON this produces, it never runs Python.

## Setup (once)

```
cd pipeline
python -m venv .venv
.venv\Scripts\activate      # Windows
pip install -r requirements.txt
```

## Fetch a lap

```
python fetch_session.py --year 2023 --gp Bahrain --session R --driver VER --lap fastest
```

Writes two files to `../public/data/`:
- `<slug>.json` — plain array of `TelemetryUpdate` samples (via
  `lap.get_telemetry()`, so car data and X/Y position data are already
  merged onto one time index), ready for `historicalAdapter.js` to
  `fetch()` and replay.
- `<slug>.meta.json` — lap metadata (driver, lap number, lap/sector times,
  compound) for later UI use — not required by the adapter today.

First run downloads and caches session data into `.cache/` (gitignored);
later runs against the same session reuse the cache.

## Validate before wiring in a new file

```
node validate_output.mjs ../public/data/<slug>.json
```

Checks every sample against the `TelemetryUpdate` field list, types, and
sane ranges, and exits non-zero on any violation.

## Field mapping

See [`../docs/DATA_SHAPE.md`](../docs/DATA_SHAPE.md) and
[`../docs/ROADMAP.md`](../docs/ROADMAP.md) (Phase A3) for the brake
(bool-vs-analog) and DRS (enum-vs-boolean) normalization rules applied in
`fetch_session.py`. `sector` is derived (not a raw fastf1 field) from the
lap's own `LapStartDate` + cumulative `Sector1Time`/`Sector2Time` —
verified against real data: sector sample-count proportions matched the
real sector-time ratios almost exactly (e.g. sector 2 being the longest
sector showed up as the largest share of samples). `x`/`y` come from
`lap.get_telemetry()` rather than `lap.get_car_data()` — that method
merges car data with position data by interpolating over a shared time
index, which is also why sample counts went from ~350 to ~700+ per lap.

**Verified against real data (2023 Bahrain GP, Race):** the `{10, 12, 14}`
"DRS open" code set is correct per fastf1's own encoding, but across a full
race those codes are rare relative to `0`/`1`/`8` — a single ~350-sample
lap can easily contain zero of them, especially for a race leader (DRS
needs a car ahead within a second, which a leader rarely has). A lap with
`drs: false` throughout is expected, not a mapping bug — don't "fix" it
without checking the raw `DRS` column first.
