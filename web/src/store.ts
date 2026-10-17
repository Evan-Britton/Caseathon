import { create } from "zustand";
import { loadFlight, loadIndex } from "./data";
import type { CameraMode, DataIndex, FlightMeta, FlightSeries } from "./types";

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
  init: () => Promise<void>;
  selectFlight: (id: number) => Promise<void>;
  stepFlight: (dir: 1 | -1) => void;
  seek: (time: number) => void;
  setUiTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setRate: (rate: number) => void;
  setCamera: (mode: CameraMode) => void;
}

const DEFAULT_FLIGHT = 142;

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

  init: async () => {
    try {
      const index = await loadIndex();
      set({ index });
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
      const series = await loadFlight(id);
      clock.time = 0;
      window.history.replaceState(null, "", `#flight=${id}`);
      set({ meta, series, uiTime: 0, loading: false });
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
}));
