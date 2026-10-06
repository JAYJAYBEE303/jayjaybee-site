"""
Pull one lap of car+position telemetry via fastf1 and normalize it to the
shared TelemetryUpdate shape (see ../src/lib/telemetryShape.js and
../docs/DATA_SHAPE.md). Writes a plain JSON array of samples that
historicalAdapter.js can fetch()/replay directly — no wrapper object,
no extra keys, so it's a drop-in for the existing fixture-replay loop.

One-shot script: runs, writes files, exits. Not part of `npm run build`;
run manually whenever a new lap is needed.

Usage:
    python fetch_session.py --year 2023 --gp Bahrain --session R \
        --driver VER --lap fastest

Field mapping notes (see docs/ROADMAP.md Phase A3 and docs/DATA_SHAPE.md
for the "why" on each of these):
  - Brake:  fastf1 gives a bool in older seasons, an analog 0-100 in
            newer ones. Both are normalized to 0-100 here.
  - DRS:    fastf1 is an enum (0,1,2,8,10,12,14,...), not a boolean.
            Only 10/12/14 mean "open".
  - X/Y:    lap.get_telemetry() (not get_car_data()) merges car data with
            position data by interpolating over a shared time index, so
            every sample carries a matching (x, y) alongside speed/etc.
            Units are metres in fastf1's local track-relative frame — not
            GPS lat/lon, but real physical scale, fine for drawing a
            to-scale track outline.
  - sector: not a raw fastf1 channel. Derived per-sample by comparing the
            sample's timestamp against the lap's official sector-time
            boundaries (LapStartDate + cumulative Sector1Time/Sector2Time),
            so it lines up with the same sector splits timing screens show.
  - Distance: get_telemetry() adds this (and RelativeDistance) already.
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


def compute_sectors(dates: pd.Series, lap) -> pd.Series:
    """
    Map each sample's Date to a sector number (1, 2, or 3) using the lap's
    own official sector-time boundaries, so this lines up with the same
    splits a timing screen would show — not a guess from track distance.
    """
    lap_start = lap["LapStartDate"]
    sector1_end = lap_start + lap["Sector1Time"]
    sector2_end = sector1_end + lap["Sector2Time"]

    def sector_for(date):
        if pd.isna(date):
            return 1
        if date < sector1_end:
            return 1
        if date < sector2_end:
            return 2
        return 3

    return dates.apply(sector_for)


def build_samples(telemetry: pd.DataFrame, lap) -> list[dict]:
    """Transform one lap's merged car+position telemetry into a list of
    TelemetryUpdate dicts."""
    # get_telemetry() can leave a few NaN rows at the interpolation edges;
    # drop them rather than ship a sample with missing fields.
    telemetry = telemetry.dropna(
        subset=["Date", "Speed", "Throttle", "Brake", "nGear", "RPM", "DRS", "Distance", "X", "Y"]
    ).reset_index(drop=True)

    frame = pd.DataFrame(
        {
            "timestamp": to_epoch_ms(telemetry["Date"]),
            "speed": telemetry["Speed"].round().astype(int),
            "throttle": telemetry["Throttle"].clip(0, 100).round().astype(int),
            "brake": normalize_brake(telemetry["Brake"]),
            "gear": telemetry["nGear"].astype(int),
            "rpm": telemetry["RPM"].astype(int),
            "drs": normalize_drs(telemetry["DRS"]),
            "lapDistance": telemetry["Distance"].round(1),
            "sector": compute_sectors(telemetry["Date"], lap).astype(int),
            "x": telemetry["X"].round(1),
            "y": telemetry["Y"].round(1),
        }
    )
    return json.loads(frame.to_json(orient="records"))


def format_laptime(lap_time) -> str | None:
    """Format a pandas Timedelta as 'M:SS.mmm' instead of '0 days 00:01:36.236000'."""
    if pd.isna(lap_time):
        return None
    total_seconds = lap_time.total_seconds()
    minutes, seconds = divmod(total_seconds, 60)
    return f"{int(minutes)}:{seconds:06.3f}"


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

    telemetry = lap.get_telemetry()
    samples = build_samples(telemetry, lap)

    meta = {
        "year": year,
        "grandPrix": gp,
        "session": session_code,
        "driver": driver,
        "lapNumber": int(lap["LapNumber"]),
        "lapTime": format_laptime(lap["LapTime"]),
        "sector1Time": format_laptime(lap["Sector1Time"]),
        "sector2Time": format_laptime(lap["Sector2Time"]),
        "sector3Time": format_laptime(lap["Sector3Time"]),
        "compound": lap.get("Compound"),
        "sampleCount": len(samples),
    }
    return samples, meta


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
