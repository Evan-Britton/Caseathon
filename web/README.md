# Drone flight replay

A 3D replay of the CMU package-delivery quadcopter flights. Pick a flight, scrub or play it back, and watch the path, power draw and telemetry change over time. It is a visualization only: no prediction model or degradation is applied yet.

Built with React 19, three.js (via React Three Fiber) and Vite. It deploys to Cloudflare Workers as static assets.

## What's on screen

- **3D scene.** The recorded path, coloured by power draw (teal is low, ember is high). A translucent curtain drops from the path to the ground. The drone model is drawn 6× real size so it stays visible.
- **Top bar.** Flight picker (grouped by flight day, with previous and next buttons) and the planned cruise speed, payload, altitude, duration, total energy and date.
- **Route.** Top-down map (north up) with a scale bar, plus an altitude profile.
- **Telemetry.** Altitude above launch, ground speed, airflow from the onboard anemometer, battery voltage, current, power, and energy used so far.
- **Playback.** Play/pause, a power-draw scrubber, speed (1–16×) and three camera modes: Orbit, Chase and Top.

Keyboard: Space plays or pauses. With the scrubber focused, the arrow keys step 1 s (10 s with Shift), and Home/End jump to the start or end. The URL hash (`#flight=142`) links to a specific flight.

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
- skips the 9 ground tests (routes A1–A3).

Source: Rodrigues et al., *Data Collected with Package Delivery Quadcopter Drone*, Carnegie Mellon University, [doi:10.1184/R1/12683453.v1](https://doi.org/10.1184/R1/12683453.v1), CC BY 4.0. The app shows this attribution.

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
| @react-three/fiber | 9.8.2 |
| zustand | 5.0.15 |
| vite | 8.3.4 |
| typescript | 7.0.2 |
| wrangler | 4.151.1 |

The production build is about 330 KB of gzipped JS. three.js is split into its own long-cached chunk. Each flight file is about 85 KB, or about 27 KB compressed, and loads on demand.

## Code map

| Path | What it does |
|---|---|
| `src/store.ts` | App state (Zustand) and the playback clock. Time lives outside React so the 3D scene can advance every frame without re-rendering. |
| `src/data.ts` | Fetching, caching and time interpolation helpers. |
| `src/scene/` | `Scene` (lights, ground, camera modes), `FlightPath` (ribbon and curtain), `Drone` (model and reticle), `palette` (colours shared with CSS). |
| `src/ui/` | `TopBar`, `RouteMap`, `Telemetry`, `Dock` (playback). |
