/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Maps Platform key with the Map Tiles API enabled. Optional: without it the 3D map layer is off. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}
