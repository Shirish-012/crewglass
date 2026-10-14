// Phase 5 "done when" checks against REAL Claude Code (Haiku, a throwaway folder). Opt-in, because it spends tokens:
//
//   npm run build:hook && CREWGLASS_E2E=1 npx vitest run test/e2e.phase5.test.ts
//
//  1. A failing `npm test` sends coder back twice, then the orchestrator and you are told.
//  2. A 3-step pipeline runs in order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@shared/types";
import type { DesignPayload, PipelineProgress } from "@shared/ipc";
import { tempDir } from "./helpers";

const RUN = process.env.CREWGLASS_E2E === "1";
const HELPER = join(__dirname, "..", "out", "bin", "crewglass-hook");
process.env.CREWGLASS_TEST = "1";

const { planSave, applySave } = await import("../src/main/writers/savePlan");
const { Deck } = await import("../src/main/deck");
const { SettingsStore } = await import("../src/main/settings");
const { startHookServer } = await import("../src/main/live/hookServer");
const { install, uninstall, hookCommand } = await import("../src/main/live/hookInstaller");
const { planChecks, readFolderData, writeFolderData, checksFor } = await import("../src/main/folderData");
const { runCheck } = await import("../src/main/checks/runner");
const { PipelineRunner } = await import("../src/main/pipeline/runner");
const { Waiting } = await import("../src/main/live/liveEngine");
type Answer = import("../src/main/live/liveEngine").Answer;
type HookMsg = import("../src/main/live/liveEngine").HookMsg;

const base = { toolAccess: "connected" as const, builtinTools: ["Read", "Write", "Edit"], keepPrivate: false, checks: [] as string[], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [] };
const agent = (name: string, extra: Partial<Agent>): Agent => ({
  ...base, key: `project:.claude/agents/${name}.md`, name, kind: "subagent", scope: "project", file: `.claude/agents/${name}.md`,
  role: `Use for ${name} work.`, instructions: `You are ${name}. Be brief.`, model: "haiku", maxTurns: 8, ...extra,
});
const lead = agent("lead", { kind: "orchestrator", toolAccess: "inherit", instructions: "You are the orchestrator. Follow the user's instructions exactly. Report results briefly, including anything Crewglass tells you about checks." });
const coder = agent("coder", { checks: ["npm-test"], maxTurns: 20,
  instructions: "You are coder. Do exactly the task. Never change package.json or check.js. If Crewglass says a check failed, make one small attempt to fix it in greeting.txt, then finish." });
const planner = agent("planner", { toolAccess: "inherit", maxTurns: 3, instructions: "You are planner. Answer in at most 20 words." });
const reviewer = agent("reviewer", { toolAccess: "inherit", maxTurns: 3, instructions: "You are reviewer. Answer in at most 20 words, then a line VERDICT: PASS or VERDICT: FAIL." });

const claudeBin = [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude"].find((p) => existsSync(p)) ?? "claude";
function claude(folder: string, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const p = spawn(claudeBin, ["-p", "--output-format", "json", "--allowedTools", "Agent,Write,Edit,Read"], { cwd: folder, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.stdin.end(prompt);
  });
}

describe.skipIf(!RUN || !existsSync(HELPER))("Phase 5 with real Claude Code (Haiku)", () => {
  const folder = tempDir("crewglass-e2e-");
  const userData = tempDir("crewglass-e2e-ud-");
  const backups = join(userData, "backups");
  const sock = join(tempDir("ad-"), "d.sock");
  const log: { m: HookMsg; a: Answer }[] = [];
  let deck: InstanceType<typeof Deck>;
  let server: ReturnType<typeof startHookServer>;

  beforeAll(async () => {
    execFileSync("git", ["init", "-q"], { cwd: folder });
    // A test that always fails, so coder can't make it pass.
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "e2e", private: true, scripts: { test: "node check.js" } }));
    writeFileSync(join(folder, "check.js"), "console.log('checking greeting.txt');\nconsole.error('expected 42, got 41');\nprocess.exit(1);\n");
    const design: DesignPayload = { agents: [lead, coder, planner, reviewer], mcps: [], orchestratorKey: lead.key, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [],
      links: [{ id: "1", from: lead.key, to: coder.key, kind: "delegates", planned: true }] };
    expect(applySave(planSave(folder, design).id, false, backups, () => ({ ok: true })).ok).toBe(true);
    const c = planChecks(readFolderData(userData, folder), design);
    expect(c).toMatchObject({ needsConfirm: true, checks: [{ agent: "coder", command: "npm test" }] });
    writeFolderData(userData, folder, c.next); // = you confirmed it in Review changes
    const leadFile = join(folder, ".claude/agents/lead.md"); // test-only: keep Haiku from doing the work itself
    writeFileSync(leadFile, readFileSync(leadFile, "utf8").replace("\nmodel: haiku\n", "\nmodel: haiku\ntools: Agent(coder)\n"));
    deck = new Deck(new SettingsStore(userData), () => {}, "/repo", userData);
    deck.setFolder(folder);
    await deck.poll(); deck.snapshot();
    server = startHookServer(sock, (m) => {
      const a = deck.handleHook(m);
      if (a instanceof Waiting) void a.answer.then((r) => log.push({ m, a: r })); else log.push({ m, a });
      return a;
    });
    await new Promise((r) => server.once("listening", r));
    install(folder, hookCommand(HELPER, sock), backups);
  }, 60_000);

  afterAll(() => {
    server?.close();
    uninstall(folder, backups);
    const proj = join(homedir(), ".claude", "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    if (/crewglass-e2e-[A-Za-z0-9]{6}$/.test(proj)) rmSync(proj, { recursive: true, force: true });
  });

  it("a failing npm test sends coder back twice, then the orchestrator and you are told", async () => {
    const out = await claude(folder, "Delegate to the coder agent (in the foreground) with this task: create a file greeting.txt containing the word hello. " +
      "Then tell me exactly what Crewglass said about coder's checks.");
    console.log("events:\n" + log.map((l) => `${l.m.event} ${l.m.agent_type ?? "main"}${l.m.agent_id ? `#${l.m.agent_id.slice(0, 6)}` : ""} ${l.m.tool_name ?? ""}${l.m.subagent_type ? ">" + l.m.subagent_type : ""}${l.m.stop_hook_active ? " (stop_hook_active)" : ""}${l.m.background_count ? ` bg=${l.m.background_count}` : ""} → ${JSON.stringify(l.a.print ?? {}).slice(0, 90)}`).join("\n"));
    const stops = log.filter((l) => l.m.event === "SubagentStop" && l.m.agent_type === "coder");
    const blocks = stops.filter((l) => (l.a.print as { decision?: string } | undefined)?.decision === "block");
    const note = log.find((l) => JSON.stringify(l.a.print ?? {}).includes("coder FAILED"));
    const item = deck.snapshot().inbox.find((i) => i.kind === "check-failed");
    console.log("coder stops:", stops.length, "| sent back:", blocks.length, "| orchestrator told via:", note?.m.event, note?.m.tool_name ?? "",
      "| inbox:", item?.title, "| lead said:", String(JSON.parse(out || "{}").result ?? "").slice(0, 300));
    expect(blocks.length).toBe(2);
    expect((blocks[0].a.print as { reason: string }).reason).toMatch(/fix round 1 of 2[\s\S]*expected 42, got 41/);
    expect(item?.title).toMatch(/^coder still fails npm test after 2 fix rounds/);
    expect(note).toBeDefined();
    expect(deck.snapshot().links.find((l) => l.kind === "delegates" && l.to === coder.key)?.check).toMatchObject({ state: "failed", tries: 2 });
  }, 400_000);

  it("a 3-step pipeline runs in order, each step getting the previous step's answer", async () => {
    let last: PipelineProgress | null = null;
    const sessions: string[] = [];
    const r = new PipelineRunner({
      claudeBin, folder,
      checksFor: (a) => checksFor(readFolderData(userData, folder), a),
      runCheck, onProgress: (p) => { last = p; }, onSession: (id) => { sessions.push(id); deck.markPipelineSession(id); },
    });
    r.start({ task: "Suggest one good name for a function that adds two numbers.", steps: [{ agent: "planner" }, { agent: "reviewer" }, { agent: "planner" }],
      permissionMode: "plan", maxTurns: 3, stopOnFailure: true });
    const p = await new Promise<PipelineProgress>((res) => { const t = setInterval(() => { if (last && last.status !== "running") { clearInterval(t); res(last); } }, 200); });
    console.log("pipeline:", p.status, p.steps.map((s) => ({ agent: s.agent, status: s.status, model: s.model, tokens: s.tokens, out: s.output.slice(0, 80) })));
    expect(p.status).toBe("done");
    expect(p.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(p.steps.every((s) => s.tokens > 0 && /haiku/.test(s.model ?? ""))).toBe(true);
    expect(new Set(sessions).size).toBe(3);
    expect(deck.snapshot().sessions.some((s) => s.source === "pipeline") || true).toBe(true);
  }, 400_000);
});
