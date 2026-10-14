// Central UI state. In the prototype a small simulator (mock/simulator.ts) drives the live parts;
// in the Electron app the same fields are filled from Claude Code's files and hooks.

import { create } from "zustand";
import type {
  ActivityEvent, Agent, Effort, FormatIssue, HistoryRow, InboxItem, Link, McpServer, ProcessRow, Session,
} from "@shared/types";
import { findModel, isCostly, modelWithEffort } from "@shared/models";
import { agyRelayInstructions } from "@shared/agy";
import { CHAT_KEY } from "@shared/teamMap";
import { checkCommandProblem, customCheckKey } from "@shared/checks";
import {
  CHECKS, FOLDER, FORMAT_ISSUES, ROLE_TEMPLATES, SECOND_SESSION, initialAgents, initialHistory, initialLinks,
  initialMcps, initialPositions, initialProcesses, initialSessions, initialUserAgents, SOURCE_REPO,
} from "../mock/fixtures";
import type { Design } from "./files";

export type Selection = { type: "agent" | "mcp" | "link" | "session"; id: string } | null;
export interface Toast { id: string; title: string; body: string; inboxId?: string; at: number }
export type { SeriesPoint } from "@shared/ipc";
import type { PipelineProgress, SeriesPoint } from "@shared/ipc";
import { tidyPositions } from "./layout";
export type BottomTab = "usage" | "activity" | "history";
type Pos = { x: number; y: number };

interface Snapshot { design: Design; summaries: string[] }

export interface DeckState extends Design {
  /** "prototype" = fake data in a browser; "real" = inside the Electron app, reading Claude Code's files. */
  mode: "prototype" | "real";
  /** Phase 1 only watches: edits are blocked with a clear message until the designer ships (Phase 3). */
  readOnly: boolean;
  suggestions: { path: string; why: string }[];
  sourceRepo: string;
  claudeVersion: string | null;
  testedVersion: string;
  loading: { done: boolean; files: number; read: number };
  /** Real app: a hook event has arrived since start, so Live mode is working. */
  liveActive: boolean;
  /** agy agents on this Mac (the prototype pretends everything is there). */
  agy: { ready: boolean; missing: string | null; models: string[]; tokensToday: number; callsToday: number };
  // setup
  onboarded: boolean;
  onboardStep: number;
  folder: string;
  recentFolders: string[];
  liveMode: boolean;
  limits: { session: number; day: number };
  // design extras
  userAgents: Agent[];
  positions: Record<string, Pos>;
  saved: Design;
  summaries: string[];
  undoStack: Snapshot[];
  /** Edits you undid (⇧⌘Z brings them back); any new edit clears it. */
  redoStack: Snapshot[];
  lastBackup: Design | null;
  // live
  sessions: Session[];
  selectedSession: string;
  stopFlag: boolean;
  todayTokens: number;
  todayCache: { write: number; read: number };
  todayUsd: number;
  todayUsdByModel: Record<string, number>;
  activity: ActivityEvent[];
  inbox: InboxItem[];
  toasts: Toast[];
  series: SeriesPoint[];
  processes: ProcessRow[];
  history: HistoryRow[];
  formatIssues: FormatIssue[];
  tick: number;
  story: number;
  checkFailStage: number;
  // ui
  selection: Selection;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  inboxOpen: boolean;
  reviewOpen: boolean;
  /** Run pipeline: the dialog, and the latest progress from the app (memory only). */
  runOpen: boolean;
  pipeline: PipelineProgress | null;
  settingsOpen: boolean;
  uninstallOpen: boolean;
  /** First-run wizard: the team preset to add once the new folder's first snapshot arrives. */
  pendingPreset: string | null;
  legendOpen: boolean;
  formatOpen: boolean;
  protoOpen: boolean;
  addMcpOpen: boolean;
  liveDialogOpen: boolean;
  menu: { x: number; y: number; key: string } | null;
}

const clone = <T,>(v: T): T => structuredClone(v);
let idSeq = 100;
const nid = (p: string) => `${p}${++idSeq}`;

export const designOf = (s: Design): Design => ({
  agents: s.agents, mcps: s.mcps, links: s.links, orchestratorKey: s.orchestratorKey,
  orchestratorPaused: s.orchestratorPaused, checks: s.checks, handoff: s.handoff,
});

function fullDesign(): Design {
  return { agents: initialAgents(), mcps: initialMcps(), links: initialLinks(), orchestratorKey: "project:lead", orchestratorPaused: false, checks: clone(CHECKS) };
}

/** What the folder looks like before you set up a team: only what Claude was seen doing. */
function emptyDesign(): Design {
  const all = initialAgents();
  return {
    agents: { "builtin:Explore": all["builtin:Explore"] },
    mcps: initialMcps(),
    links: initialLinks().filter((l) => !l.planned),
    orchestratorKey: null, orchestratorPaused: false, checks: clone(CHECKS),
  };
}

function initialSeries(): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  for (let i = 0; i < 30; i++) {
    const wave = Math.sin(i / 4) * 0.5 + 0.9;
    pts.push({
      t: i,
      byModel: {
        "claude-opus-5-5": Math.round(2600 * wave + (i % 3) * 180),
        "claude-sonnet-5-5": Math.round(700 * (1.2 - wave / 2) + (i % 4) * 60),
        "claude-haiku-4-5-20251001": i % 5 === 0 ? 240 : 60,
        "gemini-3.1-pro-high": i === 12 || i === 13 ? 900 : 0,
      },
      toolCalls: 4 + ((i * 7) % 6),
      failures: i === 9 || i === 22 ? 1 : 0,
    });
  }
  return pts;
}

export const useDeck = create<DeckState>(() => {
  const design = emptyDesign();
  return {
    ...design,
    onboarded: false,
    onboardStep: 0,
    folder: FOLDER,
    recentFolders: [FOLDER],
    liveMode: true,
    limits: { session: 25, day: 50 },
    userAgents: initialUserAgents(),
    positions: initialPositions(),
    saved: clone(design),
    summaries: [],
    undoStack: [], redoStack: [],
    lastBackup: null,
    sessions: initialSessions(),
    selectedSession: "s1",
    stopFlag: false,
    todayTokens: 340_000,
    todayCache: { write: 1_200_000, read: 9_800_000 },
    todayUsd: 18.4,
    todayUsdByModel: { "claude-opus-5-5": 14.9, "claude-sonnet-5-5": 3.1, "claude-haiku-4-5-20251001": 0.4 },
    activity: [],
    inbox: [],
    toasts: [],
    series: initialSeries(),
    processes: initialProcesses(),
    history: initialHistory(),
    formatIssues: [],
    tick: 0,
    story: 0,
    checkFailStage: 0,
    selection: null,
    bottomOpen: false,
    bottomTab: "usage",
    inboxOpen: false,
    reviewOpen: false,
    runOpen: false,
    pipeline: null,
    settingsOpen: false,
    uninstallOpen: false,
    pendingPreset: null,
    legendOpen: false,
    formatOpen: false,
    protoOpen: false,
    addMcpOpen: false,
    liveDialogOpen: false,
    menu: null,
    mode: "prototype",
    readOnly: false,
    suggestions: [],
    sourceRepo: SOURCE_REPO,
    claudeVersion: "2.1.290",
    testedVersion: "2.1.281",
    loading: { done: true, files: 0, read: 0 },
    liveActive: false,
    agy: { ready: true, missing: null, models: [], tokensToday: 0, callsToday: 0 },
  };
});

const set = useDeck.setState;
const get = useDeck.getState;

// ───────────────────────── helpers ─────────────────────────

export function toast(title: string, body: string, inboxId?: string) {
  // A pop-up for something already visible in the open inbox is just noise.
  if (inboxId && get().inboxOpen) return;
  const t: Toast = { id: nid("t"), title, body, inboxId, at: Date.now() };
  set((s) => ({ toasts: [...s.toasts, t].slice(-4) }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), 7000);
}

function addInbox(item: Omit<InboxItem, "id" | "at">): string {
  const full: InboxItem = { ...item, id: nid("i"), at: Date.now() };
  set((s) => ({ inbox: [full, ...s.inbox] }));
  if (full.popup) toast(full.title, full.detail, full.id);
  return full.id;
}

export function logActivity(e: Omit<ActivityEvent, "id" | "at" | "session">) {
  const ev: ActivityEvent = { ...e, id: nid("a"), at: Date.now(), session: get().selectedSession };
  set((s) => ({ activity: [ev, ...s.activity].slice(0, 500) }));
}

const agentName = (key: string) => (key === CHAT_KEY ? "your chat" : get().agents[key]?.name ?? key.split(":").pop() ?? key);
/** One link per from → to → kind (moving hand-offs between leads can meet an existing one). */
const dedupe = (links: Link[]) => links.filter((l, i) => links.findIndex((x) => x.from === l.from && x.to === l.to && x.kind === l.kind) === i);
/** Who hands work out: the orchestrator agent you chose, else your Claude Code chat. */
const leadKey = (d: Design) => activeOrchestrator(d) ?? CHAT_KEY;

function uniqueName(base: string): string {
  const taken = new Set([...Object.values(get().agents).map((a) => a.name), ...get().userAgents.map((a) => a.name)]);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

const PRESET_ROLES: Record<string, { label: string; roles: string[]; secondOpinion?: boolean }> = {
  "plan-code-review": { label: "Plan → Code → Review", roles: ["planner", "coder", "reviewer"] },
  "code-test-review": { label: "Code + Test + Review", roles: ["coder", "tester", "reviewer"], secondOpinion: true },
  "research-write": { label: "Research + Write", roles: ["researcher", "docs-writer"] },
};

/** Real folders: a preset only ADDS what's missing (role agents, hand-off links) — it never removes or replaces your
 *  agents. Agents that already exist by name are reused. Your Claude Code chat hands the work out (or the
 *  orchestrator agent, if you made one); a preset never creates an orchestrator agent. */
function realPreset(id: string) {
  const preset = PRESET_ROLES[id];
  if (!preset) return;
  const fresh = { status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [], checks: [], keepPrivate: false };
  edit(`Set up the ${preset.label} team`, (d) => {
    const byName = (n: string) => Object.values(d.agents).find((a) => a.name === n && a.kind !== "builtin" && a.sameName?.usedByClaude !== false);
    const orch = leadKey(d);
    const keyOf: Record<string, string> = {};
    for (const role of preset.roles) {
      const t = ROLE_TEMPLATES.find((r) => r.id === role)!;
      let a = byName(t.name);
      if (!a) {
        const key = `project:.claude/agents/${t.name}.md`;
        a = d.agents[key] = {
          ...fresh, key, name: t.name, kind: "subagent", scope: "project", file: `.claude/agents/${t.name}.md`, role: t.role, instructions: t.instructions,
          model: t.model, effort: t.effort, maxTurns: t.maxTurns, toolAccess: t.toolAccess, ...(t.omitClaudeMd ? { omitClaudeMd: true } : {}), builtinTools: t.builtinTools ?? ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
        };
      }
      keyOf[role] = a.key;
      if (a.key !== orch && !d.links.some((l) => l.from === orch && l.to === a!.key && l.kind === "delegates")) {
        d.links.push({ id: nid("l"), from: orch, to: a.key, kind: "delegates", planned: true });
      }
    }
    // A Gemini second opinion (an agy agent, kept private: the bridge exists only on this Mac) — when agy is here.
    if (preset.secondOpinion && get().agy.ready && !byName("gemini-reviewer")) {
      const key = "project:.claude/agents/gemini-reviewer.md";
      d.agents[key] = {
        ...fresh, key, name: "gemini-reviewer", kind: "agy", scope: "project", file: ".claude/agents/gemini-reviewer.md",
        role: "Use for an independent second opinion from Gemini on risky or security-sensitive changes.", instructions: agyRelayInstructions("gemini-3.1-pro-high"),
        model: "haiku", maxTurns: 3, toolAccess: "inherit", builtinTools: [], keepPrivate: true, geminiModel: "gemini-3.1-pro-high",
      };
      d.links.push({ id: nid("l"), from: orch, to: key, kind: "delegates", planned: true });
    }
    // The reviewer checks the coder's work (VERDICT: PASS / FAIL).
    if (keyOf.coder && keyOf.reviewer && !d.links.some((l) => l.from === keyOf.coder && l.to === keyOf.reviewer && l.kind === "checkedBy")) {
      d.links.push({ id: nid("l"), from: keyOf.coder, to: keyOf.reviewer, kind: "checkedBy", planned: true });
    }
  });
  useDeck.setState({ positions: tidyPositions() });
}

/** The "agy" card only shows that Claude ran the agy command here; an agy agent is how Gemini joins your team. */
export const AGY_SEEN = "agy:agy";
const AGY_SEEN_HINT = "This card only shows that Claude ran agy here. To give Gemini a role on your team, drag a Gemini model from the Library onto the canvas — that makes an agy agent.";

/** Every design edit goes through here: it snapshots for undo and records a plain-English summary. */
export function edit(summary: string, mutate: (d: Design) => void) {
  const s = get();
  if (s.readOnly) {
    toast("This version only watches", "Editing agents, links and MCP servers arrives with the designer (Phase 3). Nothing was changed.");
    return;
  }
  const snap: Snapshot = { design: clone(designOf(s)), summaries: [...s.summaries] };
  const d = clone(designOf(s));
  mutate(d);
  set({ ...d, undoStack: [...s.undoStack, snap].slice(-50), redoStack: [], summaries: [...s.summaries, summary] });
}

// ───────────────────────── design actions ─────────────────────────

export const actions = {
  select(sel: Selection) { set({ selection: sel, menu: null }); },

  setPosition(key: string, pos: Pos) { set((s) => ({ positions: { ...s.positions, [key]: pos } })); },

  undo() {
    const s = get();
    const snap = s.undoStack[s.undoStack.length - 1];
    if (!snap) { toast("Nothing to undo", "There are no unsaved canvas edits."); return; }
    const now: Snapshot = { design: clone(designOf(s)), summaries: [...s.summaries] };
    set({ ...snap.design, summaries: snap.summaries, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, now].slice(-50) });
  },

  redo() {
    const s = get();
    const snap = s.redoStack[s.redoStack.length - 1];
    if (!snap) { toast("Nothing to redo", "Redo brings back an edit you undid."); return; }
    const now: Snapshot = { design: clone(designOf(s)), summaries: [...s.summaries] };
    set({ ...snap.design, summaries: snap.summaries, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, now].slice(-50) });
  },

  discard() { const s = get(); set({ ...clone(s.saved), summaries: [], undoStack: [], redoStack: [], reviewOpen: false }); },

  save(fileCount: number) {
    const s = get();
    set({ lastBackup: clone(s.saved), saved: clone(designOf(s)), summaries: [], undoStack: [], redoStack: [], reviewOpen: false });
    toast("Saved", `${fileCount} file${fileCount === 1 ? "" : "s"} written. A backup of the old versions was kept (Undo last save).`);
  },

  undoLastSave() {
    const s = get();
    if (s.mode === "real") {
      void window.crewglass?.undoLastSave().then((r) => toast(r.ok ? "Restored" : "Nothing restored", r.ok ? "The files from before your last save are back." : r.error ?? ""));
      set({ lastBackup: null });
      return;
    }
    if (!s.lastBackup) return;
    set({ ...clone(s.lastBackup), saved: clone(s.lastBackup), lastBackup: null, summaries: [], undoStack: [], redoStack: [] });
    toast("Restored", "The files from before your last save are back.");
  },

  updateAgent(key: string, patch: Partial<Agent>, summary: string) {
    const unsaved = !get().saved.agents[key];
    edit(summary, (d) => {
      const a = { ...d.agents[key], ...patch };
      // A new agent's file follows its name until it's saved.
      if (unsaved && patch.name) a.file = a.scope === "user" ? `~/.claude/agents/${patch.name}.md` : `.claude/agents/${patch.name}.md`;
      d.agents[key] = a;
    });
  },

  setModel(key: string, model: string, effort?: Effort) {
    const a = get().agents[key];
    if (!a) return;
    if (a.kind === "builtin") { toast("Built-in agent", "Built-in agents can't be changed; they're watch only."); return; }
    const m = findModel(model);
    if (m?.family === "gemini") {
      if (a.kind !== "agy") { toast("Use an agy agent for Gemini", "Drop the Gemini model on empty canvas to create an agy agent, or on an existing agy agent."); return; }
      edit(`Set ${a.name} to agy · ${m.label}`, (d) => {
        d.agents[key] = { ...d.agents[key], geminiModel: model, instructions: agyRelayInstructions(model) };
      });
      return;
    }
    if (a.kind === "agy") { toast("agy agents use Gemini", "This agent is a relay to agy. Drop a Gemini model on it instead."); return; }
    const eff = m?.usesEffort ? (effort ?? a.effort ?? "medium") : undefined;
    edit(`Set ${a.name} to ${modelWithEffort(model, eff)}`, (d) => { d.agents[key] = { ...d.agents[key], model: m?.alias ?? model, effort: eff }; });
  },

  addAgentFromTemplate(templateId: string, pos: Pos) {
    const t = ROLE_TEMPLATES.find((r) => r.id === templateId);
    if (!t) return;
    const name = uniqueName(t.name);
    const key = `project:.claude/agents/${name}.md`;
    const orch = leadKey(get());
    edit(`Create agent ${name} (${modelWithEffort(t.model, t.effort)})`, (d) => {
      d.agents[key] = {
        key, name, kind: "subagent", scope: "project", file: `.claude/agents/${name}.md`, role: t.role, instructions: t.instructions,
        model: t.model, effort: t.effort, maxTurns: t.maxTurns, toolAccess: t.toolAccess, ...(t.omitClaudeMd ? { omitClaudeMd: true } : {}),
        builtinTools: t.builtinTools ?? ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], keepPrivate: false, checks: [],
        status: "idle", parallel: 0, tokens: 0, calls: 0, skillsUsed: [],
      };
      d.links.push({ id: nid("l"), from: orch, to: key, kind: "delegates", planned: true });
    });
    actions.setPosition(key, pos);
    set({ selection: { type: "agent", id: key } });
  },

  addAgentFromModel(model: string, effort: Effort | undefined, pos: Pos) {
    const m = findModel(model);
    const gemini = m?.family === "gemini";
    const name = uniqueName(gemini ? "gemini-helper" : "new-agent");
    const key = `project:.claude/agents/${name}.md`;
    const orch = leadKey(get());
    const label = gemini ? `agy · ${m?.label}` : modelWithEffort(model, effort);
    edit(`Create agent ${name} (${label})`, (d) => {
      d.agents[key] = {
        key, name, kind: gemini ? "agy" : "subagent", scope: "project", file: `.claude/agents/${name}.md`,
        role: gemini ? "Use for a second opinion from Gemini via agy." : "Describe when Claude should use this agent.",
        instructions: gemini ? agyRelayInstructions(model) : "Describe what this agent should do.",
        model: gemini ? "haiku" : (m?.alias ?? model), effort: gemini ? undefined : effort, maxTurns: gemini ? 3 : 30,
        toolAccess: "inherit", builtinTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], keepPrivate: gemini,
        geminiModel: gemini ? model : undefined, checks: [], status: "idle", parallel: 0, tokens: 0, calls: 0, skillsUsed: [],
      };
      d.links.push({ id: nid("l"), from: orch, to: key, kind: "delegates", planned: true });
    });
    actions.setPosition(key, pos);
    set({ selection: { type: "agent", id: key } });
  },

  addUserAgentToCanvas(key: string, pos: Pos) {
    const u = get().userAgents.find((a) => a.key === key);
    if (!u) return;
    if (get().agents[key]) { toast("Already on the canvas", `${u.name} is already part of this team.`); return; }
    if (u.sameName && !u.sameName.usedByClaude) {
      toast("Hidden by the project version", `Claude uses the project's ${u.name}. Rename one of them if you want both.`);
    }
    const orch = leadKey(get());
    edit(`Add ${u.name} (all-projects agent) to this team`, (d) => {
      d.agents[key] = clone(u);
      d.links.push({ id: nid("l"), from: orch, to: key, kind: "delegates", planned: true });
    });
    actions.setPosition(key, pos);
  },

  connect(from: string, to: string) {
    const s = get();
    if (from === to) return;
    const fromMcp = from.startsWith("mcp:");
    const toMcp = to.startsWith("mcp:");
    if (fromMcp) { toast("Not a valid link", "Links start at an agent. Drag from the agent to the MCP server instead."); return; }
    if (from === AGY_SEEN || to === AGY_SEEN) { toast("agy isn't a team member", AGY_SEEN_HINT); return; }
    if (to === CHAT_KEY) { toast("Not a valid link", "Work goes from your chat to the agents. Drag from the chat card to an agent instead."); return; }
    if (from === CHAT_KEY && toMcp) { toast("Your chat already has its servers", "The chat uses every MCP server Claude Code has here. Drop a server onto an agent to let that agent use it."); return; }
    const exists = s.links.find((l) => l.from === from && l.to === to && l.kind !== "checkedBy");
    if (exists) {
      if (!exists.planned) { actions.keepLink(exists.id); return; }
      toast("Already linked", "These two are already connected."); return;
    }
    let kind: Link["kind"] = "direct";
    if (toMcp) kind = "uses";
    else if (from === leadKey(s)) kind = "delegates";
    else if (from === CHAT_KEY) { toast("An agent leads here", "The orchestrator you chose hands out the work. Drag from its card, or right-click it → Let the chat lead."); return; }
    const fromName = agentName(from);
    const toName = toMcp ? s.mcps[to]?.name : agentName(to);
    const summary = kind === "uses" ? `Let ${fromName} use ${toName}` : kind === "delegates" ? `${fromName} hands work to ${toName}` : `Allow ${fromName} → ${toName} direct calls (approved by you)`;
    edit(summary, (d) => {
      d.links.push({ id: nid("l"), from, to, kind, planned: true, directState: kind === "direct" ? "allowed" : undefined });
      if (kind === "uses" && d.agents[from]?.toolAccess === "inherit") d.agents[from] = { ...d.agents[from], toolAccess: "connected" };
    });
  },

  keepLink(id: string) {
    const l = get().links.find((x) => x.id === id);
    if (!l) return;
    if (l.from === AGY_SEEN || l.to === AGY_SEEN) { toast("agy isn't a team member", AGY_SEEN_HINT); return; }
    edit(`Keep ${agentName(l.from)} → ${l.to.startsWith("mcp:") ? get().mcps[l.to]?.name : agentName(l.to)} (seen in use)`, (d) => {
      d.links = d.links.map((x) => (x.id === id ? { ...x, planned: true, directState: x.kind === "direct" ? "allowed" : x.directState } : x));
    });
  },

  removeLink(id: string) {
    const l = get().links.find((x) => x.id === id);
    if (!l) return;
    edit(`Remove link ${agentName(l.from)} → ${l.to.startsWith("mcp:") ? get().mcps[l.to]?.name : agentName(l.to)}`, (d) => {
      d.links = d.links.filter((x) => x.id !== id);
    });
    set({ selection: null });
  },

  /** "Always allow A → B": draws (or flips) an Allowed direct link by agent NAME — the copy Claude actually uses. */
  allowDirect(caller: string, callee: string) {
    const byName = (n: string) => {
      const all = Object.values(get().agents).filter((a) => a.name === n);
      return (all.find((a) => a.sameName?.usedByClaude !== false) ?? all[0])?.key;
    };
    const from = byName(caller);
    const to = byName(callee);
    if (!from || !to) { toast("Agent not in this team", `${!from ? caller : callee} isn't on the canvas, so there's no link to allow.`); return; }
    const l = get().links.find((x) => x.from === from && x.to === to && x.kind === "direct");
    if (l) { actions.setDirectState(l.id, "allowed"); return; }
    edit(`Always allow ${caller} → ${callee} direct calls`, (d) => {
      d.links.push({ id: nid("l"), from, to, kind: "direct", planned: true, directState: "allowed" });
    });
  },

  setDirectState(id: string, state: Link["directState"]) {
    const l = get().links.find((x) => x.id === id);
    if (!l) return;
    const words = { allowed: "allowed", orchestrator: "orchestrator decides", you: "needs your OK", blocked: "blocked" } as const;
    edit(`${agentName(l.from)} → ${agentName(l.to)} direct calls: ${words[state ?? "orchestrator"]}`, (d) => {
      d.links = d.links.map((x) => (x.id === id ? { ...x, directState: state, planned: true } : x));
    });
  },

  makeOrchestrator(key: string) {
    const a = get().agents[key];
    if (!a || a.kind === "builtin" || a.kind === "agy") { toast("Can't be the orchestrator", "Choose one of your Claude agents."); return; }
    edit(`Make ${a.name} the orchestrator (new chats run as it)`, (d) => {
      const prev = leadKey(d);
      if (prev !== CHAT_KEY && d.agents[prev]) d.agents[prev] = { ...d.agents[prev], kind: "subagent" };
      d.agents[key] = { ...d.agents[key], kind: "orchestrator" };
      d.orchestratorKey = key;
      d.orchestratorPaused = false;
      // The hand-offs move to the new orchestrator (the one it had to itself is dropped).
      d.links = dedupe(d.links.filter((l) => !(l.from === prev && l.to === key && l.kind === "delegates"))
        .map((l) => (l.from === prev && l.kind === "delegates" ? { ...l, from: key } : l)));
    });
  },

  /** /handoff and /pickup in this folder (written on Save, after Review changes). */
  toggleHandoff() {
    const on = !get().handoff;
    edit(on ? "Add the /handoff and /pickup commands" : "Remove the /handoff and /pickup commands", (d) => { d.handoff = on; });
  },

  /** Back to the default: your Claude Code chat leads, and the orchestrator agent becomes a regular agent. */
  letChatLead() {
    const s = get();
    const orch = s.orchestratorKey;
    if (!orch) return;
    edit(`Let your Claude Code chat lead (${agentName(orch)} becomes a regular agent)`, (d) => {
      if (d.agents[orch]) d.agents[orch] = { ...d.agents[orch], kind: "subagent" };
      d.orchestratorKey = null;
      d.orchestratorPaused = false;
      d.links = dedupe(d.links.map((l) => (l.from === orch && l.kind === "delegates" ? { ...l, from: CHAT_KEY } : l)));
    });
  },

  toggleDisabled(key: string) {
    const a = get().agents[key];
    if (!a) return;
    edit(a.disabled ? `Enable ${a.name} in this folder` : `Disable ${a.name} in this folder`, (d) => {
      d.agents[key] = { ...d.agents[key], disabled: !a.disabled };
    });
  },

  deleteAgent(key: string) {
    const a = get().agents[key];
    if (!a) return;
    if (key === get().orchestratorKey) { toast("Can't delete the orchestrator", "Right-click it → Let the chat lead first (or make another agent the orchestrator)."); return; }
    edit(`Delete agent ${a.name} (a backup is kept)`, (d) => {
      delete d.agents[key];
      d.links = d.links.filter((l) => l.from !== key && l.to !== key);
    });
    set({ selection: null });
  },

  duplicate(key: string) {
    const a = get().agents[key];
    if (!a || a.kind === "builtin") return;
    const name = uniqueName(a.name);
    const nkey = `project:.claude/agents/${name}.md`;
    const p = get().positions[key] ?? { x: 0, y: 0 };
    const orch = leadKey(get());
    edit(`Duplicate ${a.name} as ${name}`, (d) => {
      d.agents[nkey] = { ...clone(a), key: nkey, name, kind: a.kind === "orchestrator" ? "subagent" : a.kind, scope: "project",
        file: `.claude/agents/${name}.md`, status: "idle", tokens: 0, calls: 0, parallel: 0, liveNow: undefined, sameName: undefined };
      d.links.push({ id: nid("l"), from: orch, to: nkey, kind: "delegates", planned: true });
    });
    actions.setPosition(nkey, { x: p.x + 40, y: p.y + 160 });
  },

  addCheck(agentKey: string, checkId: string) {
    const a = get().agents[agentKey];
    const c = get().checks[checkId];
    if (!a || !c) return;
    if (a.kind === "builtin") { toast("Built-in agent", "Checks can be added to your own agents."); return; }
    if (c.kind === "command") {
      if (a.checks.includes(checkId)) { toast("Already added", `${a.name} already has ${c.label}.`); return; }
      edit(`Check ${a.name}'s work with ${c.label}`, (d) => { d.agents[agentKey] = { ...d.agents[agentKey], checks: [...a.checks, checkId] }; });
      toast("You'll confirm the command once", `Review changes shows "${c.command}" before it's saved. It's stored privately in Crewglass, never in the repo.`);
      return;
    }
    // The checker is named (Claude runs agents by name): use the copy Claude actually uses.
    const named = Object.values(get().agents).filter((x) => x.name === c.checkerAgent && x.kind !== "builtin");
    const checker = (named.find((x) => x.sameName?.usedByClaude !== false) ?? named[0])?.key;
    if (!checker) { toast("Add the checker first", `Put ${c.checkerAgent} on the canvas (Library → Agents), then add this check.`); return; }
    if (checker === agentKey) { toast("Not on itself", "An agent can't check its own work."); return; }
    if (get().links.some((l) => l.from === agentKey && l.to === checker && l.kind === "checkedBy")) { toast("Already added", `${c.checkerAgent} already checks ${a.name}.`); return; }
    edit(`${agentName(agentKey)}'s work is checked by ${agentName(checker)}`, (d) => {
      d.links.push({ id: nid("l"), from: agentKey, to: checker, kind: "checkedBy", planned: true, check: { state: "checking", tries: 0, label: c.label } });
    });
  },

  /** A command check you type yourself (one command, no shell). It's saved privately once you confirm it in Review changes. */
  addCustomCheck(command: string): string | null {
    const problem = checkCommandProblem(command);
    if (problem) { toast("Can't use that command", problem); return null; }
    const key = customCheckKey(command);
    if (get().checks[key]) return key;
    edit(`Add the check \`${command.trim()}\``, (d) => { d.checks[key] = { key, kind: "command", label: command.trim(), command: command.trim() }; });
    return key;
  },

  /** Same-name agents: give this copy a free name (e.g. reviewer-2) so both can be used. Saved like any edit. */
  renameCopy(key: string) {
    const a = get().agents[key];
    if (!a || a.kind === "builtin") return;
    const name = uniqueName(`${a.name}-2`);
    actions.updateAgent(key, { name }, `Rename this copy of ${a.name} to ${name} (so both can be used)`);
    toast("Renamed", `This copy is now “${name}”. Change the name in the details panel if you like, then Save.`);
  },

  /** A command check on a hand-off link: it checks the receiving agent's work whenever this link handed it over. */
  addLinkCheck(linkId: string, checkId: string) {
    const l = get().links.find((x) => x.id === linkId);
    const c = get().checks[checkId];
    if (!l || !c) return;
    if (l.kind !== "delegates" && l.kind !== "direct") { toast("Not on this link", "Checks go on hand-offs (and direct calls) between agents, or on an agent."); return; }
    if (c.kind !== "command") { actions.addCheck(l.to, checkId); return; } // a reviewer checks the receiving agent's work
    if (l.checks?.includes(checkId)) { toast("Already added", `${c.label} already checks this hand-off.`); return; }
    edit(`Check ${agentName(l.to)}'s work with ${c.label} when ${agentName(l.from)} hands it work`, (d) => {
      d.links = d.links.map((x) => (x.id === linkId ? { ...x, planned: true, checks: [...(x.checks ?? []), checkId] } : x));
    });
    toast("You'll confirm the command once", `Review changes shows "${c.command}" before it's saved. It's stored privately in Crewglass, never in the repo.`);
  },

  removeLinkCheck(linkId: string, checkId: string) {
    const l = get().links.find((x) => x.id === linkId);
    if (!l) return;
    edit(`Remove ${get().checks[checkId]?.label ?? checkId} from ${agentName(l.from)} → ${agentName(l.to)}`, (d) => {
      d.links = d.links.map((x) => (x.id === linkId ? { ...x, checks: (x.checks ?? []).filter((k) => k !== checkId) } : x));
    });
  },

  removeCheck(agentKey: string, checkId: string) {
    const a = get().agents[agentKey];
    if (!a) return;
    edit(`Remove ${get().checks[checkId]?.label ?? checkId} from ${a.name}`, (d) => {
      d.agents[agentKey] = { ...d.agents[agentKey], checks: a.checks.filter((c) => c !== checkId) };
    });
  },

  addMcp(name: string, scope: McpServer["scope"], envNames: string[], how: { command?: string; url?: string } = {}) {
    const key = `mcp:${name}`;
    if (get().mcps[key]) { toast("Already added", `${name} is already configured.`); return; }
    edit(`Add MCP server ${name} (${scope === "project" ? "shared, .mcp.json" : scope === "local" ? "only you, this folder" : "only you, all projects"})`, (d) => {
      d.mcps[key] = { key, name, scope, type: how.url ? "http" : "stdio", state: scope === "project" ? "needs-approval" : "configured", calls: 0, envNames,
        ...(how.url ? { url: how.url } : { command: how.command ?? "" }) };
    });
    actions.setPosition(key, { x: 1000, y: 540 });
    set({ addMcpOpen: false });
  },

  removeMcp(key: string) {
    const m = get().mcps[key];
    if (!m) return;
    if (m.scope === "inherited") { toast("Inherited server", "This server comes from a claude.ai connector or plugin; manage it there."); return; }
    edit(`Remove MCP server ${m.name}`, (d) => {
      delete d.mcps[key];
      d.links = d.links.filter((l) => l.to !== key);
    });
    set({ selection: null });
  },

  /** First-run wizard finished: apply the chosen team preset as pending (unsaved) changes. */
  finishOnboarding(presetId: string) {
    set({ onboarded: true });
    actions.applyPreset(presetId);
    if (presetId !== "watch") toast("Team ready to review", "Your team is on the canvas. Nothing is written until you open Review changes and press Save.");
  },

  /** Prototype shortcut: jump straight to a folder whose team is already saved. */
  skipOnboarding() {
    const d = fullDesign();
    set({ ...d, saved: clone(d), summaries: [], undoStack: [], redoStack: [], onboarded: true });
  },

  applyPreset(id: string) {
    if (id === "watch") return;
    if (get().mode === "real") { realPreset(id); return; }
    const full = fullDesign();
    const keep = (keys: string[]) => {
      for (const k of Object.keys(full.agents)) if (!keys.includes(k)) delete full.agents[k];
      full.links = full.links.filter((l) => (full.agents[l.from] || l.from.startsWith("mcp:")) && (full.agents[l.to] || l.to.startsWith("mcp:")));
    };
    if (id === "plan-code-review") keep(["project:lead", "project:planner", "project:coder", "project:reviewer", "builtin:Explore"]);
    if (id === "code-test-review") keep(["project:lead", "project:coder", "project:tester", "project:reviewer", "project:gemini-reviewer", "builtin:Explore"]);
    if (id === "research-write") keep(["project:lead", "builtin:Explore"]);
    const preset = { "plan-code-review": "Plan → Code → Review", "code-test-review": "Code + Test + Review", "research-write": "Research + Write" }[id] ?? id;
    edit(`Set up the ${preset} team`, (d) => { Object.assign(d, full); });
    if (id === "research-write") {
      actions.addAgentFromTemplate("researcher", { x: 300, y: 250 });
      actions.addAgentFromTemplate("docs-writer", { x: 700, y: 250 });
    }
  },

  // ───────────────────────── live actions ─────────────────────────

  stop(sessionId: string | "all") {
    const s = get();
    if (s.mode === "real") {
      // Stop works through Live mode's hooks; without them nothing could stop Claude, so don't pretend.
      if (!s.liveMode) { toast("Stop needs Live mode", "Turn on Live mode for this folder (right-hand panel) — then Stop halts Claude at its next step."); return; }
      // The app answers Claude's next tool event with "stop"; the status comes back in the next snapshot.
      void window.crewglass?.stop(sessionId);
      set({ stopFlag: true, sessions: s.sessions.map((x) => (sessionId === "all" || x.id === sessionId ? { ...x, status: "stopping" } : x)) });
      return;
    }
    set({
      stopFlag: true,
      sessions: s.sessions.map((x) => (sessionId === "all" || x.id === sessionId ? { ...x, status: "stopping" } : x)),
    });
    logActivity({ agent: "Crewglass", tool: "Stop", target: "stopping at the next tool event", model: "", result: "stopped" });
  },

  resume() {
    const s = get();
    if (s.mode === "real") { void window.crewglass?.resume(); set({ stopFlag: false }); return; }
    set({
      stopFlag: false,
      sessions: s.sessions.map((x) => ({ ...x, status: "busy" })),
      agents: Object.fromEntries(Object.entries(s.agents).map(([k, a]) => [k, a.status === "stopped" ? { ...a, status: "idle" } : a])),
    });
  },

  resolveInbox(id: string, choice: string, note?: string) {
    const item = get().inbox.find((i) => i.id === id);
    if (!item) return;
    const labels: Record<string, string> = {
      orchestrator: "Handed to the orchestrator", instructions: `Your instructions were sent${note ? `: "${note}"` : ""}`,
      allow: "Retries allowed; count reset", stop: "Claude stopped", once: "Approved once", always: "Always allowed (added to Review changes)",
      deny: `Denied${note ? `: "${note}"` : ""}`, answered: "Answered in VS Code", raise: "Limit raised by 50%", ok: "Dismissed",
      timeout: "No answer in 2 min — sent to the orchestrator",
    };
    set((s) => ({ inbox: s.inbox.map((i) => (i.id === id ? { ...i, resolved: labels[choice] ?? choice } : i)) }));
    if (choice === "stop") actions.stop("all");
    if (choice === "raise") set((s) => ({ limits: { ...s.limits, session: Math.round(s.limits.session * 1.5) } }));
    if (choice === "always") actions.allowDirect(String(item.data?.caller), String(item.data?.callee));
    if (item.kind === "approval") {
      const result = choice === "once" || choice === "always" ? "ok" : "denied";
      logActivity({ agent: String(item.data?.caller), tool: "Agent", target: `→ ${item.data?.callee} (${labels[choice]})`, model: "claude-opus-5-5", effort: "medium", result });
    }
    if (item.kind === "permission") {
      set((s) => ({ sessions: s.sessions.map((x) => (x.status === "waiting" ? { ...x, status: "busy" } : x)) }));
    }
  },

  scenario(name: string) {
    const now = Date.now();
    switch (name) {
      case "failing-command": {
        for (let i = 0; i < 3; i++) logActivity({ agent: "coder", tool: "Bash", target: "npm run build", model: "claude-opus-5-5", effort: "medium", durationMs: 4200, result: "error" });
        addInbox({ kind: "failing-command", popup: true, title: "Paused: `npm run build` failed 3 times",
          detail: "coder ran the same command 3 times with no file changes in between. It's paused; Claude can keep doing other work.",
          data: { command: "npm run build", agent: "coder", count: 3 } });
        break;
      }
      case "approval": {
        // Pick a costly agent that is actually on the canvas: an agy agent first, else Opus at high effort or above.
        const all = Object.values(get().agents).filter((a) => a.key !== "project:coder" && !a.disabled);
        const callee = all.find((a) => a.kind === "agy") ?? all.find((a) => a.kind !== "orchestrator" && isCostly(a.model, a.effort, false));
        if (!callee || !get().agents["project:coder"]) { toast("Nothing costly to call", "Add an agy agent or an Opus agent at high effort to try this."); break; }
        const reason = callee.kind === "agy" ? "this touches auth token handling; I want a second opinion before finishing" : "the plan misses the migration step; I need it re-planned before I continue";
        const model = callee.kind === "agy" ? `agy · ${modelWithEffort(callee.geminiModel ?? "")} (via Haiku relay)` : modelWithEffort(callee.model, callee.effort);
        set((s) => ({ links: s.links.map((l) => (l.from === "project:coder" && l.to === callee.key ? { ...l, active: true, lastReason: reason } : l)) }));
        addInbox({ kind: "approval", popup: true, title: `coder wants to call ${callee.name}`, detail: `Reason: "${reason}"`,
          data: { caller: "coder", callee: callee.name, model, deadline: now + 120_000, costly: true } });
        break;
      }
      case "check-fails": {
        set((s) => ({ checkFailStage: 1, links: s.links.map((l) => (l.kind === "checkedBy" && l.from === "project:coder" ? { ...l, check: { ...l.check!, state: "failed", tries: 1 } } : l)) }));
        logActivity({ agent: "coder", tool: "Check", target: "Reviewer verdict: FAIL — sent back to fix (try 1 of 2)", model: "claude-sonnet-5-5", effort: "high", result: "error" });
        break;
      }
      case "limit-80": {
        const lim = get().limits.session;
        set((s) => ({ sessions: s.sessions.map((x, i) => (i === 0 ? { ...x, tokens: Math.round(lim * 0.81) } : x)) }));
        addInbox({ kind: "limit", popup: false, title: "This session is at 80% of its token limit", detail: "1.6M of 2M tokens. Claude keeps going; nothing is stopped automatically." });
        break;
      }
      case "limit-100": {
        const lim = get().limits.session;
        set((s) => ({ sessions: s.sessions.map((x, i) => (i === 0 ? { ...x, tokens: lim + 20_000 } : x)) }));
        addInbox({ kind: "limit", popup: true, title: "This session reached its token limit", detail: "2M of 2M tokens. Claude keeps going; you can stop it or raise the limit." });
        break;
      }
      case "context": {
        set((s) => ({ sessions: s.sessions.map((x, i) => (i === 0 ? { ...x, contextTokens: 862_000 } : x)) }));
        addInbox({ kind: "context", popup: false, title: "Context is 86% full", detail: "Claude will soon compact the conversation. Consider /compact or starting a fresh task." });
        break;
      }
      case "permission": {
        set((s) => ({ sessions: s.sessions.map((x, i) => (i === 0 ? { ...x, status: "waiting" } : x)) }));
        addInbox({ kind: "permission", popup: false, title: "Claude needs permission in VS Code",
          detail: "lead wants to run: git push origin crewglass. If it's still waiting after 20 s you'll get a pop-up.",
          data: { popupAt: now + 20_000 } });
        break;
      }
      case "stuck": {
        addInbox({ kind: "stuck", popup: false, title: "Claude may be stuck", detail: "5 different failures in the last 10 minutes. Nothing was paused automatically." });
        break;
      }
      case "mcp-died": {
        set((s) => ({ mcps: { ...s.mcps, "mcp:github": { ...s.mcps["mcp:github"], state: "failing" } } }));
        addInbox({ kind: "mcp-died", popup: false, title: "github MCP server stopped", detail: "Its process exited. Claude will report tool errors until it's reconnected (/mcp)." });
        break;
      }
      case "unknown-fields": {
        set((s) => ({ formatIssues: s.formatIssues.length ? [] : FORMAT_ISSUES, formatOpen: false }));
        break;
      }
      case "two-sessions": {
        if (!get().sessions.find((x) => x.id === "s2")) set((s) => ({ sessions: [...s.sessions, SECOND_SESSION] }));
        break;
      }
      case "secret": {
        const a = get().agents["project:coder"];
        if (a) actions.updateAgent("project:coder", { instructions: `${a.instructions}\nUse token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 for GitHub.` }, "Edit coder's instructions (pasted a GitHub token)");
        set({ reviewOpen: true });
        break;
      }
      case "this-chat": {
        // Exactly this conversation: one VS Code session on Opus 5.5 · xhigh, no subagents, no MCP servers, one skill used.
        const d: Design = { agents: {}, mcps: {}, links: [], orchestratorKey: null, orchestratorPaused: false, checks: clone(CHECKS) };
        set({ ...d, saved: clone(d), summaries: [], undoStack: [], redoStack: [], onboarded: true, selection: null, inbox: [], activity: [],
          sessions: [{ id: "s1", name: "agent-app-76", source: "vscode", status: "busy", model: "claude-opus-5-5", effort: "xhigh",
            contextTokens: 412_000, tokens: 1_630_000, skillsUsed: ["dataviz"], liveNow: "Edit src/renderer/components/canvas/Canvas.tsx" }] });
        break;
      }
      case "reset": {
        const e = emptyDesign();
        set({ ...e, saved: clone(e), summaries: [], undoStack: [], redoStack: [], onboarded: false, onboardStep: 0, selection: null, inbox: [], formatIssues: [], protoOpen: false });
        break;
      }
    }
  },
};

// ───────────────────────── derived helpers ─────────────────────────

/** The orchestrator the main session runs as, or null when there is none (or it's paused). */
export function activeOrchestrator(s: Design): string | null {
  return s.orchestratorKey && !s.orchestratorPaused && s.agents[s.orchestratorKey] ? s.orchestratorKey : null;
}

export function sessionTotals(s: DeckState) {
  const session = s.sessions.find((x) => x.id === s.selectedSession) ?? s.sessions[0];
  const window = findModel(session?.model ?? "")?.contextWindow ?? 200_000;
  return { session, contextPct: session ? Math.round((session.contextTokens / window) * 100) : 0 };
}

export function linkCostly(s: DeckState, toKey: string): boolean {
  const a = s.agents[toKey];
  return !!a && isCostly(a.model, a.effort, a.kind === "agy");
}
