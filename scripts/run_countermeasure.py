"""Countermeasure evaluation: every condition with and without the fix, same cases.

Uses the SIMULATED timeline and defects from degrade.py and the fix from
countermeasure.py. Writes to results/countermeasure/:
  metrics.json     summary results and settings
  per_window.csv   one row per condition x fix x seed x window
  audits.csv       every source audit the fix ran (estimated bias, action taken)

Conditions
  reference, stale, low_quality, combined   the degradation grid (feed B reads 12% low)
  unseen_*                                   defects the fix was not designed around, all on
                                             the combined setting (A stops after window 1):
    unseen_bias_20pct      B reads 20% low
    unseen_drifting_bias   B's error grows 3 points per window (0% in window 0, 21% in 7)
    unseen_offset          B reads 2.5 A low (an offset, not a scale error)
    unseen_overreading     B reads 10% high
  failure_no_reference_flights   B reads 12% low and no reference flights exist

Seeds run in parallel processes. Usage: python3 scripts/run_countermeasure.py [raw_dir] [out_dir]
"""

from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import pandas as pd
import sklearn

import countermeasure as cm
import degrade as dg
import hybrid_model as hm

RAW_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw/cmu_drone")
OUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else "results/countermeasure")

SEEDS = [0, 1, 2, 3, 4]
TIMELINE_SEED = 0
STALE_AFTER = 1
EVAL_WINDOWS = list(range(1, dg.N_WINDOWS))
AFTER_OUTAGE = [w for w in EVAL_WINDOWS if w > STALE_AFTER + 1]
USABLE_WH = [16, 18, 20, 22, 24, 26]

# name -> (B defect, low-quality feed on, A stops after, reference flights per window, windows)
CONDITIONS = {
    "reference": ({"factor": dg.B_CURRENT_FACTOR}, False, None, cm.N_REF_PER_WINDOW, EVAL_WINDOWS),
    "stale": ({"factor": dg.B_CURRENT_FACTOR}, False, STALE_AFTER, cm.N_REF_PER_WINDOW, EVAL_WINDOWS),
    "low_quality": ({"factor": dg.B_CURRENT_FACTOR}, True, None, cm.N_REF_PER_WINDOW, EVAL_WINDOWS),
    "combined": ({"factor": dg.B_CURRENT_FACTOR}, True, STALE_AFTER, cm.N_REF_PER_WINDOW, EVAL_WINDOWS),
    "unseen_bias_20pct": ({"factor": 0.80}, True, STALE_AFTER, cm.N_REF_PER_WINDOW, AFTER_OUTAGE),
    "unseen_drifting_bias": ({"factor": "drift"}, True, STALE_AFTER, cm.N_REF_PER_WINDOW, AFTER_OUTAGE),
    "unseen_offset": ({"factor": 1.0, "offset_a": -2.5}, True, STALE_AFTER, cm.N_REF_PER_WINDOW, AFTER_OUTAGE),
    "unseen_overreading": ({"factor": 1.10}, True, STALE_AFTER, cm.N_REF_PER_WINDOW, AFTER_OUTAGE),
    "failure_no_reference_flights": ({"factor": dg.B_CURRENT_FACTOR}, True, STALE_AFTER, 0, AFTER_OUTAGE),
}
MAIN = ["reference", "stale", "low_quality", "combined"]


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


def outcome_counts(outcomes: pd.DataFrame, u: int) -> dict:
    pos, called = outcomes["needs_return"], outcomes["called"]
    d = {f"unsafe_{u}": int((pos & ~called).sum()), f"abort_{u}": int((~pos & called).sum()),
         f"positives_{u}": int(pos.sum()), f"negatives_{u}": int((~pos).sum())}
    d[f"deferred_{u}"] = int(outcomes["deferred"].sum()) if "deferred" in outcomes else 0
    return d


def run_seed(seed: int) -> dict:
    df = hm.load_cruise_flights(RAW_DIR)
    flights = hm.flight_table(df)
    rl = hm.route_lengths(df)
    cp_a = hm.build_checkpoints(df, rl)
    bounds = hm.motor_bounds(cp_a)
    timeline = dg.simulated_timeline(flights, TIMELINE_SEED)
    cp_a["order"] = cp_a["flight"].map(timeline["sim_order"])
    cp_a["route"] = cp_a["flight"].map(flights["route"])
    all_a = pd.Series("A", index=timeline.index)
    sources = dg.assign_sources(timeline, dg.low_quality_share, seed)
    test_by_window = {w: cp_a[cp_a["flight"].map(timeline["window"]) == w] for w in range(dg.N_WINDOWS)}
    drift = 1 - 0.03 * timeline["window"]

    feeds = {}
    rows, audit_rows, rare = [], [], []
    for cond, (defect, low_q, stale_after, n_ref, windows) in CONDITIONS.items():
        key = json.dumps(defect, sort_keys=True)
        if key not in feeds:
            factor = drift if defect["factor"] == "drift" else defect["factor"]
            raw_b = dg.corrupt_current(df, factor, dg.B_NOISE_SD_A, seed, offset_a=defect.get("offset_a", 0.0))
            feeds[key] = hm.build_checkpoints(raw_b, rl, dg.B_CHECKPOINT_STEP_S, bounds)
        cp_b = feeds[key]
        src = sources if low_q else all_a
        ref_ids = cm.reference_flights(timeline, n_ref, seed) if n_ref else pd.Index([], name="flight")
        for w in windows:
            test = test_by_window[w]

            # without the fix
            pool = dg.training_pool(cp_a, cp_b, timeline, src, w, stale_after)
            m = hm.EnergyModel("hybrid", seed).fit(pool)
            pred = test.copy()
            pred["e50"], pred["e90"] = m.predict(pred)
            row = {"condition": cond, "fix": False, "seed": seed, "window": w,
                   "low_quality_share": float((pool["source"] == "B").mean()),
                   **hm.error_metrics(pred["e_rem_wh"].to_numpy(), pred["e50"].to_numpy(), pred["e90"].to_numpy())}
            for u in USABLE_WH:
                row.update(outcome_counts(hm.decide(pred, u, "e90"), u))
            rows.append(row)
            rare.append(pred.assign(condition=cond, fix=False, seed=seed))

            # with the fix
            pool, weight, audits, health = cm.protected_pool(cp_a, cp_b, timeline, src, w, stale_after, ref_ids)
            tm = cm.TrustedModel(seed).fit(pool, weight, cp_a, w, timeline, ref_ids)
            status = cm.health_status(health, tm.calibration)
            pred = test.copy()
            pred["e50"], pred["e90"] = tm.predict(pred)
            row = {"condition": cond, "fix": True, "seed": seed, "window": w,
                   "low_quality_share": float((pool["source"] == "B").mean()),
                   **hm.error_metrics(pred["e_rem_wh"].to_numpy(), pred["e50"].to_numpy(), pred["e90"].to_numpy()),
                   **health, "health_status": status, "calibration": tm.calibration,
                   "trusted_raw_coverage": tm.trusted_raw_coverage, "cal_flights": tm.n_cal_flights}
            for u in USABLE_WH:
                row.update(outcome_counts(cm.decide_with_review(pred, u, status), u))
                auto = outcome_counts(hm.decide(pred, u, "e90"), u)
                row[f"autounsafe_{u}"], row[f"autoabort_{u}"] = auto[f"unsafe_{u}"], auto[f"abort_{u}"]
            rows.append(row)
            rare.append(pred.assign(condition=cond, fix=True, seed=seed))
            audit_rows += [{"condition": cond, "seed": seed, "retrain_window": w, **a} for a in audits]

    rare = pd.concat(rare)
    rare = rare[(rare["payload"] >= 750) | (rare["route"] == "R6")]
    return {"rows": rows, "audits": audit_rows,
            "rare": rare[["condition", "fix", "seed", "flight", "payload", "route", "e_rem_wh", "e50", "e90"]]}


def summarize(pw: pd.DataFrame, conds: list[str], windows: list[int]) -> dict:
    sub = pw[pw["condition"].isin(conds) & pw["window"].isin(windows)]
    counts = [c for c in sub.columns
              if c.split("_")[0] in ("unsafe", "abort", "positives", "negatives", "deferred", "autounsafe", "autoabort")]
    rates = ["mae_wh", "bias_wh", "p90_coverage", "low_quality_share"]
    per_seed = sub.groupby(["condition", "fix", "seed"]).agg({**{c: "sum" for c in counts}, **{c: "mean" for c in rates}})
    for u in USABLE_WH:  # the no-fix system has no review step: its automatic counts are its counts
        for kind in ("unsafe", "abort"):
            if f"auto{kind}_{u}" in per_seed:
                nofix = per_seed.index.get_level_values("fix") == False  # noqa: E712
                per_seed.loc[nofix, f"auto{kind}_{u}"] = per_seed.loc[nofix, f"{kind}_{u}"]
    for name, cols in (("unsafe_all", "unsafe"), ("abort_all", "abort"), ("deferred_all", "deferred"),
                       ("positives_all", "positives"), ("negatives_all", "negatives"),
                       ("auto_unsafe_all", "autounsafe"), ("auto_abort_all", "autoabort")):
        if f"{cols}_{USABLE_WH[0]}" not in per_seed:
            continue
        per_seed[name] = per_seed[[f"{cols}_{u}" for u in USABLE_WH]].sum(axis=1)
    out = {}
    for (cond, fix), g in per_seed.groupby(level=["condition", "fix"]):
        out[f"{cond}/{'fix' if fix else 'no_fix'}"] = {
            c: {"mean": float(g[c].mean()), "sd": float(g[c].std(ddof=0))} for c in g.columns}
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor(max_workers=len(SEEDS)) as ex:
        results = list(ex.map(run_seed, SEEDS))
    pw = pd.DataFrame([r for res in results for r in res["rows"]])
    audits = pd.DataFrame([a for res in results for a in res["audits"]])
    rare = pd.concat([res["rare"] for res in results])
    pw.to_csv(OUT_DIR / "per_window.csv", index=False, float_format="%.4f")
    audits.to_csv(OUT_DIR / "audits.csv", index=False, float_format="%.4f")

    rare["group"] = np.where(rare["payload"] >= 750, "750 g flight", "R6 long route")
    rare_summary = {
        f"{c}/{'fix' if f else 'no_fix'}/{grp}": {
            "mae_wh": float((g["e50"] - g["e_rem_wh"]).abs().mean()),
            "bias_wh": float((g["e50"] - g["e_rem_wh"]).mean()),
            "p90_coverage": float((g["e_rem_wh"] <= g["e90"]).mean()),
            "n_checkpoints": int(len(g)),
        }
        for (c, f, grp), g in rare.groupby(["condition", "fix", "group"])
    }
    fixed = pw[pw["fix"]]
    status_counts = {c: g["health_status"].value_counts().to_dict() for c, g in fixed.groupby("condition")}
    audit_summary = {
        c: {"actions": g["action"].value_counts().to_dict(),
            "mean_estimated_ratio_recalibrated": float(g.loc[g["action"] == "recalibrate", "ratio"].mean())}
        for c, g in audits.groupby("condition")
    } if len(audits) else {}

    by_window = (pw[pw["condition"].isin(MAIN)]
                 .groupby(["condition", "fix", "window"])[["mae_wh", "bias_wh", "p90_coverage"]].mean())
    out = {
        "description": "Countermeasure vs no countermeasure on the SIMULATED timeline. Same windows, flights "
        "and seeds in every pair.",
        "countermeasure": {
            "layer1_data_health_gate": f"{cm.N_REF_PER_WINDOW} reference flights per window logged by both A and B "
            "and uploaded manually; per-window audit of B against A on them (95% t-interval on the energy ratio): "
            "recalibrate B if the interval excludes 1, keep if it sits within 1 +/- "
            f"{cm.VERIFIED_HALF_WIDTH}, otherwise keep at weight {cm.UNVERIFIED_WEIGHT}. No records discarded. "
            "Freshness flag on the automatic A upload.",
            "layer2_decision_safeguards": "P90 calibrated on held-out trusted flights (reference flights and "
            f"accurate-logger flights) from the last {cm.CAL_WINDOWS} windows. CONTINUE / RETURN / DEFER: defer "
            "when the P50-P90 band straddles the budget, or when health is red and the P90 clears the budget by "
            f"less than {cm.REVIEW_MARGIN_WH} Wh. Deferred flights are scored as returned (the operator's safe "
            "choice) and counted as human workload. auto_* counts score the plain P90 rule on the fixed model.",
            "cost": f"{cm.N_REF_PER_WINDOW} dual-logged reference flights per window (about 12% of flights)",
        },
        "after_outage_windows": AFTER_OUTAGE,
        "main_grid_after_outage": summarize(pw, MAIN, AFTER_OUTAGE),
        "main_grid_all_windows": summarize(pw, MAIN, EVAL_WINDOWS),
        "unseen_and_failure_after_outage": summarize(pw, [c for c in CONDITIONS if c not in MAIN], AFTER_OUTAGE),
        "by_window_seed_mean": {f"{c}/{'fix' if f else 'no_fix'}/{w}": r.to_dict()
                                for (c, f, w), r in by_window.iterrows()},
        "rare_events": rare_summary,
        "health_status_counts_with_fix": status_counts,
        "audits": audit_summary,
        "settings": {"seeds": SEEDS, "timeline_seed": TIMELINE_SEED, "usable_wh": USABLE_WH,
                     "conditions": {k: {"b_defect": v[0], "low_quality_feed": v[1], "a_stops_after": v[2],
                                        "reference_flights_per_window": v[3], "windows": v[4]}
                                    for k, v in CONDITIONS.items()},
                     "python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__,
                     "scikit_learn": sklearn.__version__},
    }
    with open(OUT_DIR / "metrics.json", "w") as f:
        json.dump(rounded(out), f, indent=2)

    def table(summary: dict, title: str) -> None:
        print(f"\n{title}")
        print(f"{'condition/fix':<42}{'MAE':>6}{'bias':>7}{'P90cov':>8}{'auto unsafe':>12}{'auto abort':>11}"
              f"{'reviewed unsafe':>16}{'abort':>7}{'defer':>7}")
        for k, v in summary.items():
            print(f"{k:<42}{v['mae_wh']['mean']:>6.2f}{v['bias_wh']['mean']:>7.2f}{v['p90_coverage']['mean']:>8.2f}"
                  f"{v['auto_unsafe_all']['mean']:>12.1f}{v['auto_abort_all']['mean']:>11.1f}"
                  f"{v['unsafe_all']['mean']:>16.1f}{v['abort_all']['mean']:>7.1f}{v['deferred_all']['mean']:>7.1f}")

    table(out["main_grid_after_outage"], f"Main grid, windows {AFTER_OUTAGE}, summed over budgets {USABLE_WH}:")
    table(out["unseen_and_failure_after_outage"], "Unseen conditions and failure case:")
    print("\nHealth status with fix:", status_counts)
    print("Audits:", audit_summary)


if __name__ == "__main__":
    main()
