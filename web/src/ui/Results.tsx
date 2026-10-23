import { Fragment } from "react";
import { useStore } from "../store";
import type { ResultCell, ResultsSummary } from "../types";
import { fmtNum } from "./format";

// What each case-prompt requirement asks for, shown on hover over its tag.
const REQS: Record<number, string> = {
  2: "Establish a reference",
  3: "Introduce or isolate degradation",
  4: "Show the effect over time",
  5: "Explain the mechanism",
  6: "Demonstrate a countermeasure",
  7: "Identify limits and next steps",
};

// When a number counts as degraded, for colouring: clearly worse than clean data.
const BAD = {
  maeWh: (v: number, clean: number) => v > clean * 1.15,
  p90: (v: number) => v < 0.85,
  unsafe: (v: number) => v >= 0.5,
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The experiment's headline numbers, laid out against the case prompt's requirements: clean
 * baseline, the four data conditions with and without the fix, error over time, and the stress
 * tests, limits and costs. Every number comes from results/ via scripts/export_web_results.py.
 */
export function Results() {
  const r = useStore((s) => s.results);
  const feed = useStore((s) => s.scenarioIndex?.feed);
  if (!r) return null;
  const clean = r.grid.find((g) => g.key === "reference")!;
  const both = r.grid.find((g) => g.key === "combined")!;
  const cleanMae = clean.off.maeWh;
  const held = r.unseen.filter((u) => u.on.p90 >= 0.9 && !BAD.maeWh(u.on.maeWh, cleanMae));
  const span = (xs: number[], f: (v: number) => string) => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
  };
  const { physics_only: physics, hybrid } = r.baseline.models;

  return (
    <section className="results glass" aria-label="Experiment results">
      <Block reqs={[2]} title="Healthy data: the model works">
        <div className="res-hero">
          <Stat value={fmtNum(hybrid.maeWh, 2)} unit="Wh" label="typical miss" />
          <Stat value={pct(hybrid.p90)} label="safety margin held" />
          <Stat value={`${Math.round(physics.maeWh / hybrid.maeWh)}×`} label={`less error than physics alone (${fmtNum(physics.maeWh, 2)} Wh)`} />
        </div>
        <p className="res-note">
          Real data: {r.baseline.flights} flights · {r.baseline.checkpoints.toLocaleString()} checkpoints · tested on later flight days
        </p>
      </Block>

      <Block reqs={[3, 6]} title="Bad data, without → with the fix" tag={<span className="sim-tag" title={r.simulated}>Simulated</span>}>
        <table className="res-grid">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col" title="How far off the energy forecast is, on average">
                Miss (Wh)
                <small>lower = better</small>
              </th>
              <th scope="col" title="How often the safety margin really covered the energy needed (target 90%)">
                Margin held
                <small>target 90%</small>
              </th>
              <th scope="col" title={`Continue calls on flights that would have run out, out of ${r.decisions.total} flight-battery calls`}>
                Unsafe calls
                <small>target 0</small>
              </th>
            </tr>
          </thead>
          <tbody>
            {r.grid.map((g) => (
              <Fragment key={g.key}>
                <tr className={g.key === "combined" ? "res-key-row" : undefined}>
                  <th scope="row">
                    {g.label}
                    {CONDITION_NOTE[g.key] && <small>{CONDITION_NOTE[g.key]}</small>}
                  </th>
                  <Change off={g.off} on={g.on} metric="maeWh" clean={cleanMae} fmt={(v) => fmtNum(v, 2)} />
                  <Change off={g.off} on={g.on} metric="p90" clean={cleanMae} fmt={pct} />
                  <Change off={g.off} on={g.on} metric="unsafe" clean={cleanMae} fmt={(v) => fmtNum(v, 1)} />
                </tr>
                {CONDITION_DETAIL[g.key] && (
                  <tr className="res-detail-row">
                    <td colSpan={4}>{CONDITION_DETAIL[g.key]}</td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        <p className="res-note">
          Windows {r.windows[0]}–{r.windows[r.windows.length - 1]} · {r.seeds} seeds · {r.decisions.total} calls, {r.decisions.shouldReturn} should turn back
        </p>
      </Block>

      <Block reqs={[4]} title="As more sensors get damaged">
        <OverTime r={r} clean={cleanMae} />
      </Block>

      <Block reqs={[5]} title="Why it breaks">
        <p className="res-chain">
          {feed ? `Damaged sensors read ${Math.round((1 - feed.currentFactor) * 100)}% low` : "Damaged sensors read low"} <i>→</i> logs say flights used less
          energy than they did <i>→</i> the model learns missions need less (it under-forecasts by {fmtNum(-both.off.biasWh, 2)} Wh) <i>→</i> its safety
          margin holds only {pct(both.off.p90)} of the time <i>→</i> {fmtNum(both.off.unsafe, 1)} unsafe "keep flying" calls.
        </p>
      </Block>

      <Block reqs={[6]} title="How the fix corrects it">
        <p className="res-chain">
          Check flights carry a trusted spare sensor <i>→</i> they measure how far off the damaged sensors are <i>→</i> the bad readings are corrected,
          none deleted <i>→</i> the model retrains, and its margin is checked on trusted flights only <i>→</i> miss {fmtNum(both.off.maeWh, 2)} →{" "}
          {fmtNum(both.on.maeWh, 2)} Wh, margin {pct(both.off.p90)} → {pct(both.on.p90)}, unsafe calls {fmtNum(both.off.unsafe, 1)} →{" "}
          {fmtNum(both.on.unsafe, 1)}.
        </p>
      </Block>

      <Block reqs={[6, 7]} title="Stress tests, limits, cost">
        <ul className="res-facts">
          <li className="good">
            <b>
              {held.length} of {r.unseen.length}
            </b>{" "}
            other sensor faults it wasn't built for still handled: {span(held.map((u) => u.on.maeWh), (v) => fmtNum(v, 2))} Wh, {span(held.map((u) => u.on.p90), pct)} margin.
          </li>
          <li className="bad">
            <b>Limit:</b> with no check flights the margin only reaches {pct(r.failure.on.p90)}, and {Math.round(r.failure.on.deferred)} calls go to the operator.
          </li>
          <li>
            <b>Cost:</b> {r.cost}. {Math.round(both.on.deferred)} of {r.decisions.total} calls are sent for human review when both defects hit.
          </li>
        </ul>
      </Block>
    </section>
  );
}

function Block({ reqs, title, tag, children }: { reqs: number[]; title: string; tag?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="res-block">
      <h3>
        {reqs.map((n) => (
          <span key={n} className="req" title={`Case prompt requirement ${n}: ${REQS[n]}`}>
            R{n}
          </span>
        ))}
        {title}
        {tag}
      </h3>
      {children}
    </div>
  );
}

/** What each training-data condition means, in a few words under its name. */
const CONDITION_NOTE: Record<string, string> = {
  reference: "All logs arrive, all sensors OK",
  stale: "Right but old: uploads stopped",
  low_quality: "New but wrong: sensors read 12% low",
  combined: "Only bad logs arrive",
};

/** The full story behind a condition, on its own line under the row. */
const CONDITION_DETAIL: Record<string, string> = {
  stale:
    "The healthy drones' log uploads stopped after the first window. The data the model has is accurate, but it's out of date, so the model misses newer kinds of flights, like heavier payloads.",
  low_quality:
    "Logs keep arriving, but a growing share of drones have damaged current sensors. These read about 12% low and log twice as often, so the bad records outnumber the good ones. The model learns that flights use less energy than they really do.",
};

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div className="res-stat">
      <span className="res-value num">
        {value}
        {unit && <span className="unit"> {unit}</span>}
      </span>
      <span className="res-label">{label}</span>
    </div>
  );
}

function Change({ off, on, metric, clean, fmt }: { off: ResultCell; on: ResultCell; metric: keyof typeof BAD; clean: number; fmt: (v: number) => string }) {
  const bad = (v: number) => BAD[metric](v, clean);
  const offBad = bad(off[metric]);
  const onBad = bad(on[metric]);
  return (
    <td className="num">
      <span className={offBad ? "res-bad" : "res-off"}>{fmt(off[metric])}</span>
      <i aria-label="with the fix">→</i>
      <span className={onBad ? "res-bad" : offBad ? "res-good" : "res-on"}>{fmt(on[metric])}</span>
    </td>
  );
}

const CW = 296;
const CH = 62;

/** Forecast error per simulated window for the combined condition, with and without the fix. */
function OverTime({ r, clean }: { r: ResultsSummary; clean: number }) {
  const { windows, maeOff, maeOn } = r.overTime;
  const top = Math.max(...maeOff, ...maeOn) * 1.12;
  const x = (k: number) => 14 + (k / (windows.length - 1)) * (CW - 52);
  const y = (v: number) => 6 + (1 - v / top) * (CH - 22);
  const line = (vs: number[]) => vs.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = windows.length - 1;
  return (
    <figure className="res-time">
      <svg viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={`Error by window: without the fix it climbs to ${fmtNum(maeOff[last], 2)} Wh; with it, it ends at ${fmtNum(maeOn[last], 2)} Wh`}>
        <line x1={x(0)} x2={x(last)} y1={y(clean)} y2={y(clean)} className="res-clean" />
        <text x={x(0)} y={y(clean) + 9} className="res-axis">clean {fmtNum(clean, 2)}</text>
        <path d={line(maeOff)} className="res-line-off" />
        <path d={line(maeOn)} className="res-line-on" />
        <circle cx={x(last)} cy={y(maeOff[last])} r={2.5} className="res-dot-off" />
        <circle cx={x(last)} cy={y(maeOn[last])} r={2.5} className="res-dot-on" />
        <text x={x(last) + 6} y={y(maeOff[last]) + 3} className="res-end res-bad">{fmtNum(maeOff[last], 2)}</text>
        <text x={x(last) + 6} y={y(maeOn[last]) + 3} className="res-end res-good">{fmtNum(maeOn[last], 2)}</text>
        {windows.map((w, k) => (
          <text key={w} x={x(k)} y={CH - 2} textAnchor="middle" className="res-axis">
            {w}
          </text>
        ))}
      </svg>
      <figcaption>
        <span><i className="k-off" />No fix</span>
        <span><i className="k-on" />Fix</span>
        <span className="muted">Error (Wh) by simulated window</span>
      </figcaption>
    </figure>
  );
}
