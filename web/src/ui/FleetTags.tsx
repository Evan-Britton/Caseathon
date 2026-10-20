import { useFleet } from "../fleetStore";
import { fleetTags } from "../scene/FleetScene";

/** Floating name tags for the five drones. The 3D scene moves them every frame. */
export function FleetTags() {
  const on = useFleet((s) => s.open && !!s.loaded);
  const n = useFleet((s) => s.loaded?.length ?? 0);
  if (!on) return null;
  return (
    <div className="fleet-tags" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="fleet-tag" ref={(el) => void (fleetTags[i] = el)} />
      ))}
    </div>
  );
}
