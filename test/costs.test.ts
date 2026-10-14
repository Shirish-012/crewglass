// Dollars (API-equivalent), the 95% wrap-up request, the status line, /handoff + /pickup and the subagent templates.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encode, jsonl, tempDir, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { costOf, formatUsd } = await import("@shared/pricing");
const { FolderTranscripts } = await import("../src/main/sources/transcripts");
const { Scope } = await import("../src/main/scope");
const { Deck } = await import("../src/main/deck");
const { SettingsStore } = await import("../src/main/settings");
const { chatNotice } = await import("../src/main/live/chatNotice");
const { planSave, applySave } = await import("../src/main/writers/savePlan");
const { install, uninstall, setStatusLine, missingStatusLine } = await import("../src/main/live/hookInstaller");
const { renderAgentFile } = await import("@shared/agentFile");
const { readAgentFiles } = await import("../src/main/sources/agentFiles");
const { HANDOFF_MARK } = await import("@shared/handoff");

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
/** A reply line with full usage, including the 5-minute / 1-hour cache-write split. */
const reply = (id: string, cwd: string, usage: object, model = "claude-opus-5-5", ts = new Date().toISOString()) =>
  ({ type: "assistant", timestamp: ts, cwd, sessionId: "s1", message: { id, model, usage, content: [] } });

describe("API-equivalent dollars", () => {
  it("prices each kind of token at its own rate", () => {
    // 1M each on Opus 5.5: input $4 + 1-hour cache write $8 + cache read $0.20 + output $20
    expect(near(costOf("claude-opus-5-5", { input: 1e6, write5m: 0, write1h: 1e6, cacheRead: 1e6, output: 1e6 }), 32.2)).toBe(true);
    expect(near(costOf("haiku", { input: 0, write5m: 1e6, write1h: 0, cacheRead: 0, output: 0 }), 1.25)).toBe(true); // 5-min write = 1.25× input
    expect(near(costOf("sonnet", { input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 1e6 }), 10)).toBe(true); // sonnet = Sonnet 5.5
    expect(costOf("some-future-model", { input: 1e6, write5m: 0, write1h: 0, cacheRead: 0, output: 0 })).toBe(4); // priced like the default
    expect(formatUsd(3.456)).toBe("$3.46");
  });

  it("adds up a folder's replies once each (streaming snapshots aren't counted twice), per session and for today", async () => {
    const folder = tempDir("usd-");
    const file = join(home, ".claude", "projects", encode(folder), "s1.jsonl");
    const u = (out: number) => ({ input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    write(file, jsonl([reply("m1", folder, u(50_000)), reply("m1", folder, u(100_000)), reply("m2", folder, u(50_000), "claude-haiku-4-5-20251001")]));
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    const s = t.sessions.get("s1")!;
    expect(near(s.usd, 100_000 * 20 / 1e6 + 50_000 * 5 / 1e6)).toBe(true); // $2.00 + $0.25 — m1 once, at its last snapshot
    expect(near(t.todayUsd, s.usd)).toBe(true);
    expect(Object.keys(t.todayUsdByModel).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
    // No split recorded: priced as the dearer 1-hour cache, so spend is never under-counted.
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify(reply("m3", folder, { cache_creation_input_tokens: 1e6 })) + "\n");
    await t.poll();
    expect(near(t.todayUsd - 2.25, 8)).toBe(true);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 1, 0, 0);
    t.rollDay(tomorrow.getTime());
    expect(t.todayUsd).toBe(0);
    expect(s.usdToday).toBe(0);
    expect(s.usd).toBeGreaterThan(10); // the session's own total stays
  });
});

describe("near the limit, with Live mode", () => {
  async function deckWith(usd: number) {
    const folder = tempDir("wrap-");
    // One reply worth `usd` dollars of Opus 5.5 output ($20 per million).
    write(join(home, ".claude", "projects", encode(folder), "s1.jsonl"), jsonl([reply("w1", folder, { output_tokens: Math.round(usd / 20 * 1e6) })]));
    const userData = tempDir("wrap-data-");
    const settings = new SettingsStore(userData);
    settings.update({ limits: { session: 100, day: 10 } });
    const deck = new Deck(settings, () => {}, "/src", userData);
    const real = Deck.validFolder(folder)!;
    deck.setFolder(real);
    await deck.poll();
    return { deck, folder: real };
  }
  const post = (folder: string, extra: object = {}) => ({ event: "PostToolUse", session_id: "s1", cwd: folder, tool_name: "Bash", ...extra });

  it("asks the main chat once a day, after a tool step, to finish and write a handoff note — never blocks", async () => {
    const { deck, folder } = await deckWith(9.6); // 96% of the $10 day
    expect(deck.handleHook(post(folder, { agent_id: "a1", agent_type: "coder" }))).toEqual({}); // subagents aren't asked
    const a = deck.handleHook(post(folder)) as { print?: { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } } };
    expect(a.print?.hookSpecificOutput?.additionalContext).toMatch(/USAGE NOTICE[\s\S]*\.claude\/handoff\.md[\s\S]*Nothing is blocked/);
    expect(a.print?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(deck.handleHook(post(folder))).toEqual({}); // once
    expect(deck.snapshot().inbox.some((i) => i.title === "Claude was asked to wrap up")).toBe(true);
  });

  it("says nothing below 95%", async () => {
    const { deck, folder } = await deckWith(8);
    expect(deck.handleHook(post(folder))).toEqual({});
  });

  it("answers the status line with today's spend vs the limit and this session", async () => {
    const { deck, folder } = await deckWith(5);
    const a = deck.handleHook({ event: "StatusLine", session_id: "s1", cwd: folder }) as { print?: { statusText?: string } };
    expect(a.print?.statusText).toContain("today");
    const plain = (a.print?.statusText ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/^session \$5\.00 · today \$5\.00\/\$10\.00 ▰▰▰▱▱ 50%/);
    expect(deck.handleHook({ event: "StatusLine", session_id: "s1", cwd: tempDir("other-") })).toEqual({}); // another folder: nothing
  });
});

describe("/handoff and /pickup", () => {
  const design = (handoff: boolean | undefined) => ({ agents: [], mcps: [], links: [], orchestratorKey: null, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [], handoff });
  const ok = () => ({ ok: true });

  it("are added on Save (the note itself kept out of git), removed again, and never over a command you wrote", () => {
    const folder = tempDir("handoff-");
    mkdirSync(join(folder, ".git", "info"), { recursive: true });
    const backups = tempDir("handoff-bk-");
    applySave(planSave(folder, design(true)).id, false, backups, ok);
    expect(readFileSync(join(folder, ".claude/commands/handoff.md"), "utf8")).toContain(HANDOFF_MARK);
    expect(readFileSync(join(folder, ".claude/commands/pickup.md"), "utf8")).toContain("Read `.claude/handoff.md`");
    expect(readFileSync(join(folder, ".git/info/exclude"), "utf8")).toContain("/.claude/handoff.md");
    expect(readFileSync(join(folder, ".claude/rules/crewglass-usage.md"), "utf8")).toContain("USAGE NOTICE (from Crewglass)");
    expect(planSave(folder, design(undefined)).files).toEqual([]); // left alone when the design doesn't say
    applySave(planSave(folder, design(false)).id, false, backups, ok);
    expect(existsSync(join(folder, ".claude/commands/handoff.md"))).toBe(false);
    expect(readFileSync(join(folder, ".git/info/exclude"), "utf8")).not.toContain("/.claude/handoff.md");
    writeFileSync(join(folder, ".claude/commands/handoff.md"), "my own handoff command\n");
    const plan = planSave(folder, design(true));
    expect(plan.files.map((f) => f.display)).toEqual([".claude/commands/pickup.md", ".claude/rules/crewglass-usage.md", ".git/info/exclude"]);
  });

  it("a new chat mentions a waiting note first, even in a folder without a team", () => {
    expect(chatNotice({ agentType: undefined, agent: null, startEffort: null, team: null, handoff: "Oct 7, 3:40 PM" }))
      .toBe("Crewglass: handoff note from Oct 7, 3:40 PM — /pickup to continue");
    expect(chatNotice({ agentType: "lead", agent: null, startEffort: null, team: null, handoff: "Oct 7" })).toBe("Crewglass: this chat runs as lead · handoff note from Oct 7 — /pickup to continue");
  });
});

describe("the status line comes with Live mode", () => {
  const cmd = '"/opt/crewglass-hook" --socket "/tmp/d.sock"';
  it("is added and removed with Live mode, never over your own, and follows the Settings switch", () => {
    const backups = tempDir("sl-bk-");
    const a = tempDir("sl-a-");
    setStatusLine(true);
    install(a, cmd, backups);
    const settings = () => JSON.parse(readFileSync(join(a, ".claude/settings.local.json"), "utf8"));
    expect(settings().statusLine).toEqual({ type: "command", command: `${cmd} --statusline`, padding: 0 });
    uninstall(a, backups);
    expect(existsSync(join(a, ".claude/settings.local.json"))).toBe(false); // restored: there was no file before
    const b = tempDir("sl-b-");
    write(join(b, ".claude/settings.local.json"), { statusLine: { type: "command", command: "my-line" } });
    install(b, cmd, backups);
    expect(JSON.parse(readFileSync(join(b, ".claude/settings.local.json"), "utf8")).statusLine.command).toBe("my-line");
    expect(missingStatusLine(b)).toBe(false); // your own line counts: nothing to add
    setStatusLine(false);
    install(a, cmd, backups);
    expect(missingStatusLine(a)).toBe(true); // Live mode without any status line: the app adds ours at start
    expect(settings().statusLine).toBeUndefined();
    setStatusLine(true);
  });
});

describe("subagent templates", () => {
  it("omitClaudeMd is written for self-contained roles and kept when the file is read back", () => {
    const folder = tempDir("tpl-");
    const agent = { key: "k", name: "explorer", kind: "subagent", scope: "project", file: ".claude/agents/explorer.md", role: "Use to find things.", instructions: "Read only.",
      model: "haiku", toolAccess: "connected", builtinTools: ["Read", "Grep", "Glob"], omitClaudeMd: true, keepPrivate: false, checks: [], status: "idle", parallel: 0, tokens: 0, calls: 0, skillsUsed: [] } as never;
    const text = renderAgentFile(agent, { mcpServers: [], canCallAgents: false });
    expect(text).toContain("omitClaudeMd: true");
    write(join(folder, ".claude/agents/explorer.md"), text);
    expect(readAgentFiles(folder).project[0].agent.omitClaudeMd).toBe(true);
  });
});
