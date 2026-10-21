import { loadFlight, loadForecast, loadScenarios } from "./data";
import { reroute } from "./fleetRoutes";
import { deadlineTime, missionCall, missionState } from "./mission";
import type { CallType, MissionCall, MissionState } from "./mission";
import type { FlightForecast, FlightMeta, FlightScenarios, FlightSeries, ScenarioCondition } from "./types";

/**
 * The SIMULATED fleet for the operator console: five real CMU flights replayed together as if
 * one operator were watching five medical-resupply drones. The data has one aircraft, so this
 * is a staging choice, not a measurement. Cargo names are illustrative; the payload is real.
 *
 * Each battery is chosen from the poisoning lab's demo search, so the fleet mixes easy calls
 * with flights where a poisoned model is wrong:
 *   268  poisoned says CONTINUE, the flight really needs 0.1 Wh more than the pack has
 *   166  same, and the fix upgrades it to a clear RETURN
 *    99  comfortable margin: every model agrees
 *    93  pack too small: every model says RETURN
 *   276  a tight pack the flight just fits: even the clean model is cautious
 *
 * Destinations are made up. Each route is redrawn as an out-and-back (see fleetRoutes.ts); the
 * recorded flights are all the same triangle.
 */
export interface FleetSlot {
  flight: number;
  callsign: string;
  cargo: string;
  budgetWh: number;
  /** Made-up delivery destination, for the story. */
  destination: string;
  /** Direction out from the hub, degrees clockwise from north. */
  bearing: number;
}

export const HUB_NAME = "Central supply hub";

export const FLEET: FleetSlot[] = [
  { flight: 268, callsign: "Drone 1", cargo: "Blood unit", budgetWh: 28.5, destination: "Ridgeline Clinic", bearing: 25 },
  { flight: 99, callsign: "Drone 2", cargo: "Insulin", budgetWh: 30.5, destination: "Harlan Creek Health Post", bearing: 320 },
  { flight: 166, callsign: "Drone 3", cargo: "Antivenom", budgetWh: 22.0, destination: "Millbrook Rural Clinic", bearing: 75 },
  { flight: 93, callsign: "Drone 4", cargo: "Lab specimens", budgetWh: 18.0, destination: "Valley Diagnostic Lab", bearing: 250 },
  { flight: 276, callsign: "Drone 5", cargo: "Vaccines", budgetWh: 15.5, destination: "Cedar Hollow Outreach Site", bearing: 150 },
];

export interface LoadedDrone {
  slot: FleetSlot;
  meta: FlightMeta;
  forecast: FlightForecast;
  scenarios: FlightScenarios;
  /** The flight with its horizontal path redrawn as an out-and-back route; everything else is as recorded. */
  series: FlightSeries;
  /** The turnaround point, metres east and north of this drone's launch point. */
  dest: { east: number; north: number };
  /** One-way distance to the destination, metres. */
  oneWayM: number;
  window: number;
}

export async function loadFleet(
  flights: FlightMeta[],
  flightWindow: Record<string, number>,
): Promise<LoadedDrone[]> {
  return Promise.all(
    FLEET.map(async (slot) => {
      const meta = flights.find((f) => f.id === slot.flight);
      if (!meta) throw new Error(`Flight ${slot.flight} isn't in the data.`);
      const [forecast, scenarios, series] = await Promise.all([
        loadForecast(slot.flight),
        loadScenarios(slot.flight),
        loadFlight(slot.flight),
      ]);
      const routed = reroute(series, slot.bearing);
      return {
        slot,
        meta,
        forecast,
        scenarios,
        series: routed.series,
        dest: routed.dest,
        oneWayM: routed.oneWayM,
        window: flightWindow[String(slot.flight)],
      };
    }),
  );
}

const forecastCache = new Map<string, FlightForecast>();

/** The flight's forecast as the model for this training condition would have made it. */
export function forecastFor(d: LoadedDrone, condition: ScenarioCondition, fix: boolean): FlightForecast {
  const key = `${d.slot.flight}/${condition}/${fix}`;
  let fc = forecastCache.get(key);
  if (!fc) {
    const run = d.scenarios.runs[`${condition}/${fix ? "on" : "off"}`];
    fc = run && d.scenarios.n === d.forecast.t.length ? { ...d.forecast, e50: run.e50, e90: run.e90 } : d.forecast;
    forecastCache.set(key, fc);
  }
  return fc;
}

export type OperatorAction = "return" | "continue";

export interface Decision {
  action: OperatorAction;
  /** Fleet time (s) when the operator acted. */
  at: number;
  /** Wall-clock seconds the operator took, from the request appearing to the click. */
  seconds: number;
}

export type Verdict =
  | "delivered" // continued, and it made it
  | "ran-short" // continued, and the pack would have run out
  | "returned-right" // turned back, and it needed to
  | "returned-needless" // turned back, but it would have made it
  | "no-decision-ok" // a call went unanswered, the drone continued and made it
  | "no-decision-short"; // a call went unanswered, the drone continued and ran short

export interface DroneView {
  fc: FlightForecast;
  budget: number;
  state: MissionState;
  call: MissionCall;
  deadlineT: number;
  /** The system wants the operator to look: a RETURN or REVIEW call, still inside the decision window. */
  needsDecision: boolean;
  /** The decision window has closed (halfway round the route), so the outcome is fixed. */
  settled: boolean;
  verdict: Verdict | null;
  /** What the drone is doing, in words. */
  status: string;
  tone: "go" | "warn" | "stop" | "idle" | "done";
}

export function droneView(
  d: LoadedDrone,
  condition: ScenarioCondition,
  fix: boolean,
  deadlineFrac: number,
  t: number,
  decision: Decision | undefined,
): DroneView {
  const fc = forecastFor(d, condition, fix);
  const budget = d.slot.budgetWh;
  // A recalled drone stops here: its forecast and gauge freeze at the moment of the order.
  const te = decision?.action === "return" ? Math.min(t, decision.at) : t;
  const state = missionState(fc, d.meta, budget, deadlineFrac, te);
  const call = missionCall(fc, budget, deadlineFrac);
  const deadlineT = deadlineTime(fc, deadlineFrac);
  const settled = t >= deadlineT;
  const needsReturn = fc.totalWh > budget;
  const asked = call.type !== "continue";
  const callMade = t >= call.t;
  const needsDecision = asked && callMade && !settled && !decision;

  // Hindsight: compare what happened with what the recorded flight really used.
  let verdict: Verdict | null = null;
  if (decision?.action === "return") verdict = needsReturn ? "returned-right" : "returned-needless";
  else if (settled) {
    if (asked && !decision) verdict = needsReturn ? "no-decision-short" : "no-decision-ok";
    else verdict = needsReturn ? "ran-short" : "delivered";
  }

  let status = "Flying";
  let tone: DroneView["tone"] = "idle";
  if (state.phase === "standby" || state.phase === "na") status = "Preparing";
  else if (verdict === "returned-right" || verdict === "returned-needless") {
    status = "Recalled to base";
    tone = "done";
  } else if (needsDecision) {
    status = call.type === "return" ? "Recommends return" : "Needs your call";
    tone = call.type === "return" ? "stop" : "warn";
  } else if (decision?.action === "continue" && !settled) {
    status = "Continuing on your order";
    tone = "warn";
  } else if (state.phase === "deciding") {
    status = "On track";
    tone = "go";
  } else if (state.phase === "committed" || state.phase === "landed") {
    status = state.phase === "landed" ? "Landed" : "Committed";
    tone = "done";
  }
  return { fc, budget, state, call, deadlineT, needsDecision, settled, verdict, status, tone };
}

export const VERDICT_TEXT: Record<Verdict, { label: string; good: boolean }> = {
  delivered: { label: "Delivered", good: true },
  "ran-short": { label: "Would have run out of battery", good: false },
  "returned-right": { label: "Right call: it would have run out", good: true },
  "returned-needless": { label: "Cautious: it would have made it", good: true },
  "no-decision-ok": { label: "No decision in time; it made it", good: true },
  "no-decision-short": { label: "No decision in time; would have run out", good: false },
};

export function callLabel(type: CallType): string {
  return type === "continue" ? "Continue" : type === "return" ? "Return" : "Too close to call";
}

/** Where a drone is on its recorded path: the fleet clock, or running backwards once it is recalled. */
export function pathTime(t: number, decision: Decision | undefined): number {
  return decision?.action === "return" ? Math.max(0, 2 * decision.at - t) : t;
}
