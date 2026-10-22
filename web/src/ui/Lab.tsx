import { useStore } from "../store";
import type { ScenarioCondition, ScenarioDemo, ScenarioHealth, ScenarioIndex } from "../types";
import { fmtNum } from "./format";
import { useMission } from "./useMission";

const ORDER: ScenarioCondition[] = ["reference", "stale", "low_quality", "combined"];

/** Heaviest regular package in the data, g. Under "Both", these only reached training from drones with damaged sensors. */
const HEAVY_G = 500;

/** Demo cases on heavy-package flights: the poisoned model says continue on a flight that runs short. */
export function heavyDemos(idx: ScenarioIndex | null): ScenarioDemo[] {
  return idx ? idx.demos.filter((d) => d.payload >= HEAVY_G && d.condition === "combined") : [];
}

/**
 * The SIMULATED data-poisoning lab, folded into the mission check: switch from the standard model to
 * the model each training-data condition would have produced, with and without the countermeasure.
 */
export function LabControls() {
  const idx = useStore((s) => s.scenarioIndex);
  const setLab = useStore((s) => s.setLab);
  const m = useMission();
  if (!idx || !m.meta) return null;
  const { lab } = m;
  const window = idx.flightWindow[String(m.meta.id === 900 ? 142 : m.meta.id)];
  const health = window !== undefined ? idx.health[`${lab.condition}/${lab.fix ? "on" : "off"}/${window}`] : undefined;

  // "Healthy sensors" is the standard model, trained on the real (healthy) logs; the other two are lab scenarios.
  const story = lab.on ? storyOf(lab.condition, lab.fix) : "healthy";
  const pick = (st: SensorStory) => setLab(st === "healthy" ? { on: false } : { on: true, ...storySetting(st) });

  return (
    <div className="mlab">
      <StoryControls story={story} onStory={pick} rowClass="lab-row" />
      {!lab.on && <StoryNote story="healthy" note={idx.note} />}

      {lab.on && (
        <>
          {story ? (
            <StoryNote story={story} note={idx.note} />
          ) : (
            <p className="lab-desc">
              <span className="sim-tag" title={idx.note}>Simulated</span> {idx.conditions[lab.condition].desc}
            </p>
          )}
          {lab.fix && window !== undefined && window > 0 && <FixSteps idx={idx} condition={lab.condition} window={window} />}
          {m.scenarios && window !== undefined && health ? (
            <details className="mlab-more">
              <summary>Data health and error over time</summary>
              <Health idx={idx} health={health} window={window} fix={lab.fix} />
              <WindowCharts idx={idx} condition={lab.condition} fix={lab.fix} window={window} />
            </details>
          ) : (
            <p className="lab-note">
              {m.meta.route === "H"
                ? "Hover tests have no route, so there's no forecast to poison."
                : `Flight ${m.meta.id} is in window 0, the first training window. There's nothing earlier to poison; try a heavy-payload demo below.`}
            </p>
          )}
        </>
      )}

      <details className="mlab-more">
        <summary>All four test conditions</summary>
        <ScenarioControls
          idx={idx}
          condition={lab.condition}
          fix={lab.fix}
          onCondition={(condition) => setLab({ on: true, condition })}
          onFix={(fix) => setLab({ on: true, fix })}
          rowClass="lab-row"
        />
        <p className="lab-note-sm">The case tests clean, stale-only, low-quality-only and both, each with and without the fix. The Results tab has all eight.</p>
      </details>
    </div>
  );
}

/** One-click demos: a heavy-package flight, its battery, and the "Both" condition with the fix off. */
export function HeavyDemos() {
  const idx = useStore((s) => s.scenarioIndex);
  const runDemo = useStore((s) => s.runDemo);
  const meta = useStore((s) => s.meta);
  const demos = heavyDemos(idx);
  if (!idx || demos.length === 0) return null;
  return (
    <div className="lab-demos">
      <span className="lab-label">Heavy-payload demos</span>
      {demos.map((d) => (
        <button
          key={`${d.flight}-${d.condition}`}
          className={`chip-btn ${meta?.id === d.flight ? "active" : ""}`}
          onClick={() => void runDemo(d)}
          title={`${fmtNum(d.payload, 0)} g package. Heavier packages only reached training from drones with damaged current sensors, so the poisoned model (${idx.conditions[d.condition].label}) says continue with ${fmtNum(d.claimedSpareWh)} Wh to spare; the flight was really ${fmtNum(d.shortWh, 2)} Wh short. Turn on the fix to see it caught.`}
        >
          Flight {d.flight} · {fmtNum(d.budgetWh)} Wh
        </button>
      ))}
    </div>
  );
}

export type SensorStory = "healthy" | "damaged" | "fixed";

/**
 * The demo's three states. The case asks for four data conditions with and without the fix (the Results
 * tab has all eight); the story needs only these: healthy data, the damaged-sensor data ("Both": damaged
 * sensors logging while the healthy drones' uploads are broken), and that same data with the fix.
 */
const STORIES: { id: SensorStory; label: string; cls: string; title: string; condition: ScenarioCondition; fix: boolean }[] = [
  { id: "healthy", label: "Healthy sensors", cls: "seg-clean", condition: "reference", fix: false, title: "Trained on logs from healthy current sensors" },
  {
    id: "damaged",
    label: "Damaged sensors",
    cls: "seg-bad",
    condition: "combined",
    fix: false,
    title: "SIMULATED: recent logs come from drones whose damaged current sensors read 12% low, and the healthy drones' uploads broke",
  },
  {
    id: "fixed",
    label: "Damaged + fix",
    cls: "seg-fix",
    condition: "combined",
    fix: true,
    title: "The same damaged data run through the sensor check: check flights measure the error and the bad readings are corrected",
  },
];

/** The story a condition and fix setting tells, or null for one of the other test conditions. */
export function storyOf(condition: ScenarioCondition, fix: boolean): SensorStory | null {
  return STORIES.find((s) => s.condition === condition && s.fix === fix)?.id ?? null;
}

export function storySetting(story: SensorStory): { condition: ScenarioCondition; fix: boolean } {
  const s = STORIES.find((x) => x.id === story)!;
  return { condition: s.condition, fix: s.fix };
}

export function storyLabel(story: SensorStory): string {
  return STORIES.find((s) => s.id === story)!.label;
}

/**
 * Plain words for each state of the sensor switch: how bad data gets in, and what it does to the model.
 * "Damaged + fix" explains itself step by step (FixSteps). `compact` is one line, for the console.
 */
export function StoryNote({ story, note, compact = false }: { story: SensorStory | null; note: string; compact?: boolean }) {
  const sim = (
    <span className="sim-tag" title={note}>
      Simulated
    </span>
  );
  if (compact) {
    const line =
      story === "healthy"
        ? "Every log comes from a working current sensor."
        : story === "damaged"
          ? "Some drones' damaged current sensors read 12% low and flood the logs, so the model thinks missions need less energy than they do."
          : story === "fixed"
            ? "Check flights with a trusted spare sensor correct the bad readings, and a too-heavy package gets its forecast scaled up for the weight before takeoff."
            : null;
    return line ? <p className="story-note compact">{story !== "healthy" && sim} {line}</p> : null;
  }
  if (story === "healthy")
    return (
      <p className="story-note">
        <b>Healthy sensors.</b> Every flight log comes from a working current sensor, so the model learns how much energy missions really
        take.
      </p>
    );
  if (story === "damaged")
    return (
      <div className="story-note bad">
        <p>
          {sim} <b>How bad data gets in.</b> Drones get bumped on landing, rained on, or a connector works loose. The current sensor keeps
          working but reads about 12% low, and nobody notices because the drone still flies. A glitch makes these units log twice as often,
          and the healthy drones' uploads have broken, so most new logs are bad.
        </p>
        <p>
          <b>What it does to the model.</b> The logs say each flight used less energy than it really did, so the model learns that
          missions need less. It sounds just as confident, and starts clearing drones that can't make it home.
        </p>
      </div>
    );
  return null;
}

/** The demo's one control: healthy sensor data, damaged-sensor data, or the damaged data with the fix. */
export function StoryControls({
  story,
  onStory,
  rowClass,
  fixTitle,
}: {
  story: SensorStory | null;
  onStory: (s: SensorStory) => void;
  rowClass: string;
  /** What the fix does here, if more than the lab's sensor correction. */
  fixTitle?: string;
}) {
  return (
    <div className={`${rowClass} story-row`}>
      <span className="lab-label">Sensor data</span>
      <div className="seg" role="radiogroup" aria-label="Sensor data">
        {STORIES.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={story === s.id}
            className={s.cls}
            onClick={() => onStory(s.id)}
            title={s.id === "fixed" && fixTitle ? fixTitle : s.title}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The fix, step by step, with this window's real numbers: how the damaged-sensor data is cleaned before
 * the model retrains, and what that buys. `guardMaxG` adds the operator console's range guard.
 */
export function FixSteps({
  idx,
  condition,
  window,
  guardMaxG,
}: {
  idx: ScenarioIndex;
  condition: ScenarioCondition;
  window: number;
  guardMaxG?: number;
}) {
  const on = idx.health[`${condition}/on/${window}`];
  const before = idx.chart[`${condition}/off`];
  const after = idx.chart[`${condition}/on`];
  if (!on || !before || !after) return null;
  const ratio = on.estimatedFeedRatio ?? null;
  const fixed = on.recalibratedRecords ?? 0;
  const unverified = on.unverifiedRecords ?? 0;
  const status: Record<ScenarioHealth["status"], string> = { unmonitored: "not monitored", green: "green", amber: "amber", red: "red" };
  const steps: [string, string][] = [
    ["Fly check flights", `${on.referenceFlights ?? 0} flights carried a spare sensor we trust, next to the drone's own.`],
    [
      "Find the error",
      ratio ? `The damaged sensors read ${pct(1 - ratio)} too low (×${fmtNum(ratio, 3)}).` : "The sensors matched the spare, so there was nothing to fix.",
    ],
    [
      "Fix the data",
      fixed && ratio
        ? `${fixed.toLocaleString()} bad readings were scaled up ${pct(1 / ratio - 1)}. Nothing was deleted.${unverified ? ` ${unverified} it couldn't check count less.` : ""}`
        : unverified
          ? `${unverified} readings it couldn't check count less. Nothing was deleted.`
          : "No readings needed fixing. Nothing was deleted.",
    ],
    [
      "Retrain",
      `The model learned again from ${on.trainFlights} flights. Its safety margin was then checked ${on.calibration === "trusted_recent_flights" ? "on trusted flights only" : "on recent flights (too few trusted ones)"}.`,
    ],
    ["Warn people", `Data health: ${status[on.status]}. Close calls go to the operator.`],
  ];
  if (guardMaxG !== undefined) {
    steps.push([
      "Too heavy?",
      `A package over ${fmtNum(guardMaxG, 0)} g is heavier than anything it trained on, so its forecast is scaled up for the extra weight before takeoff, and a person checks close calls.`,
    ]);
  }
  const w = window - 1;
  return (
    <div className="fix-steps">
      <p className="fix-steps-head">How the fix cleans the data</p>
      <ol>
        {steps.map(([title, text]) => (
          <li key={title}>
            <strong>{title}.</strong> {text}
          </li>
        ))}
      </ol>
      <p className="fix-result num">
        Before → after: forecast off by {fmtNum(before.maeWh[w], 2)} → <b>{fmtNum(after.maeWh[w], 2)} Wh</b> · safety margin worked{" "}
        {pct(before.p90Coverage[w])} → <b>{pct(after.p90Coverage[w])}</b> of the time
      </p>
      <p className="fix-real">
        In a real fleet: put a trusted spare sensor on a few flights each week, the way you check a scale against a known weight. It also
        caught sensor faults it wasn't built for: reading 20% low, drifting, a fixed offset, reading high.
      </p>
    </div>
  );
}

/** Training-data condition and countermeasure switch, shared by the lab and the operator console. */
export function ScenarioControls({
  idx,
  condition,
  fix,
  onCondition,
  onFix,
  rowClass,
  fixLabel = "sensor check",
}: {
  idx: ScenarioIndex;
  condition: ScenarioCondition;
  fix: boolean;
  onCondition: (c: ScenarioCondition) => void;
  onFix: (fix: boolean) => void;
  rowClass: string;
  /** What the fix does here, after "On: ". */
  fixLabel?: string;
}) {
  return (
    <>
      <div className={rowClass}>
        <span className="lab-label">Training data</span>
        <div className="seg" role="radiogroup" aria-label="Training data condition">
          {ORDER.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={condition === c}
              className={c === "reference" ? "seg-clean" : "seg-bad"}
              onClick={() => onCondition(c)}
              title={idx.conditions[c].desc}
            >
              {idx.conditions[c].label}
            </button>
          ))}
        </div>
      </div>

      <div className={rowClass}>
        <span className="lab-label">Countermeasure</span>
        <button className={`switch ${fix ? "on" : ""}`} role="switch" aria-checked={fix} onClick={() => onFix(!fix)}>
          <i aria-hidden />
          {fix ? `On: ${fixLabel}` : "Off"}
        </button>
      </div>
    </>
  );
}

/** Data-health readout for one training window, shared by the lab and the operator console. */
export function Health({
  idx,
  health,
  window,
  fix,
  children,
}: {
  idx: ScenarioIndex;
  health: ScenarioHealth;
  window: number;
  fix: boolean;
  children?: React.ReactNode;
}) {
  const stale = health.uploadAgeWindows > 1;
  const cheap = health.cheapFeedShare > 0;
  const statusText: Record<ScenarioHealth["status"], string> = {
    unmonitored: "Not monitored",
    green: "Green",
    amber: "Amber",
    red: "Red",
  };
  const findings: string[] = [];
  if (fix) {
    if (health.recalibratedRecords && health.estimatedFeedRatio)
      findings.push(`damaged sensors read ×${fmtNum(health.estimatedFeedRatio, 2)}: ${health.recalibratedRecords} records corrected`);
    if (health.unverifiedRecords) findings.push(`${health.unverifiedRecords} records unverified, down-weighted`);
    if (stale) findings.push("broken uploads flagged");
    if (health.referenceFlights) findings.push(`margin checked on ${health.referenceFlights} check flights (known-good backup sensor)`);
  }

  return (
    <div className="lab-health">
      <p className="lab-window">
        Window {window} of {idx.windows - 1} · trained on {health.trainFlights} flights
      </p>
      <dl>
        <div className={stale ? "bad" : "ok"}>
          <dt>Newest healthy-drone upload</dt>
          <dd>
            {health.newestAutoUploadWindow === null ? "none" : `window ${health.newestAutoUploadWindow}`}
            {stale && <span> · {health.uploadAgeWindows} windows old</span>}
          </dd>
        </div>
        <div className={cheap ? "bad" : "ok"}>
          <dt>Damaged-sensor records</dt>
          <dd>
            {Math.round(health.cheapFeedShare * 100)}%
            {cheap && <span> · reads {Math.round((1 - idx.feed.currentFactor) * 100)}% low</span>}
          </dd>
        </div>
        <div className={`status-${health.status}`}>
          <dt>Data health check</dt>
          <dd>
            {statusText[health.status]}
            {!fix && (stale || cheap) && <span> · nothing flags it</span>}
          </dd>
        </div>
      </dl>
      {findings.length > 0 && <p className="lab-findings">Fix: {findings.join(" · ")}.</p>}
      {children}
    </div>
  );
}

const CW = 176;
const CHT = 64;

/** Error and P90 coverage across the simulated windows: clean, this condition, and with the fix. */
function WindowCharts({ idx, condition, fix, window }: { idx: ScenarioIndex; condition: ScenarioCondition; fix: boolean; window: number }) {
  const clean = idx.chart["reference/off"];
  const bad = idx.chart[`${condition}/off`];
  const fixed = idx.chart[`${condition}/on`];
  if (!clean || !bad || !fixed) return null;
  const n = clean.maeWh.length;
  const x = (i: number) => 8 + (i / (n - 1)) * (CW - 16);
  const maeTop = Math.max(...clean.maeWh, ...bad.maeWh, ...fixed.maeWh) * 1.15;
  const lineOf = (vals: number[], top: number, bottom = 0) =>
    vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(CHT - 6 - ((v - bottom) / (top - bottom)) * (CHT - 16)).toFixed(1)}`).join("");
  const wx = x(window - 1);
  const charts = [
    { title: "Forecast error", unit: "Wh", key: "maeWh" as const, top: maeTop, bottom: 0, fmt: (v: number) => fmtNum(v, 2) },
    { title: "P90 really holds", unit: "%", key: "p90Coverage" as const, top: 1, bottom: 0.2, fmt: (v: number) => `${Math.round(v * 100)}` },
  ];

  return (
    <div className="lab-charts">
      {charts.map((c) => {
        const y90 = CHT - 6 - ((0.9 - c.bottom) / (c.top - c.bottom)) * (CHT - 16);
        const cur = c.key === "maeWh" ? (fix ? fixed : bad).maeWh[window - 1] : (fix ? fixed : bad).p90Coverage[window - 1];
        return (
          <figure key={c.key} className="lab-chart">
            <figcaption>
              <span>{c.title}</span>
              <span className="num">
                {c.fmt(cur)} {c.unit}
              </span>
            </figcaption>
            <svg viewBox={`0 0 ${CW} ${CHT}`} role="img" aria-label={`${c.title} by simulated window`}>
              <line x1={wx} x2={wx} y1={2} y2={CHT - 4} className="lc-now" />
              {c.key === "p90Coverage" && <line x1={4} x2={CW - 4} y1={y90} y2={y90} className="lc-target" />}
              <path d={lineOf(clean[c.key], c.top, c.bottom)} className="lc-clean" />
              <path d={lineOf(bad[c.key], c.top, c.bottom)} className={`lc-bad ${fix ? "dim" : ""}`} />
              <path d={lineOf(fixed[c.key], c.top, c.bottom)} className={`lc-fix ${fix ? "" : "dim"}`} />
            </svg>
          </figure>
        );
      })}
      <div className="lab-key">
        <span><i className="k-clean" />Clean</span>
        <span><i className="k-bad" />{idx.conditions[condition].label}, no fix</span>
        <span><i className="k-fix" />With fix</span>
        <span className="muted">W1–W{n} · 5-seed means</span>
      </div>
    </div>
  );
}
