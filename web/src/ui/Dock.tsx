import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { powerRange } from "../scene/palette";
import { useStore } from "../store";
import type { Basemap, CameraMode } from "../types";
import { fmtClock } from "./format";
import { Icons } from "./icons";
import { useMission } from "./useMission";

const RATES = [1, 2, 4, 8, 16];
const H = 56;
const CAMERAS: { id: CameraMode; label: string; icon: React.ReactNode }[] = [
  { id: "orbit", label: "Orbit", icon: Icons.orbit },
  { id: "chase", label: "Chase", icon: Icons.chase },
  { id: "top", label: "Top", icon: Icons.top },
];

const BASEMAPS: { id: Basemap; label: string; icon: React.ReactNode }[] = [
  { id: "grid", label: "Grid", icon: Icons.grid },
  { id: "terrain", label: "Terrain", icon: Icons.terrain },
];

/** Playback controls with a power-draw scrubber and camera modes. */
export function Dock() {
  const series = useStore((s) => s.series);
  const uiTime = useStore((s) => s.uiTime);
  const playing = useStore((s) => s.playing);
  const rate = useStore((s) => s.rate);
  const camera = useStore((s) => s.camera);
  const basemap = useStore((s) => s.basemap);
  const { seek, setPlaying, setRate, setCamera, setBasemap } = useStore.getState();
  const { forecast, call, deadlineT } = useMission();

  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(e.contentRect.width, 120)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const end = series ? series.t[series.t.length - 1] : 1;
  const chart = useMemo(() => {
    if (!series) return null;
    const { t, power, up } = series;
    const [, hi] = powerRange(power, up);
    const top = Math.max(hi * 1.15, 1);
    const step = Math.max(1, Math.floor(t.length / 400));
    let d = `M0,${H}`;
    for (let i = 0; i < t.length; i += step) d += `L${((t[i] / end) * width).toFixed(1)},${(H - (Math.max(power[i], 0) / top) * (H - 6)).toFixed(1)}`;
    return `${d}L${width},${H}Z`;
  }, [series, width, end]);

  const scrubbing = useRef(false);
  const seekFromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * end);
  };
  const onKey = (e: KeyboardEvent) => {
    const s = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight") seek(uiTime + s);
    else if (e.key === "ArrowLeft") seek(uiTime - s);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(end);
    else return;
    e.preventDefault();
  };
  const playX = (uiTime / end) * width;
  const tx = (s: number) => (s / end) * width;
  const callColor = call?.type === "return" ? "var(--stop)" : "var(--warn)";

  return (
    <section className="dock glass" aria-label="Playback">
      <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"} disabled={!series}>
        {playing ? (
          <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden><path d="M4.5 2.2l9.5 5.8-9.5 5.8z" /></svg>
        )}
      </button>

      <div className="clock num">
        {fmtClock(uiTime)}
        <span className="muted"> / {fmtClock(end)}</span>
      </div>

      <div className="scrub" ref={wrap}>
        <span className="scrub-label">Power draw</span>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          preserveAspectRatio="none"
          role="slider"
          tabIndex={0}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(end)}
          aria-valuenow={Math.round(uiTime)}
          aria-valuetext={`${fmtClock(uiTime)} of ${fmtClock(end)}`}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            scrubbing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e);
          }}
          onPointerMove={(e) => scrubbing.current && seekFromPointer(e)}
          onPointerUp={() => (scrubbing.current = false)}
        >
          <defs>
            <linearGradient id="powerfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ff5c8a" stopOpacity="0.85" />
              <stop offset="0.5" stopColor="#b45cff" stopOpacity="0.45" />
              <stop offset="1" stopColor="#5b6cff" stopOpacity="0.1" />
            </linearGradient>
            <clipPath id="flown">
              <rect width={playX} height={H} />
            </clipPath>
          </defs>
          {forecast && deadlineT !== null && (
            <g aria-hidden>
              <rect x={tx(forecast.tOn)} width={Math.max(tx(deadlineT) - tx(forecast.tOn), 0)} y={0} height={H} className="scrub-window" />
              <line x1={tx(deadlineT)} x2={tx(deadlineT)} y1={0} y2={H} className="scrub-deadline">
                <title>Halfway: the last moment a turn-back call helps</title>
              </line>
            </g>
          )}
          {chart && <path d={chart} fill="rgba(255,255,255,0.07)" />}
          {chart && <path d={chart} fill="url(#powerfill)" clipPath="url(#flown)" />}
          {call && call.type !== "continue" && uiTime >= call.t && (
            <circle cx={tx(call.t)} cy={H - 7} r={4.5} fill={callColor} className="scrub-call">
              <title>{call.type === "return" ? "Turn back" : "Operator review"} called at {fmtClock(call.t)}</title>
            </circle>
          )}
          <line x1={playX} x2={playX} y1={0} y2={H} className="playhead" />
          <circle cx={playX} cy={4} r={4} className="playhead-knob" />
        </svg>
      </div>

      <label className="rate">
        <span className="visually-hidden">Playback speed</span>
        <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
          {RATES.map((r) => (
            <option key={r} value={r}>{r}×</option>
          ))}
        </select>
      </label>

      <div className="cams" role="group" aria-label="Map layer">
        {BASEMAPS.map((b) => (
          <button
            key={b.id}
            aria-pressed={basemap === b.id}
            onClick={() => setBasemap(b.id)}
            title={`${b.label} map`}
          >
            {b.icon}
            <span>{b.label}</span>
          </button>
        ))}
      </div>

      <div className="cams" role="group" aria-label="Camera">
        {CAMERAS.map((c) => (
          <button key={c.id} aria-pressed={camera === c.id} onClick={() => setCamera(c.id)} title={`${c.label} camera`}>
            {c.icon}
            <span>{c.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
