"""Initial exploration of the CMU package-delivery quadcopter dataset.

Reads the untouched raw copy in data/raw/cmu_drone/ and writes:
  results/exploration/flight_summary.csv   one row per flight (energy, duration, conditions)
  results/exploration/exploration.json     dataset-level facts for the data manifest

Usage: python3 scripts/explore_cmu_drone.py [raw_dir] [out_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
OUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else "results/exploration")


def flight_summary(g: pd.DataFrame) -> pd.Series:
    t = g["time"].to_numpy()
    v = g["battery_voltage"].to_numpy()
    i = g["battery_current"].to_numpy()
    power = v * i  # W
    dt = np.diff(t)
    energy_j = np.trapezoid(power, t)
    # Horizontal ground distance from integrated velocity (NED frame, m/s).
    vxy = np.hypot(g["velocity_x"].to_numpy(), g["velocity_y"].to_numpy())
    dist_m = np.trapezoid(vxy, t)
    return pd.Series(
        {
            "rows": len(g),
            "duration_s": t[-1] - t[0],
            "median_dt_s": np.median(dt) if len(dt) else np.nan,
            "max_gap_s": dt.max() if len(dt) else np.nan,
            "non_monotonic_steps": int((dt <= 0).sum()),
            "energy_wh": energy_j / 3600.0,
            "mean_power_w": power.mean(),
            "peak_power_w": power.max(),
            "min_current_a": i.min(),
            "start_voltage_v": v[:10].mean(),
            "end_voltage_v": v[-10:].mean(),
            "ground_dist_m": dist_m,
            "max_rel_alt_m": g["position_z"].max() - g["position_z"].iloc[:10].mean(),
            "mean_wind_speed_ms": g["wind_speed"].mean(),
            "max_wind_speed_ms": g["wind_speed"].max(),
        }
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    params = pd.read_csv(RAW_DIR / "parameters.csv", dtype={"altitude": str})
    # altitude is mostly numeric but two R7 flights use a profile like "25-50-100-25".
    df = pd.read_csv(RAW_DIR / "flights.csv", dtype={"altitude": str})

    per_flight = df.groupby("flight", sort=True).apply(flight_summary, include_groups=False)
    meta_cols = ["speed", "payload", "altitude", "date", "time_day", "route"]
    meta = df.groupby("flight")[meta_cols].first()
    summary = meta.join(per_flight).reset_index()
    summary["is_cruise_flight"] = summary["route"].str.match(r"^R\d$")
    summary["energy_wh_per_km"] = np.where(
        summary["ground_dist_m"] > 50,
        summary["energy_wh"] / (summary["ground_dist_m"] / 1000.0),
        np.nan,
    )
    summary.to_csv(OUT_DIR / "flight_summary.csv", index=False)

    cruise = summary[summary["is_cruise_flight"]]
    dates = pd.to_datetime(summary["date"])
    facts = {
        "flights_csv_rows": int(len(df)),
        "flights_csv_columns": list(df.columns),
        "parameters_csv_rows": int(len(params)),
        "flights_in_flights_csv": int(df["flight"].nunique()),
        "flight_ids_only_in_parameters": sorted(set(params["flight"]) - set(df["flight"])),
        "flight_ids_only_in_flights_csv": sorted(set(df["flight"]) - set(params["flight"])),
        "missing_values_per_column": {c: int(n) for c, n in df.isna().sum().items() if n},
        "duplicate_rows": int(df.duplicated().sum()),
        "route_counts": summary["route"].value_counts().sort_index().to_dict(),
        "cruise_flights": int(len(cruise)),
        "date_range": [str(dates.min().date()), str(dates.max().date())],
        "distinct_flight_days": int(dates.nunique()),
        "flights_per_month": summary.assign(m=dates.dt.strftime("%Y-%m"))["m"].value_counts().sort_index().to_dict(),
        "parameter_levels": {
            c: sorted(summary[c].dropna().unique().tolist(), key=lambda x: (isinstance(x, str) and not x.isdigit(), float(x) if str(x).replace(".", "").isdigit() else 0, str(x))) for c in ["speed", "payload", "altitude"]
        },
        "median_sample_interval_s": float(summary["median_dt_s"].median()),
        "flights_with_non_monotonic_time": int((summary["non_monotonic_steps"] > 0).sum()),
        "flights_with_gap_over_2s": int((summary["max_gap_s"] > 2).sum()),
        "flights_with_negative_current": int((summary["min_current_a"] < 0).sum()),
        "cruise_energy_wh": cruise["energy_wh"].describe().round(3).to_dict(),
        "cruise_duration_s": cruise["duration_s"].describe().round(1).to_dict(),
        "cruise_energy_wh_by_payload": cruise.groupby("payload")["energy_wh"].mean().round(2).to_dict(),
        "cruise_energy_wh_by_speed": cruise.groupby("speed")["energy_wh"].mean().round(2).to_dict(),
        "cruise_energy_wh_by_altitude": cruise.groupby("altitude")["energy_wh"].mean().round(2).to_dict(),
    }
    with open(OUT_DIR / "exploration.json", "w") as f:
        json.dump(facts, f, indent=2, default=str)
    print(json.dumps(facts, indent=2, default=str))


if __name__ == "__main__":
    main()
