import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDeck } from "./store";
import { diffDesigns } from "./files";

/** Files that Save would write right now (current design vs last saved). */
export function usePendingFiles() {
  const d = useDeck(useShallow((s) => ({
    saved: s.saved, agents: s.agents, mcps: s.mcps, links: s.links, orchestratorKey: s.orchestratorKey,
    orchestratorPaused: s.orchestratorPaused, checks: s.checks,
  })));
  return useMemo(() => diffDesigns(d.saved, d), [d]);
}

export function useStatusLine() {
  return useDeck(useShallow((s) => {
    const running = Object.values(s.agents).filter((a) => a.status === "running").length;
    const stopping = s.sessions.some((x) => x.status === "stopping");
    const stopped = s.sessions.length > 0 && s.sessions.every((x) => x.status === "stopped");
    const waiting = s.sessions.some((x) => x.status === "waiting");
    const busy = s.sessions.some((x) => x.status === "busy");
    let text = "Idle";
    let tone: "running" | "waiting" | "idle" | "stopped" = "idle";
    if (stopping) { text = "Stopping…"; tone = "stopped"; }
    else if (stopped) { text = "Stopped · send a message or press Resume"; tone = "stopped"; }
    else if (waiting) { text = "Waiting for you in VS Code"; tone = "waiting"; }
    else if (busy) { text = running ? `Working · ${running} agent${running === 1 ? "" : "s"} running` : "Working · main session"; tone = "running"; }
    return { text, tone, anyRunning: busy || waiting || stopping };
  }));
}
