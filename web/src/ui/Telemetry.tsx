import { lerpAt, sampleAt } from "../data";
import { useStore } from "../store";
import { fmtNum } from "./format";

export function Telemetry() {
  const series = useStore((s) => s.series);
  const meta = useStore((s) => s.meta);
  const uiTime = useStore((s) => s.uiTime);
  if (!series || !meta) return null;

  const { i, f } = sampleAt(series.t, uiTime);
  const at = (arr: number[]) => lerpAt(arr, i, f);
  const up = Math.max(at(series.up), 0);
  const airborne = up > 0.5;
  const powerLost = !!meta.simulated && uiTime >= (meta.failureS ?? Infinity);
  const used = at(series.energyWh);
  const total = series.energyWh[series.energyWh.length - 1];

  return (
    <section className="telemetry glass" aria-label="Telemetry">
      <div className="panel-head">
        <h2>DJI Matrice 100</h2>
        <span className={`state ${powerLost ? "state-fail" : airborne ? "state-air" : "state-ground"}`}>
          {powerLost ? (airborne ? "Power lost" : "Crashed") : airborne ? "Airborne" : "On ground"}
        </span>
      </div>

      <div className="tele-body">
        <DroneGlyph spinning={airborne && !powerLost} />
        <dl className="readouts">
          <Readout label="Altitude" value={fmtNum(up)} unit="m" />
          <Readout label="Ground speed" value={fmtNum(at(series.groundSpeed))} unit="m/s" />
          <Readout label="Airflow" value={fmtNum(series.windSpeed[i])} unit="m/s" />
          <Readout label="Voltage" value={fmtNum(at(series.voltage), 2)} unit="V" />
          <Readout label="Current" value={fmtNum(at(series.current))} unit="A" />
          <Readout label="Power" value={fmtNum(at(series.power), 0)} unit="W" />
        </dl>
      </div>

      <div className="energy">
        <div className="energy-label">
          <span>Energy used</span>
          <span className="num">
            {fmtNum(used)} <span className="muted">of {fmtNum(total)} Wh</span>
          </span>
        </div>
        <div className="energy-track">
          <div className="energy-fill" style={{ width: `${Math.min((used / Math.max(total, 0.01)) * 100, 100)}%` }} />
        </div>
      </div>
    </section>
  );
}

function Readout({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className="num">{value}</span> <span className="unit">{unit}</span>
      </dd>
    </div>
  );
}

/** Top-down quadcopter with aviation nav colours: port red, starboard green, rear white. */
function DroneGlyph({ spinning }: { spinning: boolean }) {
  const rotors: [number, number, string][] = [
    [22, 22, "#ff4d4d"],
    [78, 22, "#5cff9a"],
    [22, 78, "#f5f7fa"],
    [78, 78, "#f5f7fa"],
  ];
  return (
    <svg viewBox="0 0 100 100" className={`glyph ${spinning ? "spin" : ""}`} aria-hidden>
      <path d="M22 22L78 78M78 22L22 78" stroke="#6b7684" strokeWidth={5} strokeLinecap="round" />
      {rotors.map(([x, y, c]) => (
        <g key={`${x}${y}`}>
          <circle cx={x} cy={y} r={17} fill="none" stroke={c} strokeOpacity={0.55} strokeWidth={1.5} />
          <g className="prop" style={{ transformOrigin: `${x}px ${y}px` }}>
            <path d={`M${x - 14} ${y}H${x + 14}`} stroke="#cfd8e0" strokeOpacity={0.7} strokeWidth={2.5} strokeLinecap="round" />
          </g>
          <circle cx={x} cy={y} r={3.5} fill={c} />
        </g>
      ))}
      <rect x={38} y={36} width={24} height={28} rx={6} fill="#2a333d" stroke="#8a95a3" strokeWidth={1.5} />
      <path d="M50 30l5 6h-10z" fill="#f2a33a" />
    </svg>
  );
}
