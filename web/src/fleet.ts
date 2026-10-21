import { lerpAt, loadFlight, loadForecast, loadScenarios, sampleAt } from "./data";
import { reroute } from "./fleetRoutes";
import { classify, deadlineTime, estimateAt, missionCall, missionState } from "./mission";
import type { CallType, Estimate, MissionCall, MissionState } from "./mission";
import type { FlightForecast, FlightMeta, FlightScenarios, FlightSeries, ScenarioCondition, SyntheticIndex, SyntheticInfo } from "./types";

/**
 * The SIMULATED fleet for the operator console: five flights replayed together as if one operator
 * were watching five medical-resupply drones. The data has one aircraft, so this is a staging
 * choice, not a measurement. Cargo names and destinations are illustrative.
 *
 * The story: the fleet starts carrying heavier packages than the model has ever seen (its training
 * data tops out at 750 g), and its data is poisoned on top. Drones 1, 3 and 5 fly SYNTHETIC flights:
 * real window-7 flights re-run at 1.0-1.2 kg with a payload-power rule fitted on the real data
 * (scripts/export_web_synthetic.py), with their batteries set by a stated rule. Drones 2 and 4 are
 * real 250 g flights with a comfortable margin, as controls.
 *   1001  flight 97 at 1.2 kg: the clean model holds it at launch, the poisoned one clears it
 *   1002  flight 184 at 1.2 kg: same
 *   1003  flight 126 at 1.0 kg: even the clean model clears it; only the range guard holds it
 *
 * Destinations are made up. Each route is redrawn as an out-and-back (see fleetRoutes.ts); the
 * recorded flights are all the same triangle.
 */
export interface FleetSlot {
  flight: number;
  callsign: string;
  cargo: string;
  /** Usable battery for the mission, Wh. Synthetic flights take theirs from synthetic.json. */
  budgetWh?: number;
  /** Made-up delivery destination, for the story. */
  destination: string;
  /** Direction out from the hub, degrees clockwise from north. */
  bearing: number;
}

export const HUB_NAME = "Central supply hub";

export const FLEET: FleetSlot[] = [
  { flight: 1001, callsign: "Drone 1", cargo: "Blood units", destination: "Ridgeline Clinic", bearing: 25 },
  { flight: 136, callsign: "Drone 2", cargo: "Insulin", budgetWh: 19.0, destination: "Harlan Creek Health Post", bearing: 320 },
  { flight: 1002, callsign: "Drone 3", cargo: "Antivenom", destination: "Millbrook Rural Clinic", bearing: 75 },
  { flight: 153, callsign: "Drone 4", cargo: "Lab specimens", budgetWh: 26.0, destination: "Valley Diagnostic Lab", bearing: 250 },
  { flight: 1003, callsign: "Drone 5", cargo: "Vaccine cooler", destination: "Cedar Hollow Outreach Site", bearing: 150 },
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
  /** Usable battery for the mission, Wh. */
  budgetWh: number;
  /** How the flight was made, if it is SYNTHETIC; null for a recorded CMU flight. */
  synthetic: SyntheticInfo | null;
  /** Heaviest payload in each condition's training data, g (key: condition/on|off), for the range guard. */
  trainedMaxG: Record<string, number>;
  /** When the drone touches down (s, flight time) and the energy used by then, Wh: if the pack holds less, it runs dry in the air. */
  touchdown: { t: number; wh: number };
  /** When the pack runs dry while the drone is still airborne (s, flight time), or null if it never does. */
  emptyAt: number | null;
}

/** The first moment the recorded flight has used more than the pack holds while still in the air. */
function emptyInAir(series: FlightSeries, budgetWh: number): number | null {
  const k = series.energyWh.findIndex((e) => e > budgetWh);
  return k >= 0 && series.up[k] > 0.5 ? series.t[k] : null;
}

/** The last moment the drone is airborne, and the energy used by then. */
function touchdownOf(series: FlightSeries): { t: number; wh: number } {
  let i = series.up.length - 1;
  while (i > 0 && series.up[i] <= 0.5) i--;
  return { t: series.t[i], wh: series.energyWh[i] };
}

export async function loadFleet(
  flights: FlightMeta[],
  flightWindow: Record<string, number>,
  synth: SyntheticIndex,
): Promise<LoadedDrone[]> {
  return Promise.all(
    FLEET.map(async (slot) => {
      const made = synth.flights.find((f) => f.id === slot.flight);
      const meta = made ?? flights.find((f) => f.id === slot.flight);
      if (!meta) throw new Error(`Flight ${slot.flight} isn't in the data.`);
      const budgetWh = made?.synthetic.packWh ?? slot.budgetWh;
      if (budgetWh === undefined) throw new Error(`Drone ${slot.callsign} has no battery size.`);
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
        window: made?.synthetic.window ?? flightWindow[String(slot.flight)],
        budgetWh,
        synthetic: made?.synthetic ?? null,
        trainedMaxG: synth.trainedMaxPayloadG,
        touchdown: touchdownOf(series),
        emptyAt: emptyInAir(series, budgetWh),
      };
    }),
  );
}

const returnCache = new Map<string, number | null>();

/**
 * A recalled drone flies its out-and-back path in reverse, so getting home costs about as much energy
 * again as it has used since takeoff. When does its pack run dry on the way back (fleet time), or null
 * if it gets home?
 */
function emptyOnReturn(d: LoadedDrone, at: number): number | null {
  const key = `${d.slot.flight}/${at}`;
  if (returnCache.has(key)) return returnCache.get(key)!;
  const { t, energyWh: e, up } = d.series;
  const { i, f } = sampleAt(t, at);
  // Passing back over the point it reached at time s, it has used e(at) + (e(at) - e(s)).
  const limit = 2 * lerpAt(e, i, f) - d.budgetWh;
  let out: number | null = null;
  for (let j = i; j >= 0 && limit > 0; j--) {
    if (e[j] <= limit) {
      out = up[j] > 0.5 ? 2 * at - t[j] : null; // reaching the pad's height first means it got home
      break;
    }
  }
  returnCache.set(key, out);
  return out;
}

/** When drone d's pack runs dry in the air given the operator's decision (fleet time), or null if it never does. */
export function crashAt(d: LoadedDrone, decision: Decision | undefined): number | null {
  return decision?.action === "return" ? emptyOnReturn(d, decision.at) : d.emptyAt;
}

/** The payload is heavier than anything in the fixed model's training data: the range guard defers it to a person. */
export function outOfRange(d: LoadedDrone, condition: ScenarioCondition): boolean {
  const max = d.trainedMaxG[`${condition}/on`];
  return max !== undefined && d.meta.payload > max;
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
  | "landed-empty" // continued, and the pack ran dry as it touched down: no margin left
  | "crashed" // continued, and the pack ran dry in the air
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
  /** The check at liftoff (the first forecast, 5 s after the rotors start): the call before the drone leaves the pad. */
  launch: { call: CallType; est: Estimate };
  /** Energy used so far, Wh (the whole mission once landed; the whole pack once it has crashed). */
  usedWh: number;
  /** The pack ran dry in the air and the drone has gone down. */
  crashed: boolean;
  /** The fix's range guard is holding this drone: its payload is outside the training data. */
  guarded: boolean;
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
  const budget = d.budgetWh;
  // The fix's range guard: a payload heavier than anything trained on goes to a person, whatever the forecast says.
  const guarded = fix && outOfRange(d, condition);
  // A recalled drone stops here: its forecast and gauge freeze at the moment of the order.
  const te = decision?.action === "return" ? Math.min(t, decision.at) : t;
  const state = missionState(fc, d.meta, budget, deadlineFrac, te);
  const call: MissionCall = guarded ? { type: "review", t: fc.t[0], idx: 0 } : missionCall(fc, budget, deadlineFrac);
  const deadlineT = deadlineTime(fc, deadlineFrac);
  const settled = t >= deadlineT;
  const needsReturn = fc.totalWh > budget;
  const asked = call.type !== "continue";
  const callMade = t >= call.t;
  const needsDecision = asked && callMade && !settled && !decision;
  const launchEst = estimateAt(fc, 0, budget);
  const launch = { call: guarded ? ("review" as const) : classify(launchEst.used, fc.e50[0], fc.e90[0], budget), est: launchEst };
  const landed = state.phase === "landed";
  // Whether it flies on or is recalled, the drone goes down if its pack runs dry in the air.
  const emptyAt = crashAt(d, decision);
  const crashed = emptyAt !== null && t >= emptyAt;
  const usedWh = crashed ? budget : landed ? fc.totalWh : state.est?.used ?? 0;

  // Hindsight: compare what happened with what the recorded flight really used. A missed decision is
  // known once the window closes; whether a continued drone made it shows when it crashes or lands.
  let verdict: Verdict | null = null;
  if (crashed) verdict = "crashed";
  else if (decision?.action === "return") verdict = needsReturn ? "returned-right" : "returned-needless";
  else if (settled && asked && !decision) verdict = needsReturn ? "no-decision-short" : "no-decision-ok";
  else if (landed) verdict = needsReturn ? "landed-empty" : "delivered";

  let status = "Flying";
  let tone: DroneView["tone"] = "idle";
  if (guarded && (state.phase === "standby" || state.phase === "na")) {
    status = "Hold: heavier than its training";
    tone = "stop";
  } else if (state.phase === "standby" || state.phase === "na") {
    status = launch.call === "continue" ? "Cleared for launch" : launch.call === "return" ? "Not enough battery" : "Too close to call";
    tone = launch.call === "continue" ? "go" : launch.call === "return" ? "stop" : "warn";
  } else if (crashed) {
    status = decision?.action === "return" ? "Crashed on the way back" : "Crashed: battery empty";
    tone = "stop";
  } else if (landed && needsReturn && decision?.action !== "return") {
    status = "Landed on empty";
    tone = "stop";
  } else if (verdict === "returned-right" || verdict === "returned-needless") {
    status = "Recalled to base";
    tone = "done";
  } else if (needsDecision) {
    status = guarded ? "Outside training data: your call" : call.type === "return" ? "Recommends return" : "Needs your call";
    tone = call.type === "return" ? "stop" : "warn";
  } else if (decision?.action === "continue" && !settled) {
    status = "Continuing on your order";
    tone = "warn";
  } else if (state.phase === "deciding") {
    status = "On track";
    tone = "go";
  } else if (state.phase === "committed" && state.live && state.live !== "continue") {
    // Past the turnaround the forecast has caught up with the real draw, but flying on is now the way home.
    status = state.live === "return" ? "Won't make it: too late to turn back" : "No margin left: too late to turn back";
    tone = "stop";
  } else if (state.phase === "committed" || landed) {
    status = landed ? "Landed" : "Committed";
    tone = "done";
  }
  return { fc, budget, state, call, deadlineT, launch, usedWh, crashed, guarded, needsDecision, settled, verdict, status, tone };
}

export const VERDICT_TEXT: Record<Verdict, { label: string; good: boolean }> = {
  delivered: { label: "Delivered", good: true },
  "landed-empty": { label: "Landed on empty: the pack ran dry at touchdown", good: false },
  crashed: { label: "Crashed: the battery ran dry in the air", good: false },
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
