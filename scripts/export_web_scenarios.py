"""Export the SIMULATED data-poisoning scenarios for the replay app's "poisoning lab".

Everything here follows results/countermeasure (scripts/run_countermeasure.py), seed 0:
the 196 cruise flights are re-sequenced into 8 simulated operating windows with the package
mix drifting heavier; at the start of each window the system retrains on what it has
received from earlier windows. Four training-data conditions, each with and without the fix:

  reference    every earlier flight arrives from the accurate logger
  stale        the accurate logger's uploads stop after window 1
  low_quality  a cheap feed (current reads 12% low, twice the record rate) carries a
               growing share of flights
  combined     both: uploads stop and the cheap feed keeps flowing

For each flight in windows 1-7 the app gets the P50/P90 "energy still needed" forecast,
once per second, from the model each condition would have flown it with. The time base,
energy used and route share are the same as in data/model/flights/<id>.json, so only the
forecasts differ. Window 0 flights have no scenario: nothing earlier exists to train on.

Also exported, per window and condition: what the training data really contains (age of
the newest accurate upload, the cheap feed's share), what the fix's health check reports,
the by-window error and P90 coverage from results/countermeasure (5-seed means), and the
flights and battery levels where poisoning visibly flips the call (for the demo).

Writes web/public/data/scenarios/index.json and web/public/data/scenarios/flights/<id>.json.

Usage: python3 scripts/export_web_scenarios.py [raw_dir] [web_data_dir] [results_dir]
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import countermeasure as cm  # noqa: E402
import degrade as dg  # noqa: E402
import hybrid_model as hm  # noqa: E402

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
WEB_DATA = Path(sys.argv[2] if len(sys.argv) > 2 else "web/public/data")
RESULTS = Path(sys.argv[3] if len(sys.argv) > 3 else "results/countermeasure")
OUT = WEB_DATA / "scenarios"

SEED = 0
STALE_AFTER = 1
SERVE_STEP_S = 1.0
SIM_ID, SIM_SOURCE = 900, 142
CONDITIONS = {
    "reference": {"label": "Clean", "low_quality": False, "stale_after": None,
                  "desc": "Every earlier flight arrives from the accurate logger."},
    "stale": {"label": "Stale", "low_quality": False, "stale_after": STALE_AFTER,
              "desc": "The accurate logger's uploads stopped after window 1. Retraining keeps reusing old, lighter flights."},
    "low_quality": {"label": "Low quality", "low_quality": True, "stale_after": None,
                    "desc": "A cheap feed whose current sensor reads 12% low, sending twice as many records, carries a growing share of flights."},
    "combined": {"label": "Both", "low_quality": True, "stale_after": STALE_AFTER,
                 "desc": "Accurate uploads stopped after window 1 while the cheap feed kept flowing: every recent record is from the biased sensor."},
}
DEMO_BUDGETS = np.arange(14.0, 30.01, 0.5)


def r(a, n=3):
    return [round(float(x), n) for x in a]


def key(cond: str, fix: bool) -> str:
    return f"{cond}/{'on' if fix else 'off'}"


def first_call(used, e50, e90, frac, budget, deadline=hm.DECISION_DEADLINE_FRAC) -> str:
    """Same rule as web/src/mission.ts: first non-continue before the halfway deadline."""
    for u, a, b, f in zip(used, e50, e90, frac):
        if f > deadline or u > budget:
            break
        if u + b <= budget:
            continue
        return "return" if u + a > budget else "review"
    return "continue"


def training_facts(pool: pd.DataFrame, window: int) -> dict:
    accurate = pool.loc[pool["source"].isin(["A", "R"]), "window"]
    auto_a = pool.loc[pool["source"] == "A", "window"]
    newest_auto = int(auto_a.max()) if len(auto_a) else None
    return {
        "trainFlights": int(pool["flight"].nunique()),
        "trainRecords": int(len(pool)),
        "cheapFeedShare": round(float((pool["source"] == "B").mean()), 3),
        "newestAccurateWindow": int(accurate.max()) if len(accurate) else None,
        "newestAutoUploadWindow": newest_auto,
        "uploadAgeWindows": (window - 1 - newest_auto) if newest_auto is not None else window,
    }


def main() -> None:
    df = hm.load_cruise_flights(RAW_DIR)
    flights = hm.flight_table(df)
    rl = hm.route_lengths(df)
    cp_a = hm.build_checkpoints(df, rl)
    bounds = hm.motor_bounds(cp_a)
    timeline = dg.simulated_timeline(flights, SEED)
    cp_a["order"] = cp_a["flight"].map(timeline["sim_order"])
    window_of = timeline["window"]

    print("building feeds and per-second checkpoints...", flush=True)
    cp_b = hm.build_checkpoints(dg.corrupt_current(df, dg.B_CURRENT_FACTOR, dg.B_NOISE_SD_A, SEED),
                                rl, dg.B_CHECKPOINT_STEP_S, bounds)
    serve = hm.build_checkpoints(df, rl, step=SERVE_STEP_S)
    serve["window"] = serve["flight"].map(window_of)
    sources = dg.assign_sources(timeline, dg.low_quality_share, SEED)
    all_a = pd.Series("A", index=timeline.index)
    ref_ids = cm.reference_flights(timeline, cm.N_REF_PER_WINDOW, SEED)

    runs: dict[int, dict] = {}
    health: dict[str, dict] = {}
    for w in range(1, dg.N_WINDOWS):
        test = serve[serve["window"] == w]
        for cond, spec in CONDITIONS.items():
            src = sources if spec["low_quality"] else all_a
            # without the fix
            pool = dg.training_pool(cp_a, cp_b, timeline, src, w, spec["stale_after"])
            model = hm.EnergyModel("hybrid", SEED).fit(pool)
            e50, e90 = model.predict(test)
            health[f"{key(cond, False)}/{w}"] = {**training_facts(pool, w), "status": "unmonitored"}
            for fid, idx in test.groupby("flight").indices.items():
                runs.setdefault(fid, {})[key(cond, False)] = {"e50": r(e50[idx]), "e90": r(e90[idx])}
            # with the fix
            pool, weight, audits, h = cm.protected_pool(cp_a, cp_b, timeline, src, w, spec["stale_after"], ref_ids)
            tm = cm.TrustedModel(SEED).fit(pool, weight, cp_a, w, timeline, ref_ids)
            e50, e90 = tm.predict(test)
            recal = [a for a in audits if a["action"] == "recalibrate"]
            health[f"{key(cond, True)}/{w}"] = {
                **training_facts(pool, w),
                "status": cm.health_status(h, tm.calibration),
                "referenceFlights": h["reference_flights_in_training"],
                "recalibratedRecords": h["b_recalibrated"],
                "unverifiedRecords": h["b_unverified"],
                "auditedWindows": len(audits),
                "estimatedFeedRatio": round(float(np.mean([a["ratio"] for a in recal])), 3) if recal else None,
                "calibration": tm.calibration,
            }
            for fid, idx in test.groupby("flight").indices.items():
                runs[fid][key(cond, True)] = {"e50": r(e50[idx]), "e90": r(e90[idx])}
        print(f"  window {w}: {test['flight'].nunique()} flights", flush=True)

    # Per-flight files, aligned with data/model/flights/<id>.json (same checkpoints, same order).
    (OUT / "flights").mkdir(parents=True, exist_ok=True)
    by_flight = {fid: g.sort_values("t") for fid, g in serve.groupby("flight")}
    for fid, rr in runs.items():
        g = by_flight[fid]
        with open(OUT / "flights" / f"{fid}.json", "w") as f:
            json.dump({"window": int(window_of[fid]), "n": len(g), "runs": rr}, f, separators=(",", ":"))

    app_index = json.loads((WEB_DATA / "index.json").read_text())
    sim = next((f for f in app_index["flights"] if f["id"] == SIM_ID), None)
    if sim is not None and SIM_SOURCE in runs:
        sim_fc = json.loads((WEB_DATA / "model" / "flights" / f"{SIM_ID}.json").read_text())
        n = len(sim_fc["t"])
        cut = {k: {"e50": v["e50"][:n], "e90": v["e90"][:n]} for k, v in runs[SIM_SOURCE].items()}
        with open(OUT / "flights" / f"{SIM_ID}.json", "w") as f:
            json.dump({"window": int(window_of[SIM_SOURCE]), "n": n, "runs": cut}, f, separators=(",", ":"))
        runs[SIM_ID] = cut

    # Flights and battery levels where poisoning flips the call, for the demo. The clean model is
    # cautious (turn back or operator review), the poisoned one says continue, the fixed one is
    # cautious again, and the flight really did need more than the battery. Ranked by how
    # confidently wrong the poisoned call is: its claimed spare energy plus the real shortfall.
    demos = []
    for fid, rr in runs.items():
        if fid == SIM_ID or window_of[fid] <= STALE_AFTER + 1:
            continue
        g = by_flight[fid]
        used, frac, total = g["e_used_wh"].to_numpy(), g["route_frac"].to_numpy(), float(g["e_total_wh"].iloc[0])
        last = int(np.flatnonzero(frac <= hm.DECISION_DEADLINE_FRAC).max())
        for cond in ("combined", "low_quality", "stale"):
            best = None
            for b in DEMO_BUDGETS:
                if total <= b:
                    continue
                calls = {k: first_call(used, rr[k]["e50"], rr[k]["e90"], frac, b)
                         for k in ("reference/off", f"{cond}/off", f"{cond}/on")}
                if calls["reference/off"] == "continue" or calls[f"{cond}/off"] != "continue" or calls[f"{cond}/on"] == "continue":
                    continue
                claim = b - (used[last] + rr[f"{cond}/off"]["e90"][last])
                score = claim + (total - b)
                if best is None or score > best["score"]:
                    best = {"flight": int(fid), "condition": cond, "budgetWh": float(b), "window": int(window_of[fid]),
                            "totalWh": round(total, 2), "shortWh": round(total - b, 2), "claimedSpareWh": round(claim, 2),
                            "cleanCall": calls["reference/off"], "fixedCall": calls[f"{cond}/on"],
                            "payload": float(flights.loc[fid, "payload"]), "speed": float(flights.loc[fid, "speed"]),
                            "score": round(score, 2)}
            if best:
                demos.append(best)
    demos.sort(key=lambda d: (-d["score"], d["flight"]))

    # By-window error and coverage from the countermeasure results (5-seed means).
    chart = {}
    res = json.loads((RESULTS / "metrics.json").read_text())["by_window_seed_mean"]
    for cond in CONDITIONS:
        for fix in (False, True):
            rows = [res[f"{cond}/{'fix' if fix else 'no_fix'}/{w}"] for w in range(1, dg.N_WINDOWS)]
            chart[key(cond, fix)] = {"maeWh": [round(x["mae_wh"], 3) for x in rows],
                                     "p90Coverage": [round(x["p90_coverage"], 3) for x in rows]}

    mix = flights.join(timeline).assign(p=lambda d: d["payload"].clip(upper=500).astype(int))
    window_mix = {str(w): {str(k): int(v) for k, v in g["p"].value_counts().sort_index().items()}
                  for w, g in mix.groupby("window")}
    index = {
        "simulated": True,
        "note": "SIMULATED: the timeline, the cheap feed, the upload outage and the reference flights are "
        "experiment settings, not CMU data. Seed 0 of results/countermeasure.",
        "conditions": {k: {"label": v["label"], "desc": v["desc"]} for k, v in CONDITIONS.items()},
        "windows": dg.N_WINDOWS,
        "staleAfter": STALE_AFTER,
        "feed": {"currentFactor": dg.B_CURRENT_FACTOR, "recordsPerAccurate": hm.CHECKPOINT_STEP_S / dg.B_CHECKPOINT_STEP_S},
        "flightWindow": {str(int(f)): int(w) for f, w in window_of.items()},
        "windowMix": window_mix,
        "health": health,
        "chart": chart,
        "demos": demos[:8],
        "flights": sorted(int(f) for f in runs),
    }
    with open(OUT / "index.json", "w") as f:
        json.dump(index, f, indent=1)
    print(f"wrote {len(runs)} flight scenario files; {len(demos)} demo cases")
    for d in demos[:5]:
        print("  ", d)


if __name__ == "__main__":
    main()
