import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, PointsMaterial } from "three";

/** A faint starfield on a distant dome, for the night-ops look. Static, so it costs one draw call. */
export function Stars({ count = 1400, radius = 4200 }: { count?: number; radius?: number }) {
  const { geometry, material } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const theta = rand() * Math.PI * 2;
      const y = 0.06 + rand() * 0.94; // upper hemisphere only, a little above the horizon
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    const m = new PointsMaterial({ color: 0xd8d4ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false, depthWrite: false });
    return { geometry: g, material: m };
  }, [count, radius]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  return <points geometry={geometry} material={material} />;
}
