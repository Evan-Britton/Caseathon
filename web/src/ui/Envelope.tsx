import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { loadEnvelope } from "../data";
import { AXES, checkEnvelope, type EnvelopeCheck } from "../envelope";
import { useStore } from "../store";
import type { EnvelopeAxis, EnvelopeData, EnvelopePoint } from "../types";
import { fmtNum } from "./format";

/**
 * The model's training envelope in 3D: every real CMU flight by payload, speed and wind, the trained
 * range around them, and a pre-launch check for a planned mission. Drag to turn the plot.
 */

// Plot range on each axis: wider than the trained range, so what falls outside it has room to show.
const VIEW: Record<EnvelopeAxis, [number, number]> = { payload: [0, 1500], speed: [0, 16], wind: [0, 14] };
const TICKS: Record<EnvelopeAxis, number[]> = { payload: [0, 500, 1000, 1500], speed: [0, 4, 8, 12, 16], wind: [0, 5, 10] };
const SLIDER: Record<EnvelopeAxis, { min: number; max: number; step: number }> = {
  payload: { min: 0, max: 1500, step: 50 },
  speed: { min: 2, max: 16, step: 1 },
  wind: { min: 0, max: 14, step: 0.5 },
};
const DIGITS: Record<EnvelopeAxis, number> = { payload: 0, speed: 0, wind: 1 };

const PRESETS: { label: string; p: EnvelopePoint }[] = [
  { label: "Typical delivery", p: { payload: 500, speed: 6, wind: 5.5 } },
  { label: "1.2 kg medical kit", p: { payload: 1200, speed: 4, wind: 3.7 } },
  { label: "750 g at 12 m/s", p: { payload: 750, speed: 12, wind: 6 } },
  { label: "Storm wind", p: { payload: 500, speed: 8, wind: 12 } },
];

const W = 560;
const H = 440;
const CX = W / 2;
const CY = H / 2 + 10;
const SCALE = 150;
const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const fmt = (axis: EnvelopeAxis, v: number) => fmtNum(v, DIGITS[axis]);

/** Data value on an axis, scaled to -1..1 across the plot range. */
function norm(axis: EnvelopeAxis, v: number): number {
  const [lo, hi] = VIEW[axis];
  return ((v - lo) / (hi - lo)) * 2 - 1;
}

interface View {
  yaw: number;
  pitch: number;
}

/** Screen position and depth (larger is nearer) of a point. Payload runs along x, wind up, speed along z. */
function project(v: View, p: EnvelopePoint): { x: number; y: number; d: number } {
  const x = norm("payload", p.payload);
  const y = norm("wind", p.wind);
  const z = norm("speed", p.speed);
  const x1 = x * Math.cos(v.yaw) + z * Math.sin(v.yaw);
  const z1 = -x * Math.sin(v.yaw) + z * Math.cos(v.yaw);
  const y2 = y * Math.cos(v.pitch) - z1 * Math.sin(v.pitch);
  const z2 = y * Math.sin(v.pitch) + z1 * Math.cos(v.pitch);
  return { x: CX + x1 * SCALE, y: CY - y2 * SCALE, d: z2 };
}

/** A short note and the button that opens the 3D view, shown where the model is explained. */
export function EnvelopeLink() {
  const flights = useStore((s) => s.results?.baseline.flights);
  const setOpen = useStore((s) => s.setEnvelopeOpen);
  return (
    <div className="mission-envelope">
      <div className="mission-envelope-head">
        <span className="mission-envelope-title">
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8Z M2 4.8 8 8l6-3.2 M8 8v6.5" />
          </svg>
          Training envelope
        </span>
        <button className="mission-envelope-btn" onClick={() => setOpen(true)}>
          Open 3D view
        </button>
      </div>
      <p>
        The model is only trusted inside the conditions it was trained on: payload, speed and wind from {flights ?? "the"} real flights.
        Before launch, a mission outside them goes to the operator.
      </p>
    </div>
  );
}

export function Envelope() {
  const open = useStore((s) => s.envelopeOpen);
  const setOpen = useStore((s) => s.setEnvelopeOpen);
  const [env, setEnv] = useState<EnvelopeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || env) return;
    loadEnvelope().then(setEnv, (e: Error) => setError(e.message));
  }, [open, env]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="env-overlay" role="dialog" aria-modal="true" aria-label="Training envelope" onClick={() => setOpen(false)}>
      <section className="env-card glass" onClick={(e) => e.stopPropagation()}>
        <header className="env-head">
          <div>
            <h2>
              <span className="req" title="Case prompt requirement 6: Demonstrate a countermeasure">R6</span>
              Training envelope
            </h2>
            <p>Where the energy model has seen real data, and the check that runs before every launch.</p>
          </div>
          <button className="btn" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>
        {env ? <EnvelopeBody env={env} /> : <p className="env-loading">{error ?? "Loading the training data…"}</p>}
      </section>
    </div>
  );
}

function EnvelopeBody({ env }: { env: EnvelopeData }) {
  const [mission, setMission] = useState<EnvelopePoint>(PRESETS[0].p);
  const [showSynthetic, setShowSynthetic] = useState(true);
  const [showInjected, setShowInjected] = useState(false);
  const check = checkEnvelope(env, mission);
  const injectedFlagged = useMemo(() => env.injected.filter((p) => !checkEnvelope(env, p).inside).length, [env]);
  const syntheticFlagged = useMemo(() => env.synthetic.filter((p) => !checkEnvelope(env, p).inside).length, [env]);

  return (
    <div className="env-body">
      <div className="env-plot-col">
        <Plot env={env} mission={mission} inside={check.inside} showSynthetic={showSynthetic} showInjected={showInjected} />
        <div className="env-legend">
          <span>
            <i className="env-key train" />
            {env.flights.length} real CMU flights (training data)
          </span>
          <span>
            <i className="env-key box" />
            Trained range
          </span>
          <label>
            <input type="checkbox" checked={showSynthetic} onChange={(e) => setShowSynthetic(e.target.checked)} />
            <i className="env-key synth" />
            Heavy medical kits, 1.0–1.2 kg ({syntheticFlagged} of {env.synthetic.length} flagged)
          </label>
          <label>
            <input type="checkbox" checked={showInjected} onChange={(e) => setShowInjected(e.target.checked)} />
            <i className="env-key inject" />
            Poisoned records <span className="sim-tag inline">Simulated</span>
          </label>
        </div>
        {showInjected && (
          <p className="env-note warn">
            Records an attacker could slip into the training feed, far outside anything really flown. The same check would flag all{" "}
            {injectedFlagged} of {env.injected.length} before the model retrains on them. Illustration only, not part of the measured results.
          </p>
        )}
        <p className="env-note">
          Drag to turn. Wind is the onboard anemometer reading while flying, which mixes the wind with the drone's own motion.
        </p>
      </div>

      <div className="env-side">
        <h3>Check a mission before launch</h3>
        <div className="env-presets">
          {PRESETS.map((pr) => (
            <button
              key={pr.label}
              className={`chip-btn ${AXES.every((a) => pr.p[a] === mission[a]) ? "active" : ""}`}
              onClick={() => setMission(pr.p)}
            >
              {pr.label}
            </button>
          ))}
        </div>
        {AXES.map((axis) => (
          <AxisSlider key={axis} env={env} axis={axis} value={mission[axis]} onChange={(v) => setMission({ ...mission, [axis]: v })} />
        ))}
        <Verdict env={env} check={check} />
        <p className="env-note">
          Damaged sensors don't show up here: their missions look normal, only the energy reading is wrong. That's why the sensor check is
          needed as well.
        </p>
      </div>
    </div>
  );
}

function AxisSlider({ env, axis, value, onChange }: { env: EnvelopeData; axis: EnvelopeAxis; value: number; onChange: (v: number) => void }) {
  const { label, unit } = env.axes[axis];
  const [min, max] = env.ranges[axis];
  const s = SLIDER[axis];
  const out = value < min || value > max;
  return (
    <div className="env-slider">
      <label htmlFor={`env-${axis}`}>
        <span>{label}</span>
        <span className={`num ${out ? "bad" : ""}`}>
          {fmt(axis, value)} {unit}
        </span>
      </label>
      <input id={`env-${axis}`} type="range" min={s.min} max={s.max} step={s.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="env-range">
        Trained on {fmt(axis, min)}–{fmt(axis, max)} {unit}
      </span>
    </div>
  );
}

function Verdict({ env, check }: { env: EnvelopeData; check: EnvelopeCheck }) {
  if (check.inside)
    return (
      <div className="env-verdict good">
        <p className="env-verdict-title">Inside the envelope</p>
        <p>
          {check.similar} real training {check.similar === 1 ? "flight" : "flights"} flew within {fmtNum(env.near.payload, 0)} g,{" "}
          {fmtNum(env.near.speed, 0)} m/s and {fmtNum(env.near.wind, 0)} m/s of wind of this mission. The model has seen missions like it,
          so its forecast can be trusted.
        </p>
      </div>
    );
  const off = check.axes.filter((a) => a.where !== "ok");
  const heavy = off.some((a) => a.axis === "payload" && a.where === "above");
  const windy = off.some((a) => a.axis === "wind" && a.where === "above");
  const speed = off.some((a) => a.axis === "speed");
  return (
    <div className="env-verdict bad">
      <p className="env-verdict-title">Outside what the model learned</p>
      <ul>
        {off.map((a) => {
          const { label, unit } = env.axes[a.axis];
          return (
            <li key={a.axis}>
              {label} {fmt(a.axis, a.value)} {unit} is {a.where === "above" ? "above" : "below"} anything it trained on (
              {a.where === "above" ? "max" : "min"} {fmt(a.axis, a.where === "above" ? a.max : a.min)} {unit}).
            </li>
          );
        })}
        {off.length === 0 && <li>Every condition is in range, but no training flight flew this combination.</li>}
      </ul>
      <p className="env-verdict-sub">Its forecast here would be a guess, so before launch the system:</p>
      <ul>
        <li>Won't clear the mission on its own. The call goes to the operator.</li>
        {heavy && <li>Scales the forecast up for the extra weight (the range guard), so the charge plan asks for more battery.</li>}
        {windy && <li>Suggests waiting for the wind to drop, a bigger battery, or a calmer route.</li>}
        {speed && <li>Suggests flying at a trained speed ({fmt("speed", env.ranges.speed[0])}–{fmt("speed", env.ranges.speed[1])} m/s).</li>}
      </ul>
    </div>
  );
}

type Mark = { key: string; x: number; y: number; d: number; kind: "train" | "synth" | "inject" };

function Plot({
  env,
  mission,
  inside,
  showSynthetic,
  showInjected,
}: {
  env: EnvelopeData;
  mission: EnvelopePoint;
  inside: boolean;
  showSynthetic: boolean;
  showInjected: boolean;
}) {
  const [view, setView] = useState<View>({ yaw: -0.65, pitch: 0.42 });
  const auto = useRef(!reducedMotion);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Turn slowly until the viewer grabs it.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (auto.current) setView((v) => ({ ...v, yaw: v.yaw + dt * 0.22 }));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    auto.current = false;
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ yaw: v.yaw + dx * 0.008, pitch: Math.min(Math.max(v.pitch + dy * 0.006, 0.05), 1.35) }));
  };
  const onUp = () => void (drag.current = null);

  const at = (payload: number, speed: number, wind: number) => project(view, { payload, speed, wind });
  const [pLo, pHi] = VIEW.payload;
  const [sLo, sHi] = VIEW.speed;
  const [wLo, wHi] = VIEW.wind;

  // The trained range as a box: 8 corners, 6 faces drawn back to front, 12 edges.
  const r = env.ranges;
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(r.payload[i & 1], r.speed[(i >> 1) & 1], r.wind[(i >> 2) & 1]));
  const faces = [
    [0, 1, 3, 2],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 3, 7, 5],
  ]
    .map((f) => ({ f, d: f.reduce((s, i) => s + corners[i].d, 0) / 4 }))
    .sort((a, b) => a.d - b.d);
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const marks: Mark[] = [
    ...env.flights.map((f) => ({ key: `f${f.id}`, kind: "train" as const, ...at(f.payload, f.speed, f.wind) })),
    ...(showSynthetic ? env.synthetic.map((f) => ({ key: `s${f.id}`, kind: "synth" as const, ...at(f.payload, f.speed, f.wind) })) : []),
    ...(showInjected ? env.injected.map((f, i) => ({ key: `i${i}`, kind: "inject" as const, ...at(f.payload, f.speed, f.wind) })) : []),
  ].sort((a, b) => a.d - b.d);

  const m = at(mission.payload, mission.speed, mission.wind);
  const mFloor = at(mission.payload, mission.speed, wLo);
  const fade = (d: number) => 0.35 + 0.65 * Math.min(Math.max((d + 1.7) / 3.4, 0), 1);
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("") + "Z";

  return (
    <svg
      className="env-plot"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`3D scatter of ${env.flights.length} training flights by payload, speed and wind, with the trained range drawn as a box`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* Floor grid at zero wind */}
      {TICKS.payload.map((v) => {
        const a = at(v, sLo, wLo);
        const b = at(v, sHi, wLo);
        return <line key={`gp${v}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="env-grid" />;
      })}
      {TICKS.speed.map((v) => {
        const a = at(pLo, v, wLo);
        const b = at(pHi, v, wLo);
        return <line key={`gs${v}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="env-grid" />;
      })}
      {/* Wind axis */}
      {(() => {
        const a = at(pLo, sLo, wLo);
        const b = at(pLo, sLo, wHi);
        return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="env-axis" />;
      })()}

      {faces.map(({ f }, k) => (
        <path key={`face${k}`} d={path(f.map((i) => corners[i]))} className="env-face" />
      ))}

      {marks.map((p) =>
        p.kind === "train" ? (
          <circle key={p.key} cx={p.x} cy={p.y} r={3} className="env-pt train" opacity={fade(p.d)} />
        ) : p.kind === "synth" ? (
          <rect key={p.key} x={p.x - 5} y={p.y - 5} width={10} height={10} transform={`rotate(45 ${p.x} ${p.y})`} className="env-pt synth" opacity={fade(p.d)} />
        ) : (
          <g key={p.key} className="env-pt inject" opacity={fade(p.d)}>
            <line x1={p.x - 5} y1={p.y - 5} x2={p.x + 5} y2={p.y + 5} />
            <line x1={p.x - 5} y1={p.y + 5} x2={p.x + 5} y2={p.y - 5} />
          </g>
        ),
      )}

      {edges.map(([a, b]) => (
        <line key={`e${a}${b}`} x1={corners[a].x} y1={corners[a].y} x2={corners[b].x} y2={corners[b].y} className="env-edge" />
      ))}

      {/* The mission being checked, with a drop line to the floor */}
      <line x1={m.x} y1={m.y} x2={mFloor.x} y2={mFloor.y} className={`env-drop ${inside ? "good" : "bad"}`} />
      <circle cx={mFloor.x} cy={mFloor.y} r={3} className={`env-foot ${inside ? "good" : "bad"}`} />
      <circle cx={m.x} cy={m.y} r={13} className={`env-halo ${inside ? "good" : "bad"}`} />
      <circle cx={m.x} cy={m.y} r={7} className={`env-mission ${inside ? "good" : "bad"}`} />

      {/* Tick labels and axis names */}
      {TICKS.payload.map((v) => {
        const p = at(v, sLo, wLo);
        return (
          <text key={`tp${v}`} x={p.x} y={p.y + 14} className="env-tick" textAnchor="middle">
            {v}
          </text>
        );
      })}
      {TICKS.speed.slice(1).map((v) => {
        const p = at(pLo, v, wLo);
        return (
          <text key={`ts${v}`} x={p.x - 8} y={p.y + 4} className="env-tick" textAnchor="end">
            {v}
          </text>
        );
      })}
      {TICKS.wind.slice(1).map((v) => {
        const p = at(pLo, sLo, v);
        return (
          <text key={`tw${v}`} x={p.x - 8} y={p.y + 4} className="env-tick" textAnchor="end">
            {v}
          </text>
        );
      })}
      {(
        [
          [at(pHi * 1.08, sLo, wLo), "Payload (g)"],
          [at(pLo, sHi * 1.1, wLo), "Speed (m/s)"],
          [at(pLo, sLo, wHi * 1.07), "Wind (m/s)"],
        ] as const
      ).map(([p, label]) => (
        <text key={label} x={p.x} y={p.y} className="env-axis-name" textAnchor="middle">
          {label}
        </text>
      ))}
    </svg>
  );
}
