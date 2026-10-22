import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Vector2 } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Final grade, after tone mapping and the sRGB conversion: a soft vignette and fine animated film grain
 * (which also hides gradient banding). Appended to the output pass's shader, so it costs no extra pass.
 */
const GRADE_PARS = /* glsl */ `
  uniform float uTime;
  float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
`;
const GRADE = /* glsl */ `
  float vd = length((vUv - 0.5) * vec2(1.0, 0.9));
  gl_FragColor.rgb *= 1.0 - smoothstep(0.3, 0.85, vd) * 0.5;
  gl_FragColor.rgb += (rand(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * 0.03;
`;

/**
 * Post-processing: bloom on anything brighter than white-ish (nav lights, strobe, hot motors,
 * the flight path and its trail), then one final pass for tone mapping, the vignette and grain.
 * Takes over rendering from R3F by running at frame priority 1.
 */
export function Effects() {
  const { gl, scene, camera, size } = useThree();
  const dpr = useThree((s) => s.viewport.dpr);
  const { composer, grade } = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new Vector2(256, 256), 0.85, 0.5, 0.7));
    const output = new OutputPass();
    output.uniforms.uTime = { value: 0 };
    output.material.fragmentShader = output.material.fragmentShader
      .replace("varying vec2 vUv;", `varying vec2 vUv;\n${GRADE_PARS}`)
      .replace(/}\s*$/, `${GRADE}\n}`);
    composer.addPass(output);
    return { composer, grade: output };
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
