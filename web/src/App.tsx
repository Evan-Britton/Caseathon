import { useEffect } from "react";
import { powerRange } from "./scene/palette";
import { Scene } from "./scene/Scene";
import { useStore } from "./store";
import type { CameraMode } from "./types";
import { Console } from "./ui/Console";
import { FlightList } from "./ui/FlightList";
import { fmtAltitude, fmtClock, fmtDate, fmtNum } from "./ui/format";
import { Timeline } from "./ui/Timeline";

const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: "orbit", label: "Orbit" },
  { id: "chase", label: "Chase" },
  { id: "top", label: "Top" },
];

export default function App() {
  const init = useStore((s) => s.init);
  useEffect(() => {
    void init();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.code !== "Space" || /INPUT|SELECT|BUTTON|TEXTAREA/.test(el.tagName)) return;
      e.preventDefault();
      const st = useStore.getState();
      st.setPlaying(!st.playing);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [init]);

  return (
    <div className="app">
      <FlightList />
      <main className="stage">
        <Scene />
        <FlightTitle />
        <CameraSwitch />
        <PowerLegend />
        <StageMessage />
      </main>
      <Console />
      <Timeline />
    </div>
  );
}

function FlightTitle() {
  const meta = useStore((s) => s.meta);
  if (!meta) return null;
  const hover = meta.route === "H";
  return (
    <header className="flight-title">
      <h1>Flight {meta.id}</h1>
      <dl>
        <div><dt>Route</dt><dd>{hover ? "Hover test" : meta.route}</dd></div>
        {!hover && <div><dt>Cruise</dt><dd>{meta.speed} m/s</dd></div>}
        <div><dt>Payload</dt><dd>{meta.payload} g</dd></div>
        <div><dt>Altitude</dt><dd>{fmtAltitude(meta.altitude)}</dd></div>
        <div><dt>Flown</dt><dd>{fmtDate(meta.date)}, {meta.time}</dd></div>
        <div><dt>Length</dt><dd>{fmtClock(meta.durationS)}</dd></div>
        <div><dt>Energy</dt><dd>{fmtNum(meta.energyWh)} Wh</dd></div>
      </dl>
    </header>
  );
}

function CameraSwitch() {
  const camera = useStore((s) => s.camera);
  const setCamera = useStore((s) => s.setCamera);
  return (
    <div className="seg camera" role="group" aria-label="Camera">
      {CAMERAS.map((c) => (
        <button key={c.id} aria-pressed={camera === c.id} onClick={() => setCamera(c.id)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

function PowerLegend() {
  const series = useStore((s) => s.series);
  if (!series) return null;
  const [lo, hi] = powerRange(series.power, series.up);
  return (
    <div className="power-legend" aria-label={`Path colour shows power draw from ${Math.round(lo)} to ${Math.round(hi)} watts`}>
      <span>Path colour is power draw</span>
      <div className="ramp" />
      <div className="ramp-ends">
        <span>{Math.round(lo)} W</span>
        <span>{Math.round(hi)} W</span>
      </div>
    </div>
  );
}

function StageMessage() {
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  if (error) return <p className="stage-msg error">{error}</p>;
  if (loading) return <p className="stage-msg">Loading flight…</p>;
  return null;
}
