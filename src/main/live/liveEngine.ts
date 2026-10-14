// Live mode decisions (plan §4.2, §7). Every hook event arrives here via the helper; the answer is what the helper
// prints back to Claude Code. Verified behaviours (Phase 0a):
//   • Stop = continue:false (+ deny on PreToolUse so no other call in the same batch runs). No Stop event follows.
//   • The Stop flag clears only on a real message from you — NOT on a <task-notification> (a subagent finishing).
//   • A denied tool call's reason is read by Claude; additionalContext on PostToolUse / task-notification reaches it.
// Pure logic (no Electron), so it's unit-tested directly.

import { CHAT_NAME } from "@shared/teamMap";
import type { CheckState, InboxItem } from "@shared/types";
import type { CheckDef, CheckResult } from "../checks/runner";

export interface HookMsg {
  event: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  /** SessionStart: startup · resume · clear · compact. */
  source?: string;
  tool_name?: string;
  tool_use_id?: string;
  notification_type?: string;
  background_count?: number;
  task_notification?: boolean;
  command?: string;
  file_path?: string;
  subagent_type?: string;
  skill?: string;
  call_reason?: string;
  error_kind?: string;
  stop_hook_active?: boolean;
  /** Agent names from an "Allowed calls:" line in the orchestrator's brief (names only). */
  allowed_calls?: string[];
}

/** How a direct call between two subagents is approved (from the links you drew; D18). */
export interface DirectRules {
  state(from: string, to: string): "allowed" | "orchestrator" | "you" | "blocked" | undefined;
  costly(to: string): boolean;
  model(to: string): string;
}

export type Choice = "orchestrator" | "instructions" | "allow" | "stop";
export type Notify = (title: string, body: string, inboxId?: string, kind?: string) => void;
export interface Answer { print?: Record<string, unknown> }

/** An answer that takes a while (your approval, or checks running): the helper is told to wait up to `ms`. */
export class Waiting {
  constructor(readonly answer: Promise<Answer>, readonly ms: number) {}
}

/** Command checks (plan §6.4): which ones an agent has, and how to run one. Commands come only from Crewglass's
 *  private data (you confirmed them), never from the repo. */
export interface CheckService {
  /** The agent's own checks, plus those on the hand-off from `caller` (who gave it this work), if known. */
  checksFor(agentName: string, caller?: string): CheckDef[];
  run(def: CheckDef, cwd: string, signal: AbortSignal): Promise<CheckResult>;
}

/** All of an agent's checks together get at most 5 minutes; the helper waits a little longer than that. */
export const CHECKS_BUDGET_MS = 5 * 60_000;
export const CHECK_WAIT_MS = CHECKS_BUDGET_MS + 20_000;
export const MAX_FIX_TRIES = 2;

const deny = (reason: string): Answer => ({ print: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } });
export const requestReason = (callee: string, why = "Direct calls to this agent need the orchestrator's OK") =>
  `${why}. Finish your current step and reply to the orchestrator with: REQUEST ${callee}: <your reason>. The orchestrator will decide.`;

export const STOP_REASON = "Stopped from Crewglass. Summarize where you are in one or two sentences and wait for the user.";
export const PAUSED_REASON = "Crewglass paused this command: it failed several times in a row with no file changes in between. Do not run it again. The user is deciding what to do — continue with other work if you can, otherwise stop and wait.";
export const ORCH_REASON = "The user asked (via Crewglass) that you not retry this command as-is. Find the root cause or try a different approach; if you can't, stop and explain what's blocking you.";

interface Paused { signature: string; agent: string; count: number; choice: Choice | null; inboxId: string }
interface Session {
  id: string;
  status: "busy" | "idle" | "waiting" | "stopping" | "stopped";
  stop: boolean;
  waitingSince?: number;
  permissionItem?: string;
  failures: { signature: string; count: number } | null;
  paused: Map<string, Paused>;
  runningAgents: Map<string, number>;
  note?: { text: string; delivered: boolean };
  preToolCount: number;
  lastAt: number;
  cwd?: string;
  /** Orchestrator grants from its brief: subagent type → agents it may call directly. */
  grants: Map<string, Set<string>>;
  depth: Map<string, number>;
  directCalls: Map<string, number>;
  pendingSpawn: string | null;
  /** Who handed work to each running subagent (agent_id → the caller's name), for checks on hand-off links. */
  callers: Map<string, string>;
  pendingCaller: string | null;
  /** Per agent run (agent_id, or "main" for this turn of the main session): did it change files, and fix rounds so far. */
  runs: Map<string, AgentRun>;
  /** Check results waiting to be told to the orchestrator (on its next Agent result or task notification). */
  orchNotes: string[];
}

export interface AgentCheckState { state: CheckState; tries: number; label: string; at: number }

/** One agent run's check bookkeeping. `failed` = its last check failed and it was sent back to fix. */
interface AgentRun { name: string; edited: boolean; tries: number; failed: { what: string; label: string; tail: string } | null }

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const PERMISSION_POPUP_MS = 20_000;

export class LiveEngine {
  readonly sessions = new Map<string, Session>();
  items: InboxItem[] = [];
  lastEventAt: number | null = null;
  private seq = 0;

  constructor(
    private notify: Notify,
    private folderName: () => string,
    private inScope: (cwd: string | undefined) => boolean,
    private opts: { threshold?: number; testStopAfterTools?: number; approvalMs?: number; permissionPopupMs?: number } = {},
    private rules: () => DirectRules | null = () => null,
    private checks: CheckService | null = null,
  ) {}

  /** Settings changed (breaker threshold, permission pop-up delay): applies from the next event. */
  setOptions(o: { threshold?: number; permissionPopupMs?: number }) { this.opts = { ...this.opts, ...o }; }

  /** Latest check result per agent name, for ✓ / ✗ / ⏳ on the canvas. */
  readonly checkStates = new Map<string, AgentCheckState>();

  private approvals = new Map<string, { resolve: (a: Answer) => void; timer: ReturnType<typeof setTimeout>; caller: string; callee: string }>();
  /** "Always allow" answers, effective at once (and saved as a drawn link when you press Save). */
  private alwaysAllowed = new Set<string>();

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, status: "idle", stop: false, failures: null, paused: new Map(), runningAgents: new Map(), preToolCount: 0, lastAt: Date.now(),
        grants: new Map(), depth: new Map(), directCalls: new Map(), pendingSpawn: null, callers: new Map(), pendingCaller: null, runs: new Map(), orchNotes: [] };
      this.sessions.set(id, s);
    }
    return s;
  }

  private addItem(item: Omit<InboxItem, "id" | "at">, popup?: { title: string; body: string }): string {
    const full: InboxItem = { ...item, id: `live-${++this.seq}`, at: Date.now() };
    this.items = [full, ...this.items].slice(0, 100);
    if (item.popup && popup) this.notify(popup.title, popup.body, full.id, item.kind);
    return full.id;
  }

  private resolveItem(id: string | undefined, label: string) {
    if (!id) return;
    this.items = this.items.map((i) => (i.id === id && !i.resolved ? { ...i, resolved: label } : i));
  }

  private leaveWaiting(s: Session) {
    if (s.status === "waiting") s.status = "busy";
    s.waitingSince = undefined;
    this.resolveItem(s.permissionItem, "Answered");
    s.permissionItem = undefined;
  }

  /** Handles one hook event and returns what the helper should print (if anything). */
  handle(m: HookMsg, now = Date.now()): Answer | Waiting {
    if (!m.session_id || !this.inScope(m.cwd)) return {}; // other folders: allow, ignore
    this.lastEventAt = now;
    const s = this.session(m.session_id);
    s.lastAt = now;
    if (m.cwd) s.cwd = m.cwd;
    const sub = m.agent_id ? m.agent_type ?? "subagent" : null;

    switch (m.event) {
      case "SessionEnd":
        this.sessions.delete(s.id);
        return {};
      case "CwdChanged":
        if (!this.inScope(m.cwd)) this.sessions.delete(s.id);
        return {};
      case "UserPromptSubmit": {
        if (!m.task_notification) {
          // Your next message clears Stop (a subagent reporting in does not), and starts a new turn.
          s.stop = false;
          s.status = "busy";
          s.runs.delete("main");
          return {};
        }
        if (s.stop) return {};
        // A background agent finished. If it ran out of turns while fixing a failed check, no SubagentStop came.
        for (const [key, run] of [...s.runs]) if (key !== "main" && run.failed) this.giveUp(s, key, run, true);
        if (s.orchNotes.length) return { print: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: s.orchNotes.splice(0).join("\n\n") } } };
        if (s.note && !s.note.delivered) {
          s.note.delivered = true;
          return { print: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: s.note.text } } };
        }
        return {};
      }
      case "Notification":
        if (m.notification_type === "permission_prompt") { s.status = "waiting"; s.waitingSince ??= now; }
        else if (m.notification_type === "idle_prompt" && s.status !== "stopped") s.status = "idle";
        return {};
      case "PermissionRequest":
        s.status = "waiting";
        s.waitingSince ??= now;
        return {};
      case "PermissionDenied":
        this.leaveWaiting(s);
        return {};
      case "SubagentStart":
        if (m.agent_type) s.runningAgents.set(m.agent_type, (s.runningAgents.get(m.agent_type) ?? 0) + 1);
        // Spawn depth: 1 if the orchestrator/main session started it, parent's depth + 1 for a direct call.
        if (m.agent_id) s.depth.set(m.agent_id, s.pendingSpawn ? (s.depth.get(s.pendingSpawn) ?? 1) + 1 : 1);
        if (m.agent_id && s.pendingCaller) s.callers.set(m.agent_id, s.pendingCaller);
        s.pendingSpawn = null;
        s.pendingCaller = null;
        return {};
      case "SubagentStop": {
        if (m.agent_type) {
          const n = (s.runningAgents.get(m.agent_type) ?? 1) - 1;
          if (n > 0) s.runningAgents.set(m.agent_type, n); else s.runningAgents.delete(m.agent_type);
        }
        return this.finishRun(s, m, m.agent_type, m.agent_id ?? "");
      }
      case "Stop":
        if (!s.stop && !m.background_count) s.status = "idle";
        s.waitingSince = undefined;
        // The main session (or the orchestrator it runs as) finished its turn — unless background agents still work.
        return m.background_count ? {} : this.finishRun(s, m, m.agent_type, "main");
      case "StopFailure":
        s.status = "idle";
        this.addItem({ kind: "turn-failed", popup: true, title: "Claude's turn ended with an error", detail: "The request to Claude failed (for example a rate limit or network error). Nothing else was changed." },
          { title: `Claude stopped with an error in ${this.folderName()}`, body: "Open Crewglass for details." });
        return {};
      case "PreToolUse":
        return this.preToolUse(s, m, sub);
      case "PostToolUse":
      case "PostToolUseFailure":
        return this.postToolUse(s, m, sub);
      default:
        return {};
    }
  }

  private preToolUse(s: Session, m: HookMsg, sub: string | null): Answer | Waiting {
    this.leaveWaiting(s);
    s.preToolCount++;
    if (this.opts.testStopAfterTools && s.preToolCount === this.opts.testStopAfterTools) s.stop = true;
    if (s.stop) {
      s.status = "stopping";
      return { print: { continue: false, stopReason: STOP_REASON, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: STOP_REASON } } };
    }
    if (s.status !== "stopped") s.status = "busy";
    if ((m.tool_name === "Agent" || m.tool_name === "Task")) {
      const callee = m.subagent_type ?? "general-purpose";
      if (!sub) {
        // The orchestrator / main session delegating: remember any "Allowed calls:" grant in its brief.
        if (m.allowed_calls?.length) s.grants.set(callee, new Set(m.allowed_calls)); else s.grants.delete(callee);
        s.pendingSpawn = null;
        s.pendingCaller = m.agent_type ?? CHAT_NAME; // the orchestrator the chat runs as — or the chat itself — hands this work over
        return {};
      }
      return this.directCall(s, m, sub, callee);
    }
    if (m.tool_name === "Bash" && m.command) {
      const p = s.paused.get(m.command);
      if (p && p.choice !== "allow") {
        let reason = PAUSED_REASON;
        if (p.choice === "orchestrator") reason = ORCH_REASON;
        if (p.choice === "instructions" && s.note && !s.note.delivered) { s.note.delivered = true; reason = `${ORCH_REASON}\n${s.note.text}`; }
        else if (p.choice === "instructions") reason = ORCH_REASON;
        return { print: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } };
      }
    }
    return {};
  }

  private postToolUse(s: Session, m: HookMsg, sub: string | null): Answer {
    this.leaveWaiting(s);
    if (s.stop) {
      s.status = "stopped";
      return { print: { continue: false, stopReason: STOP_REASON } };
    }
    const failed = m.event === "PostToolUseFailure";
    if (m.tool_name === "Bash" && m.command) {
      if (failed) {
        s.failures = s.failures?.signature === m.command ? { signature: m.command, count: s.failures.count + 1 } : { signature: m.command, count: 1 };
        const threshold = this.opts.threshold ?? 3;
        if (s.failures.count >= threshold && !s.paused.has(m.command)) {
          const inboxId = this.addItem({
            kind: "failing-command", popup: true,
            title: `Paused: \`${m.command.length > 60 ? `${m.command.slice(0, 59)}…` : m.command}\` failed ${s.failures.count} times`,
            detail: `${sub ?? "The main session"} ran the same command ${s.failures.count} times with no file changes in between. It's paused; Claude can keep doing other work.`,
            data: { command: m.command, agent: sub ?? "main session", count: s.failures.count },
          }, { title: `A command was paused in ${this.folderName()}`, body: `It failed ${s.failures.count} times in a row. Choose what happens next in Crewglass.` });
          s.paused.set(m.command, { signature: m.command, agent: sub ?? "main session", count: s.failures.count, choice: null, inboxId });
        }
      } else if (s.failures?.signature === m.command) {
        s.failures = null;
      }
    }
    if (!failed && m.tool_name && EDIT_TOOLS.has(m.tool_name)) {
      s.failures = null;
      const key = m.agent_id ?? "main";
      const run = s.runs.get(key) ?? { name: m.agent_type ?? "", edited: false, tries: 0, failed: null };
      run.edited = true;
      s.runs.set(key, run);
    }
    if (!sub && (m.tool_name === "Agent" || m.tool_name === "Task")) {
      // The subagent's run is over. If it ran out of turns while fixing a failed check, no SubagentStop came: tell now.
      for (const [key, run] of [...s.runs]) if (key !== "main" && run.failed && run.name === m.subagent_type) this.giveUp(s, key, run, true);
    }
    // Check results for the orchestrator ride on the result of its Agent call (a subagent that ran in the foreground).
    if (!sub && (m.tool_name === "Agent" || m.tool_name === "Task") && s.orchNotes.length) {
      return { print: { hookSpecificOutput: { hookEventName: m.event, additionalContext: s.orchNotes.splice(0).join("\n\n") } } };
    }
    if (s.note && !s.note.delivered) {
      s.note.delivered = true;
      return { print: { hookSpecificOutput: { hookEventName: m.event, additionalContext: s.note.text } } };
    }
    return {};
  }

  /** A subagent calling another subagent directly (D18): Reason line, limits, then who approves. */
  private directCall(s: Session, m: HookMsg, caller: string, callee: string): Answer | Waiting {
    const reason = (m.call_reason ?? "").trim();
    if (reason.length < 10) return deny(`To call ${callee} directly, the first line of your request must be "Reason: <why you need ${callee}>". Add it and try again.`);
    const callerId = m.agent_id ?? "";
    // Depth 1 = started by the orchestrator. A → B → C is two levels of direct calls; C may not call further.
    if ((s.depth.get(callerId) ?? 1) >= 3) return deny(requestReason(callee, "Direct calls go at most 2 levels deep"));
    if ((s.directCalls.get(callerId) ?? 0) >= 3) return deny(requestReason(callee, "Each agent run may make at most 3 direct calls"));
    const rules = this.rules();
    const state = rules?.state(caller, callee);
    const allow = (): Answer => { s.directCalls.set(callerId, (s.directCalls.get(callerId) ?? 0) + 1); s.pendingSpawn = callerId; s.pendingCaller = caller; return {}; };
    if (state === "blocked") return deny(`Direct calls from ${caller} to ${callee} are not allowed. Finish your step and return to the orchestrator.`);
    if (state === "allowed" || s.grants.get(caller)?.has(callee) || this.alwaysAllowed.has(`${caller}>${callee}`)) return allow();
    const needsYou = state === "you" || (state === undefined && !!rules?.costly(callee));
    if (!needsYou) return deny(requestReason(callee));
    // Costly (or "needs your OK"): wait for you — at most 2 minutes, then it goes to the orchestrator.
    if (this.approvals.size >= 10) return deny(requestReason(callee, "Several calls are already waiting for the user"));
    const ms = this.opts.approvalMs ?? 120_000;
    const inboxId = this.addItem({
      kind: "approval", popup: true, title: `${caller} wants to call ${callee}`, detail: `Reason: "${reason}"`,
      data: { caller, callee, model: rules?.model(callee) ?? callee, deadline: Date.now() + ms, costly: true, reason },
    }, { title: `An agent needs your OK in ${this.folderName()}`, body: `${caller} wants to call ${callee}. Approve or send it to the orchestrator in Crewglass.` });
    return new Waiting(new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(inboxId);
        this.approvalAllow.delete(inboxId);
        this.resolveItem(inboxId, "No answer in 2 min — sent to the orchestrator");
        resolve(deny(requestReason(callee, "The user didn't answer in time")));
      }, ms);
      this.approvals.set(inboxId, { resolve: (a) => { clearTimeout(timer); resolve(a); }, timer, caller, callee });
      // remember how to allow it
      this.approvalAllow.set(inboxId, allow);
    }), ms + 10_000);
  }

  /** An agent run finished: if it changed files (or is being re-checked after a fix round), run its command checks.
   *  Failed → sent back to fix with the failure summary, at most twice; then you and the orchestrator are told. */
  private finishRun(s: Session, m: HookMsg, name: string | undefined, runKey: string): Answer | Waiting {
    const run = s.runs.get(runKey);
    if (run && name) run.name = name;
    const caller = runKey !== "main" ? s.callers.get(runKey) : undefined;
    const defs = name && this.checks && !s.stop ? this.checks.checksFor(name, caller) : [];
    if (!name || !run || !defs.length || (!run.edited && run.tries === 0)) { if (runKey !== "main") { s.runs.delete(runKey); s.callers.delete(runKey); } return {}; }
    // Checks run where the agent worked (its git worktree, for example) — but only inside the watched folder.
    const cwd = m.cwd && this.inScope(m.cwd) ? m.cwd : null;
    if (!cwd) return {};
    const sub = runKey !== "main";
    const labels = defs.map((d) => d.label).join(", ");
    this.checkStates.set(name, { state: "checking", tries: run.tries, label: labels, at: Date.now() });
    const answer = (async (): Promise<Answer> => {
      const abort = new AbortController();
      const budget = setTimeout(() => abort.abort(), CHECKS_BUDGET_MS);
      let failed: CheckResult | undefined;
      try {
        for (const d of defs) {
          const r = await this.checks!.run(d, cwd, abort.signal);
          if (!r.ok) { failed = r; break; }
        }
      } finally { clearTimeout(budget); }
      if (!failed) {
        run.failed = null;
        this.checkStates.set(name, { state: "passed", tries: run.tries, label: labels, at: Date.now() });
        if (sub) s.orchNotes.push(`Crewglass checks: ${name} passed ${labels}${run.tries ? ` after ${run.tries} fix round${run.tries === 1 ? "" : "s"}` : ""}.`);
        s.runs.delete(runKey);
        s.callers.delete(runKey);
        return {};
      }
      const what = `\`${failed.label}\` ${failed.timedOut ? "took too long" : `failed (exit code ${failed.exitCode ?? "none"})`}`;
      run.failed = { what, label: failed.label, tail: failed.tail };
      if (run.tries < MAX_FIX_TRIES) {
        run.tries++;
        run.edited = false;
        this.checkStates.set(name, { state: "failed", tries: run.tries, label: labels, at: Date.now() });
        return { print: { decision: "block", reason:
          `Crewglass ran your checks: ${what}. Fix the problem, then finish again (fix round ${run.tries} of ${MAX_FIX_TRIES}).\nLast lines of output:\n${failed.tail}` } };
      }
      this.giveUp(s, runKey, run, false);
      return {};
    })();
    return new Waiting(answer, CHECK_WAIT_MS);
  }

  /** Checks still fail and no more fix rounds are left (or the agent ran out of turns while fixing): tell you and the orchestrator. */
  private giveUp(s: Session, runKey: string, run: AgentRun, outOfTurns: boolean) {
    const f = run.failed;
    s.runs.delete(runKey);
    s.callers.delete(runKey);
    if (!f) return;
    const sub = runKey !== "main";
    const rounds = `${run.tries} fix round${run.tries === 1 ? "" : "s"}`;
    const why = outOfTurns ? ` (it ran out of turns while fixing)` : "";
    this.checkStates.set(run.name, { state: "failed", tries: run.tries, label: f.label, at: Date.now() });
    if (outOfTurns && run.name) {
      const n = (s.runningAgents.get(run.name) ?? 1) - 1; // no SubagentStop came for it
      if (n > 0) s.runningAgents.set(run.name, n); else s.runningAgents.delete(run.name);
    }
    this.addItem({
      kind: "check-failed", popup: true, title: `${run.name} still fails ${f.label} after ${rounds}${why}`,
      detail: `${f.what}. ${sub ? "The orchestrator was told." : "Claude stopped."}\n${f.tail.split("\n").slice(-12).join("\n")}`,
      data: { agent: run.name, check: f.label },
    }, { title: `A check kept failing in ${this.folderName()}`, body: `${run.name}'s work still fails its checks. Open Crewglass for details.` });
    if (sub) s.orchNotes.push(`Crewglass checks: ${run.name} FAILED ${f.what} after ${rounds}${why}. Last lines:\n${f.tail.split("\n").slice(-15).join("\n")}\nDecide what to do: fix it yourself, hand it back with specific feedback, or tell the user.`);
  }

  /** A message for Claude in this session, delivered with its next step (additionalContext). */
  say(sessionId: string, text: string) { this.session(sessionId).note = { text: text.slice(0, 4000), delivered: false }; }

  private approvalAllow = new Map<string, () => Answer>();

  /** Your answer to an approval card: once · always · orchestrator · deny (+ note). */
  private answerApproval(itemId: string, choice: string, note?: string): boolean {
    const a = this.approvals.get(itemId);
    if (!a) return false;
    this.approvals.delete(itemId);
    const allow = this.approvalAllow.get(itemId);
    this.approvalAllow.delete(itemId);
    const labels: Record<string, string> = { once: "Approved once", always: "Always allowed (saved when you press Save)", orchestrator: "Sent to the orchestrator", deny: "Denied" };
    this.resolveItem(itemId, labels[choice] ?? "Denied");
    if (choice === "always") this.alwaysAllowed.add(`${a.caller}>${a.callee}`);
    if (choice === "once" || choice === "always") a.resolve(allow ? allow() : {});
    else if (choice === "orchestrator") a.resolve(deny(requestReason(a.callee, "The user sent this call to the orchestrator")));
    else a.resolve(deny(`The user declined this direct call${note ? `: ${note}` : "."} Finish your step and return to the orchestrator.`));
    return true;
  }

  /** Stop one session or all of them, at their next event. */
  stop(sessionIds: string[]) {
    for (const id of sessionIds) {
      const s = this.session(id);
      s.stop = true;
      if (s.status !== "idle") s.status = "stopping";
    }
  }

  resume() {
    for (const s of this.sessions.values()) {
      s.stop = false;
      if (s.status === "stopping" || s.status === "stopped") s.status = "idle";
    }
  }

  /** Your choice for a paused command: orchestrator · instructions (with a note) · allow · stop. */
  resolve(itemId: string, choice: Choice | "once" | "always" | "deny", note?: string): boolean {
    if (this.answerApproval(itemId, choice, note)) return true;
    if (choice === "once" || choice === "always" || choice === "deny") { this.resolveItem(itemId, "Dismissed"); return false; }
    for (const s of this.sessions.values()) {
      for (const p of s.paused.values()) {
        if (p.inboxId !== itemId) continue;
        p.choice = choice;
        const labels: Record<Choice, string> = {
          orchestrator: "Handed to the orchestrator", instructions: "Your instructions were sent", allow: "Retries allowed; count reset", stop: "Claude stopped",
        };
        if (choice === "allow") { s.paused.delete(p.signature); s.failures = null; }
        if (choice === "stop") this.stop([s.id]);
        if (choice === "instructions" && note) s.note = { text: `Message from the user (via Crewglass): ${note}`, delivered: false };
        this.resolveItem(itemId, labels[choice]);
        return true;
      }
    }
    this.resolveItem(itemId, "Dismissed");
    return false;
  }

  /** Once a second: pop up for a permission prompt that has been waiting 20 s. */
  tick(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (s.status === "waiting" && s.waitingSince && now - s.waitingSince >= (this.opts.permissionPopupMs ?? PERMISSION_POPUP_MS) && !s.permissionItem) {
        const secs = Math.round((this.opts.permissionPopupMs ?? PERMISSION_POPUP_MS) / 1000);
        s.permissionItem = this.addItem({ kind: "permission", popup: true, title: "Claude needs your permission", detail: `It has been waiting for ${secs} seconds. Answer it in VS Code.` },
          { title: `Claude needs your permission in ${this.folderName()}`, body: `It has been waiting for ${secs} seconds. Answer it in VS Code.` });
      }
    }
  }

  /** Sessions seen through hooks recently — includes headless `claude -p` runs, which have no session file. */
  recentSessions(withinMs: number, now = Date.now()): { id: string; status: Session["status"]; cwd?: string }[] {
    return [...this.sessions.values()].filter((s) => now - s.lastAt < withinMs).map((s) => ({ id: s.id, status: s.status, cwd: s.cwd }));
  }

  statusOf(id: string): Session["status"] | null {
    return this.sessions.get(id)?.status ?? null;
  }

  runningAgents(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.sessions.values()) for (const [k, n] of s.runningAgents) out.set(k, (out.get(k) ?? 0) + n);
    return out;
  }
}
