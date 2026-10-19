"""Export the hybrid energy model's in-flight forecasts for the replay app.

For every cruise flight in the app, the model's forecast is computed once per second
of flight: energy used so far (Wh), and the P50 and P90 of the energy still needed
before landing. The app turns these into a live CONTINUE / TURN BACK call against a
battery budget the viewer sets.

Every flight is scored by a model that never saw it: flights are split into 5 groups
by flight day, and each group is predicted by a model trained on the other four.
The models are the same hybrid as in results/baseline (scripts/hybrid_model.py).

Simulated flight 900 reuses flight 142's real path and sensors, so its forecast is
142's forecast up to the moment its (simulated) depleted pack cuts out. Its budget is
fixed at the energy it had used when power was lost.

Hover tests (route H) have no delivery route, so the model doesn't rate them.

Writes web/public/data/model/index.json and web/public/data/model/flights/<id>.json.

Usage: python3 scripts/export_web_model.py [raw_dir] [web_data_dir]
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hybrid_model as hm  # noqa: E402

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
WEB_DATA = Path(sys.argv[2] if len(sys.argv) > 2 else "web/public/data")
OUT = WEB_DATA / "model"

N_GROUPS = 5
SEED = 0
SERVE_STEP_S = 1.0
SIM_ID, SIM_SOURCE = 900, 142
BUDGET = {"default": 20.0, "min": 12.0, "max": 36.0, "step": 0.5}


def r(a, n):
    return [round(float(x), n) for x in a]


def main() -> None:
    df = hm.load_cruise_flights(RAW_DIR)
    flights = hm.flight_table(df)
    rl = hm.route_lengths(df)
    train_cp = hm.build_checkpoints(df, rl)
    train_cp["order"] = train_cp["flight"].map(flights["order"])

    days = sorted(flights["date"].unique())
    group_of_day = {d: k % N_GROUPS for k, d in enumerate(days)}
    group = flights["date"].map(group_of_day)

    print("building per-second checkpoints...", flush=True)
    serve_cp = hm.build_checkpoints(df, rl, step=SERVE_STEP_S)

    (OUT / "flights").mkdir(parents=True, exist_ok=True)
    oof = []
    served = {}
    for k in range(N_GROUPS):
        test_ids = group.index[group == k]
        model = hm.EnergyModel("hybrid", SEED).fit(train_cp[~train_cp["flight"].isin(test_ids)])
        # out-of-group check on the standard 10 s checkpoints
        chk = train_cp[train_cp["flight"].isin(test_ids)].copy()
        chk["e50"], chk["e90"] = model.predict(chk)
        oof.append(chk)
        sub = serve_cp[serve_cp["flight"].isin(test_ids)].copy()
        sub["e50"], sub["e90"] = model.predict(sub)
        for fid, g in sub.groupby("flight"):
            served[fid] = (k, g.sort_values("t"))
        print(f"  group {k + 1}/{N_GROUPS}: {len(test_ids)} flights", flush=True)

    def payload(g: pd.DataFrame, k: int) -> dict:
        return {
            "group": k,
            "tOn": round(float(g["t"].iloc[0] - g["elapsed_s"].iloc[0]), 2),
            "tOff": round(float(g["t"].iloc[0] + g["t_rem_s"].iloc[0]), 2),
            "totalWh": round(float(g["e_total_wh"].iloc[0]), 3),
            "t": r(g["t"], 2),
            "used": r(g["e_used_wh"], 3),
            "e50": r(g["e50"], 3),
            "e90": r(g["e90"], 3),
            "frac": r(g["route_frac"].clip(upper=1.5), 3),
        }

    for fid, (k, g) in served.items():
        with open(OUT / "flights" / f"{fid}.json", "w") as f:
            json.dump(payload(g, k), f, separators=(",", ":"))

    # Simulated flight 900: flight 142's forecast until its simulated pack cuts out.
    index_path = WEB_DATA / "index.json"
    app_index = json.loads(index_path.read_text())
    sim = next((f for f in app_index["flights"] if f["id"] == SIM_ID), None)
    sims = {}
    if sim is not None and SIM_SOURCE in served:
        k, g = served[SIM_SOURCE]
        sim_series = json.loads((WEB_DATA / "flights" / f"{SIM_ID}.json").read_text())
        fail_t = float(sim["failureS"])
        budget = float(np.interp(fail_t, sim_series["t"], sim_series["energyWh"]))
        p = payload(g[g["t"] <= fail_t], k)
        p["tOff"] = round(fail_t, 2)
        with open(OUT / "flights" / f"{SIM_ID}.json", "w") as f:
            json.dump(p, f, separators=(",", ":"))
        served[SIM_ID] = (k, g)
        sims[str(SIM_ID)] = {
            "basedOn": SIM_SOURCE,
            "budgetWh": round(budget, 2),
            "note": "Simulated depleted pack: power is lost after about "
            f"{budget:.1f} Wh. The forecast is flight {SIM_SOURCE}'s, since the path and sensors are the same.",
        }

    oof = pd.concat(oof)
    m = hm.error_metrics(oof["e_rem_wh"].to_numpy(), oof["e50"].to_numpy(), oof["e90"].to_numpy())
    app_ids = {f["id"] for f in app_index["flights"]}
    index = {
        "model": "Hybrid energy model: physics (Coulomb counting + time-left plan) and gradient-boosted P50/P90 power",
        "validation": f"Each flight is scored by a model trained without it ({N_GROUPS} groups split by flight day).",
        "metrics": {
            "maeWh": round(m["mae_wh"], 3),
            "biasWh": round(m["bias_wh"], 3),
            "p90Coverage": round(m["p90_coverage"], 3),
            "checkpoints": m["n_checkpoints"],
        },
        "deadlineFrac": hm.DECISION_DEADLINE_FRAC,
        "packWh": hm.PACK_WH,
        "budget": BUDGET,
        "flights": sorted(int(f) for f in served if f in app_ids),
        "simulated": sims,
    }
    with open(OUT / "index.json", "w") as f:
        json.dump(index, f, indent=1)
    skipped = sorted(app_ids - set(served))
    print(f"wrote {len(index['flights'])} flight forecasts to {OUT}; not rated: {skipped}")
    print(f"out-of-group check: MAE {m['mae_wh']:.3f} Wh, P90 coverage {m['p90_coverage']:.3f}")


if __name__ == "__main__":
    main()
