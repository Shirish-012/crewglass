// Live Claude Code sessions, from ~/.claude/sessions/<pid>.json. Only the listed fields are read,
// the *.key files are never opened, and sessions outside the watched folder are dropped right here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../paths";
import type { Scope } from "../scope";
import type { SessionSource, SessionStatus } from "@shared/types";

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  subfolder: string;
  kind: string;
  entrypoint: string;
  status: string;
  name: string;
  version: string;
  updatedAt: number;
  /** The agent this session runs as (from `--agent` or the `agent` setting), if any. */
  agent?: string;
  /** Field names seen in the file, for the unknown-fields check (names only, never values). */
  fields: string[];
}

// "bg" = a background session started with `claude --bg` (Phase 6); shown like "background".
const INCLUDED_KINDS = new Set(["interactive", "teammate", "background", "bg"]);
const INCLUDED_ENTRYPOINTS = new Set(["claude-vscode", "cli"]);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readSessions(scope: Scope, ownPids: Set<number> = new Set()): { included: LiveSession[]; seenFields: string[][]; kinds: string[]; statuses: string[] } {
  const included: LiveSession[] = [];
  const seenFields: string[][] = [];
  const kinds: string[] = [];
  const statuses: string[] = [];
  let files: string[] = [];
  try { files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")); } catch { return { included, seenFields, kinds, statuses }; }
  for (const f of files) {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8")); } catch { continue; }
    const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
    // Outside the folder: dropped immediately, nothing kept or counted.
    if (!scope.contains(cwd)) continue;
    seenFields.push(Object.keys(raw));
    const pid = Number(raw.pid);
    const kind = String(raw.kind ?? "");
    const entrypoint = String(raw.entrypoint ?? "");
    kinds.push(kind);
    statuses.push(String(raw.status ?? ""));
    const ok = ownPids.has(pid) || INCLUDED_KINDS.has(kind) && (kind !== "interactive" || INCLUDED_ENTRYPOINTS.has(entrypoint));
    if (!ok || !Number.isFinite(pid) || !alive(pid)) continue;
    included.push({
      pid, sessionId: String(raw.sessionId ?? ""), cwd, subfolder: scope.subfolder(cwd), kind, entrypoint,
      status: String(raw.status ?? ""), name: String(raw.name ?? `session-${pid}`), version: String(raw.version ?? ""),
      updatedAt: Number(raw.updatedAt ?? 0), fields: Object.keys(raw),
      ...(typeof raw.agent === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/.test(raw.agent) ? { agent: raw.agent } : {}),
    });
  }
  return { included, seenFields, kinds, statuses };
}

export function sourceOf(entrypoint: string, kind: string): SessionSource {
  if (kind === "sdk") return "pipeline";
  if (entrypoint === "claude-vscode") return "vscode";
  if (entrypoint === "sdk-cli") return "headless";
  return "terminal";
}

export function statusOf(raw: string): SessionStatus {
  if (raw === "busy") return "busy";
  if (raw === "waiting") return "waiting";
  return "idle";
}
