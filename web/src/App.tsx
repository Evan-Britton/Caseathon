import { useEffect } from "react";
import { powerRange } from "./scene/palette";
import { reticle } from "./scene/Drone";
import { Scene } from "./scene/Scene";
import { useStore } from "./store";
import { Dock } from "./ui/Dock";
import { Lab } from "./ui/Lab";
import { Mission } from "./ui/Mission";
import { RouteMap } from "./ui/RouteMap";
import { Telemetry } from "./ui/Telemetry";
import { TopBar } from "./ui/TopBar";

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
    <div className="hud">
      <main className="scene">
        <Scene />
        <div className="reticle-anchor" ref={(el) => void (reticle.el = el)} aria-hidden>
          <div className="reticle">
            <i /><i /><i /><i />
            <span className="reticle-label" ref={(el) => void (reticle.label = el)} />
          </div>
        </div>
        <PowerLegend />
        <StageMessage />
      </main>
      <TopBar />
      <div className="left-stack">
        <Mission />
        <Telemetry />
      </div>
      <Lab />
      <RouteMap />
      <Dock />
      <Attribution />
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
      <div className="ramp-ends num">
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

function Attribution() {
  const source = useStore((s) => s.index?.source);
  const basemap = useStore((s) => s.basemap);
  const mapCredits = useStore((s) => s.mapCredits);
  if (!source) return null;
  return (
    <p className="attribution">
      Data: <a href={source.url} target="_blank" rel="noreferrer">{source.authors}</a>, {source.license}
      {basemap === "terrain" && mapCredits && (
        <>
          {" "}<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">{mapCredits}</a>
        </>
      )}
    </p>
  );
}
