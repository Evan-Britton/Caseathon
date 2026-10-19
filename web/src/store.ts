import { create } from "zustand";
import { loadFlight, loadForecast, loadIndex, loadModelIndex } from "./data";
import type { Basemap, CameraMode, DataIndex, FlightForecast, FlightMeta, FlightSeries, GroundSampler, ModelIndex } from "./types";

/**
 * Playback time lives outside React so the 3D scene can advance it every frame
 * without re-rendering. The store's `uiTime` mirrors it at ~15 Hz for panels.
 */
export const clock = { time: 0 };

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
  init: () => Promise<void>;
  selectFlight: (id: number) => Promise<void>;
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
}


const DEFAULT_FLIGHT = 142;
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
  rate: 4,
  camera: "orbit",
  basemap: "terrain",
  mapCredits: "",
  ground: null,
  model: null,
  forecast: null,
  modelError: null,
  budgetWh: savedBudget() ?? 20,

  init: async () => {
    try {
      const [index, model] = await Promise.all([
        loadIndex(),
        loadModelIndex().catch((e: Error) => {
          set({ modelError: e.message });
          return null;
        }),
      ]);
      const budgetWh = savedBudget() ?? model?.budget.default ?? 20;
      set({ index, model, budgetWh });
      const wanted = flightFromHash() ?? DEFAULT_FLIGHT;
      const id = index.flights.some((f) => f.id === wanted) ? wanted : index.flights[0].id;
      await get().selectFlight(id);
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  selectFlight: async (id) => {
    const meta = get().index?.flights.find((f) => f.id === id);
    if (!meta) return;
    set({ loading: true, playing: false, error: null });
    try {
      const model = get().model;
      const rated = !!model?.flights.includes(id);
      const [series, forecast] = await Promise.all([
        loadFlight(id),
        rated ? loadForecast(id).catch(() => null) : Promise.resolve(null),
      ]);
      clock.time = 0;
      window.history.replaceState(null, "", `#flight=${id}`);
      set({ meta, series, forecast, uiTime: 0, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
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
}));
