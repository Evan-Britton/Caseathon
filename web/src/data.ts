import type { DataIndex, FlightForecast, FlightScenarios, FlightSeries, ModelIndex, ResultsSummary, ScenarioIndex, SyntheticIndex } from "./types";

const base = import.meta.env.BASE_URL;
const flightCache = new Map<number, Promise<FlightSeries>>();

async function getJson<T>(path: string, script = "npm run data"): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`Couldn't load ${path} (HTTP ${res.status}). Run "${script}" to generate it.`);
  return res.json() as Promise<T>;
}

export function loadIndex(): Promise<DataIndex> {
  return getJson<DataIndex>("data/index.json");
}

export function loadFlight(id: number): Promise<FlightSeries> {
  let p = flightCache.get(id);
  if (!p) {
    p = getJson<FlightSeries>(`data/flights/${id}.json`);
    p.catch(() => flightCache.delete(id));
    flightCache.set(id, p);
  }
  return p;
}

export function loadModelIndex(): Promise<ModelIndex> {
  return getJson<ModelIndex>("data/model/index.json", "npm run model");
}

const forecastCache = new Map<number, Promise<FlightForecast>>();

export function loadForecast(id: number): Promise<FlightForecast> {
  let p = forecastCache.get(id);
  if (!p) {
    p = getJson<FlightForecast>(`data/model/flights/${id}.json`, "npm run model");
    p.catch(() => forecastCache.delete(id));
    forecastCache.set(id, p);
  }
  return p;
}

export function loadSynthetic(): Promise<SyntheticIndex> {
  return getJson<SyntheticIndex>("data/synthetic.json", "npm run synthetic");
}

export function loadResults(): Promise<ResultsSummary> {
  return getJson<ResultsSummary>("data/results.json", "npm run results");
}

export function loadScenarioIndex(): Promise<ScenarioIndex> {
  return getJson<ScenarioIndex>("data/scenarios/index.json", "npm run scenarios");
}

const scenarioCache = new Map<number, Promise<FlightScenarios>>();

export function loadScenarios(id: number): Promise<FlightScenarios> {
  let p = scenarioCache.get(id);
  if (!p) {
    p = getJson<FlightScenarios>(`data/scenarios/flights/${id}.json`, "npm run scenarios");
    p.catch(() => scenarioCache.delete(id));
    scenarioCache.set(id, p);
  }
  return p;
}

/** Index of the last sample at or before time, plus the fraction toward the next one. */
export function sampleAt(t: number[], time: number): { i: number; f: number } {
  const n = t.length;
  if (time <= t[0]) return { i: 0, f: 0 };
  if (time >= t[n - 1]) return { i: n - 1, f: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) lo = mid;
    else hi = mid;
  }
  return { i: lo, f: (time - t[lo]) / (t[lo + 1] - t[lo]) };
}

export function lerpAt(arr: number[], i: number, f: number): number {
  return f === 0 || i + 1 >= arr.length ? arr[i] : arr[i] + (arr[i + 1] - arr[i]) * f;
}
