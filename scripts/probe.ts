#!/usr/bin/env node
// scripts/probe.ts — read-only check of Claude Code's local data formats (Phase 0a).
//
// Run:  node scripts/probe.ts [--folder <path>] [--json]
//
// Reports field NAMES, TYPES and small enum values only (kinds, statuses, entry types, models).
// It never prints prompt text, replies, tool inputs, tokens, or credentials, and never writes anything.
// Re-run it after a Claude Code update to see what changed (the app's "Unknown fields" box does the same live).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const folderArg = args.includes("--folder") ? args[args.indexOf("--folder") + 1] : process.cwd();
const asJson = args.includes("--json");
const folder = realpathSync(folderArg);
const claudeDir = join(homedir(), ".claude");

type Counter = Record<string, number>;
const bump = (c: Counter, k: string) => { c[k] = (c[k] ?? 0) + 1; };
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const keyTypes = (o: Record<string, unknown>, into: Record<string, string>) => {
  for (const [k, v] of Object.entries(o)) into[k] = into[k] && into[k] !== typeOf(v) ? `${into[k]}|${typeOf(v)}` : typeOf(v);
};
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const jsonLines = (p: string): any[] =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const isInside = (cwd: string | undefined) => {
  if (!cwd) return false;
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* folder may be gone */ }
  return real === folder || real.startsWith(folder + "/");
};
// Claude Code encodes a project path by replacing every non-alphanumeric character with "-".
const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

const report: Record<string, unknown> = { folder, claudeDir };

// 1. Session status files (never the *.key files).
const sessionsDir = join(claudeDir, "sessions");
const sessions = { files: 0, inFolder: 0, kinds: {} as Counter, entrypoints: {} as Counter, statuses: {} as Counter,
  versions: {} as Counter, fields: {} as Record<string, string> };
if (existsSync(sessionsDir)) {
  for (const f of readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))) {
    const s = readJson(join(sessionsDir, f));
    if (!s) continue;
    sessions.files++;
    keyTypes(s, sessions.fields);
    bump(sessions.kinds, String(s.kind)); bump(sessions.entrypoints, String(s.entrypoint));
    bump(sessions.statuses, String(s.status)); bump(sessions.versions, String(s.version));
    if (isInside(s.cwd)) sessions.inFolder++;
  }
}
report.sessions = sessions;

// 2. IDE lock files: only the key names (authToken is never read into the report).
const ideDir = join(claudeDir, "ide");
const ide = { files: 0, fields: {} as Record<string, string>, ideNames: {} as Counter };
if (existsSync(ideDir)) {
  for (const f of readdirSync(ideDir).filter((f) => f.endsWith(".lock"))) {
    const l = readJson(join(ideDir, f));
    if (!l) continue;
    ide.files++;
    keyTypes(l, ide.fields); bump(ide.ideNames, String(l.ideName));
  }
}
report.ideLocks = ide;

// 3. Transcripts for this folder (and subfolders), confirmed by the cwd inside each file.
const projectsDir = join(claudeDir, "projects");
const tx = {
  projectDirs: [] as string[], mainFiles: 0, subagentFiles: 0, entryTypes: {} as Counter, topFields: {} as Record<string, string>,
  usageFields: {} as Record<string, string>, models: {} as Counter, efforts: {} as Counter, toolNames: {} as Counter,
  messageIdLines: { ids: 0, repeatedIds: 0, repeatsWithDifferentUsage: 0 }, subagentMetaFields: {} as Record<string, string>,
  sidechainInMain: 0,
};
if (existsSync(projectsDir)) {
  const prefix = encode(folder);
  for (const dir of readdirSync(projectsDir).filter((d) => d.startsWith(prefix))) {
    const full = join(projectsDir, dir);
    const mains = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    // Confirm with the cwd inside the first entry that has one ("agent app" and "agent-app" encode the same).
    const belongs = mains.some((f) => isInside(jsonLines(join(full, f)).find((e) => e.cwd)?.cwd));
    if (!belongs) continue;
    tx.projectDirs.push(dir);
    const files: [string, boolean][] = mains.map((f) => [join(full, f), false]);
    for (const f of mains) {
      const subDir = join(full, basename(f, ".jsonl"), "subagents");
      if (!existsSync(subDir)) continue;
      for (const s of readdirSync(subDir)) {
        if (s.endsWith(".jsonl")) files.push([join(subDir, s), true]);
        if (s.endsWith(".meta.json")) keyTypes(readJson(join(subDir, s)) ?? {}, tx.subagentMetaFields);
      }
    }
    for (const [path, isSub] of files) {
      isSub ? tx.subagentFiles++ : tx.mainFiles++;
      const lastUsageById = new Map<string, string>();
      for (const e of jsonLines(path)) {
        bump(tx.entryTypes, String(e.type));
        keyTypes(e, tx.topFields);
        if (!isSub && e.isSidechain === true) tx.sidechainInMain++;
        if (e.type !== "assistant" || typeof e.message !== "object") continue;
        const m = e.message;
        bump(tx.models, String(m.model));
        if (e.effort !== undefined) bump(tx.efforts, `${m.model}:${e.effort}`);
        if (m.usage) keyTypes(m.usage, tx.usageFields);
        for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === "tool_use") bump(tx.toolNames, String(c.name));
        const usage = JSON.stringify(m.usage ?? null);
        const prev = lastUsageById.get(m.id);
        if (prev === undefined) tx.messageIdLines.ids++;
        else { tx.messageIdLines.repeatedIds++; if (prev !== usage) tx.messageIdLines.repeatsWithDifferentUsage++; }
        lastUsageById.set(m.id, usage);
      }
    }
  }
}
// Tool names are summarized: MCP tools are grouped by server so nothing specific leaks into the report.
const groupedTools: Counter = {};
for (const [name, n] of Object.entries(tx.toolNames)) {
  const key = name.startsWith("mcp__") ? `mcp__${name.split("__")[1]}__*` : name;
  groupedTools[key] = (groupedTools[key] ?? 0) + n;
}
tx.toolNames = groupedTools;
report.transcripts = tx;

// 4. Agent files (project + user): file names and frontmatter keys only.
const frontmatterKeys = (p: string) => {
  const m = readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1].split("\n").map((l) => l.match(/^([A-Za-z][\w-]*):/)?.[1]).filter(Boolean) as string[] : [];
};
const agents: Record<string, { files: string[]; frontmatterKeys: Counter }> = {};
for (const [scope, dir] of [["project", join(folder, ".claude", "agents")], ["user", join(claudeDir, "agents")]]) {
  const entry = { files: [] as string[], frontmatterKeys: {} as Counter };
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    entry.files.push(f);
    for (const k of frontmatterKeys(join(dir, f))) bump(entry.frontmatterKeys, k);
  }
  agents[scope] = entry;
}
report.agents = agents;

// 5. Settings and MCP config: top-level keys and server names only.
const settings: Record<string, unknown> = {};
for (const name of ["settings.json", "settings.local.json"]) {
  const s = readJson(join(folder, ".claude", name));
  if (s) settings[name] = { keys: Object.keys(s), hookEvents: Object.keys(s.hooks ?? {}), agent: s.agent ?? null };
}
const mcp = readJson(join(folder, ".mcp.json"));
settings[".mcp.json"] = mcp ? { servers: Object.keys(mcp.mcpServers ?? {}) } : null;
const userCfg = readJson(join(homedir(), ".claude.json")); // only mcpServers keys are read from it
settings["~/.claude.json"] = userCfg ? {
  userMcpServers: Object.keys(userCfg.mcpServers ?? {}),
  localMcpServers: Object.keys(userCfg.projects?.[folder]?.mcpServers ?? {}),
} : null;
report.settings = settings;

report.rulesFiles = existsSync(join(folder, ".claude", "rules"))
  ? readdirSync(join(folder, ".claude", "rules")).filter((f) => f.endsWith(".md")) : [];
report.generatedAt = new Date().toISOString();
try { report.transcriptsNewestMtime = tx.projectDirs.length
  ? new Date(Math.max(...tx.projectDirs.map((d) => statSync(join(projectsDir, d)).mtimeMs))).toISOString() : null; } catch { /* ignore */ }

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const s = report.sessions as typeof sessions;
  console.log(`Crewglass probe — folder: ${folder}\n`);
  console.log(`Sessions: ${s.files} files, ${s.inFolder} in this folder`);
  console.log(`  kinds ${JSON.stringify(s.kinds)}  entrypoints ${JSON.stringify(s.entrypoints)}  statuses ${JSON.stringify(s.statuses)}`);
  console.log(`  fields ${Object.keys(s.fields).join(", ")}`);
  console.log(`IDE locks: ${ide.files} (${JSON.stringify(ide.ideNames)}) fields ${Object.keys(ide.fields).join(", ")}`);
  console.log(`Transcripts: ${tx.mainFiles} main, ${tx.subagentFiles} subagent, dirs ${tx.projectDirs.join(", ") || "none"}`);
  console.log(`  entry types ${JSON.stringify(tx.entryTypes)}`);
  console.log(`  models ${JSON.stringify(tx.models)}  efforts ${JSON.stringify(tx.efforts)}`);
  console.log(`  usage fields ${Object.keys(tx.usageFields).join(", ")}`);
  console.log(`  message.id: ${tx.messageIdLines.ids} ids, ${tx.messageIdLines.repeatedIds} repeated lines, ` +
    `${tx.messageIdLines.repeatsWithDifferentUsage} with changed usage (use the LAST line per id)`);
  console.log(`  sidechain entries inside main transcripts: ${tx.sidechainInMain}`);
  console.log(`  tools ${JSON.stringify(tx.toolNames)}`);
  console.log(`  subagent meta fields ${Object.keys(tx.subagentMetaFields).join(", ") || "none"}`);
  console.log(`Agents: project ${agents.project.files.length}, user ${agents.user.files.length}; keys ${JSON.stringify({ ...agents.project.frontmatterKeys, ...agents.user.frontmatterKeys })}`);
  console.log(`Settings: ${JSON.stringify(settings)}`);
  console.log(`Rules files: ${(report.rulesFiles as string[]).join(", ") || "none"}`);
}
