// Live mode installer (plan §4.2). The ONLY project file Crewglass writes in Phase 2:
//   <folder>/.claude/settings.local.json   — personal, and git-ignored (checked; added to .git/info/exclude if not)
// Rules: show the diff first; touch only our own hook entries; running it twice changes nothing; re-read right
// before writing (Claude Code writes this file too); write via temp file + rename; removal restores the file
// byte-for-byte when nothing else changed, and never touches anything that isn't ours.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { realPath } from "../scope";
import { LEGACY } from "@shared/legacy";

export const HELPER_MARK = "crewglass-hook";

/** Every event Live mode listens to (all verified in Phase 0a). PreToolUse gets 150 s so an approval can wait (Phase 3);
 *  Stop and SubagentStop get 360 s so command checks (at most 5 min together) can finish (Phase 5). */
export const HOOK_EVENTS: { event: string; matcher: boolean; timeout: number }[] = [
  { event: "SessionStart", matcher: false, timeout: 5 },
  { event: "SessionEnd", matcher: false, timeout: 5 },
  { event: "UserPromptSubmit", matcher: false, timeout: 5 },
  { event: "PreToolUse", matcher: true, timeout: 150 },
  { event: "PostToolUse", matcher: true, timeout: 5 },
  { event: "PostToolUseFailure", matcher: true, timeout: 5 },
  { event: "PermissionRequest", matcher: true, timeout: 5 },
  { event: "PermissionDenied", matcher: true, timeout: 5 },
  { event: "Notification", matcher: false, timeout: 5 },
  { event: "Stop", matcher: false, timeout: 360 },
  { event: "StopFailure", matcher: false, timeout: 5 },
  { event: "SubagentStart", matcher: false, timeout: 5 },
  { event: "SubagentStop", matcher: false, timeout: 360 },
  { event: "PreCompact", matcher: false, timeout: 5 },
  { event: "PostCompact", matcher: false, timeout: 5 },
  { event: "PostModelSwitch", matcher: false, timeout: 5 },
  { event: "CwdChanged", matcher: false, timeout: 5 },
  { event: "TaskCreated", matcher: false, timeout: 5 },
  { event: "TaskCompleted", matcher: false, timeout: 5 },
  { event: "TeammateIdle", matcher: false, timeout: 5 },
];

type Json = Record<string, unknown>;
type Handler = { type?: string; command?: string; timeout?: number };
type Entry = { matcher?: string; hooks?: Handler[] };

/** The exact hook command. Paths are validated so nothing in them can break out of the quotes. */
export function hookCommand(helperPath: string, socketPath: string): string {
  for (const p of [helperPath, socketPath]) {
    if (!p.startsWith("/") || /["$`\\\n]/.test(p)) throw new Error("unsafe path for the hook command");
  }
  return `"${helperPath}" --socket "${socketPath}"`;
}

export interface HookPlan {
  path: string;
  before: string;
  after: string;
  existed: boolean;
  /** true = git already ignores it; false = we'll add it to .git/info/exclude; null = not a git repo. */
  gitIgnored: boolean | null;
}

function settingsPath(folder: string): string {
  const root = realPath(folder);
  const dir = join(root, ".claude");
  // Refuse to write through symlinks (plan §9: no writes through links that could point outside the folder).
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(".claude is a link; refusing to write through it");
  const file = join(dir, "settings.local.json");
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("settings.local.json is a link; refusing to write through it");
  return file;
}

const readText = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const parse = (t: string | null): Json => {
  if (t === null || t.trim() === "") return {};
  const v = JSON.parse(t) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("settings.local.json is not a JSON object");
  return v as Json;
};
// Entries written under the old name (Agent Deck) are ours too, so they get updated or removed like the rest.
const ours = (h: Handler) => typeof h?.command === "string" && (h.command.includes(HELPER_MARK) || h.command.includes(LEGACY.hookMark));
/** Our status line entry: the same helper, run with --statusline. */
const oursStatus = (s: unknown) => !!s && typeof s === "object" && ours(s as Handler) && String((s as Handler).command).includes("--statusline");

/** Live mode also sets Claude Code's status line (model · context · today's spend vs your limit). Settings switch. */
let statusLineOn = true;
export function setStatusLine(on: boolean) { statusLineOn = on; }

function withOurHooks(obj: Json, command: string): Json {
  const out: Json = structuredClone(obj);
  const hooks = (out.hooks && typeof out.hooks === "object" ? out.hooks : {}) as Record<string, Entry[]>;
  for (const { event, matcher, timeout } of HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Replace any older Crewglass entry (e.g. a moved helper) so installing twice changes nothing.
    const cleaned = list.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !ours(h)) })).filter((e) => (e.hooks ?? []).length > 0);
    cleaned.push({ ...(matcher ? { matcher: "*" } : {}), hooks: [{ type: "command", command, timeout }] });
    hooks[event] = cleaned;
  }
  out.hooks = hooks;
  // Never over a status line of your own; ours is replaced or removed with the switch.
  if (statusLineOn) { if (out.statusLine === undefined || oursStatus(out.statusLine)) out.statusLine = { type: "command", command: `${command} --statusline`, padding: 0 }; }
  else if (oursStatus(out.statusLine)) delete out.statusLine;
  return out;
}

/** If Live mode is on in these settings, bring its entries up to date (e.g. longer time limits for checks). */
export function refreshOurHooks(obj: Json, command: string): Json {
  const hooks = obj.hooks as Record<string, Entry[]> | undefined;
  const on = !!hooks && typeof hooks === "object" && Object.values(hooks).some((l) => Array.isArray(l) && l.some((e) => (e.hooks ?? []).some(ours)));
  return on ? withOurHooks(obj, command) : obj;
}

function withoutOurHooks(obj: Json): Json {
  const out: Json = structuredClone(obj);
  if (oursStatus(out.statusLine)) delete out.statusLine;
  if (!out.hooks || typeof out.hooks !== "object") return out;
  const hooks = out.hooks as Record<string, Entry[]>;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !ours(h)) })).filter((e) => (e.hooks ?? []).length > 0);
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

const pretty = (o: Json) => JSON.stringify(o, null, 2) + "\n";

function gitIgnored(folder: string): boolean | null {
  try {
    // fsmonitor off: a doctored .git/config in an untrusted folder can't make this git call run a program.
    execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", folder, "check-ignore", "-q", ".claude/settings.local.json"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status === 1 ? false : null; // 1 = not ignored; anything else (128) = not a git repo / git missing
  }
}

/** Live mode is on here but there's no status line at all yet (it predates the feature, and you set none of your own). */
export function missingStatusLine(folder: string): boolean {
  try { return isInstalled(folder) && parse(readText(settingsPath(folder))).statusLine === undefined; } catch { return false; }
}

/** Live mode is on here but some of our entries run a different command (a moved helper, or the old name's). */
export function outdatedHooks(folder: string, command: string): boolean {
  try {
    const hooks = parse(readText(settingsPath(folder))).hooks as Record<string, Entry[]> | undefined;
    if (!hooks) return false;
    return Object.values(hooks).some((l) => Array.isArray(l) && l.some((e) => (e.hooks ?? []).some((h) => ours(h) && h.command !== command)));
  } catch { return false; }
}

export function isInstalled(folder: string): boolean {
  try {
    const hooks = parse(readText(settingsPath(folder))).hooks as Record<string, Entry[]> | undefined;
    return !!hooks && Object.values(hooks).some((l) => Array.isArray(l) && l.some((e) => (e.hooks ?? []).some(ours)));
  } catch { return false; }
}

export function planInstall(folder: string, command: string): HookPlan {
  const path = settingsPath(folder);
  const before = readText(path);
  return { path, before: before ?? "", after: pretty(withOurHooks(parse(before), command)), existed: before !== null, gitIgnored: gitIgnored(folder) };
}

export function planUninstall(folder: string, backupDir: string): HookPlan {
  const path = settingsPath(folder);
  const before = readText(path) ?? "";
  return { path, before, after: restoredText(folder, parse(before), backupDir) ?? "", existed: before !== "", gitIgnored: gitIgnored(folder) };
}

const backupFile = (folder: string, backupDir: string) =>
  join(backupDir, createHash("sha256").update(realPath(folder)).digest("hex").slice(0, 16), "settings.local.json.orig.json");

/** What the file should look like after removal: the original bytes if nothing else changed, else the current file minus our hooks. */
function restoredText(folder: string, current: Json, backupDir: string): string | null {
  const stripped = withoutOurHooks(current);
  let original: { existed: boolean; text: string | null } | null = null;
  try { original = JSON.parse(readFileSync(backupFile(folder, backupDir), "utf8")); } catch { /* no backup */ }
  if (original) {
    const same = JSON.stringify(parse(original.text)) === JSON.stringify(stripped);
    if (same) return original.existed ? original.text : null;
  }
  return Object.keys(stripped).length ? pretty(stripped) : null;
}

/** Write with a fresh re-read: retried if Claude Code changed the file between our read and our write. */
function safeWrite(path: string, compute: (current: string | null) => string | null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = readText(path);
    const stamp = existsSync(path) ? statSync(path).mtimeMs : -1;
    const next = compute(current);
    const nowStamp = existsSync(path) ? statSync(path).mtimeMs : -1;
    if (nowStamp !== stamp) continue;
    if (next === null) { if (current !== null) unlinkSync(path); return; }
    mkdirSync(dirname(path), { recursive: true });
    // Random name + "wx" (create only): a file or link planted at the temp name is never followed or overwritten.
    const tmp = `${path}.crewglass-${randomUUID()}.tmp`;
    writeFileSync(tmp, next, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644, flag: "wx" });
    renameSync(tmp, path);
    return;
  }
  throw new Error("settings.local.json kept changing; try again");
}

export function install(folder: string, command: string, backupDir: string): HookPlan {
  const plan = planInstall(folder, command);
  const bf = backupFile(folder, backupDir);
  // Keep the original only once (the first install), so removal can restore exactly what you had.
  if (!existsSync(bf) || !isInstalled(folder)) {
    mkdirSync(dirname(bf), { recursive: true, mode: 0o700 });
    writeFileSync(bf, JSON.stringify({ existed: plan.existed, text: plan.existed ? plan.before : null }), { mode: 0o600 });
  }
  const createdDir = !existsSync(dirname(plan.path));
  safeWrite(plan.path, (cur) => pretty(withOurHooks(parse(cur), command)));
  if (createdDir) writeFileSync(`${bf}.created-dir`, "1");
  if (plan.gitIgnored === false) {
    const exclude = join(realPath(folder), ".git", "info", "exclude");
    // Only a real .git folder (not a link, and not a worktree's .git file).
    const isLink = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();
    if (existsSync(join(realPath(folder), ".git")) && lstatSync(join(realPath(folder), ".git")).isDirectory()
      && !isLink(dirname(exclude)) && !isLink(exclude)) { // never write through a link
      const text = readText(exclude) ?? "";
      if (!text.includes("/.claude/settings.local.json")) {
        mkdirSync(dirname(exclude), { recursive: true });
        appendFileSync(exclude, `${text.endsWith("\n") || !text ? "" : "\n"}# Crewglass: personal Claude Code settings\n/.claude/settings.local.json\n`);
      }
    }
  }
  return plan;
}

export function uninstall(folder: string, backupDir: string): HookPlan {
  const plan = planUninstall(folder, backupDir);
  safeWrite(plan.path, (cur) => restoredText(folder, parse(cur), backupDir));
  const bf = backupFile(folder, backupDir);
  // Remove the .claude folder too if we created it and it's now empty.
  if (existsSync(`${bf}.created-dir`)) {
    const dir = dirname(plan.path);
    try { if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* not empty: leave it */ }
    unlinkSync(`${bf}.created-dir`);
  }
  try { unlinkSync(bf); } catch { /* no backup */ }
  return plan;
}
