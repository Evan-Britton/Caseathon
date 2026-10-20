import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import { lerpAt, sampleAt } from "../data";
import { missionState } from "../mission";
import { activeForecast, budgetFor, clock, useStore } from "../store";
import type { FlightMeta, FlightSeries } from "../types";
import { MOTORS_ON_W, SCENE, powerRange, toWorld } from "./palette";
import { Smoke } from "./Smoke";

// A real M100 spans ~0.65 m; drawn 6x so it stays readable against a ~150 m route.
export const DRONE_SCALE = 6;
// Model units from the hull centre down to the bottom of the skids, so the aircraft stands on y = 0.
const GEAR = 0.164;
/** Metres the hull centre sits above the recorded position, so the skids touch the ground at y = 0. */
export const BODY_LIFT = GEAR * DRONE_SCALE;
const ARM_ANGLES = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
const ARM_REACH = 0.33;
const ROTOR_Y = 0.075;
const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shared pose so the camera rig can follow the drone. */
export const dronePose = { x: 0, y: 0, z: 0, headingRad: 0 };

/** DOM targeting reticle drawn over the canvas; positioned each frame from the drone's screen position. */
export const reticle: { el: HTMLDivElement | null; label: HTMLSpanElement | null } = { el: null, label: null };
const projected = new Vector3();
const RING = { go: new Color(SCENE.accent), review: new Color(SCENE.warn), stop: new Color(SCENE.stop) };

// Aviation nav lights, pushed above 1.0 so the bloom pass picks them up.
const NAV = { port: new Color("#ff4d4d").multiplyScalar(4), starboard: new Color("#5cff9a").multiplyScalar(4), tail: new Color("#f5f7fa").multiplyScalar(3) };
const STROBE_ON = new Color(10, 10, 10);
const STROBE_OFF = new Color("#5a5e63");

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export function Drone({ series, meta }: { series: FlightSeries; meta: FlightMeta }) {
  const group = useRef<Group>(null);
  const body = useRef<Group>(null);
  const rotors = useRef<(Group | null)[]>([]);
  const lights = useRef<Group>(null);
  const strobe = useRef<Mesh>(null);
  const gimbal = useRef<Group>(null);
  const marker = useRef<Group>(null);
  const drop = useRef<Mesh>(null);
  const ring = useRef<MeshBasicMaterial>(null);
  const spin = useRef(0);
  const heat = useRef(0);
  const { camera, size } = useThree();
  const shadowTex = useMemo(radialGlow, []);
  const mats = useMemo(makeMaterials, []);
  const deck = useMemo(() => deckMaterial(meta.id), [meta.id]);
  const bladeGeo = useMemo(() => new SphereGeometry(1, 16, 8), []);
  const discGeo = useMemo(() => new CircleGeometry(0.17, 40), []);
  const [lo, hi] = useMemo(() => powerRange(series.power, series.up), [series]);

  // Power-loss flights tumble from the cutoff until they hit the ground.
  const impactS = useMemo(() => {
    if (!meta.simulated || meta.failureS === undefined) return Infinity;
    const k = series.t.findIndex((t, i) => t > meta.failureS! && series.up[i] <= 0.05);
    return k < 0 ? series.t[series.t.length - 1] : series.t[k];
  }, [series, meta]);

  useEffect(() => () => shadowTex.dispose(), [shadowTex]);
  useEffect(() => () => void [deck.map?.dispose(), deck.dispose()], [deck]);
  useEffect(
    () => () => {
      for (const m of Object.values(mats)) {
        if ("map" in m) m.map?.dispose();
        m.dispose();
      }
      bladeGeo.dispose();
      discGeo.dispose();
    },
    [mats, bladeGeo, discGeo],
  );

  useFrame((state, delta) => {
    const { i, f } = sampleAt(series.t, clock.time);
    const [x, y, z] = toWorld(lerpAt(series.east, i, f), lerpAt(series.north, i, f), lerpAt(series.up, i, f));
    const h0 = series.heading[i];
    const h1 = series.heading[Math.min(i + 1, series.heading.length - 1)];
    const dh = ((h1 - h0 + 540) % 360) - 180;
    const headingRad = ((h0 + dh * f) * Math.PI) / 180;
    Object.assign(dronePose, { x, y, z, headingRad });

    // Simulated failure flights: motors stop once power is lost.
    const powerLost = !!meta.simulated && clock.time >= (meta.failureS ?? Infinity);
    const power = lerpAt(series.power, i, f);
    const motorsOn = !powerLost && power > MOTORS_ON_W;
    const airborne = y > 0.5;
    const speed = lerpAt(series.groundSpeed, i, f);

    group.current?.position.set(x, y, z);
    if (body.current) {
      body.current.position.y = BODY_LIFT;
      // Cosmetic forward lean proportional to ground speed (multirotors pitch into their direction of travel).
      let pitch = -Math.min(speed * 1.3, 16) * (Math.PI / 180);
      let roll = 0;
      if (powerLost) {
        const dt = Math.min(clock.time - meta.failureS!, impactS - meta.failureS!);
        if (clock.time < impactS) {
          pitch = 0.35 * dt * dt;
          roll = 0.7 * dt + 0.9 * dt * dt;
        } else {
          // Wreck: settled on one arm
          pitch = -0.18;
          roll = 0.42;
        }
      }
      body.current.rotation.set(pitch, -headingRad, roll, "YXZ");
    }

    // Rotors spin up and down smoothly; blades blur into a disc at speed.
    const target = motorsOn ? (airborne ? 75 : 30) : 0;
    spin.current += (target - spin.current) * (1 - Math.exp(-delta * 1.6));
    if (!reducedMotion) {
      for (const [k, r] of rotors.current.entries()) if (r) r.rotation.y += (k % 2 ? 1 : -1) * delta * spin.current;
    }
    const blur = reducedMotion ? 0 : smoothstep(18, 42, spin.current);
    mats.blade.opacity = 1 - blur;
    mats.blade.visible = blur < 0.98;
    mats.disc.opacity = (reducedMotion ? smoothstep(5, 30, spin.current) : blur) * 0.9;

    // Motors glow with power draw, then cool after shutdown.
    const draw = Math.min(Math.max((power - lo) / Math.max(hi - lo, 1), 0), 1);
    const hot = motorsOn ? 0.25 + 2.4 * draw * draw : 0;
    heat.current += (hot - heat.current) * (1 - Math.exp(-delta * (motorsOn ? 4 : 0.6)));
    mats.motor.emissiveIntensity = heat.current;

    // Lights: steady nav lights, double-flash anti-collision strobe. Dark once power is lost.
    if (lights.current) lights.current.visible = !powerLost;
    if (strobe.current) {
      const p = state.clock.elapsedTime % 1.3;
      const flash = !powerLost && (p < 0.06 || (p > 0.17 && p < 0.23));
      (strobe.current.material as MeshBasicMaterial).color.set(flash ? STROBE_ON : STROBE_OFF);
    }

    // Sensor ball swings toward the direction of travel and looks a little down.
    if (gimbal.current) {
      const j = Math.min(i + 1, series.t.length - 1);
      const travel = Math.atan2(series.east[j] - series.east[i], series.north[j] - series.north[i]);
      let rel = speed > 1.5 ? travel - headingRad : 0;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      const k = 1 - Math.exp(-delta * 2.5);
      gimbal.current.rotation.y += (-rel - gimbal.current.rotation.y) * k;
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
    const mission = missionState(activeForecast(st), meta, budgetFor(st.model, meta, st.budgetWh), st.model?.deadlineFrac ?? 0.5, clock.time);
    const callType = mission.call?.type;
    ring.current?.color.copy(callType === "return" ? RING.stop : callType === "review" ? RING.review : RING.go);
    if (reticle.el) {
      projected.set(x, y + BODY_LIFT, z).project(camera);
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
          {/* Faceted hull: lower belly, main body, raised top shell with a stencilled deck */}
          <mesh position={[0, -0.0175, 0]} material={mats.gunmetal}>
            <cylinderGeometry args={[0.115, 0.085, 0.03, 8, 1, false, Math.PI / 8]} />
          </mesh>
          <mesh position={[0, 0.02, 0]} material={mats.hull}>
            <cylinderGeometry args={[0.105, 0.115, 0.045, 8, 1, false, Math.PI / 8]} />
          </mesh>
          <mesh position={[0, 0.0425, 0]} material={mats.seam}>
            <cylinderGeometry args={[0.107, 0.107, 0.004, 8, 1, false, Math.PI / 8]} />
          </mesh>
          <mesh position={[0, 0.06, 0]} material={mats.hull}>
            <cylinderGeometry args={[0.062, 0.1, 0.035, 8, 1, false, Math.PI / 8]} />
          </mesh>
          <mesh position={[0, 0.0779, 0]} rotation={[-Math.PI / 2, 0, 0]} material={deck}>
            <circleGeometry args={[0.062, 8, Math.PI / 8]} />
          </mesh>

          {/* GPS mast with puck and the anti-collision strobe on top */}
          <mesh position={[0, 0.128, 0.045]} material={mats.carbon}>
            <cylinderGeometry args={[0.004, 0.005, 0.1, 8]} />
          </mesh>
          <mesh position={[0, 0.183, 0.045]} material={mats.puck}>
            <cylinderGeometry args={[0.022, 0.026, 0.012, 20]} />
          </mesh>
          <mesh ref={strobe} position={[0, 0.195, 0.045]}>
            <sphereGeometry args={[0.011, 12, 8]} />
            <meshBasicMaterial color={STROBE_OFF} />
          </mesh>

          {/* Whip antennas raked back from the rear corners */}
          {[-1, 1].map((s) => (
            <group key={s} position={[s * 0.07, 0.045, 0.075]} rotation={[0.55, 0, s * -0.3]}>
              <mesh position={[0, 0.07, 0]} material={mats.carbon}>
                <cylinderGeometry args={[0.0025, 0.0045, 0.14, 6]} />
              </mesh>
              <mesh position={[0, 0.142, 0]} material={mats.carbon}>
                <sphereGeometry args={[0.005, 8, 6]} />
              </mesh>
            </group>
          ))}

          {/* EO/IR sensor ball under the nose */}
          <mesh position={[0, -0.045, -0.075]} material={mats.gunmetal}>
            <cylinderGeometry args={[0.014, 0.014, 0.03, 12]} />
          </mesh>
          <group ref={gimbal} position={[0, -0.09, -0.075]}>
            <group rotation={[-0.35, 0, 0]}>
              <mesh material={mats.ball}>
                <sphereGeometry args={[0.036, 24, 16]} />
              </mesh>
              <mesh position={[0.008, 0, -0.031]} rotation={[Math.PI / 2, 0, 0]} material={mats.lens}>
                <cylinderGeometry args={[0.015, 0.015, 0.012, 24]} />
              </mesh>
              <mesh position={[-0.017, 0.011, -0.03]} rotation={[Math.PI / 2, 0, 0]} material={mats.lens}>
                <cylinderGeometry args={[0.0075, 0.0075, 0.012, 16]} />
              </mesh>
            </group>
          </group>

          <group ref={lights}>
            {ARM_ANGLES.map((a, k) => {
              const mx = Math.sin(a) * ARM_REACH;
              const mz = -Math.cos(a) * ARM_REACH;
              // Port (left) red, starboard (right) green; -z is forward.
              const c = mz < 0 ? (mx < 0 ? NAV.port : NAV.starboard) : NAV.tail;
              return (
                <mesh key={k} position={[mx, 0.006, mz]}>
                  <sphereGeometry args={[0.011, 10, 8]} />
                  <meshBasicMaterial color={c} />
                </mesh>
              );
            })}
          </group>

          {ARM_ANGLES.map((a, k) => (
            // Each arm is built along local -z, then turned to its corner.
            <group key={k} rotation={[0, -a, 0]}>
              <mesh position={[0, 0.02, -0.115]} material={mats.gunmetal}>
                <boxGeometry args={[0.042, 0.032, 0.036]} />
              </mesh>
              <mesh position={[0, 0.02, -0.115]} material={mats.carbon}>
                <cylinderGeometry args={[0.007, 0.007, 0.042, 10]} />
              </mesh>
              <mesh position={[0, 0.02, -0.219]} rotation={[-Math.PI / 2, 0, 0]} material={mats.carbon}>
                <cylinderGeometry args={[0.01, 0.014, 0.172, 12]} />
              </mesh>
              <mesh position={[0, 0.022, -ARM_REACH]} material={mats.gunmetal}>
                <cylinderGeometry args={[0.034, 0.034, 0.008, 6]} />
              </mesh>
              <mesh position={[0, 0.045, -ARM_REACH]} material={mats.motor}>
                <cylinderGeometry args={[0.026, 0.029, 0.038, 20]} />
              </mesh>
              <mesh position={[0, 0.067, -ARM_REACH]} material={mats.gunmetal}>
                <cylinderGeometry args={[0.02, 0.026, 0.006, 20]} />
              </mesh>
              <group ref={(g) => void (rotors.current[k] = g)} position={[0, ROTOR_Y, -ARM_REACH]}>
                <mesh material={mats.gunmetal}>
                  <cylinderGeometry args={[0.011, 0.013, 0.014, 12]} />
                </mesh>
                {[-1, 1].map((s) => (
                  <mesh key={s} geometry={bladeGeo} material={mats.blade} position={[s * 0.088, 0, 0]} rotation={[s * 0.14, 0, 0]} scale={[0.085, 0.0035, 0.016]} />
                ))}
              </group>
              <mesh geometry={discGeo} material={mats.disc} position={[0, ROTOR_Y, -ARM_REACH]} rotation={[-Math.PI / 2, 0, 0]} />
            </group>
          ))}

          {/* Landing gear: two struts per side down to a skid */}
          {[-1, 1].map((s) => (
            <group key={s}>
              {[-1, 1].map((e) => (
                <Strut key={e} from={[s * 0.055, -0.02, e * 0.055]} to={[s * 0.11, -0.155, e * 0.075]} r={0.006} material={mats.carbon} />
              ))}
              <mesh position={[s * 0.11, -0.155, 0]} rotation={[Math.PI / 2, 0, 0]} material={mats.carbon}>
                <cylinderGeometry args={[0.008, 0.008, 0.26, 10]} />
              </mesh>
              {[-1, 1].map((e) => (
                <mesh key={e} position={[s * 0.11, -0.155, e * 0.13]} material={mats.gunmetal}>
                  <sphereGeometry args={[0.009, 10, 8]} />
                </mesh>
              ))}
            </group>
          ))}

          {/* Rugged payload case with straps, sized by payload mass */}
          {payloadScale > 0 && (
            <group position={[0, -0.1, 0.05]} scale={payloadScale}>
              <mesh material={mats.case}>
                <boxGeometry args={[0.12, 0.05, 0.14]} />
              </mesh>
              <mesh material={mats.caseSeam}>
                <boxGeometry args={[0.123, 0.006, 0.143]} />
              </mesh>
              {[-1, 1].map((e) => (
                <mesh key={e} position={[0, 0, e * 0.04]} material={mats.strap}>
                  <boxGeometry args={[0.126, 0.054, 0.012]} />
                </mesh>
              ))}
            </group>
          )}
        </group>
        <mesh ref={drop}>
          <cylinderGeometry args={[0.06, 0.06, 1, 6]} />
          <meshBasicMaterial color={SCENE.accent} transparent opacity={0.35} />
        </mesh>
      </group>
      <group ref={marker}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[9, 9]} />
          <meshBasicMaterial map={shadowTex} transparent depthWrite={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[4.2, 4.5, 48]} />
          <meshBasicMaterial ref={ring} color={SCENE.accent} transparent opacity={0.6} />
        </mesh>
      </group>
      {meta.simulated && meta.failureS !== undefined && <Smoke series={series} failureS={meta.failureS} />}
    </>
  );
}

const UP = new Vector3(0, 1, 0);

/** A round tube between two points (model units). */
function Strut({ from, to, r, material }: { from: number[]; to: number[]; r: number; material: Material }) {
  const a = new Vector3(...from);
  const b = new Vector3(...to);
  const dir = b.clone().sub(a);
  const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  return (
    <mesh position={a.add(b).multiplyScalar(0.5)} quaternion={q} material={material}>
      <cylinderGeometry args={[r, r, dir.length(), 8]} />
    </mesh>
  );
}

function makeMaterials() {
  return {
    hull: new MeshStandardMaterial({ color: "#4d5340", roughness: 0.78, metalness: 0.2, flatShading: true }),
    seam: new MeshStandardMaterial({ color: "#23261e", roughness: 0.9 }),
    gunmetal: new MeshStandardMaterial({ color: "#3a3e44", roughness: 0.38, metalness: 0.7, flatShading: true }),
    carbon: new MeshStandardMaterial({ color: "#16181b", roughness: 0.3, metalness: 0.35 }),
    motor: new MeshStandardMaterial({ color: "#25282c", roughness: 0.3, metalness: 0.85, emissive: "#ff5a1f", emissiveIntensity: 0 }),
    blade: new MeshStandardMaterial({ color: "#121315", roughness: 0.45, transparent: true }),
    disc: new MeshBasicMaterial({ map: rotorDisc(), transparent: true, depthWrite: false, side: DoubleSide }),
    puck: new MeshStandardMaterial({ color: "#b4b6a3", roughness: 0.6 }),
    ball: new MeshStandardMaterial({ color: "#2b2e33", roughness: 0.32, metalness: 0.6 }),
    lens: new MeshStandardMaterial({ color: "#0a1420", roughness: 0.05, metalness: 1, emissive: "#1d4a8a", emissiveIntensity: 0.7 }),
    case: new MeshStandardMaterial({ color: "#5b5a3f", roughness: 0.85 }),
    caseSeam: new MeshStandardMaterial({ color: "#3a3928", roughness: 0.9 }),
    strap: new MeshStandardMaterial({ color: "#1d1f1a", roughness: 0.9 }),
  };
}

/** Top deck decal: olive paint with seams, rivets, a forward chevron and the flight number stencilled on. */
function deckMaterial(id: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4d5340";
  g.fillRect(0, 0, 256, 256);
  let seed = id * 7919 + 13;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 2200; k++) {
    g.fillStyle = rand() < 0.5 ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.04)";
    g.fillRect(rand() * 256, rand() * 256, 2, 2);
  }
  g.strokeStyle = "rgba(18,20,14,0.75)";
  g.lineWidth = 3;
  g.strokeRect(70, 92, 116, 112);
  g.beginPath();
  g.moveTo(128, 92);
  g.lineTo(128, 204);
  g.stroke();
  g.fillStyle = "rgba(18,20,14,0.7)";
  for (let k = 0; k < 6; k++) {
    for (const [x, y] of [[76, 100 + k * 19], [180, 100 + k * 19]]) {
      g.beginPath();
      g.arc(x, y, 2.4, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Forward chevron (canvas up is the aircraft's nose)
  g.fillStyle = "rgba(226,184,64,0.9)";
  g.beginPath();
  g.moveTo(128, 30);
  g.lineTo(162, 72);
  g.lineTo(146, 72);
  g.lineTo(128, 50);
  g.lineTo(110, 72);
  g.lineTo(94, 72);
  g.closePath();
  g.fill();
  g.fillStyle = "rgba(222,220,196,0.85)";
  g.font = "bold 30px ui-monospace, Menlo, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(id).padStart(3, "0"), 98, 148);
  g.font = "bold 15px ui-monospace, Menlo, monospace";
  g.fillText("UAS", 158, 136);
  g.fillText("M100", 158, 160);
  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 4;
  return new MeshStandardMaterial({ map, roughness: 0.8, metalness: 0.15 });
}

/** Motion-blur disc for a spinning prop, with the bright tip stripe. */
function rotorDisc() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(200,205,195,0)");
  grad.addColorStop(0.18, "rgba(200,205,195,0.05)");
  grad.addColorStop(0.7, "rgba(210,215,205,0.13)");
  grad.addColorStop(0.86, "rgba(220,225,215,0.2)");
  grad.addColorStop(0.89, "rgba(255,176,64,0.55)");
  grad.addColorStop(0.95, "rgba(255,176,64,0.08)");
  grad.addColorStop(1, "rgba(255,176,64,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function radialGlow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(154,140,255,0.45)");
  grad.addColorStop(1, "rgba(154,140,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}
