import { describe, expect, it } from "vitest";
import { LiveEngine, ORCH_REASON, PAUSED_REASON, STOP_REASON, Waiting, type Answer, type CheckService, type HookMsg } from "../src/main/live/liveEngine";

const FOLDER = "/work/agent app";
const mk = (opts = {}) => {
  const popups: string[] = [];
  const e = new LiveEngine((t, b) => popups.push(`${t} | ${b}`), () => "agent app", (cwd) => !!cwd && (cwd === FOLDER || cwd.startsWith(FOLDER + "/")), opts);
  return { e, popups };
};
const ev = (event: string, extra: Partial<HookMsg> = {}): HookMsg => ({ event, session_id: "s1", cwd: FOLDER, ...extra });
const bash = (command: string) => ({ tool_name: "Bash", command });

describe("Stop", () => {
  it("answers the next tool call with continue:false plus a deny, then stops after the current call", () => {
    const { e } = mk();
    e.handle(ev("UserPromptSubmit"));
    e.stop(["s1"]);
    const pre = e.handle(ev("PreToolUse", bash("npm test")));
    expect(pre.print).toMatchObject({ continue: false, stopReason: STOP_REASON, hookSpecificOutput: { permissionDecision: "deny" } });
    expect(e.statusOf("s1")).toBe("stopping");
    expect(e.handle(ev("PostToolUse", bash("ls"))).print).toMatchObject({ continue: false });
    expect(e.statusOf("s1")).toBe("stopped");
  });
  it("also stops subagents (their events carry the same session)", () => {
    const { e } = mk();
    e.stop(["s1"]);
    expect(e.handle(ev("PreToolUse", { ...bash("x"), agent_id: "a1", agent_type: "coder" })).print).toMatchObject({ continue: false });
  });
  it("clears on your next real message, but not on a subagent's task notification", () => {
    const { e } = mk();
    e.stop(["s1"]);
    e.handle(ev("UserPromptSubmit", { task_notification: true }));
    expect(e.handle(ev("PreToolUse", bash("x"))).print).toBeDefined();
    e.handle(ev("UserPromptSubmit", { task_notification: false }));
    expect(e.handle(ev("PreToolUse", bash("x"))).print).toBeUndefined();
  });
  it("ignores (and allows) events from outside the folder", () => {
    const { e } = mk();
    e.stop(["s1"]);
    expect(e.handle({ event: "PreToolUse", session_id: "s1", cwd: "/elsewhere", ...bash("x") })).toEqual({});
  });
});

describe("failing-command breaker", () => {
  const fail3 = (e: LiveEngine, cmd = "npm run build") => { for (let i = 0; i < 3; i++) { e.handle(ev("PreToolUse", bash(cmd))); e.handle(ev("PostToolUseFailure", bash(cmd))); } };

  it("pauses the exact command on the 3rd failure in a row, with a pop-up that doesn't contain the command", () => {
    const { e, popups } = mk();
    fail3(e);
    expect(e.items[0]).toMatchObject({ kind: "failing-command", popup: true });
    expect(popups).toHaveLength(1);
    expect(popups[0]).not.toContain("npm run build");
    expect(e.handle(ev("PreToolUse", bash("npm run build"))).print).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: PAUSED_REASON } });
    expect(e.handle(ev("PreToolUse", bash("npm run lint"))).print).toBeUndefined(); // other work continues
  });
  it("doesn't count fix-and-retest cycles (a file edit in between resets the count)", () => {
    const { e } = mk();
    for (let i = 0; i < 4; i++) {
      e.handle(ev("PostToolUseFailure", bash("npm test")));
      e.handle(ev("PostToolUse", { tool_name: "Edit", file_path: `${FOLDER}/a.ts` }));
    }
    expect(e.items).toHaveLength(0);
  });
  it("choice: let the orchestrator handle it → keeps it paused with a 'find the root cause' reason", () => {
    const { e } = mk();
    fail3(e);
    e.resolve(e.items[0].id, "orchestrator");
    expect(e.handle(ev("PreToolUse", bash("npm run build"))).print).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: ORCH_REASON } });
    expect(e.items[0].resolved).toBe("Handed to the orchestrator");
  });
  it("choice: give instructions → your text reaches Claude once, at the next tool event", () => {
    const { e } = mk();
    fail3(e);
    e.resolve(e.items[0].id, "instructions", "set NODE_ENV=production first");
    const next = e.handle(ev("PostToolUse", bash("git status")));
    expect(JSON.stringify(next.print)).toContain("set NODE_ENV=production first");
    expect(e.handle(ev("PostToolUse", bash("git status"))).print).toBeUndefined();
  });
  it("choice: allow retries → unpauses and resets the count", () => {
    const { e } = mk();
    fail3(e);
    e.resolve(e.items[0].id, "allow");
    expect(e.handle(ev("PreToolUse", bash("npm run build"))).print).toBeUndefined();
  });
  it("choice: stop Claude", () => {
    const { e } = mk();
    fail3(e);
    e.resolve(e.items[0].id, "stop");
    expect(e.handle(ev("PreToolUse", bash("ls"))).print).toMatchObject({ continue: false });
  });
});

describe("permission waits", () => {
  it("pops up only if Claude is still waiting after 20 s, and resolves when answered", () => {
    const { e, popups } = mk();
    e.handle(ev("Notification", { notification_type: "permission_prompt" }), 1000);
    e.tick(15_000);
    expect(popups).toHaveLength(0);
    e.tick(21_500);
    expect(popups).toHaveLength(1);
    expect(e.statusOf("s1")).toBe("waiting");
    e.handle(ev("PostToolUse", bash("git push")), 30_000);
    expect(e.statusOf("s1")).toBe("busy");
    expect(e.items[0].resolved).toBe("Answered");
  });
  it("no pop-up when answered within 20 s", () => {
    const { e, popups } = mk();
    e.handle(ev("PermissionRequest", { tool_name: "Bash" }), 0);
    e.handle(ev("PostToolUse", bash("x")), 5000);
    e.tick(25_000);
    expect(popups).toHaveLength(0);
  });
});

describe("subagents", () => {
  it("tracks running subagents, including parallel copies", () => {
    const { e } = mk();
    e.handle(ev("SubagentStart", { agent_id: "a", agent_type: "coder" }));
    e.handle(ev("SubagentStart", { agent_id: "b", agent_type: "coder" }));
    expect(e.runningAgents().get("coder")).toBe(2);
    e.handle(ev("SubagentStop", { agent_id: "a", agent_type: "coder" }));
    expect(e.runningAgents().get("coder")).toBe(1);
  });
});

describe("direct calls between subagents (D18)", () => {
  type State = "allowed" | "orchestrator" | "you" | "blocked";
  const rules = (links: Record<string, State> = {}, costly: string[] = []) => () => ({
    state: (f: string, t: string) => links[`${f}>${t}`],
    costly: (t: string) => costly.includes(t),
    model: (t: string) => (t === "architect" ? "Opus 5.5 · high" : "Sonnet 5 · medium"),
  });
  const mkD = (r = rules(), approvalMs = 50) => {
    const popups: string[] = [];
    const e = new LiveEngine((t, b) => popups.push(`${t} | ${b}`), () => "agent app", () => true, { approvalMs }, r);
    return { e, popups };
  };
  const call = (from: string, to: string, reason?: string, agentId = `id-${from}`) =>
    ev("PreToolUse", { tool_name: "Agent", agent_id: agentId, agent_type: from, subagent_type: to, ...(reason !== undefined ? { call_reason: reason } : {}) });
  const decision = (a: unknown) => (a as { print?: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } }).print?.hookSpecificOutput;
  const spawn = (e: LiveEngine, type: string, id: string) => e.handle(ev("SubagentStart", { agent_id: id, agent_type: type }));

  it("refuses a call without a clear Reason: line", () => {
    const { e } = mkD(rules({ "coder>tester": "allowed" }));
    expect(decision(e.handle(call("coder", "tester")))?.permissionDecisionReason).toMatch(/Reason:/);
    expect(decision(e.handle(call("coder", "tester", "tests")))?.permissionDecision).toBe("deny"); // too vague
  });
  it("lets a link you drew as Allowed straight through", () => {
    const { e } = mkD(rules({ "coder>tester": "allowed" }));
    expect(e.handle(call("coder", "tester", "run the integration tests on my change"))).toEqual({});
  });
  it("blocks a link you marked Blocked", () => {
    const { e } = mkD(rules({ "coder>tester": "blocked" }));
    expect(decision(e.handle(call("coder", "tester", "run the integration tests on my change")))?.permissionDecisionReason).toMatch(/not allowed/);
  });
  it("honours the orchestrator's Allowed calls: grant for that agent, and forgets it on the next brief without one", () => {
    const { e } = mkD();
    e.handle(ev("PreToolUse", { tool_name: "Agent", subagent_type: "coder", allowed_calls: ["tester"] }));
    expect(e.handle(call("coder", "tester", "run the integration tests on my change"))).toEqual({});
    e.handle(ev("PreToolUse", { tool_name: "Agent", subagent_type: "coder" }));
    expect(decision(e.handle(call("coder", "tester", "run the integration tests on my change")))?.permissionDecisionReason).toMatch(/REQUEST tester:/);
  });
  it("sends anything else that isn't costly to the orchestrator as a REQUEST", () => {
    const { e, popups } = mkD();
    expect(decision(e.handle(call("coder", "tester", "run the integration tests on my change")))?.permissionDecisionReason).toMatch(/REQUEST tester:/);
    expect(popups).toEqual([]);
  });
  it("makes a costly call wait for you: Approve once", async () => {
    const { e, popups } = mkD(rules({}, ["architect"]), 5000);
    const p = e.handle(call("coder", "architect", "need a design decision on the cache layer"));
    expect(p).toBeInstanceOf(Waiting);
    expect(popups[0]).toMatch(/needs your OK/);
    expect(popups[0]).not.toMatch(/cache layer/); // no work text in notifications
    const item = e.items.find((i) => i.kind === "approval")!;
    expect(item.data).toMatchObject({ caller: "coder", callee: "architect", model: "Opus 5.5 · high" });
    e.resolve(item.id, "once");
    expect(await (p as Waiting).answer).toEqual({});
    expect(e.items.find((i) => i.id === item.id)?.resolved).toBe("Approved once");
  });
  it("Always allow takes effect at once for later calls", async () => {
    const { e } = mkD(rules({}, ["architect"]), 5000);
    const p = e.handle(call("coder", "architect", "need a design decision on the cache layer"));
    e.resolve(e.items[0].id, "always");
    expect(await (p as Waiting).answer).toEqual({});
    expect(e.handle(call("coder", "architect", "and one more question on the schema"))).toEqual({});
  });
  it("Deny + note gives the agent your note; Send to orchestrator turns it into a REQUEST", async () => {
    const { e } = mkD(rules({}, ["architect"]), 5000);
    const p1 = e.handle(call("coder", "architect", "need a design decision on the cache layer"));
    e.resolve(e.items[0].id, "deny", "use the existing LRU");
    expect(decision(await (p1 as Waiting).answer)?.permissionDecisionReason).toMatch(/use the existing LRU/);
    const p2 = e.handle(call("coder", "architect", "need a design decision on the cache layer", "id-coder-2"));
    e.resolve(e.items[0].id, "orchestrator");
    expect(decision(await (p2 as Waiting).answer)?.permissionDecisionReason).toMatch(/REQUEST architect:/);
  });
  it("with no answer in time, the call goes to the orchestrator", async () => {
    const { e } = mkD(rules({}, ["architect"]), 30);
    const p = e.handle(call("coder", "architect", "need a design decision on the cache layer"));
    expect(decision(await (p as Waiting).answer)?.permissionDecisionReason).toMatch(/didn't answer in time.*REQUEST architect:/);
    expect(e.items[0].resolved).toMatch(/orchestrator/);
  });
  it("a link marked Needs your OK waits for you even when the agent isn't costly", () => {
    const { e } = mkD(rules({ "coder>tester": "you" }), 5000);
    expect(e.handle(call("coder", "tester", "run the integration tests on my change"))).toBeInstanceOf(Waiting);
    e.resolve(e.items[0].id, "deny");
  });
  it("allows at most 3 direct calls per agent run and 2 levels deep", () => {
    const { e } = mkD(rules({ "coder>tester": "allowed", "tester>linter": "allowed", "linter>fmt": "allowed" }));
    spawn(e, "coder", "c1");
    for (let n = 0; n < 3; n++) expect(e.handle(call("coder", "tester", "run the integration tests on my change", "c1"))).toEqual({});
    expect(decision(e.handle(call("coder", "tester", "run the integration tests on my change", "c1")))?.permissionDecisionReason).toMatch(/at most 3/);
    // coder (depth 1) → tester (2) → linter (3); linter may not call further.
    const { e: e2 } = mkD(rules({ "coder>tester": "allowed", "tester>linter": "allowed", "linter>fmt": "allowed" }));
    spawn(e2, "coder", "c1");
    e2.handle(call("coder", "tester", "run the integration tests on my change", "c1")); spawn(e2, "tester", "t1");
    expect(e2.handle(call("tester", "linter", "lint the files I just changed please", "t1"))).toEqual({}); spawn(e2, "linter", "l1");
    expect(decision(e2.handle(call("linter", "fmt", "format the files I just linted please", "l1")))?.permissionDecisionReason).toMatch(/2 levels deep/);
  });
  it("the orchestrator's own hand-offs are never treated as direct calls", () => {
    const { e } = mkD(rules({}, ["architect"]));
    expect(e.handle(ev("PreToolUse", { tool_name: "Agent", subagent_type: "architect" }))).toEqual({});
  });
});

describe("command checks (D8)", () => {
  const def = (label: string) => ({ key: label, label, command: label });
  const mkC = (results: boolean[], checksOf: Record<string, string[]> = { coder: ["npm test"] }) => {
    const popups: string[] = [];
    let i = 0;
    const ran: string[] = [];
    const svc: CheckService = {
      checksFor: (n) => (checksOf[n] ?? []).map(def),
      run: async (d, cwd) => { ran.push(`${d.label}@${cwd}`); const ok = results[Math.min(i++, results.length - 1)]; return { key: d.key, label: d.label, ok, exitCode: ok ? 0 : 1, timedOut: false, ms: 5, tail: ok ? "" : "expected 42, got 41" }; },
    };
    const e = new LiveEngine((t, b) => popups.push(`${t} | ${b}`), () => "agent app", () => true, {}, () => null, svc);
    return { e, popups, ran };
  };
  const edit = (e: LiveEngine, agentId?: string) => e.handle(ev("PostToolUse", { tool_name: "Edit", file_path: "a.ts", ...(agentId ? { agent_id: agentId, agent_type: "coder" } : {}) }));
  const subStop = (e: LiveEngine) => e.handle(ev("SubagentStop", { agent_id: "c1", agent_type: "coder" }));
  const answer = async (a: Answer | Waiting) => (a instanceof Waiting ? a.answer : a);

  it("runs only when the agent changed files", async () => {
    const { e, ran } = mkC([true]);
    e.handle(ev("SubagentStart", { agent_id: "c1", agent_type: "coder" }));
    expect(subStop(e)).toEqual({});
    expect(ran).toEqual([]);
  });

  it("a passing check lets the agent finish and tells the orchestrator on its Agent result", async () => {
    const { e, ran } = mkC([true]);
    edit(e, "c1");
    const a = subStop(e);
    expect(a).toBeInstanceOf(Waiting);
    expect(await answer(a)).toEqual({});
    expect(ran).toEqual([`npm test@${FOLDER}`]);
    expect(e.checkStates.get("coder")).toMatchObject({ state: "passed", tries: 0 });
    const note = e.handle(ev("PostToolUse", { tool_name: "Agent" })) as Answer;
    expect(JSON.stringify(note.print)).toContain("coder passed npm test");
  });

  it("a failing check sends the agent back twice, then you and the orchestrator are told", async () => {
    const { e, popups } = mkC([false]);
    edit(e, "c1");
    const r1 = (await answer(subStop(e))).print as { decision: string; reason: string };
    expect(r1.decision).toBe("block");
    expect(r1.reason).toMatch(/fix round 1 of 2[\s\S]*expected 42, got 41/);
    // Even without new edits, the retry is checked again (an agent can't skip its checks by not editing).
    const r2 = (await answer(subStop(e))).print as { decision: string; reason: string };
    expect(r2.reason).toMatch(/fix round 2 of 2/);
    expect(e.checkStates.get("coder")).toMatchObject({ state: "failed", tries: 2 });
    expect(await answer(subStop(e))).toEqual({}); // the agent may stop now
    expect(e.items.find((i) => i.kind === "check-failed")?.title).toBe("coder still fails npm test after 2 fix rounds");
    expect(popups.join(" ")).not.toMatch(/expected 42/); // no work text in notifications
    // Background agent: the note rides on the task notification instead.
    const n = e.handle(ev("UserPromptSubmit", { task_notification: true })) as Answer;
    expect(JSON.stringify(n.print)).toMatch(/coder FAILED `npm test` failed \(exit code 1\) after 2 fix rounds/);
  });

  it("an agent that runs out of turns while fixing: you and the orchestrator are told when its Agent call returns", async () => {
    const { e } = mkC([false]);
    edit(e, "c1");
    await answer(subStop(e)); // sent back (round 1) … then it hits maxTurns: no SubagentStop
    const r = e.handle(ev("PostToolUse", { tool_name: "Agent", subagent_type: "coder" })) as Answer;
    expect(JSON.stringify(r.print)).toMatch(/coder FAILED .* after 1 fix round \(it ran out of turns while fixing\)/);
    expect(e.items.find((i) => i.kind === "check-failed")?.title).toBe("coder still fails npm test after 1 fix round (it ran out of turns while fixing)");
  });

  it("checks the orchestrator's own work at the end of its turn, but not while background agents still run", async () => {
    const { e, ran } = mkC([true], { lead: ["npm test"] });
    edit(e);
    expect(e.handle(ev("Stop", { agent_type: "lead", background_count: 1 }))).toEqual({});
    const a = e.handle(ev("Stop", { agent_type: "lead" }));
    expect(await answer(a)).toEqual({});
    expect(ran.length).toBe(1);
  });

  it("skips runs started by the pipeline (it runs checks itself) and runs outside the folder", async () => {
    const { e, ran } = mkC([true]);
    e.markPipeline("s1");
    edit(e, "c1");
    expect(subStop(e)).toEqual({});
    expect(ran).toEqual([]);
  });
});
