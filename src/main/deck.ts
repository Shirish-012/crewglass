// Deck: watches ONE folder and turns everything the readers find into the Snapshot the UI shows.
// It never writes: saving goes through writers/savePlan.ts, and only after you review the exact diff.

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Agent, HistoryRow, Link, McpServer, Session } from "@shared/types";
import type { SeriesPoint, Snapshot } from "@shared/ipc";
import { chatStartEffort, findModel, formatTokens, isCostly, modelWithEffort, runDiffers } from "@shared/models";
import { Scope, realPath } from "./scope";
import { readSessions, sourceOf, statusOf, type LiveSession } from "./sources/claudeSessions";
import { openWorkspaceFolders } from "./sources/ideLocks";
import { readAgentFiles, type AgentFile } from "./sources/agentFiles";
import { readFolderConfig, readGitExcludes, type FolderConfig } from "./sources/configFiles";
import { processTree } from "./sources/processes";
import { FolderTranscripts } from "./sources/transcripts";
import { detectFormatIssues, issuesSignature, TESTED_CLAUDE_VERSION } from "./formatWatch";
import { Alerts, type Notify } from "./alerts";
import type { SettingsStore } from "./settings";
import { LiveEngine, type Answer, type DirectRules, type HookMsg, type Waiting } from "./live/liveEngine";
import { isInstalled } from "./live/hookInstaller";
import { CHAT_KEY, CHAT_NAME, parseTeamMap, TEAM_MAP_FILES, type TeamMapData } from "@shared/teamMap";
import { chatNotice } from "./live/chatNotice";
import { checksFor, readFolderData } from "./folderData";
import { runCheck } from "./checks/runner";
import { BUILTIN_CHECKS } from "@shared/checks";
import { AGY_SERVER } from "@shared/agy";
import { LEGACY } from "@shared/legacy";
import type { AgyEnv } from "./writers/savePlan";
import type { AgyAgg } from "./sources/transcripts";
import { mergeHistory, readHistory, saveHistory, type StoredRow } from "./history";

const BUILTIN_AGENTS = new Set(["Explore", "Plan", "general-purpose", "statusline-setup", "claude-code-guide", "claude", "output-style-setup"]);
const RUNNING_MS = 20_000;
const AGY_CALL_MS = 6 * 60_000; // the bridge's own limit is 5 min + a margin

const relTime = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

const startedLabel = (at: number) => {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};

/** mcp__claude_ai_Google_Drive__x → "claude.ai Google Drive"; mcp__plugin_x_y__z → "plugin x y". */
function inheritedLabel(server: string): { name: string; source: string } {
  if (server.startsWith("claude_ai_")) return { name: server.slice(10).replace(/_/g, " "), source: "claude.ai connector" };
  if (server.startsWith("plugin_")) return { name: server.slice(7).replace(/_/g, " "), source: "plugin" };
  return { name: server, source: "inherited" };
}

export class Deck {
  scope: Scope | null = null;
  private transcripts: FolderTranscripts | null = null;
  private alerts = new Alerts();
  private files: { project: AgentFile[]; user: AgentFile[] } = { project: [], user: [] };
  private config: FolderConfig | null = null;
  private live: LiveSession[] = [];
  private sessionFields: string[][] = [];
  private kinds: string[] = [];
  private statuses: string[] = [];
  private processes: Snapshot["processes"] = [];
  private tick = 0;
  private engine: LiveEngine;
  liveInstalled = false;
  helperReady = false;
  agyEnv: AgyEnv = { node: null, bridge: null, agy: null };
  private directRules: DirectRules | null = null;
  constructor(private settings: SettingsStore, private notify: Notify, readonly sourceRepo: string, private userData = "") {
    this.engine = this.newEngine();
  }

  static validFolder(path: unknown): string | null {
    if (typeof path !== "string" || !path.startsWith("/")) return null;
    try { return statSync(path).isDirectory() ? realPath(path) : null; } catch { return null; }
  }

  private newEngine() {
    // Test-only switches: ignored unless CREWGLASS_TEST=1.
    const testing = process.env.CREWGLASS_TEST === "1";
    const testStop = testing ? Number(process.env.CREWGLASS_TEST_STOP_AFTER_TOOLS) || undefined : undefined;
    const approvalMs = testing ? Number(process.env.CREWGLASS_TEST_APPROVAL_MS) || undefined : undefined;
    const set = this.settings.data;
    return new LiveEngine(this.notify, () => (this.scope ? basename(this.scope.folder) : ""), (cwd) => !!this.scope?.contains(cwd),
      { testStopAfterTools: testStop, approvalMs, threshold: set.breakerThreshold, permissionPopupMs: set.permissionPopupSec * 1000 }, () => this.directRules, {
        // Only commands you confirmed, from Crewglass's private data (never from the repo).
        checksFor: (name, caller) => (this.userData && this.scope ? checksFor(readFolderData(this.userData, this.scope.folder), name, caller) : []),
        run: (def, cwd, signal) => runCheck(def, cwd, signal),
      });
  }

  /** A hook event from the helper (Live mode). Returns what the helper should print back to Claude Code. */
  handleHook(m: HookMsg): Answer | Waiting {
    const answer = this.engine.handle(m);
    // A new chat: a one-line notice for you saying which agent it runs as (never read by Claude).
    if (m.event === "SessionStart" && m.source !== "compact" && this.settings.data.chatNotice && this.scope?.contains(m.cwd)) {
      const note = this.chatNoticeFor(m.agent_type);
      if (note) return { print: { systemMessage: note } };
    }
    return answer;
  }

  /** The folder's team map (under the current name, else the old one), or null if none is saved. */
  private teamMapText(): string | null {
    for (const f of TEAM_MAP_FILES) { try { return readFileSync(join(this.scope!.folder, f), "utf8"); } catch { /* try the next */ } }
    return null;
  }

  private chatNoticeFor(agentType: string | undefined): string | null {
    if (!this.scope) return null;
    let team: TeamMapData | null = null;
    const text = this.teamMapText();
    if (text) team = parseTeamMap(text);
    const file = agentType ? [...this.files.project, ...this.files.user].find((f) => f.agent.name === agentType && f.agent.sameName?.usedByClaude !== false) : undefined;
    return chatNotice({ agentType, agent: file ? { model: file.agent.model } : null, startEffort: this.config?.effortLevel ?? null, team });
  }

  stop(target: string) {
    const known = new Set([...this.live.map((l) => l.sessionId), ...this.engine.recentSessions(120_000).map((h) => h.id)]);
    this.engine.stop(target === "all" ? [...known] : known.has(target) ? [target] : []);
  }

  resume() { this.engine.resume(); }

  /** Tokens are counted differently now, so the saved limits were reset once: say so in the inbox. */
  noteLimitsReset() {
    const l = this.settings.data.limits;
    this.alerts.note("limits-reset", "Token limits were reset for the new count",
      `Tokens now mean input + output, like Claude Code's /cost — cache writes aren't counted any more (they made usage look inflated). Your limits are now ${formatTokens(l.session)} per session and ${formatTokens(l.day)} per day; change them in Settings.`);
  }

  /** Does this watcher know the session (for routing a hook event that carries no folder)? */
  knowsSession(id: string): boolean { return this.engine.sessions.has(id) || this.live.some((l) => l.sessionId === id); }

  setFolder(folder: string | null) {
    this.engine = this.newEngine();
    this.scope = folder ? new Scope(folder) : null;
    this.transcripts = folder ? new FolderTranscripts(this.scope!) : null;
    this.alerts = new Alerts();
    this.config = null;
    this.live = [];
    // Nothing from the previous folder may show (or be built on) before this one is read.
    this.files = { project: [], user: [] };
    this.processes = [];
    this.sessionFields = [];
    this.kinds = [];
    this.statuses = [];
    this.storedHistory = folder && this.userData ? readHistory(this.userData, this.scope!.folder) : [];
    this.tick = 0;
  }

  resolveInbox(id: string, choice: string, note?: string) {
    if (id.startsWith("live-")) {
      const valid = ["orchestrator", "instructions", "allow", "stop", "once", "always", "deny"] as const;
      this.engine.resolve(id, (valid as readonly string[]).includes(choice) ? (choice as (typeof valid)[number]) : "orchestrator", note);
      return;
    }
    const item = this.alerts.items.find((i) => i.id === id);
    this.alerts.resolve(id, choice);
    const session = typeof item?.data?.session === "string" ? item.data.session : null;
    if (item?.kind === "stuck" && session) {
      // "Claude may be stuck" / subagent loop, with Live mode: the choice reaches Claude with its next step.
      if (choice === "orchestrator") this.engine.say(session, item.data?.loop
        ? `Crewglass noticed ${String(item.data.agent)} was given the same task several times. Don't send it again as-is: find out why it isn't working, change the approach, or ask the user.`
        : "Crewglass noticed several tool calls failed in the last few minutes. Step back: find the root cause or try a different approach; if you're blocked, stop and explain what's blocking you.");
      if (choice === "instructions" && note) this.engine.say(session, `Message from the user (via Crewglass): ${note}`);
      if (choice === "stop") this.stop(session);
      return;
    }
    if (choice === "stop") this.stop("all");
    if (choice === "raise") {
      const l = this.settings.data.limits;
      this.settings.update({ limits: { ...l, session: Math.round(l.session * 1.5) } });
    }
  }

  async poll(): Promise<void> {
    if (!this.scope || !this.transcripts) return;
    this.tick++;
    const r = readSessions(this.scope);
    this.live = r.included;
    this.sessionFields = r.seenFields;
    this.kinds = r.kinds;
    this.statuses = r.statuses;
    if (this.tick % 3 === 1) {
      this.files = readAgentFiles(this.scope.folder);
      this.config = readFolderConfig(this.scope.folder);
      this.liveInstalled = isInstalled(this.scope.folder);
    }
    this.engine.tick();
    await this.transcripts.poll();
    if (this.tick % 60 === 2) this.persistHistory(); // soon after the first read, then about once a minute
    if (this.tick % 2 === 1) {
      const labels = new Map(this.live.map((l) => [l.pid, `claude · ${l.name} (${sourceOf(l.entrypoint, l.kind) === "vscode" ? "VS Code" : "terminal"})`]));
      this.processes = await processTree(this.live.map((l) => l.pid), (this.config?.mcps ?? []).map((m) => m.name), labels);
    }
    this.alerts.evaluate({
      folderName: basename(this.scope.folder),
      sessions: this.buildSessions().filter((s) => s.id !== "none").map((s) => ({ id: s.id, name: s.name, status: s.status, tokens: s.tokens, contextPct: this.contextPct(s), source: s.source })),
      todayTokens: this.transcripts.todayTokens,
      limits: this.settings.data.limits,
      // With Live mode on, the engine pauses failing commands itself; the transcript-based warning is for watch-only.
      failStreaks: this.liveInstalled ? [] : [...this.transcripts.failStreaks.values()],
      agyBursts: [...this.transcripts.agyBursts.values()],
      finishedAfterMs: this.settings.data.notifyEveryFinish ? 0 : this.settings.data.longTaskMin * 60_000,
      liveOn: this.liveInstalled,
      stuck: this.transcripts.stuckSessions(),
      loops: this.transcripts.subagentLoops(),
      mcpDown: [...this.transcripts.mcpDown.entries()].map(([server, d]) => ({ server, at: d.at })),
      relaySkips: this.transcripts.relayRunsWithoutAgy(new Set([...this.files.project, ...this.files.user].filter((f) => f.agent.kind === "agy").map((f) => f.agent.name))),
    }, this.notify);
  }

  private contextPct(s: Session) {
    return Math.round((s.contextTokens / (findModel(s.model)?.contextWindow ?? 200_000)) * 100);
  }

  private buildSessions(): Session[] {
    const t = this.transcripts!;
    const sessions: Session[] = this.live.map((l) => {
      const agg = t.sessions.get(l.sessionId);
      const liveStatus = this.engine.statusOf(l.sessionId);
      return {
        id: l.sessionId, name: l.name, source: sourceOf(l.entrypoint, l.kind), subfolder: l.subfolder || undefined,
        status: liveStatus === "waiting" || liveStatus === "stopping" || liveStatus === "stopped" ? liveStatus : statusOf(l.status), model: agg?.lastModel ?? "unknown", effort: agg?.lastEffort,
        contextTokens: agg?.contextTokens ?? 0, tokens: agg?.tokens ?? 0, tokensToday: agg?.tokensToday ?? 0,
        cache: agg ? { write: agg.cacheWrite, read: agg.cacheRead } : undefined, runsAs: l.agent ?? agg?.agentSetting ?? undefined,
        liveNow: agg?.lastAction && Date.now() - agg.lastAction.at < 30_000 ? agg.lastAction.text : undefined,
        skillsUsed: agg ? [...agg.skills] : [],
      };
    });
    // Headless `claude -p` runs have no session file; with Live mode on, the hooks still tell us about them.
    for (const h of this.engine.recentSessions(120_000)) {
      if (sessions.some((x) => x.id === h.id) || h.status === "idle") continue;
      const agg = t.sessions.get(h.id);
      sessions.push({
        id: h.id, name: "headless run", source: "headless", subfolder: h.cwd && this.scope ? this.scope.subfolder(h.cwd) || undefined : undefined,
        status: h.status === "stopping" || h.status === "stopped" || h.status === "waiting" ? h.status : "busy",
        model: agg?.lastModel ?? "unknown", effort: agg?.lastEffort, contextTokens: agg?.contextTokens ?? 0, tokens: agg?.tokens ?? 0, tokensToday: agg?.tokensToday ?? 0,
        cache: agg ? { write: agg.cacheWrite, read: agg.cacheRead } : undefined, runsAs: agg?.agentSetting ?? undefined,
        liveNow: agg?.lastAction && Date.now() - agg.lastAction.at < 30_000 ? agg.lastAction.text : undefined, skillsUsed: agg ? [...agg.skills] : [],
      });
    }
    if (!sessions.length) {
      const last = [...t.sessions.values()].sort((a, b) => b.lastTs - a.lastTs)[0];
      sessions.push({ id: "none", name: "Claude Code is not running here", source: "vscode", status: "idle", model: last?.lastModel ?? "unknown",
        effort: last?.lastEffort, contextTokens: 0, tokens: 0, skillsUsed: [] });
    }
    return sessions;
  }

  snapshot(): Snapshot {
    const s = this.settings.data;
    const suggestions = openWorkspaceFolders().map((p) => ({ path: p, why: "Open in VS Code now" }));
    for (const p of s.recentFolders) if (!suggestions.some((x) => x.path === p)) suggestions.push({ path: p, why: "Recent" });
    const base: Snapshot = {
      folder: this.scope?.folder ?? null, recentFolders: s.recentFolders, suggestions, sessions: [], agents: [], userAgents: [], mcps: [], links: [],
      orchestratorKey: null, orchestratorPaused: false, activity: [], series: [], processes: [], history: [], formatIssues: [], inbox: [], todayTokens: 0, todayCache: { write: 0, read: 0 }, limits: s.limits,
      sourceRepo: "", claudeVersion: null, testedClaudeVersion: TESTED_CLAUDE_VERSION, loading: { done: false, files: 0, read: 0 },
      live: { installed: this.liveInstalled, active: this.engine.lastEventAt !== null, lastEventAt: this.engine.lastEventAt, helperReady: this.helperReady },
      agy: { ...this.agyReadiness(), models: s.geminiModels, tokensToday: 0, callsToday: 0 },
      checks: { ...BUILTIN_CHECKS },
    };
    if (!this.scope || !this.transcripts) return base;
    const t = this.transcripts;
    const now = Date.now();
    const sessions = this.buildSessions();

    const folderData = this.userData ? readFolderData(this.userData, this.scope.folder) : null;
    const privateChecks = folderData?.checks ?? {};
    const checkCatalog = { ...BUILTIN_CHECKS };
    for (const [key, c] of Object.entries(folderData?.commands ?? {})) checkCatalog[key] = { key, kind: "command", label: c.label, command: c.command };
    const teamMapText = this.teamMapText();
    const teamMap = teamMapText ? parseTeamMap(teamMapText) : null;

    // ── agents: files first, then built-in / plugin / agy agents seen in use ──
    const byName = new Map<string, Agent>();
    const agents: Agent[] = [];
    const excluded = readGitExcludes(this.scope.folder);
    const agentFromFile = (f: AgentFile) => {
      const a = { ...f.agent };
      if (a.scope === "project") a.keepPrivate = excluded.has(`/${a.file}`);
      // Claude runs agents by name, so activity belongs only to the copy Claude actually uses.
      const agg = a.sameName?.usedByClaude === false ? undefined : t.agents.get(a.name);
      if (agg) {
        a.tokens = agg.tokensToday;
        a.calls = agg.callsToday;
        a.skillsUsed = [...agg.skills];
        const running = now - agg.lastTs < RUNNING_MS && sessions.some((x) => x.status === "busy");
        a.status = running ? "running" : agg.lastTs ? "done" : "idle";
        if (running && agg.lastAction) a.liveNow = { action: agg.lastAction.text, model: agg.lastModel ?? a.model, effort: agg.lastEffort, tokens: 0 };
        if (agg.lastModel && runDiffers(a, { model: agg.lastModel, effort: agg.lastEffort })) { a.actualModel = agg.lastModel; a.actualEffort = agg.lastEffort; }
      }
      if (this.config?.deniedAgents.includes(a.name)) a.disabled = true;
      a.checks = privateChecks[a.name] ?? [];
      return a;
    };
    for (const f of this.files.project) { const a = agentFromFile(f); agents.push(a); if (!byName.has(a.name)) byName.set(a.name, a); }
    const userAgents: Agent[] = [];
    for (const f of this.files.user) {
      const a = agentFromFile(f);
      if (t.agents.has(a.name) && !byName.has(a.name)) { agents.push(a); byName.set(a.name, a); } else userAgents.push(a);
    }
    for (const [type, agg] of t.agents) {
      if (byName.has(type)) continue;
      const running = now - agg.lastTs < RUNNING_MS && sessions.some((x) => x.status === "busy");
      // Built-in (Explore, Plan…), a plugin agent ("plugin:name"), or one whose file has since been deleted or renamed.
      const builtin = BUILTIN_AGENTS.has(type);
      const plugin = !builtin && type.includes(":");
      const a: Agent = {
        key: `builtin:${type}`, name: type, kind: "builtin", scope: builtin ? "builtin" : plugin ? "plugin" : "project", file: "",
        role: builtin ? "Built-in Claude Code agent (watch only)." : plugin ? "Agent from a plugin (watch only)." : "Used here, but its file isn't in .claude/agents any more (deleted or renamed).", instructions: "",
        model: agg.lastModel ?? "unknown", effort: agg.lastEffort, toolAccess: "inherit", builtinTools: [], keepPrivate: false, checks: [],
        status: running ? "running" : "done", parallel: running ? 1 : 0, tokens: agg.tokensToday, calls: agg.callsToday, skillsUsed: [...agg.skills],
        liveNow: running && agg.lastAction ? { action: agg.lastAction.text, model: agg.lastModel ?? "", effort: agg.lastEffort, tokens: 0 } : undefined,
      };
      agents.push(a);
      byName.set(type, a);
    }
    // Live mode knows exactly which subagents are running right now (SubagentStart/Stop), including parallel copies.
    for (const [type, n] of this.engine.runningAgents()) {
      const a = byName.get(type);
      if (a) { a.status = "running"; a.parallel = n; }
    }
    // agy: an agy agent (Haiku relay) shows the Gemini model the bridge reported. agy used any other way
    // (a Bash `agy …` command, or the bridge called by a non-relay agent) shows as one "agy" card.
    const geminiOf = (g: AgyAgg | undefined): Agent["gemini"] => g && {
      model: g.model, tokensToday: g.tokensToday, callsToday: g.callsToday, lastSeconds: g.lastSeconds, running: !!g.pendingSince && now - g.pendingSince < AGY_CALL_MS,
    };
    const relayNames = new Set<string>();
    for (const a of agents) {
      if (a.kind !== "agy" || a.sameName?.usedByClaude === false) continue;
      relayNames.add(a.name);
      a.gemini = geminiOf(t.agy.get(a.name));
      if (a.gemini?.running) { a.status = "running"; a.liveNow = { action: "asking Gemini through agy", model: a.gemini.model ?? a.geminiModel ?? "", tokens: 0 }; }
    }
    const otherAgy = [...t.agy.entries()].filter(([owner]) => !relayNames.has(owner)).map(([, g]) => g);
    if (otherAgy.length) {
      const latest = otherAgy.reduce((x, y) => (y.lastTs > x.lastTs ? y : x));
      const sum: AgyAgg = { ...latest, callsToday: otherAgy.reduce((n, g) => n + g.callsToday, 0), tokensToday: otherAgy.reduce((n, g) => n + g.tokensToday, 0),
        pendingSince: otherAgy.some((g) => g.pendingSince) ? latest.pendingSince : null, model: latest.model ?? otherAgy.find((g) => g.model)?.model ?? null };
      const gemini = geminiOf(sum);
      agents.push({ key: "agy:agy", name: "agy", kind: "agy", scope: "builtin", file: "", role: "Google Antigravity CLI, run by Claude.", instructions: "",
        model: "haiku", geminiModel: sum.model ?? "agy-default", gemini, toolAccess: "inherit", builtinTools: [], keepPrivate: false, checks: [],
        status: gemini?.running ? "running" : "done", parallel: 0, tokens: 0, calls: sum.callsToday, skillsUsed: [] });
    }

    // A chat that runs as one of your agents (the orchestrator, or `claude --agent x`) shows its live state on that card.
    for (const x of sessions) {
      const a = x.runsAs && x.id !== "none" ? byName.get(x.runsAs) : undefined;
      if (!a || a.kind === "builtin" || a.sameName?.usedByClaude === false) continue;
      a.tokens += x.tokensToday ?? 0; // the card shows today's tokens
      if (x.status === "busy") {
        a.status = "running";
        if (x.liveNow) a.liveNow = { action: x.liveNow, model: x.model, effort: x.effort, tokens: 0 };
      } else if ((x.status === "waiting" || x.status === "stopping") && a.status !== "running") a.status = "waiting";
    }

    // Orchestrator: only an agent you made one (the `agent` setting). Otherwise your Claude Code chat leads the team.
    // (A team map that names an orchestrator the setting no longer has — "paused" in earlier versions — reads as the chat leading.)
    const orchName = this.config?.agentSetting ?? null;
    const formerOrch = !orchName ? teamMap?.orchestrator ?? null : null;
    const orch = orchName ? byName.get(orchName) : undefined;
    if (orch && orch.kind !== "builtin") orch.kind = "orchestrator";
    if (orch && orch.kind === "orchestrator") {
      // The chat running as the orchestrator: what it's really on. A model or effort picked in the chat wins for that
      // chat; new chats start on the orchestrator's model and the folder's effort (max starts at xhigh).
      const onModel = (x: Session) => x.runsAs === orch.name && x.model !== "unknown";
      const chat = sessions.find((x) => onModel(x) && x.status === "busy") ?? sessions.find(onModel);
      delete orch.actualModel; delete orch.actualEffort;
      const ran = chat ? { model: chat.model, effort: chat.effort } : null;
      if (ran && runDiffers(orch, ran) && runDiffers({ model: orch.model, effort: chatStartEffort(orch.model, orch.effort) }, ran)) {
        orch.actualModel = ran.model; orch.actualEffort = ran.effort;
      }
    }

    const orchKey = orch && orch.kind === "orchestrator" ? orch.key : null;

    // ── MCP servers: configured, plus inherited ones seen in use ("failing" once its connection is gone) ──
    // Crewglass's own agy bridge isn't shown as a server: the agy agents that use it stand for it.
    const mcps = new Map<string, McpServer>((this.config?.mcps ?? []).filter((m) => m.name !== AGY_SERVER && m.name !== LEGACY.agyServer).map((m) => [m.key, { ...m }]));
    const resolveEnd = (end: string): string | null => {
      if (end.startsWith("session:")) {
        // A chat's own activity belongs to the agent it runs as, else to the orchestrator, else to the chat card.
        const runsAs = sessions.find((x) => x.id === end.slice(8))?.runsAs;
        return (runsAs ? byName.get(runsAs)?.key : undefined) ?? orchKey ?? CHAT_KEY;
      }
      if (end === "agy") return agents.some((a) => a.key === "agy:agy") ? "agy:agy" : null;
      if (end.startsWith("mcp:")) {
        if (!mcps.has(end)) { const l = inheritedLabel(end.slice(4)); mcps.set(end, { key: end, name: l.name, scope: "inherited", source: l.source, type: "http", state: "remote", calls: 0 }); }
        return end;
      }
      return byName.get(end)?.key ?? null;
    };
    const links = new Map<string, Link>();
    const lastSeenAt = new Map<string, number>();
    for (const l of t.links.values()) {
      const from = resolveEnd(l.from);
      const to = resolveEnd(l.to);
      if (!from || !to || from === to) continue;
      const id = `obs:${from}>${to}`;
      const calls = (links.get(id)?.observed?.calls ?? 0) + l.calls;
      const last = Math.max(l.lastTs, lastSeenAt.get(id) ?? 0);
      lastSeenAt.set(id, last);
      links.set(id, { id, from, to, kind: l.kind, planned: false, observed: { calls, tokens: 0, lastSeen: relTime(last) }, active: now - last < 10_000 });
      if (to.startsWith("mcp:")) { const m = mcps.get(to)!; m.calls += l.calls; if (m.state === "configured") m.state = "in-use"; }
    }
    for (const server of t.mcpDown.keys()) { const m = mcps.get(`mcp:${server}`); if (m) m.state = "failing"; }

    // ── planned links (the team map) — observed activity on the same link is merged into it ──
    if (teamMap) {
      const endKey = (name: string) => (name === CHAT_NAME || name === formerOrch ? orchKey ?? CHAT_KEY
        : name.startsWith("mcp:") ? (mcps.has(name) ? name : null) : byName.get(name)?.key ?? null);
      for (const pl of teamMap.links) {
        const from = endKey(pl.from);
        const to = endKey(pl.to);
        if (!from || !to) continue;
        const obs = [...links.values()].find((l) => l.from === from && l.to === to && l.kind !== "checkedBy");
        if (obs && pl.kind !== "checkedBy") links.delete(obs.id);
        const id = `plan:${from}>${to}:${pl.kind}`;
        links.set(id, {
          id, from, to, kind: pl.kind, planned: true, observed: obs?.observed, active: obs?.active,
          ...(pl.kind === "direct" ? { directState: pl.directState ?? "allowed" } : {}),
          ...(pl.kind === "checkedBy" ? { check: { state: "checking" as const, tries: 0, label: pl.check ?? "Reviewer verdict" } } : {}),
          ...(folderData?.linkChecks[`${pl.from}>${pl.to}`]?.length ? { checks: folderData.linkChecks[`${pl.from}>${pl.to}`] } : {}),
        });
      }
    }

    // ── check results on the canvas: ✓ passed · ✗ failed (fix round n/2) · ⏳ checking ──
    const nameOf = new Map(agents.map((a) => [a.key, a.name]));
    for (const l of links.values()) {
      const target = nameOf.get(l.to);
      if (!target) continue;
      if (l.kind === "delegates") {
        const c = this.engine.checkStates.get(target);
        if (c && now - c.at < 6 * 3600_000) l.check = { state: c.state, tries: c.tries, label: c.label };
      } else if (l.kind === "checkedBy") {
        // The checker's latest VERDICT (only the word was read). Nothing yet: "waiting for a verdict".
        const v = t.verdicts.get(target);
        l.check = v ? { state: v.verdict === "PASS" ? "passed" : "failed", tries: 0, label: `${target}: VERDICT ${v.verdict}` } : { state: "checking", tries: 0, label: `waiting for ${target}'s verdict` };
      }
    }
    // Next poll, read verdicts only from the agents that check others.
    t.verdictAgents = new Set([...links.values()].filter((l) => l.kind === "checkedBy").map((l) => nameOf.get(l.to)).filter((n): n is string => !!n));

    // Direct-call rules for Live mode (D18), by agent name, from the links you drew.
    const nameOfKey = new Map(agents.map((a) => [a.key, a.name]));
    const direct = new Map<string, "allowed" | "orchestrator" | "you" | "blocked">();
    for (const l of links.values()) if (l.kind === "direct" && l.planned) direct.set(`${nameOfKey.get(l.from)}>${nameOfKey.get(l.to)}`, l.directState ?? "allowed");
    this.directRules = {
      state: (f, t) => direct.get(`${f}>${t}`),
      costly: (t) => { const a = byName.get(t); return !!a && isCostly(a.model, a.effort, a.kind === "agy"); },
      model: (t) => { const a = byName.get(t); return !a ? t : a.kind === "agy" ? `agy · ${modelWithEffort(a.geminiModel ?? "")} (via Haiku relay)` : modelWithEffort(a.model, a.effort); },
    };

    // ── charts: last 30 minutes ──
    const nowMin = Math.floor(now / 60_000);
    const series: SeriesPoint[] = [];
    for (let m = nowMin - 29; m <= nowMin; m++) {
      const b = t.minutes.get(m);
      series.push({ t: m, byModel: b ? { ...b.byModel } : {}, toolCalls: b?.toolCalls ?? 0, failures: b?.failures ?? 0 });
    }

    // ── history: past sessions in this folder, numbers only — Claude's last 30 days plus what Crewglass kept ──
    const history: HistoryRow[] = mergeHistory(this.storedHistory, this.liveHistory(), s.historyDays, startedLabel);

    const issues = detectFormatIssues({ sessionFields: this.sessionFields, kinds: this.kinds, statuses: this.statuses, transcripts: t.format });
    const version = this.live[0]?.version || t.format.version;
    const signature = issuesSignature(issues, version);

    return {
      ...base,
      sessions, agents, userAgents, mcps: [...mcps.values()], links: [...links.values()], orchestratorKey: orchKey, orchestratorPaused: false,
      activity: t.recentActivity(), series, processes: this.processes, history,
      formatIssues: issues.length && s.dismissedFormat !== signature ? issues : [], inbox: [...this.engine.items, ...this.alerts.items].sort((a, b) => b.at - a.at), todayTokens: t.todayTokens, todayCache: { ...t.todayCache },
      claudeVersion: version, loading: { ...t.progress },
      // Only looked up when the "Unknown fields" box needs it (it's in your Documents folder).
      sourceRepo: issues.length && s.dismissedFormat !== signature ? this.sourceRepoHere() : "",
      agy: { ...base.agy, tokensToday: t.agyTokensToday, callsToday: t.agyCallsToday },
      checks: checkCatalog,
    };
  }

  /** Crewglass's source folder for the "Unknown fields" box — "" when it isn't on this Mac (e.g. an app someone sent you). */
  private sourceRepoHere(): string {
    const p = this.settings.data.sourceRepo ?? this.sourceRepo;
    try { return p && statSync(p).isDirectory() ? p : ""; } catch { return ""; }
  }

  /** For the menu bar: is Claude working or waiting here, and how many inbox items are open (cheap — no snapshot). */
  quickStatus(): { busy: boolean; waiting: boolean; open: number } {
    if (!this.scope || !this.transcripts) return { busy: false, waiting: false, open: 0 };
    const sessions = this.buildSessions();
    const open = [...this.engine.items, ...this.alerts.items].filter((i) => !i.resolved).length;
    return { busy: sessions.some((s) => s.status === "busy"), waiting: sessions.some((s) => s.status === "waiting"), open };
  }

  /** Can agy agents work on this Mac? (Node, agy and the bridge; nothing is run to find out.) */
  private agyReadiness(): { ready: boolean; missing: string | null } {
    const e = this.agyEnv;
    const missing = !e.agy ? "agy isn't installed (looked in ~/.local/bin, Homebrew, /usr/local/bin and other usual places)"
      : !e.node ? "Node isn't installed (looked in Homebrew, /usr/local/bin, Volta, nvm and other usual places)" : !e.bridge ? "the agy bridge is missing from this build (run npm run build)" : null;
    return { ready: !missing, missing };
  }

  /** This folder's sessions as history rows (numbers and names only), from Claude's transcripts. */
  private liveHistory(): StoredRow[] {
    if (!this.transcripts) return [];
    return [...this.transcripts.sessions.values()].filter((x) => x.firstTs).map((x) => ({
      id: x.sessionId, startedAt: x.firstTs, lastAt: x.lastTs || x.firstTs,
      source: x.entrypoint === "claude-vscode" ? "vscode" : x.entrypoint === "sdk-cli" ? "headless" : "terminal",
      durationMin: Math.max(1, Math.round((x.lastTs - x.firstTs) / 60_000)), tokens: x.tokens, agents: [...x.agentsUsed], mcps: [...x.mcpsUsed].map((m) => inheritedLabel(m).name),
      failures: x.failures, models: [...x.models].map((m) => findModel(m)?.label ?? m),
    }));
  }

  /** Kept history for this folder (Crewglass's private data), refreshed about once a minute. */
  private storedHistory: StoredRow[] = [];
  private persistHistory() {
    if (!this.userData || !this.scope || !this.transcripts?.progress.done) return;
    this.storedHistory = saveHistory(this.userData, this.scope.folder, this.liveHistory(), this.settings.data.historyDays);
  }

  dismissFormat() {
    if (!this.transcripts) return;
    const issues = detectFormatIssues({ sessionFields: this.sessionFields, kinds: this.kinds, statuses: this.statuses, transcripts: this.transcripts.format });
    this.settings.update({ dismissedFormat: issuesSignature(issues, this.live[0]?.version || this.transcripts.format.version) });
  }
}
