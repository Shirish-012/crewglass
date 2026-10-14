// agy agents: the bundled bridge (run for real against a fake `agy`, so nothing reaches Google), the report line,
// the transcript reader, agent files and the save planner.
import { describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assistant, encode, jsonl, tempDir, toolUse, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { AGY_TOOL, agyRelayInstructions, geminiFromInstructions, geminiLabel, parseAgyReport } = await import("@shared/agy");
const { planSave } = await import("../src/main/writers/savePlan");
const { parseAgyModels } = await import("../src/main/agyEnv");
const { FolderTranscripts } = await import("../src/main/sources/transcripts");
const { readAgentFiles } = await import("../src/main/sources/agentFiles");
const { renderAgentFile, agentTools } = await import("@shared/agentFile");
const { Scope } = await import("../src/main/scope");
const { treeFrom } = await import("../src/main/sources/processes");

const BRIDGE = join(__dirname, "..", "resources", "agy-bridge", "agy-bridge.mjs");

/** A stand-in for agy: records its arguments, then prints what real agy prints with --output-format json. */
function fakeAgy(output: string, exitCode = 0) {
  const dir = tempDir("fake-agy-");
  const bin = join(dir, "agy");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${dir}/args"\ncat <<'JSON'\n${output}\nJSON\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { bin, args: () => readFileSync(join(dir, "args"), "utf8").split("\0") };
}

/** Talks MCP to the bridge: sends each request, collects each reply by id. */
async function mcp(agyPath: string, requests: object[]): Promise<Map<number, Record<string, unknown>>> {
  const p = spawn(process.execPath, [BRIDGE, "--agy", agyPath], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map<number, Record<string, unknown>>();
  let buf = "";
  const want = requests.filter((r) => "id" in r).length;
  await new Promise<void>((resolve) => {
    p.stdout.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        replies.set(m.id, m);
        if (replies.size === want) resolve();
      }
    });
    for (const r of requests) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
  p.stdin.end();
  return replies;
}
const call = (id: number, args: object) => ({ id, method: "tools/call", params: { name: "ask_agy", arguments: args } });
const textOf = (r: Record<string, unknown>) => ((r.result as { content: { text: string }[] }).content[0].text);

describe("agy bridge (MCP over stdin/stdout)", () => {
  const ok = JSON.stringify({ status: "SUCCESS", response: "Looks correct.\n", duration_seconds: 4.5, usage: { input_tokens: 11878, output_tokens: 39, thinking_tokens: 35 } });

  it("answers initialize and lists one tool", async () => {
    const r = await mcp("/bin/false", [
      { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "nope" },
    ]);
    expect(r.get(1)?.result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
    expect((r.get(2)?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["ask_agy"]);
    expect(r.get(3)?.error).toMatchObject({ code: -32601 });
  });

  it("runs agy with the prompt as one argument, sandboxed, on the chosen Gemini model — and adds the report line", async () => {
    const agy = fakeAgy(ok);
    const r = await mcp(agy.bin, [call(1, { prompt: "Is 2+2=4? $(rm -rf ~) `x`", model: "gemini-3.8-flash-low", effort: "low" })]);
    const args = agy.args();
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("Is 2+2=4? $(rm -rf ~) `x`"); // passed as data, never through a shell
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json", "--sandbox", "--model", "gemini-3.8-flash-low", "--effort", "low"]));
    const text = textOf(r.get(1)!);
    expect(text).toMatch(/^Looks correct\./);
    expect(parseAgyReport(text)).toEqual({ model: "gemini-3.8-flash-low", seconds: expect.any(Number), in: 11878, out: 39, thinking: 35, status: "SUCCESS" });
  });

  it("refuses non-Gemini models and empty prompts without running agy", async () => {
    const agy = fakeAgy(ok);
    const r = await mcp(agy.bin, [call(1, { prompt: "hi", model: "claude-opus-4-6-thinking" }), call(2, { prompt: " " }), call(3, { prompt: "hi", model: "gemini-x --dangerously-skip-permissions" })]);
    for (const id of [1, 2, 3]) expect((r.get(id)?.result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r.get(1)!)).toMatch(/not a Gemini model/);
    expect(() => agy.args()).toThrow(); // agy never ran
  });

  it("reports a failed agy run as an error, still with the report line", async () => {
    const agy = fakeAgy(JSON.stringify({ status: "ERROR", response: "quota exceeded" }), 1);
    const r = await mcp(agy.bin, [call(1, { prompt: "hi" })]);
    expect((r.get(1)?.result as { isError?: boolean }).isError).toBe(true);
    expect(parseAgyReport(textOf(r.get(1)!))).toMatchObject({ model: "agy-default", status: "ERROR", in: 0 });
  });
});

describe("agy helpers", () => {
  it("labels Gemini ids and reads the relay's model back from its instructions", () => {
    expect(geminiLabel("gemini-3.8-flash-low")).toBe("Gemini 3.8 Flash · low");
    expect(geminiLabel("gemini-3.1-pro-high")).toBe("Gemini 3.1 Pro · high");
    expect(geminiFromInstructions(agyRelayInstructions("gemini-3.1-pro-high"))).toBe("gemini-3.1-pro-high");
  });
  it("keeps only Gemini ids from `agy models`", () => {
    expect(parseAgyModels("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude\ngpt-oss-120b-medium\tGPT\n"))
      .toEqual(["gemini-3.8-flash-high"]);
  });
  it("writes a relay agent whose only tool is the bridge, and reads it back as an agy agent", () => {
    const folder = tempDir("agy-files-");
    const relay = {
      key: "project:.claude/agents/gemini-reviewer.md", name: "gemini-reviewer", kind: "agy" as const, scope: "project" as const, file: ".claude/agents/gemini-reviewer.md",
      role: "Use for a second opinion from Gemini.", instructions: agyRelayInstructions("gemini-3.1-pro-high"), model: "haiku", maxTurns: 3,
      toolAccess: "inherit" as const, builtinTools: [], keepPrivate: true, geminiModel: "gemini-3.1-pro-high", checks: [], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [],
    };
    expect(agentTools(relay, { mcpServers: [], canCallAgents: false })).toEqual([AGY_TOOL]);
    write(join(folder, ".claude/agents/gemini-reviewer.md"), renderAgentFile(relay, { mcpServers: [], canCallAgents: false }));
    const back = readAgentFiles(folder).project[0].agent;
    expect(back).toMatchObject({ kind: "agy", geminiModel: "gemini-3.1-pro-high", model: "haiku", maxTurns: 3 });
  });
});

describe("agy in transcripts", () => {
  it("shows the model the bridge reported and counts Gemini tokens apart from Claude's, and calls per turn", async () => {
    const folder = tempDir("agy-folder-");
    const proj = join(home, ".claude", "projects", encode(folder));
    const report = "Looks fine.\n\n[crewglass:agy] model=gemini-3.1-pro-high seconds=12.3 in=11000 out=500 thinking=200 status=SUCCESS";
    const result = (id: string, text: string) => ({ type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
    write(join(proj, "s1.jsonl"), jsonl([
      { type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content: "review this" } },
      assistant("m1", { cwd: folder, tools: [toolUse("b1", "Bash", { command: "agy -p 'hi' --model gemini-3.8-flash-low" })] }),
      assistant("m2", { cwd: folder, tools: [toolUse("b2", "Bash", { command: "agy -p 'again'" })] }),
    ]));
    write(join(proj, "s1", "subagents", "agent-r1.meta.json"), { agentType: "gemini-reviewer" });
    write(join(proj, "s1", "subagents", "agent-r1.jsonl"), jsonl([
      assistant("r1", { model: "claude-haiku-4-5-20251001", sidechain: true, tools: [toolUse("g1", AGY_TOOL, { prompt: "secret task", model: "gemini-3.1-pro-high" })] }),
      result("g1", report),
      assistant("r2", { model: "claude-haiku-4-5-20251001", sidechain: true, tools: [toolUse("g2", AGY_TOOL, { prompt: "secret task 2", model: "gemini-3.1-pro-high" })] }),
      result("g2", report),
    ]));
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    expect(t.agy.get("gemini-reviewer")).toMatchObject({ model: "gemini-3.1-pro-high", callsToday: 2, tokensToday: 23400, lastSeconds: 12.3, pendingSince: null });
    expect(t.agy.get("session:s1")).toMatchObject({ model: "gemini-3.8-flash-low", callsToday: 2 });
    expect(t.agyTokensToday).toBe(23400);
    expect(t.agyBursts.get("s1")?.count).toBe(4);
    expect(JSON.stringify([...t.agy.values()])).not.toContain("secret");
    expect(t.relayRunsWithoutAgy(new Set(["gemini-reviewer"]))).toEqual([]);
    // Your next message starts a new turn; a background agent's notification doesn't.
    const more = (content: string) => { const p = join(proj, "s1.jsonl"); write(p, readFileSync(p, "utf8") + jsonl([{ type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content } }])); };
    more("<task-notification>done</task-notification>");
    await t.poll();
    expect(t.agyBursts.get("s1")?.count).toBe(4);
    more("thanks, next task");
    await t.poll();
    expect(t.agyBursts.has("s1")).toBe(false);
  });
});

describe("a relay that answers by itself", () => {
  it("is flagged, because the answer didn't come from Gemini", async () => {
    const folder = tempDir("agy-skip-");
    const proj = join(home, ".claude", "projects", encode(folder));
    write(join(proj, "s1.jsonl"), jsonl([{ type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content: "check" } }, assistant("m1", { cwd: folder })]));
    write(join(proj, "s1", "subagents", "agent-r9.meta.json"), { agentType: "gemini-reviewer" });
    write(join(proj, "s1", "subagents", "agent-r9.jsonl"), jsonl([assistant("r1", { model: "claude-haiku-4-5-20251001", sidechain: true })])); // text only, no agy call
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    expect(t.relayRunsWithoutAgy(new Set(["gemini-reviewer"]))).toEqual([{ id: "r9", agentType: "gemini-reviewer", at: expect.any(Number) }]);
  });
});

describe("saving a team with an agy agent", () => {
  const relay = (extra: object = {}) => ({
    key: "project:.claude/agents/gemini-reviewer.md", name: "gemini-reviewer", kind: "agy" as const, scope: "project" as const, file: ".claude/agents/gemini-reviewer.md",
    role: "Second opinion.", instructions: agyRelayInstructions("gemini-3.1-pro-high"), model: "haiku", maxTurns: 3, toolAccess: "inherit" as const, builtinTools: [],
    keepPrivate: false, geminiModel: "gemini-3.1-pro-high", checks: [], status: "idle" as const, parallel: 0, tokens: 0, calls: 0, skillsUsed: [], ...extra,
  });
  const design = (agents: object[]) => ({ agents, mcps: [], links: [], orchestratorKey: null, orchestratorPaused: false, checks: {}, deletedKeys: [], removedMcpKeys: [] }) as never;
  const env = { node: "/opt/homebrew/bin/node", bridge: `${home}/Library/Application Support/Crewglass/bin/agy-bridge.mjs`, agy: `${home}/.local/bin/agy` };

  it("registers the bridge privately for the folder, once", () => {
    const folder = tempDir("agy-save-");
    const plan = planSave(folder, design([relay()]), env);
    expect(plan.commands).toEqual([{
      label: "claude mcp add --scope local crewglass-agy -- /opt/homebrew/bin/node ~/Library/Application Support/Crewglass/bin/agy-bridge.mjs --agy ~/.local/bin/agy",
      argv: ["mcp", "add", "--scope", "local", "crewglass-agy", "--", env.node, env.bridge, "--agy", env.agy],
    }]);
    expect(plan.warnings.join(" ")).toMatch(/shared through git, but the agy bridge exists only on this Mac/);
    // Already registered for this folder (in ~/.claude.json): nothing to run.
    write(join(home, ".claude.json"), { projects: { [folder]: { mcpServers: { "crewglass-agy": { type: "stdio", command: "node", args: [] } } } } });
    expect(planSave(folder, design([relay({ keepPrivate: true })]), env).commands).toEqual([]);
  });

  it("says what's missing instead of registering a bridge that can't work", () => {
    const folder = tempDir("agy-save-");
    const plan = planSave(folder, design([relay()]), { ...env, agy: null });
    expect(plan.commands).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/need agy/);
    expect(() => planSave(folder, design([relay({ geminiModel: "claude-opus-5-5" })]), env)).toThrow(/isn't a Gemini model/);
  });
});

describe("standalone agy / Gemini never appears", () => {
  it("lists agy only when a Claude session in the folder started it", () => {
    const row = (pid: number, ppid: number, comm: string) => ({ pid, ppid, cpu: 0, rssKb: 1024, comm });
    const rows = [row(100, 1, "claude"), row(101, 100, "node"), row(102, 101, "agy"), row(200, 1, "zsh"), row(201, 200, "agy"), row(300, 1, "gemini")];
    const tree = treeFrom(rows, [100], []);
    expect(tree.map((r) => r.pid)).toEqual([100, 101, 102]);
    expect(tree.find((r) => r.pid === 102)?.kind).toBe("agy");
  });
});
