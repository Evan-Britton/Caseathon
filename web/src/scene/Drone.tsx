import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { lerpAt, sampleAt } from "../data";
import { missionState } from "../mission";
import { budgetFor, clock, useStore } from "../store";
import type { FlightMeta, FlightSeries } from "../types";
import { SCENE, toWorld } from "./palette";

// A real M100 spans ~0.65 m; drawn 6x so it stays readable against a ~150 m route.
export const DRONE_SCALE = 6;
const ARM_ANGLES = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
const ARM_REACH = 0.33;
const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shared pose so the camera rig can follow the drone. */
export const dronePose = { x: 0, y: 0, z: 0, headingRad: 0 };

/** DOM targeting reticle drawn over the canvas; positioned each frame from the drone's screen position. */
export const reticle: { el: HTMLDivElement | null; label: HTMLSpanElement | null } = { el: null, label: null };
const projected = new Vector3();
const RING = { go: new Color(SCENE.teal), review: new Color(SCENE.amber), stop: new Color(SCENE.ember) };

export function Drone({ series, meta }: { series: FlightSeries; meta: FlightMeta }) {
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const rotors = useRef<(Mesh | null)[]>([]);
  const marker = useRef<Group>(null);
  const drop = useRef<Mesh>(null);
  const ring = useRef<MeshBasicMaterial>(null);
  const { camera, size } = useThree();
  const shadowTex = useMemo(radialGlow, []);

  useFrame((_, delta) => {
    const { i, f } = sampleAt(series.t, clock.time);
    const [x, y, z] = toWorld(lerpAt(series.east, i, f), lerpAt(series.north, i, f), lerpAt(series.up, i, f));
    const h0 = series.heading[i];
    const h1 = series.heading[Math.min(i + 1, series.heading.length - 1)];
    const dh = ((h1 - h0 + 540) % 360) - 180;
    const headingRad = ((h0 + dh * f) * Math.PI) / 180;
    Object.assign(dronePose, { x, y, z, headingRad });

    group.current?.position.set(x, y, z);
    if (body.current) {
      // Cosmetic forward lean proportional to ground speed (multirotors pitch into their direction of travel).
      const lean = Math.min(lerpAt(series.groundSpeed, i, f) * 1.3, 16) * (Math.PI / 180);
      body.current.rotation.set(-lean, -headingRad, 0, "YXZ");
    }
    const airborne = y > 0.5;
    // Simulated failure flights: motors stop once power is lost.
    const powerLost = !!meta.simulated && clock.time >= (meta.failureS ?? Infinity);
    if (!reducedMotion && !powerLost) {
      for (const [k, r] of rotors.current.entries()) if (r) r.rotation.y += (k % 2 ? 1 : -1) * delta * (airborne ? 60 : 8);
    }
    const ground = useStore.getState().ground;
    const g = ground ? ground(x, z) : 0;
    marker.current?.position.set(x, g + 0.3, z);
    if (drop.current) {
      const h = Math.max(y - g, 0.01);
      drop.current.scale.y = h;
      drop.current.position.y = -h / 2;
      drop.current.visible = airborne && h > 0.5;
    }
    // Mission check at this instant: tint the ground ring and the reticle once a call is made.
    const st = useStore.getState();
    const mission = missionState(st.forecast, meta, budgetFor(st.model, meta, st.budgetWh), st.model?.deadlineFrac ?? 0.5, clock.time);
    const callType = mission.call?.type;
    ring.current?.color.copy(callType === "return" ? RING.stop : callType === "review" ? RING.review : RING.go);
    if (reticle.el) {
      projected.set(x, y, z).project(camera);
      const visible = projected.z < 1;
      reticle.el.style.opacity = visible ? "1" : "0";
      reticle.el.style.transform = `translate(${((projected.x + 1) / 2) * size.width}px, ${((1 - projected.y) / 2) * size.height}px)`;
      reticle.el.classList.toggle("reticle-fail", powerLost);
      reticle.el.classList.toggle("reticle-return", !powerLost && callType === "return");
      reticle.el.classList.toggle("reticle-review", !powerLost && callType === "review");
      const tag = callType === "return" ? " · turn back" : callType === "review" ? " · operator review" : "";
      if (reticle.label) reticle.label.textContent = powerLost ? `Power lost, ${y.toFixed(0)} m` : `${y.toFixed(0)} m above launch${tag}`;
    }
  });

  const payloadScale = meta.payload > 0 ? 0.7 + meta.payload / 1000 : 0;

  return (
    <>
      <group ref={group}>
        <group ref={body} scale={DRONE_SCALE}>
          <mesh position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.11, 0.12, 0.05, 24]} />
            <meshStandardMaterial color="#59636e" roughness={0.45} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.07, 0.01]}>
            <boxGeometry args={[0.09, 0.05, 0.16]} />
            <meshStandardMaterial color="#3a424c" roughness={0.5} />
          </mesh>
          {ARM_ANGLES.map((a, k) => {
            const mx = Math.sin(a) * ARM_REACH;
            const mz = -Math.cos(a) * ARM_REACH;
            // Aviation nav lights: port (left) red, starboard (right) green; -z is forward.
            const light = mz < 0 ? (mx < 0 ? "#ff4d4d" : "#5cff9a") : "#f5f7fa";
            return (
              <group key={k}>
                <mesh position={[mx / 2, 0.02, mz / 2]} rotation={[0, -a, 0]}>
                  <boxGeometry args={[0.024, 0.018, ARM_REACH]} />
                  <meshStandardMaterial color="#454e58" roughness={0.4} metalness={0.4} />
                </mesh>
                <mesh position={[mx, 0.04, mz]}>
                  <cylinderGeometry args={[0.028, 0.028, 0.045, 16]} />
                  <meshStandardMaterial color="#8a95a3" roughness={0.3} metalness={0.6} />
                </mesh>
                <mesh position={[mx, 0.005, mz]}>
                  <sphereGeometry args={[0.014, 10, 8]} />
                  <meshBasicMaterial color={light} toneMapped={false} />
                </mesh>
                <mesh ref={(m) => void (rotors.current[k] = m)} position={[mx, 0.067, mz]}>
                  <cylinderGeometry args={[0.165, 0.165, 0.003, 32]} />
                  <meshBasicMaterial color="#cfe9ef" transparent opacity={0.14} depthWrite={false} />
                </mesh>
              </group>
            );
          })}
          {[-1, 1].map((s) => (
            <group key={s}>
              <mesh position={[s * 0.09, -0.07, 0]} rotation={[0, 0, s * 0.25]}>
                <cylinderGeometry args={[0.008, 0.008, 0.16, 8]} />
                <meshStandardMaterial color="#454e58" />
              </mesh>
              <mesh position={[s * 0.11, -0.15, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.009, 0.009, 0.22, 8]} />
                <meshStandardMaterial color="#454e58" />
              </mesh>
            </group>
          ))}
          {/* USPS small flat-rate box, sized by payload mass */}
          {payloadScale > 0 && (
            <group position={[0, -0.1, 0]} scale={payloadScale}>
              <mesh>
                <boxGeometry args={[0.14, 0.04, 0.22]} />
                <meshStandardMaterial color="#e9ecef" roughness={0.8} />
              </mesh>
              <mesh>
                <boxGeometry args={[0.142, 0.042, 0.04]} />
                <meshStandardMaterial color="#2f5f9a" roughness={0.8} />
              </mesh>
            </group>
          )}
        </group>
        <mesh ref={drop}>
          <cylinderGeometry args={[0.06, 0.06, 1, 6]} />
          <meshBasicMaterial color={SCENE.teal} transparent opacity={0.35} />
        </mesh>
      </group>
      <group ref={marker}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[9, 9]} />
          <meshBasicMaterial map={shadowTex} transparent depthWrite={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[4.2, 4.5, 48]} />
          <meshBasicMaterial ref={ring} color={SCENE.teal} transparent opacity={0.6} />
        </mesh>
      </group>
    </>
  );
}

function radialGlow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(63,182,201,0.45)");
  grad.addColorStop(1, "rgba(63,182,201,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}
