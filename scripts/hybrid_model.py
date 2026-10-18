"""Hybrid in-flight energy model for the CMU package-delivery drone.

The question the model answers, at checkpoints during a flight:
"How much more energy (Wh) will this flight use before it lands?"

It splits that into two parts:
  physics   energy used so far by Coulomb counting (integral of voltage x current),
            and a kinematic estimate of the time left on the planned route (T_plan)
  ML        the power the drone will burn over that remaining time. A gradient-boosted
            quantile model predicts P50 and P90 of
                P_eff = remaining energy / T_plan   (W)
            so energy_needed = P_eff x T_plan. Any systematic error in T_plan is
            absorbed into P_eff, which keeps the quantiles honest.

The P90 is recalibrated by split-conformal calibration: the model is first fitted
without the most recent training flights, its P90 is scaled so that 90% of those
recent outcomes fall under it, and that scale is applied to the model refitted on
all training flights. Raw quantile models were overconfident on later flights.

The decision rule compares the conservative P90 estimate with the energy left:
    continue  if  energy_used + energy_needed_P90  <=  usable_wh
    return    otherwise
where usable_wh is the energy assigned to the mission after the safety reserve.
Real flights never got near empty, so usable_wh is a simulated scenario setting.
Routes are loops that land at the launch point, so a "return" call only helps
before the halfway point. After that, finishing the loop is the quickest way home.

Two comparison models share the same checkpoints and features:
  physics_only  recent 30 s mean power x T_plan (P90 from a calibrated ratio)
  direct_ml     the same boosted model predicting remaining energy directly

Everything here takes plain DataFrames so the degradation experiments can corrupt
raw sensor columns, rebuild checkpoints and refit with the same code.

scikit-learn's HistGradientBoostingRegressor is used for the boosted models. It is
the same histogram gradient-boosting algorithm as LightGBM and avoids an extra
dependency.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LinearRegression

CHECKPOINT_STEP_S = 10.0
MOTOR_ON_W = 150.0  # power above this means the rotors are spinning
CRUISE_START_FRAC = 0.05  # share of route flown before the climb counts as over
CRUISE_END_FRAC = 0.93  # share of route flown after which the drone is descending
PACK_WH = 99.9  # DJI TB47D: 4500 mAh at 22.2 V
DECISION_DEADLINE_FRAC = 0.5  # a return call must come before this share of the route
CALIB_FRAC = 0.2  # most recent share of training flights held out to calibrate P90

PHASES = {"climb": 0, "cruise": 1, "descent": 2}

ML_FEATURES = [
    "payload",
    "speed_plan",
    "alt_target",
    "elapsed_s",
    "e_used_wh",
    "alt_now",
    "vz_5s",
    "gs_5s",
    "dist_so_far",
    "dist_rem",
    "p_10s",
    "p_30s",
    "wind_10s",
    "wind_rel_sin",
    "wind_rel_cos",
    "volt_10s",
    "phase",
    "t_plan_s",
    "cruise_left_s",
]
TIME_FEATURES = ["cruise_left_s", "climb_left_m", "descent_alt_m", "is_climb", "is_cruise"]


# ---------------------------------------------------------------- data loading


def load_cruise_flights(raw_dir: Path) -> pd.DataFrame:
    """Raw rows for the 196 cruise flights (routes R1-R7), time-sorted per flight."""
    df = pd.read_csv(Path(raw_dir) / "flights.csv", dtype={"altitude": str})
    df = df[df["route"].str.match(r"^R\d$")]
    return df.sort_values(["flight", "time"]).reset_index(drop=True)


def flight_table(df: pd.DataFrame) -> pd.DataFrame:
    """One row per flight with plan parameters, start timestamp and chronological rank."""
    meta = df.groupby("flight")[["speed", "payload", "altitude", "date", "time_day", "route"]].first()
    meta["start"] = pd.to_datetime(meta["date"] + " " + meta["time_day"])
    meta = meta.sort_values(["start", meta.index.name or "flight"])
    meta["order"] = np.arange(len(meta))
    return meta


def route_lengths(df: pd.DataFrame) -> dict[str, float]:
    """Planned route length per route: the median ground distance flown on that route.

    The mission plan is known before take-off, so this stands in for the planned
    length rather than using each flight's own flown distance.
    """
    dist = {}
    for fid, g in df.groupby("flight"):
        t = g["time"].to_numpy()
        vxy = np.hypot(g["velocity_x"].to_numpy(), g["velocity_y"].to_numpy())
        dist[fid] = (g["route"].iloc[0], np.trapezoid(vxy, t))
    s = pd.DataFrame(dist.values(), columns=["route", "dist"])
    return s.groupby("route")["dist"].median().to_dict()


def _alt_targets(altitude: str) -> tuple[float, float]:
    """First and last planned altitude. Two R7 flights use a profile like '25-50-100-25'."""
    parts = [float(p) for p in str(altitude).split("-")]
    return parts[0], parts[-1]


# ---------------------------------------------------------------- checkpoints


def _cumulative(t: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(np.diff(t) * (y[1:] + y[:-1]) / 2)])


def _window_mean(t: np.ndarray, y: np.ndarray, t_end: float, width: float) -> float:
    m = (t > t_end - width) & (t <= t_end)
    return float(y[m].mean()) if m.any() else float(y[np.searchsorted(t, t_end, side="right") - 1])


def flight_checkpoints(
    g: pd.DataFrame,
    route_len: float,
    step: float = CHECKPOINT_STEP_S,
    bounds: tuple[float, float] | None = None,
) -> pd.DataFrame:
    """Checkpoint rows for one flight: features known at time t, and the outcome after t.

    bounds overrides when the rotors start and stop (seconds from the first row).
    Experiments that corrupt the battery sensor pass the clean bounds, since the
    flight controller, not the current sensor, knows when the motors run.
    """
    t = g["time"].to_numpy(dtype=float)
    t = t - t[0]
    volts = g["battery_voltage"].to_numpy(dtype=float)
    amps = g["battery_current"].to_numpy(dtype=float)
    power = volts * amps
    energy_wh = _cumulative(t, power) / 3600.0  # Coulomb counting

    if bounds is None:
        on = np.flatnonzero(power > MOTOR_ON_W)
        if len(on) == 0:
            return pd.DataFrame()
        t_on, t_off = t[on[0]], t[on[-1]]
    else:
        t_on, t_off = bounds
    e_on = np.interp(t_on, t, energy_wh)
    e_off = np.interp(t_off, t, energy_wh)

    up = g["position_z"].to_numpy() - g["position_z"].iloc[:10].mean()
    vz = g["velocity_z"].to_numpy()
    vxy = np.hypot(g["velocity_x"].to_numpy(), g["velocity_y"].to_numpy())
    dist = _cumulative(t, vxy)

    x, y, z, w = (g[f"orientation_{c}"].to_numpy() for c in "xyzw")
    yaw = np.degrees(np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))
    heading_mag = (-yaw) % 360  # yaw runs counter-clockwise from magnetic north
    rel = np.radians(g["wind_angle"].to_numpy() - heading_mag)
    wind = g["wind_speed"].to_numpy()

    first = g.iloc[0]
    alt_first, alt_last = _alt_targets(first["altitude"])
    speed_plan = float(first["speed"])

    rows = []
    for tc in np.arange(t_on + 5.0, t_off - 5.0 + 1e-9, step):
        e_used = float(np.interp(tc, t, energy_wh) - e_on)
        d = float(np.interp(tc, t, dist))
        alt_now = _window_mean(t, up, tc, 2.0)
        vz5 = _window_mean(t, vz, tc, 5.0)
        dist_rem = max(route_len - d, 0.0)
        if d < CRUISE_START_FRAC * route_len:
            phase = "climb"
        elif d >= CRUISE_END_FRAC * route_len or (d >= 0.5 * route_len and vz5 < -1.0):
            phase = "descent"
        else:
            phase = "cruise"
        rows.append(
            {
                "t": tc,
                "elapsed_s": tc - t_on,
                "e_used_wh": e_used,
                "alt_now": alt_now,
                "vz_5s": vz5,
                "gs_5s": _window_mean(t, vxy, tc, 5.0),
                "dist_so_far": d,
                "dist_rem": dist_rem,
                "route_frac": d / route_len,
                "p_10s": _window_mean(t, power, tc, 10.0),
                "p_30s": _window_mean(t, power, tc, 30.0),
                "wind_10s": _window_mean(t, wind, tc, 10.0),
                "wind_rel_sin": _window_mean(t, np.sin(rel), tc, 10.0),
                "wind_rel_cos": _window_mean(t, np.cos(rel), tc, 10.0),
                "volt_10s": _window_mean(t, volts, tc, 10.0),
                "phase": PHASES[phase],
                "cruise_left_s": dist_rem / speed_plan,
                "climb_left_m": max(alt_first - alt_now, 0.0) if phase == "climb" else 0.0,
                "descent_alt_m": alt_last if phase == "climb" else alt_now,
                "is_climb": float(phase == "climb"),
                "is_cruise": float(phase == "cruise"),
                # outcomes after t: never used as features
                "e_rem_wh": float(e_off - np.interp(tc, t, energy_wh)),
                "t_rem_s": t_off - tc,
                "e_total_wh": float(e_off - e_on),
            }
        )
    out = pd.DataFrame(rows)
    out["payload"] = float(first["payload"])
    out["speed_plan"] = speed_plan
    out["alt_target"] = alt_first
    return out


def build_checkpoints(
    df: pd.DataFrame,
    route_len: dict[str, float],
    step: float = CHECKPOINT_STEP_S,
    bounds: dict | None = None,
) -> pd.DataFrame:
    parts = []
    for fid, g in df.groupby("flight", sort=False):
        b = bounds.get(fid) if bounds is not None else None
        cp = flight_checkpoints(g, route_len[g["route"].iloc[0]], step, b)
        if len(cp):
            cp.insert(0, "flight", fid)
            parts.append(cp)
    return pd.concat(parts, ignore_index=True)


# ---------------------------------------------------------------- models


class TimePlan:
    """Kinematic estimate of time left: climb, cruise at planned speed, descent, landing.

    The rates (seconds per metre of climb or descent, overhead per phase) are fitted
    by least squares on training checkpoints, with non-negative coefficients.
    """

    def fit(self, cp: pd.DataFrame) -> "TimePlan":
        self.lr = LinearRegression(positive=True).fit(cp[TIME_FEATURES], cp["t_rem_s"])
        return self

    def predict(self, cp: pd.DataFrame) -> np.ndarray:
        return np.clip(self.lr.predict(cp[TIME_FEATURES]), 5.0, None)


def _gbm(quantile: float, seed: int) -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        loss="quantile",
        quantile=quantile,
        max_iter=300,
        learning_rate=0.05,
        max_leaf_nodes=15,
        min_samples_leaf=20,
        l2_regularization=1.0,
        max_features=0.8,
        early_stopping=False,
        random_state=seed,
    )


@dataclass
class EnergyModel:
    """kind: 'hybrid', 'direct_ml' or 'physics_only'. predict() returns (e50, e90) in Wh.

    With calibrate=True, fit() needs an 'order' column (chronological flight rank) so
    it can hold out the most recent training flights for the P90 calibration.
    """

    kind: str = "hybrid"
    seed: int = 0
    calibrate: bool = True

    def fit(self, cp: pd.DataFrame, sample_weight: np.ndarray | None = None) -> "EnergyModel":
        self.p90_scale = 1.0
        if self.calibrate:
            order = cp.groupby("flight")["order"].first().sort_values()
            cal_ids = order.index[-max(round(CALIB_FRAC * len(order)), 5):]
            early = ~cp["flight"].isin(cal_ids).to_numpy()
            w = None if sample_weight is None else np.asarray(sample_weight)[early]
            probe = EnergyModel(self.kind, self.seed, calibrate=False).fit(cp[early], w)
            _, e90 = probe.predict(cp[~early])
            score = cp.loc[~early, "e_rem_wh"].to_numpy() / np.clip(e90, 1e-3, None)
            n = len(score)
            self.p90_scale = float(np.quantile(score, min(np.ceil((n + 1) * 0.9) / n, 1.0)))
        self.time = TimePlan().fit(cp)
        X = self._features(cp)
        if self.kind == "hybrid":
            y = cp["e_rem_wh"] * 3600.0 / X["t_plan_s"]  # P_eff in W
        elif self.kind == "direct_ml":
            y = cp["e_rem_wh"]
        elif self.kind == "physics_only":
            base = X["p_30s"] * X["t_plan_s"] / 3600.0
            ratio = cp["e_rem_wh"] / base.clip(lower=0.05)
            self.ratio50 = float(np.quantile(ratio, 0.5))
            self.ratio90 = float(np.quantile(ratio, 0.9))
            return self
        else:
            raise ValueError(self.kind)
        self.q50 = _gbm(0.5, self.seed).fit(X[ML_FEATURES], y, sample_weight=sample_weight)
        self.q90 = _gbm(0.9, self.seed).fit(X[ML_FEATURES], y, sample_weight=sample_weight)
        return self

    def _features(self, cp: pd.DataFrame) -> pd.DataFrame:
        X = cp.copy()
        X["t_plan_s"] = self.time.predict(cp)
        return X

    def predict(self, cp: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        X = self._features(cp)
        if self.kind == "physics_only":
            base = (X["p_30s"] * X["t_plan_s"] / 3600.0).to_numpy()
            e50, e90 = base * self.ratio50, base * self.ratio90
        else:
            p50 = np.clip(self.q50.predict(X[ML_FEATURES]), 0, None)
            p90 = np.clip(self.q90.predict(X[ML_FEATURES]), 0, None)
            scale = X["t_plan_s"].to_numpy() / 3600.0 if self.kind == "hybrid" else 1.0
            e50, e90 = p50 * scale, p90 * scale
        return e50, np.maximum(e90 * self.p90_scale, e50)


# ---------------------------------------------------------------- evaluation


def error_metrics(actual: np.ndarray, e50: np.ndarray, e90: np.ndarray) -> dict:
    err = e50 - actual  # negative = underestimate = unsafe direction
    return {
        "n_checkpoints": int(len(actual)),
        "mae_wh": float(np.mean(np.abs(err))),
        "rmse_wh": float(np.sqrt(np.mean(err**2))),
        "bias_wh": float(np.mean(err)),
        "abs_err_p90_wh": float(np.quantile(np.abs(err), 0.9)),
        "underestimate_gt_1wh_rate": float(np.mean(err < -1.0)),
        "p90_coverage": float(np.mean(actual <= e90)),
        "p90_mean_margin_wh": float(np.mean(e90 - actual)),
    }


def decide(pred: pd.DataFrame, usable_wh: float, col: str = "e90") -> pd.DataFrame:
    """Flight-level outcome of the continue/return rule for one usable-energy budget.

    needs_return  the flight's true mission energy exceeds usable_wh
    called        the rule said "return" at a checkpoint before the decision deadline
                  (halfway round the route) while energy_used <= usable_wh. A later call
                  is too late to help and counts as missed.

    The rule acts on e_used_wh, the energy the system believes it has used. If the
    live sensor is degraded, pass the clean value as e_used_true_wh: the deadline and
    the call margin are then judged on the true energy.
    """
    rows = []
    for fid, g in pred.sort_values("t").groupby("flight", sort=False):
        used_true = g["e_used_true_wh"] if "e_used_true_wh" in g else g["e_used_wh"]
        over = g["e_used_wh"] + g[col] > usable_wh
        in_time = (used_true <= usable_wh) & (g["route_frac"] <= DECISION_DEADLINE_FRAC)
        hit = g[over & in_time]
        rows.append(
            {
                "flight": fid,
                "needs_return": bool(g["e_total_wh"].iloc[0] > usable_wh),
                "called": len(hit) > 0,
                "call_elapsed_s": float(hit["elapsed_s"].iloc[0]) if len(hit) else np.nan,
                "call_margin_wh": float(usable_wh - used_true[hit.index].iloc[0]) if len(hit) else np.nan,
            }
        )
    return pd.DataFrame(rows)


def decision_metrics(outcomes: pd.DataFrame) -> dict:
    """Positive class = 'should return'. FN = unsafe continue, FP = needless abort."""
    pos, called = outcomes["needs_return"], outcomes["called"]
    tp, fn = int((pos & called).sum()), int((pos & ~called).sum())
    fp, tn = int((~pos & called).sum()), int((~pos & ~called).sum())
    return {
        "flights": int(len(outcomes)),
        "tp": tp,
        "fn_unsafe_continue": fn,
        "fp_needless_abort": fp,
        "tn": tn,
        "miss_rate": fn / (tp + fn) if tp + fn else None,
        "false_abort_rate": fp / (fp + tn) if fp + tn else None,
        "mean_call_margin_wh_tp": float(outcomes.loc[pos & called, "call_margin_wh"].mean()) if tp else None,
    }


def motor_bounds(cp: pd.DataFrame) -> dict:
    """Per-flight (t_on, t_off) recovered from checkpoints, for build_checkpoints(bounds=...)."""
    first = cp.groupby("flight").first()
    return {f: (r.t - r.elapsed_s, r.t + r.t_rem_s) for f, r in first.iterrows()}


def chronological_folds(flights: pd.DataFrame, cuts=(0.4, 0.6, 0.8)) -> list[dict]:
    """Expanding-window folds split at flight-day boundaries, never inside a day.

    Fold k trains on every flight before cut k and tests on the flights up to the next cut.
    """
    days = flights.groupby("date").size().sort_index()
    cum = days.cumsum() / days.sum()
    bounds = [cum.index[np.argmin(np.abs(cum.to_numpy() - c))] for c in cuts] + [days.index[-1]]
    folds = []
    for k, c in enumerate(cuts):
        train_last, test_last = bounds[k], bounds[k + 1]
        train = flights.index[flights["date"] <= train_last]
        test = flights.index[(flights["date"] > train_last) & (flights["date"] <= test_last)]
        folds.append(
            {
                "name": f"fold{k + 1}",
                "train_flights": list(train),
                "test_flights": list(test),
                "train_dates": [str(flights.loc[train, "date"].min()), str(train_last)],
                "test_dates": [str(flights.loc[test, "date"].min()), str(test_last)],
            }
        )
    return folds
