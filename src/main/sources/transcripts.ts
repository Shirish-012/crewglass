// Reads Claude Code transcripts for the watched folder and turns them into numbers and names.
//
// Rules (docs/data-sources.md):
//  • One reply is split over several lines with the same message.id; later lines are streaming snapshots,
//    so usage is taken from the LAST line per id (applied as a delta, so nothing is counted twice).
//  • Subagent transcripts live in <project>/<session>/subagents/agent-<id>.jsonl (+ .meta.json) and are
//    added up separately; the main transcript never repeats them.
//  • Only field names, token numbers, model ids, tool names and short targets are kept. Text, thinking,
//    prompts and tool output are never stored.

import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PROJECTS_DIR } from "../paths";
import { encodeProjectDir, type Scope } from "../scope";
import type { ActivityEvent, Effort } from "@shared/types";
import { EFFORTS } from "@shared/models";
import { GEMINI_ID_RE, geminiLabel, isAgyTool, parseAgyReport } from "@shared/agy";
import { verdictOf } from "@shared/checks";

export const KNOWN_ENTRY_TYPES = new Set([
  "user", "assistant", "attachment", "system", "cost-state", "agent-setting", "ai-title", "last-prompt", "queue-operation",
  "file-history-snapshot", "file-history-delta", "atis-latch", "summary", "custom-title", "progress",
  "mode", "permission-mode", "agent-name", // seen in Phase 6; nothing in them is needed
]);
export const KNOWN_USAGE_KEYS = new Set([
  "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "output_tokens_details",
  "server_tool_use", "service_tier", "cache_creation", "inference_geo", "iterations", "speed",
]);

const WINDOW_MS = 30 * 24 * 3600 * 1000;
const MINUTE = 60_000;

export interface Usage { input: number; cacheWrite: number; cacheRead: number; output: number }
const ZERO: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
/** "Tokens" for limits and charts: input + output — the same Input and Output lines Claude Code's /cost shows.
 *  Cache writes (Claude re-saving the conversation, e.g. after its cache expired) and cache reads are tracked
 *  separately: in a long chat they dwarf everything else, and counting them made usage look inflated. */
export const billable = (u: Usage) => u.input + u.output;

export interface SessionAgg {
  sessionId: string;
  entrypoint: string;
  firstTs: number;
  lastTs: number;
  tokens: number;
  /** Of `tokens`, the part from today (local time). */
  tokensToday: number;
  cacheRead: number;
  cacheWrite: number;
  models: Set<string>;
  agentsUsed: Set<string>;
  mcpsUsed: Set<string>;
  failures: number;
  agentSetting: string | null;
  lastModel: string | null;
  lastEffort: Effort | undefined;
  contextTokens: number;
  skills: Set<string>;
  lastAction: { text: string; at: number } | null;
}

export interface AgentAgg {
  type: string;
  tokensToday: number;
  callsToday: number;
  lastTs: number;
  lastModel: string | null;
  lastEffort: Effort | undefined;
  skills: Set<string>;
  lastAction: { text: string; at: number } | null;
}

/** agy use by one owner (an agent type, or "session:<id>"): Gemini model and Google tokens, from the bridge's report line. */
export interface AgyAgg { model: string | null; calls: number; callsToday: number; tokensToday: number; lastSeconds: number | null; pendingSince: number | null; lastTs: number }

/** agy calls in the current turn of a session (from your message until Claude finishes). */
export interface AgyBurst { session: string; count: number; startedAt: number; lastAt: number }

export interface LinkAgg { from: string; to: string; kind: "delegates" | "direct" | "uses"; calls: number; lastTs: number }

export interface FormatSeen { entryTypes: Set<string>; usageKeys: Set<string>; missingUsage: boolean; version: string | null }

interface FileState {
  path: string;
  offset: number;
  partial: string;
  sessionId: string;
  /** Owner of tool calls in this file: "session:<id>" for the main transcript, the agent type for subagents. */
  owner: string;
  agentId?: string;
  agentType?: string;
  isMain: boolean;
  confirmed: boolean;
  /** Main transcript whose cwd turned out to be outside the folder (a look-alike directory name): never read again. */
  rejected: boolean;
  usageById: Map<string, { u: Usage; model: string; minute: number }>;
  pendingTools: Map<string, { at: number; activity?: ActivityEvent; bashSig?: string; agy?: boolean; mcp?: string }>;
  /** Subagent runs: agy calls made, and when it gave a final answer (a reply with no tool calls). */
  agyCalls: number;
  answeredAt: number | null;
  /** Main transcripts: the first lines, kept until one says which folder the session is in (then replayed). */
  early: string[];
}

export interface FailureStreak { session: string; owner: string; command: string; count: number; lastAt: number }

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class FolderTranscripts {
  private files = new Map<string, FileState>();
  private scope: Scope;
  private metaCache = new Map<string, { agentType?: string; parentAgentId?: string }>();
  private agentTypeById = new Map<string, string>();
  private confirmedSessions = new Set<string>();
  private rejectedSessions = new Set<string>();
  readonly sessions = new Map<string, SessionAgg>();
  readonly agents = new Map<string, AgentAgg>();
  readonly links = new Map<string, LinkAgg>();
  /** Per-minute buckets (epoch minute → tokens by model, tool calls, failures). */
  readonly minutes = new Map<number, { byModel: Record<string, number>; toolCalls: number; failures: number }>();
  readonly activity: ActivityEvent[] = [];
  readonly format: FormatSeen = { entryTypes: new Set(), usageKeys: new Set(), missingUsage: false, version: null };
  /** Same Bash command failing again and again with no file edit in between (per session). */
  readonly failStreaks = new Map<string, FailureStreak>();
  readonly agy = new Map<string, AgyAgg>();
  /** Failed tool calls per session in the last 10 minutes (timestamps only) — "Claude may be stuck". */
  readonly recentFailures = new Map<string, number[]>();
  /** This turn's delegations per session: agent + a one-way hash of the task → how many times (the text is never kept). */
  private turnTasks = new Map<string, { startedAt: number; counts: Map<string, { agent: string; count: number }> }>();
  /** MCP servers whose calls fail with "connection closed" (their process is gone), until a call succeeds again. */
  readonly mcpDown = new Map<string, { at: number; session: string }>();
  /** Checker agents (reviewers): only the word PASS or FAIL from their VERDICT line is kept. */
  verdictAgents = new Set<string>();
  readonly verdicts = new Map<string, { verdict: "PASS" | "FAIL"; at: number }>();
  readonly agyBursts = new Map<string, AgyBurst>();
  todayTokens = 0;
  /** Today's cache traffic in this folder, shown next to the tokens (not counted in them). */
  readonly todayCache = { write: 0, read: 0 };
  agyTokensToday = 0;
  agyCallsToday = 0;
  /** Local midnight the "today" counters belong to. Crewglass runs for days (launch at login), so they start
   *  again from 0 at each midnight — before, "Today" kept every day since the app started. */
  private dayStart = startOfToday();
  progress = { files: 0, read: 0, done: false };
  private seq = 0;

  constructor(scope: Scope) { this.scope = scope; }

  /** A new day: every "today" counter starts again (lines are counted as they're read, by their own timestamp). */
  rollDay(now = Date.now()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    if (d.getTime() === this.dayStart) return;
    this.dayStart = d.getTime();
    this.todayTokens = 0; this.todayCache.write = 0; this.todayCache.read = 0;
    this.agyTokensToday = 0; this.agyCallsToday = 0;
    for (const s of this.sessions.values()) s.tokensToday = 0;
    for (const a of this.agents.values()) { a.tokensToday = 0; a.callsToday = 0; }
    for (const g of this.agy.values()) { g.tokensToday = 0; g.callsToday = 0; }
  }

  /** Finds this folder's transcript files (last 30 days) and reads whatever is new in each. */
  async poll(): Promise<boolean> {
    this.rollDay();
    const found = await this.discover();
    this.progress.files = found.length;
    let changed = false;
    for (const f of found) {
      if (await this.readNew(f)) changed = true;
      this.progress.read = Math.max(this.progress.read, [...this.files.values()].filter((x) => x.offset > 0).length);
    }
    this.progress.done = true;
    return changed;
  }

  private async discover(): Promise<FileState[]> {
    const prefix = encodeProjectDir(this.scope.folder);
    let dirs: string[] = [];
    try { dirs = (await readdir(PROJECTS_DIR)).filter((d) => d === prefix || d.startsWith(prefix + "-")); } catch { return []; }
    const cutoff = Date.now() - WINDOW_MS;
    const out: FileState[] = [];
    for (const d of dirs) {
      const dir = join(PROJECTS_DIR, d);
      let entries: string[] = [];
      try { entries = await readdir(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        const st = await stat(path).catch(() => null);
        if (!st || st.mtimeMs < cutoff) continue;
        const sessionId = basename(name, ".jsonl");
        out.push(this.fileState(path, sessionId, true));
        const subDir = join(dir, sessionId, "subagents");
        let subs: string[] = [];
        try { subs = await readdir(subDir); } catch { /* no subagents */ }
        for (const s of subs) {
          if (!s.endsWith(".jsonl")) continue;
          const agentId = s.replace(/^agent-/, "").replace(/\.jsonl$/, "");
          const fs = this.fileState(join(subDir, s), sessionId, false, agentId);
          if (!fs.agentType) {
            const meta = await this.meta(join(subDir, s.replace(/\.jsonl$/, ".meta.json")));
            const type = meta.agentType ?? this.agentTypeById.get(agentId);
            if (type) { fs.agentType = type; fs.owner = type; this.agentTypeById.set(agentId, type); }
            else fs.owner = "subagent";
          }
          out.push(fs);
        }
      }
    }
    return out;
  }

  private async meta(path: string) {
    if (this.metaCache.has(path)) return this.metaCache.get(path)!;
    let m: { agentType?: string; parentAgentId?: string } = {};
    try {
      const j = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      m = { agentType: typeof j.agentType === "string" ? j.agentType : undefined, parentAgentId: typeof j.parentAgentId === "string" ? j.parentAgentId : undefined };
    } catch { /* meta not written yet */ }
    if (m.agentType) this.metaCache.set(path, m); // not cached until complete, so it's retried next poll
    return m;
  }

  private fileState(path: string, sessionId: string, isMain: boolean, agentId?: string): FileState {
    let f = this.files.get(path);
    if (!f) {
      f = { path, offset: 0, partial: "", sessionId, owner: isMain ? `session:${sessionId}` : "", agentId, isMain, confirmed: false, rejected: false,
        usageById: new Map(), pendingTools: new Map(), agyCalls: 0, answeredAt: null, early: [] };
      this.files.set(path, f);
    }
    return f;
  }

  private async readNew(f: FileState): Promise<boolean> {
    if (f.rejected || this.rejectedSessions.has(f.sessionId)) return false;
    // Subagent transcripts are read only once their session's main transcript is confirmed to be in the folder.
    if (!f.isMain && !this.confirmedSessions.has(f.sessionId)) return false;
    const st = await stat(f.path).catch(() => null);
    if (!st) return false;
    if (st.size < f.offset) { f.offset = 0; f.partial = ""; }
    if (st.size === f.offset) return false;
    const fh = await open(f.path, "r");
    try {
      let changed = false;
      while (f.offset < st.size) {
        const len = Math.min(8 * 1024 * 1024, st.size - f.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        const text = f.partial + buf.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        f.partial = lines.pop() ?? "";
        // A single line bigger than 64 MB (e.g. a huge tool output) is skipped rather than held in memory.
        if (f.partial.length > 64 * 1024 * 1024) f.partial = "\u0000skip";
        let n = 0;
        for (const line of lines) {
          if (f.rejected) return changed;
          if (line.startsWith("\u0000skip")) continue;
          if (line.trim() && this.handleLine(f, line)) changed = true;
          // Big histories: let the app answer Claude's hook events in between (they must answer within 300 ms).
          if (++n % 2000 === 0) await new Promise((r) => setImmediate(r));
        }
      }
      return changed;
    } finally {
      await fh.close();
    }
  }

  private handleLine(f: FileState, line: string): boolean {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { return false; }
    // Main transcripts: confirm the cwd really is inside the folder ("agent app" and "agent-app" encode the same).
    if (!f.confirmed) {
      if (!f.isMain) f.confirmed = true;
      else {
        // Lines before the first one that names the folder (e.g. which agent the session runs as) wait here.
        if (typeof e.cwd !== "string") { if (f.early.length < 50) f.early.push(line); return false; }
        if (!this.scope.contains(e.cwd)) { f.rejected = true; f.early = []; this.rejectedSessions.add(f.sessionId); return false; }
        f.confirmed = true;
        this.confirmedSessions.add(f.sessionId);
        for (const earlier of f.early.splice(0)) this.handleLine(f, earlier);
      }
    }
    const type = String(e.type ?? "");
    this.format.entryTypes.add(type);
    if (typeof e.version === "string") this.format.version = e.version;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    const at = Number.isFinite(ts) ? ts : Date.now();
    const session = this.session(f.sessionId);
    if (f.isMain && typeof e.entrypoint === "string" && !session.entrypoint) session.entrypoint = e.entrypoint;
    if (f.isMain && Number.isFinite(ts)) { session.firstTs = Math.min(session.firstTs || ts, ts); session.lastTs = Math.max(session.lastTs, ts); }

    if (type === "agent-setting" && typeof e.agentSetting === "string") { session.agentSetting = e.agentSetting; return true; }
    if (type === "assistant") return this.assistant(f, e, at);
    if (type === "user") return this.userEntry(f, e, at);
    return false;
  }

  private session(id: string): SessionAgg {
    let s = this.sessions.get(id);
    if (!s) {
      s = { sessionId: id, entrypoint: "", firstTs: 0, lastTs: 0, tokens: 0, tokensToday: 0, cacheRead: 0, cacheWrite: 0, models: new Set(), agentsUsed: new Set(), mcpsUsed: new Set(),
        failures: 0, agentSetting: null, lastModel: null, lastEffort: undefined, contextTokens: 0, skills: new Set(), lastAction: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  private agent(type: string): AgentAgg {
    let a = this.agents.get(type);
    if (!a) {
      a = { type, tokensToday: 0, callsToday: 0, lastTs: 0, lastModel: null, lastEffort: undefined, skills: new Set(), lastAction: null };
      this.agents.set(type, a);
    }
    return a;
  }

  private link(from: string, to: string, kind: LinkAgg["kind"], at: number) {
    const id = `${from}>${to}`;
    const l = this.links.get(id) ?? { from, to, kind, calls: 0, lastTs: 0 };
    l.calls++;
    l.lastTs = Math.max(l.lastTs, at);
    this.links.set(id, l);
  }

  private minute(at: number) {
    const k = Math.floor(at / MINUTE);
    let m = this.minutes.get(k);
    if (!m) { m = { byModel: {}, toolCalls: 0, failures: 0 }; this.minutes.set(k, m); }
    return m;
  }

  private assistant(f: FileState, e: Record<string, unknown>, at: number): boolean {
    const msg = (e.message ?? {}) as Record<string, unknown>;
    const model = typeof msg.model === "string" ? msg.model : "";
    if (model === "<synthetic>") return false;
    const effort = EFFORTS.includes(e.effort as Effort) ? (e.effort as Effort) : undefined;
    const session = this.session(f.sessionId);
    const usageRaw = msg.usage as Record<string, unknown> | undefined;
    const id = typeof msg.id === "string" ? msg.id : "";
    if (!usageRaw || !id) { if (model) this.format.missingUsage = true; }
    if (usageRaw) for (const k of Object.keys(usageRaw)) this.format.usageKeys.add(k);

    if (usageRaw && id) {
      const u: Usage = {
        input: num(usageRaw.input_tokens), cacheWrite: num(usageRaw.cache_creation_input_tokens),
        cacheRead: num(usageRaw.cache_read_input_tokens), output: num(usageRaw.output_tokens),
      };
      const prev = f.usageById.get(id);
      const minute = prev?.minute ?? Math.floor(at / MINUTE);
      const delta = billable(u) - (prev ? billable(prev.u) : 0);
      const deltaRead = u.cacheRead - (prev?.u ?? ZERO).cacheRead;
      const deltaWrite = u.cacheWrite - (prev?.u ?? ZERO).cacheWrite;
      f.usageById.set(id, { u, model, minute });
      session.tokens += delta;
      session.cacheRead += deltaRead;
      session.cacheWrite += deltaWrite;
      const bucket = this.minute(minute * MINUTE);
      bucket.byModel[model] = (bucket.byModel[model] ?? 0) + delta;
      if (at >= startOfToday()) {
        this.todayTokens += delta;
        session.tokensToday += delta;
        this.todayCache.write += deltaWrite;
        this.todayCache.read += deltaRead;
      }
      if (!f.isMain && f.agentType && at >= startOfToday()) this.agent(f.agentType).tokensToday += delta;
      if (f.isMain && e.isSidechain !== true) session.contextTokens = u.input + u.cacheRead + u.cacheWrite;
    }
    if (model) {
      session.models.add(model);
      if (f.isMain) { session.lastModel = model; if (effort) session.lastEffort = effort; }
      else if (f.agentType) { const a = this.agent(f.agentType); a.lastModel = model; if (effort) a.lastEffort = effort; a.lastTs = Math.max(a.lastTs, at); }
    }

    const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
    for (const c of content) if (c?.type === "tool_use") this.toolUse(f, c, at, model, effort);
    if (!f.isMain && content.length && content.every((c) => c?.type === "text")) f.answeredAt = at;
    if (!f.isMain && f.agentType && this.verdictAgents.has(f.agentType)) {
      for (const c of content) {
        const v = c?.type === "text" && typeof c.text === "string" ? verdictOf(c.text) : null;
        if (v) this.verdicts.set(f.agentType, { verdict: v, at });
      }
    }
    return true;
  }

  private toolUse(f: FileState, c: Record<string, unknown>, at: number, model: string, effort: Effort | undefined) {
    const name = String(c.name ?? "");
    const input = (c.input ?? {}) as Record<string, unknown>;
    const id = String(c.id ?? "");
    const session = this.session(f.sessionId);
    const ownerLabel = f.isMain ? "main session" : f.agentType ?? "subagent";
    let target = "";
    let bashSig: string | undefined;
    let agyCall = false;
    let mcpServer: string | undefined;

    if (name === "Agent" || name === "Task") {
      const type = typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose";
      target = `→ ${type}`;
      // Identical tasks for the same agent in one turn (only a hash of the task is compared, never stored as text).
      const task = typeof input.prompt === "string" ? input.prompt : "";
      const hash = createHash("sha256").update(`${type}\u0000${task}`).digest("hex").slice(0, 16);
      const turn = this.turnTasks.get(f.sessionId) ?? { startedAt: at, counts: new Map() };
      const t = turn.counts.get(hash) ?? { agent: type, count: 0 };
      t.count++;
      turn.counts.set(hash, t);
      this.turnTasks.set(f.sessionId, turn);
      session.agentsUsed.add(type);
      this.link(f.owner, type, f.isMain ? "delegates" : "direct", at);
      if (at >= startOfToday()) this.agent(type).callsToday++;
    } else if (isAgyTool(name)) {
      // agy through a bridge: keep only the Gemini model id; the prompt is never read.
      const model = typeof input.model === "string" && GEMINI_ID_RE.test(input.model) ? input.model : null;
      target = `agy · ${model ? geminiLabel(model) : "Gemini"}`;
      this.link(f.owner, "agy", "uses", at);
      this.agyCall(f, model, at, true);
      f.agyCalls++;
      agyCall = true;
    } else if (name.startsWith("mcp__")) {
      const [, server, ...tool] = name.split("__");
      target = `${server} · ${tool.join("__")}`;
      session.mcpsUsed.add(server);
      this.link(f.owner, `mcp:${server}`, "uses", at);
      mcpServer = server;
    } else if (name === "Skill") {
      const skill = typeof input.skill === "string" ? input.skill : "";
      target = skill;
      if (skill) { if (f.isMain) session.skills.add(skill); else if (f.agentType) this.agent(f.agentType).skills.add(skill); }
    } else if (name === "Bash") {
      const cmd = typeof input.command === "string" ? input.command.replace(/\s+/g, " ").trim() : "";
      target = clip(cmd, 80);
      bashSig = clip(cmd, 200);
      // agy counts only when it's actually given a task (-p / --print / --prompt / -i), also after `&&` or a pipe.
      // `agy --help`, `agy models`, `agy --version` and the like don't ask Gemini anything.
      if (/(?:^|[|;&]\s*)(?:\w+=\S*\s+)*agy\s(?:[^|;&]*\s)?(?:-p|--print|--prompt|-i|--prompt-interactive)(?:[\s=]|$)/.test(cmd)) {
        this.link(f.owner, "agy", "uses", at);
        const m = cmd.match(/\s--model(?:=|\s+)(gemini-[a-z0-9][a-z0-9.-]{0,60})(?:\s|$)/);
        this.agyCall(f, m?.[1] ?? null, at, false);
      }
    } else if (typeof input.file_path === "string") {
      const p = input.file_path;
      target = p.startsWith(this.scope.folder + "/") ? p.slice(this.scope.folder.length + 1) : basename(p);
      // A file edit resets "same command keeps failing" for this session.
      if (name === "Edit" || name === "Write" || name === "NotebookEdit") this.failStreaks.delete(f.sessionId);
    } else if (typeof input.pattern === "string") {
      target = clip(input.pattern, 60);
    } else if (typeof input.url === "string") {
      try { target = new URL(input.url).host; } catch { target = ""; }
    }

    const ev: ActivityEvent = { id: `a${++this.seq}`, at, session: f.sessionId, agent: ownerLabel, tool: agyCall ? "agy" : name, target, model, effort, result: "running" };
    this.pushActivity(ev);
    f.pendingTools.set(id, { at, activity: ev, bashSig, agy: agyCall || undefined, mcp: mcpServer });
    this.minute(at).toolCalls++;
    const action = { text: agyCall ? `asking ${target}` : target ? `${name} ${target}` : name, at };
    if (f.isMain) session.lastAction = action;
    else if (f.agentType) this.agent(f.agentType).lastAction = action;
  }

  private agyAgg(owner: string): AgyAgg {
    let a = this.agy.get(owner);
    if (!a) { a = { model: null, calls: 0, callsToday: 0, tokensToday: 0, lastSeconds: null, pendingSince: null, lastTs: 0 }; this.agy.set(owner, a); }
    return a;
  }

  private agyCall(f: FileState, model: string | null, at: number, viaBridge: boolean) {
    const a = this.agyAgg(f.owner);
    a.calls++;
    a.lastTs = Math.max(a.lastTs, at);
    if (model) a.model = model;
    if (viaBridge) a.pendingSince = at;
    if (at >= startOfToday()) { a.callsToday++; this.agyCallsToday++; }
    const b = this.agyBursts.get(f.sessionId) ?? { session: f.sessionId, count: 0, startedAt: at, lastAt: 0 };
    b.count++;
    b.lastAt = at;
    this.agyBursts.set(f.sessionId, b);
  }

  private userEntry(f: FileState, e: Record<string, unknown>, at: number): boolean {
    const msg = (e.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
    let changed = false;
    // Your own message starts a new turn (a background agent's task notification doesn't).
    if (f.isMain && e.isMeta !== true && !content.some((c) => c?.type === "tool_result")) {
      const first = typeof msg.content === "string" ? msg.content : content.find((c) => c?.type === "text")?.text;
      if (typeof first === "string" && !first.startsWith("<task-notification>")) { this.agyBursts.delete(f.sessionId); this.turnTasks.delete(f.sessionId); }
    }
    for (const c of content) {
      if (c?.type !== "tool_result") continue;
      const pending = f.pendingTools.get(String(c.tool_use_id ?? ""));
      if (!pending) continue;
      f.pendingTools.delete(String(c.tool_use_id));
      const failed = c.is_error === true;
      if (pending.activity) { pending.activity.result = failed ? "error" : "ok"; pending.activity.durationMs = Math.max(0, at - pending.at); }
      if (pending.agy) this.agyResult(f, c.content, at);
      if (pending.mcp) this.mcpResult(pending.mcp, failed, c.content, f.sessionId, at);
      if (failed) {
        this.minute(at).failures++;
        this.session(f.sessionId).failures++;
        const recent = (this.recentFailures.get(f.sessionId) ?? []).filter((t) => at - t < 10 * MINUTE);
        recent.push(at);
        this.recentFailures.set(f.sessionId, recent.slice(-50));
        if (pending.bashSig) {
          const prev = this.failStreaks.get(f.sessionId);
          const same = prev && prev.command === pending.bashSig;
          this.failStreaks.set(f.sessionId, { session: f.sessionId, owner: pending.activity?.agent ?? "", command: pending.bashSig, count: same ? prev.count + 1 : 1, lastAt: at });
        }
      } else if (pending.bashSig) {
        const prev = this.failStreaks.get(f.sessionId);
        if (prev && prev.command === pending.bashSig) this.failStreaks.delete(f.sessionId);
      }
      changed = true;
    }
    // Agent results carry the model the subagent really used.
    const r = e.toolUseResult as Record<string, unknown> | undefined;
    if (r && typeof r.agentType === "string" && typeof r.resolvedModel === "string") {
      const a = this.agent(r.agentType);
      a.lastModel = r.resolvedModel;
      if (typeof r.agentId === "string") this.agentTypeById.set(r.agentId, r.agentType);
    }
    return changed;
  }

  /** An MCP call failed because its server's connection is gone (only this error wording is checked; nothing kept). */
  private mcpResult(server: string, failed: boolean, content: unknown, session: string, at: number) {
    if (!failed) { this.mcpDown.delete(server); return; }
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join(" ") : "";
    if (/connection closed|MCP error -32000|not connected|transport (is )?closed|server (has )?(disconnected|exited|crashed)/i.test(text.slice(0, 500))) {
      this.mcpDown.set(server, { at, session });
    }
  }

  /** Sessions with 5 or more failed tool calls in the last 10 minutes. */
  stuckSessions(now = Date.now()): { session: string; count: number; since: number }[] {
    const out: { session: string; count: number; since: number }[] = [];
    for (const [session, times] of this.recentFailures) {
      const recent = times.filter((t) => now - t < 10 * MINUTE);
      if (recent.length >= 5) out.push({ session, count: recent.length, since: recent[0] });
    }
    return out;
  }

  /** The same agent given an identical task 3 or more times in one turn. */
  subagentLoops(): { session: string; agent: string; count: number; turnStartedAt: number }[] {
    const out: { session: string; agent: string; count: number; turnStartedAt: number }[] = [];
    for (const [session, turn] of this.turnTasks) for (const t of turn.counts.values()) if (t.count >= 3) out.push({ session, agent: t.agent, count: t.count, turnStartedAt: turn.startedAt });
    return out;
  }

  /** The bridge's report line → Gemini model and Google tokens (numbers only; the answer itself is ignored). */
  private agyResult(f: FileState, content: unknown, at: number) {
    const a = this.agyAgg(f.owner);
    a.pendingSince = null;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("\n") : "";
    const r = parseAgyReport(text.slice(-2000));
    if (!r) return;
    if (GEMINI_ID_RE.test(r.model) || r.model === "agy-default") a.model = r.model;
    a.lastSeconds = r.seconds;
    if (at >= startOfToday()) { const t = r.in + r.out + r.thinking; a.tokensToday += t; this.agyTokensToday += t; }
  }

  private pushActivity(ev: ActivityEvent) {
    this.activity.push(ev);
    if (this.activity.length > 700) this.activity.splice(0, this.activity.length - 500);
  }

  /** agy agent runs that finished without calling agy — the Haiku relay answered by itself, so it wasn't Gemini. */
  relayRunsWithoutAgy(relayTypes: Set<string>): { id: string; agentType: string; at: number }[] {
    const out: { id: string; agentType: string; at: number }[] = [];
    for (const f of this.files.values()) {
      if (!f.isMain && f.agentType && relayTypes.has(f.agentType) && f.answeredAt && f.agyCalls === 0 && Date.now() - f.answeredAt < 24 * 3600_000) {
        out.push({ id: f.agentId ?? f.path, agentType: f.agentType, at: f.answeredAt });
      }
    }
    return out;
  }

  /** Newest first, at most 500 — kept in memory only. */
  recentActivity(): ActivityEvent[] {
    return [...this.activity].sort((a, b) => b.at - a.at).slice(0, 500);
  }
}
