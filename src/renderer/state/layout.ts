// Auto-arrange: whoever leads (your chat, or the orchestrator agent) on top, agents four per row, MCP servers underneath.
import { CHAT_KEY } from "@shared/teamMap";
import { activeOrchestrator, useDeck } from "./store";

type Pos = { x: number; y: number };

export function tidyPositions(): Record<string, Pos> {
  const s = useDeck.getState();
  const pos: Record<string, Pos> = { ...s.positions };
  const byX = (a: { key: string }, b: { key: string }) => (s.positions[a.key]?.x ?? 0) - (s.positions[b.key]?.x ?? 0);
  const orch = activeOrchestrator(s);
  const agents = Object.values(s.agents).filter((a) => a.key !== orch).sort(byX);
  const top = [orch ?? CHAT_KEY];
  const mcps = Object.values(s.mcps).sort(byX);
  const perRow = 4;
  const rows = agents.length ? Math.ceil(agents.length / perRow) : 0;
  const rowWidth = Math.max(Math.min(agents.length, perRow) * 260 - 40, 260);
  top.forEach((k) => { pos[k] = { x: rowWidth / 2 - 130, y: 0 }; });
  agents.forEach((a, i) => { pos[a.key] = { x: (i % perRow) * 260, y: 230 + Math.floor(i / perRow) * 240 }; });
  const mcpY = 230 + rows * 240 - (rows ? 10 : 0);
  mcps.forEach((m, i) => { pos[m.key] = { x: rowWidth / 2 - (mcps.length * 260) / 2 + i * 260 + 20, y: mcpY }; });
  return pos;
}
