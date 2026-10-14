// Run pipeline with a stand-in for `claude` (a tiny script that speaks stream-json), so no tokens are spent.
import { describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PipelineRunner, validSpec } from "../src/main/pipeline/runner";
import type { PipelineProgress, PipelineSpec } from "@shared/ipc";
import type { CheckDef, CheckResult } from "../src/main/checks/runner";
import { tempDir } from "./helpers";

function fakeClaude() {
  const dir = tempDir("fake-claude-");
  const log = join(dir, "log.jsonl");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const agent = args[args.indexOf("--agent") + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent, args, prompt }) + "\\n");
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", session_id: "sess-" + agent, model: "claude-haiku-4-5-20251001" });
  if (agent === "slow") { setTimeout(() => {}, 60000); return; }
  out({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "working" }] } });
  out({ type: "result", is_error: agent === "broken", result: "RESULT from " + agent, usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 3 } });
  process.exit(agent === "broken" ? 1 : 0);
});
`);
  chmodSync(bin, 0o755);
  return { bin, runs: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { agent: string; args: string[]; prompt: string }) };
}

function runner(bin: string, checks: Record<string, boolean[]> = {}) {
  const sessions: string[] = [];
  let last: PipelineProgress | null = null;
  const counts: Record<string, number> = {};
  const r = new PipelineRunner({
    claudeBin: bin, folder: tempDir("pipe-folder-"),
    checksFor: (agent): CheckDef[] => (checks[agent] ? [{ key: "t", label: "npm test", command: "npm test" }] : []),
    runCheck: async (d): Promise<CheckResult> => {
      const agent = Object.keys(checks).find((a) => checks[a]) as string;
      const i = counts[agent] = (counts[agent] ?? -1) + 1;
      const ok = checks[agent][Math.min(i, checks[agent].length - 1)];
      return { key: d.key, label: d.label, ok, exitCode: ok ? 0 : 1, timedOut: false, ms: 1, tail: ok ? "" : "1 test failed" };
    },
    onProgress: (p) => { last = p; },
    onSession: (id) => sessions.push(id),
  });
  const done = () => new Promise<PipelineProgress>((res) => { const t = setInterval(() => { if (last && last.status !== "running") { clearInterval(t); res(last); } }, 20); });
  return { r, sessions, done };
}
const spec = (agents: string[], extra: Partial<PipelineSpec> = {}): PipelineSpec => ({ task: "Add a greeting", steps: agents.map((agent) => ({ agent })), permissionMode: "plan", maxTurns: 10, stopOnFailure: true, ...extra });

describe("Run pipeline", () => {
  it("runs the steps in order, read-only, each given the previous step's output", async () => {
    const c = fakeClaude();
    const { r, sessions, done } = runner(c.bin);
    r.start(spec(["planner", "coder", "reviewer"]));
    const p = await done();
    expect(p.status).toBe("done");
    expect(c.runs().map((x) => x.agent)).toEqual(["planner", "coder", "reviewer"]);
    expect(c.runs()[0].args).toEqual(expect.arrayContaining(["-p", "--agent", "planner", "--permission-mode", "plan", "--max-turns", "10", "--output-format", "stream-json"]));
    expect(c.runs()[1].prompt).toContain("Output of the previous step (planner):\nRESULT from planner");
    expect(c.runs()[2].prompt).toContain("RESULT from coder");
    expect(p.steps.map((s) => [s.status, s.tokens, s.lastTool])).toEqual([["done", 18, "Read"], ["done", 18, "Read"], ["done", 18, "Read"]]);
    expect(sessions).toEqual(["sess-planner", "sess-coder", "sess-reviewer"]);
  });

  it("runs the step's checks, sends it back with the failure (at most 2 rounds), then goes on", async () => {
    const c = fakeClaude();
    const { r, done } = runner(c.bin, { coder: [false, true] });
    r.start(spec(["coder", "reviewer"]));
    const p = await done();
    expect(p.status).toBe("done");
    expect(c.runs().map((x) => x.agent)).toEqual(["coder", "coder", "reviewer"]);
    expect(c.runs()[1].prompt).toMatch(/Crewglass ran your checks[\s\S]*npm test` failed \(exit code 1\)[\s\S]*1 test failed/);
    expect(p.steps[0]).toMatchObject({ status: "done", tries: 1, checks: [{ label: "npm test", ok: true }] });
  });

  it("stops at a step whose checks keep failing (stop on failure)", async () => {
    const c = fakeClaude();
    const { r, done } = runner(c.bin, { coder: [false] });
    r.start(spec(["coder", "reviewer"]));
    const p = await done();
    expect(p.status).toBe("failed");
    expect(c.runs().map((x) => x.agent)).toEqual(["coder", "coder", "coder"]);
    expect(p.steps.map((s) => s.status)).toEqual(["failed", "waiting"]);
  });

  it("a step that fails stops the pipeline", async () => {
    const c = fakeClaude();
    const { r, done } = runner(c.bin);
    r.start(spec(["broken", "reviewer"]));
    expect((await done()).steps.map((s) => s.status)).toEqual(["failed", "waiting"]);
  });

  it("Stop ends the running step and skips the rest", async () => {
    const c = fakeClaude();
    const { r, done } = runner(c.bin);
    r.start(spec(["slow", "reviewer"]));
    await new Promise((res) => setTimeout(res, 300));
    r.stop();
    const p = await done();
    expect(p.status).toBe("stopped");
    expect(p.steps.map((s) => s.status)).toEqual(["stopped", "waiting"]);
  });

  it("never allows bypassing permissions, and checks every field", () => {
    expect(validSpec({ ...spec(["coder"]), permissionMode: "bypassPermissions" })).toMatch(/read-only or can-edit/);
    expect(validSpec({ ...spec(["../x"]) })).toMatch(/agents/);
    expect(validSpec({ ...spec([]) })).toMatch(/1 to 8/);
    expect(validSpec({ ...spec(["coder"]), task: " " })).toMatch(/task/);
    expect(typeof validSpec(spec(["coder"], { permissionMode: "acceptEdits" }))).toBe("object");
  });
});
