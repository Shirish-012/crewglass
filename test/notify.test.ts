// "Claude finished" Mac notifications, and what counts as Claude using agy.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { assistant, encode, jsonl, tempDir, toolResult, toolUse, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { Alerts } = await import("../src/main/alerts");
const { FolderTranscripts } = await import("../src/main/sources/transcripts");
const { Scope } = await import("../src/main/scope");
const { cleanSettingsPatch } = await import("../src/main/settings");

function run(statuses: string[], opts: { finishedAfterMs?: number; source?: string; gapMs?: number } = {}) {
  const a = new Alerts();
  const pops: string[] = [];
  const realNow = Date.now;
  let t = realNow();
  try {
    for (const status of statuses) {
      Date.now = () => t;
      a.evaluate({ folderName: "app", sessions: [{ id: "s1", name: "agent-app-1", status, usd: 0, contextPct: 0, source: opts.source }],
        todayUsd: 0, limits: { session: 1e9, day: 1e10 }, failStreaks: [], finishedAfterMs: opts.finishedAfterMs ?? 0 }, (title, body, _id, kind) => pops.push(`${kind}|${title}|${body}`));
      t += opts.gapMs ?? 1000;
    }
  } finally { Date.now = realNow; }
  return pops;
}

describe("Claude finished — Mac notification", () => {
  it("fires when Claude goes from working to idle, after every task", () => {
    expect(run(["busy", "busy", "idle"])).toEqual(["finished|Claude finished in app|agent-app-1 is waiting for your next message."]);
  });
  it("says how long it worked for longer tasks, and fires again for the next task (no cooldown)", () => {
    const pops = run(["busy", "idle", "busy", "idle"], { gapMs: 90_000 });
    expect(pops).toHaveLength(2);
    expect(pops[0]).toMatch(/worked for 2 min and is waiting/);
  });
  it("doesn't fire while Claude waits for your permission — only once it's really idle", () => {
    expect(run(["busy", "waiting", "busy", "idle"])).toHaveLength(1);
    expect(run(["busy", "waiting"])).toEqual([]);
  });
  it("doesn't fire after you pressed Stop, or for pipeline steps (the pipeline tells you once)", () => {
    expect(run(["busy", "stopping", "stopped", "idle"])).toEqual([]);
    expect(run(["busy", "idle"], { source: "pipeline" })).toEqual([]);
  });
  it("'only longer tasks' skips quick ones", () => {
    expect(run(["busy", "idle"], { finishedAfterMs: 120_000 })).toEqual([]);
    expect(run(["busy", "idle"], { finishedAfterMs: 120_000, gapMs: 130_000 })).toHaveLength(1);
  });
  it("the setting is a plain on/off", () => {
    expect(cleanSettingsPatch({ notifyEveryFinish: false })).toEqual({ notifyEveryFinish: false });
    expect(cleanSettingsPatch({ notifyEveryFinish: "yes" })).toEqual({});
  });
});

describe("what counts as Claude using agy", () => {
  it("only an agy run that sends Gemini a task — not --help, models or --version", async () => {
    const folder = tempDir("agy-detect-");
    const cmds = ["agy --help 2>&1 | head -80", "agy models", "agy --version", "cd x && agy -p 'review this' --model gemini-3.8-flash-low", "echo hi | agy --print"];
    write(join(home, ".claude", "projects", encode(folder), "s1.jsonl"), jsonl([
      { type: "user", cwd: folder, timestamp: new Date().toISOString(), message: { content: "go" } },
      ...cmds.flatMap((c, i) => [assistant(`m${i}`, { cwd: folder, tools: [toolUse(`b${i}`, "Bash", { command: c })] }), toolResult(`b${i}`)]),
    ]));
    const t = new FolderTranscripts(new Scope(folder));
    await t.poll();
    expect(t.agy.get("session:s1")).toMatchObject({ callsToday: 2, model: "gemini-3.8-flash-low" });
  });
});
