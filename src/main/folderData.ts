// Private per-folder data in Crewglass's own data folder — never in the repo (plan §6.4): the command checks you
// attached to agents, the commands you typed yourself, and the commands you've confirmed for this folder.
// A cloned or malicious repo can therefore never make Crewglass run a command.
import { CHAT_KEY, CHAT_NAME } from "@shared/teamMap";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesignPayload, PlanCheck } from "@shared/ipc";
import { BUILTIN_CHECKS, checkCommandProblem, customCheckKey } from "@shared/checks";
import type { CheckDef } from "./checks/runner";

export interface FolderData {
  /** Agent name → the command checks that run when it finishes. */
  checks: Record<string, string[]>;
  /** Commands you typed yourself (check key → label + command). */
  commands: Record<string, { label: string; command: string }>;
  /** Exact commands you confirmed for this folder. */
  confirmed: string[];
  /** Checks on a hand-off ("lead>coder" → check keys): they check coder's work whenever lead handed it that work. */
  linkChecks: Record<string, string[]>;
}

const EMPTY: FolderData = { checks: {}, commands: {}, confirmed: [], linkChecks: {} };
const file = (userData: string, folder: string) => join(userData, "folders", `${createHash("sha256").update(folder).digest("hex").slice(0, 16)}.json`);

export function readFolderData(userData: string, folder: string): FolderData {
  try { return { ...EMPTY, ...(JSON.parse(readFileSync(file(userData, folder), "utf8")) as Partial<FolderData>) }; }
  catch { return { ...EMPTY }; }
}

export function writeFolderData(userData: string, folder: string, data: FolderData) {
  const p = file(userData, folder);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/** The command a check key stands for: built-ins from Crewglass's own catalog, yours from private data. */
function commandOf(data: FolderData, key: string): { label: string; command: string } | null {
  const b = BUILTIN_CHECKS[key];
  if (b) return b.kind === "command" && b.command ? { label: b.label, command: b.command } : null;
  return data.commands[key] ?? null;
}

/** The command checks for an agent's finished work: its own, plus those on the hand-off from `caller` (if any).
 *  Only commands you confirmed ever run. */
export function checksFor(data: FolderData, agentName: string, caller?: string): CheckDef[] {
  const keys = [...new Set([...(data.checks[agentName] ?? []), ...(caller ? data.linkChecks[`${caller}>${agentName}`] ?? [] : [])])];
  return keys.flatMap((key) => {
    const c = commandOf(data, key);
    return c && data.confirmed.includes(c.command) ? [{ key, label: c.label, command: c.command }] : [];
  });
}

/** What Save will do with command checks: which run for whom, which commands are new here (you confirm those). */
export function planChecks(data: FolderData, design: DesignPayload): { checks: PlanCheck[]; changed: boolean; needsConfirm: boolean; next: FolderData } {
  const next: FolderData = { checks: {}, commands: {}, confirmed: [...data.confirmed], linkChecks: {} };
  const checks: PlanCheck[] = [];
  // Resolve one check key to its command (built-ins from Crewglass's catalog, yours from what you typed).
  const resolve = (key: string, who: string) => {
    let c = BUILTIN_CHECKS[key]?.kind === "command" ? commandOf(data, key) : null;
    if (!c && key.startsWith("cmd:")) {
      // A command you typed: it must be a valid single command, and its key must match it.
      const typed = design.checks[key];
      const command = typeof typed?.command === "string" ? typed.command.trim() : "";
      const problem = checkCommandProblem(command);
      if (problem) throw new Error(`${who}: ${problem}`);
      if (customCheckKey(command) !== key) throw new Error(`${who}: that check doesn't match its command`);
      c = { label: command, command };
      next.commands[key] = c;
    }
    return c;
  };
  for (const a of design.agents) {
    if (a.kind === "builtin" || !a.checks.length) continue;
    for (const key of a.checks) {
      const c = resolve(key, a.name);
      if (!c) continue;
      (next.checks[a.name] ??= []).push(key);
      checks.push({ agent: a.name, label: c.label, command: c.command, isNew: !data.confirmed.includes(c.command) });
    }
  }
  // Checks on hand-off links, by agent names (Claude runs agents by name).
  const nameOf = new Map<string, string>([...design.agents.map((a): [string, string] => [a.key, a.name]), [CHAT_KEY, CHAT_NAME]]);
  for (const l of design.links) {
    if (!l.planned || !l.checks?.length || (l.kind !== "delegates" && l.kind !== "direct")) continue;
    const from = nameOf.get(l.from), to = nameOf.get(l.to);
    if (!from || !to) continue;
    const fromLabel = from === CHAT_NAME ? "your chat" : from;
    for (const key of l.checks) {
      const c = resolve(key, `${fromLabel} → ${to}`);
      if (!c) continue;
      (next.linkChecks[`${from}>${to}`] ??= []).push(key);
      checks.push({ agent: `${to} (when ${fromLabel} hands it work)`, label: c.label, command: c.command, isNew: !data.confirmed.includes(c.command) });
    }
  }
  for (const c of checks) if (!next.confirmed.includes(c.command)) next.confirmed.push(c.command);
  const changed = JSON.stringify([next.checks, next.commands, next.linkChecks]) !== JSON.stringify([data.checks, data.commands, data.linkChecks]);
  return { checks, changed, needsConfirm: checks.some((c) => c.isNew), next };
}
