// The contract between Crewglass's main process (reads Claude Code's files) and its UI.
// The UI can only call the functions in DeckApi — nothing else from the operating system is exposed.

import type {
  ActivityEvent, Agent, Check, FormatIssue, HistoryRow, InboxItem, Link, McpScope, McpServer, ProcessRow, Session,
} from "./types";
import type { SecretHit } from "./secretGuard";

/** What you designed on the canvas. The app turns it into an exact file plan (you review it), then writes it. */
export interface DesignPayload {
  agents: Agent[];
  mcps: McpServer[];
  links: Link[];
  orchestratorKey: string | null;
  orchestratorPaused: boolean;
  checks: Record<string, Check>;
  /** Agents you deleted (their files are removed; a backup is kept). */
  deletedKeys: string[];
  /** MCP servers you removed, and where each one was configured (it's no longer in `mcps`). */
  removedMcpKeys: string[];
  removedMcpScopes?: Record<string, McpScope>;
}

export interface PlanFile {
  path: string;
  /** Path as shown to you (relative to the folder, or ~/...). */
  display: string;
  before: string;
  /** null = the file will be deleted (a backup is kept). */
  after: string | null;
  shared: boolean;
  hits: SecretHit[];
}

export interface SavePlan {
  id: string;
  files: PlanFile[];
  /** Official `claude mcp add|remove` commands for private (local / user) MCP servers. */
  commands: { label: string; argv: string[] }[];
  warnings: string[];
  /** A file shared through git contains something that looks like a key: Save is blocked. */
  blocked: boolean;
  /** Something under ~/.claude changes (affects all your projects): you must confirm. */
  needsUserConfirm: boolean;
  /** Command checks Crewglass will run after these agents finish (stored privately, never in the repo). */
  checks: PlanCheck[];
  checksChanged: boolean;
  /** A command is new to this folder: you confirm it before it's saved. */
  needsCheckConfirm: boolean;
}

/** Pop-up types you can switch off in Settings (plan §8). */
export type PopupKind = "permission" | "paused" | "approval" | "failed" | "finished" | "limit";

/** What Uninstall will do (shown as a checklist before anything happens). */
export interface UninstallPlan {
  hookFolders: string[];
  agyFolders: string[];
  orchestratorFolders: { folder: string; agent: string }[];
  dataFolders: string[];
}

export interface PlanCheck { agent: string; label: string; command: string; isNew: boolean }

export interface SeriesPoint { t: number; byModel: Record<string, number>; toolCalls: number; failures: number }

export interface Snapshot {
  folder: string | null;
  recentFolders: string[];
  suggestions: { path: string; why: string }[];
  sessions: Session[];
  /** Project agents, plus built-in / plugin / agy agents seen in use here. */
  agents: Agent[];
  /** All-projects agents (~/.claude/agents), shown in the Library. */
  userAgents: Agent[];
  mcps: McpServer[];
  /** Observed connectors (from transcripts). Planned ones come from the team map in Phase 3. */
  links: Link[];
  orchestratorKey: string | null;
  /** The team map names an orchestrator, but the `agent` setting is off (you paused it). */
  orchestratorPaused: boolean;
  activity: ActivityEvent[];
  series: SeriesPoint[];
  processes: ProcessRow[];
  history: HistoryRow[];
  formatIssues: FormatIssue[];
  inbox: InboxItem[];
  todayTokens: number;
  /** Today's cache writes and reads in this folder (not counted in todayTokens). */
  todayCache: { write: number; read: number };
  limits: { session: number; day: number };
  sourceRepo: string;
  claudeVersion: string | null;
  testedClaudeVersion: string;
  loading: { done: boolean; files: number; read: number };
  /** Live mode for the watched folder: hooks installed, and whether any hook event has arrived since the app started. */
  live: { installed: boolean; active: boolean; lastEventAt: number | null; helperReady: boolean };
  /** agy agents: what this Mac has (Node, agy, the bridge), the Gemini models found by "Refresh from agy",
   *  and Gemini tokens used today (Google's quota, counted apart from Claude's). */
  agy: { ready: boolean; missing: string | null; models: string[]; tokensToday: number; callsToday: number };
  /** Checks you can attach: the built-in ones plus commands you added (from Crewglass's private data). */
  checks: Record<string, Check>;
}

export interface LivePlan {
  installed: boolean;
  path: string;
  before: string;
  after: string;
  existed: boolean;
  gitIgnored: boolean | null;
  error?: string;
}

export interface DeckApi {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  /** Opens the macOS folder picker. Resolves to the chosen folder, or null if cancelled. */
  chooseFolder(): Promise<string | null>;
  setFolder(path: string): Promise<boolean>;
  setLimits(limits: { session: number; day: number }): Promise<void>;
  resolveInbox(id: string, choice: string, note?: string): Promise<void>;
  /** What turning Live mode on (or off) would change in <folder>/.claude/settings.local.json. */
  livePreview(): Promise<LivePlan>;
  setLiveMode(on: boolean): Promise<{ ok: boolean; error?: string }>;
  /** Stop one session ("<sessionId>") or every session in the folder ("all") at its next step. */
  stop(target: string): Promise<void>;
  resume(): Promise<void>;
  planSave(design: DesignPayload): Promise<SavePlan | { error: string }>;
  applySave(planId: string, confirmUser: boolean, confirmChecks?: boolean): Promise<{ ok: boolean; error?: string; written?: number }>;
  undoLastSave(): Promise<{ ok: boolean; error?: string }>;
  uninstallPlan(): Promise<UninstallPlan>;
  /** Removes Live mode from every folder, unregisters the agy bridge, deletes Crewglass's data, then quits. */
  uninstall(opts: { removeOrchestrator: boolean }): Promise<{ ok: boolean; error?: string }>;
  /** Runs `agy models` (only when you click; agy may contact Google) and keeps the Gemini ids. */
  refreshAgyModels(): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  dismissFormatIssues(): Promise<void>;
  /** Brings VS Code to the front on that folder (only the watched folder or the Crewglass source repo). */
  openInVSCode(path: string): Promise<void>;
  /** Commands from the app menu / notifications, e.g. "open-inbox". */
  onCommand(cb: (command: string) => void): () => void;
}

declare global {
  interface Window { crewglass?: DeckApi }
}
