// Turns the difference between the last-saved design and the current one into real file changes,
// so "Review changes" shows exactly what Save would write.

import { HANDOFF_COMMAND, HANDOFF_FILES, PICKUP_COMMAND, USAGE_RULES } from "@shared/handoff";
import type { Agent, Check, FileChange, Link, McpServer } from "@shared/types";
import { renderAgentFile } from "@shared/agentFile";
import { renderTeamMap } from "@shared/teamMap";

export interface Design {
  agents: Record<string, Agent>;
  mcps: Record<string, McpServer>;
  links: Link[];
  orchestratorKey: string | null;
  orchestratorPaused: boolean;
  checks: Record<string, Check>;
  /** /handoff and /pickup commands in this folder (Crewglass's copies). */
  handoff?: boolean;
}

const agentPath = (a: Agent) => (a.scope === "user" ? `~/.claude/agents/${a.name}.md` : `.claude/agents/${a.name}.md`);

function renderAgent(d: Design, a: Agent): string {
  const planned = d.links.filter((l) => l.planned && l.from === a.key);
  const mcpServers = planned.filter((l) => l.kind === "uses").map((l) => d.mcps[l.to]?.name).filter(Boolean) as string[];
  const canCallAgents = planned.some((l) => l.kind === "direct" && l.directState !== "blocked");
  return renderAgentFile(a, { mcpServers, canCallAgents });
}

function settingsLocal(d: Design): string {
  const orch = d.orchestratorKey && !d.orchestratorPaused ? d.agents[d.orchestratorKey]?.name : undefined;
  const disabled = Object.values(d.agents).filter((a) => a.disabled).map((a) => `Agent(${a.name})`);
  const obj: Record<string, unknown> = {};
  if (orch) obj.agent = orch;
  if (disabled.length) obj.permissions = { deny: disabled };
  obj.hooks = "… Crewglass Live mode (unchanged) …";
  return JSON.stringify(obj, null, 2);
}

function mcpJson(d: Design): string {
  const servers = Object.values(d.mcps).filter((m) => m.scope === "project");
  const obj = {
    mcpServers: Object.fromEntries(servers.map((m) => [m.name, {
      type: m.type, command: "npx", args: [`@modelcontextprotocol/server-${m.name}`],
      ...(m.envNames?.length ? { env: Object.fromEntries(m.envNames.map((n) => [n, `\${${n}}`])) } : {}),
    }])),
  };
  return JSON.stringify(obj, null, 2);
}

function teamMap(d: Design): string {
  const orchestrator = d.orchestratorKey ? d.agents[d.orchestratorKey] ?? null : null;
  return renderTeamMap({ agents: Object.values(d.agents), links: d.links, checks: d.checks, orchestrator });
}

export function diffDesigns(saved: Design, current: Design): FileChange[] {
  const changes: FileChange[] = [];
  const keys = new Set([...Object.keys(saved.agents), ...Object.keys(current.agents)]);
  for (const key of keys) {
    const before = saved.agents[key];
    const after = current.agents[key];
    const a = after ?? before;
    if (!a || a.kind === "builtin") continue;
    const b = before ? renderAgent(saved, before) : "";
    const c = after ? renderAgent(current, after) : "";
    const pathBefore = before ? agentPath(before) : "";
    const pathAfter = after ? agentPath(after) : "";
    if (pathBefore && pathAfter && pathBefore !== pathAfter) {
      changes.push({ path: pathBefore, before: b, after: "", shared: !before!.keepPrivate });
      changes.push({ path: pathAfter, before: "", after: c, shared: !after!.keepPrivate });
    } else if (b !== c) {
      changes.push({ path: pathAfter || pathBefore, before: b, after: c, shared: !a.keepPrivate && a.scope === "project" });
    }
  }
  const pairs: [string, (d: Design) => string, boolean][] = [
    [".claude/settings.local.json", settingsLocal, false],
    [".claude/rules/crewglass-team.md", teamMap, true],
    [".mcp.json", mcpJson, true],
    [HANDOFF_FILES.handoff, (d) => (d.handoff ? HANDOFF_COMMAND : ""), true],
    [HANDOFF_FILES.pickup, (d) => (d.handoff ? PICKUP_COMMAND : ""), true],
    [HANDOFF_FILES.rules, (d) => (d.handoff ? USAGE_RULES : ""), true],
  ];
  for (const [path, render, shared] of pairs) {
    const b = render(saved);
    const c = render(current);
    if (b !== c) changes.push({ path, before: b, after: c, shared });
  }
  return changes;
}
