import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { CanvasTexture, Color, Group, Mesh, MeshStandardMaterial } from "three";
import { lerpAt, sampleAt } from "../data";
import { statusAt } from "../sim";
import { clock, useStore } from "../store";
import type { FlightMeta, FlightSeries } from "../types";
import { SCENE, toWorld } from "./palette";

// A real M100 spans ~0.65 m; drawn 4x so it stays readable against a ~150 m route.
export const DRONE_SCALE = 4;
const ARM_ANGLES = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
const ARM_REACH = 0.33;
const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const STATUS_COLOR = {
  continue: new Color(SCENE.chartBlue),
  defer: new Color(SCENE.amber),
  return: new Color(SCENE.amber),
  depleted: new Color(SCENE.red),
};

/** Shared pose so the camera rig and ground marker can follow the drone. */
export const dronePose = { x: 0, y: 0, z: 0, headingRad: 0 };

export function Drone({ series, meta }: { series: FlightSeries; meta: FlightMeta }) {
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const rotors = useRef<(Mesh | null)[]>([]);
  const marker = useRef<Group>(null);
  const drop = useRef<Mesh>(null);
  const light = useMemo(() => new MeshStandardMaterial({ color: SCENE.chartBlue, emissive: SCENE.chartBlue, emissiveIntensity: 1.4 }), []);
  const shadowTex = useMemo(radialShadow, []);

  useFrame((_, delta) => {
    const { i, f } = sampleAt(series.t, clock.time);
    const [x, y, z] = toWorld(lerpAt(series.east, i, f), lerpAt(series.north, i, f), lerpAt(series.up, i, f));
    const h0 = series.heading[i];
    const h1 = series.heading[Math.min(i + 1, series.heading.length - 1)];
    const dh = ((h1 - h0 + 540) % 360) - 180;
    const headingRad = ((h0 + dh * f) * Math.PI) / 180;
    Object.assign(dronePose, { x, y, z, headingRad });

    if (group.current) {
      group.current.position.set(x, y, z);
      group.current.rotation.set(0, -headingRad, 0);
    }
    if (body.current) {
      // Cosmetic forward lean proportional to ground speed (multirotors pitch into their direction of travel).
      const lean = Math.min(lerpAt(series.groundSpeed, i, f) * 1.3, 16) * (Math.PI / 180);
      body.current.rotation.x = -lean;
    }
    const airborne = y > 0.5;
    if (!reducedMotion) {
      for (const [k, r] of rotors.current.entries()) if (r) r.rotation.y += (k % 2 ? 1 : -1) * delta * (airborne ? 60 : 8);
    }
    if (marker.current) marker.current.position.set(x, 0.05, z);
    if (drop.current) {
      drop.current.scale.y = Math.max(y, 0.01);
      drop.current.position.y = -y / 2;
      drop.current.visible = airborne;
    }

    const sim = useStore.getState().sim;
    if (sim) {
      const c = STATUS_COLOR[statusAt(sim, i, clock.time)];
      light.color.copy(c);
      light.emissive.copy(c);
    }
  });

  const payloadScale = meta.payload > 0 ? 0.7 + meta.payload / 1000 : 0;

  return (
    <>
      <group ref={group}>
        <group ref={body} scale={DRONE_SCALE}>
          {/* hub and battery */}
          <mesh position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.11, 0.12, 0.05, 24]} />
            <meshStandardMaterial color="#2a2f36" roughness={0.55} metalness={0.2} />
          </mesh>
          <mesh position={[0, 0.07, 0.01]}>
            <boxGeometry args={[0.09, 0.05, 0.16]} />
            <meshStandardMaterial color="#3b424b" roughness={0.6} />
          </mesh>
          {/* status light on the nose (-z is forward) */}
          <mesh position={[0, 0.03, -0.13]} material={light}>
            <sphereGeometry args={[0.022, 16, 12]} />
          </mesh>
          {ARM_ANGLES.map((a, k) => {
            const mx = Math.sin(a) * ARM_REACH;
            const mz = -Math.cos(a) * ARM_REACH;
            const front = mz < 0;
            return (
              <group key={k}>
                <mesh position={[mx / 2, 0.02, mz / 2]} rotation={[0, -a, 0]}>
                  <boxGeometry args={[0.024, 0.018, ARM_REACH]} />
                  <meshStandardMaterial color="#1f2328" roughness={0.4} metalness={0.3} />
                </mesh>
                <mesh position={[mx, 0.04, mz]}>
                  <cylinderGeometry args={[0.028, 0.028, 0.045, 16]} />
                  <meshStandardMaterial color={front ? SCENE.magenta : "#6b7380"} roughness={0.35} metalness={0.5} />
                </mesh>
                <mesh ref={(m) => void (rotors.current[k] = m)} position={[mx, 0.067, mz]}>
                  <cylinderGeometry args={[0.165, 0.165, 0.003, 32]} />
                  <meshStandardMaterial color="#1b2430" transparent opacity={0.16} depthWrite={false} />
                </mesh>
              </group>
            );
          })}
          {/* landing gear */}
          {[-1, 1].map((s) => (
            <group key={s}>
              <mesh position={[s * 0.09, -0.07, 0]} rotation={[0, 0, s * 0.25]}>
                <cylinderGeometry args={[0.008, 0.008, 0.16, 8]} />
                <meshStandardMaterial color="#2a2f36" />
              </mesh>
              <mesh position={[s * 0.11, -0.15, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.009, 0.009, 0.22, 8]} />
                <meshStandardMaterial color="#2a2f36" />
              </mesh>
            </group>
          ))}
          {/* USPS small flat-rate box, sized by payload mass */}
          {payloadScale > 0 && (
            <group position={[0, -0.1, 0]} scale={payloadScale}>
              <mesh>
                <boxGeometry args={[0.14, 0.04, 0.22]} />
                <meshStandardMaterial color="#f2f2ee" roughness={0.8} />
              </mesh>
              <mesh position={[0, 0, 0]}>
                <boxGeometry args={[0.142, 0.042, 0.04]} />
                <meshStandardMaterial color="#2b5c8a" roughness={0.8} />
              </mesh>
            </group>
          )}
        </group>
        {/* vertical drop line to the ground */}
        <mesh ref={drop}>
          <cylinderGeometry args={[0.08, 0.08, 1, 6]} />
          <meshBasicMaterial color={SCENE.ink} transparent opacity={0.35} />
        </mesh>
      </group>
      {/* ground shadow, in world space so it ignores heading */}
      <group ref={marker}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[7, 7]} />
          <meshBasicMaterial map={shadowTex} transparent depthWrite={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[4.2, 4.6, 48]} />
          <meshBasicMaterial color={SCENE.ink} transparent opacity={0.4} />
        </mesh>
      </group>
    </>
  );
}

function radialShadow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(27,36,48,0.45)");
  grad.addColorStop(1, "rgba(27,36,48,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}
