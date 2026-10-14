// The compiled Swift helper talking to the real socket server (needs `npm run build:hook` first; skipped otherwise).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { startHookServer } from "../src/main/live/hookServer";
import { Waiting, type Answer, type HookMsg } from "../src/main/live/liveEngine";
import { tempDir } from "./helpers";

const HELPER = join(__dirname, "..", "out", "bin", "crewglass-hook");

function runHelper(socket: string, event: object): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(HELPER, ["--socket", socket], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.stdin.end(JSON.stringify(event));
  });
}
const directCall = (prompt: string) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/w", tool_name: "Agent", agent_id: "a1", agent_type: "coder",
  tool_input: { subagent_type: "tester", prompt } });

describe.skipIf(!existsSync(HELPER))("hook helper ↔ socket", () => {
  it("forwards only whitelisted fields: the Reason line and the Allowed calls names, never the prompt", async () => {
    const sock = join(tempDir("ad-sock-"), "d.sock");
    const got: HookMsg[] = [];
    const server = startHookServer(sock, (m) => { got.push(m); return {}; });
    await new Promise((r) => server.once("listening", r));
    await runHelper(sock, directCall("Reason: need the integration tests run\nAllowed calls: linter, fmt — to tidy up\nSECRET-WORK-TEXT"));
    server.close();
    expect(got[0].call_reason).toBe("need the integration tests run");
    expect(got[0].allowed_calls).toEqual(["linter", "fmt"]);
    expect(JSON.stringify(got[0])).not.toContain("SECRET-WORK-TEXT");
  });

  it("waits for an answer that takes longer than 300 ms when told to wait (an approval)", async () => {
    const sock = join(tempDir("ad-sock-"), "d.sock");
    const deny: Answer = { print: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } } };
    const server = startHookServer(sock, () => new Waiting(new Promise<Answer>((r) => setTimeout(() => r(deny), 1200)), 5000));
    await new Promise((r) => server.once("listening", r));
    const t0 = Date.now();
    const out = await runHelper(sock, directCall("Reason: need the integration tests run"));
    server.close();
    expect(Date.now() - t0).toBeGreaterThan(1000);
    expect(JSON.parse(out)).toEqual(deny.print);
  });

  it("at a chat's start prints only a notice for you (systemMessage), never anything that would reach Claude", async () => {
    const sock = join(tempDir("ad-sock-"), "d.sock");
    let answer: Answer = { print: { systemMessage: "Crewglass: this chat runs as lead" } };
    const server = startHookServer(sock, () => answer);
    await new Promise((r) => server.once("listening", r));
    const start = { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w", agent_type: "lead", source: "startup" };
    expect(JSON.parse(await runHelper(sock, start))).toEqual({ systemMessage: "Crewglass: this chat runs as lead" });
    answer = { print: { systemMessage: "hi", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "INJECTED" } } };
    expect(await runHelper(sock, start)).toBe("");
    answer = { print: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "INJECTED" } } };
    expect(await runHelper(sock, start)).toBe("");
    answer = { print: { systemMessage: "x".repeat(301) } };
    expect(await runHelper(sock, start)).toBe("");
    server.close();
  });

  it("status line: model · context from Claude Code, plus Crewglass's part — and still the first two when the app is closed", async () => {
    const run = (socket: string) => new Promise<string>((resolve) => {
      const p = spawn(HELPER, ["--socket", socket, "--statusline"], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => resolve(out));
      p.stdin.end(JSON.stringify({ session_id: "s1", cwd: "/w", model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 12.4 } }));
    });
    const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain(await run(join(tempDir("ad-sock-"), "missing.sock")))).toBe("Opus 5.5 · ctx 12%");
    const sock = join(tempDir("ad-sock-"), "d.sock");
    const got: HookMsg[] = [];
    const server = startHookServer(sock, (m) => { got.push(m); return { print: { statusText: "today $1.00/$50.00\nsecond line" } }; });
    await new Promise((r) => server.once("listening", r));
    expect(plain(await run(sock))).toBe("Opus 5.5 · ctx 12% · today $1.00/$50.00 second line");
    server.close();
    expect(got[0]).toMatchObject({ event: "StatusLine", session_id: "s1", cwd: "/w" });
  });

  it("app not running: allows normal events, but a subagent's direct call gets Claude's own prompt", async () => {
    const sock = join(tempDir("ad-sock-"), "missing.sock");
    expect(await runHelper(sock, { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } })).toBe("");
    expect(await runHelper(sock, { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "coder" } })).toBe("");
    expect(JSON.parse(await runHelper(sock, directCall("Reason: x")))).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it("if the app hangs up while you're deciding, the call falls back to Claude's own prompt (never a silent allow)", async () => {
    const sock = join(tempDir("ad-sock-"), "d.sock");
    const server = createServer((c) => c.once("data", () => { c.write('{"wait":true}\n'); setTimeout(() => c.destroy(), 200); }));
    await new Promise<void>((r) => server.listen(sock, r));
    const out = await runHelper(sock, directCall("Reason: need the integration tests run"));
    server.close();
    expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });
});
