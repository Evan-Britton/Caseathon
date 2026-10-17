import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide } from "three";
import { sampleAt } from "../data";
import { clock } from "../store";
import type { FlightSeries } from "../types";
import { powerColor, powerRange, toWorld } from "./palette";

interface Props {
  series: FlightSeries;
}

/**
 * The flown path as a glowing ribbon coloured by power draw, with a
 * translucent "curtain" dropped to the ground beneath it. Both grow with
 * playback; the remaining route shows as a faint guide line.
 */
export function FlightPath({ series }: Props) {
  const { points, colors, curtain } = useMemo(() => build(series), [series]);
  const flownRef = useRef<{ geometry: { instanceCount: number } }>(null);
  useEffect(() => () => curtain.dispose(), [curtain]);

  useFrame(() => {
    const { i } = sampleAt(series.t, clock.time);
    const segments = Math.max(i, 0);
    if (flownRef.current) flownRef.current.geometry.instanceCount = segments;
    curtain.setDrawRange(0, segments * 6);
  });

  return (
    <group>
      <Line points={points} color="#8b97a5" lineWidth={1} transparent opacity={0.3} dashed dashSize={3} gapSize={2} />
      <Line ref={flownRef as never} points={points} vertexColors={colors} lineWidth={3} />
      <mesh geometry={curtain} renderOrder={-1}>
        <meshBasicMaterial vertexColors transparent side={DoubleSide} depthWrite={false} blending={AdditiveBlending} />
      </mesh>
    </group>
  );
}

function build(series: FlightSeries) {
  const n = series.t.length;
  const [lo, hi] = powerRange(series.power, series.up);
  const points: [number, number, number][] = [];
  const colors: [number, number, number][] = [];
  const pos = new Float32Array(n * 2 * 3);
  const col = new Float32Array(n * 2 * 4);
  const c = new Color();

  for (let i = 0; i < n; i++) {
    const [x, y, z] = toWorld(series.east[i], series.north[i], series.up[i]);
    points.push([x, y, z]);
    powerColor(series.power[i], lo, hi, c);
    colors.push([c.r, c.g, c.b]);
    pos.set([x, y, z, x, 0, z], i * 6);
    col.set([c.r, c.g, c.b, 0.42, c.r, c.g, c.b, 0.0], i * 8);
  }

  const index = new Uint32Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const top = i * 2;
    index.set([top, top + 1, top + 2, top + 1, top + 3, top + 2], i * 6);
  }
  const curtain = new BufferGeometry();
  curtain.setAttribute("position", new BufferAttribute(pos, 3));
  curtain.setAttribute("color", new BufferAttribute(col, 4));
  curtain.setIndex(new BufferAttribute(index, 1));
  return { points, colors, curtain };
}
