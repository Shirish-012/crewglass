// Renders an agent as the Markdown file Claude Code reads (.claude/agents/<name>.md).
// The prototype uses it to show real-looking diffs. The Electron writer will round-trip existing
// files with the `yaml` Document API instead, so unknown fields and comments are kept.

import { stringify } from "yaml";
import type { Agent } from "./types";
import { findModel } from "./models";
import { AGY_TOOL } from "./agy";

export interface AgentFileExtras {
  /** MCP servers this agent is connected to on the canvas ("can use" links). */
  mcpServers: string[];
  /** True when the agent has an outgoing hand-off link, so it needs the Agent tool. */
  canCallAgents: boolean;
}

export function agentTools(agent: Agent, extras: AgentFileExtras): string[] | null {
  if (agent.kind === "agy") return [AGY_TOOL]; // the relay's only tool: Crewglass's agy bridge
  if (agent.toolAccess === "inherit") return null;
  const tools = [...agent.builtinTools];
  if ((extras.canCallAgents || agent.kind === "orchestrator") && !tools.includes("Agent")) tools.push("Agent");
  for (const s of extras.mcpServers) tools.push(`mcp__${s}__*`);
  return tools;
}

export function renderAgentFile(agent: Agent, extras: AgentFileExtras): string {
  // Values go through a real YAML writer, so text like "Use when: reviewing" (or a line break) can never
  // break the file or add a field of its own.
  const model = findModel(agent.model);
  const tools = agentTools(agent, extras);
  const fm: Record<string, unknown> = { name: agent.name, description: agent.role, model: model?.alias ?? agent.model };
  if (agent.effort && model?.usesEffort) fm.effort = agent.effort;
  if (agent.maxTurns) fm.maxTurns = agent.maxTurns;
  if (agent.omitClaudeMd) fm.omitClaudeMd = true;
  if (tools) fm.tools = tools.join(", ");
  return ["---", stringify(fm, { lineWidth: 0 }).trimEnd(), "---", "", agent.instructions.trim(), ""].join("\n");
}
