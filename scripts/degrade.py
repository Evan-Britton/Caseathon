"""Controlled data defects for the degradation experiments.

Everything here is SIMULATED. It stands in for accidental real-world failures:
the CMU recordings contain no ingestion outages, no second sensor feed and no
long-term fleet history.

Simulated timeline
  The 196 cruise flights are re-sequenced into operating windows in which the
  package mix drifts from mostly 0 g towards mostly 500 g. Each window is about
  one retraining cycle of a delivery operation.

Two logging sources (training/update stage)
  A  the accurate logger (Mauch PL-200 current sensor, as recorded)
  B  a cheap, fast telemetry feed: current reads low by a fixed fraction plus
     noise, and it logs at twice the checkpoint rate, so it adds more records per
     flight than A. Its share of flights grows across windows.

Stale ingestion (training/update stage)
  A's uploads stop after a given window, so the training set stops receiving
  accurate records while operations keep changing.

Live-sensor defects (input stage, for the stage comparison)
  frozen telemetry   voltage and current hold their last value from part-way
                     through the flight (a dropped link with last-value hold)
  biased sensor      the live current sensor reads low, like source B
"""

from __future__ import annotations

import numpy as np
import pandas as pd

import hybrid_model as hm

N_WINDOWS = 8
TIMELINE_NOISE = 0.8  # spread of the payload-driven ordering key, in payload steps
B_CURRENT_FACTOR = 0.88  # source B reads current 12% low
B_NOISE_SD_A = 1.0  # extra per-sample current noise on B (A)
B_CHECKPOINT_STEP_S = hm.CHECKPOINT_STEP_S / 2  # B logs twice as often
PLACEBO_NOISE_SD_A = 3.0  # unbiased noise with an error size comparable to B's bias


def simulated_timeline(flights: pd.DataFrame, seed: int = 0) -> pd.DataFrame:
    """Assign each flight a window (0..N_WINDOWS-1) and a simulated order.

    Flights are sorted by payload level plus noise, so early windows are mostly
    0 g and late windows mostly 500 g, with overlap between neighbours. Within a
    window, flights keep their real chronological order.
    """
    rng = np.random.default_rng(seed)
    levels = flights["payload"].clip(upper=500) / 250.0  # 0, 1, 2 (the one 750 g flight -> 2)
    key = levels + rng.normal(0, TIMELINE_NOISE, len(flights))
    ranked = flights.assign(key=key.to_numpy()).sort_values("key")
    ranked["window"] = np.arange(len(ranked)) * N_WINDOWS // len(ranked)
    ranked = ranked.sort_values(["window", "start"])
    ranked["sim_order"] = np.arange(len(ranked))
    return ranked[["window", "sim_order"]]


def low_quality_share(window: int, max_share: float = 0.9, per_window: float = 0.15) -> float:
    """Share of a window's flights logged only by the cheap feed B."""
    return min(max_share, per_window * window)


def assign_sources(timeline: pd.DataFrame, schedule, seed: int) -> pd.Series:
    """'A' or 'B' per flight. schedule(window) gives the share of flights on B."""
    rng = np.random.default_rng(seed + 1000)
    u = rng.random(len(timeline))
    share = timeline["window"].map(schedule).to_numpy()
    return pd.Series(np.where(u < share, "B", "A"), index=timeline.index)


def corrupt_current(
    df: pd.DataFrame,
    factor: float | pd.Series,
    noise_sd: float,
    seed: int,
    after_s: float = 0.0,
    offset_a: float = 0.0,
) -> pd.DataFrame:
    """current -> current x factor + offset_a + Gaussian noise, from after_s seconds in.

    factor is a constant or a Series indexed by flight id (for a bias that drifts).
    """
    rng = np.random.default_rng(seed + 2000)
    out = df.copy()
    t = out["time"] - out.groupby("flight")["time"].transform("min")
    m = (t >= after_s).to_numpy()
    f = out["flight"].map(factor).to_numpy(dtype=float)[m] if isinstance(factor, pd.Series) else factor
    cur = out["battery_current"].to_numpy(dtype=float).copy()
    cur[m] = cur[m] * f + offset_a + rng.normal(0, noise_sd, m.sum())
    out["battery_current"] = cur
    return out


def freeze_telemetry(df: pd.DataFrame, route_len: dict[str, float], at_route_frac: float) -> pd.DataFrame:
    """Hold voltage and current at their last value once the drone has flown at_route_frac of its route."""
    out = df.copy()
    for fid, g in out.groupby("flight"):
        t = g["time"].to_numpy()
        vxy = np.hypot(g["velocity_x"].to_numpy(), g["velocity_y"].to_numpy())
        dist = np.concatenate([[0.0], np.cumsum(np.diff(t) * (vxy[1:] + vxy[:-1]) / 2)])
        idx = np.flatnonzero(dist >= at_route_frac * route_len[g["route"].iloc[0]])
        if len(idx) == 0:
            continue
        rows = g.index[idx[0]:]
        for col in ("battery_voltage", "battery_current"):
            out.loc[rows, col] = g[col].iloc[idx[0]]
    return out


def training_pool(
    cp_a: pd.DataFrame,
    cp_b: pd.DataFrame,
    timeline: pd.DataFrame,
    sources: pd.Series,
    window: int,
    stale_after: int | None,
) -> pd.DataFrame:
    """Checkpoints the system has ingested when it retrains at the start of `window`.

    Flights from earlier windows arrive from their logging source: A flights as
    clean 10 s checkpoints, B flights as biased 5 s checkpoints. With stale_after
    set, A uploads stop after that window: A flights from later windows never arrive.
    Adds columns: source, window, age_windows (how many windows old the record is).
    """
    past = timeline.index[timeline["window"] < window]
    src = sources.reindex(past)
    a_ids = src.index[src == "A"]
    if stale_after is not None:
        a_ids = a_ids[timeline.loc[a_ids, "window"] <= stale_after]
    b_ids = src.index[src == "B"]
    pool = pd.concat(
        [
            cp_a[cp_a["flight"].isin(a_ids)].assign(source="A"),
            cp_b[cp_b["flight"].isin(b_ids)].assign(source="B"),
        ],
        ignore_index=True,
    )
    pool["window"] = pool["flight"].map(timeline["window"])
    pool["age_windows"] = window - pool["window"]
    pool["order"] = pool["flight"].map(timeline["sim_order"])
    return pool
