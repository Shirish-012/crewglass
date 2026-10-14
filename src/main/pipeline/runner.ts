// Run pipeline (plan §6.5): your steps, in a guaranteed order. Each step is one `claude -p --agent <name>` run in the
// folder, given the task plus the previous step's output; the step agent's command checks run in between, and a
// failed check sends that step back to fix (at most 2 rounds). Stop ends the running step's whole process group.
// Output is kept in memory only (shown live, copyable); nothing from it is written to disk.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Effort } from "@shared/types";
import type { PipelineProgress, PipelineSpec, StepProgress } from "@shared/ipc";
import { EFFORTS } from "@shared/models";
import type { CheckDef, CheckResult } from "../checks/runner";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/;
const MAX_OUTPUT = 200_000;
const MAX_HANDOFF = 20_000;
const MAX_FIX_ROUNDS = 2;
const CHECKS_BUDGET_MS = 5 * 60_000;

export interface PipelineDeps {
  claudeBin: string;
  folder: string;
  checksFor(agent: string, caller?: string): CheckDef[];
  runCheck(def: CheckDef, cwd: string, signal: AbortSignal): Promise<CheckResult>;
  onProgress(p: PipelineProgress): void;
  /** A step's Claude session id, as soon as it's known (Live mode then leaves its checks to the pipeline). */
  onSession(sessionId: string): void;
}

export function validSpec(x: unknown): PipelineSpec | string {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  if (typeof o.task !== "string" || !o.task.trim()) return "Describe the task first.";
  if (o.task.length > 20_000) return "The task is too long.";
  if (!Array.isArray(o.steps) || !o.steps.length || o.steps.length > 8) return "A pipeline has 1 to 8 steps.";
  const steps: PipelineSpec["steps"] = [];
  for (const s of o.steps as Record<string, unknown>[]) {
    if (typeof s?.agent !== "string" || !NAME_RE.test(s.agent)) return "Each step needs one of your agents.";
    if (s.effort !== undefined && !EFFORTS.includes(s.effort as Effort)) return "Unknown effort level.";
    steps.push({ agent: s.agent, ...(s.effort ? { effort: s.effort as Effort } : {}) });
  }
  // Never "bypass": read-only by default, or allowed to edit files.
  if (o.permissionMode !== "plan" && o.permissionMode !== "acceptEdits") return "Choose read-only or can-edit.";
  const maxTurns = Number(o.maxTurns);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) return "Max turns must be 1–200.";
  return { task: o.task, steps, permissionMode: o.permissionMode, maxTurns, stopOnFailure: o.stopOnFailure !== false };
}

export class PipelineRunner {
  progress: PipelineProgress | null = null;
  private child: ChildProcess | null = null;
  private abort: AbortController | null = null;
  private stopped = false;

  constructor(private deps: PipelineDeps) {}

  get running(): boolean { return this.progress?.status === "running"; }

  start(spec: PipelineSpec): string {
    if (this.running) throw new Error("A pipeline is already running.");
    this.stopped = false;
    const steps: StepProgress[] = spec.steps.map((s, index) => ({ index, agent: s.agent, status: "waiting", tokens: 0, model: null, lastTool: null, output: "", checks: [], tries: 0, ms: 0 }));
    this.progress = { id: randomUUID(), status: "running", task: spec.task.slice(0, 200), permissionMode: spec.permissionMode, steps, startedAt: Date.now() };
    this.emit(true);
    void this.run(spec).catch((e) => this.finish("failed", String((e as Error)?.message ?? e)));
    return this.progress.id;
  }

  /** Ends the running step (its whole process group) and skips the rest. */
  stop() {
    if (!this.running) return;
    this.stopped = true;
    this.abort?.abort();
    this.killChild();
  }

  private async run(spec: PipelineSpec) {
    const p = this.progress!;
    let handoff = "";
    for (const step of p.steps) {
      if (this.stopped) break;
      let feedback = "";
      for (;;) {
        step.status = step.tries ? "fixing" : "running";
        this.emit(true);
        const prompt = [
          spec.task.trim(),
          handoff && `---\nOutput of the previous step (${p.steps[step.index - 1].agent}):\n${handoff}`,
          feedback && `---\nCrewglass ran your checks after your last attempt:\n${feedback}\nFix the problem and finish again.`,
        ].filter(Boolean).join("\n\n");
        const ok = await this.runStep(step, spec, prompt);
        if (this.stopped) { step.status = "stopped"; break; }
        if (!ok) { step.status = "failed"; break; }
        // Checks between steps (the step agent's command checks you confirmed).
        const defs = this.deps.checksFor(step.agent, step.index > 0 ? p.steps[step.index - 1].agent : undefined);
        if (!defs.length) { step.status = "done"; break; }
        step.status = "checking";
        this.emit(true);
        const failed = await this.runChecks(step, defs);
        if (this.stopped) { step.status = "stopped"; break; }
        if (!failed) { step.status = "done"; break; }
        if (step.tries >= MAX_FIX_ROUNDS) { step.status = "failed"; break; }
        step.tries++;
        feedback = `\`${failed.label}\` ${failed.timedOut ? "took too long" : `failed (exit code ${failed.exitCode ?? "none"})`}. Last lines:\n${failed.tail}`;
      }
      this.emit(true);
      if (step.status === "stopped") break;
      if (step.status === "failed" && spec.stopOnFailure) break;
      handoff = step.output.slice(-MAX_HANDOFF);
    }
    const anyFailed = p.steps.some((s) => s.status === "failed");
    this.finish(this.stopped ? "stopped" : anyFailed ? "failed" : "done");
  }

  private runStep(step: StepProgress, spec: PipelineSpec, prompt: string): Promise<boolean> {
    const s = spec.steps[step.index];
    const args = ["-p", "--agent", s.agent, "--permission-mode", spec.permissionMode, "--max-turns", String(spec.maxTurns),
      "--output-format", "stream-json", "--verbose", ...(s.effort ? ["--effort", s.effort] : [])];
    const env: NodeJS.ProcessEnv = {};
    // Not attached to whatever launched Crewglass (e.g. a VS Code window's Claude session).
    for (const [k, v] of Object.entries(process.env)) if (!/^(ELECTRON_|NODE_OPTIONS$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_CODE_SSE_PORT$|ENABLE_IDE_INTEGRATION$)/.test(k)) env[k] = v;
    const started = Date.now();
    return new Promise((resolve) => {
      let buf = "";
      let result: Record<string, unknown> | null = null;
      const child = spawn(this.deps.claudeBin, args, { cwd: this.deps.folder, env, shell: false, detached: true, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m: Record<string, unknown>;
          try { m = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (m.type === "system" && m.subtype === "init") {
            if (typeof m.session_id === "string") { step.sessionId = m.session_id; this.deps.onSession(m.session_id); }
            if (typeof m.model === "string") step.model = m.model;
          } else if (m.type === "assistant") {
            const msg = (m.message ?? {}) as { content?: { type?: string; text?: string; name?: string }[]; model?: string };
            if (typeof msg.model === "string") step.model = msg.model;
            for (const c of msg.content ?? []) {
              if (c.type === "text" && c.text) step.output = (step.output + (step.output ? "\n" : "") + c.text).slice(-MAX_OUTPUT);
              if (c.type === "tool_use" && c.name) step.lastTool = c.name;
            }
          } else if (m.type === "result") {
            result = m;
          }
          step.ms = Date.now() - started;
          this.emit();
        }
      });
      child.on("error", () => { this.child = null; resolve(false); });
      child.on("close", (code) => {
        this.child = null;
        step.ms = Date.now() - started;
        if (result) {
          const u = (result.usage ?? {}) as Record<string, number>;
          step.tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (typeof result.result === "string" && result.result.trim()) step.output = result.result.slice(-MAX_OUTPUT);
        }
        resolve(code === 0 && !!result && result.is_error !== true);
      });
    });
  }

  private async runChecks(step: StepProgress, defs: CheckDef[]): Promise<CheckResult | null> {
    this.abort = new AbortController();
    const budget = setTimeout(() => this.abort?.abort(), CHECKS_BUDGET_MS);
    try {
      for (const d of defs) {
        const r = await this.deps.runCheck(d, this.deps.folder, this.abort.signal);
        step.checks = [...step.checks.filter((c) => c.label !== r.label), { label: r.label, ok: r.ok, tail: r.ok ? undefined : r.tail }];
        this.emit(true);
        if (!r.ok) return r;
      }
      return null;
    } finally { clearTimeout(budget); this.abort = null; }
  }

  private killChild() {
    const c = this.child;
    if (!c?.pid) return;
    try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-c.pid!, "SIGKILL"); } catch { /* gone */ } }, 3000);
  }

  private finish(status: PipelineProgress["status"], error?: string) {
    if (!this.progress) return;
    this.progress.status = status;
    if (error) this.progress.error = error;
    this.progress.endedAt = Date.now();
    this.emit(true);
  }

  private lastEmit = 0;
  private pendingEmit: ReturnType<typeof setTimeout> | null = null;
  /** At most 10 updates a second (plan §11). */
  private emit(now = false) {
    if (!this.progress) return;
    const send = () => { this.pendingEmit = null; this.lastEmit = Date.now(); this.deps.onProgress(structuredClone(this.progress!)); };
    if (now || Date.now() - this.lastEmit >= 100) { if (this.pendingEmit) clearTimeout(this.pendingEmit); send(); }
    else if (!this.pendingEmit) this.pendingEmit = setTimeout(send, 100);
  }
}
