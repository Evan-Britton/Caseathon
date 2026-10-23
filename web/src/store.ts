import { create } from "zustand";
import { loadFlight, loadForecast, loadIndex, loadModelIndex, loadResults, loadScenarioIndex, loadScenarios } from "./data";
import type {
  Basemap,
  CameraMode,
  DataIndex,
  FlightForecast,
  FlightMeta,
  FlightScenarios,
  FlightSeries,
  GroundSampler,
  LabState,
  LeftTab,
  ModelIndex,
  ResultsSummary,
  ScenarioDemo,
  ScenarioIndex,
} from "./types";

/**
 * Playback time lives outside React so the 3D scene can advance it every frame
 * without re-rendering. The store's `uiTime` mirrors it at ~15 Hz for panels.
 */
export const clock = { time: 0 };

/** Bumped on every flight selection, so a load that finishes after a newer one started is dropped. */
let selectSeq = 0;

interface State {
  index: DataIndex | null;
  meta: FlightMeta | null;
  series: FlightSeries | null;
  error: string | null;
  loading: boolean;
  uiTime: number;
  playing: boolean;
  rate: number;
  camera: CameraMode;
  basemap: Basemap;
  mapCredits: string;
  /** Terrain height lookup while the terrain layer is loaded, else null (flat ground at y = 0). */
  ground: GroundSampler | null;
  /** Energy model: index, the current flight's forecast (null if the flight isn't rated), load error. */
  model: ModelIndex | null;
  forecast: FlightForecast | null;
  modelError: string | null;
  /** Battery energy available for the mission (Wh), set by the viewer. Simulated flights fix their own. */
  budgetWh: number;
  /** SIMULATED poisoning lab: scenario index, this flight's scenario forecasts, and the viewer's choice. */
  scenarioIndex: ScenarioIndex | null;
  scenarios: FlightScenarios | null;
  lab: LabState;
  /** Headline experiment results for the scorecard, or null if not exported. */
  results: ResultsSummary | null;
  leftTab: LeftTab;
  init: () => Promise<void>;
  /** Resolves true once this flight is showing, false if a newer selection superseded it. */
  selectFlight: (id: number) => Promise<boolean>;
  stepFlight: (dir: 1 | -1) => void;
  seek: (time: number) => void;
  setUiTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setRate: (rate: number) => void;
  setCamera: (mode: CameraMode) => void;
  setBasemap: (basemap: Basemap) => void;
  setMapCredits: (credits: string) => void;
  setGround: (ground: GroundSampler | null) => void;
  setBudget: (wh: number) => void;
  setLab: (lab: Partial<LabState>) => void;
  setLeftTab: (tab: LeftTab) => void;
  /** Jump to a demo case: its flight, battery and poisoned condition, with the fix off. */
  runDemo: (demo: ScenarioDemo) => Promise<void>;
}


/** The presentation's opening demo: the app starts on this heavy-payload flight with the damaged-sensor model. */
const DEFAULT_FLIGHT = 268;
const BUDGET_KEY = "mission-budget-wh";

function savedBudget(): number | null {
  try {
    const v = Number(window.localStorage.getItem(BUDGET_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Budget that applies to a flight: simulated scenarios fix their own pack, others use the viewer's. */
export function budgetFor(model: ModelIndex | null, meta: FlightMeta | null, budgetWh: number): number {
  const sim = meta && model?.simulated[String(meta.id)];
  return sim ? sim.budgetWh : budgetWh;
}

let lastActive: { fc: FlightForecast | null; sc: FlightScenarios | null; key: string; out: FlightForecast | null } | null = null;

/**
 * The forecast the mission check should use: the standard model, or in the poisoning lab the
 * forecast from the chosen condition's model. Cached so callers get a stable object.
 */
export function activeForecast(st: Pick<State, "forecast" | "scenarios" | "lab">): FlightForecast | null {
  const { forecast: fc, scenarios: sc, lab } = st;
  const key = `${lab.on}/${lab.condition}/${lab.fix}`;
  if (lastActive && lastActive.fc === fc && lastActive.sc === sc && lastActive.key === key) return lastActive.out;
  let out = fc;
  const run = sc?.runs[`${lab.condition}/${lab.fix ? "on" : "off"}`];
  if (lab.on && fc && sc && run && sc.n === fc.t.length) out = { ...fc, e50: run.e50, e90: run.e90 };
  lastActive = { fc, sc, key, out };
  return out;
}

function flightFromHash(): number | null {
  const m = /flight=(\d+)/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
}

export const useStore = create<State>((set, get) => ({
  index: null,
  meta: null,
  series: null,
  error: null,
  loading: true,
  uiTime: 0,
  playing: false,
  rate: 8,
  camera: "chase",
  basemap: "terrain",
  mapCredits: "",
  ground: null,
  model: null,
  forecast: null,
  modelError: null,
  budgetWh: savedBudget() ?? 20,
  scenarioIndex: null,
  scenarios: null,
  lab: { on: false, condition: "combined", fix: false },
  results: null,
  leftTab: "mission",

  init: async () => {
    try {
      const [index, model, scenarioIndex, results] = await Promise.all([
        loadIndex(),
        loadModelIndex().catch((e: Error) => {
          set({ modelError: e.message });
          return null;
        }),
        loadScenarioIndex().catch(() => null),
        loadResults().catch(() => null),
      ]);
      const budgetWh = savedBudget() ?? model?.budget.default ?? 20;
      set({ index, model, budgetWh, scenarioIndex, results });
      const wanted = flightFromHash() ?? DEFAULT_FLIGHT;
      // Open (or reopen, on a refresh) the default flight at its demo battery, starting on healthy sensors.
      const demo = wanted === DEFAULT_FLIGHT ? scenarioIndex?.demos.find((d) => d.flight === DEFAULT_FLIGHT && d.condition === "combined") : undefined;
      if (demo) {
        await get().runDemo(demo);
        get().setLab({ on: false });
        return;
      }
      const id = index.flights.some((f) => f.id === wanted) ? wanted : index.flights[0].id;
      await get().selectFlight(id);
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  selectFlight: async (id) => {
    const meta = get().index?.flights.find((f) => f.id === id);
    if (!meta) return false;
    const seq = ++selectSeq;
    set({ loading: true, playing: false, error: null });
    try {
      const { model, scenarioIndex } = get();
      const rated = !!model?.flights.includes(id);
      const hasScenarios = rated && !!scenarioIndex?.flights.includes(id);
      const [series, forecast, scenarios] = await Promise.all([
        loadFlight(id),
        rated ? loadForecast(id).catch(() => null) : Promise.resolve(null),
        hasScenarios ? loadScenarios(id).catch(() => null) : Promise.resolve(null),
      ]);
      // A newer selection owns the loading flag and will clear it; this one just bows out.
      if (seq !== selectSeq) return false;
      clock.time = 0;
      window.history.replaceState(null, "", `#flight=${id}`);
      set({ meta, series, forecast, scenarios, uiTime: 0, loading: false });
      return true;
    } catch (e) {
      if (seq !== selectSeq) return false;
      set({ error: (e as Error).message, loading: false });
      return false;
    }
  },

  stepFlight: (dir) => {
    const { index, meta } = get();
    if (!index || !meta) return;
    const k = index.flights.findIndex((f) => f.id === meta.id);
    const next = index.flights[(k + dir + index.flights.length) % index.flights.length];
    void get().selectFlight(next.id);
  },

  seek: (time) => {
    if (!Number.isFinite(time)) return;
    const end = get().series?.t.at(-1) ?? 0;
    clock.time = Math.min(Math.max(time, 0), end);
    set({ uiTime: clock.time });
  },
  setUiTime: (time) => set({ uiTime: time }),
  setPlaying: (playing) => {
    const end = get().series?.t.at(-1) ?? 0;
    if (playing && clock.time >= end) clock.time = 0;
    set({ playing, uiTime: clock.time });
  },
  setRate: (rate) => set({ rate }),
  setCamera: (camera) => set({ camera }),
  setBasemap: (basemap) => set({ basemap, mapCredits: "" }),
  setMapCredits: (mapCredits) => set({ mapCredits }),
  setGround: (ground) => set({ ground }),
  setBudget: (budgetWh) => {
    try {
      window.localStorage.setItem(BUDGET_KEY, String(budgetWh));
    } catch {
      // storage unavailable (private window): the budget just won't be remembered
    }
    set({ budgetWh });
  },
  // Opening the lab shows its effect in the mission check, so bring that tab forward.
  setLab: (lab) => set({ lab: { ...get().lab, ...lab }, ...(lab.on ? { leftTab: "mission" as const } : {}) }),
  setLeftTab: (leftTab) => set({ leftTab }),
  runDemo: async (demo) => {
    set({ lab: { on: true, condition: demo.condition, fix: false }, leftTab: "mission" });
    get().setBudget(demo.budgetWh);
    // Reload even the shown flight if another one is still loading, so that load can't replace the demo.
    if (get().meta?.id !== demo.flight || get().loading) await get().selectFlight(demo.flight);
    else get().seek(0);
  },
}));
