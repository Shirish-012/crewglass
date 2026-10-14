// The plan items finished at the end: stuck / loop / MCP-died / +25% warnings, checks on hand-off links,
// 90-day history, same-name rename, redo, and finding tools in the usual places.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistant, encode, jsonl, tempDir, toolResult, toolUse, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { FolderTranscripts } = await import("../src/main/sources/transcripts");
const { Scope } = await import("../src/main/scope");
const { Alerts } = await import("../src/main/alerts");
const { LiveEngine, Waiting } = await import("../src/main/live/liveEngine");
const { planChecks, checksFor } = await import("../src/main/folderData");
const { saveHistory, readHistory, mergeHistory } = await import("../src/main/history");
const { findTool } = await import("../src/main/tools");
const { cleanSettingsPatch } = await import("../src/main/settings");

const errResult = (id: string, text: string) => ({ type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });

async function transcriptsWith(lines: object[]) {
  const folder = tempDir("feat-");
  write(join(home, ".claude", "projects", encode(folder), "s1.jsonl"), jsonl([{ type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content: "go" } }, ...lines]));
  const t = new FolderTranscripts(new Scope(folder));
  await t.poll();
  return t;
}

describe("warnings read from transcripts", () => {
  it("Claude may be stuck: 5 failed tool calls within 10 minutes", async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) lines.push(assistant(`m${i}`, { tools: [toolUse(`t${i}`, "Read", { file_path: `/x${i}` })] }), toolResult(`t${i}`, true));
    const t = await transcriptsWith(lines);
    expect(t.stuckSessions()).toEqual([{ session: "s1", count: 5, since: expect.any(Number) }]);
  });
  it("subagent loop: the same agent given an IDENTICAL task 3 times in one turn (different tasks don't count)", async () => {
    const same = (i: number) => assistant(`a${i}`, { tools: [toolUse(`g${i}`, "Agent", { subagent_type: "coder", prompt: "fix the login bug" })] });
    const t = await transcriptsWith([same(1), same(2), assistant("b", { tools: [toolUse("h", "Agent", { subagent_type: "coder", prompt: "a different task" })] }), same(3)]);
    expect(t.subagentLoops()).toEqual([{ session: "s1", agent: "coder", count: 3, turnStartedAt: expect.any(Number) }]);
    expect(JSON.stringify(t.subagentLoops())).not.toContain("login"); // only a hash was compared
  });
  it("an MCP server whose calls fail with 'connection closed' is down until a call succeeds again", async () => {
    const t = await transcriptsWith([assistant("m1", { tools: [toolUse("x1", "mcp__github__get_issue", { n: 1 })] }), errResult("x1", "MCP error -32000: Connection closed")]);
    expect([...t.mcpDown.keys()]).toEqual(["github"]);
    const ok = await transcriptsWith([assistant("m1", { tools: [toolUse("x1", "mcp__github__get_issue", {})] }), errResult("x1", "Issue not found")]);
    expect(ok.mcpDown.size).toBe(0); // an ordinary tool error isn't a dead server
  });

  it("alerts: stuck and loop cards offer choices only with Live mode; MCP-died; limits every +25% after 100%", () => {
    const a = new Alerts();
    const base = { folderName: "app", sessions: [{ id: "s1", name: "main", status: "busy", usd: 26, contextPct: 10 }], todayUsd: 0, limits: { session: 20, day: 1e9 }, failStreaks: [] };
    a.evaluate({ ...base, liveOn: true, stuck: [{ session: "s1", count: 6 }], loops: [{ session: "s1", agent: "coder", count: 3, turnStartedAt: 1 }], mcpDown: [{ server: "github", at: 1 }] }, () => {});
    const byTitle = (re: RegExp) => a.items.find((i) => re.test(i.title));
    expect(byTitle(/may be stuck/)).toMatchObject({ kind: "stuck", popup: false, data: { session: "s1", live: true } });
    expect(byTitle(/same task 3 times/)).toMatchObject({ kind: "stuck", data: { loop: true, agent: "coder" } });
    expect(byTitle(/github MCP server stopped/)).toMatchObject({ kind: "mcp-died", popup: false });
    expect(a.items.filter((i) => i.kind === "limit").map((i) => i.title)).toEqual(expect.arrayContaining([
      "This session reached its limit", "This session is at 125% of its limit",
    ]));
    expect(a.items.some((i) => /150%/.test(i.title))).toBe(false);
    a.evaluate({ ...base, liveOn: false, stuck: [{ session: "s1", count: 7 }] }, () => {});
    expect(a.items.filter((i) => /may be stuck/.test(i.title))).toHaveLength(1); // not repeated while still stuck
  });
});

describe("checks on a hand-off link", () => {
  const agent = (name: string, checks: string[] = []) => ({ key: `project:.claude/agents/${name}.md`, name, kind: "subagent", checks }) as never;
  it("are saved by agent names and run for the receiving agent only when that caller handed it the work", () => {
    const design = { agents: [agent("lead"), agent("coder")], mcps: [], orchestratorKey: null, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [],
      links: [{ id: "1", from: "project:.claude/agents/lead.md", to: "project:.claude/agents/coder.md", kind: "delegates", planned: true, checks: ["npm-test"] }] } as never;
    const p = planChecks({ checks: {}, commands: {}, confirmed: [], linkChecks: {} }, design);
    expect(p.next.linkChecks).toEqual({ "lead>coder": ["npm-test"] });
    expect(p.checks[0]).toMatchObject({ agent: "coder (when lead hands it work)", command: "npm test", isNew: true });
    expect(checksFor(p.next, "coder", "lead").map((c) => c.command)).toEqual(["npm test"]);
    expect(checksFor(p.next, "coder", "tester")).toEqual([]);
    expect(checksFor(p.next, "coder")).toEqual([]);
  });
  it("Live mode knows who handed the work over (the orchestrator the main session runs as)", async () => {
    const asked: [string, string | undefined][] = [];
    const e = new LiveEngine(() => {}, () => "app", () => true, {}, () => null, {
      checksFor: (name, caller) => { asked.push([name, caller]); return [{ key: "t", label: "npm test", command: "npm test" }]; },
      run: async (d) => ({ key: d.key, label: d.label, ok: true, exitCode: 0, timedOut: false, ms: 1, tail: "" }),
    });
    const ev = (event: string, extra: object = {}) => ({ event, session_id: "s1", cwd: "/w", ...extra });
    e.handle(ev("PreToolUse", { tool_name: "Agent", agent_type: "lead", subagent_type: "coder" }));
    e.handle(ev("SubagentStart", { agent_id: "c1", agent_type: "coder" }));
    e.handle(ev("PostToolUse", { tool_name: "Edit", agent_id: "c1", agent_type: "coder" }));
    const a = e.handle(ev("SubagentStop", { agent_id: "c1", agent_type: "coder" }));
    expect(a).toBeInstanceOf(Waiting);
    await (a as InstanceType<typeof Waiting>).answer;
    expect(asked).toEqual([["coder", "lead"]]);
  });
  it("a hand-off from your chat (no orchestrator agent) is saved as @chat, and Live mode knows the chat handed the work over", async () => {
    const design = { agents: [agent("coder")], mcps: [], orchestratorKey: null, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [],
      links: [{ id: "1", from: "chat:main", to: "project:.claude/agents/coder.md", kind: "delegates", planned: true, checks: ["npm-test"] }] } as never;
    const p = planChecks({ checks: {}, commands: {}, confirmed: [], linkChecks: {} }, design);
    expect(p.next.linkChecks).toEqual({ "@chat>coder": ["npm-test"] });
    expect(p.checks[0]).toMatchObject({ agent: "coder (when your chat hands it work)" });
    const asked: [string, string | undefined][] = [];
    const e = new LiveEngine(() => {}, () => "app", () => true, {}, () => null, {
      checksFor: (name, caller) => { asked.push([name, caller]); return []; },
      run: async (d) => ({ key: d.key, label: d.label, ok: true, exitCode: 0, timedOut: false, ms: 1, tail: "" }),
    });
    const ev = (event: string, extra: object = {}) => ({ event, session_id: "s1", cwd: "/w", ...extra });
    e.handle(ev("PreToolUse", { tool_name: "Agent", subagent_type: "coder" })); // a plain chat: no agent_type
    e.handle(ev("SubagentStart", { agent_id: "c1", agent_type: "coder" }));
    e.handle(ev("PostToolUse", { tool_name: "Edit", agent_id: "c1", agent_type: "coder" }));
    e.handle(ev("SubagentStop", { agent_id: "c1", agent_type: "coder" }));
    expect(asked).toEqual([["coder", "@chat"]]);
  });
});

describe("usage history beyond 30 days", () => {
  const row = (id: string, daysAgo: number) => ({ id, startedAt: Date.now() - daysAgo * 864e5, lastAt: Date.now() - daysAgo * 864e5 + 60_000, source: "vscode" as const,
    durationMin: 1, tokens: 1000, agents: ["coder"], mcps: [], failures: 0, models: ["Opus 5.5"] });
  it("keeps each session's numbers for the days you choose, and live rows win", () => {
    const ud = tempDir("hist-");
    saveHistory(ud, "/work/app", [row("old", 200), row("a", 40), row("b", 1)], 90);
    expect(readHistory(ud, "/work/app").map((r) => r.id).sort()).toEqual(["a", "b"]); // 200 days is past 90
    const merged = mergeHistory(readHistory(ud, "/work/app"), [{ ...row("b", 1), tokens: 5000 }], 90, () => "label");
    expect(merged.map((r) => [r.id, r.tokens])).toEqual([["b", 5000], ["a", 1000]]);
    expect(mergeHistory(readHistory(ud, "/work/app"), [], 30, () => "l").map((r) => r.id)).toEqual(["b"]);
  });
  it("only accepts 30–365 days", () => {
    expect(cleanSettingsPatch({ historyDays: 10 })).toEqual({});
    expect(cleanSettingsPatch({ historyDays: 180 })).toEqual({ historyDays: 180 });
  });
});

describe("finding tools", () => {
  it("looks in the usual places, including a version manager's newest install", () => {
    const bin = join(home, ".nvm", "versions", "node", "v24.2.0", "bin");
    const older = join(home, ".nvm", "versions", "node", "v22.9.0", "bin");
    for (const d of [bin, older]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "claude"), "#!/bin/sh\n"); chmodSync(join(d, "claude"), 0o755); }
    const found = findTool("claude");
    // A real install in ~/.local/bin or Homebrew wins; otherwise the newest nvm one.
    if (!found?.startsWith("/opt/homebrew") && !found?.startsWith("/usr/local")) expect(found).toBe(join(bin, "claude"));
  });
});

describe("which agent a chat runs as", async () => {
  const { chatNotice } = await import("../src/main/live/chatNotice");
  const { chatStartEffort, runDiffers } = await import("@shared/models");
  const team = { version: 1 as const, orchestrator: "lead", links: [
    { from: "lead", to: "planner", kind: "delegates" as const }, { from: "lead", to: "coder", kind: "delegates" as const },
    { from: "coder", to: "tester", kind: "direct" as const, directState: "allowed" as const }] };

  it("names the agent, what new chats start on, and who it hands work to", () => {
    expect(chatNotice({ agentType: "lead", agent: { model: "opus" }, startEffort: "high", team }))
      .toBe("Crewglass: this chat runs as lead · starts on Opus 5.5 · high · hands work to planner, coder");
    // No effort set for the folder: the model only (your own effort applies).
    expect(chatNotice({ agentType: "lead", agent: { model: "claude-sonnet-5" }, startEffort: null, team: null }))
      .toBe("Crewglass: this chat runs as lead · starts on Sonnet 5");
  });

  it("says when the chat itself leads the team, and says nothing in a folder without a team", () => {
    const chatTeam = { version: 1 as const, orchestrator: null, links: [{ from: "@chat", to: "coder", kind: "delegates" as const }, { from: "@chat", to: "reviewer", kind: "delegates" as const }] };
    expect(chatNotice({ agentType: undefined, agent: null, startEffort: null, team: chatTeam }))
      .toBe("Crewglass: this chat leads your team · hands work to coder, reviewer · /workflow <task> runs the full team steps");
    // An older team map that still names a former orchestrator: its hand-offs are the chat's now.
    expect(chatNotice({ agentType: undefined, agent: null, startEffort: null, team })).toContain("hands work to planner, coder");
    expect(chatNotice({ agentType: undefined, agent: null, startEffort: null, team: null })).toBeNull();
  });

  it("keeps names from the folder's files plain and the line short (the helper refuses anything over 300 characters)", () => {
    const long = { ...team, links: Array.from({ length: 20 }, (_, i) => ({ from: "lead", to: `agent-${"x".repeat(60)}-${i}`, kind: "delegates" as const })) };
    const note = chatNotice({ agentType: "lead\u001b[31m<b>", agent: { model: "weird\nmodel" }, startEffort: null, team: long })!;
    expect(note.length).toBeLessThanOrEqual(280);
    expect(note).not.toMatch(/[\u0000-\u001f<>]/);
  });

  it("works out the starting effort and spots a chat on a different model or effort", () => {
    expect(chatStartEffort("opus", "max")).toBe("xhigh");
    expect(chatStartEffort("opus", "medium")).toBe("medium");
    expect(chatStartEffort("haiku", "low")).toBeUndefined();
    expect(runDiffers({ model: "opus", effort: "high" }, { model: "claude-opus-5-5", effort: "high" })).toBe(false);
    expect(runDiffers({ model: "opus", effort: "high" }, { model: "claude-opus-5-5", effort: "xhigh" })).toBe(true);
    expect(runDiffers({ model: "opus", effort: "high" }, { model: "claude-sonnet-5", effort: "high" })).toBe(true);
    expect(runDiffers({ model: "haiku" }, { model: "claude-haiku-4-5-20251001" })).toBe(false);
  });
});

describe("the start-of-chat notice in a watched folder", () => {
  it("answers a new chat with the notice — and nothing after a compaction, in other folders, or when switched off", async () => {
    const { Deck } = await import("../src/main/deck");
    const { SettingsStore } = await import("../src/main/settings");
    const dir = tempDir("notice-");
    write(join(dir, ".claude", "agents", "lead.md"), "---\nname: lead\ndescription: Use to run the team.\nmodel: opus\neffort: high\n---\nLead the team.\n");
    write(join(dir, ".claude", "settings.local.json"), { agent: "lead", effortLevel: "high" });
    write(join(dir, ".claude", "rules", "crewglass-team.md"),
      '# team\n<!-- crewglass:team {"version":1,"orchestrator":"lead","links":[{"from":"lead","to":"coder","kind":"delegates"}]} -->\n');
    const userData = tempDir("notice-data-");
    const settings = new SettingsStore(userData);
    const deck = new Deck(settings, () => {}, "/src", userData);
    const folder = Deck.validFolder(dir)!;
    deck.setFolder(folder);
    await deck.poll();
    const start = (extra: object = {}) => deck.handleHook({ event: "SessionStart", session_id: "n1", cwd: folder, agent_type: "lead", source: "startup", ...extra });
    expect(start()).toEqual({ print: { systemMessage: "Crewglass: this chat runs as lead · starts on Opus 5.5 · high · hands work to coder" } });
    expect(start({ source: "compact" })).toEqual({});
    expect(start({ cwd: tempDir("elsewhere-") })).toEqual({});
    settings.update({ chatNotice: false });
    expect(start()).toEqual({});
  });
});

describe("your Claude Code chat leads by default", () => {
  it("a saved chat-led team map comes back as hand-offs from the chat card; an older paused orchestrator reads the same way", async () => {
    const { Deck } = await import("../src/main/deck");
    const { SettingsStore } = await import("../src/main/settings");
    const dir = tempDir("chatlead-");
    for (const n of ["coder", "lead"]) write(join(dir, ".claude", "agents", `${n}.md`), `---\nname: ${n}\ndescription: Use for ${n}.\nmodel: sonnet\n---\nDo ${n} work.\n`);
    const map = (data: object) => write(join(dir, ".claude", "rules", "crewglass-team.md"), `# team\n<!-- crewglass:team ${JSON.stringify(data)} -->\n`);
    map({ version: 1, orchestrator: null, links: [{ from: "@chat", to: "coder", kind: "delegates" }] });
    const userData = tempDir("chatlead-data-");
    const deck = new Deck(new SettingsStore(userData), () => {}, "/src", userData);
    deck.setFolder(Deck.validFolder(dir)!);
    await deck.poll();
    let snap = deck.snapshot();
    expect(snap.orchestratorKey).toBeNull();
    expect(snap.links).toContainEqual(expect.objectContaining({ from: "chat:main", to: "project:.claude/agents/coder.md", kind: "delegates", planned: true }));
    // Saved by an earlier version with the orchestrator "paused": the chat leads, and lead is a regular agent.
    map({ version: 1, orchestrator: "lead", links: [{ from: "lead", to: "coder", kind: "delegates" }] });
    snap = deck.snapshot();
    expect(snap.orchestratorKey).toBeNull();
    expect(snap.agents.find((a) => a.name === "lead")?.kind).toBe("subagent");
    expect(snap.links).toContainEqual(expect.objectContaining({ from: "chat:main", to: "project:.claude/agents/coder.md", kind: "delegates" }));
  });
});

describe("models and token counting after the Sonnet 5.5 release", () => {
  it("names the models Claude Code uses: sonnet is Sonnet 5.5; earlier and dated ids are named too", async () => {
    const { findModel, modelLabel, modelWithEffort, isCostly, runDiffers, LISTED_CLAUDE } = await import("@shared/models");
    expect(findModel("sonnet")?.id).toBe("claude-sonnet-5-5");
    expect(modelWithEffort("claude-sonnet-5-5", "high")).toBe("Sonnet 5.5 · high");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelLabel("claude-mythos-5-1")).toBe("Mythos 5.1");
    expect(LISTED_CLAUDE().map((m) => m.label)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 4.5", "Fable 5.1"]);
    // An agent set to `sonnet` that ran on Sonnet 5.5 is not a mismatch any more.
    expect(runDiffers({ model: "sonnet", effort: "high" }, { model: "claude-sonnet-5-5", effort: "high" })).toBe(false);
    // Fable and Mythos cost more than Opus: calls to them at high effort need your OK too.
    expect(isCostly("fable", "high", false)).toBe(true);
    expect(isCostly("claude-opus-5", "xhigh", false)).toBe(true);
    expect(isCostly("sonnet", "max", false)).toBe(false);
  });

  it("resets limits saved under the old count once, and leaves new ones alone", async () => {
    const { SettingsStore } = await import("../src/main/settings");
    const ud = tempDir("limits-");
    writeFileSync(join(ud, "settings.json"), JSON.stringify({ limits: { session: 1_000_000, day: 1_500_000 }, tokenCount: 2, launchAtLogin: false }));
    const s = new SettingsStore(ud);
    expect(s.limitsReset).toBe(true); // token limits mean nothing in dollars
    expect(s.data.limits).toEqual({ session: 25, day: 50 });
    expect(s.data.launchAtLogin).toBe(false); // everything else kept
    s.update({ limits: { session: 12, day: 30 } });
    const again = new SettingsStore(ud);
    expect(again.limitsReset).toBe(false);
    expect(again.data.limits).toEqual({ session: 12, day: 30 });
    expect(new SettingsStore(tempDir("fresh-")).limitsReset).toBe(false); // first run: just the new defaults
  });
});
