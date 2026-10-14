import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, write } from "./helpers";

const home = tempDir();
const claude = join(home, ".claude");
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = claude;
const { readSessions } = await import("../src/main/sources/claudeSessions");
const { readFolderConfig } = await import("../src/main/sources/configFiles");
const { readAgentFiles } = await import("../src/main/sources/agentFiles");
const { openWorkspaceFolders } = await import("../src/main/sources/ideLocks");
const { Scope } = await import("../src/main/scope");

const work = tempDir();
const folder = join(work, "agent app");
const other = join(work, "other project");
mkdirSync(join(folder, "src"), { recursive: true });
mkdirSync(other, { recursive: true });
const alive = process.pid; // this test process is certainly alive
const dead = 999_999;
const session = (pid: number, cwd: string, extra: object = {}) => ({ pid, sessionId: `s${pid}`, cwd, kind: "interactive", entrypoint: "claude-vscode", status: "busy", name: `n${pid}`, version: "2.1.281", ...extra });

describe("session rules (plan §3.1)", () => {
  write(join(claude, "sessions", "a.json"), session(alive, folder));
  write(join(claude, "sessions", "b.json"), { ...session(alive, join(folder, "src")), sessionId: "sub", entrypoint: "cli" });
  write(join(claude, "sessions", "c.json"), { ...session(alive, other), sessionId: "elsewhere" });
  write(join(claude, "sessions", "d.json"), { ...session(dead, folder), sessionId: "dead" });
  write(join(claude, "sessions", "e.json"), { ...session(alive, folder), sessionId: "sdk-app", kind: "sdk", entrypoint: "sdk-ts" });
  write(join(claude, "sessions", "f.json"), { ...session(alive, folder), sessionId: "mate", kind: "teammate", entrypoint: "cli" });
  write(join(claude, "sessions", "a.secret.key"), "not-json-and-never-read");

  it("keeps VS Code, terminal and teammate sessions in the folder or a subfolder", () => {
    const ids = readSessions(new Scope(folder)).included.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["mate", `s${alive}`, "sub"]);
  });
  it("drops other folders, dead processes and other Agent SDK apps", () => {
    const ids = readSessions(new Scope(folder)).included.map((s) => s.sessionId);
    expect(ids).not.toContain("elsewhere");
    expect(ids).not.toContain("dead");
    expect(ids).not.toContain("sdk-app");
  });
  it("records the subfolder", () => {
    expect(readSessions(new Scope(folder)).included.find((s) => s.sessionId === "sub")?.subfolder).toBe("src");
  });
  it("never reports anything about sessions in other folders", () => {
    const r = readSessions(new Scope(other));
    expect(r.included.map((s) => s.sessionId)).toEqual(["elsewhere"]);
  });
});

describe("IDE lock files", () => {
  it("uses only workspaceFolders, never the auth token", () => {
    write(join(claude, "ide", "1.lock"), { pid: 1, workspaceFolders: [folder], authToken: "SECRET-TOKEN" });
    const out = openWorkspaceFolders();
    expect(out).toEqual([folder]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

describe("config files", () => {
  write(join(folder, ".mcp.json"), { mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: "ghp_realsecretvalue" } }, docs: { type: "http", url: "https://x" } } });
  write(join(home, ".claude.json"), {
    oauthAccount: { emailAddress: "someone@example.com" },
    mcpServers: { postgres: { command: "pg" } },
    projects: { [folder]: { mcpServers: { local1: { command: "x" } } }, [other]: { mcpServers: { notmine: {} } } },
  });
  write(join(folder, ".claude", "settings.local.json"), { agent: "lead", enabledMcpjsonServers: ["github"], permissions: { deny: ["Agent(old-helper)", "Bash(rm:*)"] } });

  it("lists MCP servers by scope, keeping secret NAMES only", () => {
    const c = readFolderConfig(folder);
    const byName = Object.fromEntries(c.mcps.map((m) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(["docs", "github", "local1", "postgres"]);
    expect(byName.github.scope).toBe("project");
    expect(byName.github.envNames).toEqual(["GITHUB_TOKEN"]);
    expect(byName.local1.scope).toBe("local");
    expect(byName.postgres.scope).toBe("user");
    expect(JSON.stringify(c)).not.toContain("ghp_realsecretvalue");
    expect(JSON.stringify(c)).not.toContain("someone@example.com");
    expect(JSON.stringify(c)).not.toContain("notmine");
  });
  it("knows which project servers still need approval", () => {
    const c = readFolderConfig(folder);
    expect(c.mcps.find((m) => m.name === "github")?.state).toBe("configured");
    expect(c.mcps.find((m) => m.name === "docs")?.state).toBe("needs-approval");
  });
  it("reads the orchestrator setting and disabled agents", () => {
    const c = readFolderConfig(folder);
    expect(c.agentSetting).toBe("lead");
    expect(c.deniedAgents).toEqual(["old-helper"]);
  });
});

describe("agent files", () => {
  write(join(folder, ".claude", "agents", "a-reviewer.md"), "---\nname: reviewer\ndescription: Project reviewer\nmodel: sonnet\neffort: high\ntools: Read, Grep, mcp__github__*\n---\nReview it.\n");
  write(join(folder, ".claude", "agents", "b-reviewer.md"), "---\nname: reviewer\ndescription: Second copy\nmodel: haiku\n---\nx\n");
  write(join(folder, ".claude", "agents", "gem.md"), "---\nname: gemini-reviewer\ndescription: relay\nmodel: haiku\ntools: mcp__agy__ask_agy\n---\nForward.\n");
  write(join(folder, ".claude", "agents", "bad.md"), "---\nname: ../../etc/evil\n---\nx\n");
  write(join(claude, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: User-level\nmodel: opus\n---\nx\n");

  it("parses fields and keeps same-name agents apart, marking which one Claude uses", () => {
    const { project, user } = readAgentFiles(folder);
    const [first, second] = project.filter((f) => f.agent.name === "reviewer");
    expect(first.agent.effort).toBe("high");
    expect(first.agent.toolAccess).toBe("connected");
    expect(first.agent.builtinTools).toEqual(["Read", "Grep"]);
    expect(first.agent.sameName?.usedByClaude).toBe(true);   // first file alphabetically wins in a folder
    expect(second.agent.sameName?.usedByClaude).toBe(false);
    expect(user[0].agent.sameName?.usedByClaude).toBe(false); // the project version beats the user one
  });
  it("recognises agy relay agents and rejects unsafe names", () => {
    const { project } = readAgentFiles(folder);
    expect(project.find((f) => f.agent.name === "gemini-reviewer")?.agent.kind).toBe("agy");
    expect(project.some((f) => f.agent.name.includes(".."))).toBe(false);
  });
});
