import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { GridHelper, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { clock, useStore } from "../store";
import type { CameraMode, FlightMeta, FlightSeries } from "../types";
import { GOOGLE_MAPS_KEY, PhotoTiles } from "./Basemap";
import { Drone, dronePose } from "./Drone";
import { FlightPath } from "./FlightPath";
import { SCENE } from "./palette";
import { Stars } from "./Stars";
import { Terrain } from "./Terrain";

export function Scene() {
  const series = useStore((s) => s.series);
  const meta = useStore((s) => s.meta);
  const camera = useStore((s) => s.camera);
  const basemap = useStore((s) => s.basemap);
  const ground = useStore((s) => s.ground);
  const onMap = basemap !== "grid";

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.5, far: 6000, position: [260, 180, 260] }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      aria-label="3D replay of the selected flight"
    >
      {/* Push the fog back over real maps so distant terrain stays readable */}
      <fog attach="fog" args={onMap ? [SCENE.horizon, 900, 3200] : [SCENE.horizon, 380, 1400]} />
      <hemisphereLight args={["#9fb4c4", "#0d141a", 1.1]} />
      <directionalLight position={[120, 300, 80]} intensity={1.6} />
      <directionalLight position={[-200, 80, -120]} intensity={0.5} color={SCENE.teal} />
      <Ticker />
      {basemap === "grid" && <Ground />}
      <LaunchPad />
      {basemap !== "photo" && <Stars />}
      {meta && basemap === "terrain" && <Terrain meta={meta} />}
      {meta && basemap === "photo" && GOOGLE_MAPS_KEY && <PhotoTiles meta={meta} apiKey={GOOGLE_MAPS_KEY} />}
      {series && meta && (
        <>
          <FlightPath series={series} glow={basemap !== "photo"} ground={ground} />
          <Drone series={series} meta={meta} />
          <CameraRig series={series} meta={meta} mode={camera} />
        </>
      )}
    </Canvas>
  );
}

/** Advances playback time and mirrors it into the store ~15 times a second. */
function Ticker() {
  const acc = useRef(0);
  useFrame((_, delta) => {
    const st = useStore.getState();
    if (!st.playing || !st.series) return;
    const end = st.series.t[st.series.t.length - 1];
    clock.time = Math.min(clock.time + Math.min(delta, 0.1) * st.rate, end);
    acc.current += delta;
    if (clock.time >= end) st.setPlaying(false);
    else if (acc.current > 1 / 15) {
      acc.current = 0;
      st.setUiTime(clock.time);
    }
  });
  return null;
}

function Ground() {
  const grids = useMemo(
    () => ({
      cells: new GridHelper(2000, 200, SCENE.gridCell, SCENE.gridCell),
      sections: new GridHelper(2000, 40, SCENE.gridSection, SCENE.gridSection),
    }),
    [],
  );
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <planeGeometry args={[8000, 8000]} />
        <meshBasicMaterial color={SCENE.ground} />
      </mesh>
      {/* 10 m cells with 50 m sections; fog fades them toward the horizon */}
      <primitive object={grids.cells} position={[0, 0.01, 0]} />
      <primitive object={grids.sections} position={[0, 0.02, 0]} />
    </>
  );
}

function LaunchPad() {
  return (
    <group position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh>
        <ringGeometry args={[5, 5.6, 64]} />
        <meshBasicMaterial color={SCENE.amber} />
      </mesh>
      <mesh>
        <circleGeometry args={[1.2, 32]} />
        <meshBasicMaterial color={SCENE.amber} />
      </mesh>
    </group>
  );
}

function useBounds(series: FlightSeries) {
  return useMemo(() => {
    const xs = series.east;
    const zs = series.north.map((n) => -n);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const radius = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 60) / 2;
    const top = Math.max(...series.up);
    return { center: new Vector3(cx, top / 3, cz), radius, top };
  }, [series]);
}

const tmpPos = new Vector3();
const tmpLook = new Vector3();

function CameraRig({ series, meta, mode }: { series: FlightSeries; meta: FlightMeta; mode: CameraMode }) {
  const { camera, size, gl } = useThree();
  const controls = useMemo(() => {
    const c = new OrbitControls(camera);
    Object.assign(c, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI / 2 - 0.04, minDistance: 8, maxDistance: 1800 });
    return c;
  }, [camera]);
  // Connect in an effect (not at creation) so React's dev double-mount reconnects the pointer listeners.
  useEffect(() => {
    controls.connect(gl.domElement);
    return () => controls.disconnect();
  }, [controls, gl]);
  const aspect = useRef(1);
  aspect.current = size.width / size.height;
  const bounds = useBounds(series);
  const look = useRef(new Vector3());

  // Reset to a framed three-quarter view when the flight or mode changes.
  useEffect(() => {
    if (mode !== "orbit") return;
    const { center, radius, top } = bounds;
    // Pull back on tall, narrow screens so the whole route stays in frame.
    const d = (radius * 1.7 + top * 0.8) * Math.max(1, 1.25 / aspect.current);
    camera.position.set(center.x + d * 0.75, top + d * 0.5, center.z + d * 0.95);
    controls.target.copy(center);
    controls.update();
  }, [bounds, mode, camera, controls, meta.id]);

  useEffect(() => {
    controls.enabled = mode === "orbit";
  }, [controls, mode]);

  useFrame((_, delta) => {
    // Looking straight down, "up" is ambiguous; pin north to the top of the screen in top view.
    camera.up.set(0, mode === "top" ? 0 : 1, mode === "top" ? -1 : 0);
    if (mode === "orbit") {
      controls.update();
      return;
    }
    const k = 1 - Math.exp(-delta * 4);
    const [x, y, z] = [dronePose.x, dronePose.y, dronePose.z];
    if (mode === "chase") {
      const back = 26;
      tmpPos.set(x + Math.sin(dronePose.headingRad) * -back, y + 10, z + Math.cos(dronePose.headingRad) * back);
      tmpLook.set(x, y + 1, z);
    } else {
      const { center, radius } = bounds;
      tmpPos.set(center.x, radius * 4.2 + 80, center.z + 0.01);
      tmpLook.set(center.x, 0, center.z);
    }
    camera.position.lerp(tmpPos, k);
    look.current.lerp(tmpLook, k);
    camera.lookAt(look.current);
  });

  return null;
}

