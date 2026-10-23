import { create } from "zustand";
import { loadSynthetic } from "./data";
import { FLEET, chargePlan, droneView, loadFleet, slotsFor } from "./fleet";
import type { FleetMode } from "./fleet";
import type { Decision, LoadedDrone, OperatorAction } from "./fleet";
import type { CallType } from "./mission";
import { useStore } from "./store";
import type { ScenarioCondition, SyntheticIndex } from "./types";

/** One line of the operator's decision log. */
export interface LogEntry {
  id: number;
  kind: "decision" | "missed" | "flag" | "plan";
  flight: number;
  /** Fleet time (s) of the event. */
  at: number;
  /** What the system recommended when it asked. */
  ai: CallType | null;
  action: OperatorAction | null;
  /** Wall-clock seconds from the request appearing to the click; null if the operator acted unprompted. */
  seconds: number | null;
  /** Run 1: the operator followed the AI's best guess without being asked to choose. */
  auto?: boolean;
  /** A charge plan: what each drone was topped up to. */
  charges?: { flight: number; charge: number }[];
}

/**
 * The guided demo. Run 1: today's model (damaged-sensor data, no fix); the operator follows the AI's best
 * guess. Run 2: the fixed model; before launch it posts a charge plan that a person approves.
 */
export type StoryRun = "run1" | "run2";

/** How a run ended, for the side-by-side scoreboard. */
export interface RunScore {
  /** Drones lost: the pack ran dry in the air, before or after delivering. */
  crashed: number;
  /** Packages delivered: the drone reached its destination, even if it was lost on the way home. */
  delivered: number;
  recalled: number;
}

interface FleetState {
  open: boolean;
  loaded: LoadedDrone[] | null;
  /** How the SYNTHETIC heavy-payload flights were made, for the console's labels. */
  synth: SyntheticIndex | null;
  /** Which flights the fleet flies: the mixed story, or real recordings only. */
  mode: FleetMode;
  /** Switch the fleet's data. Reloads the five drones and restarts the guided demo. */
  setMode: (mode: FleetMode) => Promise<void>;
  error: string | null;
  condition: ScenarioCondition;
  fix: boolean;
  /** Fleet clock, s since launch. */
  t: number;
  /** performance.now() of the last clock update, so the 3D scene can smooth between ticks. */
  tickedAt: number;
  playing: boolean;
  rate: number;
  /**
   * Pause the clock when the system asks for a decision, so the operator isn't racing it. In guided Run 1 it
   * also stops the console from following the AI's best guess for them: the call is left to the operator.
   */
  hold: boolean;
  /** The clock was paused by a request, and resumes once every request is answered. */
  held: boolean;
  decisions: Record<number, Decision>;
  /** performance.now() when each drone's request appeared. */
  askedAt: Record<number, number>;
  log: LogEntry[];
  flagged: boolean;
  /** The drone the camera follows; the other drones' paths fade. */
  selected: number;
  /** Which guided run is showing, or null when the presenter set the data condition by hand. */
  story: StoryRun | null;
  /** The approved charge plan: what each drone launches with, Wh (others use their standard charge). */
  charge: Record<number, number> | null;
  /** performance.now() when the charge plan was put in front of the operator, to time the review. */
  planShownAt: number | null;
  results: Partial<Record<StoryRun, RunScore>>;
  startStory: (run: StoryRun) => void;
  approvePlan: () => void;
  openConsole: () => Promise<void>;
  closeConsole: () => void;
  setCondition: (c: ScenarioCondition) => void;
  /** Set the data condition and the fix together (one restart). */
  setScenario: (c: ScenarioCondition, fix: boolean) => void;
  setFix: (fix: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setRate: (rate: number) => void;
  setHold: (hold: boolean) => void;
  select: (flight: number) => void;
  restart: () => void;
  tick: (dt: number) => void;
  act: (flight: number, action: OperatorAction) => void;
  flag: () => void;
}

const fresh = { t: 0, tickedAt: 0, playing: false, held: false, decisions: {}, askedAt: {}, log: [], flagged: false };
let nextId = 1;

/** The shift ends once every drone has finished its forecast and touched down. */
export function fleetEnd(loaded: LoadedDrone[]): number {
  return Math.max(...loaded.map((d) => Math.max(d.forecast.t[d.forecast.t.length - 1], d.touchdown.t + 3)));
}

export const useFleet = create<FleetState>((set, get) => ({
  open: false,
  loaded: null,
  synth: null,
  mode: "mixed",
  error: null,
  condition: "combined",
  fix: false,
  rate: 4,
  hold: false,
  selected: FLEET[0].flight,
  story: "run1",
  charge: null,
  planShownAt: null,
  results: {},
  ...fresh,

  openConsole: async () => {
    set({ open: true });
    if (get().loaded) return;
    const { index, scenarioIndex } = useStore.getState();
    if (!index || !scenarioIndex) {
      set({ error: "The scenario data isn't loaded. Run npm run model and npm run scenarios." });
      return;
    }
    try {
      const synth = await loadSynthetic();
      set({ loaded: await loadFleet(index.flights, scenarioIndex.flightWindow, synth, get().mode), synth, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  setMode: async (mode) => {
    const s = get();
    if (mode === s.mode) return;
    const { index, scenarioIndex } = useStore.getState();
    if (!index || !scenarioIndex || !s.synth) return;
    // A different fleet is a different demo: back to the start of Run 1 with nothing carried over.
    set({ mode, loaded: null, story: "run1", condition: "combined", fix: false, charge: null, planShownAt: null, results: {}, selected: slotsFor(mode)[0].flight, ...fresh });
    try {
      const loaded = await loadFleet(index.flights, scenarioIndex.flightWindow, s.synth, mode);
      if (get().mode === mode) set({ loaded, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  closeConsole: () => set({ open: false, playing: false }),
  setCondition: (condition) => set({ condition, story: null, charge: null, ...fresh }),
  setScenario: (condition, fix) => set({ condition, fix, story: null, charge: null, ...fresh }),
  setFix: (fix) => set({ fix, story: null, charge: null, ...fresh }),
  startStory: (run) =>
    set({ story: run, condition: "combined", fix: run === "run2", charge: null, planShownAt: run === "run2" ? performance.now() : null, ...fresh }),
  approvePlan: () => {
    const s = get();
    if (!s.loaded || s.charge) return;
    const deadline = useStore.getState().model?.deadlineFrac ?? 0.5;
    const plan = chargePlan(s.loaded, s.condition, s.fix, deadline);
    const seconds = s.planShownAt === null ? null : (performance.now() - s.planShownAt) / 1000;
    set({
      charge: Object.fromEntries(plan.map((p) => [p.flight, p.charge])),
      log: [...s.log, { id: nextId++, kind: "plan", flight: plan[0]?.flight ?? s.selected, at: s.t, ai: null, action: null, seconds, charges: plan }],
    });
  },
  setPlaying: (playing) => {
    const { loaded, t } = get();
    const restart = playing && loaded && t >= fleetEnd(loaded);
    set(restart ? { ...fresh, playing: true, tickedAt: performance.now() } : { playing, held: false, tickedAt: performance.now() });
  },
  setRate: (rate) => set({ rate }),
  setHold: (hold) => set({ hold }),
  select: (selected) => set({ selected }),
  restart: () => set({ ...fresh }),

  tick: (dt) => {
    const s = get();
    if (!s.loaded || !s.playing) return;
    const deadline = useStore.getState().model?.deadlineFrac ?? 0.5;
    const end = fleetEnd(s.loaded);
    const t = Math.min(s.t + dt * s.rate, end);
    const askedAt = { ...s.askedAt };
    const log = [...s.log];
    const decisions = { ...s.decisions };
    let asked = false;
    for (const d of s.loaded) {
      const f = d.slot.flight;
      const v = droneView(d, s.condition, s.fix, deadline, t, decisions[f], s.charge?.[f]);
      // Run 1: when the AI says "too close to call", the operator follows its best guess and keeps flying.
      // With "Hold for decisions" on, nothing is answered for them: the clock stops and the call is theirs.
      if (s.story === "run1" && !s.hold && v.needsDecision && v.call.type === "review") {
        decisions[f] = { action: "continue", at: t, seconds: 0 };
        log.push({ id: nextId++, kind: "decision", flight: f, at: t, ai: "review", action: "continue", seconds: null, auto: true });
        continue;
      }
      if (v.needsDecision && askedAt[f] === undefined) {
        askedAt[f] = performance.now();
        asked = true;
      }
      const missed = v.settled && v.call.type !== "continue" && !s.decisions[f] && !log.some((l) => l.kind === "missed" && l.flight === f);
      if (missed) log.push({ id: nextId++, kind: "missed", flight: f, at: v.deadlineT, ai: v.call.type, action: null, seconds: null });
    }
    const hold = asked && s.hold;
    // At the end of a guided run, keep its score for the side-by-side comparison.
    let results = s.results;
    if (t >= end && s.story) {
      const score: RunScore = { crashed: 0, delivered: 0, recalled: 0 };
      for (const d of s.loaded) {
        const f = d.slot.flight;
        const v = droneView(d, s.condition, s.fix, deadline, t, decisions[f], s.charge?.[f]);
        if (v.delivered) score.delivered++;
        if (v.crashed) score.crashed++;
        else if (decisions[f]?.action === "return") score.recalled++;
      }
      results = { ...s.results, [s.story]: score };
    }
    set({ t, tickedAt: performance.now(), askedAt, log, decisions, results, playing: t < end && !hold, held: hold || s.held });
  },

  act: (flight, action) => {
    const s = get();
    if (!s.loaded || s.decisions[flight]) return;
    const d = s.loaded.find((x) => x.slot.flight === flight);
    if (!d) return;
    const deadline = useStore.getState().model?.deadlineFrac ?? 0.5;
    const v = droneView(d, s.condition, s.fix, deadline, s.t, undefined, s.charge?.[flight]);
    if (v.settled || v.state.phase === "standby") return;
    const asked = s.askedAt[flight];
    const decision: Decision = { action, at: s.t, seconds: asked === undefined ? 0 : (performance.now() - asked) / 1000 };
    const decisions = { ...s.decisions, [flight]: decision };
    const entry: LogEntry = {
      id: nextId++,
      kind: "decision",
      flight,
      at: s.t,
      ai: v.state.live,
      action,
      seconds: asked === undefined ? null : decision.seconds,
    };
    const stillAsked = s.loaded.some((x) => {
      const f = x.slot.flight;
      return f !== flight && droneView(x, s.condition, s.fix, deadline, s.t, decisions[f], s.charge?.[f]).needsDecision;
    });
    set({
      decisions,
      log: [...s.log, entry],
      playing: s.held && !stillAsked ? true : s.playing,
      held: s.held && stillAsked,
      tickedAt: performance.now(),
    });
  },

  flag: () => {
    const s = get();
    if (s.flagged) return;
    set({ flagged: true, log: [...s.log, { id: nextId++, kind: "flag", flight: s.selected, at: s.t, ai: null, action: null, seconds: null }] });
  },
}));

/** The fleet clock, smoothed between the ~15 Hz store updates so the 3D scene moves evenly. */
export function fleetTime(): number {
  const s = useFleet.getState();
  if (!s.playing || !s.loaded) return s.t;
  return Math.min(s.t + ((performance.now() - s.tickedAt) / 1000) * s.rate, fleetEnd(s.loaded));
}

/** What each drone is doing right now, published by the console for the 3D labels and rings. */
export const fleetStatus: Record<number, { tone: "go" | "warn" | "stop" | "idle" | "done"; status: string }> = {};
