import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { useDeck } from "../../state/store";
import { findModel, formatTokens, modelLabel, modelWithEffort } from "@shared/models";
import type { AgentStatus } from "@shared/types";
import { CHAT_KEY } from "@shared/teamMap";
import { Icon, ModelChip, StatusText } from "../ui";

export type NodeData = { key: string };

function Handles() {
  // Four loose handles so links can leave from whichever side is nearest.
  return (
    <>
      <Handle id="t" type="source" position={Position.Top} />
      <Handle id="b" type="source" position={Position.Bottom} />
      <Handle id="l" type="source" position={Position.Left} />
      <Handle id="r" type="source" position={Position.Right} />
    </>
  );
}

export function AgentNode({ data, selected }: NodeProps) {
  const key = (data as NodeData).key;
  const { a, checks, orchestratorPaused, inChat } = useDeck(useShallow((s) => ({ a: s.agents[key], checks: s.checks, orchestratorPaused: s.orchestratorPaused,
    // A Claude Code chat open right now runs as this agent (Claude runs agents by name, so only the copy it uses).
    inChat: !!s.agents[key] && s.agents[key].sameName?.usedByClaude !== false && s.sessions.some((x) => x.id !== "none" && x.runsAs === s.agents[key].name) })));
  if (!a) return null;
  const orch = a.kind === "orchestrator";
  const cls = ["node-card", orch && "orchestrator", selected && "selected", a.status === "running" && "running",
    a.status === "waiting" && "waiting", a.status === "failed" && "failed", a.disabled && "disabled", inChat && "in-chat"].filter(Boolean).join(" ");
  const kindTag = orch ? (orchestratorPaused ? "Orchestrator · paused" : "Orchestrator") : a.kind === "agy" ? "agy agent" : a.kind === "builtin" ? (a.scope === "plugin" ? "Plugin · watch only" : a.scope === "project" ? "File missing" : "Built-in · watch only") : a.scope === "user" ? "All-projects agent" : "Subagent";

  return (
    <div className={cls} aria-label={`${a.name}, ${kindTag}, ${a.status}${inChat ? ", your Claude chat runs as this agent" : ""}`}
      title={inChat ? "Double border: your Claude Code chat runs as this agent" : undefined}>
      <Handles />
      <div className="head">
        {orch && <Icon name="baton" size={17} />}
        <span className="name truncate grow">{a.name}</span>
        {a.keepPrivate && <span title="Kept private — not in git"><Icon name="lock" size={13} /></span>}
        <span className="kind-tag">{kindTag}</span>
      </div>
      <div className="role" title={a.role}>{a.role}</div>
      <div className="model">
        {a.kind === "agy" ? (
          <>
            {/* The model the bridge reported for the last call, else the one it's set to. */}
            <ModelChip model={a.gemini?.model ?? a.geminiModel ?? ""} prefix="agy · " />
            {a.scope !== "builtin" && <span className="chip" title="The relay that hands the task to agy">via {modelLabel(a.model)} relay</span>}
          </>
        ) : <>
          <ModelChip model={a.model} effort={a.effort} />
          {a.actualModel && (
            <span className="badge warn" title={orch ? "The chat running as this orchestrator is on a different model or effort (picked in the chat, which wins for that chat). New chats start on what's set here."
              : "Its last run used a different model or effort than set here."}>{orch ? "chat now" : "last run"}: {modelWithEffort(a.actualModel, a.actualEffort)}</span>
          )}
        </>}
      </div>
      <div className="live">
        <StatusText status={a.disabled ? "idle" : a.status} parallel={a.parallel} />
        {a.disabled && <span className="badge">Disabled here</span>}
        <span className="spacer" />
        {a.kind === "agy" && a.gemini
          ? <span title="Claude tokens for the relay + Gemini tokens (Google's quota) today">{formatTokens(a.tokens)} + {formatTokens(a.gemini.tokensToday)} Gemini</span>
          : <span title="Tokens used by this agent today">{formatTokens(a.tokens)} tok</span>}
      </div>
      {a.liveNow && a.status === "running" && (
        <div className="live" title="What it's doing right now">
          <Icon name="sparkle" size={13} />
          <span className="truncate grow">{a.liveNow.action}</span>
          {a.liveNow.model && <span className="muted small">{modelWithEffort(a.liveNow.model, a.liveNow.effort)}</span>}
        </div>
      )}
      {(a.checks.length > 0 || a.skillsUsed.length > 0 || a.sameName) && (
        <div className="badges">
          {a.checks.map((c) => <span key={c} className="badge"><Icon name="terminal" size={11} /> {checks[c]?.label ?? c}</span>)}
          {a.skillsUsed.length > 0 && <span className="badge" title="Skills this agent used (watch only in v1)">skills: {a.skillsUsed.join(", ")}</span>}
          {a.sameName && (a.sameName.usedByClaude
            ? <span className="badge info" title="Another agent has the same name; Claude uses this one">Claude uses this one</span>
            : <span className="badge warn">Hidden by the project version</span>)}
        </div>
      )}
    </div>
  );
}

const MCP_STATE: Record<string, { text: string; cls?: string }> = {
  configured: { text: "Configured" }, "needs-approval": { text: "Approve in Claude", cls: "warn" }, disabled: { text: "Disabled" },
  running: { text: "Running", cls: "good" }, "in-use": { text: "In use", cls: "good" }, failing: { text: "Failing", cls: "bad" }, remote: { text: "Remote" },
};

export function McpNode({ data, selected }: NodeProps) {
  const key = (data as NodeData).key;
  const m = useDeck((s) => s.mcps[key]);
  if (!m) return null;
  const st = MCP_STATE[m.state];
  return (
    <div className={`mcp-card ${selected ? "selected" : ""} ${m.state === "failing" ? "failing" : ""}`} aria-label={`MCP server ${m.name}`}>
      <Handles />
      <div className="row">
        <Icon name="plug" size={15} />
        <strong className="grow truncate">{m.name}</strong>
        <span className={`badge ${st.cls ?? ""}`}>{st.text}</span>
      </div>
      <div className="muted small" style={{ marginTop: 2 }}>
        {m.scope === "inherited" ? `Inherited · ${m.source}` : m.scope === "project" ? "Shared · .mcp.json" : m.scope === "local" ? "Only you · this folder" : "Only you · all projects"}
        {m.calls ? ` · ${m.calls} calls` : ""}
      </div>
    </div>
  );
}

/** Your Claude Code chat (VS Code or terminal). It leads the team by default — hand-offs start here — until you make
 *  an agent the orchestrator (then new chats run as that agent, and this card gives way to it). */
export function ChatNode({ selected }: NodeProps) {
  const { all, handsTo } = useDeck(useShallow((s) => ({
    all: s.sessions,
    handsTo: s.links.filter((l) => l.from === CHAT_KEY && l.kind === "delegates" && l.planned).length,
  })));
  // Plain chats only: a chat that runs as an agent shows on that agent's card (double border).
  // (Filtered outside the selector: a new array from the selector each time would re-render forever.)
  const sessions = all.filter((x) => x.id !== "none" && !x.runsAs);
  const x = sessions.find((y) => y.status === "busy") ?? sessions.find((y) => y.status === "waiting") ?? sessions[0];
  const status: AgentStatus = !x ? "idle" : x.status === "busy" ? "running" : x.status === "waiting" ? "waiting" : x.status === "idle" ? "idle" : "stopped";
  const pct = x ? Math.round((x.contextTokens / (findModel(x.model)?.contextWindow ?? 200_000)) * 100) : 0;
  const where = !x ? "" : x.source === "vscode" ? "VS Code" : x.source === "terminal" ? "Terminal" : x.source === "headless" ? "Headless" : "Pipeline";
  return (
    <div className={`node-card orchestrator chat ${selected ? "selected" : ""} ${status === "running" ? "running" : ""} ${status === "waiting" ? "waiting" : ""}`}
      aria-label={`Your Claude Code chat, leads the team, ${status}`}>
      <Handles />
      <div className="head">
        <Icon name="chat" size={16} />
        <span className="name grow truncate">Claude Code chat</span>
        <span className="kind-tag" title="Leads the team: it hands work to your agents">Leads</span>
      </div>
      <div className="role">{handsTo ? `Hands work to your agents · ${where || "no plain chat open"}${sessions.length > 1 ? ` · ${sessions.length} chats` : ""}`
        : `Works alone until you connect agents${where ? ` · ${where}` : ""}`}</div>
      <div className="model">{x ? <ModelChip model={x.model} effort={x.effort} title="The model picked in the chat (/model)" /> : <span className="chip">Model: picked in the chat</span>}</div>
      <div className="live"><StatusText status={status} /><span className="spacer" />{x && <span>{formatTokens(x.tokens)} tok</span>}</div>
      {x?.liveNow && status === "running" && (
        <div className="live"><Icon name="sparkle" size={13} /><span className="truncate grow">{x.liveNow}</span></div>
      )}
      {x && (
        <div className="live" title="How full the context window is">
          <span className="muted">Context</span>
          <span className="ctx-bar"><span style={{ width: `${pct}%` }} className={pct >= 85 ? "warn" : ""} /></span>
          <span>{pct}%</span>
        </div>
      )}
      {x?.skillsUsed?.length ? <div className="badges"><span className="badge" title="Skills used (watch only in v1)">skills: {x.skillsUsed.join(", ")}</span></div> : null}
    </div>
  );
}
