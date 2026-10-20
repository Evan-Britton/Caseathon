import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Vector2 } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Final grade, after tone mapping: a soft vignette and fine animated film grain (which also hides gradient banding). */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length((vUv - 0.5) * vec2(1.0, 0.9));
      c.rgb *= 1.0 - smoothstep(0.3, 0.85, d) * 0.5;
      c.rgb += (rand(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * 0.03;
      gl_FragColor = c;
    }
  `,
};

/**
 * Post-processing: bloom on anything brighter than white-ish (nav lights, strobe, hot motors,
 * the flight path and its trail), then tone mapping, then the vignette and grain. Takes over
 * rendering from R3F by running at frame priority 1.
 */
export function Effects() {
  const { gl, scene, camera, size } = useThree();
  const dpr = useThree((s) => s.viewport.dpr);
  const { composer, grade } = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new Vector2(256, 256), 0.85, 0.5, 0.7));
    composer.addPass(new OutputPass());
    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    return { composer, grade };
  }, [gl, scene, camera]);

  useEffect(() => {
    composer.setPixelRatio(dpr);
    composer.setSize(size.width, size.height);
  }, [composer, dpr, size]);
  useEffect(
    () => () => {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    },
    [composer],
  );

  useFrame((state, delta) => {
    if (!reducedMotion) grade.uniforms.uTime.value = state.clock.elapsedTime;
    composer.render(delta);
  }, 1);
  return null;
}
