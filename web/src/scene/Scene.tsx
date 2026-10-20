import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, GridHelper, PMREMGenerator, SRGBColorSpace, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { useFleet } from "../fleetStore";
import { clock, useStore } from "../store";
import type { CameraMode, FlightMeta, FlightSeries } from "../types";
import { BODY_LIFT, Drone, dronePose } from "./Drone";
import { Effects } from "./Effects";
import { FleetScene } from "./FleetScene";
import { FlightPath } from "./FlightPath";
import { LaunchPad } from "./LaunchPad";
import { SCENE } from "./palette";
import { Stars } from "./Stars";
import { Terrain } from "./Terrain";

export function Scene() {
  const series = useStore((s) => s.series);
  const meta = useStore((s) => s.meta);
  const camera = useStore((s) => s.camera);
  const basemap = useStore((s) => s.basemap);
  const ground = useStore((s) => s.ground);
  const fleet = useFleet((s) => (s.open ? s.loaded : null));
  const onMap = basemap !== "grid" || !!fleet;

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.5, far: 6000, position: [260, 180, 260] }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      aria-label="3D replay of the selected flight"
    >
      {/* Push the fog back over real maps so distant terrain stays readable */}
      <fog attach="fog" args={onMap ? [SCENE.horizon, 900, 3200] : [SCENE.horizon, 380, 1400]} />
      <hemisphereLight args={["#b8b3d9", "#0e0d14", 1.1]} />
      <directionalLight position={[120, 300, 80]} intensity={1.6} />
      <directionalLight position={[-200, 80, -120]} intensity={0.5} color={SCENE.accent} />
      <Backdrop />
      <Reflections />
      <Effects />
      <Ticker />
      {((basemap === "grid" && !fleet) || (fleet && !ground)) && <Ground />}
      {!fleet && <LaunchPad />}
      <Stars />
      {fleet && <Terrain meta={fleet[0].meta} />}
      {fleet && <FleetScene loaded={fleet} />}
      {!fleet && meta && basemap === "terrain" && <Terrain meta={meta} />}
      {!fleet && series && meta && (
        <>
          <FlightPath series={series} ground={ground} failureS={meta.simulated ? meta.failureS : undefined} />
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

/** Opaque sky gradient drawn by three (the bloom pass needs an opaque frame to composite onto). */
function Backdrop() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const [inner, mid, outer] = SCENE.bg;
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d")!;
    // Same shape as the old CSS backdrop: an ellipse centred a little above the middle.
    const grad = g.createRadialGradient(256, 194, 0, 256, 194, 400);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.45, mid);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    scene.background = tex;
    return () => {
      scene.background = null;
      tex.dispose();
    };
  }, [scene]);
  return null;
}

/** Soft studio reflections so the drone's metal parts read as metal. Only PBR materials (the drone) use it. */
function Reflections() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = env;
    scene.environmentIntensity = 0.45;
    return () => {
      scene.environment = null;
      env.dispose();
    };
  }, [gl, scene]);
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
  useEffect(
    () => () => {
      for (const g of Object.values(grids)) g.dispose();
    },
    [grids],
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

// Chase view: default ~26 m behind and ~9 m above the drone. Dragging orbits around it, scrolling zooms.
const CHASE_DIST = 27.5;
const CHASE_PITCH = 0.33; // rad above the horizon
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

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
  // Viewer's chase offsets (yaw relative to the drone's heading), their smoothed values, and the eased heading.
  const chase = useRef({ yaw: 0, pitch: CHASE_PITCH, dist: CHASE_DIST, sYaw: 0, sPitch: CHASE_PITCH, sDist: CHASE_DIST, heading: 0, settle: 0 });

  // Chase mode: drag to orbit the drone, scroll to zoom, double-click to go back behind it.
  useEffect(() => {
    if (mode !== "chase") return;
    const el = gl.domElement;
    const c = chase.current;
    c.heading = dronePose.headingRad;
    c.settle = 0;
    let drag: { id: number; x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      // Same feel as the orbit camera: a full screen-height drag turns the view a full circle.
      const k = (2 * Math.PI) / el.clientHeight;
      c.yaw += (e.clientX - drag.x) * k;
      c.pitch = clamp(c.pitch + (e.clientY - drag.y) * k, 0.05, 1.45);
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      el.style.cursor = "grab";
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      c.dist = clamp(c.dist * Math.exp(e.deltaY * 0.001), 10, 150);
    };
    const reset = () => Object.assign(c, { yaw: 0, pitch: CHASE_PITCH, dist: CHASE_DIST });
    el.style.cursor = "grab";
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("dblclick", reset);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("dblclick", reset);
      el.style.cursor = "";
    };
  }, [gl, mode]);

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
    let k = 1 - Math.exp(-delta * 4);
    const [x, y, z] = [dronePose.x, dronePose.y, dronePose.z];
    if (mode === "chase") {
      // Locked onto the drone; only the heading and the viewer's drag are eased.
      const c = chase.current;
      const kv = 1 - Math.exp(-delta * 12);
      c.heading += wrapAngle(dronePose.headingRad - c.heading) * (1 - Math.exp(-delta * 3));
      c.sYaw += (c.yaw - c.sYaw) * kv;
      c.sPitch += (c.pitch - c.sPitch) * kv;
      c.sDist += (c.dist - c.sDist) * kv;
      const theta = c.heading + c.sYaw;
      const horiz = c.sDist * Math.cos(c.sPitch);
      const cy = y + BODY_LIFT;
      tmpPos.set(x - Math.sin(theta) * horiz, cy + c.sDist * Math.sin(c.sPitch), z + Math.cos(theta) * horiz);
      // Never dip under the terrain.
      const ground = useStore.getState().ground;
      tmpPos.y = Math.max(tmpPos.y, (ground ? ground(tmpPos.x, tmpPos.z) : 0) + 2);
      tmpLook.set(x, cy, z);
      // Glide in when switching to chase, then stay locked.
      c.settle = Math.min(c.settle + delta * 1.5, 1);
      if (c.settle >= 1) k = 1;
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

