"""Degradation experiments for the hybrid energy model (no countermeasure yet).

Everything runs on a SIMULATED timeline (see degrade.py): 8 operating windows in
which the package mix drifts heavier, with a retrain at the start of each window.

Main grid: four conditions at the training/update stage, each window, 5 seeds
  reference   every earlier flight arrives through the accurate logger A
  stale       A's uploads stop after window 1; nothing newer reaches training
  low_quality the cheap feed B (current 12% low, plus noise, 2x record rate) logs
              a growing share of flights: 0% in window 0 up to 90%
  combined    A stops after window 1 while B keeps flowing, so every recent
              record comes from the biased feed
Models are tested on the clean recordings of the current window's flights.

Mechanism checks
  dose_response   B share fixed at 0/25/50/75% of training flights (windows 5-7)
  placebo         the same volume of B records with unbiased noise instead of bias
  decomposition   log error split into its power (ML) and time-plan (physics) parts
Stage comparison
  a model trained on clean data, fed frozen or biased live telemetry (input stage)

Outputs in results/degradation/:
  metrics.json            summary results and settings
  per_window.csv          one row per condition x model x seed x window
  modification_log.json   every injected defect: fields, timing, severity, source mix

Usage: python3 scripts/run_degradation.py [raw_dir] [out_dir]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import pandas as pd
import sklearn

import degrade as dg
import hybrid_model as hm

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
OUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else "results/degradation")

SEEDS = [0, 1, 2, 3, 4]
TIMELINE_SEED = 0
EVAL_WINDOWS = list(range(1, dg.N_WINDOWS))
STALE_AFTER = 1  # last window whose accurate (A) logs reach training
AFTER_OUTAGE = [w for w in EVAL_WINDOWS if w > STALE_AFTER + 1]  # windows where stale differs
MODELS = ["hybrid", "direct_ml"]
CONDITIONS = {
    "reference": {"low_quality": False, "stale_after": None},
    "stale": {"low_quality": False, "stale_after": STALE_AFTER},
    "low_quality": {"low_quality": True, "stale_after": None},
    "combined": {"low_quality": True, "stale_after": STALE_AFTER},
}
USABLE_WH = [16, 18, 20, 22, 24, 26]
DOSE_SHARES = [0.0, 0.25, 0.5, 0.75]
DOSE_WINDOWS = [5, 6, 7]
FREEZE_AT_ROUTE_FRAC = 0.3
STAGE_WINDOW = dg.N_WINDOWS - 1


def rounded(obj, places=4):
    if isinstance(obj, dict):
        return {str(k): rounded(v, places) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rounded(v, places) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return None if np.isnan(obj) else round(float(obj), places)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def evaluate(test: pd.DataFrame) -> dict:
    """Error metrics plus decision outcomes (P90 rule) for every usable-energy budget."""
    m = hm.error_metrics(test["e_rem_wh"].to_numpy(), test["e50"].to_numpy(), test["e90"].to_numpy())
    for u in USABLE_WH:
        d = hm.decision_metrics(hm.decide(test, u, "e90"))
        m[f"unsafe_{u}"] = d["fn_unsafe_continue"]
        m[f"abort_{u}"] = d["fp_needless_abort"]
        m[f"positives_{u}"] = d["tp"] + d["fn_unsafe_continue"]
        m[f"negatives_{u}"] = d["fp_needless_abort"] + d["tn"]
    return m


def decomposition(test: pd.DataFrame, t_plan: np.ndarray) -> dict:
    """log(E_hat/E) = log(P_hat/P) + log(T_hat/T): which half of the hybrid is off, on average.

    Negative means the part underestimates. Uses the P50 estimate.
    """
    e, t = test["e_rem_wh"].to_numpy(), test["t_rem_s"].to_numpy()
    p_true = e * 3600 / t
    p_hat = test["e50"].to_numpy() * 3600 / t_plan
    ok = (e > 0.5) & (p_hat > 0)
    return {
        "log_err_total": float(np.mean(np.log(test["e50"].to_numpy()[ok] / e[ok]))),
        "log_err_power_ml": float(np.mean(np.log(p_hat[ok] / p_true[ok]))),
        "log_err_time_physics": float(np.mean(np.log(t_plan[ok] / t[ok]))),
    }


def fit_predict(kind: str, seed: int, pool: pd.DataFrame, test: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    m = hm.EnergyModel(kind, seed).fit(pool)
    out = test.copy()
    out["e50"], out["e90"] = m.predict(out)
    return out, m.time.predict(out)


def pool_stats(pool: pd.DataFrame) -> dict:
    return {
        "train_flights": int(pool["flight"].nunique()),
        "train_records": int(len(pool)),
        "records_a": int((pool["source"] == "A").sum()),
        "records_b": int((pool["source"] == "B").sum()),
        "low_quality_share": float((pool["source"] == "B").mean()),
        "median_age_windows": float(pool["age_windows"].median()),
        "newest_window_in_training": int(pool["window"].max()),
    }


def summarize(rows: pd.DataFrame, keys: list[str], windows: list[int]) -> dict:
    """Seed-mean and seed-sd over the given windows. Counts are summed over windows first."""
    sub = rows[rows["window"].isin(windows)]
    count_cols = [c for c in sub.columns if c.split("_")[0] in ("unsafe", "abort", "positives", "negatives")]
    rate_cols = ["mae_wh", "bias_wh", "p90_coverage", "underestimate_gt_1wh_rate", "low_quality_share",
                 "median_age_windows", "log_err_total", "log_err_power_ml", "log_err_time_physics"]
    rate_cols = [c for c in rate_cols if c in sub.columns]
    per_seed = sub.groupby(keys + ["seed"]).agg({**{c: "sum" for c in count_cols}, **{c: "mean" for c in rate_cols}})
    out = {}
    for k, g in per_seed.groupby(level=keys):
        key = k if isinstance(k, str) else "/".join(map(str, k))
        out[key] = {c: {"mean": float(g[c].mean()), "sd": float(g[c].std(ddof=0))} for c in count_cols + rate_cols}
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df = hm.load_cruise_flights(RAW_DIR)
    flights = hm.flight_table(df)
    rl = hm.route_lengths(df)
    cp_a = hm.build_checkpoints(df, rl)
    bounds = hm.motor_bounds(cp_a)
    timeline = dg.simulated_timeline(flights, TIMELINE_SEED)
    cp_a["order"] = cp_a["flight"].map(timeline["sim_order"])
    all_a = pd.Series("A", index=timeline.index)
    test_by_window = {w: cp_a[cp_a["flight"].map(timeline["window"]) == w] for w in range(dg.N_WINDOWS)}

    rows, dose_rows, stage_rows, payload_parts = [], [], [], []
    for seed in SEEDS:
        print(f"seed {seed}: building corrupted feeds", flush=True)
        cp_b = hm.build_checkpoints(
            dg.corrupt_current(df, dg.B_CURRENT_FACTOR, dg.B_NOISE_SD_A, seed), rl, dg.B_CHECKPOINT_STEP_S, bounds)
        cp_placebo = hm.build_checkpoints(
            dg.corrupt_current(df, 1.0, dg.PLACEBO_NOISE_SD_A, seed), rl, dg.B_CHECKPOINT_STEP_S, bounds)
        sources = dg.assign_sources(timeline, dg.low_quality_share, seed)

        # ---- main grid
        for cond, spec in CONDITIONS.items():
            src = sources if spec["low_quality"] else all_a
            for w in EVAL_WINDOWS:
                pool = dg.training_pool(cp_a, cp_b, timeline, src, w, spec["stale_after"])
                stats = pool_stats(pool)
                for kind in MODELS:
                    pred, t_plan = fit_predict(kind, seed, pool, test_by_window[w])
                    row = {"condition": cond, "model": kind, "seed": seed, "window": w, **stats, **evaluate(pred)}
                    if kind == "hybrid":
                        row.update(decomposition(pred, t_plan))
                        if w in AFTER_OUTAGE:
                            payload_parts.append(pred.assign(condition=cond, seed=seed))
                    rows.append(row)

        # ---- dose-response and placebo: fixed B share across all training flights
        for feed_name, feed in (("biased", cp_b), ("placebo_unbiased_noise", cp_placebo)):
            for share in DOSE_SHARES:
                src = dg.assign_sources(timeline, lambda _w, s=share: s, seed)
                for w in DOSE_WINDOWS:
                    pool = dg.training_pool(cp_a, feed, timeline, src, w, None)
                    pred, t_plan = fit_predict("hybrid", seed, pool, test_by_window[w])
                    dose_rows.append({"feed": feed_name, "b_flight_share": share, "seed": seed, "window": w,
                                      **pool_stats(pool), **evaluate(pred), **decomposition(pred, t_plan)})

        # ---- stage comparison: clean-trained model, degraded live inputs
        pool = dg.training_pool(cp_a, cp_b, timeline, all_a, STAGE_WINDOW, None)
        model = hm.EnergyModel("hybrid", seed).fit(pool)
        test_ids = test_by_window[STAGE_WINDOW]["flight"].unique()
        raw_test = df[df["flight"].isin(test_ids)]
        clean = test_by_window[STAGE_WINDOW]
        variants = {
            "clean_inputs": raw_test,
            "frozen_telemetry": dg.freeze_telemetry(raw_test, rl, FREEZE_AT_ROUTE_FRAC),
            "biased_live_sensor": dg.corrupt_current(raw_test, dg.B_CURRENT_FACTOR, dg.B_NOISE_SD_A, seed),
        }
        variants["frozen_and_biased"] = dg.freeze_telemetry(variants["biased_live_sensor"], rl, FREEZE_AT_ROUTE_FRAC)
        for name, raw in variants.items():
            live = hm.build_checkpoints(raw, rl, hm.CHECKPOINT_STEP_S, bounds)
            live = live.drop(columns=["e_rem_wh", "t_rem_s", "e_total_wh"]).merge(
                clean[["flight", "t", "e_rem_wh", "t_rem_s", "e_total_wh", "e_used_wh"]].rename(
                    columns={"e_used_wh": "e_used_true_wh"}), on=["flight", "t"])
            live["e50"], live["e90"] = model.predict(live)
            stage_rows.append({"input": name, "seed": seed,
                               "reported_minus_true_used_wh": float((live["e_used_wh"] - live["e_used_true_wh"]).mean()),
                               **evaluate(live), **decomposition(live, model.time.predict(live))})

    per_window = pd.DataFrame(rows)
    per_window.to_csv(OUT_DIR / "per_window.csv", index=False, float_format="%.4f")
    dose = pd.DataFrame(dose_rows)
    stage = pd.DataFrame(stage_rows)

    payload = pd.concat(payload_parts)
    payload["err"] = payload["e50"] - payload["e_rem_wh"]
    by_payload = {
        f"{c}/{int(p)}": {"mae_wh": float(g["err"].abs().mean()), "bias_wh": float(g["err"].mean()),
                          "p90_coverage": float((g["e_rem_wh"] <= g["e90"]).mean()), "n_checkpoints": int(len(g))}
        for (c, p), g in payload.groupby(["condition", "payload"])
    }

    window_mix = flights.join(timeline).groupby("window")["payload"].value_counts().unstack(fill_value=0)
    out = {
        "description": "Degradation experiments on a SIMULATED timeline. No countermeasure applied.",
        "stage_affected": "training/update stage for the main grid and mechanism checks; input stage for the "
        "stage comparison",
        "simulated_timeline": {
            "windows": dg.N_WINDOWS,
            "rule": "flights sorted by payload level plus Gaussian noise (sd "
            f"{dg.TIMELINE_NOISE} payload steps, seed {TIMELINE_SEED}), cut into equal windows; real "
            "chronological order kept within a window. The system retrains at the start of each window on "
            "everything it has ingested from earlier windows, then is tested on the current window's flights.",
            "payload_flights_by_window": {str(w): {str(int(k)): int(v) for k, v in r.items()} for w, r in window_mix.iterrows()},
        },
        "conditions": {
            "reference": "all earlier flights ingested from the accurate logger A",
            "stale": f"A uploads stop after window {STALE_AFTER}: the model keeps retraining on windows 0-{STALE_AFTER}",
            "low_quality": "cheap feed B logs a growing share of flights (0% in window 0, +15 points per window, "
            f"max 90%): current x{dg.B_CURRENT_FACTOR} + N(0, {dg.B_NOISE_SD_A} A), one checkpoint every "
            f"{dg.B_CHECKPOINT_STEP_S:.0f} s instead of {hm.CHECKPOINT_STEP_S:.0f} s",
            "combined": "both: A stops after window 1, B keeps flowing",
        },
        "evaluation": "each window's flights, clean recordings, P90 decision rule, decision deadline halfway round the route",
        "after_outage_windows": AFTER_OUTAGE,
        "main_grid_after_outage": summarize(per_window, ["condition", "model"], AFTER_OUTAGE),
        "main_grid_by_window": summarize(per_window, ["condition", "model", "window"], EVAL_WINDOWS),
        "hybrid_by_payload_after_outage_pooled_seeds": by_payload,
        "dose_response": summarize(dose.assign(condition=dose["feed"], model=dose["b_flight_share"].astype(str)),
                                   ["condition", "model"], DOSE_WINDOWS),
        "dose_response_note": "keys are feed/B share of training flights; pooled over windows 5-7",
        "stage_comparison": {
            k: {c: {"mean": float(g[c].mean()), "sd": float(g[c].std(ddof=0))}
                for c in g.columns if c not in ("input", "seed")}
            for k, g in stage.groupby("input")
        },
        "stage_comparison_note": f"model trained on clean windows 0-{STAGE_WINDOW - 1}, tested on window "
        f"{STAGE_WINDOW} with degraded live telemetry. Frozen = voltage and current held from "
        f"{FREEZE_AT_ROUTE_FRAC:.0%} of the route. Decisions act on the reported energy used; "
        "truth is the clean recording.",
        "settings": {
            "seeds": SEEDS, "models": MODELS, "usable_wh": USABLE_WH,
            "python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__,
            "scikit_learn": sklearn.__version__,
        },
    }
    with open(OUT_DIR / "metrics.json", "w") as f:
        json.dump(rounded(out), f, indent=2)

    log = [
        {"id": "timeline", "type": "simulated progression", "fields": ["flight order"],
         "timing": "all windows", "severity": f"payload-driven ordering, noise sd {dg.TIMELINE_NOISE}",
         "represents": "a delivery operation whose package mix gets heavier over time"},
        {"id": "stale_ingestion", "type": "stale", "fields": ["all fields of A-logged flights"],
         "timing": f"A flights from window {STALE_AFTER + 1} on never reach training",
         "severity": "training data age grows by one window per retrain",
         "represents": "a log-upload job that silently stops, so retraining keeps reusing old records"},
        {"id": "feed_b_bias", "type": "low quality", "fields": ["battery_current"],
         "timing": "whole flight, for B-logged flights",
         "severity": f"x{dg.B_CURRENT_FACTOR} (reads 12% low) + N(0, {dg.B_NOISE_SD_A} A) per sample",
         "source_mix": "B share of flights 0.15 x window, max 0.9; 2 records per A record",
         "represents": "a cheap, fast telemetry feed with an uncalibrated current sensor"},
        {"id": "placebo_noise", "type": "control", "fields": ["battery_current"],
         "timing": "whole flight", "severity": f"N(0, {dg.PLACEBO_NOISE_SD_A} A), no bias",
         "represents": "same volume of extra records, noisy but unbiased"},
        {"id": "frozen_telemetry", "type": "stale (input stage)", "fields": ["battery_voltage", "battery_current"],
         "timing": f"held at last value from {FREEZE_AT_ROUTE_FRAC:.0%} of the route", "severity": "full hold",
         "represents": "a telemetry link that drops and keeps showing the last packet"},
        {"id": "biased_live_sensor", "type": "low quality (input stage)", "fields": ["battery_current"],
         "timing": "whole flight", "severity": f"x{dg.B_CURRENT_FACTOR} + N(0, {dg.B_NOISE_SD_A} A)",
         "represents": "the drone flying with the cheap sensor itself"},
        {"id": "observed_source_defects", "type": "already in source, not injected",
         "fields": ["battery_current"], "timing": "on the ground before take-off and after landing",
         "severity": "small negative readings near 0 A in 185 flights; 3 flights with a gap over 2 s",
         "represents": "left unchanged in every condition"},
    ]
    with open(OUT_DIR / "modification_log.json", "w") as f:
        json.dump(log, f, indent=2)

    s = out["main_grid_after_outage"]
    print(f"\nAfter the outage (windows {AFTER_OUTAGE}), seed mean:")
    print(f"{'condition/model':<24}{'MAE':>7}{'bias':>7}{'P90cov':>8}{'LQ%':>6}{'age':>5}" +
          "".join(f"{'unsafe' + str(u):>10}" for u in USABLE_WH))
    for k, v in s.items():
        print(f"{k:<24}{v['mae_wh']['mean']:>7.2f}{v['bias_wh']['mean']:>7.2f}{v['p90_coverage']['mean']:>8.2f}"
              f"{100 * v['low_quality_share']['mean']:>6.0f}{v['median_age_windows']['mean']:>5.1f}" +
              "".join(f"{v[f'unsafe_{u}']['mean']:>6.1f}/{v[f'positives_{u}']['mean']:<3.0f}" for u in USABLE_WH))
    print("\nDose-response (windows 5-7):")
    for k, v in out["dose_response"].items():
        print(f"  {k:<30} MAE {v['mae_wh']['mean']:.2f} bias {v['bias_wh']['mean']:+.2f} "
              f"cov {v['p90_coverage']['mean']:.2f} unsafe@22 {v['unsafe_22']['mean']:.1f}")
    print("\nStage comparison (window 7):")
    for k, v in out["stage_comparison"].items():
        print(f"  {k:<20} MAE {v['mae_wh']['mean']:.2f} bias {v['bias_wh']['mean']:+.2f} "
              f"used-err {v['reported_minus_true_used_wh']['mean']:+.2f} unsafe@22 {v['unsafe_22']['mean']:.1f} "
              f"abort@22 {v['abort_22']['mean']:.1f}")


if __name__ == "__main__":
    main()
