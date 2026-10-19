import type { FlightForecast, FlightMeta } from "./types";

/**
 * The in-flight mission check, computed live from the model's forecast and the battery budget.
 *
 * At each forecast point (once per second) the drone has used `used` Wh and the model expects to
 * need `e50` more (median) or `e90` more (P90, the safety margin) before landing:
 *   CONTINUE  even the P90 total fits the budget
 *   RETURN    even the median total doesn't fit: turn back
 *   REVIEW    the P50–P90 band straddles the budget: too close to call, ask the operator
 * Routes are loops back to launch, so a call only helps before the halfway point (`deadlineFrac`).
 * After that the drone is committed: finishing the loop is the quickest way home.
 */

export type CallType = "continue" | "return" | "review";

export interface MissionCall {
  type: CallType;
  /** s: when the call was made. For "continue", the moment the decision window closed. */
  t: number;
  idx: number;
}

export type Phase = "na" | "standby" | "deciding" | "committed" | "landed" | "lost";

export interface Estimate {
  used: number;
  need50: number; // total mission energy, median forecast
  need90: number; // total mission energy, P90
  margin: number; // budget minus the P90 total: negative means it may not make it
}

export interface MissionState {
  phase: Phase;
  /** The call the system has committed to by this time (null while it is still watching). */
  call: MissionCall | null;
  /** What the live forecast says right now, before or after the deadline. */
  live: CallType | null;
  est: Estimate | null;
  idx: number;
}

export function classify(used: number, e50: number, e90: number, budget: number): CallType {
  if (used + e90 <= budget) return "continue";
  if (used + e50 > budget) return "return";
  return "review";
}

/** Index of the last forecast point at or before time t, or -1 before the first one. */
export function indexAt(fc: FlightForecast, t: number): number {
  const ts = fc.t;
  if (t < ts[0]) return -1;
  let lo = 0;
  let hi = ts.length - 1;
  if (t >= ts[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Time the decision window closes: the first forecast point past the deadline share of the route. */
export function deadlineTime(fc: FlightForecast, deadlineFrac: number): number {
  const k = fc.frac.findIndex((f) => f > deadlineFrac);
  return k < 0 ? fc.t[fc.t.length - 1] : fc.t[k];
}

/** The first non-continue call inside the decision window, else "continue" at the deadline. */
export function missionCall(fc: FlightForecast, budget: number, deadlineFrac: number): MissionCall {
  let last = 0;
  for (let i = 0; i < fc.t.length; i++) {
    if (fc.frac[i] > deadlineFrac || fc.used[i] > budget) break;
    last = i;
    const c = classify(fc.used[i], fc.e50[i], fc.e90[i], budget);
    if (c !== "continue") return { type: c, t: fc.t[i], idx: i };
  }
  return { type: "continue", t: deadlineTime(fc, deadlineFrac), idx: last };
}

export function estimateAt(fc: FlightForecast, i: number, budget: number): Estimate {
  const used = fc.used[i];
  const need50 = used + fc.e50[i];
  const need90 = used + fc.e90[i];
  return { used, need50, need90, margin: budget - need90 };
}

export function missionState(
  fc: FlightForecast | null,
  meta: FlightMeta | null,
  budget: number,
  deadlineFrac: number,
  t: number,
): MissionState {
  if (!fc || !meta) return { phase: "na", call: null, live: null, est: null, idx: -1 };
  const call = missionCall(fc, budget, deadlineFrac);
  const i = indexAt(fc, t);
  if (meta.simulated && t >= (meta.failureS ?? Infinity)) {
    const k = fc.t.length - 1;
    return { phase: "lost", call: t >= call.t ? call : null, live: null, est: estimateAt(fc, k, budget), idx: k };
  }
  if (i < 0) return { phase: "standby", call: null, live: null, est: null, idx: -1 };
  const est = estimateAt(fc, i, budget);
  const live = classify(est.used, fc.e50[i], fc.e90[i], budget);
  const committed = t >= call.t;
  const pastEnd = t > fc.t[fc.t.length - 1];
  const phase: Phase = pastEnd ? "landed" : fc.frac[i] > deadlineFrac ? "committed" : "deciding";
  return { phase, call: committed ? call : null, live, est, idx: i };
}

export type OutcomeKind = "right-return" | "unsafe-continue" | "needless-return" | "right-continue";

export interface Outcome {
  kind: OutcomeKind;
  needsReturn: boolean;
  spareWh: number; // budget minus what the mission actually used (negative = it would have run out)
}

/** Hindsight: compare the call with what the flight actually used. A REVIEW counts as a return. */
export function outcome(fc: FlightForecast, call: MissionCall, budget: number): Outcome {
  const needsReturn = fc.totalWh > budget;
  const returned = call.type !== "continue";
  const kind: OutcomeKind = needsReturn
    ? returned ? "right-return" : "unsafe-continue"
    : returned ? "needless-return" : "right-continue";
  return { kind, needsReturn, spareWh: budget - fc.totalWh };
}
