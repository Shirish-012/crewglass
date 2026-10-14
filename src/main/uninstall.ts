// Uninstall (plan §10): shows a checklist first, then removes Crewglass's hooks from EVERY folder it ever touched,
// unregisters its private agy bridge, optionally removes the orchestrator setting, and deletes its own data.
// Your agent files, .mcp.json and the team map are yours and are kept.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UninstallPlan } from "@shared/ipc";
import { AGY_SERVER } from "@shared/agy";
import { LEGACY } from "@shared/legacy";
import { TEAM_MAP_FILES } from "@shared/teamMap";
import { isInstalled, uninstall as uninstallHooks } from "./live/hookInstaller";
import { readFolderConfig } from "./sources/configFiles";

/** The bridge's name, and the one it was registered under as Agent Deck. */
const AGY_NAMES: string[] = [AGY_SERVER, LEGACY.agyServer];
const exists = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

/** Every folder Crewglass may have changed: the ones on its lists, plus recent and open folders (checked on disk). */
export function planUninstall(lists: { hookFolders: string[]; agyFolders: string[]; recent: string[] }, dataFolders: string[]): UninstallPlan {
  const candidates = [...new Set([...lists.hookFolders, ...lists.agyFolders, ...lists.recent])].filter(exists);
  const hookFolders = candidates.filter((f) => lists.hookFolders.includes(f) || isInstalled(f));
  const agyFolders = candidates.filter((f) => readFolderConfig(f).mcps.some((m) => AGY_NAMES.includes(m.name) && m.scope === "local"));
  const orchestratorFolders = candidates.flatMap((f) => {
    const agent = readFolderConfig(f).agentSetting;
    // Only folders whose orchestrator Crewglass set up (it wrote a team map there).
    return agent && TEAM_MAP_FILES.some((t) => existsSync(join(f, t))) ? [{ folder: f, agent }] : [];
  });
  return { hookFolders, agyFolders, orchestratorFolders, dataFolders: dataFolders.filter(exists) };
}

/** Removes only the `agent` setting (and the effort Crewglass set with it) from a folder's settings.local.json. */
function removeOrchestrator(folder: string) {
  const p = join(folder, ".claude", "settings.local.json");
  if (!existsSync(p) || lstatSync(p).isSymbolicLink() || lstatSync(join(folder, ".claude")).isSymbolicLink()) return;
  const s = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  if (!("agent" in s)) return;
  delete s.agent;
  delete s.effortLevel; // Save writes the orchestrator's effort here, next to the agent setting
  const tmp = `${p}.crewglass-${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { flag: "wx" }); // create only: never through a planted link
  renameSync(tmp, p);
}

export function runUninstall(plan: UninstallPlan, opts: { removeOrchestrator: boolean }, deps: {
  backups: string;
  runClaude(folder: string, argv: string[]): { ok: boolean; error?: string };
}): { errors: string[] } {
  const errors: string[] = [];
  for (const f of plan.hookFolders) {
    try { uninstallHooks(f, deps.backups); } catch (e) { errors.push(`${f}: ${(e as Error).message}`); }
  }
  for (const f of plan.agyFolders) {
    for (const name of readFolderConfig(f).mcps.filter((m) => AGY_NAMES.includes(m.name) && m.scope === "local").map((m) => m.name)) {
      const r = deps.runClaude(f, ["mcp", "remove", "--scope", "local", name]);
      if (!r.ok) errors.push(`${f}: couldn't unregister the agy bridge (${r.error})`);
    }
  }
  if (opts.removeOrchestrator) {
    for (const { folder } of plan.orchestratorFolders) {
      try { removeOrchestrator(folder); } catch (e) { errors.push(`${folder}: ${(e as Error).message}`); }
    }
  }
  return { errors };
}
