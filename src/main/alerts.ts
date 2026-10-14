// Alerts that need no hooks (Phase 1): context almost full, token limits, a long task finished,
// and the same command failing again and again. Pop-ups follow plan §8: only when you need to act or a
// long task ended, never while Crewglass is in front, grouped by type with a 2-minute cooldown.

import type { InboxItem } from "@shared/types";
import { formatTokens } from "@shared/models";

export interface AlertInput {
  folderName: string;
  sessions: { id: string; name: string; status: string; tokens: number; contextPct: number; source?: string }[];
  todayTokens: number;
  limits: { session: number; day: number };
  failStreaks: { session: string; owner: string; command: string; count: number }[];
  /** agy calls in the current turn, per session (plan §7: warn after more than 3). */
  agyBursts?: { session: string; count: number; startedAt: number }[];
  /** agy agents whose relay answered without asking agy (so the answer isn't Gemini's). */
  relaySkips?: { id: string; agentType: string }[];
  /** Claude finished a task (busy → idle): a pop-up after every task (0), or only after tasks at least this long. */
  finishedAfterMs?: number;
  /** Live mode is on here, so warnings can offer choices (the orchestrator / instructions / Stop). */
  liveOn?: boolean;
  /** 5+ failed tool calls in 10 minutes, per session (plan §7 "Claude may be stuck"). */
  stuck?: { session: string; count: number }[];
  /** The same agent given an identical task 3+ times in one turn (plan §7 "subagent loop"). */
  loops?: { session: string; agent: string; count: number; turnStartedAt: number }[];
  /** MCP servers whose connection is gone (their calls fail with "connection closed"). */
  mcpDown?: { server: string; at: number }[];
}

/** `kind` is what the pop-up is about (an inbox kind, or "finished"), so Settings can switch types off. */
export type Notify = (title: string, body: string, inboxId?: string, kind?: string) => void;

const COOLDOWN_MS = 2 * 60_000;
const LONG_TASK_MS = 2 * 60_000;

export class Alerts {
  items: InboxItem[] = [];
  private fired = new Set<string>();
  private busySince = new Map<string, number>();
  private lastPopup = new Map<string, number>();
  private seq = 0;

  resolve(id: string, choice: string) {
    const labels: Record<string, string> = {
      ok: "Dismissed", raise: "Limit raised by 50%", stop: "Stopping Claude at its next step",
      orchestrator: "Claude was told to step back and find the root cause", instructions: "Your instructions were sent", answered: "Dismissed",
    };
    this.items = this.items.map((i) => (i.id === id ? { ...i, resolved: labels[choice] ?? "Dismissed" } : i));
  }

  /** A one-off note in the inbox (no pop-up). */
  note(key: string, title: string, detail: string) {
    this.add(key, { kind: "limit", popup: false, title, detail }, () => {});
  }

  /** `popupText` is what macOS shows (and keeps in its notification history on disk), so it must never contain
   *  commands, paths or other text from your work — those stay in the in-memory inbox item. */
  private add(key: string, item: Omit<InboxItem, "id" | "at">, notify: Notify, popupText?: { title: string; body: string }) {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    const full: InboxItem = { ...item, id: `alert-${++this.seq}`, at: Date.now() };
    this.items = [full, ...this.items].slice(0, 100);
    if (full.popup) this.popup(item.kind, popupText?.title ?? full.title, popupText?.body ?? full.detail, notify, full.id, item.kind);
  }

  private popup(type: string, title: string, body: string, notify: Notify, inboxId?: string, kind?: string) {
    const last = this.lastPopup.get(type) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    this.lastPopup.set(type, Date.now());
    notify(title, body, inboxId, kind);
  }

  evaluate(input: AlertInput, notify: Notify) {
    const now = Date.now();
    for (const s of input.sessions) {
      // Context: once per crossing of 85%, re-armed after it drops below 70% (a compaction).
      if (s.contextPct >= 85) this.add(`ctx:${s.id}`, { kind: "context", popup: false, title: `Context is ${s.contextPct}% full`, detail: `${s.name}: Claude will soon compact the conversation. Consider /compact or a fresh task.` }, notify);
      else if (s.contextPct < 70) this.fired.delete(`ctx:${s.id}`);

      const pct = s.tokens / input.limits.session;
      if (pct >= 0.8) this.add(`lim80:${s.id}`, { kind: "limit", popup: false, title: "This session is at 80% of its token limit", detail: `${formatTokens(s.tokens)} of ${formatTokens(input.limits.session)}. Claude keeps going; nothing is stopped automatically.` }, notify);
      if (pct >= 1) this.add(`lim100:${s.id}`, { kind: "limit", popup: true, title: "This session reached its token limit", detail: `${formatTokens(s.tokens)} of ${formatTokens(input.limits.session)} in ${input.folderName}. Claude keeps going.` }, notify);
      // Past the limit: a quiet reminder at every further 25% (125%, 150%, …).
      for (let step = 125; pct * 100 >= step; step += 25) {
        this.add(`lim${step}:${s.id}`, { kind: "limit", popup: false, title: `This session is at ${step}% of its token limit`, detail: `${formatTokens(s.tokens)} of ${formatTokens(input.limits.session)}. Claude keeps going.` }, notify);
      }

      // Claude finished a task: busy → IDLE. ("Waiting for your permission" isn't finished, and a Stop you pressed
      // doesn't need telling.) Pipeline steps don't notify one by one — the pipeline tells you when it's done.
      if (s.status === "busy") { if (!this.busySince.has(s.id)) this.busySince.set(s.id, now); }
      else if (s.status === "stopping" || s.status === "stopped") this.busySince.delete(s.id);
      else if (s.status === "idle" && this.busySince.has(s.id)) {
        const took = now - this.busySince.get(s.id)!;
        this.busySince.delete(s.id);
        if (s.source !== "pipeline" && took >= (input.finishedAfterMs ?? LONG_TASK_MS)) {
          const mins = Math.round(took / 60_000);
          notify(`Claude finished in ${input.folderName}`, `${s.name} ${mins >= 1 ? `worked for ${mins} min and ` : ""}is waiting for your next message.`, undefined, "finished");
        }
      }
    }

    for (const id of [...this.busySince.keys()]) if (!input.sessions.some((x) => x.id === id)) this.busySince.delete(id); // ended

    const day = new Date().toDateString();
    const dayPct = input.todayTokens / input.limits.day;
    if (dayPct >= 0.8) this.add(`day80:${day}`, { kind: "limit", popup: false, title: "Today's usage in this folder is at 80%", detail: `${formatTokens(input.todayTokens)} of ${formatTokens(input.limits.day)}.` }, notify);
    if (dayPct >= 1) this.add(`day100:${day}`, { kind: "limit", popup: true, title: "Today's token limit for this folder is reached", detail: `${formatTokens(input.todayTokens)} of ${formatTokens(input.limits.day)}. Claude keeps going.` }, notify);
    for (let step = 125; dayPct * 100 >= step; step += 25) {
      this.add(`day${step}:${day}`, { kind: "limit", popup: false, title: `Today's usage in this folder is at ${step}% of its limit`, detail: `${formatTokens(input.todayTokens)} of ${formatTokens(input.limits.day)}. Claude keeps going.` }, notify);
    }

    // "Claude may be stuck": many failures in a short time. Nothing is paused; with Live mode you can step in.
    const stuckNow = new Set((input.stuck ?? []).map((x) => x.session));
    for (const x of input.stuck ?? []) {
      const name = input.sessions.find((y) => y.id === x.session)?.name ?? "A session";
      this.add(`stuck:${x.session}`, {
        kind: "stuck", popup: false, title: "Claude may be stuck",
        detail: `${name}: ${x.count} tool calls failed in the last 10 minutes. Nothing was paused.${input.liveOn ? "" : " Turn on Live mode to let the orchestrator handle it, send instructions, or stop Claude from here."}`,
        data: { session: x.session, count: x.count, live: !!input.liveOn },
      }, notify);
    }
    for (const key of [...this.fired]) if (key.startsWith("stuck:") && !stuckNow.has(key.slice(6))) this.fired.delete(key); // re-arms once it calms down

    // Subagent loop: the same agent handed an identical task again and again (compared by a one-way hash only).
    for (const l of input.loops ?? []) {
      this.add(`loop:${l.session}:${l.turnStartedAt}:${l.agent}`, {
        kind: "stuck", popup: false, title: `${l.agent} was given the same task ${l.count} times`,
        detail: `In one turn, ${l.agent} got an identical task ${l.count} times — it may be going in circles.${input.liveOn ? "" : " Turn on Live mode to step in from here."}`,
        data: { session: l.session, agent: l.agent, count: l.count, live: !!input.liveOn, loop: true },
      }, notify);
    }

    // An MCP server's connection is gone (its calls fail with "connection closed").
    const downNow = new Set((input.mcpDown ?? []).map((m) => m.server));
    for (const m of input.mcpDown ?? []) {
      this.add(`mcp:${m.server}`, {
        kind: "mcp-died", popup: false, title: `The ${m.server} MCP server stopped`,
        detail: `Calls to ${m.server} fail with “connection closed” — its process has ended. Reconnect it in Claude Code with /mcp.`,
        data: { server: m.server },
      }, notify);
    }
    for (const key of [...this.fired]) if (key.startsWith("mcp:") && !downNow.has(key.slice(4))) this.fired.delete(key);

    for (const b of input.agyBursts ?? []) {
      if (b.count <= 3) continue;
      const name = input.sessions.find((x) => x.id === b.session)?.name ?? "A session";
      this.add(`agy:${b.session}:${b.startedAt}`, {
        kind: "agy-calls", popup: false,
        title: `agy was called ${b.count} times in one turn`,
        detail: `${name}: each agy call costs Gemini quota (about 12k tokens) plus a few hundred Claude tokens for the relay. Claude keeps going; nothing is stopped automatically.`,
      }, notify);
    }

    for (const r of input.relaySkips ?? []) {
      this.add(`relay:${r.id}`, {
        kind: "agy-calls", popup: false,
        title: `${r.agentType} answered without asking Gemini`,
        detail: `Its Haiku relay replied by itself instead of calling agy, so that answer came from Haiku, not Gemini. If it keeps happening, check that agy works (Refresh in the Library) and that Claude may use the agy bridge (/mcp).`,
      }, notify);
    }

    for (const f of input.failStreaks) {
      if (f.count < 3) continue;
      this.add(`fail:${f.session}:${f.command}`, {
        kind: "failing-command", popup: true,
        title: `\`${f.command.length > 60 ? `${f.command.slice(0, 59)}…` : f.command}\` failed ${f.count} times`,
        detail: `${f.owner} ran the same command ${f.count} times with no file changes in between. Turn on Live mode for this folder and Crewglass pauses such a command and lets you choose what happens next.`,
        data: { command: f.command, agent: f.owner, count: f.count, phase1: true },
      }, notify, { title: `A command failed ${f.count} times in ${input.folderName}`, body: "Open Crewglass to see which one." });
    }
  }
}
