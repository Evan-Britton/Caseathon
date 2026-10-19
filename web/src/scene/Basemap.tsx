import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { Group, MathUtils, Raycaster, Vector3 } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin } from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { useStore } from "../store";
import type { FlightMeta } from "../types";

export const GOOGLE_MAPS_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || undefined;

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
        `The Google 3D map didn't load (${e.error.message}). Check that VITE_GOOGLE_MAPS_API_KEY is valid, the Map Tiles API is enabled, and the key allows this site. Showing the terrain map instead.`,
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
