// Phase 3 "done when" checks against REAL Claude Code (Haiku, a throwaway folder). Opt-in, because it spends tokens:
//
//   npm run build:hook && CREWGLASS_E2E=1 npx vitest run test/e2e.phase3.test.ts
//
// Runs Crewglass's own pieces in-process (Deck + socket server + the compiled helper + the save planner) — the same
// code the app runs — so nothing depends on clicking the UI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@shared/types";
import type { DesignPayload } from "@shared/ipc";
import { tempDir } from "./helpers";

const RUN = process.env.CREWGLASS_E2E === "1";
const HELPER = join(__dirname, "..", "out", "bin", "crewglass-hook");
const APPROVAL_MS = 20_000;
process.env.CREWGLASS_TEST = "1";
process.env.CREWGLASS_TEST_APPROVAL_MS = String(APPROVAL_MS);

const { planSave, applySave } = await import("../src/main/writers/savePlan");
const { Deck } = await import("../src/main/deck");
const { SettingsStore } = await import("../src/main/settings");
const { startHookServer } = await import("../src/main/live/hookServer");
const { Waiting } = await import("../src/main/live/liveEngine");
const { install, uninstall, hookCommand } = await import("../src/main/live/hookInstaller");
type HookMsg = import("../src/main/live/liveEngine").HookMsg;
type Answer = import("../src/main/live/liveEngine").Answer;

const base = { toolAccess: "connected" as const, builtinTools: ["Read"], keepPrivate: false, checks: [], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [] };
const agent = (name: string, extra: Partial<Agent>): Agent => ({
  ...base, key: `project:.claude/agents/${name}.md`, name, kind: "subagent", scope: "project", file: `.claude/agents/${name}.md`,
  role: `Use for ${name} work.`, instructions: `You are ${name}. Be brief.`, model: "haiku", maxTurns: 6, ...extra,
});
const lead = agent("lead", { kind: "orchestrator", toolAccess: "inherit", instructions: "You are the orchestrator. Follow the user's instructions exactly. Never call the architect agent yourself." });
const coder = agent("coder", { instructions: "You are coder. Follow the task exactly and report what happened, including any error text you received, word for word." });
const tester = agent("tester", { instructions: "You are tester. Reply with the single word PONG." });
const architect = agent("architect", { model: "opus", effort: "high", maxTurns: 1, instructions: "You are architect. Reply with OK." });
const design = (agents: Agent[]): DesignPayload => ({
  agents, mcps: [], orchestratorKey: lead.key, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [],
  links: [
    { id: "1", from: lead.key, to: coder.key, kind: "delegates", planned: true },
    { id: "2", from: coder.key, to: tester.key, kind: "direct", planned: true, directState: "allowed" },
  ],
});

function claude(folder: string, prompt: string, extra: string[] = []): Promise<string> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE; // run as a normal top-level session
    const p = spawn("claude", ["-p", "--output-format", "stream-json", "--verbose", "--allowedTools", "Agent", ...extra], { cwd: folder, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.stdin.end(prompt);
  });
}
const lines = (out: string) => out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
/** Subagent runs Claude recorded for a folder: file → { type, parent }. */
function subagentRuns(folder: string): Map<string, { type: string; parent: string | null; transcript: string }> {
  const proj = join(homedir(), ".claude", "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  const out = new Map<string, { type: string; parent: string | null; transcript: string }>();
  if (!existsSync(proj)) return out;
  for (const f of readdirSync(proj, { recursive: true }).map(String).filter((x) => x.endsWith(".meta.json"))) {
    try {
      const m = JSON.parse(readFileSync(join(proj, f), "utf8"));
      out.set(f, { type: m.agentType, parent: m.parentAgentId ?? null, transcript: join(proj, f.replace(/\.meta\.json$/, ".jsonl")) });
    } catch { /* partial */ }
  }
  return out;
}
const reasonOf = (a: Answer) => (a.print?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason;

describe.skipIf(!RUN || !existsSync(HELPER))("Phase 3 with real Claude Code (Haiku)", () => {
  const folder = tempDir("crewglass-e2e-");
  const userData = tempDir("crewglass-e2e-ud-");
  const backups = join(userData, "backups");
  const sock = join(tempDir("ad-"), "d.sock");
  const log: { m: HookMsg; a: Answer; ms: number }[] = [];
  const popups: string[] = [];
  let deck: InstanceType<typeof Deck>;
  let server: ReturnType<typeof startHookServer>;
  let timer: ReturnType<typeof setInterval>;

  beforeAll(async () => {
    execFileSync("git", ["init", "-q"], { cwd: folder });
    const plan = planSave(folder, design([lead, coder, tester, architect]));
    expect(plan.blocked).toBe(false);
    expect(applySave(plan.id, false, backups, () => ({ ok: true })).ok).toBe(true);
    // Test-only: Haiku as the orchestrator sometimes skips coder and calls the target itself; pin its hand-offs to coder.
    const leadFile = join(folder, ".claude/agents/lead.md");
    writeFileSync(leadFile, readFileSync(leadFile, "utf8").replace("\nmodel: haiku\n", "\nmodel: haiku\ntools: Agent(coder)\n"));
    deck = new Deck(new SettingsStore(userData), (t, b) => popups.push(`${t} | ${b}`), "/repo", userData);
    deck.setFolder(folder);
    await deck.poll(); deck.snapshot();
    timer = setInterval(() => void deck.poll().then(() => deck.snapshot()), 1000);
    server = startHookServer(sock, (m) => {
      const t0 = Date.now();
      const a = deck.handleHook(m);
      if (a instanceof Waiting) void a.answer.then((r) => log.push({ m, a: r, ms: Date.now() - t0 }));
      else log.push({ m, a, ms: 0 });
      return a;
    });
    await new Promise((r) => server.once("listening", r));
    install(folder, hookCommand(HELPER, sock), backups);
  }, 60_000);

  afterAll(() => {
    clearInterval(timer);
    server?.close();
    uninstall(folder, backups);
    // Remove the transcripts Claude Code kept for this throwaway folder (only ever an crewglass-e2e-* folder).
    const proj = join(homedir(), ".claude", "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    if (/crewglass-e2e-[A-Za-z0-9]{6}$/.test(proj)) rmSync(proj, { recursive: true, force: true });
  });

  it("the saved team is Claude's team, and a new session runs as the orchestrator on its model", async () => {
    const init = lines(await claude(folder, "Reply with just OK.", ["--max-turns", "1"])).find((l) => l.type === "system" && l.subtype === "init")!;
    console.log("init:", { model: init.model, agents: init.agents });
    expect(init.agents).toEqual(expect.arrayContaining(["lead", "coder", "tester", "architect"]));
    expect(String(init.model)).toMatch(/haiku/);
    const settings = JSON.parse(readFileSync(join(folder, ".claude/settings.local.json"), "utf8"));
    expect(settings.agent).toBe("lead");
  }, 120_000);

  it("a planted fake key is blocked from a shared file", () => {
    const before = readFileSync(join(folder, ".claude/agents/coder.md"), "utf8");
    const bad = { ...coder, instructions: "Use token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 for GitHub." };
    const plan = planSave(folder, design([lead, bad, tester, architect]));
    expect(plan.blocked).toBe(true);
    expect(applySave(plan.id, false, backups, () => ({ ok: true })).ok).toBe(false);
    expect(readFileSync(join(folder, ".claude/agents/coder.md"), "utf8")).toBe(before);
  });

  it("a subagent's direct call without a Reason: line is refused, and told how to fix it", async () => {
    // The team map teaches every agent the Reason: rule (in practice they follow it), so hide it for this run.
    const map = join(folder, ".claude/rules/crewglass-team.md");
    renameSync(map, map + ".off");
    log.length = 0;
    try {
      await claude(folder, "Use the Agent tool exactly once: delegate to the coder agent with exactly this prompt, copied verbatim with nothing added:\n\n" +
        "Use the Agent tool to call the tester agent. Your prompt to tester must be exactly: Reply with PONG\nThen report tester's answer, or the exact error you got.");
    } finally { renameSync(map + ".off", map); }
    const calls = log.filter((l) => l.m.event === "PreToolUse" && l.m.agent_type === "coder" && l.m.subagent_type === "tester");
    console.log("coder → tester:", calls.map((c) => ({ reason: c.m.call_reason ?? null, answer: reasonOf(c.a) ?? "allowed" })));
    if (!calls.length) console.log("events:", log.map((l) => `${l.m.event}:${l.m.agent_type ?? "main"}:${l.m.tool_name ?? ""}${l.m.subagent_type ? ">" + l.m.subagent_type : ""}`).join(" "));
    expect(calls.length).toBeGreaterThan(0);
    expect(reasonOf(calls[0].a)).toMatch(/first line of your request must be "Reason:/);
  }, 240_000);

  it("a costly direct call waits for you, then goes to the orchestrator", async () => {
    log.length = 0;
    const t0 = Date.now();
    await claude(folder, "Use the Agent tool exactly once: delegate to the coder agent with exactly this prompt, copied verbatim with nothing added:\n\n" +
      "Use the Agent tool to call the architect agent. The first line of your prompt to architect must be exactly:\nReason: need a design decision on the cache layer\n" +
      "and the second line: Reply with OK\nThen report the exact answer or error you got. Do not call any other agent.\n\n" +
      "After coder reports back, stop. Do not call architect yourself.");
    const calls = log.filter((l) => l.m.event === "PreToolUse" && l.m.agent_type === "coder" && l.m.subagent_type === "architect");
    const item = deck.snapshot().inbox.find((i) => i.kind === "approval");
    console.log("coder → architect:", calls.map((c) => ({ waitedMs: c.ms, answer: reasonOf(c.a) ?? "allowed" })), "| card:", item?.title, "→", item?.resolved, "| popups:", popups);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].ms).toBeGreaterThanOrEqual(APPROVAL_MS - 100);
    expect(reasonOf(calls[0].a)).toMatch(/didn't answer in time.*REQUEST architect:/);
    expect(item?.resolved).toMatch(/orchestrator/);
    expect(popups.some((p) => /needs your OK/.test(p))).toBe(true);
    expect(popups.join("\n")).not.toMatch(/cache layer/); // no work text in macOS notifications
    // architect (Opus · high) never ran
    const proj = join(homedir(), ".claude", "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    const metas = existsSync(proj) ? readdirSync(proj, { recursive: true }).map(String).filter((f) => f.endsWith(".meta.json")) : [];
    const types = metas.map((f) => { try { return JSON.parse(readFileSync(join(proj, f), "utf8")).agentType as string; } catch { return ""; } });
    expect(types).not.toContain("architect");
    expect(Date.now() - t0).toBeGreaterThan(APPROVAL_MS);
  }, 300_000);

  it("app closed: a direct call is not silently allowed (Claude's own permission prompt; nobody to answer in -p)", async () => {
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    const before = subagentRuns(folder);
    const out = lines(await claude(folder, "Use the Agent tool exactly once: delegate to the coder agent with exactly this prompt, copied verbatim with nothing added:\n\n" +
      "Use the Agent tool to call the tester agent. Your prompt to tester must be:\nReason: need the integration tests run on my change\nReply with PONG\nThen report the exact answer or error you got.\n\n" +
      "Do not call tester yourself."));
    const result = out.find((l) => l.type === "result");
    const fresh = [...subagentRuns(folder)].filter(([f]) => !before.has(f)).map(([, v]) => v);
    console.log("app closed → result:", String(result?.result ?? "").slice(0, 400), "| new subagent runs:", fresh);
    expect(fresh.some((r) => r.type === "coder")).toBe(true);
    expect(fresh.filter((r) => r.type === "tester" && r.parent)).toEqual([]); // coder's direct call didn't go through
    const coderRun = fresh.find((r) => r.type === "coder")!;
    expect(readFileSync(coderRun.transcript, "utf8")).toContain("Crewglass isn't answering, so this direct call between agents needs your OK.");
  }, 240_000);
});
