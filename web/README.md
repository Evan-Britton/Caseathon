# Drone flight replay

A 3D replay of the CMU package-delivery quadcopter flights, with a live **mission check**: as each flight plays, the hybrid energy model (`scripts/hybrid_model.py`) forecasts the energy the mission still needs, and the app decides whether the drone will make it or should turn back. The degradation and countermeasure experiments aren't in the app yet.

Built with React 19, three.js (via React Three Fiber) and Vite. It deploys to Cloudflare Workers as static assets.

## What's on screen

- **3D scene.** The recorded path, coloured by power draw (indigo is low, violet in between, rose is high). A translucent curtain drops from the path to the ground. The drone model is drawn 6× real size so it stays visible.
- **Top bar.** Flight picker, grouped by flight day, with previous and next buttons.
- **Mission check.** The model's live call for this flight:
  - **On track**: even the cautious forecast (P90) fits the battery.
  - **Turn back**: even the median forecast doesn't fit.
  - **Too close to call**: the P50–P90 band straddles the battery, so it goes to the operator and is scored as a return.

  The call has to come before halfway round the route; after that the drone is committed, because finishing the loop is the quickest way home. The panel also has:
  - an energy gauge (used, forecast and P90 against the battery line);
  - a forecast chart of the total mission energy over the flight (click to scrub);
  - a **battery slider** (the usable energy for this mission, remembered between visits);
  - a hindsight line comparing the call with what the flight really used.

  The timeline shades the decision window and flags the call, and the drone's reticle and ground ring turn amber or red. Hover tests have no route, so they show "Not rated". Simulated flight 900 uses its own depleted pack (10.9 Wh) instead of the slider.
- **Poisoning lab (simulated).** Replays the same flight with the model each training-data condition would have produced, from the simulated timeline in `results/countermeasure` (seed 0). Every element is labelled SIMULATED.
  - **Training data:**
    - Clean.
    - Stale: the healthy drones' log uploads broke after window 1.
    - Low quality: accidentally damaged current sensors (hard landing, moisture, a loose connector) on a growing share of drones, reading 12% low and logging twice as often.
    - Both.
  - **Countermeasure switch:** the reference-flight audit, recalibration and trusted P90 calibration.
  - **Health rows:** what the training data really contains (age of the newest healthy-drone upload, the damaged sensors' share), and what the fix's health check reports. Without the fix it reads "Not monitored · nothing flags it".
  - **Two charts by window:** forecast error and how often the P90 really holds, for clean, poisoned and fixed.
  - **Demo buttons:** jump to flights where poisoning flips the call. In the top case, flight 268 with a 28.5 Wh battery, the poisoned model says continue while the flight really comes up 0.15 Wh short; the clean and fixed models both say it's too close to call.

  While the lab is open, the mission check, timeline and reticle all use the lab's forecast. The forecast chart adds an "actual" line, so you can see the P90 band falling below what the flight really used. Window 0 flights have no scenario (nothing earlier to train on), and the lab says so.
- **Results tab.** The left column switches between the mission check and a results scorecard. Each block is tagged with the case-prompt requirement it answers (R2–R7, with the requirement's name on hover):
  - clean baseline accuracy;
  - the four data conditions without and with the fix (error, how often the safety margin held, unsafe continue calls);
  - error by simulated window;
  - the chain from bad data to bad decisions;
  - unseen-defect tests, the main limit, and the cost.

  Opening the poisoning lab switches back to the mission check.
- **Flight panel (right).** Live telemetry: altitude above launch, ground speed, airflow from the onboard anemometer, battery voltage, current, power, and energy used so far.
- **Playback.** Play/pause, a power-draw scrubber, speed (1–16×), a map layer (Grid or Terrain) and three camera modes: Orbit, Chase and Top. It opens in Chase at 8×. In Chase, drag to swing around the drone, scroll to zoom and double-click to go back behind it; the camera stays locked on the drone.
- **Simulated flight 900.** A labelled battery-failure scenario, built by `scripts/make_sim_failure.py` from flight 142's real path. It is not CMU data: the picker, a banner, the telemetry chip and the 3D reticle all mark it, and the rotors stop when power is lost.

Keyboard: Space plays or pauses. With the scrubber focused, the arrow keys step 1 s (10 s with Shift), and Home/End jump to the start or end. The URL hash (`#flight=142`) links to a specific flight.

## Map layers

Each flight's launch latitude and longitude (`origin` in `index.json`) places it on a real map. Heights stay relative to the launch point: the ground under the launch point is y = 0.

| Layer | What it is | Needs |
|---|---|---|
| Grid | The dark grid, no map | Nothing |
| Terrain (default) | Real 3D relief from [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/), about 2.8 km square around the launch point. Here that's USGS 3DEP elevation at about 3 m resolution. Dips narrower than about 33 m (stormwater basins, road cuts, culverts in the lidar) are filled and the surface lightly smoothed, because at this mesh resolution they rendered as deep, faceted holes. It's drawn as a holographic topo map: hill shading, glowing contour lines (5 m minor, 25 m major, on true elevation), a faint 100 m grid, a scan pulse from the drone, and an edge that fades out. The path curtain and the drone's shadow sit on the terrain surface. | Nothing |

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

### Poisoning lab scenarios (simulated)

`public/data/scenarios/` holds the lab's data: `index.json` (conditions, each flight's simulated window, training-data health per window, by-window error and coverage, demo cases) plus `flights/<id>.json` (P50/P90 forecasts under every condition, with and without the fix, aligned point for point with `model/flights/<id>.json`). To rebuild them (about 2 minutes), run:

```bash
npm run scenarios
```

This runs `scripts/export_web_scenarios.py`. It retrains the hybrid model at each simulated window for each condition, exactly as `scripts/run_countermeasure.py` does with seed 0, and reads the chart values from `results/countermeasure/metrics.json` (5-seed means).

### Synthetic heavy-payload flights (operator console)

The CMU packages top out at 500 g (one flight at 750 g). To show what happens when operations move to heavier packages than the model has seen, drones 1, 3 and 5 in the operator console fly **SYNTHETIC** flights: real window-7 flights (97, 184, 126) re-run at 1.0–1.2 kg, which is within the Matrice 100's 3.6 kg take-off limit. While the motors run, the battery current is multiplied by `((2355 + new payload) / (2355 + recorded payload)) ^ b`. The exponent `b` (about 0.95) is fitted on the real 0–500 g flights, comparing flights flown at the same speed, altitude and route, and is checked on the real 750 g flight, which the fit never saw: scaled flights land within +1% to +10% of its energy. Route, speed, altitude, wind and timing stay as recorded. Each flight's battery comes from a stated rule on the launch forecasts, recorded in the output. The console labels these drones as synthetic everywhere they appear.

`public/data/synthetic.json` describes each flight, the scaling fit and its check. The flights' series, forecasts and scenario runs sit next to the real ones under ids 1001–1003. To rebuild them (about 25 s), run:

```bash
npm run synthetic
```

The console's countermeasure adds a **range guard** for any payload heavier than the heaviest one in the fixed model's training data (750 g). A tree model can't forecast past what it has seen, so the guard scales its forecast up from 750 g to the real payload with the same fitted weight-to-power rule. It also sends close calls to a person. Before takeoff, this turns the heavy drones' launch check into "Not enough battery". Because the synthetic flights were built with that same rule, the correction isn't independent evidence on them; it still comes out 2–4 Wh low. The Results tab experiments don't include the guard.

### Results scorecard

`public/data/results.json` holds the headline numbers for the Results tab, copied (not recomputed) from `results/baseline/metrics.json` and `results/countermeasure/metrics.json`. After rerunning those experiments, refresh it with:

```bash
npm run results
```

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

The production build is about 350 KB of gzipped JS. three.js is split into its own long-cached chunk. Each flight file is about 85 KB, or about 27 KB compressed, and loads on demand.

## Look

Graphite panels with an ultraviolet accent, after a tactical drone-ops dashboard. Colours are CSS tokens at the top of `src/styles.css` (`--accent`, `--go`, `--warn`, `--stop`, `--ramp`), mirrored for the 3D scene in `src/scene/palette.ts`. Headings use Orbitron (uppercase, wide tracking); numbers and body text use Geist.

## Code map

| Path | What it does |
|---|---|
| `src/store.ts` | App state (Zustand) and the playback clock. Time lives outside React so the 3D scene can advance every frame without re-rendering. |
| `src/data.ts` | Fetching, caching and time interpolation helpers. |
| `src/mission.ts` | The mission check: on track / turn back / too close, the halfway deadline, and the hindsight outcome. Pure functions shared by the panel, the timeline and the 3D reticle. |
| `src/scene/` | `Scene` (lights, ground, camera modes), `Terrain` (elevation tiles to topo mesh and shader, with narrow pits filled), `Stars`, `FlightPath` (ribbon and curtain), `Drone` (model and reticle), `palette` (colours shared with CSS). |
| `src/ui/` | `TopBar`, `Mission` (mission check panel), `Lab` (poisoning lab), `useMission` (shared hook), `Telemetry`, `Dock` (playback). |
