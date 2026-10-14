import { beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assistant, encode, jsonl, tempDir, toolResult, toolUse, write } from "./helpers";

const claude = tempDir();
process.env.CREWGLASS_CLAUDE_DIR = claude;
const { FolderTranscripts, billable } = await import("../src/main/sources/transcripts");
const { Scope } = await import("../src/main/scope");

const work = tempDir();
const folder = join(work, "agent app");
const lookalike = join(work, "agent-app");
mkdirSync(folder, { recursive: true });
mkdirSync(lookalike, { recursive: true });
const proj = join(claude, "projects", encode(folder)); // "agent app" and "agent-app" share this directory
const mainPath = join(proj, "s1.jsonl");

beforeAll(() => {
  write(mainPath, jsonl([
    { type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content: "a prompt that must never be kept" } },
    // One reply split over three lines: usage grows (streaming snapshots) — only the LAST counts.
    assistant("m1", { cwd: folder, out: 4, effort: "xhigh" }),
    assistant("m1", { cwd: folder, out: 50, effort: "xhigh" }),
    assistant("m1", { cwd: folder, out: 125, effort: "xhigh", tools: [
      toolUse("t1", "Agent", { subagent_type: "coder", prompt: "task text never kept" }),
      toolUse("t2", "mcp__github__get_issue", { number: 1 }),
      toolUse("t3", "Skill", { skill: "dataviz" }),
    ] }),
    toolResult("t1"), toolResult("t2"), toolResult("t3"),
    // The same command failing three times with no edit in between.
    assistant("m2", { cwd: folder, tools: [toolUse("b1", "Bash", { command: "npm   run build" })] }), toolResult("b1", true),
    assistant("m3", { cwd: folder, tools: [toolUse("b2", "Bash", { command: "npm run build" })] }), toolResult("b2", true),
    assistant("m4", { cwd: folder, tools: [toolUse("b3", "Bash", { command: "npm run build" })] }), toolResult("b3", true),
    { type: "agent-setting", agentSetting: "lead", sessionId: "s1" },
  ]));
  write(join(proj, "s1", "subagents", "agent-a1.meta.json"), { agentType: "coder", spawnDepth: 1 });
  write(join(proj, "s1", "subagents", "agent-a1.jsonl"), jsonl([
    assistant("sub1", { model: "claude-sonnet-5", effort: "medium", out: 7, sidechain: true }),
    assistant("sub1", { model: "claude-sonnet-5", effort: "medium", out: 70, sidechain: true, tools: [toolUse("n1", "Agent", { subagent_type: "tester" })] }),
    toolResult("n1"),
  ]));
  // A transcript from the look-alike folder in the same directory — and its subagent — must be ignored.
  write(join(proj, "s2.jsonl"), jsonl([assistant("x1", { cwd: lookalike, out: 999_999 })]));
  write(join(proj, "s2", "subagents", "agent-z.meta.json"), { agentType: "intruder" });
  write(join(proj, "s2", "subagents", "agent-z.jsonl"), jsonl([assistant("z1", { out: 888_888, sidechain: true })]));
});

describe("transcript reader", () => {
  it("counts each reply once, using its last streaming snapshot", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const s = t.sessions.get("s1")!;
    // m1 (last: out 125) + m2 + m3 + m4 (out 5 each) = input 10+100 cache writes per message.
    const perMsg = (out: number) => billable({ input: 10, cacheWrite: 100, cacheRead: 1000, output: out });
    const main = perMsg(125) + 3 * perMsg(5);
    const sub = perMsg(70);
    expect(s.tokens).toBe(main + sub);
    expect(s.cacheRead).toBe(5 * 1000);
    expect(s.lastModel).toBe("claude-opus-5-5");
    expect(s.lastEffort).toBe("xhigh");
    expect(s.agentSetting).toBe("lead");
    expect([...s.skills]).toEqual(["dataviz"]);
  });

  it("reads subagents separately, with their own model and effort", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const coder = t.agents.get("coder")!;
    expect(coder.lastModel).toBe("claude-sonnet-5");
    expect(coder.lastEffort).toBe("medium");
    expect(coder.callsToday).toBe(1);
  });

  it("draws observed links: session → subagent, subagent → subagent (nesting), agent → MCP", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const links = [...t.links.values()].map((l) => `${l.from}>${l.to}:${l.kind}`);
    expect(links).toContain("session:s1>coder:delegates");
    expect(links).toContain("coder>tester:direct");
    expect(links).toContain("session:s1>mcp:github:uses");
  });

  it("tracks the same command failing repeatedly (whitespace-normalized)", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const streak = t.failStreaks.get("s1")!;
    expect(streak.command).toBe("npm run build");
    expect(streak.count).toBe(3);
    // A file edit resets it.
    appendFileSync(mainPath, jsonl([assistant("m5", { cwd: folder, tools: [toolUse("e1", "Edit", { file_path: join(folder, "a.ts") })] })]));
    await t.poll();
    expect(t.failStreaks.has("s1")).toBe(false);
  });

  it("ignores transcripts (and their subagents) whose cwd is outside the folder", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    expect(t.sessions.has("s2")).toBe(false);
    expect(t.agents.has("intruder")).toBe(false);
    expect([...t.sessions.values()].every((s) => s.tokens < 999_999)).toBe(true);
  });

  it("waits for a half-written line and reads only what's new", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const before = t.sessions.get("s1")!.tokens;
    const line = JSON.stringify(assistant("m6", { cwd: folder, out: 1 }));
    appendFileSync(mainPath, line.slice(0, 40));
    await t.poll();
    expect(t.sessions.get("s1")!.tokens).toBe(before);
    appendFileSync(mainPath, line.slice(40) + "\n");
    await t.poll();
    expect(t.sessions.get("s1")!.tokens).toBe(before + 11); // input 10 + output 1 (cache writes aren't counted)
  });

  it("counts input + output as tokens; cache writes and reads are kept apart, per session and for today", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const s = t.sessions.get("s1")!;
    const before = { tokens: s.tokens, write: s.cacheWrite, read: s.cacheRead, today: t.todayTokens, cache: { ...t.todayCache } };
    appendFileSync(mainPath, JSON.stringify(assistant("m7", { cwd: folder, input: 3, out: 40, cacheWrite: 400_000, cacheRead: 900 })) + "\n");
    await t.poll();
    expect(s.tokens - before.tokens).toBe(43);
    expect(s.cacheWrite - before.write).toBe(400_000);
    expect(s.cacheRead - before.read).toBe(900);
    expect(t.todayTokens - before.today).toBe(43);
    expect(t.todayCache.write - before.cache.write).toBe(400_000);
  });

  it("starts the day's counters again at midnight (the app runs for days)", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    expect(t.todayTokens).toBeGreaterThan(0);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 5, 0, 0);
    t.rollDay(tomorrow.getTime());
    expect(t.todayTokens).toBe(0);
    expect(t.todayCache).toEqual({ write: 0, read: 0 });
    expect([...t.sessions.values()].every((x) => x.tokensToday === 0)).toBe(true);
    expect([...t.agents.values()].every((a) => a.tokensToday === 0 && a.callsToday === 0)).toBe(true);
    expect(t.sessions.get("s1")!.tokens).toBeGreaterThan(0); // the session's own total is kept
    t.rollDay(tomorrow.getTime() + 60_000); // same day: nothing changes
    expect(t.todayTokens).toBe(0);
  });

  it("never keeps prompt, reply or tool-output text", async () => {
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const dump = JSON.stringify({ a: t.recentActivity(), s: [...t.sessions.values()].map((s) => ({ ...s, models: [...s.models] })) });
    expect(dump).not.toContain("must never be kept");
    expect(dump).not.toContain("task text never kept");
  });
});
