import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, ShaderMaterial, Vector2 } from "three";
import { clock } from "../store";

// One puff every EMIT seconds of flight time, each living LIFE seconds. Puffs are a pure function of
// playback time (emitted at the drone's position at their birth time), so scrubbing back and forth just works.
const EMIT = 0.06;
const LIFE = 3.5;
const N = Math.ceil(LIFE / EMIT) + 1;

const hash = (k: number) => {
  const s = Math.sin(k * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

const vertexShader = /* glsl */ `
  attribute float aAge;
  uniform float uScale;
  varying float vAge;
  void main() {
    vAge = aAge;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = aAge < 0.0 ? 0.0 : mix(0.9, 7.0, sqrt(aAge)); // metres
    gl_PointSize = size * projectionMatrix[1][1] * uScale / -mv.z;
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAge;
  void main() {
    if (vAge < 0.0) discard;
    float soft = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
    float hot = smoothstep(0.06, 0.0, vAge);
    vec3 smoke = mix(vec3(0.24, 0.23, 0.22), vec3(0.07), vAge);
    vec3 col = mix(smoke, vec3(1.6, 0.55, 0.12), hot); // fresh puffs glow faintly (picked up by bloom)
    gl_FragColor = vec4(col, soft * (1.0 - vAge) * 0.75);
  }
`;

const buffer = new Vector2();

/**
 * Smoke and sparks trailing from the motors after a power loss, and rising from the wreck. `posAt(t)` is
 * where the drone's body was at time t; puffs are emitted from `startS` (the power loss) to `endS`.
 */
export function Smoke({
  startS,
  endS,
  posAt,
  getTime = () => clock.time,
}: {
  startS: number;
  endS: number;
  posAt: (t: number) => [number, number, number];
  getTime?: () => number;
}) {
  const { geometry, material } = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute("aAge", new BufferAttribute(new Float32Array(N).fill(-1), 1));
    const m = new ShaderMaterial({ vertexShader, fragmentShader, transparent: true, depthWrite: false, uniforms: { uScale: { value: 400 } } });
    return { geometry: g, material: m };
  }, []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(({ gl }) => {
    const t = getTime();
    const pos = geometry.attributes.position.array as Float32Array;
    const age = geometry.attributes.aAge.array as Float32Array;
    const k0 = Math.floor(t / EMIT);
    for (let j = 0; j < N; j++) {
      const k = k0 - j;
      const born = k * EMIT;
      const a = (t - born) / LIFE;
      if (born < startS || born > endS || a < 0 || a >= 1) {
        age[j] = -1;
        continue;
      }
      const [x, y, z] = posAt(born);
      const dt = t - born;
      pos[j * 3] = x + (hash(k) - 0.5) * 3 + dt * 1.3;
      pos[j * 3 + 1] = y + (hash(k + 0.37) - 0.5) + dt * 2.6 - dt * dt * 0.12;
      pos[j * 3 + 2] = z + (hash(k + 0.71) - 0.5) * 3 - dt * 0.6;
      age[j] = a;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAge.needsUpdate = true;
    material.uniforms.uScale.value = gl.getDrawingBufferSize(buffer).y / 2;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
