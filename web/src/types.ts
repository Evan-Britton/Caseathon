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
