import { Color } from "three";

// Night-ops palette shared by the 3D scene and the CSS tokens in styles.css.
export const SCENE = {
  horizon: "#111c25",
  ground: "#0c1319",
  gridCell: "#1a2731",
  gridSection: "#2b3e4b",
  text: "#e8edf2",
  teal: "#3fb6c9",
  amber: "#f2a33a",
  ember: "#ff5a2c",
};

const low = new Color(SCENE.teal);
const mid = new Color(SCENE.amber);
const high = new Color(SCENE.ember);

/** Heat ramp for power draw: teal (low) through amber to ember (high). */
export function powerColor(p: number, lo: number, hi: number, out = new Color()): Color {
  const x = Math.min(Math.max((p - lo) / Math.max(hi - lo, 1), 0), 1);
  return x < 0.5 ? out.lerpColors(low, mid, x * 2) : out.lerpColors(mid, high, (x - 0.5) * 2);
}

export function powerCss(p: number, lo: number, hi: number): string {
  return `#${powerColor(p, lo, hi).getHexString()}`;
}

/** Robust power range for colouring: 5th to 95th percentile of airborne samples. */
export function powerRange(power: number[], up: number[]): [number, number] {
  const airborne = power.filter((_, i) => up[i] > 2).sort((a, b) => a - b);
  const src = airborne.length > 10 ? airborne : [...power].sort((a, b) => a - b);
  return [src[Math.floor(src.length * 0.05)], src[Math.floor(src.length * 0.95)]];
}

/** Dataset east/north/up (m) to three.js world: x = east, y = up, z = -north. */
export function toWorld(east: number, north: number, up: number): [number, number, number] {
  return [east, Math.max(up, 0), -north];
}
