import type { EnvelopeAxis, EnvelopeData, EnvelopePoint } from "./types";

/**
 * The pre-launch envelope check: is a planned mission inside the conditions the energy model was
 * trained on? Two tests, both needed:
 *   in range   every condition sits within the trained range on its axis
 *   similar    a real training flight flew close to this combination (within `near` on every axis)
 * The second catches empty corners of the box: 750 g and 12 m/s are each in range, but the only
 * 750 g flight flew at 4 m/s.
 */

export const AXES: EnvelopeAxis[] = ["payload", "speed", "wind"];

export interface AxisCheck {
  axis: EnvelopeAxis;
  value: number;
  min: number;
  max: number;
  /** Below the trained range, above it, or within it. */
  where: "below" | "above" | "ok";
}

export interface EnvelopeCheck {
  axes: AxisCheck[];
  /** Training flights similar to this mission on every axis. */
  similar: number;
  inside: boolean;
}

export function checkEnvelope(env: EnvelopeData, p: EnvelopePoint): EnvelopeCheck {
  const axes = AXES.map((axis): AxisCheck => {
    const [min, max] = env.ranges[axis];
    const value = p[axis];
    return { axis, value, min, max, where: value < min ? "below" : value > max ? "above" : "ok" };
  });
  const similar = env.flights.filter((f) => AXES.every((a) => Math.abs(f[a] - p[a]) <= env.near[a])).length;
  return { axes, similar, inside: axes.every((a) => a.where === "ok") && similar > 0 };
}
