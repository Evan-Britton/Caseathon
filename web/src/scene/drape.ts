import type { BufferGeometry } from "three";
import type { GroundSampler } from "../types";

/**
 * Lays a flat ground marker over the terrain. `geo` lies in the XZ plane around its own origin, placed
 * at (cx, cz) with y = 0; each vertex is lifted to `lift` m above the ground beneath it, so a marker
 * on a slope follows the hillside instead of sinking into it. With no terrain the ground is y = 0.
 */
export function drape(geo: BufferGeometry, ground: GroundSampler | null, cx: number, cz: number, lift: number) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, (ground ? ground(cx + pos.getX(i), cz + pos.getZ(i)) : 0) + lift);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}
