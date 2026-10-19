import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, NormalBlending } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { sampleAt } from "../data";
import { clock } from "../store";
import type { FlightSeries, GroundSampler } from "../types";
import { powerColor, powerRange, toWorld } from "./palette";

/**
 * The flown path as a glowing ribbon coloured by power draw, with a
 * translucent "curtain" dropped to the ground (or terrain) beneath it. Both grow with
 * playback; the remaining route shows as a faint dashed guide.
 */
export function FlightPath({ series, glow, ground }: { series: FlightSeries; glow: boolean; ground: GroundSampler | null }) {
  const { flown, guide, curtain } = useMemo(() => build(series, ground), [series, ground]);

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

  useFrame(() => {
    const { i } = sampleAt(series.t, clock.time);
    flown.geometry.instanceCount = i;
    curtain.setDrawRange(0, i * 6);
  });

  return (
    <group>
      <primitive object={guide} />
      <primitive object={flown} />
      <mesh geometry={curtain} renderOrder={-1}>
        {/* Additive glow reads well on the dark grid but washes out over map imagery */}
        <meshBasicMaterial
          key={glow ? "glow" : "plain"}
          vertexColors
          transparent
          side={DoubleSide}
          depthWrite={false}
          blending={glow ? AdditiveBlending : NormalBlending}
        />
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
    lineCol.set([c.r, c.g, c.b], i * 3);
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
    new LineMaterial({ color: 0x8b97a5, linewidth: 1, transparent: true, opacity: 0.3, dashed: true, dashSize: 3, gapSize: 2 }),
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
