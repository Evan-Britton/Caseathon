import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Vector3 } from "three";
import { clock, useStore } from "../store";
import type { CameraMode, FlightMeta, FlightSeries } from "../types";
import { Drone, dronePose } from "./Drone";
import { FlightPath } from "./FlightPath";
import { SCENE } from "./palette";

export function Scene() {
  const series = useStore((s) => s.series);
  const meta = useStore((s) => s.meta);
  const camera = useStore((s) => s.camera);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.5, far: 6000, position: [260, 180, 260] }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      aria-label="3D replay of the selected flight"
    >
      <color attach="background" args={[SCENE.sky]} />
      <fog attach="fog" args={[SCENE.sky, 500, 1600]} />
      <hemisphereLight args={["#f4f7f8", "#9aa58f", 1.6]} />
      <directionalLight position={[120, 300, 80]} intensity={1.4} />
      <Ticker />
      <Ground />
      <LaunchPad />
      {series && meta && (
        <>
          <FlightPath series={series} />
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
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <planeGeometry args={[8000, 8000]} />
        <meshBasicMaterial color={SCENE.ground} />
      </mesh>
      <Grid
        infiniteGrid
        cellSize={10}
        sectionSize={50}
        cellThickness={0.6}
        sectionThickness={1}
        cellColor={SCENE.gridCell}
        sectionColor={SCENE.gridSection}
        fadeDistance={900}
        fadeStrength={1.5}
        position={[0, 0.01, 0]}
      />
    </>
  );
}

function LaunchPad() {
  return (
    <group position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh>
        <ringGeometry args={[5, 6, 64]} />
        <meshBasicMaterial color={SCENE.magenta} />
      </mesh>
      <mesh>
        <circleGeometry args={[1.2, 32]} />
        <meshBasicMaterial color={SCENE.magenta} />
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
  const { camera } = useThree();
  const controls = useRef<{ target: Vector3; update: () => void } | null>(null);
  const bounds = useBounds(series);
  const look = useRef(new Vector3());

  // Reset to a framed three-quarter view when the flight or mode changes.
  useEffect(() => {
    if (mode !== "orbit") return;
    const { center, radius, top } = bounds;
    const d = radius * 2.1 + top;
    camera.position.set(center.x + d * 0.75, top + d * 0.55, center.z + d * 0.95);
    controls.current?.target.copy(center);
    controls.current?.update();
  }, [bounds, mode, camera, meta.id]);

  useFrame((_, delta) => {
    if (mode === "orbit") return;
    const k = 1 - Math.exp(-delta * 4);
    const [x, y, z] = [dronePose.x, dronePose.y, dronePose.z];
    if (mode === "chase") {
      const back = 26;
      tmpPos.set(x + Math.sin(dronePose.headingRad) * -back, y + 10, z + Math.cos(dronePose.headingRad) * back);
      tmpLook.set(x, y + 1, z);
    } else {
      const { center, radius } = bounds;
      tmpPos.set(center.x, Math.max(radius * 3.2, 260), center.z + 0.01);
      tmpLook.set(center.x, 0, center.z);
    }
    camera.position.lerp(tmpPos, k);
    look.current.lerp(tmpLook, k);
    camera.lookAt(look.current);
  });

  return (
    <OrbitControls
      ref={controls as never}
      makeDefault
      enabled={mode === "orbit"}
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI / 2 - 0.04}
      minDistance={8}
      maxDistance={1800}
    />
  );
}

