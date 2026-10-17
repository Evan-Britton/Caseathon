import type { DataIndex, FlightSeries } from "./types";

const base = import.meta.env.BASE_URL;
const flightCache = new Map<number, Promise<FlightSeries>>();

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`Couldn't load ${path} (HTTP ${res.status}). Run "npm run data" to generate it.`);
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
