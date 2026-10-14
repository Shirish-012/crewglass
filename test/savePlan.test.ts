import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Link, McpServer } from "@shared/types";
import type { DesignPayload } from "@shared/ipc";
import { tempDir, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { planSave, applySave, undoLastSave, guardPath } = await import("../src/main/writers/savePlan");
const { parseTeamMap, renderTeamMap } = await import("@shared/teamMap");
const { parse: parseYaml } = await import("yaml");

const base = { toolAccess: "inherit" as const, builtinTools: ["Read", "Edit"], keepPrivate: false, checks: [], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [] };
const agent = (name: string, extra: Partial<Agent> = {}): Agent => ({
  ...base, key: `project:.claude/agents/${name}.md`, name, kind: "subagent", scope: "project", file: `.claude/agents/${name}.md`,
  role: `Use for ${name}.`, instructions: `You are ${name}.`, model: "sonnet", effort: "medium", maxTurns: 20, ...extra,
});
const design = (agents: Agent[], extra: Partial<DesignPayload> = {}): DesignPayload => ({
  agents, mcps: [], links: [], orchestratorKey: null, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [], ...extra,
});
const ok = () => ({ ok: true });
function setup() {
  const folder = tempDir("crewglass-save-");
  return { folder, backups: tempDir("crewglass-bk-"), file: (rel: string) => join(folder, rel), read: (rel: string) => readFileSync(join(folder, rel), "utf8") };
}

describe("save plan", () => {
  it("creates new agent files, with tools derived from the links you drew", () => {
    const { folder, backups, read } = setup();
    const coder = agent("coder", { toolAccess: "connected" });
    const tester = agent("tester");
    const gh: McpServer = { key: "mcp:github", name: "github", scope: "project", type: "stdio", state: "configured", calls: 0 };
    const links: Link[] = [
      { id: "1", from: coder.key, to: "mcp:github", kind: "uses", planned: true },
      { id: "2", from: coder.key, to: tester.key, kind: "direct", planned: true, directState: "allowed" },
    ];
    const plan = planSave(folder, design([coder, tester], { mcps: [gh], links }));
    expect(plan.files.map((f) => f.display).sort()).toEqual([".claude/agents/coder.md", ".claude/agents/tester.md", ".claude/commands/workflow.md", ".claude/rules/crewglass-team.md", ".mcp.json"].sort());
    expect(applySave(plan.id, false, backups, ok).ok).toBe(true);
    expect(read(".claude/agents/coder.md")).toContain("tools: Read, Edit, Agent, mcp__github__*");
    const map = parseTeamMap(read(".claude/rules/crewglass-team.md"))!;
    expect(map.links).toContainEqual({ from: "coder", to: "tester", kind: "direct", directState: "allowed" });
  });

  it("edits existing agent files in place, keeping unknown fields and comments", () => {
    const { folder, backups, file, read } = setup();
    write(file(".claude/agents/reviewer.md"), "---\n# my note\nname: reviewer\ndescription: Reviews code.\nmodel: sonnet\neffort: high\ncolor: purple\nisolation: worktree\n---\n\nReview it carefully.\n");
    const r = agent("reviewer", { role: "Reviews code.", effort: "xhigh", instructions: "Review it carefully.", maxTurns: undefined });
    const plan = planSave(folder, design([r]));
    applySave(plan.id, false, backups, ok);
    const text = read(".claude/agents/reviewer.md");
    expect(text).toContain("# my note");
    expect(text).toContain("color: purple");
    expect(text).toContain("isolation: worktree");
    expect(text).toContain("effort: xhigh");
    expect(text).toContain("\nReview it carefully.\n");
  });

  it("sets the orchestrator and disabled agents in settings.local.json, keeping Live mode hooks and other rules", () => {
    const { folder, backups, file, read } = setup();
    write(file(".claude/settings.local.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "x crewglass-hook" }] }] }, permissions: { deny: ["Bash(rm:*)"] } });
    const lead = agent("lead", { kind: "orchestrator" });
    const old = agent("old", { disabled: true });
    applySave(planSave(folder, design([lead, old], { orchestratorKey: lead.key })).id, false, backups, ok);
    const s = JSON.parse(read(".claude/settings.local.json"));
    expect(s.agent).toBe("lead");
    expect(s.permissions.deny).toEqual(["Bash(rm:*)", "Agent(old)"]);
    expect(s.hooks.Stop[0].hooks[0].command).toContain("crewglass-hook");
    // Re-enabling removes only our rule; pausing the orchestrator removes the setting.
    applySave(planSave(folder, design([lead, agent("old")], { orchestratorKey: lead.key, orchestratorPaused: true })).id, false, backups, ok);
    const s2 = JSON.parse(read(".claude/settings.local.json"));
    expect(s2.permissions.deny).toEqual(["Bash(rm:*)"]);
    expect(s2.agent).toBeUndefined();
  });

  it("writes a team map led by your chat when there's no orchestrator agent (and no agent setting)", () => {
    const { folder, backups, read } = setup();
    const coder = agent("coder"), reviewer = agent("reviewer");
    const links: Link[] = [
      { id: "1", from: "chat:main", to: coder.key, kind: "delegates", planned: true },
      { id: "2", from: "chat:main", to: reviewer.key, kind: "delegates", planned: true },
    ];
    applySave(planSave(folder, design([coder, reviewer], { links })).id, false, backups, ok);
    const text = read(".claude/rules/crewglass-team.md");
    expect(text).toContain("Orchestrator: **your Claude Code chat**");
    expect(text).toContain("Your Claude Code chat hands work to: coder, reviewer.");
    expect(text).toContain("When you handed work to agents, end with a short report");
    expect(parseTeamMap(text)).toMatchObject({ orchestrator: null, links: [{ from: "@chat", to: "coder", kind: "delegates" }, { from: "@chat", to: "reviewer", kind: "delegates" }] });
    expect(existsSync(join(folder, ".claude", "settings.local.json"))).toBe(false); // no orchestrator setting to write
  });

  it("starts orchestrator chats at its effort (Claude Code ignores an agent file's effort for the main chat)", () => {
    const { folder, backups, read } = setup();
    const settings = () => JSON.parse(read(".claude/settings.local.json"));
    const lead = agent("lead", { kind: "orchestrator", model: "opus", effort: "high" });
    applySave(planSave(folder, design([lead], { orchestratorKey: lead.key })).id, false, backups, ok);
    expect(settings()).toMatchObject({ agent: "lead", effortLevel: "high" });
    // max can't be a starting effort (Claude Code ignores it there): chats start at xhigh, and Review says why.
    const maxLead = { ...lead, effort: "max" as const };
    const plan = planSave(folder, design([maxLead], { orchestratorKey: lead.key }));
    expect(plan.warnings.join(" ")).toContain("can't start a chat at max effort");
    applySave(plan.id, false, backups, ok);
    expect(settings().effortLevel).toBe("xhigh");
    // Pausing the orchestrator takes its effort away with it.
    applySave(planSave(folder, design([maxLead], { orchestratorKey: lead.key, orchestratorPaused: true })).id, false, backups, ok);
    expect(settings().agent).toBeUndefined();
    expect(settings().effortLevel).toBeUndefined();
    // Haiku has no effort, so nothing is set; a folder without an orchestrator keeps your own effortLevel.
    const two = setup();
    write(two.file(".claude/settings.local.json"), { effortLevel: "low" });
    applySave(planSave(two.folder, design([agent("coder")])).id, false, two.backups, ok);
    expect(JSON.parse(two.read(".claude/settings.local.json")).effortLevel).toBe("low");
    const quick = agent("lead", { kind: "orchestrator", model: "haiku", effort: "low" });
    const three = setup();
    applySave(planSave(three.folder, design([quick], { orchestratorKey: quick.key })).id, false, three.backups, ok);
    expect(JSON.parse(three.read(".claude/settings.local.json")).effortLevel).toBeUndefined();
  });

  it("blocks saving a key into a file shared through git", () => {
    const { folder, backups } = setup();
    const plan = planSave(folder, design([agent("coder", { instructions: "token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" })]));
    expect(plan.blocked).toBe(true);
    expect(applySave(plan.id, false, backups, ok).ok).toBe(false);
    // The same text in a private agent isn't shared, so it isn't blocked.
    expect(planSave(folder, design([agent("coder", { keepPrivate: true, instructions: "token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" })])).blocked).toBe(false);
  });

  it("needs your confirmation for all-projects agents (~/.claude/agents)", () => {
    const { folder, backups } = setup();
    const u = agent("helper", { scope: "user", key: "user:~/.claude/agents/helper.md", file: "~/.claude/agents/helper.md" });
    const plan = planSave(folder, design([u]));
    expect(plan.needsUserConfirm).toBe(true);
    expect(applySave(plan.id, false, backups, ok).ok).toBe(false);
    expect(applySave(plan.id, true, backups, ok).ok).toBe(true);
    expect(existsSync(join(home, ".claude", "agents", "helper.md"))).toBe(true);
  });

  it("refuses if a file changed after you reviewed it", () => {
    const { folder, backups, file } = setup();
    const plan = planSave(folder, design([agent("coder")]));
    write(file(".claude/agents/coder.md"), "---\nname: coder\n---\nsomeone else wrote this\n");
    expect(applySave(plan.id, false, backups, ok)).toMatchObject({ ok: false });
  });

  it("deletes an agent file with a backup, and Undo last save brings it back", () => {
    const { folder, backups, file, read } = setup();
    write(file(".claude/agents/temp.md"), "---\nname: temp\ndescription: x\n---\nhello\n");
    applySave(planSave(folder, design([], { deletedKeys: ["project:.claude/agents/temp.md"] })).id, false, backups, ok);
    expect(existsSync(file(".claude/agents/temp.md"))).toBe(false);
    expect(undoLastSave(folder, backups).ok).toBe(true);
    expect(read(".claude/agents/temp.md")).toContain("hello");
  });

  it("writes project MCP servers with ${VAR} references and private ones through the official CLI", () => {
    const { folder, backups, read } = setup();
    const ran: string[][] = [];
    const proj: McpServer = { key: "mcp:linear", name: "linear", scope: "project", type: "stdio", state: "configured", calls: 0, command: "npx -y linear-mcp", envNames: ["LINEAR_API_KEY"] };
    const loc: McpServer = { key: "mcp:pg", name: "pg", scope: "local", type: "stdio", state: "configured", calls: 0, command: "pg-mcp --ro", envNames: ["DATABASE_URL"] };
    const plan = planSave(folder, design([], { mcps: [proj, loc] }));
    applySave(plan.id, false, backups, (argv) => { ran.push(argv); return { ok: true }; });
    expect(JSON.parse(read(".mcp.json")).mcpServers.linear).toEqual({ type: "stdio", command: "npx", args: ["-y", "linear-mcp"], env: { LINEAR_API_KEY: "${LINEAR_API_KEY}" } });
    expect(ran).toEqual([["mcp", "add", "--scope", "local", "-e", "DATABASE_URL=${DATABASE_URL}", "pg", "--", "pg-mcp", "--ro"]]);
  });

  it("only ever writes allowed paths, never through links", () => {
    const { folder } = setup();
    expect(() => guardPath(folder, join(folder, "src", "index.ts"))).toThrow();
    expect(() => guardPath(folder, "/etc/hosts")).toThrow();
    expect(() => guardPath(folder, join(folder, ".claude", "agents", "..", "..", "x.md"))).toThrow();
    const other = tempDir("crewglass-other-");
    mkdirSync(join(folder, ".claude"));
    symlinkSync(other, join(folder, ".claude", "agents"));
    expect(() => guardPath(folder, join(folder, ".claude", "agents", "evil.md"))).toThrow(/link/);
    writeFileSync(join(other, "keep.txt"), "untouched");
  });

  it("writes any role text as valid YAML — a colon or a line break can't break the file or add a field", () => {
    const { folder, backups, read } = setup();
    const a = agent("reviewer", { role: "Use when: reviewing code\npermissionMode: bypassPermissions" });
    applySave(planSave(folder, design([a])).id, false, backups, ok);
    const fm = parseYaml(read(".claude/agents/reviewer.md").split("---")[1]) as Record<string, unknown>;
    expect(fm.description).toBe("Use when: reviewing code\npermissionMode: bypassPermissions");
    expect(fm.permissionMode).toBeUndefined();
  });

  it("refuses MCP names and addresses that could be read as options by the claude command", () => {
    const { folder } = setup();
    const m = (extra: Partial<McpServer>): McpServer => ({ key: "mcp:x", name: "x", scope: "local", type: "stdio", state: "configured", calls: 0, command: "srv", ...extra });
    expect(() => planSave(folder, design([], { mcps: [m({ name: "--scope" })] }))).toThrow(/valid MCP server name/);
    expect(() => planSave(folder, design([], { mcps: [m({ url: "-e X=1", command: undefined })] }))).toThrow(/http/);
    expect(() => planSave(folder, design([], { mcps: [m({ envNames: ["A=B"] })] }))).toThrow(/variable name/);
    expect(() => planSave(folder, design([], { mcps: [m({ command: "srv\nrm -rf ~" })] }))).toThrow(/one line/);
    // An existing server you didn't touch never blocks a save, whatever its name.
    expect(() => planSave(folder, design([], { mcps: [m({ name: "odd.name", command: undefined })] }))).not.toThrow();
  });

  it("removes a project MCP server from .mcp.json only, and a private one through the CLI", () => {
    const { folder, backups, file, read } = setup();
    write(file(".mcp.json"), { mcpServers: { linear: { type: "stdio", command: "linear-mcp" } } });
    const ran: string[][] = [];
    const plan = planSave(folder, design([], { removedMcpKeys: ["mcp:linear", "mcp:pg"], removedMcpScopes: { "mcp:linear": "project", "mcp:pg": "local" } }));
    applySave(plan.id, false, backups, (argv) => { ran.push(argv); return { ok: true }; });
    expect(JSON.parse(read(".mcp.json")).mcpServers).toEqual({});
    expect(ran).toEqual([["mcp", "remove", "--scope", "local", "pg"]]);
  });

  it("never follows a file planted at a temp name, and leaves no temp files behind", () => {
    const { folder, backups, file } = setup();
    applySave(planSave(folder, design([agent("coder")])).id, false, backups, ok);
    expect(readdirSync(file(".claude/agents")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("keeps the team map's link data readable even if a label contains -->", () => {
    const a = agent("coder");
    const text = renderTeamMap({ agents: [a, agent("tester")], checks: {}, orchestrator: null,
      links: [{ id: "1", from: a.key, to: "project:.claude/agents/tester.md", kind: "checkedBy", planned: true, check: { label: "tests --> pass", kind: "command" } as never }] });
    expect(parseTeamMap(text)?.links[0]).toMatchObject({ from: "coder", to: "tester", check: "tests --> pass" });
  });

  it("keeps an agent private through .git/info/exclude, and turning it off removes only Crewglass's lines", () => {
    const { folder, backups, file, read } = setup();
    mkdirSync(file(".git/info"), { recursive: true });
    writeFileSync(file(".git/info/exclude"), "# my own rule\n*.log\n");
    applySave(planSave(folder, design([agent("coder", { keepPrivate: true }), agent("tester", { keepPrivate: true })])).id, false, backups, ok);
    expect(read(".git/info/exclude")).toBe("# my own rule\n*.log\n# Crewglass: kept private\n/.claude/agents/coder.md\n# Crewglass: kept private\n/.claude/agents/tester.md\n");
    applySave(planSave(folder, design([agent("coder", { keepPrivate: false }), agent("tester", { keepPrivate: true })])).id, false, backups, ok);
    expect(read(".git/info/exclude")).toBe("# my own rule\n*.log\n# Crewglass: kept private\n/.claude/agents/tester.md\n");
  });

  it("reads an agent file whose header isn't strict YAML (as Claude Code does), and saving rewrites it properly", async () => {
    const { folder, backups, file, read } = setup();
    write(file(".claude/agents/lead.md"), "---\nname: lead\ndescription: Orchestrator: plans, delegates and verifies.\nmodel: haiku\nmaxTurns: 8\n---\n\nYou lead.\n");
    const { readAgentFiles } = await import("../src/main/sources/agentFiles");
    const a = readAgentFiles(folder).project[0].agent;
    expect(a).toMatchObject({ name: "lead", role: "Orchestrator: plans, delegates and verifies.", model: "haiku", maxTurns: 8, lenientHeader: true });
    applySave(planSave(folder, design([{ ...a, effort: undefined, maxTurns: 10 }])).id, false, backups, ok);
    const fm = parseYaml(read(".claude/agents/lead.md").split("---")[1]) as Record<string, unknown>;
    expect(fm).toMatchObject({ name: "lead", description: "Orchestrator: plans, delegates and verifies.", model: "haiku", maxTurns: 10 });
  });
});

describe("files saved under the old name (Agent Deck)", () => {
  it("the old team map is read, then replaced by the new one on Save (never two maps)", () => {
    const { folder, backups, file, read } = setup();
    const coder = agent("coder");
    write(file(".claude/agents/coder.md"), "---\nname: coder\ndescription: Use for coder.\nmodel: sonnet\n---\n\nYou are coder.\n");
    write(file(".claude/rules/agent-deck-team.md"), '# Agent Deck team map\n<!-- agent-deck:team {"version":1,"orchestrator":null,"links":[{"from":"@chat","to":"coder","kind":"delegates"}]} -->\n');
    expect(parseTeamMap(read(".claude/rules/agent-deck-team.md"))!.links).toHaveLength(1);
    const links: Link[] = [{ id: "1", from: "chat:main", to: coder.key, kind: "delegates", planned: true }];
    const plan = planSave(folder, design([coder], { links }));
    expect(applySave(plan.id, false, backups, ok).ok).toBe(true);
    expect(existsSync(file(".claude/rules/agent-deck-team.md"))).toBe(false);
    expect(parseTeamMap(read(".claude/rules/crewglass-team.md"))!.links).toHaveLength(1);
  });
});

