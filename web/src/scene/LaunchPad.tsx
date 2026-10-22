import { useEffect, useLayoutEffect, useMemo } from "react";
import { CircleGeometry, RingGeometry } from "three";
import { useStore } from "../store";
import { drape } from "./drape";
import { SCENE } from "./palette";

/**
 * Launch pad marker at (x, z): a ring, plus a centre disc unless `disc` is off. The launch point is
 * rarely level, so the pad is draped over the terrain and no part of it ends up underground.
 */
export function LaunchPad({ x = 0, z = 0, disc = true, color = SCENE.warn }: { x?: number; z?: number; disc?: boolean; color?: string }) {
  const ground = useStore((s) => s.ground);
  const ringGeo = useMemo(() => new RingGeometry(5, 5.6, 64, 2).rotateX(-Math.PI / 2), []);
  const discGeo = useMemo(() => new CircleGeometry(1.2, 32).rotateX(-Math.PI / 2), []);
  useEffect(
    () => () => {
      ringGeo.dispose();
      discGeo.dispose();
    },
    [ringGeo, discGeo],
  );
  useLayoutEffect(() => {
    drape(ringGeo, ground, x, z, 0.15);
    drape(discGeo, ground, x, z, 0.15);
  }, [ground, ringGeo, discGeo, x, z]);

  return (
    <group position={[x, 0, z]}>
      <mesh geometry={ringGeo}>
        <meshBasicMaterial color={color} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      {disc && (
        <mesh geometry={discGeo}>
          <meshBasicMaterial color={color} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      )}
    </group>
  );
}
