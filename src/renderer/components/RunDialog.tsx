import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast, useDeck } from "../state/store";
import { formatTokens, modelLabel } from "@shared/models";
import type { Agent } from "@shared/types";
import type { PipelineSpec, StepProgress } from "@shared/ipc";
import { Icon, ModelChip } from "./ui";
import { CHAT_KEY } from "@shared/teamMap";

const close = () => useDeck.setState({ runOpen: false });

/** The hand-off order you drew (left to right on the canvas), else every agent of yours. */
function defaultSteps(agents: Record<string, Agent>, links: { from: string; to: string; kind: string; planned: boolean }[], orch: string | null, x: (k: string) => number): string[] {
  const lead = orch ?? CHAT_KEY; // your chat hands the work out unless an agent is the orchestrator
  const handOffs = links.filter((l) => l.planned && l.kind === "delegates" && l.from === lead && agents[l.to]).map((l) => l.to);
  const keys = handOffs.length ? handOffs : Object.values(agents).filter((a) => a.kind === "subagent" || a.kind === "agy").map((a) => a.key);
  return [...new Set(keys)].sort((a, b) => x(a) - x(b)).map((k) => agents[k].name);
}

function Setup() {
  const s = useDeck(useShallow((st) => ({ agents: st.agents, saved: st.saved, links: st.links, orch: st.orchestratorKey, positions: st.positions, checks: st.checks, dirty: st.summaries.length > 0, real: st.mode === "real" })));
  const team = useMemo(() => Object.values(s.saved.agents).filter((a) => a.kind !== "builtin" && !a.disabled).sort((a, b) => a.name.localeCompare(b.name)), [s.saved.agents]);
  const byName = (n: string) => team.find((a) => a.name === n && a.sameName?.usedByClaude !== false) ?? team.find((a) => a.name === n);
  const [task, setTask] = useState("");
  const [steps, setSteps] = useState<string[]>(() => defaultSteps(s.saved.agents, s.saved.links, s.saved.orchestratorKey, (k) => s.positions[k]?.x ?? 0));
  const [mode, setMode] = useState<PipelineSpec["permissionMode"]>("plan");
  const [maxTurns, setMaxTurns] = useState(20);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const move = (i: number, d: number) => setSteps((st) => { const n = [...st]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  const missing = steps.filter((n) => !byName(n));
  const canStart = task.trim() && steps.length > 0 && steps.length <= 8 && !missing.length;

  const start = async () => {
    const spec: PipelineSpec = { task, steps: steps.map((agent) => ({ agent, ...(byName(agent)?.effort && byName(agent)?.kind !== "agy" ? { effort: byName(agent)!.effort } : {}) })), permissionMode: mode, maxTurns, stopOnFailure };
    if (!s.real) { toast("Runs in the real app", "In the prototype, pipelines are only a preview."); return; }
    const r = await window.crewglass!.runPipeline(spec);
    if (!r.ok) toast("Pipeline didn't start", r.error ?? "Unknown error");
  };

  return (
    <>
      <div className="col" style={{ gap: 12, padding: 16, overflow: "auto" }}>
        <div className="field">
          <label>Task</label>
          <textarea className="input" rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Add input validation to the signup form" />
          <span className="muted small">Each step gets this task plus the previous step's answer.</span>
        </div>
        <div className="field">
          <label>Steps, in order</label>
          {steps.map((n, i) => {
            const a = byName(n);
            const checks = a ? a.checks.map((c) => s.checks[c]?.label ?? c) : [];
            return (
              <div key={`${n}-${i}`} className="row card-box" style={{ gap: 8, padding: "6px 10px", marginBottom: 6 }}>
                <span className="muted small" style={{ width: 16 }}>{i + 1}</span>
                <select className="select" value={n} onChange={(e) => setSteps((st) => st.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Step ${i + 1} agent`}>
                  {!a && <option value={n}>{n} (not saved)</option>}
                  {team.map((t) => <option key={t.key} value={t.name}>{t.name}</option>)}
                </select>
                {a && (a.kind === "agy" ? <ModelChip model={a.geminiModel ?? ""} prefix="agy · " /> : <ModelChip model={a.model} effort={a.effort} />)}
                <span className="small muted grow truncate">{checks.length ? `checks: ${checks.join(", ")}` : "no checks"}</span>
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="down" size={13} /></button>
                <button className="icon-btn" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down" style={{ transform: "rotate(180deg)" }}><Icon name="down" size={13} /></button>
                <button className="icon-btn" onClick={() => setSteps((st) => st.filter((_, j) => j !== i))} aria-label="Remove step"><Icon name="x" size={13} /></button>
              </div>
            );
          })}
          {steps.length < 8 && team.length > 0 && (
            <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setSteps((st) => [...st, team.find((t) => t.kind !== "orchestrator")?.name ?? team[0].name])}>
              <Icon name="plus" size={13} /> Add step</button>
          )}
          {!team.length && <span className="muted small">Save a team first — the pipeline runs your saved agents.</span>}
        </div>
        <div className="row" style={{ gap: 18, alignItems: "flex-start" }}>
          <div className="field">
            <label>What steps may do</label>
            <div className="seg" role="radiogroup">
              <button className={mode === "plan" ? "on" : ""} role="radio" aria-checked={mode === "plan"} onClick={() => setMode("plan")}>Read only</button>
              <button className={mode === "acceptEdits" ? "on" : ""} role="radio" aria-checked={mode === "acceptEdits"} onClick={() => setMode("acceptEdits")}>Can edit files</button>
            </div>
            <span className="muted small">{mode === "plan" ? "Claude's plan mode: steps can read and answer, not change anything." : "Steps may edit files in this folder (other commands still need permission)."}</span>
          </div>
          <div className="field" style={{ width: 120 }}>
            <label>Max turns per step</label>
            <input className="input" type="number" min={1} max={200} value={maxTurns} onChange={(e) => setMaxTurns(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
          </div>
        </div>
        <label className="checkbox"><input type="checkbox" checked={stopOnFailure} onChange={(e) => setStopOnFailure(e.target.checked)} /> Stop if a step fails (or its checks still fail after 2 fix rounds)</label>
        {s.dirty && <div className="hint"><Icon name="info" size={15} /><span>You have unsaved edits. The pipeline runs your agents as they're saved.</span></div>}
        {missing.length > 0 && <div className="hint"><Icon name="alert" size={15} /><span>{missing.join(", ")} isn't saved yet. Save it first, or choose another agent.</span></div>}
      </div>
      <div className="dialog-foot">
        <span className="muted small">Each step is a separate <span className="mono">claude -p --agent …</span> run in this folder. Output stays in memory.</span>
        <div className="spacer" />
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!canStart} onClick={() => void start()}><Icon name="play" size={13} /> Run {steps.length} step{steps.length === 1 ? "" : "s"}</button>
      </div>
    </>
  );
}

const STEP_TEXT: Record<StepProgress["status"], string> = { waiting: "Waiting", running: "Running", checking: "Checking", fixing: "Fixing", done: "Done", failed: "Failed", stopped: "Stopped" };

function Progress() {
  const p = useDeck((st) => st.pipeline)!;
  const [sel, setSel] = useState(0);
  const running = p.status === "running";
  useEffect(() => {
    const active = p.steps.findIndex((x) => x.status === "running" || x.status === "checking" || x.status === "fixing");
    if (active >= 0) setSel(active);
  }, [p.steps]);
  const step = p.steps[sel];
  const copy = () => { void navigator.clipboard.writeText(step?.output ?? "").then(() => toast("Copied", `${step.agent}'s output is on the clipboard.`)); };
  return (
    <>
      <div className="dialog-body" style={{ gridTemplateColumns: "300px 1fr" }}>
        <div className="change-list">
          <div className="small muted" style={{ marginBottom: 8 }}>{p.task}</div>
          {p.steps.map((x) => (
            <div key={x.index} className={`file-item ${x.index === sel ? "on" : ""}`} onClick={() => setSel(x.index)} role="button" tabIndex={0}>
              <Icon name={x.status === "done" ? "check" : x.status === "failed" ? "alert" : x.status === "stopped" ? "stop" : x.status === "waiting" ? "right" : "sparkle"} size={14} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}><b>{x.index + 1}. {x.agent}</b><span className={`badge ${x.status === "done" ? "good" : x.status === "failed" ? "bad" : ""}`}>{STEP_TEXT[x.status]}{x.tries ? ` · fix round ${x.tries}/2` : ""}</span></div>
                <div className="small muted truncate">
                  {x.model ? modelLabel(x.model) : "—"} · {formatTokens(x.tokens)} tok{x.ms ? ` · ${Math.round(x.ms / 1000)} s` : ""}{x.lastTool && x.status === "running" ? ` · ${x.lastTool}` : ""}
                </div>
                {x.checks.map((c) => <div key={c.label} className="small" style={{ color: c.ok ? "var(--good-ink)" : "var(--critical-ink)" }}>{c.ok ? "✓" : "✗"} {c.label}</div>)}
              </div>
            </div>
          ))}
          {p.error && <div className="hint" style={{ marginTop: 8 }}><Icon name="alert" size={14} /><span>{p.error}</span></div>}
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div className="row" style={{ padding: "8px 12px", gap: 8 }}>
            <b className="grow">{step ? `${step.agent} — output` : ""}</b>
            <button className="btn small" disabled={!step?.output} onClick={copy}><Icon name="copy" size={13} /> Copy</button>
          </div>
          <pre className="diff" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{step?.output || (step?.status === "waiting" ? "Not started yet." : "…")}
            {step?.checks.filter((c) => !c.ok && c.tail).map((c) => `\n\n── ${c.label} failed ──\n${c.tail}`).join("")}</pre>
        </div>
      </div>
      <div className="dialog-foot">
        <span className="muted small">{running ? "Running…" : p.status === "done" ? "All steps done." : p.status === "stopped" ? "Stopped." : "Stopped at a failed step."} {p.permissionMode === "plan" ? "Read only." : "Steps could edit files."}</span>
        <div className="spacer" />
        {running
          ? <button className="btn danger" onClick={() => void window.crewglass?.stopPipeline()}><Icon name="stop" size={12} /> Stop</button>
          : <><button className="btn" onClick={() => useDeck.setState({ pipeline: null })}>New run</button><button className="btn primary" onClick={close}>Close</button></>}
      </div>
    </>
  );
}

export function RunDialog() {
  const open = useDeck((st) => st.runOpen);
  const hasRun = useDeck((st) => !!st.pipeline);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Run pipeline">
        <div className="dialog-head">
          <h2 className="grow">Run pipeline</h2>
          <span className="muted small">Your steps, in a guaranteed order, with checks in between.</span>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        {hasRun ? <Progress /> : <Setup />}
      </div>
    </div>
  );
}
