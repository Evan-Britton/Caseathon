"""Export the model's training envelope for the replay app's 3D envelope view.

The energy model only knows the conditions it was trained on. This writes each real
cruise flight's mission conditions, so the app can draw the envelope they span and check
a planned mission against it before launch:

  payload  package weight, g (the flight plan)
  speed    planned cruise speed, m/s (the flight plan)
  wind     mean onboard anemometer reading while the rotors spin, m/s. The anemometer
           mixes the wind with the drone's own motion, so this is airflow, not pure wind.

A mission is inside the envelope when every condition is within the trained range AND a
real training flight flew similar conditions. The second test catches empty corners of the
box: the only 750 g flight flew at 4 m/s, so 750 g at 12 m/s is in range on both axes but
nothing like it was ever flown. "Similar" means within half a step of the CMU test plan on
every axis at once: payloads were flown in 250 g steps and speeds in 2 m/s steps, so a
flight within 125 g, 1 m/s and 1 m/s of wind.

Also written, for contrast:
  synthetic  the operator console's SYNTHETIC heavy-payload flights (1.0-1.2 kg), with the
             speed and wind of the real flight each was made from
  injected   a SIMULATED illustration of deliberately poisoned records: made-up conditions
             far outside the envelope, the kind an attacker could slip into the training
             feed. They are not part of any measured result.

Writes web/public/data/envelope.json.

Usage: python3 scripts/export_web_envelope.py [raw_dir] [web_data_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hybrid_model as hm  # noqa: E402

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
WEB_DATA = Path(sys.argv[2] if len(sys.argv) > 2 else "web/public/data")

AXES = ["payload", "speed", "wind"]
# Half a step of the CMU test plan on each axis: how close a training flight must be to count as similar.
NEAR = {"payload": 125.0, "speed": 1.0, "wind": 1.0}

# SIMULATED poisoned records (payload g, speed m/s, wind m/s): hand-picked conditions well
# outside what CMU flew, one or two axes at a time, so each shows a different way out.
INJECTED = [
    (1400.0, 6.0, 5.2),
    (250.0, 15.0, 6.1),
    (500.0, 8.0, 12.5),
    (0.0, 4.0, 11.0),
    (1100.0, 14.0, 9.0),
    (900.0, 10.0, 13.0),
    (650.0, 2.0, 1.5),
]


def r(x: float, n: int = 2) -> float:
    return round(float(x), n)


def main() -> None:
    df = hm.load_cruise_flights(RAW_DIR)
    power = df["battery_voltage"] * df["battery_current"]
    airborne = df[power > hm.MOTOR_ON_W]
    per = airborne.groupby("flight").agg(
        payload=("payload", "first"),
        speed=("speed", "first"),
        altitude=("altitude", "first"),
        route=("route", "first"),
        wind=("wind_speed", "mean"),
    )
    flights = [
        {"id": int(fid), "payload": r(row.payload, 0), "speed": r(row.speed, 1), "wind": r(row.wind), "altitude": str(row.altitude), "route": row.route}
        for fid, row in per.iterrows()
    ]

    X = per[AXES].to_numpy(dtype=float)
    lo, hi = X.min(axis=0), X.max(axis=0)

    synth_index = json.loads((WEB_DATA / "synthetic.json").read_text())
    synthetic = []
    for f in synth_index["flights"]:
        src = int(f["synthetic"]["basedOn"])
        synthetic.append(
            {
                "id": int(f["id"]),
                "basedOn": src,
                "payload": r(f["payload"], 0),
                "speed": r(f["speed"], 1),
                "wind": r(per.loc[src, "wind"]),
            }
        )

    out = {
        "note": "Real CMU cruise flights: the conditions the energy model was trained on. Wind is the mean onboard anemometer reading while the rotors spin, which mixes wind with the drone's own motion.",
        "axes": {
            "payload": {"label": "Payload", "unit": "g"},
            "speed": {"label": "Speed", "unit": "m/s"},
            "wind": {"label": "Wind", "unit": "m/s"},
        },
        "ranges": {k: [r(lo[i]), r(hi[i])] for i, k in enumerate(AXES)},
        "near": NEAR,
        "flights": flights,
        "synthetic": synthetic,
        "syntheticNote": synth_index["note"],
        "injected": [{"payload": p, "speed": s, "wind": w} for p, s, w in INJECTED],
        "injectedNote": "SIMULATED illustration of deliberately poisoned records: made-up conditions far outside the envelope. Not part of any measured result.",
    }
    path = WEB_DATA / "envelope.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"wrote {path}: {len(flights)} flights, ranges {out['ranges']}")


if __name__ == "__main__":
    main()
