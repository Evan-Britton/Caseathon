import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { outcome, type MissionCall, type MissionState, type OutcomeKind } from "../mission";
import { useStore } from "../store";
import type { FlightForecast, FlightMeta } from "../types";
import { fmtClock, fmtNum } from "./format";
import { HeavyDemos, LabControls, storyLabel, storyOf } from "./Lab";
import { useMission } from "./useMission";

type Tone = "go" | "warn" | "stop" | "idle" | "fail";

interface Headline {
  tone: Tone;
  title: string;
  detail: string;
  icon: "check" | "back" | "review" | "lock" | "wait" | "off" | "bolt";
}

/** The live in-flight energy check: will this flight make it, or should it turn back? */
export function Mission() {
  const m = useMission();
  const modelError = useStore((s) => s.modelError);
  const [showHindsight, setShowHindsight] = useState(false);
  useEffect(() => setShowHindsight(false), [m.meta?.id]);

  if (!m.meta) return null;
  const dry = m.emptyS !== null && m.uiTime >= m.emptyS;
  const head = dry
    ? {
        tone: "fail" as const,
        icon: "bolt" as const,
        title: "Battery empty",
        detail: `The check cleared this mission, but the pack ran dry at ${fmtClock(m.emptyS!)}. This is a recorded flight, so it keeps its real path; the smoke marks where the battery gave out.`,
      }
    : headline(m.state, m.call, m.budget, m.deadlineT, m.uiTime, m.meta, !!m.forecast, modelError);
  const done = m.state.phase === "landed" || m.state.phase === "lost" || dry;
  const result = m.forecast && m.call ? outcome(m.forecast, m.call, m.budget) : null;

  return (
    <section className="mission glass" aria-label="Mission energy check">
      <div className="panel-head">
        <h2>Mission check</h2>
        {m.labActive && m.scenarioIndex ? (
          <span className={`ai-tag lab-tag ${m.lab.condition !== "reference" && !m.lab.fix ? "bad" : ""}`} title={m.scenarioIndex.note}>
            {(() => {
              const story = storyOf(m.lab.condition, m.lab.fix);
              return story ? storyLabel(story) : `Lab · ${m.scenarioIndex.conditions[m.lab.condition].label}${m.lab.fix ? " + fix" : ""}`;
            })()}
          </span>
        ) : (
          <span className="ai-tag" title={m.model?.model}>AI forecast</span>
        )}
      </div>

      <LabControls />

      <div className={`verdict tone-${head.tone}`} role="status" aria-live="polite">
        <VerdictIcon kind={head.icon} />
        <div className="verdict-text">
          <p className="verdict-title">{head.title}</p>
          <p className="verdict-detail">{head.detail}</p>
        </div>
      </div>

      {m.forecast && (
        <>
          <EnergyBar state={m.state} budget={m.budget} forecast={m.forecast} done={done} />
          <ForecastChart
            forecast={m.forecast}
            budget={m.budget}
            call={m.call}
            deadlineT={m.deadlineT}
            actualWh={m.labActive ? m.forecast.totalWh : null}
          />
        </>
      )}

      {m.forecast && <BudgetControl />}

      {m.forecast && result && (
        <div className="hindsight">
          {done || showHindsight ? (
            <p className={`hindsight-text out-${result.kind}`}>
              <strong>{OUTCOME_LABEL[result.kind]}</strong>{" "}
              {m.sim
                ? `The full mission takes ${fmtNum(m.forecast.totalWh)} Wh (flight ${m.sim.basedOn} flew it), ${fmtNum(-result.spareWh)} Wh more than this pack had.`
                : hindsightText(result.kind, m.forecast.totalWh, result.spareWh)}
            </p>
          ) : (
            <button className="link-btn" onClick={() => setShowHindsight(true)}>
              Show hindsight: what the flight actually used
            </button>
          )}
        </div>
      )}

      <HeavyDemos />

      {m.model && m.forecast && (
        <p className="mission-foot" title={m.model.validation}>
          Tested on flights it never saw · off by about {fmtNum(m.model.metrics.maeWh, 2)} Wh on average · safety margin held {Math.round(m.model.metrics.p90Coverage * 100)}% of the time
        </p>
      )}
    </section>
  );
}

const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  "right-return": "Right call.",
  "unsafe-continue": "Missed.",
  "needless-return": "Cautious.",
  "right-continue": "Right call.",
};

function hindsightText(kind: OutcomeKind, total: number, spare: number): string {
  const t = fmtNum(total);
  const s = fmtNum(Math.abs(spare));
  switch (kind) {
    case "right-return":
      return `The mission really used ${t} Wh, ${s} Wh more than this battery had.`;
    case "unsafe-continue":
      return `The mission really used ${t} Wh. Flown on this battery it would have run ${s} Wh short.`;
    case "needless-return":
      return `The mission really used ${t} Wh, so it would have made it with ${s} Wh to spare.`;
    case "right-continue":
      return `The mission really used ${t} Wh and landed with ${s} Wh to spare.`;
  }
}

function headline(
  st: MissionState,
  call: MissionCall | null,
  budget: number,
  deadlineT: number | null,
  t: number,
  meta: FlightMeta,
  rated: boolean,
  modelError: string | null,
): Headline {
  if (!rated) {
    if (meta.route === "H") return { tone: "idle", icon: "off", title: "Not rated", detail: "Hover test: there's no delivery route to finish." };
    return { tone: "idle", icon: "off", title: "No forecast", detail: modelError ?? "This flight has no model forecast." };
  }
  const est = st.est;
  const range = est ? `${fmtNum(est.need50)}–${fmtNum(est.need90)} Wh` : "";
  const madeAt = call ? fmtClock(call.t) : "";

  if (st.phase === "standby") return { tone: "idle", icon: "wait", title: "Waiting for takeoff", detail: "The first forecast comes 5 s after the rotors start." };

  if (st.phase === "lost") {
    if (call && call.type !== "continue")
      return {
        tone: "fail",
        icon: "bolt",
        title: "Power lost",
        detail: `The check called for a return at ${madeAt}, ${fmtNum((meta.failureS ?? 0) - call.t, 0)} s before the pack cut out.`,
      };
    return { tone: "fail", icon: "bolt", title: "Power lost", detail: "The pack cut out before the drone got home." };
  }

  const replayNote = st.phase === "landed" ? "" : " This replay keeps flying as recorded.";
  if (st.call?.type === "return")
    return {
      tone: "stop",
      icon: "back",
      title: "Turn back",
      detail: `Needs about ${fmtNum(est!.need50)} Wh, but only ${fmtNum(budget)} Wh is available. Called at ${madeAt}.${replayNote}`,
    };
  if (st.call?.type === "review")
    return {
      tone: "warn",
      icon: "review",
      title: "Too close to call",
      detail: `Forecast ${range} against ${fmtNum(budget)} Wh. Sent to the operator at ${madeAt}; scored as a return.${replayNote}`,
    };

  if (st.phase === "deciding") {
    const left = deadlineT !== null ? Math.max(deadlineT - t, 0) : 0;
    return {
      tone: "go",
      icon: "check",
      title: "On track",
      detail: `Even the cautious forecast (${fmtNum(est!.need90)} Wh) fits, with ${fmtNum(est!.margin)} Wh to spare. The call locks at halfway, in ${fmtNum(left, 0)} s.`,
    };
  }

  // Past halfway with no return call: committed to finishing the loop.
  const margin = est!.margin;
  if (st.phase === "landed")
    return { tone: "go", icon: "check", title: "Cleared to continue", detail: `The check let this mission continue at halfway (${fmtClock(call!.t)}). The hindsight below says whether that was right.` };
  return margin >= 0
    ? { tone: "go", icon: "lock", title: "Committed: will make it", detail: `Past halfway, finishing is the quickest way home. Forecast to land with ${fmtNum(margin)} Wh to spare.` }
    : { tone: "warn", icon: "lock", title: "Committed: tight", detail: `Past halfway, finishing is the quickest way home, but the forecast is now ${range} against ${fmtNum(budget)} Wh.` };
}

/** Horizontal energy gauge: used so far, the forecast still to burn, the P90 margin, and the budget line. */
function EnergyBar({ state, budget, forecast, done }: { state: MissionState; budget: number; forecast: FlightForecast; done: boolean }) {
  const est = state.est;
  // After landing, show what the mission really used (the last forecast point is 5 s before the rotors stop).
  const used = state.phase === "landed" ? forecast.totalWh : est?.used ?? 0;
  const n50 = est && !done ? est.need50 : used;
  const n90 = est && !done ? est.need90 : used;
  const scale = Math.max(budget, n90, ...forecast.used.slice(-1), 1) * 1.12;
  const pct = (x: number) => `${Math.min((x / scale) * 100, 100)}%`;
  const over = n90 > budget;

  return (
    <div className="ebar">
      <div className="ebar-track" aria-hidden>
        <div className="ebar-used" style={{ width: pct(used) }} />
        <div className="ebar-p50" style={{ left: pct(used), width: pct(Math.max(n50 - used, 0)) }} />
        <div className={`ebar-p90 ${over ? "over" : ""}`} style={{ left: pct(n50), width: pct(Math.max(n90 - n50, 0)) }} />
        <div className="ebar-budget" style={{ left: pct(budget) }} />
      </div>
      <dl className="ebar-legend num">
        <div>
          <dt><i className="sw sw-used" />Used</dt>
          <dd>{fmtNum(used)} Wh</dd>
        </div>
        <div>
          <dt><i className="sw sw-need" />{done ? "Forecast" : "Total forecast"}</dt>
          <dd>{done || !est ? "–" : `${fmtNum(n50)} (P90 ${fmtNum(n90)})`}</dd>
        </div>
        <div>
          <dt><i className="sw sw-budget" />Battery</dt>
          <dd>{fmtNum(budget)} Wh</dd>
        </div>
      </dl>
    </div>
  );
}

const CH = 84;
const PAD_T = 12;

/**
 * Total-mission forecast (energy used + still needed) over the flight, against the battery line.
 * The y-axis is zoomed to the band around the battery, where the decision is made. Click or drag to scrub.
 */
function ForecastChart({
  forecast,
  budget,
  call,
  deadlineT,
  actualWh,
}: {
  forecast: FlightForecast;
  budget: number;
  call: MissionCall | null;
  deadlineT: number | null;
  /** In the poisoning lab, what the mission really used, so the band can be judged against it. */
  actualWh: number | null;
}) {
  const series = useStore((s) => s.series);
  const uiTime = useStore((s) => s.uiTime);
  const seek = useStore((s) => s.seek);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(296);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(e.contentRect.width, 120)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const end = series ? series.t[series.t.length - 1] : forecast.tOff;
  const geo = useMemo(() => {
    const { t, used, e50, e90 } = forecast;
    const totals90 = e90.map((e, i) => used[i] + e);
    const totals50 = e50.map((e, i) => used[i] + e);
    const top = Math.max(budget, ...totals90, actualWh ?? 0) + 1;
    const bottom = Math.max(Math.min(budget, ...totals50, actualWh ?? Infinity) - 1.5, 0);
    const x = (s: number) => (s / end) * width;
    const y = (wh: number) => CH - ((wh - bottom) / Math.max(top - bottom, 1)) * (CH - PAD_T);
    const step = Math.max(1, Math.floor(t.length / 160));
    const idx: number[] = [];
    for (let i = 0; i < t.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== t.length - 1) idx.push(t.length - 1);
    const p = (i: number, wh: number) => `${x(t[i]).toFixed(1)},${y(wh).toFixed(1)}`;
    const band = `M${idx.map((i) => p(i, used[i] + e90[i])).join("L")}L${[...idx].reverse().map((i) => p(i, used[i] + e50[i])).join("L")}Z`;
    const mid = `M${idx.map((i) => p(i, used[i] + e50[i])).join("L")}`;
    return { x, y, band, mid, top, bottom };
  }, [forecast, budget, end, width, actualWh]);

  const scrubbing = useRef(false);
  const seekFrom = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * end);
  };
  const playX = geo.x(Math.min(uiTime, end));
  const by = geo.y(budget);
  const callColor = call?.type === "return" ? "var(--stop)" : call?.type === "review" ? "var(--warn)" : "var(--go)";
  const callWh = call ? forecast.used[call.idx] + forecast.e50[call.idx] : 0;

  return (
    <div className="fchart" ref={wrap}>
      <div className="fchart-head">
        <span>Total mission forecast</span>
        <span className="muted">click to scrub</span>
      </div>
      <svg
        width="100%"
        height={CH}
        viewBox={`0 0 ${width} ${CH}`}
        preserveAspectRatio="none"
        aria-label="Forecast of total mission energy over the flight, with the battery budget"
        onPointerDown={(e) => {
          scrubbing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFrom(e);
        }}
        onPointerMove={(e) => scrubbing.current && seekFrom(e)}
        onPointerUp={() => (scrubbing.current = false)}
        // A cancelled touch or pen gesture never sends pointerup; without these the next hover would seek.
        onPointerCancel={() => (scrubbing.current = false)}
        onLostPointerCapture={() => (scrubbing.current = false)}
      >
        <defs>
          <clipPath id="fc-past">
            <rect width={playX} height={CH} />
          </clipPath>
        </defs>
        {deadlineT !== null && (
          <>
            <rect x={geo.x(forecast.tOn)} width={Math.max(geo.x(deadlineT) - geo.x(forecast.tOn), 0)} y={0} height={CH} className="fc-window" />
            <line x1={geo.x(deadlineT)} x2={geo.x(deadlineT)} y1={0} y2={CH} className="fc-deadline" />
            <text x={geo.x(deadlineT) + 4} y={10} className="fc-label">halfway</text>
          </>
        )}
        <path d={geo.band} className="fc-band" />
        <path d={geo.band} className="fc-band past" clipPath="url(#fc-past)" />
        <path d={geo.mid} className="fc-mid future" />
        <path d={geo.mid} className="fc-mid" clipPath="url(#fc-past)" />
        {actualWh !== null && (
          <>
            <line x1={0} x2={width} y1={geo.y(actualWh)} y2={geo.y(actualWh)} className="fc-actual" />
            <text x={4} y={geo.y(actualWh) - 4} className="fc-label actual">actual {fmtNum(actualWh)} Wh</text>
          </>
        )}
        <line x1={0} x2={width} y1={by} y2={by} className="fc-budget" />
        <text x={width - 4} y={by < 18 ? by + 11 : by - 4} textAnchor="end" className="fc-label budget">battery {fmtNum(budget)} Wh</text>
        {Math.abs(by - CH) > 16 && <text x={4} y={CH - 4} className="fc-label">{fmtNum(geo.bottom, 0)} Wh</text>}
        {call && call.type !== "continue" && uiTime >= call.t && (
          <g>
            <line x1={geo.x(call.t)} x2={geo.x(call.t)} y1={geo.y(callWh)} y2={CH} stroke={callColor} strokeDasharray="2 3" />
            <circle cx={geo.x(call.t)} cy={geo.y(callWh)} r={4} fill={callColor} className="fc-call" />
          </g>
        )}
        <line x1={playX} x2={playX} y1={0} y2={CH} className="playhead" />
      </svg>
      <div className="fchart-key">
        <span><i className="sw sw-band" />Forecast, P50–P90</span>
        <span><i className="sw sw-budgetline" />Battery</span>
        {actualWh !== null ? (
          <span><i className="sw sw-actual" />Actual (hindsight)</span>
        ) : (
          <span><i className="sw sw-window" />Before halfway</span>
        )}
      </div>
    </div>
  );
}

function BudgetControl() {
  const model = useStore((s) => s.model);
  const budgetWh = useStore((s) => s.budgetWh);
  const setBudget = useStore((s) => s.setBudget);
  const meta = useStore((s) => s.meta);
  if (!model) return null;
  const sim = meta ? model.simulated[String(meta.id)] : undefined;
  const { min, max, step } = model.budget;

  if (sim)
    return (
      <div className="budget locked">
        <div className="budget-head">
          <span>Battery for this mission</span>
          <span className="budget-val num">{fmtNum(sim.budgetWh)} Wh</span>
        </div>
        <p className="budget-note">Simulated depleted pack. Power is lost after about {fmtNum(sim.budgetWh)} Wh.</p>
      </div>
    );

  return (
    <div className="budget">
      <label className="budget-head" htmlFor="budget-range">
        <span>Battery for this mission</span>
        <span className="budget-val num">{fmtNum(budgetWh)} Wh</span>
      </label>
      <input
        id="budget-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={budgetWh}
        onChange={(e) => setBudget(Number(e.target.value))}
        style={{ "--fill": `${((budgetWh - min) / (max - min)) * 100}%` } as React.CSSProperties}
        aria-valuetext={`${fmtNum(budgetWh)} watt-hours`}
      />
      <p className="budget-note">Usable energy after the safety reserve ({fmtNum(model.packWh, 0)} Wh pack). Drag to change the call.</p>
    </div>
  );
}

function VerdictIcon({ kind }: { kind: Headline["icon"] }) {
  const paths: Record<Headline["icon"], React.ReactNode> = {
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    back: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
    review: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5v.01" /></>,
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    wait: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    off: <><circle cx="12" cy="12" r="9" /><path d="M7.5 16.5l9-9" /></>,
    bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  };
  return (
    <svg className="verdict-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[kind]}
    </svg>
  );
}
