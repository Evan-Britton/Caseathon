import { useEffect, useMemo } from "react";
import { lerpAt, sampleAt } from "../data";
import { CHARGE_RESERVE, FLEET, VERDICT_TEXT, callLabel, chargePlan, crashAt, droneView, pathTime } from "../fleet";
import type { DroneView, LoadedDrone } from "../fleet";
import type { StoryRun } from "../fleetStore";
import { fleetEnd, fleetStatus, useFleet } from "../fleetStore";
import { useStore } from "../store";
import { fmtClock, fmtNum } from "./format";
import { FixSteps, Health, ScenarioControls, StoryControls, StoryNote, storyOf, storySetting } from "./Lab";

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
        // Cap each step so a stalled frame never skips a decision window.
        useFleet.getState().tick(Math.min(acc, 0.25));
        acc = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    // rAF pauses in a hidden tab; start counting afresh when it comes back.
    const onVisible = () => {
      last = performance.now();
      acc = 0;
    };
    document.addEventListener("visibilitychange", onVisible);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [s.open]);

  const views = useMemo(
    () =>
      s.loaded
        ? s.loaded.map((d) => droneView(d, s.condition, s.fix, deadline, s.t, s.decisions[d.slot.flight], s.charge?.[d.slot.flight]))
        : [],
    [s.loaded, s.condition, s.fix, deadline, s.t, s.decisions, s.charge],
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
        {s.loaded && <StoryBanner loaded={s.loaded} views={views} />}
        <p className="ops-credit" aria-hidden>
          {source && <>Data: {source.authors}, {source.license}</>}
          {mapCredits && <> · {mapCredits}</>}
          <br />
          Routes, destinations and the levelled hub are illustrative; speed, altitude, power and energy are from the flights.
          {s.synth && (
            <>
              <br />
              <strong className="syn-note">Synthetic:</strong> drones 1, 3 and 5 fly real CMU flights re-run at 1.0–1.2 kg, with power scaled by a
              rule fitted on the real 0–500 g flights (checked on the real 750 g flight: {fmtPct(s.synth.scaling.check.energyErrPct.min)} to{" "}
              {fmtPct(s.synth.scaling.check.energyErrPct.max)} energy).
            </>
          )}
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
  st.setBudget(d.budgetWh);
  // Seek only if this selection won; a newer pick or an unknown id leaves the replay alone.
  void st.selectFlight(d.slot.flight).then((ok) => {
    if (ok) useStore.getState().seek(f.t);
  });
  f.closeConsole();
}

function OpsBar({ views }: { views: DroneView[] }) {
  const s = useFleet();
  const end = s.loaded ? fleetEnd(s.loaded) : 0;
  // Only what a person did: their own calls and the charge-plan approval, not the console's auto-answers.
  const decisions = s.log.filter((l) => (l.kind === "decision" && !l.auto) || l.kind === "plan");
  const alerts = views.filter((v) => v.needsDecision).length;
  const crashed = views.filter((v) => v.crashed).length;

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
          title="Five flights replayed together from the same launch site near Pittsburgh. Drones 2 and 4 are real CMU flights; drones 1, 3 and 5 are SYNTHETIC heavy-payload versions of real flights. The data has one aircraft, so the fleet is staged. Cargo, destinations and the out-and-back routes are illustrative; the recorded flights are all one triangle."
        >
          Simulated fleet
        </span>
      </div>

      <dl className="ops-stats">
        <div className={alerts ? "alert" : ""}><dt>Alerts</dt><dd className="num">{alerts}</dd></div>
        <div><dt>Your decisions</dt><dd className="num">{decisions.length}</dd></div>
        <div className={crashed ? "alert" : ""}><dt>Crashed</dt><dd className="num">{crashed}</dd></div>
      </dl>

      <div className="ops-clock">
        <span className="ops-time num" title="Simulated mission time">T+ {fmtClock(s.t)} <small>/ {fmtClock(end)}</small></span>
        <button
          className="btn btn-accent"
          onClick={() => s.setPlaying(!s.playing)}
          disabled={!s.loaded || (s.story === "run2" && !s.charge)}
          title={s.story === "run2" && !s.charge ? "Approve the charge plan first" : undefined}
        >
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
    <Panel title="Demo" tag="simulated">
      <div className="run-btns" role="radiogroup" aria-label="Demo run">
        <button role="radio" aria-checked={s.story === "run1"} className="run-btn run-bad" onClick={() => s.startStory("run1")}>
          <b>Run 1</b>
          <span>Today's model</span>
        </button>
        <button role="radio" aria-checked={s.story === "run2"} className="run-btn run-good" onClick={() => s.startStory("run2")}>
          <b>Run 2</b>
          <span>Fixed model</span>
        </button>
      </div>
      {s.story ? <p className="run-desc">{s.hold && s.story === "run1" ? RUN1_HELD_TEXT : RUN_TEXT[s.story]}</p> : <StoryNote story={storyOf(s.condition, s.fix)} note={idx.note} compact />}
      {s.story === "run2" && s.loaded && <ChargePlanBox loaded={s.loaded} />}
      <details className="ops-more">
        <summary>Presenter controls</summary>
        <StoryControls
          story={s.story ? null : storyOf(s.condition, s.fix)}
          onStory={(st) => {
            const { condition, fix } = storySetting(st);
            s.setScenario(condition, fix);
          }}
          rowClass="ops-row"
          fixTitle="The same damaged data run through the sensor check, plus a range guard that scales up the forecast for any package heavier than the model has seen"
        />
        <ScenarioControls idx={idx} condition={s.condition} fix={s.fix} onCondition={s.setCondition} onFix={s.setFix} rowClass="ops-row" fixLabel="sensor check + range guard" />
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
            title="Pause the clock when the AI asks for a decision, and leave the call to you instead of following its best guess"
          >
            <i aria-hidden />
            Hold for decisions
          </button>
          {/* Synthetic flights aren't in the replay's flight list. */}
          {sel && !sel.synthetic && <button className="link-btn" onClick={() => openInReplay(sel)}>Open {sel.slot.callsign} in the replay</button>}
        </div>
      </details>
    </Panel>
  );
}

/** Run 1's description while "Hold for decisions" is on: the operator is not following the AI, they decide. */
const RUN1_HELD_TEXT =
  "The model learned from damaged-sensor data, and today's medical kits (1.0–1.2 kg) are heavier than anything it has seen. Hold is on: when the AI is unsure, the clock stops and you make the call.";

const RUN_TEXT: Record<StoryRun, string> = {
  run1: "The model learned from damaged-sensor data, and today's medical kits (1.0–1.2 kg) are heavier than anything it has seen. The operator follows the AI's call.",
  run2: "Same drones, same kits. The sensor check corrected the bad readings, and the forecast is corrected for the heavier kits. Before launch, it plans each drone's charge.",
};

/** "Drone 1", "Drones 1 and 3", "Drones 1, 3 and 5". */
function droneList(nums: number[]): string {
  if (nums.length === 1) return `Drone ${nums[0]}`;
  return `Drones ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
}

/** Run 2, before launch: what the fixed model says each drone needs, for a person to approve. */
function ChargePlanBox({ loaded }: { loaded: LoadedDrone[] }) {
  const s = useFleet();
  const deadline = useStore((st) => st.model?.deadlineFrac ?? 0.5);
  const plan = useMemo(() => chargePlan(loaded, s.condition, s.fix, deadline), [loaded, s.condition, s.fix, deadline]);
  const approval = s.log.find((l) => l.kind === "plan");
  return (
    <div className={`charge-plan ${s.charge ? "approved" : ""}`}>
      <p className="charge-head">Charge plan before launch</p>
      {plan.length === 0 ? (
        <p className="ops-empty">Every drone already has enough charge.</p>
      ) : (
        <ul>
          {plan.map((p) => {
            const i = loaded.findIndex((d) => d.slot.flight === p.flight);
            return (
              <li key={p.flight}>
                <strong>
                  {i + 1} · {loaded[i].slot.cargo}
                </strong>
                <span className="num">
                  {fmtNum(p.standard)} → <b>{fmtNum(p.charge)} Wh</b>
                </span>
                <small>
                  needs up to {fmtNum(p.need90)} Wh + {Math.round(CHARGE_RESERVE * 100)}% reserve
                </small>
              </li>
            );
          })}
        </ul>
      )}
      {s.charge ? (
        <p className="charge-ok">
          ✓ Approved{approval?.seconds != null && ` after ${fmtNum(approval.seconds)} s of review`}. Batteries topped up.
        </p>
      ) : (
        <button className="btn btn-accent charge-btn" onClick={s.approvePlan}>
          Approve charge plan
        </button>
      )}
    </div>
  );
}

/** One plain sentence over the map for each moment of the guided runs, and the scoreboard at the end. */
function StoryBanner({ loaded, views }: { loaded: LoadedDrone[]; views: DroneView[] }) {
  const s = useFleet();
  if (!s.story) return null;
  const done = s.t >= fleetEnd(loaded);
  const nums = (pick: (v: DroneView, i: number) => boolean) => views.flatMap((v, i) => (pick(v, i) ? [i + 1] : []));
  let tone: "info" | "warn" | "bad" | "good" = "info";
  let text: string;
  // Count the end like the scoreboard: a recalled drone that got home isn't a delivery.
  const recalled = views.filter((v, i) => !v.crashed && s.decisions[loaded[i].slot.flight]?.action === "return").length;
  const delivered = views.filter((v) => !v.crashed).length - recalled;
  const recallNote = recalled ? `, ${recalled} recalled` : "";
  if (s.story === "run1") {
    const down = nums((v) => v.crashed);
    const asking = nums((v) => v.needsDecision);
    const late = nums((v) => /too late to turn back/i.test(v.status));
    const unsure = s.log.filter((l) => l.auto).map((l) => loaded.findIndex((d) => d.slot.flight === l.flight) + 1);
    if (done) {
      tone = "bad";
      text = `Run 1: ${down.length} of ${loaded.length} drones crashed. Only ${delivered} ${delivered === 1 ? "delivery" : "deliveries"} made${recallNote}.`;
    } else if (down.length) {
      tone = "bad";
      text = `${droneList(down)} crashed: the battery ran dry on the way home.`;
    } else if (asking.length) {
      tone = "warn";
      text = `The AI isn't sure about ${droneList(asking).toLowerCase()}. ${s.held ? "The clock is held. " : ""}Your call.`;
    } else if (late.length) {
      tone = "warn";
      text = `Past the halfway point the AI realizes it was wrong: ${droneList(late).toLowerCase()} ${late.length === 1 ? "doesn't" : "don't"} have the energy to get home. Too late to turn back.`;
    } else if (unsure.length) {
      const one = unsure.length === 1;
      text = `The AI calls ${droneList(unsure).toLowerCase()} "too close to call", but its best guess says ${one ? "it'll" : "they'll"} make it. The operator keeps ${one ? "it" : "them"} flying.`;
    } else if (s.t > 0) {
      text = "Five medical drones head out. The AI says every one has enough battery.";
    } else {
      text = "Run 1 · Today's model. All five drones are cleared for launch. Press Start shift.";
    }
  } else {
    const need = Object.keys(s.charge ?? {}).length;
    const planned = chargePlan(loaded, s.condition, s.fix, useStore.getState().model?.deadlineFrac ?? 0.5).map(
      (p) => loaded.findIndex((d) => d.slot.flight === p.flight) + 1,
    );
    const down = nums((v) => v.crashed);
    if (done) {
      tone = down.length ? "bad" : "good";
      text = down.length
        ? `Run 2: ${down.length} crashed. ${delivered} ${delivered === 1 ? "delivery" : "deliveries"} made${recallNote}.`
        : delivered === loaded.length
        ? `Run 2: all ${loaded.length} deliveries made, no crashes.`
        : `Run 2: no crashes. ${delivered} ${delivered === 1 ? "delivery" : "deliveries"} made${recallNote}.`;
    } else if (!s.charge) {
      tone = "warn";
      text = `Before launch, the fixed model says ${droneList(planned).toLowerCase()} need more charge than usual. Review and approve the charge plan.`;
    } else if (nums((v) => v.needsDecision).length) {
      tone = "warn";
      text = `The AI isn't sure about ${droneList(nums((v) => v.needsDecision)).toLowerCase()}. ${s.held ? "The clock is held. " : ""}Your call.`;
    } else if (s.t === 0) {
      tone = "good";
      text = `Charge plan approved: ${need} batteries topped up. Press Start shift.`;
    } else {
      text = `Every drone has the energy for the round trip, plus a ${Math.round(CHARGE_RESERVE * 100)}% reserve.`;
    }
  }
  const r1 = s.results.run1;
  const r2 = s.results.run2;
  return (
    <div className="story-wrap">
      <p className={`story-banner tone-${tone}`} role="status">
        {text}
      </p>
      {done && r1 && r2 && (
        <table className="scoreboard">
          <thead>
            <tr>
              <th />
              <th scope="col">Run 1 · today</th>
              <th scope="col">Run 2 · fixed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Deliveries made</th>
              <td className="bad">{r1.delivered}</td>
              <td className="good">{r2.delivered}</td>
            </tr>
            <tr>
              <th scope="row">Drones crashed</th>
              <td className="bad">{r1.crashed}</td>
              <td className="good">{r2.crashed}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
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
              <span>{v.guarded && v.call.type === "review" ? "Outside training data" : callLabel(v.call.type)}</span>
            </div>
            {e && (
              <p>
                {v.guarded && `Corrected for the ${fmtMass(d.meta.payload)} package: `}
                Needs {fmtNum(e.need50)}–{fmtNum(e.need90)} Wh, battery {fmtNum(v.budget)} Wh.
              </p>
            )}
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
  // Before takeoff, show the launch check: the forecast the drone gets as it lifts off.
  const preflight = v.state.phase === "standby";
  const e = preflight ? v.launch.est : v.state.est;
  const canAct = !decision && !v.settled && v.state.phase !== "standby" && v.state.phase !== "na";
  const health = idx?.health[`${s.condition}/${s.fix ? "on" : "off"}/${d.window}`];
  const live = preflight ? v.launch.call : v.state.live;

  return (
    <Panel title={`${d.slot.callsign}: ${d.slot.cargo}`} tag={`${fmtNum(v.budget)} Wh pack`}>
      <p className="fc-sub">
        To {d.slot.destination}, {fmtNum(d.oneWayM / 1000, 2)} km out from the hub · {fmtMass(d.meta.payload)} package
      </p>
      {d.synthetic && (
        <p className="syn-box">
          <span className="sim-tag">Synthetic</span> Real flight {d.synthetic.basedOn} ({fmtMass(d.synthetic.sourcePayloadG)}) re-run at{" "}
          {fmtMass(d.meta.payload)}: battery current ×{fmtNum(d.synthetic.currentFactor, 2)} while the motors run. Route, speed, altitude and
          wind are as recorded.
        </p>
      )}
      <div className={`fd-rec tone-${live === "return" ? "stop" : live === "review" ? "warn" : live === "continue" ? "go" : "idle"}`}>
        <span className="fd-rec-label" title={preflight ? "The forecast made as the drone lifts off, 5 s after the rotors start" : undefined}>
          {preflight ? "Launch check" : "System recommends"}
        </span>
        <strong>{preflight ? v.status : live ? callLabel(live) : "Waiting for takeoff"}</strong>
        {v.guarded && (
          <p>
            Range guard: this {fmtMass(d.meta.payload)} package is heavier than anything in the training data (up to{" "}
            {fmtMass(d.trainedMaxG[`${s.condition}/on`])}), so the forecast is scaled up ×{fmtNum(v.payloadFactor, 2)} for the extra weight,
            using the weight-to-power rule fitted on real flights.
          </p>
        )}
        {e && (
          <p>
            Forecast {fmtNum(e.need50)}–{fmtNum(e.need90)} Wh against {fmtNum(v.budget)} Wh
            {e.margin >= 0 ? `: ${fmtNum(e.margin)} Wh to spare.` : `: the cautious end is ${fmtNum(-e.margin)} Wh over.`}
          </p>
        )}
      </div>

      {s.fix && idx && (
        <details className="ops-more" open>
          <summary>How the fix cleans the data</summary>
          <FixSteps idx={idx} condition={s.condition} window={d.window} guardMaxG={d.trainedMaxG[`${s.condition}/on`]} />
        </details>
      )}
      <details className="ops-more">
        <summary>Forecast chart</summary>
        <Evidence d={d} v={v} t={s.t} />
      </details>
      {idx && health && (
        <Health idx={idx} health={health} window={d.window} fix={s.fix}>
          <FlagLink />
        </Health>
      )}

      {decision?.auto ? (
        <p className="fd-chose">
          Followed the AI's best guess: <strong>continued</strong> at {fmtClock(decision.at)}.
        </p>
      ) : decision ? (
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
            {l.kind === "plan" && (
              <span>
                Approved the charge plan: {(l.charges ?? []).map((c) => `${name(c.flight)} → ${fmtNum(c.charge)} Wh`).join(", ")}
                {l.seconds !== null && ` (reviewed in ${fmtNum(l.seconds)} s)`}
              </span>
            )}
            {l.kind === "decision" && l.auto && (
              <span>{name(l.flight)}: system said Too close to call; the operator followed its best guess and kept flying</span>
            )}
            {l.kind === "decision" && !l.auto && (
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
  // Before takeoff the gauge shows the launch check; after that, the live forecast.
  const e = started ? v.state.est : v.launch.est;
  const top = Math.max(v.budget, e?.need90 ?? 0, v.usedWh) * 1.12;
  const leftPct = Math.max(0, Math.round(((v.budget - v.usedWh) / v.budget) * 100));
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / top) * 100))}%`;

  return (
    <button className={`dp tone-${v.tone} ${selected ? "selected" : ""} ${v.needsDecision ? "asking" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <div className="dp-head">
        <i className="lamp on" aria-hidden />
        <strong>{index + 1} · {d.slot.cargo}</strong>
        <span className="dp-status">{v.status}</span>
      </div>
      <p className="dp-dest">
        to {d.slot.destination} · {fmtMass(d.meta.payload)}
        {d.synthetic && <span className="sim-tag dp-syn" title={`Synthetic: real flight ${d.synthetic.basedOn} re-run at a heavier payload`}>Synthetic</span>}
      </p>
      <p className="dp-line num">
        {v.crashed
          ? crashLine(series, pathTime(crashAt(d, decision, v.budget) ?? 0, decision))
          : started
          ? `${fmtNum(Math.max(at(series.up), 0), 0)} m · ${fmtNum(at(series.groundSpeed), 1)} m/s · ${fmtNum(at(series.voltage), 1)} V · ${fmtNum(Math.max(at(series.power), 0), 0)} W`
          : `Launch check: needs ${fmtNum(v.launch.est.need50)}–${fmtNum(v.launch.est.need90)} Wh`}
      </p>
      <div className="dp-gauge" aria-hidden>
        <div className="dp-used" style={{ width: pct(v.usedWh) }} />
        {e && v.state.phase !== "landed" && (
          <div className="dp-need" style={{ left: pct(v.usedWh), width: `calc(${pct(e.need90)} - ${pct(v.usedWh)})` }} />
        )}
        <div className="dp-budget" style={{ left: pct(v.budget) }} />
      </div>
      <span className={`dp-foot num ${started && leftPct <= 5 ? "low" : ""}`}>
        {started ? `${fmtNum(v.usedWh, 1)} of ${fmtNum(v.budget)} Wh used · ${leftPct}% left` : `${fmtNum(v.budget)} Wh pack`}
      </span>
      {v.verdict && <p className={`fc-verdict ${VERDICT_TEXT[v.verdict].good ? "good" : "bad"}`}>{VERDICT_TEXT[v.verdict].label}</p>}
    </button>
  );
}

/** A payload in grams, as "250 g" or "1.2 kg". */
function fmtMass(g: number): string {
  return g >= 1000 ? `${fmtNum(g / 1000, 1)} kg` : `${fmtNum(g, 0)} g`;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${fmtNum(v, 0)}%`;
}

/** Where a drone went down: its distance from the hub and height when the pack ran dry. */
function crashLine(series: LoadedDrone["series"], emptyAt: number): string {
  const { i, f } = sampleAt(series.t, emptyAt);
  const km = Math.hypot(lerpAt(series.east, i, f), lerpAt(series.north, i, f)) / 1000;
  const up = fmtNum(lerpAt(series.up, i, f), 0);
  // The recorded flights end with a vertical descent over the pad, which is where a short pack usually gives out.
  return km < 0.05 ? `Ran dry ${up} m above its pad on the final descent` : `Went down ${fmtNum(km, 2)} km from the hub, ${up} m up`;
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

function FlagLink() {
  const flagged = useFleet((s) => s.flagged);
  const flag = useFleet((s) => s.flag);
  return (
    <button className="link-btn" disabled={flagged} onClick={flag} title="Tell the data-quality owner that the damaged sensors' records need checking">
      {flagged ? "Data source flagged to the data-quality owner" : "Flag data source"}
    </button>
  );
}
