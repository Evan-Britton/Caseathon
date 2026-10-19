import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { BufferAttribute, BufferGeometry, Color, MathUtils, ShaderMaterial, Vector3 } from "three";
import { useStore } from "../store";
import type { FlightMeta, GroundSampler } from "../types";
import { dronePose } from "./Drone";
import { SCENE } from "./palette";

/**
 * Real terrain around the launch point, from Mapzen/Tilezen Terrain Tiles on AWS
 * (USGS 3DEP elevation here, ~3 m resolution). Drawn as a holographic topo map:
 * hill-shaded relief, glowing contour lines, a faint 100 m grid, a scan pulse
 * that ripples out from the drone, and an edge that fades into the dark.
 *
 * Heights are shifted so the ground at the launch point is y = 0, matching the
 * recorded "metres above launch" altitudes.
 */

const ZOOM = 15; // Terrarium's max zoom: ~3.6 m per pixel at this latitude
const TILE_RADIUS = 1; // 3 x 3 tiles, ~2.8 km square
const STEP = 2; // sample every 2nd pixel: ~385 x 385 vertices
const TILE_PX = 256;
const M_PER_DEG_LAT = 110_540; // same conversion as scripts/build_web_data.py
const M_PER_DEG_LON_EQ = 111_320;
const tileUrl = (x: number, y: number) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${ZOOM}/${x}/${y}.png`;

const worldX = (lon: number) => ((lon + 180) / 360) * 2 ** ZOOM * TILE_PX;
const worldY = (lat: number) => {
  const r = MathUtils.degToRad(lat);
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM * TILE_PX;
};
const lonAt = (px: number) => (px / (2 ** ZOOM * TILE_PX)) * 360 - 180;
const latAt = (py: number) => MathUtils.radToDeg(Math.atan(Math.sinh(Math.PI - (2 * Math.PI * py) / (2 ** ZOOM * TILE_PX))));

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load elevation tile ${url}`));
    img.src = url;
  });
}

interface TerrainData {
  geometry: BufferGeometry;
  ground: GroundSampler;
  minH: number;
  maxH: number;
  launchElevation: number; // m above sea level per the elevation model
  radius: number; // m, fade-out radius around the launch point
}

async function buildTerrain(lat: number, lon: number): Promise<TerrainData> {
  const cx = Math.floor(worldX(lon) / TILE_PX);
  const cy = Math.floor(worldY(lat) / TILE_PX);
  const tiles = 2 * TILE_RADIUS + 1;
  const size = tiles * TILE_PX;
  const x0 = (cx - TILE_RADIUS) * TILE_PX; // global pixel of the block's top-left
  const y0 = (cy - TILE_RADIUS) * TILE_PX;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  await Promise.all(
    Array.from({ length: tiles * tiles }, async (_, k) => {
      const dx = k % tiles;
      const dy = Math.floor(k / tiles);
      const img = await loadImage(tileUrl(cx - TILE_RADIUS + dx, cy - TILE_RADIUS + dy));
      ctx.drawImage(img, dx * TILE_PX, dy * TILE_PX);
    }),
  );
  const rgba = ctx.getImageData(0, 0, size, size).data;
  // Terrarium encoding: metres = R * 256 + G + B / 256 - 32768
  const elev = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) elev[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;

  const elevAtPx = (px: number, py: number) => {
    const x = Math.min(Math.max(px, 0), size - 1.001);
    const y = Math.min(Math.max(py, 0), size - 1.001);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const a = elev[iy * size + ix];
    const b = elev[iy * size + ix + 1];
    const c = elev[(iy + 1) * size + ix];
    const d = elev[(iy + 1) * size + ix + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  const cosLat = Math.cos(MathUtils.degToRad(lat));
  const launchElevation = elevAtPx(worldX(lon) - x0, worldY(lat) - y0);
  // Local metres (x east, z south) <-> block pixels
  const toPx = (x: number, z: number) => {
    const plon = lon + x / (M_PER_DEG_LON_EQ * cosLat);
    const plat = lat - z / M_PER_DEG_LAT;
    return [worldX(plon) - x0, worldY(plat) - y0] as const;
  };
  const ground: GroundSampler = (x, z) => {
    const [px, py] = toPx(x, z);
    return elevAtPx(px, py) - launchElevation;
  };

  const n = Math.floor((size - 1) / STEP) + 1;
  const pos = new Float32Array(n * n * 3);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < n; j++) {
    const py = j * STEP;
    const z = -(latAt(y0 + py) - lat) * M_PER_DEG_LAT;
    for (let i = 0; i < n; i++) {
      const px = i * STEP;
      const x = (lonAt(x0 + px) - lon) * M_PER_DEG_LON_EQ * cosLat;
      const h = elev[py * size + px] - launchElevation;
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      pos.set([x, h, z], (j * n + i) * 3);
    }
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      index.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], k);
      k += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeVertexNormals();

  // Fade out before the nearest block edge so the map reads as a floating disc.
  const [opx, opy] = [worldX(lon) - x0, worldY(lat) - y0];
  const edgePx = Math.min(opx, opy, size - opx, size - opy);
  const radius = edgePx * 0.97 * (40_075_016 * cosLat) / (2 ** ZOOM * TILE_PX);
  return { geometry, ground, minH, maxH, launchElevation, radius };
}

const vertexShader = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vPos = position;
    vNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uLine;
  uniform vec3 uAccent;
  uniform float uMinH;
  uniform float uMaxH;
  uniform float uOffset;
  uniform float uRadius;
  uniform float uTime;
  uniform vec3 uDrone;
  varying vec3 vPos;
  varying vec3 vNormal;

  // Anti-aliased iso-line: 1 on the line, 0 away from it.
  float isoLine(float v, float interval, float width) {
    float f = v / interval;
    float d = abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-4);
    return 1.0 - clamp(d / width, 0.0, 1.0);
  }

  void main() {
    float t = clamp((vPos.y - uMinH) / max(uMaxH - uMinH, 1.0), 0.0, 1.0);
    vec3 col = mix(uLow, uHigh, pow(t, 0.8));

    // Hill shading from a low north-west sun
    float shade = clamp(dot(normalize(vNormal), normalize(vec3(-0.5, 0.75, -0.45))), 0.0, 1.0);
    col *= 0.35 + 0.9 * shade;

    // Contours on true elevation: minor every 5 m, major every 25 m
    float elev = vPos.y + uOffset;
    col += uLine * isoLine(elev, 5.0, 0.9) * 0.22;
    col += uLine * isoLine(elev, 25.0, 1.3) * 0.75;

    // Faint 100 m grid
    float grid = max(isoLine(vPos.x, 100.0, 0.8), isoLine(vPos.z, 100.0, 0.8));
    col += uLine * grid * 0.07;

    // Scan pulse rippling out from the drone every few seconds, plus a halo beneath it
    float d = distance(vPos.xz, uDrone.xz);
    float r = mod(uTime * 120.0, uRadius * 1.1);
    float ring = smoothstep(6.0, 0.0, abs(d - r)) * (1.0 - r / (uRadius * 1.1));
    col += uAccent * ring * 0.4;
    col += uAccent * smoothstep(24.0, 0.0, d) * 0.12;

    // Glowing boundary ring, then fade to transparent at the edge
    float e = length(vPos.xz) / uRadius;
    col += uLine * (1.0 - smoothstep(0.0, 0.006, abs(e - 0.86))) * 0.9;
    float alpha = 1.0 - smoothstep(0.86, 1.0, e);

    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

export function Terrain({ meta }: { meta: FlightMeta }) {
  const setGround = useStore((s) => s.setGround);
  const setMapCredits = useStore((s) => s.setMapCredits);
  const [data, setData] = useState<TerrainData | null>(null);
  const { lat, lon } = meta.origin;

  useEffect(() => {
    let cancelled = false;
    let built: TerrainData | null = null;
    buildTerrain(lat, lon)
      .then((d) => {
        if (cancelled) return d.geometry.dispose();
        built = d;
        setData(d);
        setGround(d.ground);
        setMapCredits("Terrain: Mapzen Terrain Tiles on AWS, USGS 3DEP");
      })
      .catch((e: Error) => console.error(e));
    return () => {
      cancelled = true;
      built?.geometry.dispose();
      setData(null);
      setGround(null);
    };
  }, [lat, lon, setGround, setMapCredits]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        uniforms: {
          uLow: { value: new Color("#06121a") },
          uHigh: { value: new Color("#1b4a5a") },
          uLine: { value: new Color(SCENE.teal) },
          uAccent: { value: new Color("#9fe8f5") }, // cool pulse, distinct from the power ramp
          uMinH: { value: 0 },
          uMaxH: { value: 1 },
          uOffset: { value: 0 },
          uRadius: { value: 1000 },
          uTime: { value: 0 },
          uDrone: { value: new Vector3() },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    if (!data) return;
    material.uniforms.uMinH.value = data.minH;
    material.uniforms.uMaxH.value = data.maxH;
    material.uniforms.uOffset.value = data.launchElevation;
    material.uniforms.uRadius.value = data.radius;
  }, [data, material]);

  useFrame(({ clock }) => {
    material.uniforms.uTime.value = clock.elapsedTime;
    (material.uniforms.uDrone.value as Vector3).set(dronePose.x, dronePose.y, dronePose.z);
  });

  if (!data) return null;
  return <mesh geometry={data.geometry} material={material} renderOrder={-2} />;
}
