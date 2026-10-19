import { useMemo } from "react";
import { lerpAt, sampleAt } from "../data";
import { powerCss, powerRange } from "../scene/palette";
import { useStore } from "../store";
import type { FlightMeta } from "../types";
import { fmtAltitude, fmtClock, fmtDate, fmtNum } from "./format";
import { Icons } from "./icons";
import { useMission } from "./useMission";

const W = 268;
const H = 190;
const PAD = 16;
const PROFILE_H = 54;

/** Top-down route (north up) plus an altitude profile over time. */
export function RouteMap() {
  const series = useStore((s) => s.series);
  const meta = useStore((s) => s.meta);
  const uiTime = useStore((s) => s.uiTime);
  const { call, deadlineT } = useMission();

  const geo = useMemo(() => {
    if (!series) return null;
    const { east, north, up, t, power } = series;
    const minE = Math.min(...east), maxE = Math.max(...east);
    const minN = Math.min(...north), maxN = Math.max(...north);
    const span = Math.max(maxE - minE, maxN - minN, 40);
    const k = (Math.min(W, H) - PAD * 2) / span;
    const ox = (W - (maxE - minE) * k) / 2;
    const oy = (H - (maxN - minN) * k) / 2;
    const px = (e: number) => ox + (e - minE) * k;
    const py = (n: number) => H - oy - (n - minN) * k;

    const [lo, hi] = powerRange(power, up);
    const step = Math.max(1, Math.floor(t.length / 240));
    const segs: { d: string; c: string; t: number }[] = [];
    for (let i = 0; i + step < t.length; i += step) {
      const j = i + step;
      segs.push({ d: `M${px(east[i]).toFixed(1)},${py(north[i]).toFixed(1)}L${px(east[j]).toFixed(1)},${py(north[j]).toFixed(1)}`, c: powerCss(power[i], lo, hi), t: t[i] });
    }

    const nice = [10, 20, 25, 50, 100, 200].find((m) => m * k >= 50) ?? 200;
    const end = t[t.length - 1];
    const maxUp = Math.max(...up, 1);
    let profile = `M0,${PROFILE_H}`;
    for (let i = 0; i < t.length; i += step) profile += `L${((t[i] / end) * W).toFixed(1)},${(PROFILE_H - (Math.max(up[i], 0) / maxUp) * (PROFILE_H - 8)).toFixed(1)}`;
    profile += `L${W},${PROFILE_H}Z`;

    return { px, py, segs, scaleM: nice, scalePx: nice * k, end, maxUp, profile, launch: [px(0), py(0)] as const };
  }, [series]);

  if (!series || !geo) return null;
  const at = (time: number): [number, number] => {
    const s = sampleAt(series.t, time);
    return [geo.px(lerpAt(series.east, s.i, s.f)), geo.py(lerpAt(series.north, s.i, s.f))];
  };
  const half = deadlineT !== null ? at(deadlineT) : null;
  const callPt = call && call.type !== "continue" && uiTime >= call.t ? at(call.t) : null;
  const { i, f } = sampleAt(series.t, uiTime);
  const dx = geo.px(lerpAt(series.east, i, f));
  const dy = geo.py(lerpAt(series.north, i, f));
  const heading = series.heading[i];
  const playX = (uiTime / geo.end) * W;

  return (
    <section className="route-map glass" aria-label="Route map">
      <div className="panel-head">
        <h2>Route</h2>
        <span className="muted">Top view, north up</span>
      </div>
      {meta && <FlightSpecs meta={meta} />}
      <svg viewBox={`0 0 ${W} ${H}`} className="map">
        <defs>
          <pattern id="mapgrid" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M16 0H0V16" fill="none" stroke="rgba(255,255,255,0.05)" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#mapgrid)" />
        {geo.segs.map((s, k) => (
          <path key={k} d={s.d} stroke={s.c} strokeWidth={2.4} strokeLinecap="round" opacity={s.t <= uiTime ? 1 : 0.22} />
        ))}
        <circle cx={geo.launch[0]} cy={geo.launch[1]} r={5} className="map-launch" />
        {half && (
          <g transform={`translate(${half[0]},${half[1]})`}>
            <title>Halfway: after this, finishing the loop is the quickest way home</title>
            <rect x={-7} y={-7} width={14} height={14} rx={3} transform="rotate(45)" className="map-half" />
            <text y={3} textAnchor="middle" className="map-half-text">½</text>
          </g>
        )}
        {callPt && (
          <circle cx={callPt[0]} cy={callPt[1]} r={5} fill={call?.type === "return" ? "var(--stop)" : "var(--warn)"} className="map-call">
            <title>{call?.type === "return" ? "Turn-back" : "Operator review"} called here</title>
          </circle>
        )}
        <g transform={`translate(${dx},${dy}) rotate(${heading})`}>
          <circle r={9} className="map-drone-halo" />
          <path d="M0,-7 L5,5 L0,2.5 L-5,5 Z" className="map-drone" />
        </g>
        <g transform={`translate(${W - 22},22)`} className="map-north">
          <path d="M0,-9 L5,5 L0,2 L-5,5 Z" />
          <text y={17} textAnchor="middle">N</text>
        </g>
        <g transform={`translate(${PAD},${PAD + 4})`} className="map-scale">
          <path d={`M0,-4V0H${geo.scalePx}V-4`} />
          <text x={geo.scalePx + 6} y={1}>{geo.scaleM} m</text>
        </g>
      </svg>

      <div className="panel-head sub">
        <h3>Altitude</h3>
        <span className="num">{Math.max(lerpAt(series.up, i, f), 0).toFixed(0)} m <span className="muted">of {geo.maxUp.toFixed(0)} m</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${PROFILE_H}`} className="profile" preserveAspectRatio="none">
        <defs>
          <linearGradient id="altfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9a8cff" stopOpacity="0.45" />
            <stop offset="1" stopColor="#9a8cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.profile} fill="url(#altfill)" stroke="#9a8cff" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        <line x1={playX} x2={playX} y1={0} y2={PROFILE_H} className="playhead" vectorEffect="non-scaling-stroke" />
      </svg>
    </section>
  );
}

/** The flight's plan and totals as a compact 3 x 2 grid. */
function FlightSpecs({ meta }: { meta: FlightMeta }) {
  const specs: [React.ReactNode, string, string, string?][] = [
    [Icons.speed, "Cruise", meta.route === "H" ? "Hover" : `${meta.speed} m/s`],
    [Icons.box, "Payload", `${meta.payload} g`],
    [Icons.altitude, "Altitude", fmtAltitude(meta.altitude)],
    [Icons.clock, "Duration", fmtClock(meta.durationS)],
    [Icons.bolt, "Energy", `${fmtNum(meta.energyWh)} Wh`],
    meta.simulated
      ? [Icons.calendar, "Source", "Simulated"]
      : [Icons.calendar, "Flown", fmtDate(meta.date), `${fmtDate(meta.date)}, ${meta.time}`],
  ];
  return (
    <dl className="specs">
      {specs.map(([icon, label, value, title]) => (
        <div key={label} title={title}>
          <dt>{icon}{label}</dt>
          <dd className="num">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
