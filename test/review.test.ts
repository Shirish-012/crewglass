// Final review fixes: planted temp-file links, Claude Code's own approval/trust records, early transcript lines,
// and the checks time budget.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistant, encode, jsonl, tempDir, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { install, hookCommand } = await import("../src/main/live/hookInstaller");
const { readFolderConfig } = await import("../src/main/sources/configFiles");
const { FolderTranscripts } = await import("../src/main/sources/transcripts");
const { Scope } = await import("../src/main/scope");
const { runCheck } = await import("../src/main/checks/runner");

describe("temp files can't be hijacked", () => {
  it("Live mode never writes through a link planted at a predictable temp name", () => {
    const folder = tempDir("plant-");
    const victim = join(tempDir("victim-"), "important.txt");
    writeFileSync(victim, "keep me");
    write(join(folder, ".claude", "settings.local.json"), "{}\n");
    // Plant links at the names an attacker could guess (the old pid-based name, among others).
    for (const name of [`settings.local.json.crewglass-${process.pid}.tmp`, "settings.local.json.tmp"]) symlinkSync(victim, join(folder, ".claude", name));
    install(folder, hookCommand("/opt/crewglass-hook", "/tmp/d.sock"), tempDir("plant-bk-"));
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readFileSync(join(folder, ".claude", "settings.local.json"), "utf8")).toContain("crewglass-hook");
  });
});

describe("what Claude Code itself recorded", () => {
  it("reads your approvals of project MCP servers and the folder's trust from ~/.claude.json", () => {
    const parent = tempDir("trust-");
    const folder = join(parent, "app");
    write(join(folder, ".mcp.json"), { mcpServers: { a: { command: "x" }, b: { command: "y" }, c: { command: "z" } } });
    write(join(home, ".claude.json"), { projects: { [parent]: { hasTrustDialogAccepted: true }, [folder]: { enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"] } } });
    const cfg = readFolderConfig(folder);
    expect(Object.fromEntries(cfg.mcps.map((m) => [m.name, m.state]))).toEqual({ a: "configured", b: "disabled", c: "needs-approval" });
    expect(cfg.trusted).toBe(true); // trusted through the folder above it
    expect(readFolderConfig(tempDir("untrusted-")).trusted).toBe(false);
  });
});

describe("transcripts", () => {
  it("keeps lines that come before the first one naming the folder (e.g. which agent the session runs as)", async () => {
    const folder = tempDir("early-");
    write(join(home, ".claude", "projects", encode(folder), "s1.jsonl"), jsonl([
      { type: "agent-setting", agentSetting: "lead", sessionId: "s1" },
      { type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content: "hi" } },
      assistant("m1", { cwd: folder }),
    ]));
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    expect(t.sessions.get("s1")?.agentSetting).toBe("lead");
  });
});

describe("checks time budget", () => {
  it("doesn't start a check once the agent's budget is used up", async () => {
    const dir = tempDir("budget-");
    const abort = new AbortController();
    abort.abort();
    const r = await runCheck({ key: "k", label: "t", command: `${process.execPath} -e "require('fs').writeFileSync('ran','1')"` }, dir, abort.signal);
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(existsSync(join(dir, "ran"))).toBe(false);
  });
});
