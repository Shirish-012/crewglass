// Builds throwaway fixture folders that look like ~/.claude, so tests never touch your real Claude Code data.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tempDir(prefix = "crewglass-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function write(path: string, content: string | object) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

export const jsonl = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

export const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

/** An assistant transcript line; `usage` numbers are per streaming snapshot. */
export function assistant(id: string, opts: { model?: string; effort?: string; out?: number; input?: number; cacheWrite?: number; cacheRead?: number; tools?: object[]; ts?: string; cwd?: string; sidechain?: boolean }) {
  return {
    type: "assistant", timestamp: opts.ts ?? new Date().toISOString(), cwd: opts.cwd, isSidechain: opts.sidechain ?? false, effort: opts.effort,
    message: {
      id, model: opts.model ?? "claude-opus-5-5",
      usage: { input_tokens: opts.input ?? 10, cache_creation_input_tokens: opts.cacheWrite ?? 100, cache_read_input_tokens: opts.cacheRead ?? 1000, output_tokens: opts.out ?? 5 },
      content: opts.tools ?? [{ type: "text", text: "secret reply text that must never be kept" }],
    },
  };
}

export const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
export const toolResult = (id: string, isError = false, ts?: string) => ({
  type: "user", timestamp: ts ?? new Date().toISOString(),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "tool output that must never be kept" }] },
});
