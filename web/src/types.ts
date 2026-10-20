export interface FlightMeta {
  id: number;
  route: string;
  speed: number; // planned cruise ground speed, m/s
  payload: number; // g
  altitude: string; // planned cruise altitude, m (two R7 flights use a profile like "25-50-100-25")
  date: string;
  time: string;
  durationS: number;
  energyWh: number;
  pathM: number;
  maxUpM: number;
  maxGapS: number;
  startVoltage: number;
  origin: { lat: number; lon: number; altM: number }; // launch point (deg, deg, m above sea level)
  /** Set only on flights we generated. Everything else is CMU data. */
  simulated?: boolean;
  outcome?: string;
  failureS?: number; // s into the flight when power is lost
  failureAltM?: number; // m above launch when power is lost
}

/** Columnar time series for one flight, one entry per sample (~5-8 Hz). */
export interface FlightSeries {
  t: number[]; // s since first sample
  east: number[]; // m from launch
  north: number[]; // m from launch
  up: number[]; // m above launch
  heading: number[]; // deg clockwise from true north
  voltage: number[]; // V
  current: number[]; // A
  power: number[]; // W
  energyWh: number[]; // cumulative, Wh
  dist: number[]; // cumulative horizontal path length, m
  groundSpeed: number[]; // m/s
  windSpeed: number[]; // m/s, onboard anemometer
  windAngle: number[]; // deg
}

export interface DataSource {
  title: string;
  authors: string;
  doi: string;
  url: string;
  license: string;
  note: string;
}

export interface DataIndex {
  source: DataSource;
  flights: FlightMeta[];
}

export type CameraMode = "orbit" | "chase" | "top";

/** What the left column shows: the live mission check or the experiment results. */
export type LeftTab = "mission" | "results";

/** Ground layer: dark grid, or 3D terrain from elevation tiles. */
export type Basemap = "grid" | "terrain";

/** Ground height (m, relative to the launch point) at a world position (x east, z south, in m). */
export type GroundSampler = (x: number, z: number) => number;

/** The energy model's out-of-sample forecast for one flight, once per second of flight. */
export interface FlightForecast {
  group: number; // cross-validation group: this flight was not in the model's training data
  tOn: number; // s, rotors start
  tOff: number; // s, rotors stop (or power is lost on a simulated failure)
  totalWh: number; // energy the mission actually used (hindsight only, never shown as a forecast)
  t: number[]; // s since first sample, same clock as FlightSeries.t
  used: number[]; // Wh used so far (Coulomb counting)
  e50: number[]; // Wh still needed before landing, median forecast
  e90: number[]; // Wh still needed before landing, P90 (the safety margin)
  frac: number[]; // share of the planned route flown
}

export interface ModelIndex {
  model: string;
  validation: string;
  metrics: { maeWh: number; biasWh: number; p90Coverage: number; checkpoints: number };
  deadlineFrac: number; // a turn-back call only helps before this share of the route
  packWh: number;
  budget: { default: number; min: number; max: number; step: number };
  flights: number[]; // flights with a forecast
  simulated: Record<string, { basedOn: number; budgetWh: number; note: string }>;
}

/** One condition with or without the fix (scripts/export_web_results.py, from results/countermeasure). */
export interface ResultCell {
  maeWh: number; // mean absolute error of the energy-still-needed forecast
  biasWh: number; // mean signed error; negative means it under-forecasts the energy needed
  p90: number; // share of checkpoints where the P90 safety margin really covered the need
  unsafe: number; // continue calls on flights that should have turned back (summed over budgets, seed mean)
  aborts: number; // needless turn-backs
  deferred: number; // calls sent to the operator
}

export interface ResultRow {
  key: string;
  label: string;
  off: ResultCell;
  on: ResultCell;
}

/** Headline experiment results for the scorecard. Degradation rows are on a SIMULATED timeline. */
export interface ResultsSummary {
  simulated: string;
  baseline: {
    flights: number;
    checkpoints: number;
    split: string;
    models: Record<"physics_only" | "direct_ml" | "hybrid", { maeWh: number; p90: number }>;
  };
  windows: number[]; // simulated windows the grid averages over
  seeds: number;
  decisions: { total: number; shouldReturn: number };
  grid: ResultRow[];
  overTime: { windows: number[]; maeOff: number[]; maeOn: number[]; p90Off: number[]; p90On: number[] };
  unseen: ResultRow[];
  failure: ResultRow;
  cost: string;
}

/** SIMULATED data-poisoning scenarios (scripts/export_web_scenarios.py). */
export type ScenarioCondition = "reference" | "stale" | "low_quality" | "combined";

export interface ScenarioHealth {
  trainFlights: number;
  trainRecords: number;
  cheapFeedShare: number; // share of training records from the biased cheap feed
  newestAccurateWindow: number | null;
  newestAutoUploadWindow: number | null;
  uploadAgeWindows: number; // windows since the accurate logger's automatic upload last arrived
  status: "unmonitored" | "green" | "amber" | "red"; // "unmonitored" = no fix, nothing checks the data
  referenceFlights?: number;
  recalibratedRecords?: number;
  unverifiedRecords?: number;
  auditedWindows?: number;
  estimatedFeedRatio?: number | null;
}

export interface ScenarioDemo {
  flight: number;
  condition: ScenarioCondition;
  budgetWh: number;
  window: number;
  totalWh: number;
  shortWh: number;
  claimedSpareWh: number;
  cleanCall: string;
  fixedCall: string;
  payload: number;
  speed: number;
}

export interface ScenarioIndex {
  simulated: boolean;
  note: string;
  conditions: Record<ScenarioCondition, { label: string; desc: string }>;
  windows: number;
  staleAfter: number;
  feed: { currentFactor: number; recordsPerAccurate: number };
  flightWindow: Record<string, number>;
  windowMix: Record<string, Record<string, number>>;
  health: Record<string, ScenarioHealth>; // key: "<condition>/<on|off>/<window>"
  chart: Record<string, { maeWh: number[]; p90Coverage: number[] }>; // key: "<condition>/<on|off>", windows 1..N-1
  demos: ScenarioDemo[];
  flights: number[];
}

/** One flight's forecasts under every condition, aligned point for point with its FlightForecast. */
export interface FlightScenarios {
  window: number;
  n: number;
  runs: Record<string, { e50: number[]; e90: number[] }>; // key: "<condition>/<on|off>"
}

export interface LabState {
  on: boolean;
  condition: ScenarioCondition;
  fix: boolean;
}
