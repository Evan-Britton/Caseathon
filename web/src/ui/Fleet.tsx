import { useEffect, useMemo } from "react";
import { lerpAt, sampleAt } from "../data";
import { FLEET, VERDICT_TEXT, callLabel, droneView, pathTime } from "../fleet";
import type { DroneView, LoadedDrone } from "../fleet";
import { fleetEnd, fleetStatus, useFleet } from "../fleetStore";
import { useStore } from "../store";
import type { ScenarioCondition, ScenarioHealth } from "../types";
import { fmtClock, fmtNum } from "./format";

const ORDER: ScenarioCondition[] = ["reference", "stale", "low_quality", "combined"];
const RATES = [2, 4, 8];

export function FleetButton() {
  const openConsole = useFleet((s) => s.openConsole);
  const ready = useStore((s) => !!s.scenarioIndex);
  if (!ready) return null;
  return (
    <button className="btn btn-accent fleet-open" onClick={() => void openConsole()}>
      Operator console
    </button>
  );
}

/**
 * The SIMULATED operator console: one operator watching five medical-resupply drones.
 * Layout, like a ground-control room: status bar on top, the live 3D map in the middle,
 * the decision queue and the selected drone on the right, and a panel per drone along the
 * bottom. The system recommends continue / return / too close to call; the operator decides.
 */
export function Fleet() {
  const s = useFleet();
  const deadline = useStore((st) => st.model?.deadlineFrac ?? 0.5);
  const scenarioIndex = useStore((st) => st.scenarioIndex);
  const mapCredits = useStore((st) => st.mapCredits);
  const source = useStore((st) => st.index?.source);

  // Advance the fleet clock about 15 times a second while playing.
  useEffect(() => {
    if (!s.open) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      acc += (now - last) / 1000;
      last = now;
      if (acc >= 0.066) {
        useFleet.getState().tick(acc);
        acc = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [s.open]);

  const views = useMemo(
    () => (s.loaded ? s.loaded.map((d) => droneView(d, s.condition, s.fix, deadline, s.t, s.decisions[d.slot.flight])) : []),
    [s.loaded, s.condition, s.fix, deadline, s.t, s.decisions],
  );

  // Let the 3D scene colour each drone's ring and tag from what the console says it's doing.
  useEffect(() => {
    if (!s.loaded) return;
    s.loaded.forEach((d, i) => {
      if (views[i]) fleetStatus[d.slot.flight] = { tone: views[i].tone, status: views[i].status };
    });
  }, [s.loaded, views]);

  if (!s.open || !scenarioIndex) return null;
  const sel = s.loaded?.findIndex((d) => d.slot.flight === s.selected) ?? -1;

  return (
    <div className="ops" role="dialog" aria-label="Operator console">
      <OpsBar views={views} />

      <aside className="ops-side">
        <Scenario />
        {s.loaded && <Queue loaded={s.loaded} views={views} />}
        {s.loaded && sel >= 0 && <Detail d={s.loaded[sel]} v={views[sel]} />}
        <Log />
      </aside>

      {/* The 3D map shows through this empty cell; the scene's camera is centred on it. */}
      <div className="ops-map">
        <div className="seg ops-cam" role="radiogroup" aria-label="Camera">
          <button role="radio" aria-checked={!s.follow} onClick={() => s.setFollow(false)}>Overview</button>
          <button role="radio" aria-checked={s.follow} onClick={() => s.setFollow(true)} title="Lock onto the selected drone and fade the other paths">
            Follow drone {sel >= 0 ? sel + 1 : ""}
          </button>
        </div>
        <p className="ops-credit" aria-hidden>
          {source && <>Data: {source.authors}, {source.license}</>}
          {mapCredits && <> · {mapCredits}</>}
        </p>
      </div>

      <section className="ops-strip" aria-label="Drones">
        {s.error && <p className="stage-msg error">{s.error}</p>}
        {!s.loaded && !s.error && <p className="lab-note">Loading the fleet…</p>}
        {s.loaded?.map((d, i) => (
          <DronePanel key={d.slot.flight} d={d} v={views[i]} index={i} selected={sel === i} onSelect={() => s.select(d.slot.flight)} />
        ))}
      </section>
    </div>
  );
}

function openInReplay(d: LoadedDrone) {
  const f = useFleet.getState();
  const st = useStore.getState();
  st.setLab({ on: true, condition: f.condition, fix: f.fix });
  st.setBudget(d.slot.budgetWh);
  void st.selectFlight(d.slot.flight).then(() => useStore.getState().seek(f.t));
  f.closeConsole();
}

function OpsBar({ views }: { views: DroneView[] }) {
  const s = useFleet();
  const end = s.loaded ? fleetEnd(s.loaded) : 0;
  const decisions = s.log.filter((l) => l.kind === "decision");
  const alerts = views.filter((v) => v.needsDecision).length;
  const short = views.filter((v) => v.verdict === "ran-short" || v.verdict === "no-decision-short").length;

  return (
    <header className="ops-bar">
      <div className="ops-brand">
        <i className={`lamp ${s.playing ? "on" : ""}`} aria-hidden />
        <div>
          <strong>Fleet ops</strong>
          <span>Medical resupply · 5 drones</span>
        </div>
        <span
          className="sim-tag"
          title="Five real CMU flights, flown on different days from the same launch site near Pittsburgh, replayed together. The data has one aircraft, so the fleet is staged. Cargo names are illustrative."
        >
          Simulated fleet
        </span>
      </div>

      <dl className="ops-stats">
        <div className={alerts ? "alert" : ""}><dt>Alerts</dt><dd className="num">{alerts}</dd></div>
        <div><dt>Your decisions</dt><dd className="num">{decisions.length}</dd></div>
        <div className={short ? "alert" : ""}><dt>Would have run out</dt><dd className="num">{short}</dd></div>
      </dl>

      <div className="ops-clock">
        <span className="ops-time num" title="Simulated mission time">T+ {fmtClock(s.t)} <small>/ {fmtClock(end)}</small></span>
        <button className="btn btn-accent" onClick={() => s.setPlaying(!s.playing)} disabled={!s.loaded}>
          {s.playing ? "Pause" : s.t >= end && s.t > 0 ? "Replay" : s.t > 0 ? "Resume" : "Start shift"}
        </button>
        <button className="btn" onClick={s.restart} disabled={!s.loaded || s.t === 0}>Restart</button>
        <button className="icon-btn" onClick={s.closeConsole} aria-label="Close the operator console">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </header>
  );
}

function Panel({ title, tag, children, className = "" }: { title: string; tag?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`ops-panel ${className}`}>
      <h3>
        <span>{title}</span>
        {tag && <em>{tag}</em>}
      </h3>
      {children}
    </section>
  );
}

function Scenario() {
  const s = useFleet();
  const idx = useStore((st) => st.scenarioIndex);
  const sel = s.loaded?.find((d) => d.slot.flight === s.selected);
  if (!idx) return null;
  return (
    <Panel title="Scenario" tag="simulated">
      <div className="ops-row">
        <span className="lab-label">Training data</span>
        <div className="seg" role="radiogroup" aria-label="Training data condition">
          {ORDER.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={s.condition === c}
              className={c === "reference" ? "seg-clean" : "seg-bad"}
              onClick={() => s.setCondition(c)}
              title={idx.conditions[c].desc}
            >
              {idx.conditions[c].label}
            </button>
          ))}
        </div>
      </div>
      <div className="ops-row">
        <span className="lab-label">Countermeasure</span>
        <button className={`switch ${s.fix ? "on" : ""}`} role="switch" aria-checked={s.fix} onClick={() => s.setFix(!s.fix)}>
          <i aria-hidden />
          {s.fix ? "On: audit + trusted calibration" : "Off"}
        </button>
      </div>
      <details className="ops-more">
        <summary>Presenter controls</summary>
        <div className="ops-row">
          <span className="lab-label">Speed</span>
          <div className="seg" role="radiogroup" aria-label="Playback speed">
            {RATES.map((r) => (
              <button key={r} role="radio" aria-checked={s.rate === r} onClick={() => s.setRate(r)}>{r}×</button>
            ))}
          </div>
        </div>
        <div className="ops-row">
          <button
            className={`switch ${s.hold ? "on" : ""}`}
            role="switch"
            aria-checked={s.hold}
            onClick={() => s.setHold(!s.hold)}
            title="Pause the clock when the system asks for a decision"
          >
            <i aria-hidden />
            Hold for decisions
          </button>
          {sel && <button className="link-btn" onClick={() => openInReplay(sel)}>Open {sel.slot.callsign} in the replay</button>}
        </div>
      </details>
    </Panel>
  );
}

function Queue({ loaded, views }: { loaded: LoadedDrone[]; views: DroneView[] }) {
  const s = useFleet();
  const asking = loaded.map((d, i) => ({ d, v: views[i] })).filter((x) => x.v.needsDecision);
  return (
    <Panel title="Decision queue" tag={asking.length ? `${asking.length} waiting` : "clear"} className={asking.length ? "alerting" : ""}>
      {asking.length === 0 && <p className="ops-empty">{s.t === 0 ? "Start the shift to launch the fleet." : "No decisions waiting."}</p>}
      {asking.map(({ d, v }) => {
        const e = v.state.est;
        return (
          <article key={d.slot.flight} className={`q-item tone-${v.tone}`} onClick={() => s.select(d.slot.flight)}>
            <div className="q-head">
              <strong>{d.slot.callsign} · {d.slot.cargo}</strong>
              <span>{callLabel(v.call.type)}</span>
            </div>
            {e && <p>Needs {fmtNum(e.need50)}–{fmtNum(e.need90)} Wh, battery {fmtNum(v.budget)} Wh.</p>}
            <div className="q-actions">
              <button className="btn btn-stop" onClick={(ev) => { ev.stopPropagation(); s.act(d.slot.flight, "return"); }}>Return now</button>
              <button className="btn" onClick={(ev) => { ev.stopPropagation(); s.act(d.slot.flight, "continue"); }}>Continue anyway</button>
            </div>
          </article>
        );
      })}
    </Panel>
  );
}

function Detail({ d, v }: { d: LoadedDrone; v: DroneView }) {
  const s = useFleet();
  const idx = useStore((st) => st.scenarioIndex);
  const decision = s.decisions[d.slot.flight];
  const e = v.state.est;
  const canAct = !decision && !v.settled && v.state.phase !== "standby" && v.state.phase !== "na";
  const health = idx?.health[`${s.condition}/${s.fix ? "on" : "off"}/${d.window}`];
  const live = v.state.live;

  return (
    <Panel title={`${d.slot.callsign}: ${d.slot.cargo}`} tag={`${fmtNum(v.budget)} Wh pack`}>
      <div className={`fd-rec tone-${live === "return" ? "stop" : live === "review" ? "warn" : live === "continue" ? "go" : "idle"}`}>
        <span className="fd-rec-label">System recommends</span>
        <strong>{live ? callLabel(live) : "Waiting for takeoff"}</strong>
        {e && (
          <p>
            Forecast {fmtNum(e.need50)}–{fmtNum(e.need90)} Wh against {fmtNum(v.budget)} Wh
            {e.margin >= 0 ? `: ${fmtNum(e.margin)} Wh to spare.` : `: the cautious end is ${fmtNum(-e.margin)} Wh over.`}
          </p>
        )}
      </div>

      <details className="ops-more">
        <summary>Forecast chart</summary>
        <Evidence d={d} v={v} t={s.t} />
      </details>
      {health && <Health health={health} fix={s.fix} feedLow={idx ? Math.round((1 - idx.feed.currentFactor) * 100) : 12} />}

      {decision ? (
        <p className="fd-chose">
          You chose <strong>{decision.action === "return" ? "Return now" : "Continue anyway"}</strong> at {fmtClock(decision.at)}
          {decision.seconds > 0 && <> after {fmtNum(decision.seconds)} s</>}.
        </p>
      ) : (
        // A drone the system is happy with isn't in the queue, but the operator can still recall it.
        canAct && !v.needsDecision && (
          <div className="fd-actions">
            <button className="btn" onClick={() => s.act(d.slot.flight, "return")}>Recall drone</button>
          </div>
        )
      )}
      {v.verdict && (
        <p className={`fd-verdict ${VERDICT_TEXT[v.verdict].good ? "good" : "bad"}`}>
          Hindsight: {VERDICT_TEXT[v.verdict].label}. It really used {fmtNum(v.fc.totalWh, 1)} Wh.
        </p>
      )}
    </Panel>
  );
}

function Log() {
  const log = useFleet((s) => s.log);
  const name = (f: number) => FLEET.find((x) => x.flight === f)?.callsign ?? `Flight ${f}`;
  return (
    <details className="ops-panel ops-log">
      <summary>
        <span>Event log</span>
        <em>{log.length}</em>
      </summary>
      <ol className="decision-log" aria-label="Decision log">
        {log.length === 0 && <li className="muted">Your calls appear here, with how long each took.</li>}
        {[...log].reverse().map((l) => (
          <li key={l.id}>
            <span className="num">{fmtClock(l.at)}</span>
            {l.kind === "flag" && <span>Flagged the data source to the data-quality owner</span>}
            {l.kind === "missed" && <span>{name(l.flight)}: no decision before the window closed (system said {callLabel(l.ai ?? "review")})</span>}
            {l.kind === "decision" && (
              <span>
                {name(l.flight)}: system said {l.ai ? callLabel(l.ai) : "continue"}; you chose {l.action === "return" ? "Return" : "Continue"}
                {l.seconds !== null ? ` in ${fmtNum(l.seconds)} s` : " (unprompted)"}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="fine">Simulated. Response time is wall-clock and measures this demo, not operator readiness.</p>
    </details>
  );
}

/** One drone's panel along the bottom: status lamp, live telemetry, and the energy gauge. */
function DronePanel({ d, v, index, selected, onSelect }: { d: LoadedDrone; v: DroneView; index: number; selected: boolean; onSelect: () => void }) {
  const t = useFleet((s) => s.t);
  const decision = useFleet((s) => s.decisions[d.slot.flight]);
  const { series } = d;
  const started = v.state.phase !== "standby" && v.state.phase !== "na";
  const { i, f } = sampleAt(series.t, Math.min(pathTime(t, decision), series.t[series.t.length - 1]));
  const at = (a: number[]) => lerpAt(a, i, f);
  const e = v.state.est;
  const top = Math.max(v.budget, e?.need90 ?? 0) * 1.12;
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / top) * 100))}%`;

  return (
    <button className={`dp tone-${v.tone} ${selected ? "selected" : ""} ${v.needsDecision ? "asking" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <div className="dp-head">
        <i className="lamp on" aria-hidden />
        <strong>{index + 1} · {d.slot.cargo}</strong>
        <span className="dp-status">{v.status}</span>
      </div>
      <p className="dp-line num">
        {started
          ? `${fmtNum(Math.max(at(series.up), 0), 0)} m · ${fmtNum(at(series.groundSpeed), 1)} m/s · ${fmtNum(at(series.voltage), 1)} V · ${fmtNum(Math.max(at(series.power), 0), 0)} W`
          : "Preparing for launch"}
      </p>
      <div className="fc-gauge" aria-hidden>
        <div className="fc-used" style={{ width: pct(e?.used ?? 0) }} />
        {e && <div className="fc-need" style={{ left: pct(e.used), width: `calc(${pct(e.need90)} - ${pct(e.used)})` }} />}
        <div className="fc-budget" style={{ left: pct(v.budget) }} />
      </div>
      <span className="dp-foot num">{e ? `${fmtNum(e.used, 1)} of ${fmtNum(v.budget)} Wh used` : `${fmtNum(v.budget)} Wh pack`}</span>
      {v.verdict && <p className={`fc-verdict ${VERDICT_TEXT[v.verdict].good ? "good" : "bad"}`}>{VERDICT_TEXT[v.verdict].label}</p>}
    </button>
  );
}

const CW = 340;
const CH = 96;

/** Total-mission forecast band against the battery, with the decision deadline. */
function Evidence({ d, v, t }: { d: LoadedDrone; v: DroneView; t: number }) {
  const fc = v.fc;
  const n = fc.t.length;
  const lo = fc.t[0];
  const hi = fc.t[n - 1];
  const p50 = fc.used.map((u, i) => u + fc.e50[i]);
  const p90 = fc.used.map((u, i) => u + fc.e90[i]);
  const ymin = Math.min(v.budget, ...p50) - 1.5;
  const ymax = Math.max(v.budget, ...p90) + 1.5;
  const x = (tt: number) => 6 + ((tt - lo) / (hi - lo)) * (CW - 12);
  const y = (w: number) => CH - 8 - ((w - ymin) / (ymax - ymin)) * (CH - 18);
  // Only what the system knew by now: forecasts for later moments don't exist yet.
  const m = Math.max(0, v.state.idx + 1);
  const line = (a: number[]) => a.slice(0, m).map((w, i) => `${i ? "L" : "M"}${x(fc.t[i]).toFixed(1)},${y(w).toFixed(1)}`).join("");
  const back = p50.slice(0, m).map((_, i) => `L${x(fc.t[m - 1 - i]).toFixed(1)},${y(p50[m - 1 - i]).toFixed(1)}`).join("");
  const band = m > 1 ? `${line(p90)}${back}Z` : "";
  const now = x(Math.min(Math.max(t, lo), hi));
  return (
    <figure className="fd-chart">
      <figcaption>
        <span>Total energy the mission will need</span>
        <span className="num">battery {fmtNum(v.budget)} Wh</span>
      </figcaption>
      <svg viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label={`Forecast of the energy ${d.slot.callsign} needs, against its battery`}>
        <path d={band} className="ev-band" />
        <path d={line(p50)} className="ev-p50" />
        <line x1={6} x2={CW - 6} y1={y(v.budget)} y2={y(v.budget)} className="ev-budget" />
        <line x1={x(v.deadlineT)} x2={x(v.deadlineT)} y1={2} y2={CH - 4} className="ev-deadline" />
        <line x1={now} x2={now} y1={2} y2={CH - 4} className="ev-now" />
        {v.settled && <line x1={6} x2={CW - 6} y1={y(fc.totalWh)} y2={y(fc.totalWh)} className="ev-actual" />}
      </svg>
    </figure>
  );
}

function Health({ health, fix, feedLow }: { health: ScenarioHealth; fix: boolean; feedLow: number }) {
  const stale = health.uploadAgeWindows > 1;
  const cheap = health.cheapFeedShare > 0;
  const status: Record<ScenarioHealth["status"], string> = { unmonitored: "Not monitored", green: "Green", amber: "Amber", red: "Red" };
  const found: string[] = [];
  if (fix) {
    if (health.recalibratedRecords && health.estimatedFeedRatio)
      found.push(`cheap feed reads ×${fmtNum(health.estimatedFeedRatio, 2)}: ${health.recalibratedRecords} records recalibrated`);
    if (health.unverifiedRecords) found.push(`${health.unverifiedRecords} records unverified, down-weighted`);
    if (stale) found.push("upload outage flagged");
    if (health.referenceFlights) found.push(`margin checked on ${health.referenceFlights} reference flights`);
  }
  return (
    <div className="lab-health">
      <dl>
        <div className={stale ? "bad" : "ok"}>
          <dt>Newest accurate upload</dt>
          <dd>{health.newestAutoUploadWindow === null ? "none" : `window ${health.newestAutoUploadWindow}`}{stale && <span> · {health.uploadAgeWindows} windows old</span>}</dd>
        </div>
        <div className={cheap ? "bad" : "ok"}>
          <dt>Cheap-feed records</dt>
          <dd>{Math.round(health.cheapFeedShare * 100)}%{cheap && <span> · reads {feedLow}% low</span>}</dd>
        </div>
        <div className={`status-${health.status}`}>
          <dt>Data health check</dt>
          <dd>{status[health.status]}{!fix && (stale || cheap) && <span> · nothing flags it</span>}</dd>
        </div>
      </dl>
      {found.length > 0 && <p className="lab-findings">Fix: {found.join(" · ")}.</p>}
      <FlagLink />
    </div>
  );
}

function FlagLink() {
  const flagged = useFleet((s) => s.flagged);
  const flag = useFleet((s) => s.flag);
  return (
    <button className="link-btn" disabled={flagged} onClick={flag} title="Tell the data-quality owner that this feed needs checking">
      {flagged ? "Data source flagged to the data-quality owner" : "Flag data source"}
    </button>
  );
}
