// Usage history beyond Claude Code's own 30 days (plan D11): one row of NUMBERS AND NAMES per past session —
// when, how long, tokens, models, agents, MCP servers, failures — kept privately in Crewglass's data folder for
// as many days as you choose (90 by default). Never any prompt or reply text.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryRow, SessionSource } from "@shared/types";

export interface StoredRow {
  id: string;
  startedAt: number;
  lastAt: number;
  source: SessionSource;
  durationMin: number;
  tokens: number;
  agents: string[];
  mcps: string[];
  failures: number;
  models: string[];
}

const file = (userData: string, folder: string) => join(userData, "history", `${createHash("sha256").update(folder).digest("hex").slice(0, 16)}.json`);
const DAY = 24 * 3600_000;
const SOURCES = new Set(["vscode", "terminal", "headless", "pipeline"]);

function clean(r: unknown): StoredRow | null {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 100)) : []);
  if (typeof o.id !== "string" || !o.id || num(o.startedAt) === null || num(o.lastAt) === null) return null;
  return {
    id: o.id.slice(0, 100), startedAt: o.startedAt as number, lastAt: o.lastAt as number,
    source: SOURCES.has(String(o.source)) ? (o.source as SessionSource) : "terminal",
    durationMin: num(o.durationMin) ?? 0, tokens: num(o.tokens) ?? 0, failures: num(o.failures) ?? 0,
    agents: names(o.agents), mcps: names(o.mcps), models: names(o.models),
  };
}

export function readHistory(userData: string, folder: string): StoredRow[] {
  try {
    const rows = (JSON.parse(readFileSync(file(userData, folder), "utf8")) as { rows?: unknown[] }).rows ?? [];
    return rows.map(clean).filter((r): r is StoredRow => !!r);
  } catch { return []; }
}

/** Adds or updates these sessions, drops anything older than `keepDays`, and writes only if something changed. */
export function saveHistory(userData: string, folder: string, rows: StoredRow[], keepDays: number, now = Date.now()): StoredRow[] {
  const byId = new Map(readHistory(userData, folder).map((r) => [r.id, r]));
  const before = JSON.stringify([...byId.values()]);
  for (const r of rows) byId.set(r.id, r);
  const kept = [...byId.values()].filter((r) => now - r.lastAt < keepDays * DAY).sort((a, b) => b.lastAt - a.lastAt).slice(0, 5000);
  if (JSON.stringify(kept) !== before) {
    const p = file(userData, folder);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(`${p}.tmp`, JSON.stringify({ rows: kept }), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  }
  return kept;
}

export function deleteHistory(userData: string) {
  rmSync(join(userData, "history"), { recursive: true, force: true });
}

/** Rows for the History tab: live ones (from Claude's transcripts) win over stored ones for the same session. */
export function mergeHistory(stored: StoredRow[], live: StoredRow[], keepDays: number, label: (at: number) => string, now = Date.now()): HistoryRow[] {
  const byId = new Map(stored.map((r) => [r.id, r]));
  for (const r of live) byId.set(r.id, r);
  return [...byId.values()].filter((r) => now - r.lastAt < keepDays * DAY).sort((a, b) => b.lastAt - a.lastAt).slice(0, 500)
    .map((r) => ({ id: r.id, started: label(r.startedAt), source: r.source, durationMin: r.durationMin, tokens: r.tokens, agents: r.agents, mcps: r.mcps, failures: r.failures, models: r.models }));
}
