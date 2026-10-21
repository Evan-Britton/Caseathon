import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, InterleavedBufferAttribute } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { lerpAt, sampleAt } from "../data";
import { clock } from "../store";
import type { FlightSeries, GroundSampler } from "../types";
import { SCENE, powerColor, powerRange, toWorld } from "./palette";

// Path colours are pushed above 1.0 so the bloom pass gives the ribbon a soft glow.
const PATH_GAIN = 2.6;
// Comet trail: the last TRAIL_S seconds of flight, drawn white-hot at the drone and fading out behind it.
const TRAIL_S = 6;
const TRAIL_N = 64;
const tmp = new Color();

/**
 * The flown path as a glowing ribbon coloured by power draw, with a
 * translucent "curtain" dropped to the ground (or terrain) beneath it, and a bright comet
 * trail right behind the drone. All grow with playback; the remaining route shows as a
 * faint dashed guide.
 */
export function FlightPath({
  series,
  ground,
  failureS,
  getTime,
  fade = false,
}: {
  series: FlightSeries;
  ground: GroundSampler | null;
  failureS?: number;
  /** Playback time for this path; the single-flight clock if omitted. */
  getTime?: () => number;
  /** Draw the path faintly, so another one can stand out. */
  fade?: boolean;
}) {
  const { flown, guide, curtain } = useMemo(() => build(series, ground), [series, ground]);
  const trail = useMemo(makeTrail, []);
  const [lo, hi] = useMemo(() => powerRange(series.power, series.up), [series]);

  useEffect(
    () => () => {
      for (const line of [flown, guide]) {
        line.geometry.dispose();
        line.material.dispose();
      }
      curtain.dispose();
    },
    [flown, guide, curtain],
  );
  useEffect(
    () => () => {
      trail.geometry.dispose();
      trail.material.dispose();
    },
    [trail],
  );

  useEffect(() => {
    for (const [line, full] of [[flown, 1], [guide, 0.3]] as const) {
      line.material.transparent = true;
      line.material.opacity = fade ? full * 0.15 : full;
      line.material.needsUpdate = true;
    }
    trail.material.opacity = fade ? 0.15 : 1;
  }, [flown, guide, trail, fade]);

  useFrame(() => {
    const time = getTime ? getTime() : clock.time;
    const now = sampleAt(series.t, time);
    flown.geometry.instanceCount = now.i;
    curtain.setDrawRange(0, now.i * 6);

    // No trail once a simulated failure cuts the power: the smoke takes over.
    trail.visible = lerpAt(series.up, now.i, now.f) > 0.5 && time < (failureS ?? Infinity);
    if (!trail.visible) return;
    const pos = (trail.geometry.attributes.instanceStart as InterleavedBufferAttribute).data;
    const col = (trail.geometry.attributes.instanceColorStart as InterleavedBufferAttribute).data;
    const prev = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < TRAIL_N; k++) {
      const u = k / (TRAIL_N - 1); // 0 = tail, 1 = at the drone
      const { i, f } = sampleAt(series.t, Math.max(time - TRAIL_S * (1 - u), 0));
      const [x, y, z] = toWorld(lerpAt(series.east, i, f), lerpAt(series.north, i, f), lerpAt(series.up, i, f));
      // Power colour rising out of black (invisible under additive blending), white-hot at the head.
      powerColor(lerpAt(series.power, i, f), lo, hi, tmp)
        .lerp(WHITE, u ** 8)
        .multiplyScalar(u * u * (1 + 2.5 * u ** 6));
      if (k > 0) {
        pos.array.set([prev[0], prev[1], prev[2], x, y, z], (k - 1) * 6);
        col.array.set([prev[3], prev[4], prev[5], tmp.r, tmp.g, tmp.b], (k - 1) * 6);
      }
      prev.splice(0, 6, x, y, z, tmp.r, tmp.g, tmp.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={guide} />
      <primitive object={flown} />
      <primitive object={trail} />
      <mesh geometry={curtain} renderOrder={-1}>
        {/* Additive glow reads well over the dark grid and the topo map */}
        <meshBasicMaterial vertexColors transparent opacity={fade ? 0.12 : 1} side={DoubleSide} depthWrite={false} blending={AdditiveBlending} />
      </mesh>
    </group>
  );
}

function build(series: FlightSeries, ground: GroundSampler | null) {
  const n = series.t.length;
  const [lo, hi] = powerRange(series.power, series.up);
  const linePos = new Float32Array(n * 3);
  const lineCol = new Float32Array(n * 3);
  const pos = new Float32Array(n * 2 * 3);
  const col = new Float32Array(n * 2 * 4);
  const c = new Color();

  for (let i = 0; i < n; i++) {
    const [x, y, z] = toWorld(series.east[i], series.north[i], series.up[i]);
    powerColor(series.power[i], lo, hi, c);
    linePos.set([x, y, z], i * 3);
    lineCol.set([c.r * PATH_GAIN, c.g * PATH_GAIN, c.b * PATH_GAIN], i * 3);
    // Curtain reaches down to the terrain (or y = 0 on the flat grid), never above the path itself.
    const floor = ground ? Math.min(ground(x, z), y) : 0;
    pos.set([x, y, z, x, floor, z], i * 6);
    col.set([c.r, c.g, c.b, 0.42, c.r, c.g, c.b, 0], i * 8);
  }

  const flownGeo = new LineGeometry();
  flownGeo.setPositions(linePos);
  flownGeo.setColors(lineCol);
  const flown = new Line2(flownGeo, new LineMaterial({ vertexColors: true, linewidth: 3 }));

  const guideGeo = new LineGeometry();
  guideGeo.setPositions(linePos);
  const guide = new Line2(
    guideGeo,
    new LineMaterial({ color: SCENE.accent, linewidth: 1.2, transparent: true, opacity: 0.4, dashed: true, dashSize: 3, gapSize: 2 }),
  );
  guide.computeLineDistances();

  const index = new Uint32Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const top = i * 2;
    index.set([top, top + 1, top + 2, top + 1, top + 3, top + 2], i * 6);
  }
  const curtain = new BufferGeometry();
  curtain.setAttribute("position", new BufferAttribute(pos, 3));
  curtain.setAttribute("color", new BufferAttribute(col, 4));
  curtain.setIndex(new BufferAttribute(index, 1));
  return { flown, guide, curtain };
}

const WHITE = new Color(1, 1, 1);

function makeTrail() {
  const geo = new LineGeometry();
  geo.setPositions(new Float32Array(TRAIL_N * 3));
  geo.setColors(new Float32Array(TRAIL_N * 3));
  const mat = new LineMaterial({ vertexColors: true, linewidth: 5, transparent: true, depthWrite: false, blending: AdditiveBlending });
  const line = new Line2(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 1;
  return line;
}
