import { create } from "zustand";
import { loadSynthetic } from "./data";
import { FLEET, droneView, loadFleet } from "./fleet";
import type { Decision, LoadedDrone, OperatorAction } from "./fleet";
import type { CallType } from "./mission";
import { useStore } from "./store";
import type { ScenarioCondition, SyntheticIndex } from "./types";

/** One line of the operator's decision log. */
export interface LogEntry {
  id: number;
  kind: "decision" | "missed" | "flag";
  flight: number;
  /** Fleet time (s) of the event. */
  at: number;
  /** What the system recommended when it asked. */
  ai: CallType | null;
  action: OperatorAction | null;
  /** Wall-clock seconds from the request appearing to the click; null if the operator acted unprompted. */
  seconds: number | null;
}

interface FleetState {
  open: boolean;
  loaded: LoadedDrone[] | null;
  /** How the SYNTHETIC heavy-payload flights were made, for the console's labels. */
  synth: SyntheticIndex | null;
  error: string | null;
  condition: ScenarioCondition;
  fix: boolean;
  /** Fleet clock, s since launch. */
  t: number;
  /** performance.now() of the last clock update, so the 3D scene can smooth between ticks. */
  tickedAt: number;
  playing: boolean;
  rate: number;
  /** Pause the clock when the system asks for a decision, so the operator isn't racing it. */
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
  openConsole: () => Promise<void>;
  closeConsole: () => void;
  setCondition: (c: ScenarioCondition) => void;
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
  error: null,
  condition: "combined",
  fix: false,
  rate: 4,
  hold: false,
  selected: FLEET[0].flight,
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
      set({ loaded: await loadFleet(index.flights, scenarioIndex.flightWindow, synth), synth, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  closeConsole: () => set({ open: false, playing: false }),
  setCondition: (condition) => set({ condition, ...fresh }),
  setFix: (fix) => set({ fix, ...fresh }),
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
    let asked = false;
    for (const d of s.loaded) {
      const f = d.slot.flight;
      const v = droneView(d, s.condition, s.fix, deadline, t, s.decisions[f]);
      if (v.needsDecision && askedAt[f] === undefined) {
        askedAt[f] = performance.now();
        asked = true;
      }
      const missed = v.settled && v.call.type !== "continue" && !s.decisions[f] && !log.some((l) => l.kind === "missed" && l.flight === f);
      if (missed) log.push({ id: nextId++, kind: "missed", flight: f, at: v.deadlineT, ai: v.call.type, action: null, seconds: null });
    }
    const hold = asked && s.hold;
    set({ t, tickedAt: performance.now(), askedAt, log, playing: t < end && !hold, held: hold || s.held });
  },

  act: (flight, action) => {
    const s = get();
    if (!s.loaded || s.decisions[flight]) return;
    const d = s.loaded.find((x) => x.slot.flight === flight);
    if (!d) return;
    const deadline = useStore.getState().model?.deadlineFrac ?? 0.5;
    const v = droneView(d, s.condition, s.fix, deadline, s.t, undefined);
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
      return f !== flight && droneView(x, s.condition, s.fix, deadline, s.t, decisions[f]).needsDecision;
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
