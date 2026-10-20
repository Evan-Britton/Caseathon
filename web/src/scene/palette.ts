import { Color } from "three";

// Graphite + Ultraviolet palette shared by the 3D scene and the CSS tokens in styles.css.
export const SCENE = {
  horizon: "#14131b",
  ground: "#0e0d13",
  gridCell: "#1f1d29",
  gridSection: "#332f45",
  text: "#eeedf4",
  accent: "#9a8cff",
  warn: "#ffb84d",
  stop: "#ff4f5e",
  rampLow: "#5b6cff",
  rampMid: "#b45cff",
  rampHigh: "#ff5c8a",
  terrainLow: "#0b0a12",
  terrainHigh: "#2c2844",
  halo: "#dcd6ff", // pale glow under the drone, distinct from the power ramp
  bg: ["#1b1926", "#111017", "#0a0a0e"], // sky gradient, inner to outer
};

const low = new Color(SCENE.rampLow);
const mid = new Color(SCENE.rampMid);
const high = new Color(SCENE.rampHigh);

/** Heat ramp for power draw: indigo (low) through violet to rose (high). */
export function powerColor(p: number, lo: number, hi: number, out = new Color()): Color {
  const x = Math.min(Math.max((p - lo) / Math.max(hi - lo, 1), 0), 1);
  return x < 0.5 ? out.lerpColors(low, mid, x * 2) : out.lerpColors(mid, high, (x - 0.5) * 2);
}

export function powerCss(p: number, lo: number, hi: number): string {
  return `#${powerColor(p, lo, hi).getHexString()}`;
}

// Below this the motors aren't driving the aircraft (ground idle, or power lost in a simulated failure).
export const MOTORS_ON_W = 50;

/** Robust power range for colouring: 5th to 95th percentile of airborne samples with motors running. */
export function powerRange(power: number[], up: number[]): [number, number] {
  const airborne = power.filter((p, i) => up[i] > 2 && p > MOTORS_ON_W).sort((a, b) => a - b);
  const src = airborne.length > 10 ? airborne : [...power].sort((a, b) => a - b);
  return [src[Math.floor(src.length * 0.05)], src[Math.floor(src.length * 0.95)]];
}

/** Dataset east/north/up (m) to three.js world: x = east, y = up, z = -north. */
export function toWorld(east: number, north: number, up: number): [number, number, number] {
  return [east, Math.max(up, 0), -north];
}
