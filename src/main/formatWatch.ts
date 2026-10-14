// Detects when a Claude Code update changes its files (plan §13.1). Compares what was seen with the shapes
// verified in Phase 0a and reports NAMES and types only — never values. Drives the bottom-left box.

import type { FormatIssue } from "@shared/types";
import { KNOWN_ENTRY_TYPES, KNOWN_USAGE_KEYS, type FormatSeen } from "./sources/transcripts";

export const TESTED_CLAUDE_VERSION = "2.1.288";

const KNOWN_SESSION_FIELDS = new Set([
  "pid", "sessionId", "cwd", "startedAt", "procStart", "version", "peerProtocol", "peerFeatures", "kind", "entrypoint",
  "pidDomain", "messagingSocketPath", "name", "nameSource", "nameSince", "status", "updatedAt", "statusUpdatedAt",
  "agent", // the agent the session runs as (--agent, or the `agent` setting) — seen in Phase 5
  "jobId", "formerNames", // background (`claude --bg`) sessions — seen in Phase 6
]);
const KNOWN_KINDS = new Set(["interactive", "teammate", "background", "bg", "sdk"]);
const KNOWN_STATUSES = new Set(["busy", "idle", "waiting", ""]);

export function detectFormatIssues(input: {
  sessionFields: string[][];
  kinds: string[];
  statuses: string[];
  transcripts: FormatSeen;
}): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const add = (i: FormatIssue) => { if (!issues.some((x) => x.source === i.source && x.name === i.name)) issues.push(i); };
  for (const fields of input.sessionFields) {
    for (const f of fields) if (!KNOWN_SESSION_FIELDS.has(f)) add({ source: "sessions", kind: "new-field", name: f, detail: "new field in session files", severity: "info", fixFile: "src/main/sources/claudeSessions.ts" });
    for (const need of ["pid", "cwd", "sessionId"]) if (!fields.includes(need)) add({ source: "sessions", kind: "missing", name: need, detail: "field Crewglass relies on is missing", severity: "warn", fixFile: "src/main/sources/claudeSessions.ts" });
  }
  for (const k of input.kinds) if (k && !KNOWN_KINDS.has(k)) add({ source: "sessions", kind: "new-value", name: `kind = "${k}"`, detail: "new session kind", severity: "info", fixFile: "src/main/sources/claudeSessions.ts" });
  for (const s of input.statuses) if (!KNOWN_STATUSES.has(s)) add({ source: "sessions", kind: "new-value", name: `status = "${s}"`, detail: "new session status", severity: "info", fixFile: "src/main/sources/claudeSessions.ts" });
  for (const t of input.transcripts.entryTypes) if (!KNOWN_ENTRY_TYPES.has(t)) add({ source: "transcripts", kind: "new-value", name: `type = "${t}"`, detail: "new entry type", severity: "info", fixFile: "src/main/sources/transcripts.ts" });
  for (const u of input.transcripts.usageKeys) if (!KNOWN_USAGE_KEYS.has(u)) add({ source: "transcripts", kind: "new-field", name: `message.usage.${u}`, detail: "new usage field", severity: "info", fixFile: "src/main/sources/transcripts.ts" });
  if (input.transcripts.missingUsage) add({ source: "transcripts", kind: "missing", name: "message.usage", detail: "token numbers missing on replies", severity: "warn", fixFile: "src/main/sources/transcripts.ts" });
  return issues;
}

/** Stable signature so "Dismiss for this version" hides exactly this set until something changes. */
export function issuesSignature(issues: FormatIssue[], version: string | null): string {
  return `${version ?? "?"}|${issues.map((i) => `${i.source}:${i.name}`).sort().join(",")}`;
}
