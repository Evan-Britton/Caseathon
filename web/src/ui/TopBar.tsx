import { useMemo } from "react";
import { useStore } from "../store";
import type { FlightMeta } from "../types";
import { fmtAltitude, fmtClock, fmtDate, fmtNum } from "./format";
import { FleetButton } from "./Fleet";
import { Icons } from "./icons";
import { heavyDemos } from "./Lab";

export function TopBar() {
  const index = useStore((s) => s.index);
  const meta = useStore((s) => s.meta);
  const scenarioIndex = useStore((s) => s.scenarioIndex);
  const demoIds = useMemo(() => new Set(heavyDemos(scenarioIndex).map((d) => d.flight)), [scenarioIndex]);
  const { selectFlight, stepFlight } = useStore.getState();

  const byDate = useMemo(() => {
    const out = new Map<string, FlightMeta[]>();
    for (const f of index?.flights ?? []) {
      const key = f.simulated ? "simulated" : f.date;
      out.set(key, [...(out.get(key) ?? []), f]);
    }
    return [...out.entries()];
  }, [index]);

  return (
    <header className="topbar">
      <div className="picker glass">
        <button onClick={() => stepFlight(-1)} aria-label="Previous flight">{Icons.prev}</button>
        <label>
          <span className="visually-hidden">Flight</span>
          <select value={meta?.id ?? ""} onChange={(e) => selectFlight(Number(e.target.value))}>
            {byDate.map(([date, list]) => (
              <optgroup key={date} label={date === "simulated" ? "Simulated scenarios" : fmtDate(date)}>
                {list.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.simulated ? `Simulated ${f.id}, battery failure` : `Flight ${f.id}`}
                    {f.simulated ? null : f.route === "H" ? ", hover test" : `, ${f.speed} m/s, ${f.payload} g, ${fmtAltitude(f.altitude)}`}
                    {demoIds.has(f.id) && " · heavy-payload demo"}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <button onClick={() => stepFlight(1)} aria-label="Next flight">{Icons.next}</button>
      </div>
      <FleetButton />

      {meta?.simulated && (
        <div className="sim-banner glass" role="status">
          <strong>Simulated, not CMU data.</strong> {meta.outcome} at {fmtClock(meta.failureS ?? 0)}, {fmtNum(meta.failureAltM ?? 0, 0)} m up.
        </div>
      )}

    </header>
  );
}
