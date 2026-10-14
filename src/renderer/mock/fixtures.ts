// Fake data for the clickable prototype. Shapes match src/shared/types.ts, so Phase 1 swaps this
// file for real readers without touching the components.

import type { Agent, Check, Effort, FormatIssue, HistoryRow, Link, McpServer, ProcessRow, Session } from "@shared/types";
import { BUILTIN_CHECKS } from "@shared/checks";

export const FOLDER = "/Users/you/projects/agent-app";
export const SOURCE_REPO = "/Users/you/projects/crewglass";

export const FOLDER_SUGGESTIONS = [
  { path: "/Users/you/projects/agent-app", why: "Open in VS Code now" },
  { path: "/Users/you/projects/web-shop", why: "Open in VS Code now" },
  { path: "/Users/you/projects/data-pipeline", why: "Recent" },
];

const base = {
  toolAccess: "inherit" as const, builtinTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  keepPrivate: false, checks: [] as string[], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [] as string[],
};

export function initialAgents(): Record<string, Agent> {
  const list: Agent[] = [
    { ...base, key: "project:lead", name: "lead", kind: "orchestrator", scope: "project", file: ".claude/agents/lead.md",
      role: "Plans the work, hands each task to the right agent, and checks every result before moving on.",
      instructions: "You are the orchestrator. Plan first, split the work into tasks with acceptance criteria, delegate following the team map, verify every result, and send failed work back with specific feedback (at most 2 times).",
      model: "opus", effort: "high", maxTurns: 60, status: "running", tokens: 412_000, calls: 0,
      liveNow: { action: "Planning the next task", model: "claude-opus-5-5", effort: "high", tokens: 41_000 } },
    { ...base, key: "project:planner", name: "planner", kind: "subagent", scope: "project", file: ".claude/agents/planner.md",
      role: "Use when a feature needs a step-by-step plan before any code is written.",
      instructions: "Write a short, numbered plan with acceptance criteria for each step. Do not write code.",
      model: "opus", effort: "high", maxTurns: 20, status: "done", tokens: 96_000, calls: 1 },
    { ...base, key: "project:coder", name: "coder", kind: "subagent", scope: "project", file: ".claude/agents/coder.md",
      role: "Use when code must be written or changed for a planned task.",
      instructions: "Implement exactly the task you are given. Keep changes small. Run the tests before you finish.",
      model: "opus", effort: "medium", maxTurns: 40, toolAccess: "connected", checks: ["npm-test"], status: "running", parallel: 1,
      tokens: 286_000, calls: 3, skillsUsed: ["pdf"],
      liveNow: { action: "Edit src/main/sources/transcripts.ts", model: "claude-opus-5-5", effort: "medium", tokens: 18_000 } },
    { ...base, key: "project:tester", name: "tester", kind: "subagent", scope: "project", file: ".claude/agents/tester.md",
      role: "Use to write and run tests for a change and report exactly what failed.",
      instructions: "Write focused tests for the change, run them, and report failures with file and line.",
      model: "sonnet", effort: "medium", maxTurns: 25, status: "idle", tokens: 54_000, calls: 2 },
    { ...base, key: "project:reviewer", name: "reviewer", kind: "subagent", scope: "project", file: ".claude/agents/reviewer.md",
      role: "Use after code changes to review them. Answer VERDICT: PASS or VERDICT: FAIL + reasons.",
      instructions: "Review the diff for bugs, security issues and missing tests. End with VERDICT: PASS or VERDICT: FAIL followed by reasons.",
      model: "sonnet", effort: "high", maxTurns: 15, toolAccess: "connected", builtinTools: ["Read", "Grep", "Glob"],
      status: "idle", tokens: 38_000, calls: 1, sameName: { usedByClaude: true, otherKey: "user:reviewer" } },
    { ...base, key: "project:gemini-reviewer", name: "gemini-reviewer", kind: "agy", scope: "project", file: ".claude/agents/gemini-reviewer.md",
      role: "Use for a second opinion from a different model family (Gemini via agy) on risky changes.",
      instructions: "Forward the task you are given, verbatim, to agy using the ask_agy tool with model \"gemini-3.1-pro-high\".\nReturn agy's answer verbatim. Never do the work yourself.",
      model: "haiku", maxTurns: 3, geminiModel: "gemini-3.1-pro-high", keepPrivate: true, status: "idle", tokens: 2_400, calls: 1 },
    { ...base, key: "builtin:Explore", name: "Explore", kind: "builtin", scope: "builtin", file: "",
      role: "Built-in: fast read-only search across the codebase.", instructions: "", model: "haiku",
      status: "done", tokens: 22_000, calls: 2 },
  ];
  return Object.fromEntries(list.map((a) => [a.key, a]));
}

/** Available in all your projects, not on this folder's canvas (lives in the Library). */
export function initialUserAgents(): Agent[] {
  return [
    { ...base, key: "user:reviewer", name: "reviewer", kind: "subagent", scope: "user", file: "~/.claude/agents/reviewer.md",
      role: "General code reviewer for any project.", instructions: "Review changes and list problems.",
      model: "opus", effort: "high", maxTurns: 15, sameName: { usedByClaude: false, otherKey: "project:reviewer" } },
    { ...base, key: "user:docs-writer", name: "docs-writer", kind: "subagent", scope: "user", file: "~/.claude/agents/docs-writer.md",
      role: "Use to write or update README and docs after a change.", instructions: "Write clear, short docs.",
      model: "sonnet", effort: "low", maxTurns: 15 },
  ];
}

export function initialMcps(): Record<string, McpServer> {
  const list: McpServer[] = [
    { key: "mcp:github", name: "github", scope: "project", type: "stdio", state: "in-use", calls: 5, cpu: 0.8, memMb: 82, envNames: ["GITHUB_TOKEN"] },
    { key: "mcp:postgres", name: "postgres", scope: "local", type: "stdio", state: "configured", calls: 0, envNames: ["DATABASE_URL"] },
    { key: "mcp:gdrive", name: "Google Drive", scope: "inherited", source: "claude.ai connector", type: "http", state: "remote", calls: 1 },
  ];
  return Object.fromEntries(list.map((m) => [m.key, m]));
}

export const CHECKS: Record<string, Check> = BUILTIN_CHECKS;

export function initialLinks(): Link[] {
  return [
    { id: "l1", from: "project:lead", to: "project:planner", kind: "delegates", planned: true, observed: { calls: 1, tokens: 96_000, lastSeen: "12 min ago" } },
    { id: "l2", from: "project:lead", to: "project:coder", kind: "delegates", planned: true, observed: { calls: 3, tokens: 286_000, lastSeen: "now" }, active: true },
    { id: "l3", from: "project:lead", to: "project:tester", kind: "delegates", planned: true, observed: { calls: 1, tokens: 31_000, lastSeen: "6 min ago" } },
    { id: "l4", from: "project:lead", to: "project:reviewer", kind: "delegates", planned: true, observed: { calls: 1, tokens: 38_000, lastSeen: "9 min ago" } },
    { id: "l5", from: "project:lead", to: "project:gemini-reviewer", kind: "delegates", planned: true },
    { id: "l6", from: "session:s1", to: "builtin:Explore", kind: "delegates", planned: false, observed: { calls: 2, tokens: 22_000, lastSeen: "15 min ago" } },
    { id: "l7", from: "project:coder", to: "project:tester", kind: "direct", planned: true, directState: "allowed",
      observed: { calls: 1, tokens: 23_000, lastSeen: "4 min ago" }, lastReason: "need the integration tests run against my change" },
    { id: "l8", from: "project:planner", to: "project:coder", kind: "direct", planned: true, directState: "orchestrator" },
    { id: "l9", from: "project:coder", to: "project:gemini-reviewer", kind: "direct", planned: true, directState: "you" },
    { id: "l10", from: "project:coder", to: "mcp:github", kind: "uses", planned: true, observed: { calls: 5, tokens: 0, lastSeen: "1 min ago" } },
    { id: "l11", from: "project:reviewer", to: "mcp:github", kind: "uses", planned: true },
    { id: "l12", from: "builtin:Explore", to: "mcp:gdrive", kind: "uses", planned: false, observed: { calls: 1, tokens: 0, lastSeen: "15 min ago" } },
    { id: "l13", from: "project:tester", to: "mcp:postgres", kind: "uses", planned: true },
    { id: "l14", from: "project:coder", to: "project:reviewer", kind: "checkedBy", planned: true,
      check: { state: "passed", tries: 0, label: "Reviewer verdict" } },
  ];
}

export function initialPositions(): Record<string, { x: number; y: number }> {
  // Orchestrator on top, at most four agents per row, MCP servers underneath — fits a laptop screen at a readable zoom.
  return {
    "project:lead": { x: 385, y: 0 },
    "session:s1": { x: 385, y: 0 },
    "project:planner": { x: 0, y: 230 },
    "project:coder": { x: 260, y: 230 },
    "project:tester": { x: 520, y: 230 },
    "project:reviewer": { x: 780, y: 230 },
    "builtin:Explore": { x: 0, y: 470 },
    "project:gemini-reviewer": { x: 520, y: 470 },
    "mcp:gdrive": { x: 10, y: 700 },
    "mcp:github": { x: 300, y: 700 },
    "mcp:postgres": { x: 800, y: 700 },
  };
}

export function initialSessions(): Session[] {
  return [
    { id: "s1", name: "agent-app-76", source: "vscode", status: "busy", model: "claude-opus-5-5", effort: "high",
      contextTokens: 340_000, tokens: 1_210_000, runsAs: "lead", skillsUsed: ["dataviz"] },
  ];
}

export const SECOND_SESSION: Session = {
  id: "s2", name: "agent-app-81", source: "terminal", subfolder: "src", status: "busy", model: "claude-sonnet-5-5", effort: "medium",
  contextTokens: 120_000, tokens: 260_000,
};

export function initialProcesses(): ProcessRow[] {
  return [
    { pid: 30772, label: "claude (VS Code session)", kind: "claude", cpu: 12.4, memMb: 310 },
    { pid: 30901, label: "github MCP server", kind: "mcp", cpu: 0.8, memMb: 82 },
    { pid: 31044, label: "npm test", kind: "tool", cpu: 38.1, memMb: 146 },
  ];
}

export function initialHistory(): HistoryRow[] {
  return [
    { id: "h1", started: "Today 09:12", source: "vscode", durationMin: 74, tokens: 1_840_000, agents: ["lead", "planner", "coder", "reviewer"], mcps: ["github"], failures: 1, models: ["Opus 5.5", "Sonnet 5.5"] },
    { id: "h2", started: "Yesterday 21:40", source: "vscode", durationMin: 38, tokens: 640_000, agents: ["coder", "tester"], mcps: ["github"], failures: 0, models: ["Opus 5.5", "Sonnet 5.5"] },
    { id: "h3", started: "Yesterday 17:05", source: "terminal", durationMin: 12, tokens: 120_000, agents: ["Explore"], mcps: [], failures: 0, models: ["Haiku 4.5"] },
    { id: "h4", started: "Sep 22 14:30", source: "vscode", durationMin: 95, tokens: 2_310_000, agents: ["lead", "coder", "gemini-reviewer"], mcps: ["github", "Google Drive"], failures: 3, models: ["Opus 5.5", "Haiku 4.5", "Gemini 3.1 Pro · high"] },
    { id: "h5", started: "Sep 21 10:02", source: "headless", durationMin: 4, tokens: 38_000, agents: [], mcps: [], failures: 0, models: ["Sonnet 5.5"] },
  ];
}

export const FORMAT_ISSUES: FormatIssue[] = [
  { source: "transcripts", kind: "new-field", name: "message.usage.reasoning_tokens", detail: "number", severity: "info", fixFile: "src/main/sources/transcripts.ts" },
  { source: "sessions", kind: "new-value", name: "kind = \"remote\"", detail: "new session kind", severity: "info", fixFile: "src/main/sources/claudeSessions.ts" },
];

export interface RoleTemplate {
  id: string;
  name: string;
  role: string;
  instructions: string;
  model: string;
  effort?: Effort;
  maxTurns: number;
  toolAccess: "inherit" | "connected";
  builtinTools?: string[];
  omitClaudeMd?: boolean;
}

// Each role returns a SHORT summary: it's all that goes back into the main chat, so the main chat stays small.
// Read-only roles with self-contained instructions start without CLAUDE.md (omitClaudeMd), so they start cheaper.
const SHORT = (fmt: string, words: number) => `\n\n## What to return (keep it short: it's all the main chat will see)\n${fmt}\nAt most ~${words} words. No code dumps: the main chat can read the files.`;
export const ROLE_TEMPLATES: RoleTemplate[] = [
  { id: "explorer", name: "explorer", role: "Use to find where or how something works in the codebase (where is X defined, what calls Y). Read-only; use instead of reading many files in the main chat.",
    instructions: "You only read. Search first (Grep/Glob), then open only the relevant parts of files. Stop as soon as you can answer confidently." +
      SHORT("- **Answer:** 1–3 sentences\n- **Where:** key locations as `path:line`, one per line, with a few words of context\n- **Unsure about:** anything you couldn't confirm (or \"nothing\")", 120),
    model: "haiku", maxTurns: 15, toolAccess: "connected", builtinTools: ["Read", "Grep", "Glob"], omitClaudeMd: true },
  { id: "planner", name: "planner", role: "Use when a feature needs a step-by-step plan before any code is written.",
    instructions: "Write a short, numbered plan with acceptance criteria for each step. Do not write code." +
      SHORT("A numbered plan: each step one line, then `Done when:` with a checkable criterion. End with risks or open questions (or \"none\").", 200),
    model: "opus", effort: "high", maxTurns: 20, toolAccess: "inherit" },
  { id: "coder", name: "coder", role: "Use when code must be written or changed across one or more files (feature, refactor, bug fix). Give it the goal, the files, the constraints and how to check the result.",
    instructions: "Implement exactly the task you are given. Read only the files you need (search before opening whole files), make small focused edits that match the surrounding style, then verify with the tests or the command in the brief. Don't widen the scope: mention problems outside the brief instead of fixing them." +
      SHORT("- **Done:** one line per file (`path`: what and why)\n- **Verified:** the command you ran and its result\n- **Open issues:** anything unfinished or risky (or \"none\")", 150),
    model: "opus", effort: "medium", maxTurns: 40, toolAccess: "inherit" },
  { id: "reviewer", name: "reviewer", role: "Use after code changes or before a commit to review them. Answers VERDICT: PASS or VERDICT: FAIL + reasons. Never edits.",
    instructions: "Review the diff (if no target was given: `git diff` and `git diff --staged`) for wrong logic, unhandled errors and edge cases, security problems, broken contracts and missing tests. Read enough surrounding code to judge each change. Only report issues you can point to; mark anything uncertain as unsure. Never edit files." +
      SHORT("A numbered list, most severe first, one line each: `[high|medium|low] path:line: problem → suggested fix`. End with `VERDICT: PASS` or `VERDICT: FAIL` followed by the reasons.", 200),
    model: "sonnet", effort: "high", maxTurns: 15, toolAccess: "connected", builtinTools: ["Read", "Grep", "Glob", "Bash"], omitClaudeMd: true },
  { id: "tester", name: "tester", role: "Use to run tests (or a given test command), find out why they fail, and add missing tests. Fixes test files only, never app code.",
    instructions: "Find the test command (package.json scripts, Makefile, the brief…) and run the narrowest set that covers the task. Filter long output (`| tail -50`, `grep -E \"FAIL|Error\"`). For each failure decide whether the code or the test is wrong: you may edit test files; report code bugs instead of fixing them. Re-run to confirm." +
      SHORT("- **Command:** what you ran\n- **Result:** X passed / Y failed\n- **Failures:** one line each: `test: cause (code bug | test bug | flaky) → what you did`\n- **Changed:** test files you edited (or \"none\")", 150),
    model: "haiku", maxTurns: 25, toolAccess: "connected", builtinTools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"] },
  { id: "researcher", name: "researcher", role: "Use to research a question in the codebase or docs and summarize the answer with sources.",
    instructions: "Search, read, and answer with sources. Do not edit files." +
      SHORT("- **Answer:** a short paragraph\n- **Sources:** `path:line` or links, one per line\n- **Unsure about:** what you couldn't confirm", 200),
    model: "sonnet", effort: "medium", maxTurns: 20, toolAccess: "connected", builtinTools: ["Read", "Grep", "Glob", "WebFetch"], omitClaudeMd: true },
  { id: "docs-writer", name: "docs-writer", role: "Use to write or update README and docs after a change.",
    instructions: "Write clear, short docs that match the code and this project's conventions." +
      SHORT("- **Updated:** one line per file\n- **Check:** anything the docs now promise that you couldn't verify", 100),
    model: "sonnet", effort: "low", maxTurns: 15, toolAccess: "inherit" },
];

export const TEAM_PRESETS = [
  { id: "plan-code-review", name: "Plan → Code → Review", detail: "Your chat hands work to planner, coder and reviewer. Coder is checked by npm test and the reviewer.", recommended: true },
  { id: "code-test-review", name: "Code + Test + Review", detail: "Your chat hands work to coder, tester and reviewer, with a Gemini second opinion." },
  { id: "research-write", name: "Research + Write", detail: "Your chat hands work to researcher and docs-writer. No code changes." },
  { id: "watch", name: "Just watch", detail: "Don't change anything; only show what Claude does in this folder." },
];

export const BUILTIN_AGENTS = [
  { name: "Explore", detail: "Fast read-only search" },
  { name: "Plan", detail: "Research and plan, no edits" },
  { name: "general-purpose", detail: "Anything else" },
];
