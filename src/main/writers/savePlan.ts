// Save = design → exact file plan (you review it) → checks → backup → safe writes (plan §5 / §10).
//
// Only these paths can ever be written (pathGuard):
//   <folder>/.claude/agents/<name>.md · <folder>/.claude/rules/crewglass-team.md · <folder>/.claude/commands/workflow.md
//   <folder>/.claude/settings.local.json · <folder>/.mcp.json · <folder>/.git/info/exclude · ~/.claude/agents/<name>.md
// Existing agent files are edited in place with the yaml Document API, so unknown fields, comments and order survive.

import { HANDOFF_COMMAND, HANDOFF_FILES, HANDOFF_NOTE, isOurHandoffFile, PICKUP_COMMAND, USAGE_RULES } from "@shared/handoff";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Document, parseDocument } from "yaml";
import { lenientFrontmatter } from "@shared/frontmatter";
import type { Agent, McpServer } from "@shared/types";
import type { DesignPayload, PlanFile, SavePlan } from "@shared/ipc";
import { agentTools, renderAgentFile } from "@shared/agentFile";
import { renderTeamMap, TEAM_MAP_FILE } from "@shared/teamMap";
import { LEGACY } from "@shared/legacy";
import { chatStartEffort, findModel } from "@shared/models";
import { findSecrets } from "@shared/secretGuard";
import { AGY_SERVER, GEMINI_ID_RE } from "@shared/agy";
import { HOME, USER_AGENTS_DIR } from "../paths";
import { realPath } from "../scope";
import { readFolderConfig } from "../sources/configFiles";
import { refreshOurHooks } from "../live/hookInstaller";

/** What agy agents need on this Mac: Node, the bridge Crewglass copied into its data folder, and agy itself. */
export interface AgyEnv { node: string | null; bridge: string | null; agy: string | null }

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXCLUDE_MARK = "# Crewglass: kept private";
const ourExcludeMark = (line: string | undefined) => line === EXCLUDE_MARK || line === LEGACY.excludeMark;
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SCOPES = new Set(["project", "local", "user"]);

/** Everything that ends up in a file or in `claude mcp …` arguments is checked here first (no flag-like names). */
function checkMcp(m: McpServer) {
  if (typeof m.name !== "string" || !MCP_NAME_RE.test(m.name)) throw new Error(`"${m.name}" isn't a valid MCP server name (letters, numbers, - and _)`);
  if (!SCOPES.has(m.scope)) throw new Error(`${m.name}: unknown scope`);
  if (m.url !== undefined && (typeof m.url !== "string" || !/^https?:\/\/[^\s]{1,2000}$/.test(m.url))) throw new Error(`${m.name}: the web address must start with http:// or https://`);
  if (m.command !== undefined && (typeof m.command !== "string" || /[\r\n\0]/.test(m.command) || m.command.length > 2000)) throw new Error(`${m.name}: the command must be one line`);
  for (const n of m.envNames ?? []) if (typeof n !== "string" || !ENV_NAME_RE.test(n)) throw new Error(`${m.name}: "${n}" isn't a valid variable name`);
}
const TEAM_MAP = TEAM_MAP_FILE;
const WORKFLOW = ".claude/commands/workflow.md";
const SETTINGS = ".claude/settings.local.json";
const MCP_JSON = ".mcp.json";

type Json = Record<string, unknown>;
const readText = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const parseJson = (t: string | null): Json => { if (!t || !t.trim()) return {}; const v = JSON.parse(t) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {}; };
const pretty = (o: Json) => JSON.stringify(o, null, 2) + "\n";

/** The single gatekeeper for every write (plan §9): real path, allow-list, no links. */
export function guardPath(folder: string, path: string): string {
  const root = realPath(folder);
  const userAgents = realPath(USER_AGENTS_DIR);
  const inProject = path.startsWith(root + "/");
  const inUserAgents = path.startsWith(USER_AGENTS_DIR + "/") || path.startsWith(userAgents + "/");
  if (!inProject && !inUserAgents) throw new Error(`refusing to write outside the folder: ${path}`);
  const rel = inProject ? relative(root, path) : `~/.claude/agents/${basename(path)}`;
  if (inUserAgents && dirname(path) !== USER_AGENTS_DIR && dirname(path) !== userAgents) throw new Error(`refusing to write ${path}`);
  // New agent files use safe names; existing files keep theirs (still no path tricks).
  const agentFile = /^(\.claude\/agents|~\/\.claude\/agents)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\.md$/.test(rel);
  const allowed = [TEAM_MAP, WORKFLOW, SETTINGS, MCP_JSON, ".git/info/exclude", HANDOFF_FILES.handoff, HANDOFF_FILES.pickup, HANDOFF_FILES.rules,
    LEGACY.teamMap, LEGACY.usageRules].includes(rel) || agentFile;
  if (!allowed || rel.includes("..")) throw new Error(`refusing to write ${rel}`);
  // No writing through links anywhere along the way.
  for (let p = path; p !== dirname(p) && (p.startsWith(root) || p.startsWith(HOME)); p = dirname(p)) {
    if (p === root || p === HOME) break;
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`refusing to write through a link: ${p}`);
  }
  return rel;
}

function agentPath(folder: string, a: Agent): string {
  if (a.file && a.file.startsWith("~/")) return join(HOME, a.file.slice(2));
  if (a.file) return join(realPath(folder), a.file);
  return a.scope === "user" ? join(USER_AGENTS_DIR, `${a.name}.md`) : join(realPath(folder), ".claude", "agents", `${a.name}.md`);
}

/** Edit an existing agent file in place: only fields that changed are touched; everything else is kept. */
export function updateAgentText(text: string, a: Agent, tools: string[] | null): string {
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) return text;
  const parsed = parseDocument(m[2], { schema: "core" });
  // A header that isn't strict YAML (Claude Code still reads it) is rewritten properly from its key: value lines.
  const doc = parsed.errors.length ? new Document(lenientFrontmatter(m[2])) : parsed;
  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === "") { if (doc.has(key)) doc.delete(key); return; }
    const cur = doc.get(key);
    const same = Array.isArray(value) ? JSON.stringify((cur as { toJSON?: () => unknown })?.toJSON?.() ?? cur) === JSON.stringify(value) : cur === value;
    if (!same) doc.set(key, value);
  };
  const model = findModel(a.model);
  set("name", a.name);
  set("description", a.role);
  set("model", model?.alias ?? a.model);
  set("effort", model?.usesEffort ? a.effort : undefined);
  set("maxTurns", a.maxTurns);
  set("omitClaudeMd", a.omitClaudeMd ? true : undefined);
  if (tools === null) set("tools", undefined);
  else {
    const cur = doc.get("tools");
    const curList = typeof cur === "string" ? cur.split(",").map((t) => t.trim()) : (cur as { toJSON?: () => unknown })?.toJSON?.();
    if (JSON.stringify(curList) !== JSON.stringify(tools)) doc.set("tools", tools.join(", "));
  }
  const fm = doc.toString().replace(/\n$/, "");
  const body = a.instructions.trim() === m[4].trim() ? m[4] : `\n${a.instructions.trim()}\n`;
  return `${m[1]}${fm}${m[3]}${body}`;
}

function extrasFor(a: Agent, design: DesignPayload) {
  const planned = design.links.filter((l) => l.planned && l.from === a.key);
  const mcpNames = planned.filter((l) => l.kind === "uses").map((l) => design.mcps.find((m) => m.key === l.to)?.name).filter((n): n is string => !!n);
  return { mcpServers: mcpNames, canCallAgents: planned.some((l) => l.kind === "direct" && l.directState !== "blocked") };
}

interface StoredPlan { plan: SavePlan; folder: string; writes: { path: string; before: string | null; after: string | null }[]; created: number }
const plans = new Map<string, StoredPlan>();

export function planSave(folder: string, design: DesignPayload, agyEnv: AgyEnv | null = null, hookCommand: string | null = null): SavePlan {
  const root = realPath(folder);
  const writes: StoredPlan["writes"] = [];
  const files: PlanFile[] = [];
  const warnings: string[] = [];
  const commands: SavePlan["commands"] = [];
  const add = (path: string, after: string | null, shared: boolean) => {
    const display = guardPath(root, path);
    const before = readText(path);
    if ((before ?? null) === after) return;
    if (before === null && after === null) return;
    writes.push({ path, before, after });
    files.push({ path, display, before: before ?? "", after, shared, hits: shared && after ? findSecrets(after) : [] });
  };

  // ── agent files ──
  let pendingExclude: string | null = null; // .git/info/exclude after all "Keep private" changes
  const editable = design.agents.filter((a) => (a.scope === "project" || a.scope === "user") && a.kind !== "builtin");
  for (const a of editable) {
    if (!NAME_RE.test(a.name)) throw new Error(`"${a.name}" isn't a valid agent name (lowercase letters, numbers, hyphens)`);
    if (typeof a.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.\[\]_-]{0,79}$/.test(a.model)) throw new Error(`${a.name}: unknown model`);
    const path = agentPath(root, a);
    const tools = agentTools(a, extrasFor(a, design));
    const existing = readText(path);
    const after = existing ? updateAgentText(existing, a, tools) : renderAgentFile(a, extrasFor(a, design));
    add(path, after, a.scope === "project" && !a.keepPrivate);
    const rel = relative(root, path);
    const exclude = join(root, ".git", "info", "exclude");
    const isRepo = existsSync(join(root, ".git")) && lstatSync(join(root, ".git")).isDirectory();
    if (a.scope === "project" && a.keepPrivate) {
      if (isRepo) {
        const text: string = pendingExclude ?? readText(exclude) ?? "";
        if (!text.split("\n").includes(`/${rel}`)) pendingExclude = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${EXCLUDE_MARK}\n/${rel}\n`;
      } else warnings.push(`${a.name} is marked private, but this folder isn't a git repository (nothing to hide it from).`);
    } else if (a.scope === "project" && isRepo) {
      // "Keep private" turned off: remove only the lines Crewglass added (the marker plus the path right below it).
      const lines: string[] = (pendingExclude ?? readText(exclude) ?? "").split("\n");
      const i = lines.findIndex((l: string, n: number) => l === `/${rel}` && ourExcludeMark(lines[n - 1]));
      if (i > 0) { lines.splice(i - 1, 2); pendingExclude = lines.join("\n"); }
    }
    // Moved between "this project" and "all my projects": the old file goes (a backup is kept).
    const originalFile = a.key.replace(/^(project|user):/, "");
    if (originalFile.endsWith(".md") && originalFile !== a.file && a.file) {
      const oldPath = originalFile.startsWith("~/") ? join(HOME, originalFile.slice(2)) : join(root, originalFile);
      if (existsSync(oldPath) && oldPath !== path) add(oldPath, null, a.key.startsWith("project:"));
    }
    if (a.kind === "agy") {
      if (a.geminiModel && a.geminiModel !== "agy-default" && !GEMINI_ID_RE.test(a.geminiModel)) throw new Error(`${a.name}: "${a.geminiModel}" isn't a Gemini model`);
      if (a.scope === "project" && !a.keepPrivate) warnings.push(`${a.name} is shared through git, but the agy bridge exists only on this Mac — someone who clones the repo gets an agent that can't reach agy. Consider "Keep private".`);
    }
  }
  // ── /handoff and /pickup: Crewglass's own copies only (a command you wrote yourself is never touched) ──
  const isRepo = existsSync(join(root, ".git")) && lstatSync(join(root, ".git")).isDirectory();
  for (const [file, text] of [[HANDOFF_FILES.handoff, HANDOFF_COMMAND], [HANDOFF_FILES.pickup, PICKUP_COMMAND], [HANDOFF_FILES.rules, USAGE_RULES]] as const) {
    const path = join(root, file);
    const existing = readText(path);
    const ours = existing === null || isOurHandoffFile(existing);
    if (design.handoff === true && ours) add(path, text, true);
    else if (design.handoff === false && existing !== null && isOurHandoffFile(existing)) add(path, null, true);
  }
  // The usage rules saved under the old name (Agent Deck) give way to the current file.
  const legacyRules = readText(join(root, LEGACY.usageRules));
  if (design.handoff !== undefined && legacyRules !== null && isOurHandoffFile(legacyRules)) add(join(root, LEGACY.usageRules), null, true);
  if (isRepo && design.handoff !== undefined) {
    // The note itself is your working state, not something to commit.
    const lines: string[] = (pendingExclude ?? readText(join(root, ".git", "info", "exclude")) ?? "").split("\n");
    const i = lines.findIndex((l, n) => l === `/${HANDOFF_NOTE}` && ourExcludeMark(lines[n - 1]));
    if (design.handoff && i < 0 && !lines.includes(`/${HANDOFF_NOTE}`)) {
      const text = lines.join("\n");
      pendingExclude = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${EXCLUDE_MARK}\n/${HANDOFF_NOTE}\n`;
    } else if (!design.handoff && i > 0) { lines.splice(i - 1, 2); pendingExclude = lines.join("\n"); }
  }
  if (pendingExclude !== null) add(join(root, ".git", "info", "exclude"), pendingExclude, false);
  for (const key of design.deletedKeys) {
    const file = key.replace(/^(project|user):/, "");
    if (!file.endsWith(".md")) continue;
    const path = file.startsWith("~/") ? join(HOME, file.slice(2)) : join(root, file);
    if (existsSync(path)) add(path, null, key.startsWith("project:"));
  }

  // ── team map + /workflow ──
  const orch = design.orchestratorKey ? design.agents.find((a) => a.key === design.orchestratorKey) ?? null : null;
  const planned = design.links.filter((l) => l.planned);
  const teamPath = join(root, TEAM_MAP);
  if (planned.length || orch) {
    add(teamPath, renderTeamMap({ agents: design.agents, links: design.links, checks: design.checks, orchestrator: orch }), true);
    add(join(root, WORKFLOW), [
      "---", "description: Run the Crewglass team workflow for a task", "---", "",
      "Follow the team map in .claude/rules/crewglass-team.md for this task: $ARGUMENTS", "",
      "Plan first, hand each part to the agent the map names, verify every result against its checks, and finish with a short report.", "",
    ].join("\n"), true);
  } else if (existsSync(teamPath)) {
    add(teamPath, null, true);
  }
  // A team map saved under the old name (Agent Deck) is replaced by the one above, never left as a second map.
  if (existsSync(join(root, LEGACY.teamMap))) add(join(root, LEGACY.teamMap), null, true);

  // ── settings.local.json: orchestrator, disabled agents, project MCP enable/disable (hooks and everything else kept) ──
  const settingsPath = join(root, SETTINGS);
  const settingsText = readText(settingsPath);
  const settings = parseJson(settingsText);
  const next: Json = structuredClone(settings);
  if (orch && !design.orchestratorPaused) next.agent = orch.name; else delete next.agent;
  // Claude Code ignores an agent file's effort for the chat that runs as it, so chats here start at the folder's
  // `effortLevel` instead (an effort picked in the chat still wins for that chat). It can't hold max: max → xhigh.
  const startEffort = orch && !design.orchestratorPaused ? chatStartEffort(orch.model, orch.effort) : undefined;
  if (startEffort) {
    if (orch!.effort === "max" && settings.effortLevel !== startEffort) warnings.push(`Claude Code can't start a chat at max effort, so chats running as ${orch!.name} start at xhigh. Pick max in the chat (/model) when you need it.`);
    next.effortLevel = startEffort;
  } else if (typeof settings.agent === "string") delete next.effortLevel; // it went with the orchestrator
  const perms = (next.permissions && typeof next.permissions === "object" ? next.permissions : {}) as Json;
  const known = new Set(editable.map((a) => a.name));
  const deny = (Array.isArray(perms.deny) ? perms.deny : []).filter((d) => {
    const m = typeof d === "string" ? d.match(/^Agent\(([^)]+)\)$/) : null;
    return !(m && known.has(m[1]));
  });
  for (const a of editable) if (a.disabled) deny.push(`Agent(${a.name})`);
  if (deny.length) next.permissions = { ...perms, deny }; else if (next.permissions) { const { deny: _d, ...rest } = perms; void _d; if (Object.keys(rest).length) next.permissions = rest; else delete next.permissions; }
  const projectMcps = design.mcps.filter((m) => m.scope === "project");
  const enabled = new Set((next.enabledMcpjsonServers as string[] | undefined) ?? []);
  const disabled = new Set((next.disabledMcpjsonServers as string[] | undefined) ?? []);
  for (const m of projectMcps) {
    if (m.state === "disabled") { disabled.add(m.name); enabled.delete(m.name); }
    else if (disabled.has(m.name)) disabled.delete(m.name);
  }
  if (enabled.size) next.enabledMcpjsonServers = [...enabled]; else delete next.enabledMcpjsonServers;
  if (disabled.size) next.disabledMcpjsonServers = [...disabled]; else delete next.disabledMcpjsonServers;
  // Live mode's own entries are brought up to date too (e.g. Phase 5's longer time limit so checks can finish).
  if (hookCommand) {
    const refreshed = refreshOurHooks(next, hookCommand);
    if (JSON.stringify([refreshed.hooks, refreshed.statusLine]) !== JSON.stringify([next.hooks, next.statusLine])) {
      next.hooks = refreshed.hooks;
      if (refreshed.statusLine === undefined) delete next.statusLine; else next.statusLine = refreshed.statusLine;
      warnings.push("Live mode's entries in settings.local.json are brought up to date (time limits for checks, and the status line if it's on in Settings).");
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(settings)) add(settingsPath, pretty(next), false);

  // ── .mcp.json (shared) — new project servers get ${VAR} references, never secret values ──
  const mcpPath = join(root, MCP_JSON);
  const mcpText = readText(mcpPath);
  const mcpJson = parseJson(mcpText);
  const servers = { ...((mcpJson.mcpServers as Json | undefined) ?? {}) };
  let mcpChanged = false;
  for (const m of projectMcps) {
    if (servers[m.name]) continue;
    checkMcp(m);
    servers[m.name] = serverConfig(m);
    mcpChanged = true;
  }
  for (const key of design.removedMcpKeys) {
    const name = key.replace(/^mcp:/, "");
    if (servers[name]) { delete servers[name]; mcpChanged = true; }
  }
  if (mcpChanged) add(mcpPath, pretty({ ...mcpJson, mcpServers: servers }), true);

  // ── private MCP servers go through the official CLI (Crewglass never hand-edits ~/.claude.json) ──
  // Servers you added here carry a command or URL; ones already configured don't (their commands are never read).
  for (const m of design.mcps.filter((x) => (x.scope === "local" || x.scope === "user") && (x.command !== undefined || x.url !== undefined))) {
    checkMcp(m);
    const env = (m.envNames ?? []).flatMap((n) => ["-e", `${n}=\${${n}}`]);
    const argv = m.url ? ["mcp", "add", "--scope", m.scope, "--transport", "http", m.name, m.url]
      : ["mcp", "add", "--scope", m.scope, ...env, m.name, "--", ...(m.command ?? "").split(/\s+/).filter(Boolean)];
    commands.push({ label: `claude ${argv.join(" ")}`, argv });
  }
  for (const key of design.removedMcpKeys) {
    // Project servers were removed from .mcp.json above; private ones go through the CLI; inherited ones can't be removed here.
    const scope = design.removedMcpScopes?.[key];
    const name = key.slice(4);
    if (scope === "inherited") warnings.push(`${name} comes from a plugin or claude.ai, so it can't be removed here.`);
    if (scope !== "local" && scope !== "user") continue;
    if (!MCP_NAME_RE.test(name)) throw new Error(`"${name}" can't be removed from here; use claude mcp remove in a terminal`);
    commands.push({ label: `claude mcp remove --scope ${scope} ${name}`, argv: ["mcp", "remove", "--scope", scope, name] });
  }

  // ── agy agents: register Crewglass's bridge privately for this folder (the path stays in your ~/.claude.json) ──
  if (design.agents.some((a) => a.kind === "agy" && !a.disabled && (a.scope === "project" || a.scope === "user"))) {
    const registered = readFolderConfig(root).mcps.some((m) => m.name === AGY_SERVER && (m.scope === "local" || m.scope === "user"));
    if (!registered) {
      const missing = !agyEnv?.node ? "Node (/opt/homebrew/bin/node)" : !agyEnv.agy ? "agy" : !agyEnv.bridge ? "Crewglass's agy bridge (run npm run build)" : null;
      if (missing) warnings.push(`agy agents need ${missing}, which wasn't found, so the bridge isn't set up yet. The agent files are still saved.`);
      else {
        const argv = ["mcp", "add", "--scope", "local", AGY_SERVER, "--", agyEnv!.node!, agyEnv!.bridge!, "--agy", agyEnv!.agy!];
        const tilde = (p: string) => (p.startsWith(HOME + "/") ? `~${p.slice(HOME.length)}` : p);
        commands.push({ label: `claude mcp add --scope local ${AGY_SERVER} -- ${argv.slice(6).map(tilde).join(" ")}`, argv });
      }
    }
  }

  const plan: SavePlan = {
    id: randomUUID(), files, commands, warnings,
    blocked: files.some((f) => f.hits.length > 0),
    needsUserConfirm: files.some((f) => f.display.startsWith("~/")),
    checks: [], checksChanged: false, needsCheckConfirm: false,
  };
  plans.set(plan.id, { plan, folder: root, writes, created: Date.now() });
  for (const [id, p] of plans) if (Date.now() - p.created > 30 * 60_000) plans.delete(id);
  return plan;
}

function serverConfig(m: McpServer): Json {
  const env = Object.fromEntries((m.envNames ?? []).map((n) => [n, `\${${n}}`]));
  if (m.url) return { type: "http", url: m.url };
  const [command, ...args] = (m.command ?? "").split(/\s+/).filter(Boolean);
  return { type: "stdio", command: command ?? "", args, ...(Object.keys(env).length ? { env } : {}) };
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  // Random name + "wx" (create only): a file or link planted at the temp name is never followed or overwritten.
  const tmp = `${path}.crewglass-${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644, flag: "wx" });
  renameSync(tmp, path);
}

export interface ApplyResult { ok: boolean; error?: string; written?: number; backup?: string }

/** Apply a reviewed plan: refuse if blocked, unconfirmed, or if any file changed since you reviewed it. */
export function applySave(planId: string, confirmUser: boolean, backupRoot: string, runClaude: (argv: string[]) => { ok: boolean; error?: string }): ApplyResult {
  const stored = plans.get(planId);
  if (!stored) return { ok: false, error: "This review is out of date. Open Review changes again." };
  const { plan, writes, folder } = stored;
  if (plan.blocked) return { ok: false, error: "A file shared through git contains something that looks like a key. Fix it first." };
  if (plan.needsUserConfirm && !confirmUser) return { ok: false, error: "Confirm the change under ~/.claude first." };
  for (const w of writes) {
    if (readText(w.path) !== w.before) return { ok: false, error: `${w.path} changed since you reviewed it. Open Review changes again.` };
  }
  // Only private data changes (e.g. checks): no files, no backup (so Undo last save still means your last file save).
  if (!writes.length && !plan.commands.length) { plans.delete(planId); return { ok: true, written: 0 }; }
  const dir = join(backupRoot, createHash("sha256").update(folder).digest("hex").slice(0, 16), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "save.json"), JSON.stringify({ folder, at: Date.now(), writes: writes.map((w) => ({ path: w.path, before: w.before })), commands: plan.commands }), { mode: 0o600 });
  for (const w of writes) {
    guardPath(folder, w.path);
    if (w.after === null) { if (existsSync(w.path)) unlinkSync(w.path); }
    else if (w.path.endsWith("/.git/info/exclude") && w.before !== null && w.after.startsWith(w.before)) appendFileSync(w.path, w.after.slice(w.before.length));
    else atomicWrite(w.path, w.after);
  }
  for (const c of plan.commands) {
    const r = runClaude(c.argv);
    if (!r.ok) return { ok: false, error: `Files were saved, but "${c.label}" failed: ${r.error}`, written: writes.length, backup: dir };
  }
  plans.delete(planId);
  return { ok: true, written: writes.length, backup: dir };
}

/** Put back every file from the most recent save in this folder. */
export function undoLastSave(folder: string, backupRoot: string): ApplyResult {
  const base = join(backupRoot, createHash("sha256").update(realPath(folder)).digest("hex").slice(0, 16));
  let latest: string | null = null;
  try { latest = readdirSync(base).filter((d) => existsSync(join(base, d, "save.json"))).sort().pop() ?? null; } catch { /* no backups */ }
  if (!latest) return { ok: false, error: "There's no save to undo." };
  const data = JSON.parse(readFileSync(join(base, latest, "save.json"), "utf8")) as { writes: { path: string; before: string | null }[] };
  for (const w of data.writes) {
    guardPath(realPath(folder), w.path);
    if (w.before === null) { if (existsSync(w.path)) unlinkSync(w.path); }
    else atomicWrite(w.path, w.before);
  }
  renameSync(join(base, latest, "save.json"), join(base, latest, "save.undone.json"));
  return { ok: true, written: data.writes.length };
}

