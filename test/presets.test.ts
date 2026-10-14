// A team preset in a real folder only adds what's missing — it never removes or replaces your agents.
import { describe, expect, it } from "vitest";
import type { Agent } from "@shared/types";

const { useDeck, actions } = await import("../src/renderer/state/store");
const { designPayload } = await import("../src/renderer/state/payload");
const { CHAT_KEY } = await import("@shared/teamMap");

const mine: Agent = {
  key: "project:.claude/agents/coder.md", name: "coder", kind: "subagent", scope: "project", file: ".claude/agents/coder.md",
  role: "My own coder.", instructions: "My instructions.", model: "sonnet", effort: "low", toolAccess: "inherit", builtinTools: [],
  keepPrivate: false, checks: [], status: "idle", parallel: 0, tokens: 0, calls: 0, skillsUsed: [],
};
const other: Agent = { ...mine, key: "project:.claude/agents/db-expert.md", name: "db-expert", file: ".claude/agents/db-expert.md", role: "Databases." };

describe("team presets in a real folder", () => {
  it("adds the missing roles with hand-offs from your chat, reuses your coder, creates no orchestrator, and deletes nothing", () => {
    const design = { agents: { [mine.key]: mine, [other.key]: other }, mcps: {}, links: [], orchestratorKey: null, orchestratorPaused: false, checks: {} };
    useDeck.setState({ mode: "real", readOnly: false, ...structuredClone(design), saved: structuredClone(design), summaries: [], undoStack: [] });
    actions.applyPreset("plan-code-review");
    const s = useDeck.getState();
    expect(s.agents[mine.key]).toMatchObject({ role: "My own coder.", model: "sonnet" }); // untouched
    expect(s.agents[other.key]).toBeDefined();
    expect(Object.keys(s.agents).sort()).toEqual([
      ".claude/agents/coder.md", ".claude/agents/db-expert.md", ".claude/agents/planner.md", ".claude/agents/reviewer.md",
    ].map((f) => `project:${f}`));
    expect(s.orchestratorKey).toBeNull(); // your Claude Code chat leads
    const handOffs = s.links.filter((l) => l.kind === "delegates");
    expect(handOffs.every((l) => l.from === CHAT_KEY)).toBe(true);
    expect(handOffs.map((l) => l.to).sort()).toEqual([mine.key, "project:.claude/agents/planner.md", "project:.claude/agents/reviewer.md"]);
    expect(s.links).toContainEqual(expect.objectContaining({ from: mine.key, to: "project:.claude/agents/reviewer.md", kind: "checkedBy" }));
    expect(designPayload().deletedKeys).toEqual([]);
    expect(s.summaries).toEqual(["Set up the Plan → Code → Review team"]); // one step to undo
  });

  it("Code + Test + Review adds a private Gemini second opinion when agy is on this Mac", () => {
    const design = { agents: {}, mcps: {}, links: [], orchestratorKey: null, orchestratorPaused: false, checks: {} };
    useDeck.setState({ mode: "real", readOnly: false, ...structuredClone(design), saved: structuredClone(design), summaries: [], undoStack: [],
      agy: { ready: true, missing: null, models: [], tokensToday: 0, callsToday: 0 } });
    actions.applyPreset("code-test-review");
    expect(useDeck.getState().agents["project:.claude/agents/gemini-reviewer.md"]).toMatchObject({ kind: "agy", model: "haiku", keepPrivate: true, geminiModel: "gemini-3.1-pro-high" });
    useDeck.setState({ ...structuredClone(design), agy: { ready: false, missing: "agy isn't installed", models: [], tokensToday: 0, callsToday: 0 } });
    actions.applyPreset("code-test-review");
    expect(useDeck.getState().agents["project:.claude/agents/gemini-reviewer.md"]).toBeUndefined();
  });

});

describe("canvas edits", () => {
  const fresh = () => {
    const design = { agents: { [mine.key]: mine, [other.key]: other }, mcps: {}, orchestratorKey: null, orchestratorPaused: false,
      links: [{ id: "l1", from: other.key, to: mine.key, kind: "delegates" as const, planned: true }],
      checks: { "npm-test": { key: "npm-test", kind: "command" as const, label: "npm test", command: "npm test" } } };
    useDeck.setState({ mode: "real", readOnly: false, ...structuredClone(design), saved: structuredClone(design), summaries: [], undoStack: [], redoStack: [], userAgents: [] });
  };
  it("⇧⌘Z redoes what ⌘Z undid; a new edit clears redo", () => {
    fresh();
    actions.updateAgent(mine.key, { role: "Changed." }, "Edit role");
    actions.undo();
    expect(useDeck.getState().agents[mine.key].role).toBe("My own coder.");
    actions.redo();
    expect(useDeck.getState().agents[mine.key].role).toBe("Changed.");
    actions.undo();
    actions.updateAgent(mine.key, { role: "Other." }, "Edit role again");
    expect(useDeck.getState().redoStack).toEqual([]);
  });
  it("the chat leads by default; Make orchestrator moves its hand-offs to the agent, and Let the chat lead moves them back", () => {
    fresh();
    actions.connect(CHAT_KEY, mine.key);
    expect(useDeck.getState().links).toContainEqual(expect.objectContaining({ from: CHAT_KEY, to: mine.key, kind: "delegates", planned: true }));
    actions.connect(CHAT_KEY, other.key);
    actions.connect(mine.key, CHAT_KEY); // nothing hands work to the chat
    expect(useDeck.getState().links.filter((l) => l.to === CHAT_KEY)).toEqual([]);
    actions.makeOrchestrator(other.key);
    let s = useDeck.getState();
    expect(s.orchestratorKey).toBe(other.key);
    // Its own hand-off from the chat is dropped (not turned into a loop), and the chat's other one isn't duplicated.
    const handOffs = () => useDeck.getState().links.filter((l) => l.kind === "delegates").map((l) => [l.from, l.to]);
    expect(handOffs()).toEqual([[other.key, mine.key]]);
    actions.letChatLead();
    s = useDeck.getState();
    expect(s.orchestratorKey).toBeNull();
    expect(s.agents[other.key].kind).toBe("subagent");
    expect(handOffs()).toEqual([[CHAT_KEY, mine.key]]);
  });

  it("Rename this copy gives a same-name agent a free name", () => {
    fresh();
    actions.renameCopy(mine.key);
    expect(useDeck.getState().agents[mine.key].name).toBe("coder-2");
  });
  it("a command check dropped on a hand-off checks the receiving agent's work", () => {
    fresh();
    actions.addLinkCheck("l1", "npm-test");
    expect(useDeck.getState().links[0].checks).toEqual(["npm-test"]);
    expect(designPayload().links[0].checks).toEqual(["npm-test"]);
    actions.removeLinkCheck("l1", "npm-test");
    expect(useDeck.getState().links[0].checks).toEqual([]);
  });
});
