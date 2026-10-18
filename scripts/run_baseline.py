"""Clean reference run for the hybrid energy model (no degradation applied).

Fits physics_only, direct_ml and hybrid on chronological expanding-window folds,
repeats the boosted models over several seeds, and writes:
  results/baseline/metrics.json      machine-readable results and settings
  results/baseline/predictions.csv   per-checkpoint predictions on test flights (seed 0)

Usage: python3 scripts/run_baseline.py [raw_dir] [out_dir]
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")  # multithreading only slows boosting on ~3k rows

import numpy as np
import pandas as pd
import sklearn

import hybrid_model as hm

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
OUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else "results/baseline")

# name -> (kind, calibrate P90). hybrid_uncalibrated shows what the calibration step adds.
MODELS = {
    "physics_only": ("physics_only", True),
    "direct_ml": ("direct_ml", True),
    "hybrid": ("hybrid", True),
    "hybrid_uncalibrated": ("hybrid", False),
}
SEEDS = [0, 1, 2, 3, 4]
USABLE_WH = [16, 18, 20, 22, 24, 26]
HEADLINE_USABLE_WH = 20
BOOTSTRAP_REPS = 1000


def md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rounded(obj, places=4):
    if isinstance(obj, dict):
        return {k: rounded(v, places) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rounded(v, places) for v in obj]
    if isinstance(obj, float):
        return round(obj, places)
    return obj


def metrics_of(p: pd.DataFrame) -> dict:
    return hm.error_metrics(p["e_rem_wh"].to_numpy(), p["e50"].to_numpy(), p["e90"].to_numpy())


def bootstrap(p: pd.DataFrame, rng: np.random.Generator) -> dict:
    """95% intervals from resampling whole test flights, not checkpoints."""
    by_flight = {f: g for f, g in p.groupby("flight")}
    ids = np.array(list(by_flight))
    stats = {"mae_wh": [], "p90_coverage": [], "bias_wh": []}
    for _ in range(BOOTSTRAP_REPS):
        s = pd.concat([by_flight[f] for f in rng.choice(ids, len(ids))])
        m = metrics_of(s)
        for k in stats:
            stats[k].append(m[k])
    return {k: [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))] for k, v in stats.items()}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df = hm.load_cruise_flights(RAW_DIR)
    flights = hm.flight_table(df)
    cp = hm.build_checkpoints(df, hm.route_lengths(df))
    cp["month"] = cp["flight"].map(flights["date"].str[:7])
    cp["order"] = cp["flight"].map(flights["order"])
    folds = hm.chronological_folds(flights)

    preds = []
    latency = {}
    for model, (kind, calibrate) in MODELS.items():
        for seed in SEEDS if kind != "physics_only" else [0]:
            for fold in folds:
                train = cp[cp["flight"].isin(fold["train_flights"])]
                test = cp[cp["flight"].isin(fold["test_flights"])].copy()
                m = hm.EnergyModel(kind, seed, calibrate).fit(train)
                t0 = time.perf_counter()
                test["e50"], test["e90"] = m.predict(test)
                latency.setdefault(model, []).append((time.perf_counter() - t0) / len(test))
                test["model"], test["seed"], test["fold"] = model, seed, fold["name"]
                test["p90_scale"] = m.p90_scale
                preds.append(test)
    preds = pd.concat(preds, ignore_index=True)

    results = {}
    rng = np.random.default_rng(0)
    for model in MODELS:
        pm = preds[preds["model"] == model]
        per_seed = [metrics_of(g) for _, g in pm.groupby("seed")]
        seed0 = pm[pm["seed"] == 0]
        results[model] = {
            "pooled_test_seed_mean": {k: float(np.mean([s[k] for s in per_seed])) for k in per_seed[0]},
            "pooled_test_seed_sd": {k: float(np.std([s[k] for s in per_seed])) for k in per_seed[0]},
            "pooled_test_seed0_bootstrap_95ci": bootstrap(seed0, rng),
            "by_fold_seed0": {f: metrics_of(g) for f, g in seed0.groupby("fold")},
            "by_month_seed0": {mo: metrics_of(g) for mo, g in seed0.groupby("month")},
            "by_payload_g_seed0": {str(int(k)): metrics_of(g) for k, g in seed0.groupby("payload")},
            "by_speed_ms_seed0": {str(int(k)): metrics_of(g) for k, g in seed0.groupby("speed_plan")},
            "by_phase_seed0": {
                name: metrics_of(seed0[seed0["phase"] == code]) for name, code in hm.PHASES.items()
            },
            "decisions_seed0": {
                policy: {
                    str(u): hm.decision_metrics(hm.decide(seed0, u, col)) for u in USABLE_WH
                }
                for policy, col in [("p90_rule", "e90"), ("p50_rule", "e50")]
            },
            "p90_calibration_scale_by_fold_seed0": seed0.groupby("fold")["p90_scale"].first().to_dict(),
            "predict_latency_ms_per_checkpoint": 1000 * float(np.mean(latency[model])),
        }

    totals = cp.groupby("flight")["e_total_wh"].first()
    out = {
        "description": "Clean reference run: no degradation, no countermeasure.",
        "target": "energy (Wh) the flight will still use from the checkpoint until the rotors stop",
        "decision_rule": "continue if energy_used + predicted_energy_needed <= usable_wh, else return. "
        "p90_rule uses the P90 estimate, p50_rule the median. A return call only counts if made before "
        f"{hm.DECISION_DEADLINE_FRAC:.0%} of the route (routes are loops back to launch).",
        "decision_positive_class": "should return (true mission energy > usable_wh)",
        "usable_wh_note": "Simulated mission budget after the safety reserve. Real flights used "
        f"{totals.min():.1f}-{totals.max():.1f} Wh of a {hm.PACK_WH} Wh pack, so none came close to empty.",
        "headline_usable_wh": HEADLINE_USABLE_WH,
        "flights_needing_return_at_usable_wh": {str(u): int((totals > u).sum()) for u in USABLE_WH},
        "data": {
            "source": "CMU Data Collected with Package Delivery Quadcopter Drone, doi 10.1184/R1/12683453.v1, CC BY 4.0",
            "file": str(RAW_DIR / "flights.csv"),
            "md5": md5(RAW_DIR / "flights.csv"),
            "subset": "cruise flights only (routes R1-R7); ground tests A1-A3 and hovers H excluded",
            "flights": int(cp["flight"].nunique()),
            "checkpoints": int(len(cp)),
            "checkpoint_rule": f"every {hm.CHECKPOINT_STEP_S:.0f} s from 5 s after the rotors start "
            f"(power > {hm.MOTOR_ON_W:.0f} W) until 5 s before they stop",
            "date_range": [str(flights["date"].min()), str(flights["date"].max())],
        },
        "split": {
            "rule": "expanding-window chronological folds, split at flight-day boundaries; "
            "every checkpoint of a flight stays on one side",
            "folds": [{k: v for k, v in f.items() if k not in ("train_flights", "test_flights")}
                      | {"n_train_flights": len(f["train_flights"]), "n_test_flights": len(f["test_flights"])}
                      for f in folds],
            "pooled_test_flights": int(preds.loc[preds["model"] == "hybrid", "flight"].nunique()),
        },
        "settings": {
            "models": {k: {"kind": v[0], "calibrated_p90": v[1]} for k, v in MODELS.items()},
            "p90_calibration": f"split-conformal scale fitted on the most recent {hm.CALIB_FRAC:.0%} "
            "of each fold's training flights, then applied to the model refitted on all of them",
            "seeds": SEEDS,
            "ml_features": hm.ML_FEATURES,
            "time_plan_features": hm.TIME_FEATURES,
            "gbm": {k: v for k, v in hm._gbm(0.5, 0).get_params().items() if k not in ("quantile", "random_state")},
            "retraining": "each fold refits from scratch on all earlier flights",
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikit_learn": sklearn.__version__,
        },
        "results": results,
    }
    with open(OUT_DIR / "metrics.json", "w") as f:
        json.dump(rounded(out), f, indent=2)

    keep = ["flight", "fold", "month", "t", "elapsed_s", "phase", "route_frac", "payload", "speed_plan",
            "e_used_wh", "e_total_wh", "e_rem_wh"]
    wide = preds[(preds["seed"] == 0) & (preds["model"] == "hybrid")][keep].reset_index(drop=True)
    for model in MODELS:
        s = preds[(preds["seed"] == 0) & (preds["model"] == model)].reset_index(drop=True)
        wide[f"{model}_e50"] = s["e50"].round(3)
        wide[f"{model}_e90"] = s["e90"].round(3)
    wide.round(3).to_csv(OUT_DIR / "predictions.csv", index=False)

    print(f"{'model':<14}{'MAE Wh':>14}{'bias Wh':>9}{'P90 cover':>11}{'miss@20':>9}{'abort@20':>10}")
    for model in MODELS:
        r = results[model]
        mean, sd = r["pooled_test_seed_mean"], r["pooled_test_seed_sd"]
        d = r["decisions_seed0"]["p90_rule"][str(HEADLINE_USABLE_WH)]
        print(f"{model:<14}{mean['mae_wh']:>8.2f} ±{sd['mae_wh']:.2f}{mean['bias_wh']:>9.2f}"
              f"{mean['p90_coverage']:>11.2f}{d['fn_unsafe_continue']:>9}{d['fp_needless_abort']:>10}")


if __name__ == "__main__":
    main()
