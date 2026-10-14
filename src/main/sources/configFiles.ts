// MCP servers and folder settings. From ~/.claude.json only `mcpServers` and this folder's project entry
// are used — everything else in that file (account details and so on) is dropped the moment it's parsed.

import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EFFORTS } from "@shared/models";
import type { Effort, McpServer } from "@shared/types";
import { CLAUDE_JSON } from "../paths";

type Json = Record<string, unknown>;
const readJson = (p: string): Json | null => { try { return JSON.parse(readFileSync(p, "utf8")) as Json; } catch { return null; } };

function server(name: string, cfg: unknown, scope: McpServer["scope"]): McpServer {
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Json;
  const type = c.type === "http" || c.type === "sse" || typeof c.url === "string" ? "http" : "stdio";
  const env = c.env && typeof c.env === "object" ? Object.keys(c.env as Json) : [];
  return { key: `mcp:${name}`, name, scope, type, state: type === "http" ? "remote" : "configured", calls: 0, envNames: env };
}

export interface FolderConfig {
  mcps: McpServer[];
  /** The `agent` setting (the orchestrator), from settings.local.json or settings.json. */
  agentSetting: string | null;
  /** The effort new chats here start at (`effortLevel`); Crewglass writes the orchestrator's effort there. */
  effortLevel: Effort | null;
  enabledProjectMcp: string[];
  disabledProjectMcp: string[];
  deniedAgents: string[];
  /** You accepted Claude Code's "trust this folder" prompt for this folder or a folder above it. */
  trusted: boolean;
}

export function readFolderConfig(folder: string): FolderConfig {
  const mcps = new Map<string, McpServer>();
  const project = readJson(join(folder, ".mcp.json"));
  for (const [n, c] of Object.entries((project?.mcpServers ?? {}) as Json)) mcps.set(n, server(n, c, "project"));

  const cj = readJson(CLAUDE_JSON);
  const projects = (cj?.projects ?? {}) as Record<string, Json | undefined>;
  const entry = projects[folder];
  const local = entry?.mcpServers as Json | undefined;
  for (const [n, c] of Object.entries(local ?? {})) mcps.set(n, server(n, c, "local"));
  for (const [n, c] of Object.entries((cj?.mcpServers ?? {}) as Json)) if (!mcps.has(n)) mcps.set(n, server(n, c, "user"));

  const shared = readJson(join(folder, ".claude", "settings.json")) ?? {};
  const personal = readJson(join(folder, ".claude", "settings.local.json")) ?? {};
  const pick = <T,>(k: string, f: (v: unknown) => T | null): T | null => f(personal[k]) ?? f(shared[k]);
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const agentSetting = pick("agent", (v) => (typeof v === "string" ? v : null));
  const effortLevel = pick("effortLevel", (v) => (EFFORTS.includes(v as Effort) ? (v as Effort) : null));
  // Approvals of the project's .mcp.json servers: in the settings files, or where Claude Code keeps your answers
  // to its "use this server?" prompt (this folder's entry in ~/.claude.json).
  const enabled = [...(pick("enabledMcpjsonServers", strList) ?? []), ...(strList(entry?.enabledMcpjsonServers) ?? [])];
  const disabled = [...(pick("disabledMcpjsonServers", strList) ?? []), ...(strList(entry?.disabledMcpjsonServers) ?? [])];
  const allowAll = pick("enableAllProjectMcpServers", (v) => (typeof v === "boolean" ? v : null)) ?? false;
  let trusted = false;
  for (let p = folder; ; p = dirname(p)) {
    if (projects[p]?.hasTrustDialogAccepted === true) { trusted = true; break; }
    if (p === dirname(p)) break;
  }
  const deny = [...(strList((personal.permissions as Json | undefined)?.deny) ?? []), ...(strList((shared.permissions as Json | undefined)?.deny) ?? [])];
  const deniedAgents = deny.map((d) => d.match(/^Agent\(([^)]+)\)$/)?.[1]).filter((x): x is string => !!x);

  for (const m of mcps.values()) {
    if (m.scope !== "project") continue;
    if (disabled.includes(m.name)) m.state = "disabled";
    else if (!enabled.includes(m.name) && !allowAll) m.state = "needs-approval";
  }
  return { mcps: [...mcps.values()], agentSetting, effortLevel, enabledProjectMcp: enabled, disabledProjectMcp: disabled, deniedAgents, trusted };
}

/** Paths hidden from git in <folder>/.git/info/exclude (how "Keep private" is stored), e.g. "/.claude/agents/x.md". */
export function readGitExcludes(folder: string): Set<string> {
  try {
    if (!lstatSync(join(folder, ".git")).isDirectory()) return new Set();
    return new Set(readFileSync(join(folder, ".git", "info", "exclude"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")));
  } catch { return new Set(); }
}
