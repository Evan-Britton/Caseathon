import { useMemo } from "react";
import { useStore } from "../store";
import type { FlightMeta } from "../types";
import { fmtAltitude, fmtClock, fmtDate, fmtNum } from "./format";
import { Icons } from "./icons";

export function TopBar() {
  const index = useStore((s) => s.index);
  const meta = useStore((s) => s.meta);
  const { selectFlight, stepFlight } = useStore.getState();

  const byDate = useMemo(() => {
    const out = new Map<string, FlightMeta[]>();
    for (const f of index?.flights ?? []) out.set(f.date, [...(out.get(f.date) ?? []), f]);
    return [...out.entries()];
  }, [index]);

  return (
    <header className="topbar">
      <div className="brand glass">
        <span className="brand-mark">{Icons.drone}</span>
        <span className="brand-name">Flight replay</span>
      </div>

      <div className="picker glass">
        <button onClick={() => stepFlight(-1)} aria-label="Previous flight">{Icons.prev}</button>
        <label>
          <span className="visually-hidden">Flight</span>
          <select value={meta?.id ?? ""} onChange={(e) => selectFlight(Number(e.target.value))}>
            {byDate.map(([date, list]) => (
              <optgroup key={date} label={fmtDate(date)}>
                {list.map((f) => (
                  <option key={f.id} value={f.id}>
                    Flight {f.id}
                    {f.route === "H" ? ", hover test" : `, ${f.speed} m/s, ${f.payload} g, ${fmtAltitude(f.altitude)}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <button onClick={() => stepFlight(1)} aria-label="Next flight">{Icons.next}</button>
      </div>

      {meta && (
        <dl className="chips">
          {meta.route !== "H" && <Chip icon={Icons.speed} label="Cruise" value={`${meta.speed} m/s`} />}
          <Chip icon={Icons.box} label="Payload" value={`${meta.payload} g`} />
          <Chip icon={Icons.altitude} label="Altitude" value={fmtAltitude(meta.altitude)} />
          <Chip icon={Icons.clock} label="Duration" value={fmtClock(meta.durationS)} />
          <Chip icon={Icons.bolt} label="Energy" value={`${fmtNum(meta.energyWh)} Wh`} />
          <Chip icon={Icons.calendar} label="Flown" value={`${fmtDate(meta.date)}, ${meta.time}`} />
        </dl>
      )}
    </header>
  );
}

function Chip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="chip glass">
      {icon}
      <dt className="visually-hidden">{label}</dt>
      <dd title={label}>{value}</dd>
    </div>
  );
}
