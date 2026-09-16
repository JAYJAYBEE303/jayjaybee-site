"""
Pull one lap of car telemetry via fastf1 and normalize it to the shared
TelemetryUpdate shape (see ../src/lib/telemetryShape.js and
../docs/DATA_SHAPE.md). Writes a plain JSON array of samples that
historicalAdapter.js can fetch()/replay directly — no wrapper object,
no extra keys, so it's a drop-in for the existing fixture-replay loop.

One-shot script: runs, writes files, exits. Not part of `npm run build`;
run manually whenever a new lap is needed.

Usage:
    python fetch_session.py --year 2023 --gp Bahrain --session R \
        --driver VER --lap fastest

Field mapping notes (see docs/ROADMAP.md Phase A3 for the "why"):
  - Brake:  fastf1 gives a bool in older seasons, an analog 0-100 in
            newer ones. Both are normalized to 0-100 here.
  - DRS:    fastf1 is an enum (0,1,2,8,10,12,14,...), not a boolean.
            Only 10/12/14 mean "open" -- see docs/DATA_SHAPE.md.
  - Distance: fastf1's add_distance() already gives meters -> lapDistance.
  - Date:   used as the timestamp source (absolute wall-clock, ms epoch).
"""

import argparse
import json
import sys
from pathlib import Path

import fastf1
import pandas as pd

PIPELINE_DIR = Path(__file__).resolve().parent
CACHE_DIR = PIPELINE_DIR / ".cache"
OUT_DIR = PIPELINE_DIR.parent / "public" / "data"

# DRS status codes that mean "open" per fastf1's car-data channel.
# See docs/DATA_SHAPE.md for the full reasoning.
DRS_OPEN_CODES = {10, 12, 14}


def normalize_brake(series: pd.Series) -> pd.Series:
    """Map fastf1's Brake channel (bool OR analog 0-100) onto 0-100."""
    if series.dtype == bool:
        return series.astype(int) * 100
    return series.clip(lower=0, upper=100).round().astype(int)


def normalize_drs(series: pd.Series) -> pd.Series:
    """Map fastf1's DRS status-code enum onto a plain open/closed bool."""
    return series.isin(DRS_OPEN_CODES)


def to_epoch_ms(series: pd.Series) -> pd.Series:
    """Convert a pandas datetime column to integer ms-since-epoch."""
    return (series.astype("int64") // 1_000_000).astype("int64")


def build_samples(car_data: pd.DataFrame) -> list[dict]:
    """Transform one lap's car_data into a list of TelemetryUpdate dicts."""
    frame = pd.DataFrame(
        {
            "timestamp": to_epoch_ms(car_data["Date"]),
            "speed": car_data["Speed"].round().astype(int),
            "throttle": car_data["Throttle"].clip(0, 100).round().astype(int),
            "brake": normalize_brake(car_data["Brake"]),
            "gear": car_data["nGear"].astype(int),
            "rpm": car_data["RPM"].astype(int),
            "drs": normalize_drs(car_data["DRS"]),
            "lapDistance": car_data["Distance"].round(1),
        }
    )
    return json.loads(frame.to_json(orient="records"))


def fetch_lap(year: int, gp: str, session_code: str, driver: str, lap_selector: str):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(str(CACHE_DIR))

    session = fastf1.get_session(year, gp, session_code)
    session.load(telemetry=True, laps=True, weather=False, messages=False)

    driver_laps = session.laps.pick_drivers(driver)
    if driver_laps.empty:
        raise SystemExit(f"No laps found for driver '{driver}' in {year} {gp} {session_code}")

    if lap_selector == "fastest":
        lap = driver_laps.pick_fastest()
    else:
        lap_number = int(lap_selector)
        matched = driver_laps[driver_laps["LapNumber"] == lap_number]
        if matched.empty:
            raise SystemExit(f"Lap {lap_number} not found for driver '{driver}'")
        lap = matched.iloc[0]

    car_data = lap.get_car_data().add_distance()
    samples = build_samples(car_data)

    meta = {
        "year": year,
        "grandPrix": gp,
        "session": session_code,
        "driver": driver,
        "lapNumber": int(lap["LapNumber"]),
        "lapTime": format_laptime(lap["LapTime"]),
        "compound": lap.get("Compound"),
        "sampleCount": len(samples),
    }
    return samples, meta


def format_laptime(lap_time) -> str | None:
    """Format a pandas Timedelta as 'M:SS.mmm' instead of '0 days 00:01:36.236000'."""
    if pd.isna(lap_time):
        return None
    total_seconds = lap_time.total_seconds()
    minutes, seconds = divmod(total_seconds, 60)
    return f"{int(minutes)}:{seconds:06.3f}"


def slugify(year: int, gp: str, session_code: str, driver: str) -> str:
    gp_slug = str(gp).lower().replace(" ", "-")
    return f"{year}-{gp_slug}-{session_code.lower()}-{driver.lower()}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--gp", type=str, required=True, help="Grand Prix name, e.g. 'Bahrain'")
    parser.add_argument("--session", type=str, required=True, help="R, Q, FP1, FP2, FP3, S, SQ")
    parser.add_argument("--driver", type=str, required=True, help="Three-letter driver code, e.g. VER")
    parser.add_argument("--lap", type=str, default="fastest", help="'fastest' or a lap number")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Fetching {args.year} {args.gp} {args.session} - {args.driver}, lap={args.lap}...")
    samples, meta = fetch_lap(args.year, args.gp, args.session, args.driver, args.lap)

    slug = slugify(args.year, args.gp, args.session, args.driver)
    samples_path = args.out_dir / f"{slug}.json"
    meta_path = args.out_dir / f"{slug}.meta.json"

    samples_path.write_text(json.dumps(samples, indent=2), encoding="utf-8")
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"Wrote {len(samples)} samples -> {samples_path}")
    print(f"Wrote lap metadata -> {meta_path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # surface a clean message instead of a raw traceback
        print(f"fetch_session.py failed: {exc}", file=sys.stderr)
        sys.exit(1)
