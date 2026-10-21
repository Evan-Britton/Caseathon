import { useFleet } from "../fleetStore";
import { HUB_NAME } from "../fleet";
import { fleetTags, routeLabels } from "../scene/FleetScene";

/** Floating name tags for the five drones. The 3D scene moves them every frame. */
export function FleetTags() {
  const on = useFleet((s) => s.open && !!s.loaded);
  const loaded = useFleet((s) => s.loaded);
  const n = loaded?.length ?? 0;
  if (!on) return null;
  return (
    <div className="fleet-tags" aria-hidden>
      <div className="fleet-place hub" ref={(el) => void (routeLabels[0] = el)}>{HUB_NAME}</div>
      {loaded?.map((d, i) => (
        <div key={d.slot.flight} className="fleet-place" ref={(el) => void (routeLabels[i + 1] = el)}>{d.slot.destination}</div>
      ))}
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="fleet-tag" ref={(el) => void (fleetTags[i] = el)} />
      ))}
    </div>
  );
}
