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
