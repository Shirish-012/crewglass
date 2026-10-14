// Phase 4 "done when" check against REAL Claude Code (Haiku) and REAL agy (one small Gemini call). Opt-in:
//
//   npm run build:hook && CREWGLASS_E2E=1 npx vitest run test/e2e.phase4.test.ts
//
// It saves a team with an agy agent into a throwaway folder (which registers Crewglass's bridge for that folder with
// `claude mcp add --scope local`), asks the orchestrator to have the agy agent check something, and watches it live.
// Afterwards the bridge is unregistered and the folder's transcripts are removed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@shared/types";
import type { DesignPayload } from "@shared/ipc";
import { tempDir } from "./helpers";

const RUN = process.env.CREWGLASS_E2E === "1";
const HELPER = join(__dirname, "..", "out", "bin", "crewglass-hook");
const BRIDGE = join(__dirname, "..", "out", "bin", "agy-bridge.mjs");
const GEMINI = "gemini-3.1-pro-low";
process.env.CREWGLASS_TEST = "1";

const { planSave, applySave } = await import("../src/main/writers/savePlan");
const { Deck } = await import("../src/main/deck");
const { SettingsStore } = await import("../src/main/settings");
const { startHookServer } = await import("../src/main/live/hookServer");
const { install, uninstall, hookCommand } = await import("../src/main/live/hookInstaller");
const { findAgyEnv } = await import("../src/main/agyEnv");
const { AGY_SERVER, AGY_TOOL, agyRelayInstructions } = await import("@shared/agy");

const base = { toolAccess: "inherit" as const, builtinTools: [], keepPrivate: true, checks: [], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [] };
const lead: Agent = { ...base, key: "project:.claude/agents/lead.md", name: "lead", kind: "orchestrator", scope: "project", file: ".claude/agents/lead.md",
  role: "Orchestrator.", instructions: "You are the orchestrator. Follow the user's instructions exactly and report results briefly.", model: "haiku", maxTurns: 6 };
const reviewer: Agent = { ...base, key: "project:.claude/agents/gemini-reviewer.md", name: "gemini-reviewer", kind: "agy", scope: "project", file: ".claude/agents/gemini-reviewer.md",
  role: "Use for a second opinion from Gemini.", instructions: agyRelayInstructions(GEMINI), model: "haiku", maxTurns: 3, geminiModel: GEMINI };
const design: DesignPayload = { agents: [lead, reviewer], mcps: [], orchestratorKey: lead.key, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [],
  links: [{ id: "1", from: lead.key, to: reviewer.key, kind: "delegates", planned: true }] };

const claudeBin = [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude"].find((p) => existsSync(p)) ?? "claude";
const env = () => { const e = { ...process.env }; delete e.CLAUDECODE; return e; };
function claude(folder: string, prompt: string, extra: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(claudeBin, ["-p", "--output-format", "json", ...extra], { cwd: folder, env: env(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
    p.stdin.end(prompt);
  });
}

const agyEnv = { ...findAgyEnv(BRIDGE), bridge: existsSync(BRIDGE) ? BRIDGE : null };
describe.skipIf(!RUN || !existsSync(HELPER) || !agyEnv.agy || !agyEnv.node)("Phase 4 with real Claude Code + agy", () => {
  const folder = tempDir("crewglass-e2e-");
  const userData = tempDir("crewglass-e2e-ud-");
  const backups = join(userData, "backups");
  const sock = join(tempDir("ad-"), "d.sock");
  let deck: InstanceType<typeof Deck>;
  let server: ReturnType<typeof startHookServer>;
  let timer: ReturnType<typeof setInterval>;
  const seen: { status: string; model: string | null }[] = [];

  beforeAll(async () => {
    execFileSync("git", ["init", "-q"], { cwd: folder });
    const plan = planSave(folder, design, agyEnv);
    console.log("commands:", plan.commands.map((c) => c.label), "| warnings:", plan.warnings);
    expect(plan.commands.map((c) => c.argv.slice(0, 5))).toEqual([["mcp", "add", "--scope", "local", AGY_SERVER]]);
    const r = applySave(plan.id, false, backups, (argv) => {
      try { execFileSync(claudeBin, argv, { cwd: folder, env: env(), stdio: "pipe", timeout: 30_000 }); return { ok: true }; }
      catch (e) { return { ok: false, error: String((e as { stderr?: Buffer }).stderr ?? e) }; }
    });
    expect(r).toMatchObject({ ok: true });
    // Test-only: keep the orchestrator from doing the check itself.
    const leadFile = join(folder, ".claude/agents/lead.md");
    writeFileSync(leadFile, readFileSync(leadFile, "utf8").replace("\nmodel: haiku\n", "\nmodel: haiku\ntools: Agent(gemini-reviewer)\n"));
    deck = new Deck(new SettingsStore(userData), () => {}, "/repo", userData);
    deck.agyEnv = agyEnv;
    deck.setFolder(folder);
    await deck.poll(); deck.snapshot();
    server = startHookServer(sock, (m) => deck.handleHook(m));
    await new Promise((res) => server.once("listening", res));
    install(folder, hookCommand(HELPER, sock), backups);
    timer = setInterval(() => void deck.poll().then(() => {
      const a = deck.snapshot().agents.find((x) => x.name === "gemini-reviewer");
      if (a) seen.push({ status: a.status, model: a.liveNow?.model ?? null });
    }), 500);
  }, 60_000);

  afterAll(() => {
    clearInterval(timer);
    server?.close();
    uninstall(folder, backups);
    try { execFileSync(claudeBin, ["mcp", "remove", "--scope", "local", AGY_SERVER], { cwd: folder, env: env(), stdio: "pipe", timeout: 30_000 }); } catch { /* already gone */ }
    const proj = join(homedir(), ".claude", "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    if (process.env.CREWGLASS_E2E_KEEP !== "1" && /crewglass-e2e-[A-Za-z0-9]{6}$/.test(proj)) rmSync(proj, { recursive: true, force: true });
    else console.log("kept transcripts:", proj);
  });

  it("\"Have gemini-reviewer check this\" shows agy · Gemini live, and Gemini tokens separately", async () => {
    const out = await claude(folder, "Have gemini-reviewer check this: is 2 + 2 equal to 4? It should answer in one word. Then tell me its answer.",
      ["--allowedTools", `Agent,${AGY_TOOL}`]);
    await deck.poll();
    const snap = deck.snapshot();
    const a = snap.agents.find((x) => x.name === "gemini-reviewer")!;
    console.log("result:", String(JSON.parse(out || "{}").result ?? out).slice(0, 300));
    console.log("card:", { kind: a.kind, relay: a.model, gemini: a.gemini }, "| running seen:", seen.filter((x) => x.status === "running").slice(0, 2),
      "| folder agy:", snap.agy, "| bridge shown as a server:", snap.mcps.some((m) => m.name === AGY_SERVER));
    expect(a.kind).toBe("agy");
    expect(a.gemini).toMatchObject({ model: GEMINI, callsToday: 1 });
    expect(a.gemini!.tokensToday).toBeGreaterThan(0);
    expect(seen.some((x) => x.status === "running" && x.model === GEMINI)).toBe(true);
    expect(snap.mcps.some((m) => m.name === AGY_SERVER)).toBe(false);
    expect(snap.agy.tokensToday).toBe(a.gemini!.tokensToday);
  }, 400_000);
});
