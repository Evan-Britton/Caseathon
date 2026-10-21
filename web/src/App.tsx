import { useEffect } from "react";
import { useFleet } from "./fleetStore";
import { powerRange } from "./scene/palette";
import { reticle } from "./scene/Drone";
import { Scene } from "./scene/Scene";
import { useStore } from "./store";
import { Dock } from "./ui/Dock";
import { Fleet } from "./ui/Fleet";
import { FleetTags } from "./ui/FleetTags";
import { Lab } from "./ui/Lab";
import { Mission } from "./ui/Mission";
import { Results } from "./ui/Results";
import { RouteMap } from "./ui/RouteMap";
import { Telemetry } from "./ui/Telemetry";
import { TopBar } from "./ui/TopBar";
import { fmtNum } from "./ui/format";

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

  const fleetOpen = useFleet((s) => s.open);
  return (
    <div className={`hud ${fleetOpen ? "fleet-on" : ""}`}>
      <main className="scene">
        <Scene />
        <div className="reticle-anchor" ref={(el) => void (reticle.el = el)} aria-hidden>
          <div className="reticle">
            <i /><i /><i /><i />
            <span className="reticle-label" ref={(el) => void (reticle.label = el)} />
          </div>
        </div>
        <FleetTags />
        <PowerLegend />
        <StageMessage />
        <Caution />
      </main>
      <TopBar />
      <LeftColumn />
      <Lab />
      <Fleet />
      <section className="flight-panel glass" aria-label="Flight">
        <Telemetry />
        <RouteMap />
      </section>
      <Dock />
      <Attribution />
    </div>
  );
}

/** Mission check or the results scorecard, switched by tabs so each gets the full column. */
function LeftColumn() {
  const tab = useStore((s) => s.leftTab);
  const hasResults = useStore((s) => !!s.results);
  const setLeftTab = useStore((s) => s.setLeftTab);
  const tabs = [
    ["mission", "Mission check"],
    ["results", "Results"],
  ] as const;
  return (
    <div className="left-stack">
      {hasResults && (
        <div className="left-tabs glass" role="tablist" aria-label="Left panel">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls="left-panel" onClick={() => setLeftTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div id="left-panel" role={hasResults ? "tabpanel" : undefined} aria-labelledby={hasResults ? `tab-${tab}` : undefined} className="left-panel">
        {tab === "results" && hasResults ? <Results /> : <Mission />}
      </div>
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

/** Simulated power loss: master caution lamp and a pulsing red edge from the cutoff onwards. */
function Caution() {
  const meta = useStore((s) => s.meta);
  const uiTime = useStore((s) => s.uiTime);
  if (!meta?.simulated || meta.failureS === undefined || uiTime < meta.failureS) return null;
  return (
    <>
      <div className="caution-edge" aria-hidden />
      <div className="caution" role="alert">
        <span className="caution-lamp">Master caution</span>
        <span>Battery cutoff, power lost at {fmtNum(meta.failureAltM ?? 0, 0)} m. Simulated.</span>
      </div>
    </>
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
