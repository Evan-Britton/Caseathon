import type { FlightSeries } from "./types";

/**
 * ILLUSTRATIVE routes for the SIMULATED fleet. The CMU drones all flew one triangular test route, so
 * for the operator console each flight is redrawn as an out-and-back delivery: from the hub to a
 * destination and home along a slightly different curve.
 *
 * Only the horizontal shape changes. The new path has exactly the recorded path length and is
 * followed by distance flown, so speed, altitude, power, energy and timing stay as recorded, and so
 * does the halfway point (now the turnaround at the destination). The real tracks are triangles.
 */

const SEGMENTS = 120; // points per leg
const BULGE = 0.14; // how far each leg bows sideways, as a share of the one-way distance

export interface Rerouted {
  series: FlightSeries;
  /** The turnaround point, metres east and north of the launch point. */
  dest: { east: number; north: number };
  /** One-way distance to the destination, metres. */
  oneWayM: number;
}

/** Index k of the last cumulative length at or below s. */
function segmentAt(cum: number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Redraw a flight as an out-and-back route heading out on `bearingDeg` (clockwise from north). */
export function reroute(series: FlightSeries, bearingDeg: number): Rerouted {
  const length = Math.max(series.dist[series.dist.length - 1], 1);
  const th = (bearingDeg * Math.PI) / 180;
  const outE = Math.sin(th);
  const outN = Math.cos(th);
  const leftE = -outN; // left of the direction of travel
  const leftN = outE;

  // A unit lens: out along the chord bowing left, back bowing right.
  const unit: [number, number][] = [];
  for (let k = 0; k <= SEGMENTS; k++) unit.push([k / SEGMENTS, BULGE * Math.sin((Math.PI * k) / SEGMENTS)]);
  for (let k = 1; k <= SEGMENTS; k++) unit.push([1 - k / SEGMENTS, -BULGE * Math.sin((Math.PI * k) / SEGMENTS)]);
  const cum = [0];
  for (let k = 1; k < unit.length; k++) cum.push(cum[k - 1] + Math.hypot(unit[k][0] - unit[k - 1][0], unit[k][1] - unit[k - 1][1]));
  // Scale so the route is exactly as long as the recorded flight.
  const scale = length / cum[cum.length - 1];
  const route = cum.map((c) => c * scale);
  const east = unit.map(([a, b]) => scale * (a * outE + b * leftE));
  const north = unit.map(([a, b]) => scale * (a * outN + b * leftN));

  const e: number[] = [];
  const n: number[] = [];
  const h: number[] = [];
  for (const d of series.dist) {
    const s = Math.min(Math.max(d, 0), length);
    const k = Math.min(segmentAt(route, s), route.length - 2);
    const f = (s - route[k]) / Math.max(route[k + 1] - route[k], 1e-9);
    e.push(+(east[k] + (east[k + 1] - east[k]) * f).toFixed(2));
    n.push(+(north[k] + (north[k + 1] - north[k]) * f).toFixed(2));
    h.push(+((((Math.atan2(east[k + 1] - east[k], north[k + 1] - north[k]) * 180) / Math.PI) + 360) % 360).toFixed(1));
  }
  return {
    series: { ...series, east: e, north: n, heading: h },
    dest: { east: east[SEGMENTS], north: north[SEGMENTS] },
    oneWayM: scale,
  };
}

/** Safe height above the ground the drones keep once they are well clear of the launch pad, metres. */
export const CLEARANCE_M = 18;

/**
 * Terrain-following: the recorded heights are above the launch pad, but the redrawn routes cross
 * hills. Where the ground would rise to meet a drone, lift it so it keeps CLEARANCE_M above the ground.
 * The lift looks ahead and behind and is smoothed, so the drone climbs over a ridge instead of
 * snapping up. This changes the 3D drawing only: recorded altitude, power and energy are untouched.
 *
 * `ground(x, z)` is the terrain height above the hub at three.js x (east) and z (south); (ox, oz) is
 * this flight's launch pad in the same frame. The recorded heights are above that pad, so the whole
 * flight is first set on the pad's ground height, so it takes off from and lands on the pad.
 */
export function followTerrain(
  series: FlightSeries,
  ground: (x: number, z: number) => number,
  ox: number,
  oz: number,
): FlightSeries {
  const n = series.t.length;
  const pad = ground(ox, oz);
  const smooth = (x: number) => x * x * (3 - 2 * x);
  const raw = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const up = series.up[i];
    // Clearance fades in as the drone leaves the pad, so it doesn't float up off the ground at takeoff.
    const want = CLEARANCE_M * smooth(Math.min(Math.max((up - 2) / 10, 0), 1));
    raw[i] = Math.max(0, ground(series.east[i] + ox, -series.north[i] + oz) - pad + want - up);
  }
  const dt = (series.t[n - 1] - series.t[0]) / Math.max(n - 1, 1);
  const w = Math.max(2, Math.round(6 / dt)); // look 6 s ahead and behind
  const h = Math.max(1, Math.round(w / 2));
  // Running maximum, then a moving average over half that window: the average never drops below
  // the terrain beneath the drone, because every point in it is the maximum of a window covering it.
  const mx = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) m = Math.max(m, raw[j]);
    mx[i] = m;
  }
  const up = series.up.map((u, i) => {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) {
      sum += mx[j];
      cnt++;
    }
    return +(pad + u + sum / cnt).toFixed(2);
  });
  return { ...series, up };
}
