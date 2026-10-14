// Shared data model for Crewglass. Used by the renderer now (with fake data) and by the
// Electron main process later (with real data read from Claude Code's files).

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentKind = "orchestrator" | "subagent" | "agy" | "builtin";
export type AgentScope = "project" | "user" | "builtin" | "plugin";
export type AgentStatus = "idle" | "running" | "waiting" | "failed" | "done" | "stopped";

export interface Agent {
  /** Stable identity: the agent's file (scope + path), so same-name agents can coexist. */
  key: string;
  name: string;
  kind: AgentKind;
  scope: AgentScope;
  /** File path relative to the folder (project) or ~ (user). Empty for built-ins. */
  file: string;
  /** The `description` field — Claude reads it to decide when to delegate. */
  role: string;
  instructions: string;
  /** Model alias or full id; "inherit" follows the session. */
  model: string;
  effort?: Effort;
  maxTurns?: number;
  toolAccess: "inherit" | "connected";
  builtinTools: string[];
  keepPrivate: boolean;
  /** agy agents: the Gemini model the Haiku relay forwards to. */
  geminiModel?: string;
  /** agy agents: what really happened — the Gemini model the bridge reported, Google tokens today, and whether a call is running. */
  gemini?: { model: string | null; tokensToday: number; callsToday: number; running: boolean; lastSeconds: number | null };
  checks: string[];
  /** Live, observed values. */
  status: AgentStatus;
  parallel: number;
  tokens: number;
  calls: number;
  skillsUsed: string[];
  liveNow?: { action: string; model: string; effort?: Effort; tokens: number };
  /** When another agent with the same name exists, which one Claude actually uses. */
  sameName?: { usedByClaude: boolean; otherKey: string };
  /** Set when the model or effort actually used differs from what's configured (for the orchestrator: its chat's). */
  actualModel?: string;
  actualEffort?: Effort;
  disabled?: boolean;
  /** Its header isn't strict YAML (Claude Code reads it anyway); saving from Crewglass rewrites it properly. */
  lenientHeader?: boolean;
}

export type McpScope = "project" | "local" | "user" | "inherited";
export type McpState = "configured" | "needs-approval" | "disabled" | "running" | "in-use" | "failing" | "remote";

export interface McpServer {
  key: string;
  name: string;
  scope: McpScope;
  /** For inherited servers: where Claude got it (claude.ai connector, plugin). */
  source?: string;
  type: "stdio" | "http";
  state: McpState;
  calls: number;
  cpu?: number;
  memMb?: number;
  envNames?: string[];
  /** For servers you add in Crewglass: how Claude should start it (stdio) or reach it (http). */
  command?: string;
  url?: string;
}

export type CheckKind = "command" | "verdict" | "second-opinion";

export interface Check {
  key: string;
  kind: CheckKind;
  label: string;
  command?: string;
  checkerAgent?: string;
}

export type LinkKind = "delegates" | "direct" | "uses" | "checkedBy";
export type DirectState = "allowed" | "orchestrator" | "you" | "blocked";
export type CheckState = "passed" | "failed" | "checking";

export interface Link {
  id: string;
  from: string;
  to: string;
  kind: LinkKind;
  /** Drawn by you (solid) vs only seen in use (dashed). */
  planned: boolean;
  observed?: { calls: number; tokens: number; lastSeen: string };
  directState?: DirectState;
  check?: { state: CheckState; tries: number; label: string };
  /** Command checks on this hand-off: they check the work of `to` whenever `from` handed it that work. */
  checks?: string[];
  /** Latest `Reason:` line for a direct call (memory only, never saved). */
  lastReason?: string;
  active?: boolean;
}

export type SessionSource = "vscode" | "terminal" | "headless" | "pipeline";
export type SessionStatus = "busy" | "idle" | "waiting" | "stopping" | "stopped";

export interface Session {
  id: string;
  name: string;
  source: SessionSource;
  subfolder?: string;
  status: SessionStatus;
  model: string;
  effort?: Effort;
  contextTokens: number;
  /** Input + output (what Claude Code's /cost calls Input and Output), including its subagents. */
  tokens: number;
  /** Of `tokens`, today's part. */
  tokensToday?: number;
  /** Cache traffic, shown next to the tokens but not counted in them. */
  cache?: { write: number; read: number };
  runsAs?: string;
  /** What the main session is doing right now (shown on its card when there is no orchestrator). */
  liveNow?: string;
  skillsUsed?: string[];
}

export type InboxKind = "failing-command" | "approval" | "limit" | "context" | "check-failed" | "stuck" | "permission" | "mcp-died" | "agy-calls" | "turn-failed";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  detail: string;
  at: number;
  resolved?: string;
  /** Kind-specific extras (command, caller, callee, reason, deadline…). */
  data?: Record<string, string | number | boolean>;
  popup: boolean;
}

export type ActivityResult = "ok" | "error" | "denied" | "running" | "stopped";

export interface ActivityEvent {
  id: string;
  at: number;
  session: string;
  agent: string;
  tool: string;
  target: string;
  model: string;
  effort?: Effort;
  durationMs?: number;
  result: ActivityResult;
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
  shared: boolean;
}

export interface PendingChange {
  id: string;
  summary: string;
  files: FileChange[];
}

export interface FormatIssue {
  source: "transcripts" | "sessions" | "hooks" | "agents" | "settings";
  kind: "new-field" | "new-value" | "missing" | "retyped";
  name: string;
  detail: string;
  severity: "info" | "warn";
  fixFile: string;
}

export interface ProcessRow {
  pid: number;
  label: string;
  kind: "claude" | "mcp" | "agy" | "tool";
  cpu: number;
  memMb: number;
}

export interface HistoryRow {
  id: string;
  started: string;
  source: SessionSource;
  durationMin: number;
  tokens: number;
  agents: string[];
  mcps: string[];
  failures: number;
  models: string[];
}
