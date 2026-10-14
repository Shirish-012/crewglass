// Subagent definitions: <folder>/.claude/agents/*.md (project) and ~/.claude/agents/*.md (all projects).
// Parsed with `yaml` in its safe core schema (no custom tags), read-only.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Agent, Effort } from "@shared/types";
import { EFFORTS } from "@shared/models";
import { geminiFromInstructions, isAgyTool } from "@shared/agy";
import { lenientFrontmatter } from "@shared/frontmatter";
import { USER_AGENTS_DIR } from "../paths";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AgentFile { agent: Agent; frontmatterKeys: string[] }

function parseFile(path: string, scope: "project" | "user", displayPath: string): AgentFile | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  let fm: Record<string, unknown>;
  let lenient = false;
  try { fm = (parse(m[1], { schema: "core", maxAliasCount: 0 }) ?? {}) as Record<string, unknown>; }
  catch { fm = lenientFrontmatter(m[1]); lenient = true; } // Claude Code reads these too
  const name = typeof fm.name === "string" ? fm.name : "";
  if (!NAME_RE.test(name)) return null;
  const tools = typeof fm.tools === "string" ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : Array.isArray(fm.tools) ? fm.tools.map(String) : null;
  const effort = EFFORTS.includes(fm.effort as Effort) ? (fm.effort as Effort) : undefined;
  const agyTool = tools?.some((t) => isAgyTool(t) || t.startsWith("mcp__agy"));
  const agent: Agent = {
    key: `${scope}:${displayPath}`,
    name,
    kind: agyTool ? "agy" : "subagent",
    geminiModel: agyTool ? geminiFromInstructions(m[2]) ?? "agy-default" : undefined,
    scope,
    file: displayPath,
    role: typeof fm.description === "string" ? fm.description : "",
    instructions: m[2].trim(),
    model: typeof fm.model === "string" ? fm.model : "inherit",
    effort,
    maxTurns: typeof fm.maxTurns === "number" ? fm.maxTurns : undefined,
    ...(fm.omitClaudeMd === true ? { omitClaudeMd: true } : {}),
    toolAccess: tools ? "connected" : "inherit",
    builtinTools: (tools ?? []).filter((t) => !t.startsWith("mcp__")),
    keepPrivate: false,
    checks: [],
    status: "idle", parallel: 0, tokens: 0, calls: 0, skillsUsed: [],
    ...(lenient ? { lenientHeader: true } : {}),
  };
  return { agent, frontmatterKeys: Object.keys(fm) };
}

function readDir(dir: string, scope: "project" | "user", prefix: string): AgentFile[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  return files.map((f) => parseFile(join(dir, f), scope, `${prefix}${f}`)).filter((x): x is AgentFile => !!x);
}

export function readAgentFiles(folder: string): { project: AgentFile[]; user: AgentFile[] } {
  const project = readDir(join(folder, ".claude", "agents"), "project", ".claude/agents/");
  const user = readDir(USER_AGENTS_DIR, "user", "~/.claude/agents/");
  // Same name in both places: the project one wins (verified in Phase 0a); within one folder the first file alphabetically wins.
  const winner = new Map<string, string>();
  for (const f of [...project, ...user]) if (!winner.has(f.agent.name)) winner.set(f.agent.name, f.agent.key);
  for (const f of [...project, ...user]) {
    const others = [...project, ...user].filter((o) => o.agent.name === f.agent.name && o.agent.key !== f.agent.key);
    if (others.length) f.agent.sameName = { usedByClaude: winner.get(f.agent.name) === f.agent.key, otherKey: others[0].agent.key };
  }
  return { project, user };
}
