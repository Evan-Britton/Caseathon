# Drone flight replay

A 3D replay of the CMU package-delivery quadcopter flights, with a live **mission check**: as each flight plays, the hybrid energy model (`scripts/hybrid_model.py`) forecasts the energy the mission still needs, and the app decides whether the drone will make it or should turn back. The degradation and countermeasure experiments aren't in the app yet.

Built with React 19, three.js (via React Three Fiber) and Vite. It deploys to Cloudflare Workers as static assets.

## What's on screen

- **3D scene.** The recorded path, coloured by power draw (teal is low, ember is high). A translucent curtain drops from the path to the ground. The drone model is drawn 6× real size so it stays visible.
- **Top bar.** Flight picker (grouped by flight day, with previous and next buttons) and the planned cruise speed, payload, altitude, duration, total energy and date.
- **Mission check.** The model's live call for this flight:
  - **On track**: even the cautious forecast (P90) fits the battery.
  - **Turn back**: even the median forecast doesn't fit.
  - **Too close to call**: the P50–P90 band straddles the battery, so it goes to the operator and is scored as a return.

  The call has to come before halfway round the route; after that the drone is committed, because finishing the loop is the quickest way home. The panel also has:
  - an energy gauge (used, forecast and P90 against the battery line);
  - a forecast chart of the total mission energy over the flight (click to scrub);
  - a **battery slider** (the usable energy for this mission, remembered between visits);
  - a hindsight line comparing the call with what the flight really used.

  The timeline shades the decision window and flags the call, the route map marks halfway and where the call was made, and the drone's reticle and ground ring turn amber or red. Hover tests have no route, so they show "Not rated". Simulated flight 900 uses its own depleted pack (11.8 Wh) instead of the slider.
- **Route.** Top-down map (north up) with a scale bar, plus an altitude profile.
- **Telemetry.** Altitude above launch, ground speed, airflow from the onboard anemometer, battery voltage, current, power, and energy used so far.
- **Playback.** Play/pause, a power-draw scrubber, speed (1–16×), a map layer (Grid, Terrain, Photo) and three camera modes: Orbit, Chase and Top.
- **Simulated flight 900.** A labelled battery-failure scenario, built by `scripts/make_sim_failure.py` from flight 142's real path. It is not CMU data: the picker, a banner, the telemetry chip and the 3D reticle all mark it, and the rotors stop when power is lost.

Keyboard: Space plays or pauses. With the scrubber focused, the arrow keys step 1 s (10 s with Shift), and Home/End jump to the start or end. The URL hash (`#flight=142`) links to a specific flight.

## Map layers

Each flight's launch latitude and longitude (`origin` in `index.json`) places it on a real map. Heights stay relative to the launch point: the ground under the launch point is y = 0.

| Layer | What it is | Needs |
|---|---|---|
| Grid | The dark grid, no map | Nothing |
| Terrain (default) | Real 3D relief from [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/), about 2.8 km square around the launch point. Here that's USGS 3DEP elevation at about 3 m resolution. It's drawn as a holographic topo map: hill shading, glowing contour lines (5 m minor, 25 m major, on true elevation), a faint 100 m grid, a scan pulse from the drone, and an edge that fades out. The path curtain and the drone's shadow sit on the terrain surface. | Nothing |
| Photo | Google Photorealistic 3D Tiles: terrain, trees and buildings. The tileset is re-centred on the launch point and dropped so the ground under it sits at the launch height. | A Google Maps Platform key (below). |

### Turning on the Photo map

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, enable billing and enable the **Map Tiles API**. There's a monthly free allowance.
2. Create an API key. Restrict it to the Map Tiles API and to your site's addresses, for example `http://localhost:5173/*` and `https://<your-worker>.workers.dev/*`.
3. Put it in `web/.env.local`. This file is gitignored.

```
VITE_GOOGLE_MAPS_API_KEY=your-key-here
```

4. Restart `npm run dev`. The Photo button turns on.

The key is built into the client JavaScript, so the address restriction is what protects it.

For a deployed build, set the variable when running `npm run deploy`. If the key is wrong or blocked, the app says so and falls back to the terrain map. Google's attribution shows bottom right while the Photo layer is on.

## Setup

Requires Node 22+.

```bash
cd web
npm install
npm run dev
```

Then open http://localhost:5173.

## Data

The app reads pre-built JSON from `public/data/`: `index.json` plus one file per flight in `flights/<id>.json`. These files are derived from the raw dataset and committed, so the app runs without the raw download.

To rebuild them from the raw CSV:

1. Unzip the committed raw CSV:

```bash
gunzip -k ../data/raw/cmu_drone/flights.csv.gz
```

2. Run:

```bash
npm run data
```

This runs `scripts/build_web_data.py` with Python 3, pandas and numpy. It:

- converts lon/lat/altitude to metres east, north and up of the launch point;
- integrates cumulative energy from voltage × current;
- derives heading from the orientation quaternion, applying a −7° magnetic declination checked against the direction of travel;
- skips the 9 ground tests (routes A1–A3);
- stores each flight's launch latitude, longitude and altitude for the map;
- re-runs `scripts/make_sim_failure.py`, so simulated flight 900 is regenerated rather than dropped.

Source: Rodrigues et al., *Data Collected with Package Delivery Quadcopter Drone*, Carnegie Mellon University, [doi:10.1184/R1/12683453.v1](https://doi.org/10.1184/R1/12683453.v1), CC BY 4.0. The app shows this attribution.

### Model forecasts

`public/data/model/` holds the energy model's forecasts: `index.json` (settings and validation) plus `flights/<id>.json` (energy used, and the P50 and P90 of the energy still needed, once per second of flight). They're committed. To rebuild them, unzip the raw CSV as above, then run:

```bash
npm run model
```

This runs `scripts/export_web_model.py` with Python 3, numpy, pandas and scikit-learn, and takes about 10 s. **Every flight is scored by a model that never saw it:** flights are split into 5 groups by flight day, and each group is forecast by a model trained on the other four. Out of sample, the forecasts are off by 0.38 Wh on average, and the P90 holds 95% of the time. The call itself (on track / turn back / too close) is made in the browser from these numbers and the battery slider, so dragging the slider updates it instantly.

## Deploy to Cloudflare Workers

`wrangler.jsonc` serves `dist/` as static assets, with single-page-app fallback. No Worker script is needed. `public/_headers` sets long-lived caching for hashed JS/CSS and one-hour caching for flight data.

```bash
npx wrangler login
```

```bash
npm run deploy
```

`npm run deploy` runs a type check, `vite build`, then `wrangler deploy`. To test the production build locally on the Workers runtime:

```bash
npm run preview
```

Before the first deploy, change `name` in `wrangler.jsonc` if you want a different `*.workers.dev` subdomain.

## Versions

| Package | Version |
|---|---|
| react, react-dom | 19.3.1 |
| three | 0.186.1 |
| 3d-tiles-renderer | 0.5.3 |
| @react-three/fiber | 9.8.2 |
| zustand | 5.0.15 |
| vite | 8.3.4 |
| typescript | 7.0.2 |
| wrangler | 4.151.1 |

The production build is about 350 KB of gzipped JS. three.js is split into its own long-cached chunk. Each flight file is about 85 KB, or about 27 KB compressed, and loads on demand.

## Code map

| Path | What it does |
|---|---|
| `src/store.ts` | App state (Zustand) and the playback clock. Time lives outside React so the 3D scene can advance every frame without re-rendering. |
| `src/data.ts` | Fetching, caching and time interpolation helpers. |
| `src/mission.ts` | The mission check: on track / turn back / too close, the halfway deadline, and the hindsight outcome. Pure functions shared by the panel, the timeline, the route map and the 3D reticle. |
| `src/scene/` | `Scene` (lights, ground, camera modes), `Terrain` (elevation tiles to topo mesh and shader), `Basemap` (Google photorealistic tiles), `Stars`, `FlightPath` (ribbon and curtain), `Drone` (model and reticle), `palette` (colours shared with CSS). |
| `public/draco/` | Draco mesh decoder for Google's compressed 3D tiles. It only loads when the Photo layer is on. |
| `src/ui/` | `TopBar`, `Mission` (mission check panel), `useMission` (shared hook), `RouteMap`, `Telemetry`, `Dock` (playback). |
