"""Build a SIMULATED battery-depletion failure flight for the replay app.

This is not CMU data. It takes the real path of flight 142 (R1, 8 m/s, 250 g, 75 m) and
changes only the battery story, so the failure is a labelled scenario we control:

  1. The pack starts partly depleted (START_V, inside the 20.9-25.9 V range seen in the
     real flights) and falls faster than the real one (EXTRA_V_PER_WH, on top of the real
     voltage trace) until it crosses the assumed low-voltage cutoff (CUTOFF_V = 6S x 3.3 V).
  2. At the cutoff the motors lose power. Current drops to avionics level and the voltage
     rebounds once the load is gone.
  3. The airframe then falls with quadratic drag (terminal speed FALL_VT) while horizontal
     speed decays (DRAG_K), until it reaches launch height. Flat ground is assumed.

Assumptions are guesses, not measurements: the cutoff, terminal speed and drag constant are
not in the dataset. Writes web/public/data/flights/900.json and adds or replaces id 900 in
web/public/data/index.json. "npm run data" runs it after rebuilding the index.

Usage: python3 scripts/make_sim_failure.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

DATA = Path("web/public/data")
SOURCE_ID = 142
SIM_ID = 900

START_V = 24.0  # V, a typical start (real starts run 20.87-25.89)
EXTRA_V_PER_WH = 0.12  # V per Wh of extra sag, i.e. a tired pack (fitted real slope is 0.044)
CUTOFF_V = 19.8  # assumed 6S low-voltage cutoff
AVIONICS_A = 0.2  # current once the motors are cut
REBOUND_V = 20.9  # unloaded voltage just after cutoff
G = 9.81
FALL_VT = 20.0  # m/s, assumed terminal speed
DRAG_K = 0.25  # 1/s, horizontal speed decay
DT = 0.1  # s, sample spacing after cutoff
HOLD_S = 3.0  # s, record after impact


def r(x, n=2):
    return round(float(x), n)


def main() -> None:
    src = json.loads((DATA / "flights" / f"{SOURCE_ID}.json").read_text())
    n = len(src["t"])
    v0 = src["voltage"][0]

    out = {k: [] for k in src}
    cut = None
    # 5 s moving average, so one noisy dip can't trip the cutoff
    w = max(1, round(n / src["t"][-1] * 5))
    smooth = [sum(src["voltage"][max(0, i - w) : i + w + 1]) / len(src["voltage"][max(0, i - w) : i + w + 1]) for i in range(n)]
    for i in range(n):
        v = smooth[i] - (v0 - START_V) - EXTRA_V_PER_WH * src["energyWh"][i]
        if v <= CUTOFF_V:
            cut = i
            break
        for k in src:
            out[k].append(src[k][i])
        out["voltage"][-1] = r(v, 3)
    if cut is None:
        raise SystemExit("Battery never reached the cutoff; raise EXTRA_V_PER_WH or lower START_V.")

    t_cut = out["t"][-1]
    e, nn, up = out["east"][-1], out["north"][-1], out["up"][-1]
    spd = max(out["groundSpeed"][-1], 0.0)
    # Travel direction from the last stretch of the real path
    j = max(0, len(out["t"]) - 8)
    de, dn = e - out["east"][j], nn - out["north"][j]
    norm = math.hypot(de, dn) or 1.0
    ue, un = de / norm, dn / norm
    heading, wind, wang = out["heading"][-1], out["windSpeed"][-1], out["windAngle"][-1]
    dist, energy = out["dist"][-1], out["energyWh"][-1]

    alt_cut = up
    t, vz, vh = t_cut, 0.0, spd
    landed_at = None
    while landed_at is None or t < landed_at + HOLD_S:
        t += DT
        if landed_at is None:
            vz += (-G + G * (vz / FALL_VT) ** 2) * DT
            up += vz * DT
            vh *= math.exp(-DRAG_K * DT)
            step = vh * DT
            e, nn, dist = e + ue * step, nn + un * step, dist + step
            if up <= 0:
                up, vz, vh, landed_at = 0.0, 0.0, 0.0, t
        else:
            vh = 0.0
        v = REBOUND_V
        cur = AVIONICS_A
        energy += v * cur * DT / 3600
        out["t"].append(r(t, 3))
        out["east"].append(r(e))
        out["north"].append(r(nn))
        out["up"].append(r(up))
        out["heading"].append(heading)
        out["voltage"].append(r(v, 3))
        out["current"].append(cur)
        out["power"].append(r(v * cur, 1))
        out["energyWh"].append(r(energy, 4))
        out["dist"].append(r(dist, 1))
        out["groundSpeed"].append(r(vh))
        out["windSpeed"].append(wind)
        out["windAngle"].append(wang)

    (DATA / "flights" / f"{SIM_ID}.json").write_text(json.dumps(out, separators=(",", ":")))

    index = json.loads((DATA / "index.json").read_text())
    base = next(f for f in index["flights"] if f["id"] == SOURCE_ID)
    meta = {
        **base,
        "id": SIM_ID,
        "date": "",
        "time": "",
        "durationS": r(out["t"][-1], 1),
        "energyWh": r(out["energyWh"][-1]),
        "pathM": r(out["dist"][-1], 1),
        "maxGapS": 0,
        "startVoltage": r(out["voltage"][0], 2),
        "simulated": True,
        "outcome": "Battery cutoff, power lost, crash",
        "failureS": r(t_cut, 1),
        "failureAltM": r(alt_cut, 1),
    }
    index["flights"] = [f for f in index["flights"] if f["id"] != SIM_ID] + [meta]
    (DATA / "index.json").write_text(json.dumps(index, indent=1))
    print(f"Cutoff at {t_cut:.1f} s ({alt_cut:.0f} m up, {spd:.1f} m/s); "
          f"impact at {landed_at:.1f} s; {len(out['t'])} samples, start {out['voltage'][0]:.2f} V")


if __name__ == "__main__":
    main()
