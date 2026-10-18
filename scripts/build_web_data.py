"""Convert the raw CMU drone CSV into compact per-flight JSON for the web app.

Reads the untouched raw copy in data/raw/cmu_drone/ and writes:
  web/public/data/index.json            flight metadata list
  web/public/data/flights/<id>.json     columnar time series for one flight

Positions are converted from lon/lat/altitude to local metres (east, north, up)
relative to the launch point. Heading comes from the orientation quaternion:
in this dataset yaw runs counter-clockwise from magnetic north, and Pittsburgh's
declination is about -7 deg, so true heading = -yaw - 7 (checked against the
direction of travel on cruise legs).

Ground tests (routes A1-A3) are skipped since the drone never leaves the ground.

Usage: python3 scripts/build_web_data.py [raw_dir] [out_dir]
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
OUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else "web/public/data")

M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON_EQ = 111_320.0
DECLINATION_DEG = -7.0


def rounded(a: np.ndarray, places: int) -> list:
    return np.round(a.astype(float), places).tolist()


def build_flight(g: pd.DataFrame) -> tuple[dict, dict]:
    g = g.sort_values("time")
    t = g["time"].to_numpy() - g["time"].iloc[0]
    lat0 = g["position_y"].iloc[:10].mean()
    lon0 = g["position_x"].iloc[:10].mean()
    alt0 = g["position_z"].iloc[:10].mean()
    east = (g["position_x"].to_numpy() - lon0) * M_PER_DEG_LON_EQ * np.cos(np.radians(lat0))
    north = (g["position_y"].to_numpy() - lat0) * M_PER_DEG_LAT
    up = g["position_z"].to_numpy() - alt0

    x, y, z, w = (g[f"orientation_{c}"].to_numpy() for c in "xyzw")
    yaw = np.degrees(np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))
    heading = (-yaw + DECLINATION_DEG) % 360

    volts = g["battery_voltage"].to_numpy()
    amps = g["battery_current"].to_numpy()
    power = volts * amps
    energy_wh = np.concatenate([[0.0], np.cumsum(np.diff(t) * (power[1:] + power[:-1]) / 2)]) / 3600

    step = np.hypot(np.diff(east), np.diff(north))
    dist = np.concatenate([[0.0], np.cumsum(step)])
    dt = np.gradient(t)
    ground_speed = np.hypot(np.gradient(east), np.gradient(north)) / np.where(dt > 0, dt, np.nan)
    ground_speed = pd.Series(ground_speed).rolling(5, center=True, min_periods=1).mean().fillna(0).to_numpy()

    first = g.iloc[0]
    meta = {
        "id": int(first["flight"]),
        "route": first["route"],
        "speed": float(first["speed"]),
        "payload": float(first["payload"]),
        "altitude": str(first["altitude"]),
        "date": first["date"],
        "time": first["time_day"],
        "durationS": round(float(t[-1]), 1),
        "energyWh": round(float(energy_wh[-1]), 2),
        "pathM": round(float(dist[-1]), 1),
        "maxUpM": round(float(up.max()), 1),
        "maxGapS": round(float(np.diff(t).max()), 2),
        "startVoltage": round(float(volts[:10].mean()), 2),
        # Launch point, so the app can place the flight on a real map.
        "origin": {"lat": round(float(lat0), 7), "lon": round(float(lon0), 7), "altM": round(float(alt0), 1)},
    }
    series = {
        "t": rounded(t, 2),
        "east": rounded(east, 2),
        "north": rounded(north, 2),
        "up": rounded(up, 2),
        "heading": rounded(heading, 1),
        "voltage": rounded(volts, 3),
        "current": rounded(amps, 3),
        "power": rounded(power, 1),
        "energyWh": rounded(energy_wh, 4),
        "dist": rounded(dist, 1),
        "groundSpeed": rounded(ground_speed, 2),
        "windSpeed": rounded(g["wind_speed"].to_numpy(), 2),
        "windAngle": rounded(g["wind_angle"].to_numpy(), 1),
    }
    return meta, series


def main() -> None:
    df = pd.read_csv(RAW_DIR / "flights.csv", dtype={"altitude": str})
    df = df[~df["route"].str.startswith("A")]
    flights_dir = OUT_DIR / "flights"
    flights_dir.mkdir(parents=True, exist_ok=True)

    index = []
    for _, g in df.groupby("flight"):
        meta, series = build_flight(g)
        with open(flights_dir / f"{meta['id']}.json", "w") as f:
            json.dump(series, f, separators=(",", ":"))
        index.append(meta)

    index.sort(key=lambda m: (m["date"], m["time"].zfill(5), m["id"]))
    with open(OUT_DIR / "index.json", "w") as f:
        json.dump(
            {
                "source": {
                    "title": "Data Collected with Package Delivery Quadcopter Drone",
                    "authors": "Rodrigues et al., Carnegie Mellon University",
                    "doi": "10.1184/R1/12683453.v1",
                    "url": "https://kilthub.cmu.edu/articles/dataset/Data_Collected_with_Package_Delivery_Quadcopter_Drone/12683453",
                    "license": "CC BY 4.0",
                    "note": "Derived: positions converted to local metres, cumulative energy integrated from voltage x current.",
                },
                "flights": index,
            },
            f,
            indent=1,
        )
    print(f"wrote {len(index)} flights to {OUT_DIR}")


if __name__ == "__main__":
    main()
