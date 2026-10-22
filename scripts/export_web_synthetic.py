"""Export SYNTHETIC heavy-payload flights for the operator console.

The question: what happens when operations start carrying heavier packages than the model has
ever seen, and its training data is poisoned on top? The CMU data tops out at 500 g (one flight
at 750 g), so the heavier flights are SYNTHETIC: a real recorded flight is re-run at a heavier
payload by scaling its battery current while the motors run, with everything else (route, speed,
altitude, wind, timing) as recorded.

The scaling rule is fitted on the real data, not assumed. Power rises with total mass as
    P_new = P_recorded x ((M0 + payload_new) / (M0 + payload_recorded)) ** b
with M0 = 2355 g (DJI Matrice 100 with its TB47D battery, DJI spec) and b fitted across the real
0-500 g flights, comparing flights flown at the same speed, altitude and route. It is then
checked on the one real 750 g flight, which the fit never saw. Battery voltage is left as
recorded (extra voltage sag under the heavier load is not modelled).

Payloads stay within the aircraft's limits: 3600 g maximum take-off weight (CMU dataset README)
leaves about 1245 g for the package.

Source flights come from window 7, the newest simulated window, so no model below has trained on
them at any payload. Each is forecast by the window-7 models from results/countermeasure (seed 0),
for every training-data condition, with and without the sensor fix, exactly as the poisoning lab.

Each flight's battery (usable energy for the mission) is set by a stated rule from the launch
forecasts, not tuned to an outcome:
  between      halfway between the poisoned ("Both") and the clean model's launch P90
  above_clean  0.8 Wh above the clean model's launch P90

Writes, next to the real flights (ids 1001+ never clash with CMU ids):
  web/public/data/flights/<id>.json            the synthetic series
  web/public/data/model/flights/<id>.json      forecast in the app's standard format (clean model)
  web/public/data/scenarios/flights/<id>.json  forecasts for every condition, with and without the fix
  web/public/data/synthetic.json               what each flight is, how it was made, the scaling check

Usage: python3 scripts/export_web_synthetic.py [raw_dir] [web_data_dir]
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_web_data as bwd  # noqa: E402
import countermeasure as cm  # noqa: E402
import degrade as dg  # noqa: E402
import hybrid_model as hm  # noqa: E402
from export_web_scenarios import CONDITIONS, STALE_AFTER, key, r  # noqa: E402

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
WEB_DATA = Path(sys.argv[2] if len(sys.argv) > 2 else "web/public/data")

SEED = 0
WINDOW = 7
M0_G = 2355.0  # DJI Matrice 100 with TB47D battery
MAX_TAKEOFF_G = 3600.0
CHECK_FLIGHT = 76  # the one real 750 g flight
# (synthetic id, source flight, payload g, battery rule)
SYNTH = [
    (1001, 97, 1200, "between"),
    (1002, 184, 1200, "between"),
    (1003, 126, 1000, "above_clean"),
]


def mean_power(df: pd.DataFrame) -> pd.DataFrame:
    """Per flight: plan settings and mean electrical power while cruising (30 s in from each end of motor time)."""
    rows = []
    for fid, g in df.groupby("flight"):
        p = (g["battery_voltage"] * g["battery_current"]).to_numpy()
        on = np.flatnonzero(p > hm.MOTOR_ON_W)
        if len(on) < 80:
            continue
        t = g["time"].to_numpy()
        mid = p[on[30]:on[-30]]
        f = g.iloc[0]
        rows.append({"flight": fid, "payload": float(f["payload"]), "group": f"{f['speed']}/{f['altitude']}/{f['route']}",
                     "p_mean": float(mid.mean()), "energy": float(np.trapezoid(p[on], t[on]) / 3600)})
    return pd.DataFrame(rows)


def fit_exponent(pw: pd.DataFrame) -> tuple[float, int]:
    """b in log P = c_group + b log(M0 + payload), fitted within speed/altitude/route groups on 0-500 g flights."""
    fit = pw[pw["payload"] <= 500].assign(lp=lambda d: np.log(d["p_mean"]), lm=lambda d: np.log(M0_G + d["payload"]))
    dm = fit.groupby("group")[["lp", "lm"]].transform("mean")
    x, y = fit["lm"] - dm["lm"], fit["lp"] - dm["lp"]
    return float((x * y).sum() / (x * x).sum()), len(fit)


def factor(payload_from: float, payload_to: float, b: float) -> float:
    return ((M0_G + payload_to) / (M0_G + payload_from)) ** b


def check_on_750(pw: pd.DataFrame, b: float) -> dict:
    """Scale each lighter flight in flight 76's group up to 750 g and compare energy with the real flight."""
    real = pw[pw["flight"] == CHECK_FLIGHT].iloc[0]
    peers = pw[(pw["group"] == real["group"]) & (pw["payload"] < 750)]
    err = [(p["energy"] * factor(p["payload"], 750, b) / real["energy"] - 1) * 100 for _, p in peers.iterrows()]
    return {"flight": CHECK_FLIGHT, "peers": len(err), "energyErrPct": {"min": round(min(err), 1), "mean": round(float(np.mean(err)), 1), "max": round(max(err), 1)}}


def scale_payload(g: pd.DataFrame, new_id: int, payload: float, b: float) -> tuple[pd.DataFrame, float]:
    g = g.copy()
    k = factor(float(g["payload"].iloc[0]), payload, b)
    motors = g["battery_voltage"] * g["battery_current"] > hm.MOTOR_ON_W
    g.loc[motors, "battery_current"] *= k
    g["payload"] = float(payload)
    g["flight"] = new_id
    return g, k


def main() -> None:
    df = hm.load_cruise_flights(RAW_DIR)
    flights = hm.flight_table(df)
    rl = hm.route_lengths(df)

    pw = mean_power(df)
    b, n_fit = fit_exponent(pw)
    check = check_on_750(pw, b)
    print(f"payload exponent b = {b:.3f} from {n_fit} flights; 750 g check: {check['energyErrPct']}", flush=True)

    print("training the window-7 models...", flush=True)
    cp_a = hm.build_checkpoints(df, rl)
    bounds = hm.motor_bounds(cp_a)
    timeline = dg.simulated_timeline(flights, SEED)
    cp_a["order"] = cp_a["flight"].map(timeline["sim_order"])
    cp_b = hm.build_checkpoints(dg.corrupt_current(df, dg.B_CURRENT_FACTOR, dg.B_NOISE_SD_A, SEED), rl, dg.B_CHECKPOINT_STEP_S, bounds)
    sources = dg.assign_sources(timeline, dg.low_quality_share, SEED)
    all_a = pd.Series("A", index=timeline.index)
    ref_ids = cm.reference_flights(timeline, cm.N_REF_PER_WINDOW, SEED)
    models, trained_max = {}, {}
    for cond, spec in CONDITIONS.items():
        src = sources if spec["low_quality"] else all_a
        pool = dg.training_pool(cp_a, cp_b, timeline, src, WINDOW, spec["stale_after"])
        models[key(cond, False)] = hm.EnergyModel("hybrid", SEED).fit(pool)
        trained_max[key(cond, False)] = float(pool["payload"].max())
        pool, weight, _, _ = cm.protected_pool(cp_a, cp_b, timeline, src, WINDOW, spec["stale_after"], ref_ids)
        models[key(cond, True)] = cm.TrustedModel(SEED).fit(pool, weight, cp_a, WINDOW, timeline, ref_ids)
        trained_max[key(cond, True)] = float(pool["payload"].max())

    app_index = json.loads((WEB_DATA / "index.json").read_text())
    meta_of = {m["id"]: m for m in app_index["flights"]}
    out = []
    for new_id, src_id, payload, rule in SYNTH:
        assert timeline.loc[src_id, "window"] == WINDOW, f"flight {src_id} is not in window {WINDOW}"
        assert M0_G + payload <= MAX_TAKEOFF_G, f"{payload} g is over the take-off limit"
        g, k = scale_payload(df[df["flight"] == src_id], new_id, payload, b)
        meta, series = bwd.build_flight(g)
        with open(WEB_DATA / "flights" / f"{new_id}.json", "w") as f:
            json.dump(series, f, separators=(",", ":"))

        serve = hm.build_checkpoints(g, rl, step=1.0).sort_values("t").reset_index(drop=True)
        runs = {}
        for name, model in models.items():
            e50, e90 = model.predict(serve)
            runs[name] = {"e50": r(e50), "e90": r(e90)}
        with open(WEB_DATA / "scenarios" / "flights" / f"{new_id}.json", "w") as f:
            json.dump({"window": WINDOW, "n": len(serve), "runs": runs}, f, separators=(",", ":"))
        with open(WEB_DATA / "model" / "flights" / f"{new_id}.json", "w") as f:
            json.dump({
                "group": -1,
                "tOn": round(float(serve["t"].iloc[0] - serve["elapsed_s"].iloc[0]), 2),
                "tOff": round(float(serve["t"].iloc[0] + serve["t_rem_s"].iloc[0]), 2),
                "totalWh": round(float(serve["e_total_wh"].iloc[0]), 3),
                "t": r(serve["t"], 2),
                "used": r(serve["e_used_wh"], 3),
                "e50": runs[key("reference", False)]["e50"],
                "e90": runs[key("reference", False)]["e90"],
                "frac": r(serve["route_frac"].clip(upper=1.5), 3),
            }, f, separators=(",", ":"))

        used0 = float(serve["e_used_wh"].iloc[0])
        launch = {name: round(used0 + v["e90"][0], 2) for name, v in runs.items()}
        bad, clean = launch[key("combined", False)], launch[key("reference", False)]
        pack = round((bad + clean) / 2, 1) if rule == "between" else round(clean + 0.8, 1)
        total = float(serve["e_total_wh"].iloc[0])
        print(f"  {new_id}: flight {src_id} at {payload} g (x{k:.3f}), needs {total:.1f} Wh; launch P90 both {bad}, clean {clean} -> pack {pack} ({rule})", flush=True)
        out.append({
            **meta,
            "id": new_id,
            "synthetic": {
                "basedOn": src_id,
                "sourcePayloadG": meta_of[src_id]["payload"],
                "currentFactor": round(k, 4),
                "packWh": pack,
                "packRule": rule,
                "window": WINDOW,
                "launchP90Wh": launch,
            },
        })

    with open(WEB_DATA / "synthetic.json", "w") as f:
        json.dump({
            "synthetic": True,
            "note": "SYNTHETIC heavy-payload flights: real CMU flights re-run at a heavier payload by scaling battery current "
                    "with a payload-power rule fitted on the real 0-500 g flights. Not recorded data.",
            "scaling": {
                "massKgFormula": "P_new = P_recorded x ((M0 + new payload) / (M0 + recorded payload)) ^ b",
                "m0G": M0_G, "exponent": round(b, 3), "fitFlights": n_fit, "maxTakeoffG": MAX_TAKEOFF_G, "check": check,
            },
            "trainedMaxPayloadG": trained_max,
            "flights": out,
        }, f, indent=1)
    print(f"wrote {len(out)} synthetic flights", flush=True)


if __name__ == "__main__":
    main()
