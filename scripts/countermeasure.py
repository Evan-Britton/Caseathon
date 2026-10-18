"""Countermeasure: a data health gate before retraining, and decision safeguards after.

Layer 1, data health gate (training/update stage)
  Reference flights   each window, a few flights are logged by BOTH the accurate
                      logger A and the cheap feed B, and uploaded by a manual path
                      that keeps working when A's automatic upload breaks. Their A
                      record is trusted training data.
  Source audit        for each window's B records, compare B's energy with A's on that
                      window's reference flights:
                        ratio clearly off 1      -> recalibrate that window's B records
                        ratio consistent with 1  -> keep them as they are
                        too few or inconclusive  -> keep them at low weight (unverified)
                      Nothing is thrown away.
  Freshness check     age of the newest automatic A upload. An outage is flagged, not hidden.

Layer 2, decision safeguards (decision stage)
  Trusted calibration the P90 is calibrated on held-out recent TRUSTED flights (reference
                      flights plus any flights from the accurate logger), so the margin is
                      checked against ground truth, never against the feed that may be biased.
  Health badge        red    unverified records carry a real share of the training weight
                      amber  the feed was recalibrated, A's upload is stale, or there were too
                             few trusted flights to calibrate on
                      green  otherwise
  Operator review     CONTINUE if even the P90 fits the budget, RETURN if even the median
                      does not, DEFER to the operator when the band straddles the budget.
                      When health is red, a continue that clears the budget by less than
                      REVIEW_MARGIN_WH is also deferred.
                      Scoring assumes the operator returns a deferred flight, the safe
                      choice. Deferrals are counted separately as human workload.
"""

import numpy as np
import pandas as pd

import degrade as dg
import hybrid_model as hm

N_REF_PER_WINDOW = 3
CAL_WINDOWS = 3  # trusted flights from this many recent windows calibrate the P90
MIN_CAL_FLIGHTS = 3
MAX_CAL_SHARE = 0.3  # never hold out more than this share of training flights for calibration
UNVERIFIED_WEIGHT = 0.2
VERIFIED_HALF_WIDTH = 0.05  # CI within 1 +/- this counts as "consistent with 1"
REVIEW_MARGIN_WH = 1.0
STALE_LIMIT_WINDOWS = 1  # newest automatic A upload older than this -> amber
RED_UNVERIFIED_SHARE = 0.1  # share of training weight on unverified records that turns health red
ENERGY_COLS = ["e_used_wh", "p_10s", "p_30s", "e_rem_wh", "e_total_wh"]
T975 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26}


def reference_flights(timeline: pd.DataFrame, n_per_window: int, seed: int) -> pd.Index:
    rng = np.random.default_rng(seed + 3000)
    picks = []
    for _, g in timeline.groupby("window"):
        picks.extend(rng.choice(g.index.to_numpy(), min(n_per_window, len(g)), replace=False))
    return pd.Index(sorted(picks), name="flight")


def audit_window(cp_a: pd.DataFrame, cp_b: pd.DataFrame, ref_ids) -> dict:
    """Compare B's mission energy with A's on dual-logged reference flights."""
    ea = cp_a[cp_a["flight"].isin(ref_ids)].groupby("flight")["e_total_wh"].first()
    eb = cp_b[cp_b["flight"].isin(ref_ids)].groupby("flight")["e_total_wh"].first()
    ratio = (eb / ea).dropna()
    n = len(ratio)
    out = {"n_reference": n, "ratio": float(ratio.mean()) if n else np.nan, "ci_low": np.nan, "ci_high": np.nan}
    if n < 2:
        out["action"] = "unverified"
        return out
    half = T975.get(n - 1, 2.0) * ratio.std(ddof=1) / np.sqrt(n)
    out["ci_low"], out["ci_high"] = out["ratio"] - half, out["ratio"] + half
    if out["ci_low"] > 1 or out["ci_high"] < 1:
        out["action"] = "recalibrate"
    elif out["ci_low"] >= 1 - VERIFIED_HALF_WIDTH and out["ci_high"] <= 1 + VERIFIED_HALF_WIDTH:
        out["action"] = "keep"
    else:
        out["action"] = "unverified"
    return out


def protected_pool(
    cp_a: pd.DataFrame,
    cp_b: pd.DataFrame,
    timeline: pd.DataFrame,
    sources: pd.Series,
    window: int,
    stale_after: int | None,
    ref_ids: pd.Index,
) -> tuple[pd.DataFrame, np.ndarray, list[dict], dict]:
    """Training pool after the data health gate, with sample weights, audits and health info."""
    past_ref = ref_ids[timeline.loc[ref_ids, "window"] < window]
    base = dg.training_pool(cp_a, cp_b, timeline, sources, window, stale_after)
    base = base[~base["flight"].isin(past_ref)]  # their trusted copy is added below
    trusted = cp_a[cp_a["flight"].isin(past_ref)].assign(source="R")
    trusted["window"] = trusted["flight"].map(timeline["window"])
    trusted["age_windows"] = window - trusted["window"]
    trusted["order"] = trusted["flight"].map(timeline["sim_order"])
    pool = pd.concat([base, trusted], ignore_index=True)
    weight = np.ones(len(pool))

    audits = []
    for w in sorted(pool.loc[pool["source"] == "B", "window"].unique()):
        refs = past_ref[timeline.loc[past_ref, "window"] == w]
        a = {"window": int(w), **audit_window(cp_a, cp_b, refs)}
        rows = ((pool["source"] == "B") & (pool["window"] == w)).to_numpy()
        a["b_records"] = int(rows.sum())
        if a["action"] == "recalibrate":
            pool.loc[rows, ENERGY_COLS] = pool.loc[rows, ENERGY_COLS] / a["ratio"]
        elif a["action"] == "unverified":
            weight[rows] = UNVERIFIED_WEIGHT
        audits.append(a)

    auto_a = pool.loc[pool["source"] == "A", "window"]
    a_age = int(window - 1 - auto_a.max()) if len(auto_a) else window
    is_b = (pool["source"] == "B").to_numpy()
    health = {
        "b_records": int(is_b.sum()),
        "b_recalibrated": int(sum(a["b_records"] for a in audits if a["action"] == "recalibrate")),
        "b_unverified": int(sum(a["b_records"] for a in audits if a["action"] == "unverified")),
        "records_discarded": 0,
        "reference_flights_in_training": int(len(past_ref)),
        "auto_a_upload_age_windows": a_age,
        "unverified_weight_share": float(weight[is_b & (weight < 1)].sum() / weight.sum()),
    }
    return pool, weight, audits, health


class TrustedModel:
    """Hybrid model whose P90 is calibrated on held-out recent trusted flights (sources A and R)."""

    def __init__(self, seed: int):
        self.seed = seed

    def fit(self, pool: pd.DataFrame, weight: np.ndarray, cp_a: pd.DataFrame, window: int,
            timeline: pd.DataFrame, ref_ids: pd.Index) -> "TrustedModel":
        trusted = pool[pool["source"].isin(["A", "R"]) & (pool["window"] >= window - CAL_WINDOWS)]
        by_order = trusted.groupby("flight")["order"].first().sort_values()
        cap = max(MIN_CAL_FLIGHTS, int(MAX_CAL_SHARE * pool["flight"].nunique()))
        recent = pd.Index(by_order.index[-cap:])
        self.n_cal_flights = len(recent)
        if len(recent) < MIN_CAL_FLIGHTS:
            # Fallback: no trusted flights, so calibrate on recent training data as before.
            self.model = hm.EnergyModel("hybrid", self.seed, calibrate=True).fit(pool, weight)
            self.trusted_raw_coverage = np.nan
            self.calibration = "fallback_recent_training_data"
            self.trusted_raw_coverage = np.nan
            return self
        keep = ~pool["flight"].isin(recent).to_numpy()
        probe = hm.EnergyModel("hybrid", self.seed, calibrate=False).fit(pool[keep], weight[keep])
        cal = cp_a[cp_a["flight"].isin(recent)]
        _, e90 = probe.predict(cal)
        actual = cal["e_rem_wh"].to_numpy()
        self.trusted_raw_coverage = float(np.mean(actual <= e90))
        score = actual / np.clip(e90, 1e-3, None)
        n = len(score)
        self.model = hm.EnergyModel("hybrid", self.seed, calibrate=False).fit(pool, weight)
        self.model.p90_scale = float(np.quantile(score, min(np.ceil((n + 1) * 0.9) / n, 1.0)))
        self.calibration = "trusted_recent_flights"
        return self

    def predict(self, cp: pd.DataFrame):
        return self.model.predict(cp)


def health_status(health: dict, calibration: str) -> str:
    """green / amber / red for the operator's data health badge."""
    if health["unverified_weight_share"] > RED_UNVERIFIED_SHARE:
        return "red"
    if (health["auto_a_upload_age_windows"] > STALE_LIMIT_WINDOWS or health["b_unverified"] > 0
            or health["b_recalibrated"] > 0 or calibration != "trusted_recent_flights"):
        return "amber"
    return "green"


def decide_with_review(pred: pd.DataFrame, usable_wh: float, status: str) -> pd.DataFrame:
    """Flight-level outcome of CONTINUE / RETURN / DEFER, before the halfway deadline.

    returned = a RETURN or a DEFER happened before the deadline (deferred flights are
    assumed returned by the operator). deferred = the first non-continue was a DEFER.
    """
    rows = []
    for fid, g in pred.sort_values("t").groupby("flight", sort=False):
        lo = g["e_used_wh"] + g["e50"]
        hi = g["e_used_wh"] + g["e90"]
        live = (g["e_used_wh"] <= usable_wh) & (g["route_frac"] <= hm.DECISION_DEADLINE_FRAC)
        ret = hi > usable_wh
        defer = (ret & (lo <= usable_wh)) | (
            (status == "red") & ~ret & (usable_wh - hi < REVIEW_MARGIN_WH))
        act = live & (ret | defer)
        first = act.idxmax() if act.any() else None
        rows.append({
            "flight": fid,
            "needs_return": bool(g["e_total_wh"].iloc[0] > usable_wh),
            "called": first is not None,
            "deferred": bool(first is not None and defer[first]),
        })
    return pd.DataFrame(rows)
