// What gets sent to the app for "Review changes": the design on the canvas, plus what you deleted since the last save.
import type { DesignPayload } from "@shared/ipc";
import { useDeck } from "./store";

export function designPayload(): DesignPayload {
  const s = useDeck.getState();
  const deletedKeys = Object.values(s.saved.agents)
    .filter((a) => (a.scope === "project" || a.scope === "user") && a.kind !== "builtin" && !s.agents[a.key])
    .map((a) => a.key);
  const removedMcpKeys = Object.keys(s.saved.mcps).filter((k) => !s.mcps[k]);
  const removedMcpScopes = Object.fromEntries(removedMcpKeys.map((k) => [k, s.saved.mcps[k].scope]));
  return {
    agents: Object.values(s.agents), mcps: Object.values(s.mcps), links: s.links, orchestratorKey: s.orchestratorKey,
    orchestratorPaused: s.orchestratorPaused, checks: s.checks, handoff: s.handoff, deletedKeys, removedMcpKeys, removedMcpScopes,
  };
}
