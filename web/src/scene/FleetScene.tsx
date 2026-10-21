import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Color, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, RingGeometry, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { lerpAt, sampleAt } from "../data";
import { pathTime } from "../fleet";
import type { LoadedDrone } from "../fleet";
import { fleetStatus, fleetTime, useFleet } from "../fleetStore";
import { useStore } from "../store";
import { DRONE_SCALE, dronePose } from "./Drone";
import { FlightPath } from "./FlightPath";
import { drape } from "./drape";
import { LaunchPad } from "./LaunchPad";
import { SCENE, toWorld } from "./palette";
import { M_PER_DEG_LAT, M_PER_DEG_LON_EQ } from "./Terrain";

const ARM_ANGLES = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
const ARM_REACH = 0.33;
/** Drawn larger than the replay's 6x so five drones stay readable in a wider view. */
const FLEET_SCALE = DRONE_SCALE * 1.7;
const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TONE = {
  go: new Color("#3ee8a8"),
  warn: new Color(SCENE.warn),
  stop: new Color(SCENE.stop),
  idle: new Color(SCENE.accent),
  done: new Color("#8f8ea3"),
};

/** DOM name tags over the canvas, one per drone, moved each frame by FleetDrone. */
export const fleetTags: (HTMLDivElement | null)[] = [];
/** DOM labels for the hub (index 0) and each drone's destination (index 1 + drone), moved each frame by RouteLabels. */
export const routeLabels: (HTMLDivElement | null)[] = [];

/** Each drone's real launch point, in metres east and south of the first drone's (three.js x and z). */
export function realOffsets(loaded: LoadedDrone[]): { x: number; z: number }[] {
  const ref = loaded[0].meta.origin;
  const cos = Math.cos((ref.lat * Math.PI) / 180);
  return loaded.map((d) => ({
    x: (d.meta.origin.lon - ref.lon) * M_PER_DEG_LON_EQ * cos,
    z: -(d.meta.origin.lat - ref.lat) * M_PER_DEG_LAT,
  }));
}

/** Time to draw drone d at: the fleet clock, or running its path backwards once it has been recalled. */
function droneTime(d: LoadedDrone): number {
  return pathTime(fleetTime(), useFleet.getState().decisions[d.slot.flight]);
}

export function FleetScene({ loaded }: { loaded: LoadedDrone[] }) {
  const offsets = useMemo(() => realOffsets(loaded), [loaded]);
  const ground = useStore((s) => s.ground);
  const follow = useFleet((s) => s.follow);
  const selected = useFleet((s) => s.selected);
  return (
    <>
      {loaded.map((d, i) => (
        <LaunchPad key={d.slot.flight} x={offsets[i].x} z={offsets[i].z} disc={false} />
      ))}
      {loaded.map((d, i) => (
        <LaunchPad key={`dest-${d.slot.flight}`} x={offsets[i].x + d.dest.east} z={offsets[i].z - d.dest.north} color="#3ee8a8" />
      ))}
      <RouteLabels loaded={loaded} offsets={offsets} />
      {loaded.map((d, i) => (
        <group key={d.slot.flight} position={[offsets[i].x, 0, offsets[i].z]}>
          <FlightPath series={d.series} ground={ground} getTime={() => droneTime(d)} fade={follow && selected !== d.slot.flight} />
          <FleetDrone d={d} index={i} offset={offsets[i]} />
        </group>
      ))}
      <FleetCamera loaded={loaded} offsets={offsets} />
    </>
  );
}

const projected = new Vector3();

/** Keeps the hub and destination name labels over their spots on the map. */
function RouteLabels({ loaded, offsets }: { loaded: LoadedDrone[]; offsets: { x: number; z: number }[] }) {
  const { camera, size } = useThree();
  useFrame(() => {
    const gnd = useStore.getState().ground;
    const place = (el: HTMLDivElement | null, x: number, z: number) => {
      if (!el) return;
      projected.set(x, (gnd ? gnd(x, z) : 0) + 7, z).project(camera);
      el.style.opacity = projected.z < 1 ? "1" : "0";
      el.style.transform = `translate(${((projected.x + 1) / 2) * size.width}px, ${((1 - projected.y) / 2) * size.height}px) translate(-50%, -100%)`;
    };
    place(routeLabels[0], offsets[0].x, offsets[0].z);
    loaded.forEach((d, i) => place(routeLabels[i + 1], offsets[i].x + d.dest.east, offsets[i].z - d.dest.north));
  });
  return null;
}

function FleetDrone({ d, index, offset }: { d: LoadedDrone; index: number; offset: { x: number; z: number } }) {
  const { series, meta } = d;
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const rotors = useRef<(Mesh | null)[]>([]);
  const marker = useRef<Group>(null);
  const drop = useRef<Mesh>(null);
  const ring = useRef<MeshBasicMaterial>(null);
  const lastTag = useRef("");
  const { camera, size } = useThree();
  const ringGeo = useMemo(() => new RingGeometry(5, 5.8, 40, 2).rotateX(-Math.PI / 2), []);
  useEffect(() => () => ringGeo.dispose(), [ringGeo]);

  useFrame((_, delta) => {
    const te = Math.min(droneTime(d), series.t[series.t.length - 1]);
    const { i, f } = sampleAt(series.t, te);
    const [x, y, z] = toWorld(lerpAt(series.east, i, f), lerpAt(series.north, i, f), lerpAt(series.up, i, f));
    const h0 = series.heading[i];
    const h1 = series.heading[Math.min(i + 1, series.heading.length - 1)];
    const dh = ((h1 - h0 + 540) % 360) - 180;
    const returning = useFleet.getState().decisions[d.slot.flight]?.action === "return";
    const headingRad = ((h0 + dh * f + (returning ? 180 : 0)) * Math.PI) / 180;

    group.current?.position.set(x, y, z);
    if (body.current) {
      const lean = Math.min(lerpAt(series.groundSpeed, i, f) * 1.3, 16) * (Math.PI / 180);
      body.current.rotation.set(-lean, -headingRad, 0, "YXZ");
    }
    const airborne = y > 0.5;
    if (!reducedMotion) {
      for (const [k, r] of rotors.current.entries()) if (r) r.rotation.y += (k % 2 ? 1 : -1) * delta * (airborne ? 60 : 8);
    }
    // Terrain under the drone, in the same launch-relative coordinates as the map.
    const gnd = useStore.getState().ground;
    const g = gnd ? gnd(x + offset.x, z + offset.z) : 0;
    marker.current?.position.set(x, 0, z);
    drape(ringGeo, gnd, x + offset.x, z + offset.z, 0.3);
    if (drop.current) {
      const h = Math.max(y - g, 0.01);
      drop.current.scale.y = h;
      drop.current.position.y = -h / 2;
      drop.current.visible = airborne && h > 0.5;
    }
    // The map's scan pulse follows the drone you have selected.
    if (useFleet.getState().selected === d.slot.flight) Object.assign(dronePose, { x: x + offset.x, y, z: z + offset.z });

    const st = fleetStatus[d.slot.flight];
    ring.current?.color.copy(TONE[st?.tone ?? "idle"]);

    // Name tag: follows the drone on screen, coloured by what it is doing.
    const tag = fleetTags[index];
    if (tag) {
      projected.set(x + offset.x, y + 10, z + offset.z).project(camera);
      const visible = projected.z < 1;
      tag.style.opacity = visible ? "1" : "0";
      // The five flew from the same launch site, so stagger the tags to keep them from stacking.
      const lift = index * 26;
      tag.style.transform = `translate(${((projected.x + 1) / 2) * size.width}px, ${((1 - projected.y) / 2) * size.height - lift}px) translate(-50%, -100%)`;
      // A compact numbered badge. Name and status only show when the drone needs attention or is selected.
      const tone = st?.tone ?? "idle";
      const detail = tone === "warn" || tone === "stop" || useFleet.getState().selected === d.slot.flight;
      const text = `${index + 1}|${detail ? `${d.slot.cargo}: ${st?.status ?? ""}` : ""}|${tone}`;
      if (text !== lastTag.current) {
        lastTag.current = text;
        const [num, status] = text.split("|");
        tag.className = `fleet-tag tone-${tone} ${status ? "" : "compact"}`;
        tag.innerHTML = "";
        const a = document.createElement("strong");
        a.textContent = num;
        tag.append(a);
        if (status) {
          const b = document.createElement("span");
          b.textContent = status;
          tag.append(b);
        }
      }
    }
  });

  const payloadScale = meta.payload > 0 ? 0.7 + meta.payload / 1000 : 0;

  return (
    <>
      <group ref={group}>
        <group ref={body} scale={FLEET_SCALE}>
          <mesh position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.11, 0.12, 0.05, 20]} />
            <meshStandardMaterial color="#59636e" roughness={0.45} metalness={0.4} />
          </mesh>
          {ARM_ANGLES.map((a, k) => {
            const mx = Math.sin(a) * ARM_REACH;
            const mz = -Math.cos(a) * ARM_REACH;
            const light = mz < 0 ? (mx < 0 ? "#ff4d4d" : "#5cff9a") : "#f5f7fa";
            return (
              <group key={k}>
                <mesh position={[mx / 2, 0.02, mz / 2]} rotation={[0, -a, 0]}>
                  <boxGeometry args={[0.024, 0.018, ARM_REACH]} />
                  <meshStandardMaterial color="#454e58" roughness={0.4} metalness={0.4} />
                </mesh>
                <mesh position={[mx, 0.005, mz]}>
                  <sphereGeometry args={[0.014, 8, 6]} />
                  <meshBasicMaterial color={light} toneMapped={false} />
                </mesh>
                <mesh ref={(m) => void (rotors.current[k] = m)} position={[mx, 0.067, mz]}>
                  <cylinderGeometry args={[0.165, 0.165, 0.003, 24]} />
                  <meshBasicMaterial color="#cfe9ef" transparent opacity={0.16} depthWrite={false} />
                </mesh>
              </group>
            );
          })}
          {payloadScale > 0 && (
            <group position={[0, -0.1, 0]} scale={payloadScale}>
              <mesh>
                <boxGeometry args={[0.14, 0.04, 0.22]} />
                <meshStandardMaterial color="#e9ecef" roughness={0.8} />
              </mesh>
              <mesh>
                <boxGeometry args={[0.142, 0.042, 0.04]} />
                <meshStandardMaterial color="#c8323c" roughness={0.8} />
              </mesh>
            </group>
          )}
        </group>
        <mesh ref={drop}>
          <cylinderGeometry args={[0.06, 0.06, 1, 6]} />
          <meshBasicMaterial color={SCENE.accent} transparent opacity={0.3} />
        </mesh>
      </group>
      <group ref={marker}>
        <mesh geometry={ringGeo}>
          <meshBasicMaterial ref={ring} color={SCENE.accent} transparent opacity={0.75} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      </group>
    </>
  );
}

/** Frames all five routes over the map, and lets the viewer orbit and zoom. */
function FleetCamera({ loaded, offsets }: { loaded: LoadedDrone[]; offsets: { x: number; z: number }[] }) {
  const { camera, gl, size } = useThree();
  const controls = useMemo(() => {
    const c = new OrbitControls(camera);
    Object.assign(c, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI / 2 - 0.04, minDistance: 15, maxDistance: 3000 });
    return c;
  }, [camera]);
  useEffect(() => {
    controls.connect(gl.domElement);
    return () => controls.disconnect();
  }, [controls, gl]);

  const aspect = size.width / size.height;
  // Frame all five routes together (the overview).
  const frame = useCallback(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let top = 0;
    loaded.forEach((d, i) => {
      for (let k = 0; k < d.series.east.length; k++) {
        minX = Math.min(minX, d.series.east[k] + offsets[i].x);
        maxX = Math.max(maxX, d.series.east[k] + offsets[i].x);
        minZ = Math.min(minZ, -d.series.north[k] + offsets[i].z);
        maxZ = Math.max(maxZ, -d.series.north[k] + offsets[i].z);
      }
      top = Math.max(top, ...d.series.up);
    });
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 80);
    const dist = (span * 1.25 + top * 0.8) * Math.max(1, 1.2 / aspect);
    camera.position.set(cx + dist * 0.45, top + dist * 0.55, cz + dist * 0.85);
    controls.target.set(cx, top / 3, cz);
    controls.update();
  }, [loaded, offsets, camera, controls, aspect]);

  // Frame once when the fleet appears or the window is resized to a different shape.
  useEffect(() => {
    frame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, offsets, Math.round(aspect * 4)]);

  const wasFollowing = useRef(false);

  // The console's panels frame the 3D view; shift the camera so the fleet is centred in the open map area.
  useEffect(() => {
    const cam = camera as PerspectiveCamera;
    const place = () => {
      const el = document.querySelector(".ops-map");
      const canvas = gl.domElement.getBoundingClientRect();
      if (!el) return cam.clearViewOffset();
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - (canvas.left + canvas.width / 2);
      const dy = r.top + r.height / 2 - (canvas.top + canvas.height / 2);
      cam.setViewOffset(canvas.width, canvas.height, -dx, -dy, canvas.width, canvas.height);
    };
    place();
    const ro = new ResizeObserver(place);
    const el = document.querySelector(".ops-map");
    if (el) ro.observe(el);
    return () => {
      ro.disconnect();
      cam.clearViewOffset();
    };
  }, [camera, gl, size.width, size.height]);

  useFrame((_, delta) => {
    camera.up.set(0, 1, 0);
    const following = useFleet.getState().follow;
    if (following) {
      if (!wasFollowing.current) {
        // Zoom in on the drone the first time, keeping the viewer's current angle.
        wasFollowing.current = true;
        tmpOff.copy(camera.position).sub(controls.target).setLength(150);
        camera.position.copy(controls.target).add(tmpOff);
      }
      // Glide the orbit target onto the selected drone, carrying the camera with it.
      const k = 1 - Math.exp(-delta * 9);
      tmpGoal.set(dronePose.x, dronePose.y * 0.6, dronePose.z);
      tmpStep.copy(tmpGoal).sub(controls.target).multiplyScalar(k);
      controls.target.add(tmpStep);
      camera.position.add(tmpStep);
    } else if (wasFollowing.current) {
      wasFollowing.current = false;
      frame();
    }
    controls.update();
  });
  return null;
}

const tmpOff = new Vector3();
const tmpGoal = new Vector3();
const tmpStep = new Vector3();

