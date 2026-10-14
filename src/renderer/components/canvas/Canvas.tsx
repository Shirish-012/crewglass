import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import {
  Background, ConnectionMode, Controls, MarkerType, MiniMap, ReactFlow, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeChange,
} from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { actions, activeOrchestrator, toast, useDeck } from "../../state/store";
import type { Link } from "@shared/types";
import { DND_TYPE, type DragPayload } from "../Library";
import { AgentNode, ChatNode, McpNode } from "./nodes";
import { CHAT_KEY } from "@shared/teamMap";
import { LinkEdge, linkStroke } from "./LinkEdge";
import { Icon } from "../ui";
import { Legend } from "./Legend";
import { tidyPositions } from "../../state/layout";

const nodeTypes = { agent: AgentNode, mcp: McpNode, chat: ChatNode };
const edgeTypes = { link: LinkEdge };

type Pos = { x: number; y: number };

function pickHandles(a: Pos | undefined, b: Pos | undefined): { sourceHandle: string; targetHandle: string } {
  if (!a || !b) return { sourceHandle: "b", targetHandle: "t" };
  const dy = b.y - a.y;
  if (Math.abs(dy) < 120) {
    // Neighbours in a row connect side to side; farther cards in the same row curve underneath instead of behind the cards between.
    if (Math.abs(b.x - a.x) > 320) return { sourceHandle: "b", targetHandle: "b" };
    return b.x > a.x ? { sourceHandle: "r", targetHandle: "l" } : { sourceHandle: "l", targetHandle: "r" };
  }
  return dy > 0 ? { sourceHandle: "b", targetHandle: "t" } : { sourceHandle: "t", targetHandle: "b" };
}

export function Canvas() {
  const s = useDeck(useShallow((st) => ({
    agents: st.agents, mcps: st.mcps, links: st.links, positions: st.positions, selection: st.selection,
    orch: activeOrchestrator(st),
  })));
  // Your Claude Code chat leads by default and gets one card; with an orchestrator agent, the chat runs as it (its card).
  const sessionKeys = useMemo(() => (s.orch ? [] : [CHAT_KEY]), [s.orch]);
  const resolve = useCallback((k: string) => (k.startsWith("session:") || k === CHAT_KEY ? (s.orch ?? CHAT_KEY) : k), [s.orch]);
  const exists = useCallback((k: string) => !!(s.agents[k] || s.mcps[k] || sessionKeys.includes(k)), [s.agents, s.mcps, sessionKeys]);
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Rebuild nodes from the store while keeping React Flow's measured sizes on existing nodes.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      const keys = [...sessionKeys, ...Object.keys(s.agents), ...Object.keys(s.mcps)];
      return keys.map((k, i) => {
        const old = byId.get(k);
        const position = s.positions[k] ?? old?.position ?? { x: 385 + (i % 6) * 300, y: k === CHAT_KEY ? 0 : 250 };
        const selected = s.selection?.id === k;
        const className = dropTarget === k ? "drop-target" : "";
        const type = k.startsWith("mcp:") ? "mcp" : k === CHAT_KEY ? "chat" : "agent";
        return { ...(old ?? {}), id: k, type, position, data: { key: k }, selected, className };
      });
    });
  }, [s.agents, s.mcps, s.positions, s.selection, dropTarget, sessionKeys]);

  const edges: Edge[] = useMemo(() => s.links
    .map((l) => ({ l, from: resolve(l.from), to: resolve(l.to) }))
    .filter(({ from, to }) => exists(from) && exists(to))
    .map(({ l, from, to }: { l: Link; from: string; to: string }) => {
      const st = linkStroke(l);
      return {
        id: l.id, source: from, target: to, type: "link", data: { linkId: l.id }, animated: !!l.active,
        selected: s.selection?.type === "link" && s.selection.id === l.id,
        markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke, width: 14, height: 14 },
        ...pickHandles(s.positions[from], s.positions[to]),
      };
    }), [s.links, s.positions, s.selection, resolve, exists]);

  // Re-fit the view when cards appear or disappear (e.g. the first real snapshot, or switching folders).
  const nodeKeys = nodes.map((n) => n.id).join("|");
  useEffect(() => {
    if (!nodeKeys) return;
    const t = setTimeout(() => rf.fitView({ padding: 0.12, maxZoom: 1.05, duration: 200 }), 120);
    return () => clearTimeout(t);
  }, [nodeKeys, rf]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    for (const c of changes) if (c.type === "position" && c.position && !c.dragging) actions.setPosition(c.id, c.position);
  }, []);

  const nodeAt = (x: number, y: number): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const node = (el as HTMLElement).closest?.(".react-flow__node") as HTMLElement | null;
      if (node?.dataset.id) return node.dataset.id;
    }
    return null;
  };

  /** The hand-off line (or its label) under the pointer, for dropping a check on a link. */
  const linkAt = (x: number, y: number): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const label = (el as HTMLElement).closest?.("[data-link-id]") as HTMLElement | null;
      if (label?.dataset.linkId) return label.dataset.linkId;
      const edge = (el as Element).closest?.(".react-flow__edge") as HTMLElement | SVGElement | null;
      const id = edge?.getAttribute("data-id");
      if (id) return id;
    }
    return null;
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
    const over = nodeAt(e.clientX, e.clientY);
    setDropTarget(over && !over.startsWith("mcp:") && over !== CHAT_KEY ? over : null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setDropTarget(null);
    const raw = e.dataTransfer.getData(DND_TYPE);
    if (!raw) return;
    const p = JSON.parse(raw) as DragPayload;
    const target = nodeAt(e.clientX, e.clientY);
    if (target === CHAT_KEY) {
      toast("That's your Claude Code chat", p.t === "model" ? "Pick the chat's model in Claude Code (/model). Drop the model on empty space to make an agent with it."
        : "Drop it on an agent, or on empty space to add one — the chat hands work to new agents automatically.");
      return;
    }
    const agentTarget = target && !target.startsWith("mcp:") ? target : null;
    const pos = rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 40 });
    switch (p.t) {
      case "model":
        if (agentTarget) actions.setModel(agentTarget, p.model, p.effort);
        else actions.addAgentFromModel(p.model, p.effort, pos);
        break;
      case "template": actions.addAgentFromTemplate(p.id, pos); break;
      case "user-agent": actions.addUserAgentToCanvas(p.key, pos); break;
      case "mcp":
        if (agentTarget) actions.connect(agentTarget, p.key);
        else toast("Drop it on an agent", "Drop an MCP server onto an agent to let that agent use it.");
        break;
      case "check": {
        const linkTarget = agentTarget ? null : linkAt(e.clientX, e.clientY);
        if (agentTarget) actions.addCheck(agentTarget, p.id);
        else if (linkTarget) actions.addLinkCheck(linkTarget, p.id);
        else toast("Drop it on an agent or a hand-off", "Drop a check onto the agent whose work it should check, or onto the line between two agents.");
        break;
      }
    }
  };

  const hasTeam = Object.values(s.agents).some((a) => a.kind !== "builtin");
  const readOnly = useDeck((st) => st.readOnly);
  const legendOpen = useDeck((st) => st.legendOpen);

  return (
    <div className="canvas-wrap" onDragOver={onDragOver} onDragLeave={() => { setDragging(false); setDropTarget(null); }} onDrop={onDrop}>
      <div className="canvas-tools">
        <button className="btn small" onClick={() => { useDeck.setState({ positions: tidyPositions() }); setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 50); }} title="Re-arrange: whoever leads (your chat or the orchestrator) on top, agents in a row, servers below">
          <Icon name="sparkle" size={14} /> Tidy
        </button>
        <button className="btn small" onClick={() => useDeck.setState({ legendOpen: !legendOpen })} aria-expanded={legendOpen}><Icon name="help" size={14} /> Legend</button>
      </div>
      {legendOpen && <Legend />}
      {dragging && !dropTarget && <div className="drop-hint" />}
      {!hasTeam && (
        <div className="canvas-banner" role="status">
          <Icon name="info" size={15} />
          <span className="grow">No team here — Claude works alone.{readOnly ? " Agents Claude uses will appear automatically." : " Drag a role or model from the Library to add agents."}</span>
          {!readOnly && <button className="btn primary small" onClick={() => actions.applyPreset("plan-code-review")}>Use Plan → Code → Review</button>}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={(c) => c.source && c.target && actions.connect(c.source, c.target)}
        onNodeClick={(_, n) => actions.select({ type: n.id.startsWith("mcp:") ? "mcp" : n.id === CHAT_KEY ? "session" : "agent", id: n.id })}
        onEdgeClick={(_, e) => actions.select({ type: "link", id: e.id })}
        onPaneClick={() => actions.select(null)}
        onNodeContextMenu={(ev, n) => { ev.preventDefault(); if (n.id === CHAT_KEY) return; actions.select({ type: n.id.startsWith("mcp:") ? "mcp" : "agent", id: n.id }); useDeck.setState({ menu: { x: ev.clientX, y: ev.clientY, key: n.id } }); }}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.05 }}
        minZoom={0.3}
        maxZoom={1.6}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap pannable zoomable position="top-right" style={{ width: 150, height: 90 }} nodeColor={() => "var(--surface-3)"} maskColor="color-mix(in srgb, var(--page) 60%, transparent)" />
      </ReactFlow>
    </div>
  );
}
