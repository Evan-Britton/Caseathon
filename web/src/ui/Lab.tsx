import { useStore } from "../store";
import type { ScenarioCondition, ScenarioHealth, ScenarioIndex } from "../types";
import { fmtNum } from "./format";
import { useMission } from "./useMission";

const ORDER: ScenarioCondition[] = ["reference", "stale", "low_quality", "combined"];

/**
 * The SIMULATED data-poisoning lab: replay the same flight with the model each training-data
 * condition would have produced, with and without the countermeasure.
 */
export function Lab() {
  const idx = useStore((s) => s.scenarioIndex);
  const setLab = useStore((s) => s.setLab);
  const runDemo = useStore((s) => s.runDemo);
  const m = useMission();
  if (!idx || !m.meta) return null;
  const { lab } = m;
  const demo = idx.demos[0];

  if (!lab.on)
    return (
      <section className="lab glass lab-closed" aria-label="Data poisoning lab">
        <div className="lab-closed-text">
          <h2>Poisoning lab</h2>
          <p>See this flight through a model trained on stale or biased data, then turn on the fix.</p>
        </div>
        <div className="lab-closed-actions">
          <button className="btn" onClick={() => setLab({ on: true })}>Open</button>
          {demo && (
            <button className="btn btn-accent" onClick={() => void runDemo(demo)} title={`Flight ${demo.flight}, ${fmtNum(demo.budgetWh)} Wh battery`}>
              Demo
            </button>
          )}
        </div>
      </section>
    );

  const window = m.meta ? idx.flightWindow[String(m.meta.id === 900 ? 142 : m.meta.id)] : undefined;
  const health = window !== undefined ? idx.health[`${lab.condition}/${lab.fix ? "on" : "off"}/${window}`] : undefined;

  return (
    <section className="lab glass" aria-label="Data poisoning lab">
      <div className="panel-head">
        <h2>Poisoning lab</h2>
        <span className="sim-tag" title={idx.note}>Simulated</span>
        <button className="icon-btn" onClick={() => setLab({ on: false })} aria-label="Close the poisoning lab" title="Back to the standard model">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <ScenarioControls
        idx={idx}
        condition={lab.condition}
        fix={lab.fix}
        onCondition={(condition) => setLab({ condition })}
        onFix={(fix) => setLab({ fix })}
        rowClass="lab-row"
      />

      <p className="lab-desc">{idx.conditions[lab.condition].desc}</p>

      {m.scenarios && window !== undefined && health ? (
        <>
          <Health idx={idx} health={health} window={window} fix={lab.fix} />
          <WindowCharts idx={idx} condition={lab.condition} fix={lab.fix} window={window} />
        </>
      ) : (
        <p className="lab-note">
          {m.meta.route === "H"
            ? "Hover tests have no route, so there's no forecast to poison."
            : `Flight ${m.meta.id} is in window 0, the first training window. There's nothing earlier to poison; try a demo below.`}
        </p>
      )}

      {idx.demos.length > 0 && (
        <div className="lab-demos">
          <span className="lab-label">Demos</span>
          {idx.demos.slice(0, 3).map((d) => (
            <button
              key={`${d.flight}-${d.condition}`}
              className={`chip-btn ${m.meta?.id === d.flight ? "active" : ""}`}
              onClick={() => void runDemo(d)}
              title={`Poisoned (${idx.conditions[d.condition].label}) says continue with ${fmtNum(d.claimedSpareWh)} Wh to spare; it was really ${fmtNum(d.shortWh, 2)} Wh short`}
            >
              Flight {d.flight} · {fmtNum(d.budgetWh)} Wh
            </button>
          ))}
        </div>
      )}
    </section>
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
}: {
  idx: ScenarioIndex;
  condition: ScenarioCondition;
  fix: boolean;
  onCondition: (c: ScenarioCondition) => void;
  onFix: (fix: boolean) => void;
  rowClass: string;
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
          {fix ? "On: audit + trusted calibration" : "Off"}
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
      findings.push(`cheap feed reads ×${fmtNum(health.estimatedFeedRatio, 2)}: ${health.recalibratedRecords} records recalibrated`);
    if (health.unverifiedRecords) findings.push(`${health.unverifiedRecords} records unverified, down-weighted`);
    if (stale) findings.push("upload outage flagged");
    if (health.referenceFlights) findings.push(`margin checked on ${health.referenceFlights} reference flights`);
  }

  return (
    <div className="lab-health">
      <p className="lab-window">
        Window {window} of {idx.windows - 1} · trained on {health.trainFlights} flights
      </p>
      <dl>
        <div className={stale ? "bad" : "ok"}>
          <dt>Newest automatic upload</dt>
          <dd>
            {health.newestAutoUploadWindow === null ? "none" : `window ${health.newestAutoUploadWindow}`}
            {stale && <span> · {health.uploadAgeWindows} windows old</span>}
          </dd>
        </div>
        <div className={cheap ? "bad" : "ok"}>
          <dt>Cheap-feed records</dt>
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
