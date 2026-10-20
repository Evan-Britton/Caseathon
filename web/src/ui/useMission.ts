import { useMemo } from "react";
import { deadlineTime, missionCall, missionState } from "../mission";
import { activeForecast, budgetFor, useStore } from "../store";

/** Everything the mission-check UI needs, at the current playback time. */
export function useMission() {
  // The standard model's forecast, or the chosen condition's in the poisoning lab.
  const forecast = useStore(activeForecast);
  const lab = useStore((s) => s.lab);
  const scenarios = useStore((s) => s.scenarios);
  const scenarioIndex = useStore((s) => s.scenarioIndex);
  const labActive = lab.on && forecast !== null && scenarios !== null;
  const meta = useStore((s) => s.meta);
  const model = useStore((s) => s.model);
  const budgetWh = useStore((s) => s.budgetWh);
  const uiTime = useStore((s) => s.uiTime);

  const budget = budgetFor(model, meta, budgetWh);
  const deadline = model?.deadlineFrac ?? 0.5;
  const call = useMemo(() => (forecast ? missionCall(forecast, budget, deadline) : null), [forecast, budget, deadline]);
  const deadlineT = useMemo(() => (forecast ? deadlineTime(forecast, deadline) : null), [forecast, deadline]);
  const state = missionState(forecast, meta, budget, deadline, uiTime);
  const sim = meta ? model?.simulated[String(meta.id)] ?? null : null;

  return { forecast, meta, model, budget, deadline, call, deadlineT, state, sim, uiTime, lab, labActive, scenarios, scenarioIndex };
}
