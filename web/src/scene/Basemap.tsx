import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, MathUtils, MeshBasicMaterial, PlaneGeometry, Raycaster, SRGBColorSpace, Texture, TextureLoader, Vector3 } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin } from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { useStore } from "../store";
import type { FlightMeta } from "../types";

export const GOOGLE_MAPS_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || undefined;

/** Same equirectangular conversion as scripts/build_web_data.py, so map and path line up. */
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

// ---------- Google Photorealistic 3D Tiles ----------

const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`).setDecoderConfig({ type: "wasm" });
const down = new Vector3(0, -1, 0);

/**
 * Streams Google's photorealistic 3D tiles around the launch point. The tileset is
 * re-centred on the launch lat/lon, then dropped so the ground under the launch
 * point sits at y = 0 (found by raycasting the loaded tiles), which keeps the
 * recorded "metres above launch" heights honest even where GPS altitude and the
 * map's terrain disagree.
 */
export function PhotoTiles({ meta, apiKey }: { meta: FlightMeta; apiKey: string }) {
  const { camera, gl } = useThree();
  const setMapCredits = useStore((s) => s.setMapCredits);
  const failPhotoMap = useStore((s) => s.failPhotoMap);
  const wrapper = useRef<Group>(null);

  // Created and disposed in one effect (not useMemo) so React's dev double-mount can't leave a disposed renderer behind.
  const [state, setState] = useState<{ tiles: TilesRenderer; reorient: ReorientationPlugin } | null>(null);
  useEffect(() => {
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new TilesFadePlugin());
    const reorient = new ReorientationPlugin({ up: "+y", recenter: true });
    tiles.registerPlugin(reorient);
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, gl);

    // A failure on the root tileset means the key or API setup is wrong, not a single missing tile.
    const onError = (e: { tile: unknown; error: Error }) => {
      if (e.tile) return;
      failPhotoMap(
        `The Google 3D map didn't load (${e.error.message}). Check that VITE_GOOGLE_MAPS_API_KEY is valid, the Map Tiles API is enabled, and the key allows this site. Showing the street map instead.`,
      );
    };
    tiles.addEventListener("load-error", onError);
    setState({ tiles, reorient });
    return () => {
      tiles.removeEventListener("load-error", onError);
      tiles.dispose();
      setState(null);
    };
  }, [apiKey, camera, gl, failPhotoMap]);

  // Re-centre on this flight's launch point and re-find the ground whenever tiles finish loading.
  useEffect(() => {
    if (!state) return;
    const { tiles, reorient } = state;
    const { lat, lon } = meta.origin;
    reorient.transformLatLonHeightToOrigin(lat * MathUtils.DEG2RAD, lon * MathUtils.DEG2RAD, 0);
    const ray = new Raycaster();
    const findGround = () => {
      const w = wrapper.current;
      if (!w) return;
      w.position.y = 0;
      w.updateMatrixWorld(true);
      ray.set(new Vector3(0, 5000, 0), down);
      const hit = ray.intersectObject(tiles.group, true)[0];
      if (hit) w.position.y = -hit.point.y;
    };
    findGround();
    const onLoaded = () => {
      findGround();
      setMapCredits(tiles.getAttributions().filter((a) => a.type === "string").map((a) => String(a.value)).join(", "));
    };
    tiles.addEventListener("tiles-load-end", onLoaded);
    return () => tiles.removeEventListener("tiles-load-end", onLoaded);
  }, [state, meta.origin, setMapCredits]);

  useFrame(() => {
    if (!state) return;
    const { tiles } = state;
    camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(camera, gl);
    tiles.update();
  });

  // The plugin puts X west and Z north; our world has X east and Z south, so turn it half a revolution.
  return (
    <group ref={wrapper}>
      <group rotation={[0, Math.PI, 0]}>
        {state && <primitive object={state.tiles.group} />}
      </group>
    </group>
  );
}

// ---------- OpenStreetMap street tiles on a flat ground plane ----------

const ZOOM = 17; // ~230 m per tile at Pittsburgh's latitude
const RADIUS = 3; // tiles each side of the launch tile, ~1.6 km square in total
const loader = new TextureLoader().setCrossOrigin("anonymous");

function tileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function tileY(lat: number, z: number) {
  const r = MathUtils.degToRad(lat);
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
function tileLon(x: number, z: number) {
  return (x / 2 ** z) * 360 - 180;
}
function tileLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return MathUtils.radToDeg(Math.atan(Math.sinh(n)));
}

/**
 * Standard OpenStreetMap raster tiles laid flat around the launch point, dimmed
 * to sit under the night palette. Heights in the replay are relative to launch,
 * so a flat map is accurate for position but ignores terrain relief.
 */
export function StreetMap({ meta }: { meta: FlightMeta }) {
  const setMapCredits = useStore((s) => s.setMapCredits);
  const { lat, lon } = meta.origin;

  const tiles = useMemo(() => {
    const cx = Math.floor(tileX(lon, ZOOM));
    const cy = Math.floor(tileY(lat, ZOOM));
    const cosLat = Math.cos(MathUtils.degToRad(lat));
    const out: { key: string; url: string; x: number; z: number; w: number; h: number }[] = [];
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        const west = (tileLon(x, ZOOM) - lon) * M_PER_DEG_LON_EQ * cosLat;
        const east = (tileLon(x + 1, ZOOM) - lon) * M_PER_DEG_LON_EQ * cosLat;
        const north = (tileLat(y, ZOOM) - lat) * M_PER_DEG_LAT;
        const south = (tileLat(y + 1, ZOOM) - lat) * M_PER_DEG_LAT;
        out.push({
          key: `${x}/${y}`,
          url: `https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`,
          x: (west + east) / 2,
          z: -(north + south) / 2,
          w: east - west,
          h: north - south,
        });
      }
    }
    return out;
  }, [lat, lon]);

  useEffect(() => setMapCredits("© OpenStreetMap contributors"), [setMapCredits]);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
      {tiles.map((t) => (
        <StreetTile key={t.key} url={t.url} x={t.x} z={t.z} w={t.w} h={t.h} />
      ))}
    </group>
  );
}

function StreetTile({ url, x, z, w, h }: { url: string; x: number; z: number; w: number; h: number }) {
  const { geometry, material } = useMemo(() => {
    const m = new MeshBasicMaterial({ color: 0x5d6873 });
    loader.load(url, (tex: Texture) => {
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      m.map = tex;
      m.needsUpdate = true;
    });
    return { geometry: new PlaneGeometry(w, h), material: m };
  }, [url, w, h]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  // Plane lies in the XY plane before the parent's -90 deg X rotation: +Y here becomes north (-Z world).
  return <mesh geometry={geometry} material={material} position={[x, -z, 0]} />;
}
