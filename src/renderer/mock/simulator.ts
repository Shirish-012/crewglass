// Fake live activity for the prototype: a short, looping story of the orchestrator handing work out,
// agents running, a direct call, a check passing, and tokens flowing. Phase 1 replaces this with
// real events from transcripts and hooks; the store fields it writes stay the same.

import type { Agent, AgentStatus, Effort } from "@shared/types";
import { activeOrchestrator, logActivity, toast, useDeck, type SeriesPoint } from "../state/store";

type Step = {
  status?: Record<string, AgentStatus>;
  live?: Record<string, { action: string; model: string; effort?: Effort }>;
  log?: { agent: string; tool: string; target: string; model: string; effort?: Effort; durationMs?: number; result?: "ok" | "error" };
  activeLinks?: string[];
  tokens?: Record<string, number>;
  check?: "checking" | "passed";
};

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

const STORY: Step[] = [
  { status: { "project:lead": "running" }, live: { "project:lead": { action: "Planning the next task", model: OPUS, effort: "high" } }, tokens: { "project:lead": 3800 } },
  { log: { agent: "lead", tool: "Agent", target: "→ coder: add message.id dedupe to the transcript reader", model: OPUS, effort: "high" }, activeLinks: ["project:lead>project:coder"], tokens: { "project:lead": 1200 } },
  { status: { "project:coder": "running" }, live: { "project:coder": { action: "Read src/main/sources/transcripts.ts", model: OPUS, effort: "medium" } }, log: { agent: "coder", tool: "Read", target: "src/main/sources/transcripts.ts", model: OPUS, effort: "medium", durationMs: 40 }, tokens: { "project:coder": 4200 } },
  { live: { "project:coder": { action: "Edit src/main/sources/transcripts.ts", model: OPUS, effort: "medium" } }, log: { agent: "coder", tool: "Edit", target: "src/main/sources/transcripts.ts", model: OPUS, effort: "medium", durationMs: 90 }, tokens: { "project:coder": 5100 } },
  { log: { agent: "coder", tool: "mcp__github__get_issue", target: "github · issue #12", model: OPUS, effort: "medium", durationMs: 620 }, activeLinks: ["project:coder>mcp:github"], tokens: { "project:coder": 2600 } },
  { live: { "project:coder": { action: "Bash npm test", model: OPUS, effort: "medium" } }, log: { agent: "coder", tool: "Bash", target: "npm test", model: OPUS, effort: "medium", durationMs: 8400 }, tokens: { "project:coder": 1900 } },
  { log: { agent: "coder", tool: "Agent", target: "→ tester · Reason: need the integration tests run against my change", model: OPUS, effort: "medium" }, activeLinks: ["project:coder>project:tester"], tokens: { "project:coder": 900 } },
  { status: { "project:tester": "running" }, live: { "project:tester": { action: "Write tests/transcripts.test.ts", model: SONNET, effort: "medium" } }, log: { agent: "tester", tool: "Write", target: "tests/transcripts.test.ts", model: SONNET, effort: "medium", durationMs: 70 }, tokens: { "project:tester": 3300 } },
  { log: { agent: "tester", tool: "Bash", target: "npx vitest run tests/transcripts.test.ts", model: SONNET, effort: "medium", durationMs: 5200 }, tokens: { "project:tester": 2100 } },
  { status: { "project:tester": "done" }, log: { agent: "tester", tool: "Result", target: "12 tests passed", model: SONNET, effort: "medium" }, tokens: { "project:tester": 600 } },
  { status: { "project:coder": "done" }, check: "checking", log: { agent: "Crewglass", tool: "Check", target: "coder: npm test (files changed)", model: "" }, tokens: {} },
  { log: { agent: "Crewglass", tool: "Check", target: "coder: npm test passed", model: "", durationMs: 9100 }, tokens: {} },
  { status: { "project:reviewer": "running" }, live: { "project:reviewer": { action: "Reviewing the diff", model: SONNET, effort: "high" } }, activeLinks: ["project:coder>project:reviewer"], log: { agent: "reviewer", tool: "Read", target: "git diff", model: SONNET, effort: "high", durationMs: 120 }, tokens: { "project:reviewer": 4400 } },
  { log: { agent: "reviewer", tool: "Result", target: "VERDICT: PASS", model: SONNET, effort: "high" }, status: { "project:reviewer": "done" }, check: "passed", tokens: { "project:reviewer": 800 } },
  { status: { "project:lead": "running" }, live: { "project:lead": { action: "Verifying results against the acceptance criteria", model: OPUS, effort: "high" } }, tokens: { "project:lead": 5200 } },
  { log: { agent: "lead", tool: "Result", target: "Task 2 of 4 done — verification table updated", model: OPUS, effort: "high" }, tokens: { "project:lead": 1600 } },
];

/** A plain chat with no team: the main session does everything itself (like this conversation). */
const SOLO_STORY: { action: string; tool: string; target: string; tokens: number; durationMs?: number }[] = [
  { action: "Read src/renderer/components/canvas/Canvas.tsx", tool: "Read", target: "src/renderer/components/canvas/Canvas.tsx", tokens: 3100, durationMs: 30 },
  { action: "Thinking about the change", tool: "", target: "", tokens: 5200 },
  { action: "Edit src/renderer/components/canvas/Canvas.tsx", tool: "Edit", target: "src/renderer/components/canvas/Canvas.tsx", tokens: 2400, durationMs: 60 },
  { action: "Bash npm run typecheck", tool: "Bash", target: "npm run typecheck", tokens: 900, durationMs: 6400 },
  { action: "Bash npm run smoke", tool: "Bash", target: "npm run smoke", tokens: 1100, durationMs: 18000 },
  { action: "Writing the reply", tool: "", target: "", tokens: 3800 },
];

const MODEL_OF: Record<string, string> = { "project:lead": OPUS, "project:coder": OPUS, "project:planner": OPUS, "project:tester": SONNET, "project:reviewer": SONNET };

export function simTick() {
  const s = useDeck.getState();
  const tick = s.tick + 1;
  const now = Date.now();

  // Approval deadlines and delayed permission pop-ups run even while stopped.
  for (const item of s.inbox) {
    if (item.resolved) continue;
    if (item.kind === "approval" && typeof item.data?.deadline === "number" && now >= item.data.deadline) {
      useDeck.setState((st) => ({ inbox: st.inbox.map((i) => (i.id === item.id ? { ...i, resolved: "No answer in 2 min — sent to the orchestrator" } : i)) }));
    }
    if (item.kind === "permission" && typeof item.data?.popupAt === "number" && now >= item.data.popupAt && !item.data.popped) {
      useDeck.setState((st) => ({ inbox: st.inbox.map((i) => (i.id === item.id ? { ...i, popup: true, data: { ...i.data, popped: true } } : i)) }));
      toast("Claude is still waiting for permission", "lead wants to run: git push origin crewglass. Answer it in VS Code.", item.id);
    }
  }

  // Check-failure scenario: try 1 → try 2 → failed for good.
  if (s.checkFailStage > 0 && tick % 3 === 0) {
    const stage = s.checkFailStage + 1;
    if (stage === 2) {
      useDeck.setState((st) => ({ checkFailStage: 2, links: st.links.map((l) => (l.kind === "checkedBy" && l.from === "project:coder" ? { ...l, check: { ...l.check!, state: "failed", tries: 2 } } : l)) }));
      logActivity({ agent: "coder", tool: "Check", target: "Reviewer verdict: FAIL — sent back to fix (try 2 of 2)", model: SONNET, effort: "high", result: "error" });
    } else {
      useDeck.setState({ checkFailStage: 0 });
      const id = `i${now}`;
      useDeck.setState((st) => ({ inbox: [{ id, kind: "check-failed", at: now, popup: true, title: "coder's work failed its check after 2 tries",
        detail: "Reviewer verdict: FAIL — missing test for empty transcripts. The orchestrator was told.", data: {} }, ...st.inbox] }));
      toast("coder's work failed its check after 2 tries", "Reviewer verdict: FAIL. The orchestrator was told.", id);
    }
  }

  if (s.stopFlag) {
    useDeck.setState({
      tick,
      sessions: s.sessions.map((x) => (x.status === "stopping" ? { ...x, status: "stopped" } : x)),
      agents: Object.fromEntries(Object.entries(s.agents).map(([k, a]) => [k, a.status === "running" ? { ...a, status: "stopped" as const, liveNow: undefined } : a])),
    });
    return;
  }
  if (s.sessions.some((x) => x.status === "waiting")) { useDeck.setState({ tick }); return; }

  if (!activeOrchestrator(s)) {
    const solo = SOLO_STORY[s.story % SOLO_STORY.length];
    const main = s.sessions[0];
    if (main && solo.tool) logActivity({ agent: "main session", tool: solo.tool, target: solo.target, model: main.model, effort: main.effort, durationMs: solo.durationMs, result: "ok" });
    let series = s.series;
    if (tick % 3 === 0 && main) {
      const last = series[series.length - 1];
      series = [...series.slice(-29), { t: last.t + 1, byModel: { [main.model]: Math.round(2400 + Math.random() * 1600) }, toolCalls: 2 + Math.round(Math.random() * 5), failures: 0 }];
    }
    useDeck.setState({
      tick, story: s.story + 1, series, todayTokens: s.todayTokens + solo.tokens,
      sessions: s.sessions.map((x, i) => (i === 0 ? { ...x, liveNow: solo.action, tokens: x.tokens + solo.tokens, contextTokens: Math.min(x.contextTokens + Math.round(solo.tokens * 0.4), 990_000) } : x)),
    });
    return;
  }

  const step = STORY[s.story % STORY.length];
  const agents: Record<string, Agent> = { ...s.agents };
  for (const [k, st] of Object.entries(step.status ?? {})) {
    if (!agents[k]) continue;
    agents[k] = { ...agents[k], status: st, parallel: st === "running" ? 1 : 0, liveNow: st === "running" ? agents[k].liveNow : undefined,
      calls: st === "running" && agents[k].status !== "running" ? agents[k].calls + 1 : agents[k].calls };
  }
  for (const [k, lv] of Object.entries(step.live ?? {})) if (agents[k]) agents[k] = { ...agents[k], liveNow: { ...lv, tokens: (agents[k].liveNow?.tokens ?? 0) } };
  let added = 0;
  const byModel: Record<string, number> = {};
  for (const [k, n] of Object.entries(step.tokens ?? {})) {
    if (!agents[k]) continue;
    const live = agents[k].liveNow;
    agents[k] = { ...agents[k], tokens: agents[k].tokens + n, liveNow: live ? { ...live, tokens: live.tokens + n } : live };
    added += n;
    const m = MODEL_OF[k] ?? OPUS;
    byModel[m] = (byModel[m] ?? 0) + n;
  }
  if (step.log) logActivity({ ...step.log, result: step.log.result ?? "ok" });

  const activeSet = new Set(step.activeLinks ?? []);
  const links = s.links.map((l) => {
    const active = activeSet.has(`${l.from}>${l.to}`);
    let next = active !== !!l.active ? { ...l, active } : l;
    if (active && l.observed) next = { ...next, observed: { ...l.observed, calls: l.observed.calls + 1, lastSeen: "now" } };
    if (step.check && l.kind === "checkedBy" && l.from === "project:coder" && s.checkFailStage === 0) next = { ...next, check: { ...l.check!, state: step.check, tries: 0 } };
    return next;
  });

  // One chart point every 3 ticks (a compressed "minute").
  let series = s.series;
  if (tick % 3 === 0) {
    const last = series[series.length - 1];
    const point: SeriesPoint = {
      t: last.t + 1,
      byModel: {
        [OPUS]: Math.round(2200 + Math.random() * 1400 + (byModel[OPUS] ?? 0) / 2),
        [SONNET]: Math.round(500 + Math.random() * 700 + (byModel[SONNET] ?? 0) / 2),
        "claude-haiku-4-5-20251001": Math.round(Math.random() * 200),
        "gemini-3.1-pro-high": 0,
      },
      toolCalls: 3 + Math.round(Math.random() * 6),
      failures: Math.random() < 0.08 ? 1 : 0,
    };
    series = [...series.slice(-29), point];
  }

  useDeck.setState({
    tick, story: s.story + 1, agents, links, series,
    todayTokens: s.todayTokens + added,
    sessions: s.sessions.map((x, i) => (i === 0 ? { ...x, tokens: x.tokens + added, contextTokens: Math.min(x.contextTokens + Math.round(added * 0.4), 990_000) } : x)),
    processes: s.processes.map((p) => ({ ...p, cpu: Math.max(0.2, Math.round((p.cpu + (Math.random() - 0.5) * 4) * 10) / 10) })),
  });
}
