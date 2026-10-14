// Real mode: the UI inside the Electron app. Instead of the simulator, it shows snapshots the main process
// builds from Claude Code's files for the watched folder. Edits collect as pending changes until you Save; live
// updates keep flowing in without wiping them.

import type { Agent, Link, McpServer } from "@shared/types";
import type { Snapshot } from "@shared/ipc";
import type { Design } from "../state/files";
import { designOf, useDeck } from "../state/store";
import { pickFolder } from "./api";
import { editCommand, focusSearch } from "../state/commands";
import { tidyPositions } from "../state/layout";
import { LEGACY } from "@shared/legacy";

let lastKeys = "";
let lastFolder: string | null = null;
const POS_KEY = (folder: string) => `crewglass.positions:${folder}`;

function loadPositions(folder: string): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(POS_KEY(folder)) ?? localStorage.getItem(`${LEGACY.storagePrefix}positions:${folder}`) ?? "{}") as Record<string, { x: number; y: number }>; } catch { return {}; }
}

/** Keep your unsaved edits, but refresh live numbers and add anything newly seen. */
function mergeLive(cur: Design, snap: Design, savedBefore: Design): Design {
  const live = (a: Agent, s?: Agent): Agent => (s ? { ...a, status: s.status, parallel: s.parallel, tokens: s.tokens, calls: s.calls, skillsUsed: s.skillsUsed,
    liveNow: s.liveNow, actualModel: s.actualModel, actualEffort: s.actualEffort, sameName: s.sameName, gemini: s.gemini } : a);
  const agents = Object.fromEntries(Object.entries(cur.agents).map(([k, a]) => [k, live(a, snap.agents[k])]));
  for (const [k, a] of Object.entries(snap.agents)) if (!agents[k] && !savedBefore.agents[k]) agents[k] = a;
  const mcps: Record<string, McpServer> = Object.fromEntries(Object.entries(cur.mcps).map(([k, m]) => [k, snap.mcps[k] ? { ...m, state: snap.mcps[k].state, calls: snap.mcps[k].calls } : m]));
  for (const [k, m] of Object.entries(snap.mcps)) if (!mcps[k] && !savedBefore.mcps[k]) mcps[k] = m;
  const snapLinks = new Map(snap.links.map((l) => [l.id, l]));
  const links: Link[] = cur.links.map((l) => { const o = snapLinks.get(l.id); return o ? { ...l, observed: o.observed, active: o.active, check: o.check } : l; });
  const known = new Set([...cur.links.map((l) => l.id), ...savedBefore.links.map((l) => l.id)]);
  for (const l of snap.links) if (!known.has(l.id)) links.push(l);
  return { ...cur, agents, mcps, links };
}

function apply(snap: Snapshot) {
  const s = useDeck.getState();
  const snapDesign: Design = {
    agents: Object.fromEntries(snap.agents.map((a) => [a.key, a])),
    mcps: Object.fromEntries(snap.mcps.map((m) => [m.key, m])),
    links: snap.links,
    orchestratorKey: snap.orchestratorKey,
    orchestratorPaused: snap.orchestratorPaused,
    checks: snap.checks,
  };
  const folderChanged = snap.folder !== lastFolder;
  const dirty = !folderChanged && s.summaries.length > 0;
  const design = dirty ? mergeLive(designOf(s), snapDesign, s.saved) : snapDesign;
  useDeck.setState({
    ...design,
    saved: snapDesign,
    ...(folderChanged ? { summaries: [], undoStack: [], redoStack: [], selection: null, positions: snap.folder ? loadPositions(snap.folder) : {} } : {}),
    onboarded: s.onboarded || !!snap.folder,
    folder: snap.folder ?? "",
    recentFolders: snap.recentFolders,
    suggestions: snap.suggestions,
    userAgents: snap.userAgents,
    sessions: snap.sessions,
    selectedSession: snap.sessions.some((x) => x.id === s.selectedSession) ? s.selectedSession : snap.sessions[0]?.id ?? "",
    activity: snap.activity,
    series: snap.series,
    processes: snap.processes,
    history: snap.history,
    formatIssues: snap.formatIssues,
    inbox: snap.inbox,
    todayTokens: snap.todayTokens,
    todayCache: snap.todayCache,
    limits: snap.limits,
    sourceRepo: snap.sourceRepo,
    claudeVersion: snap.claudeVersion,
    testedVersion: snap.testedClaudeVersion,
    loading: snap.loading,
    liveMode: snap.live.installed,
    liveActive: snap.live.active,
    agy: snap.agy,
    // Stop stays "pressed" until no session is stopping or stopped any more.
    stopFlag: snap.sessions.some((x) => x.status === "stopping" || x.status === "stopped"),
  });
  lastFolder = snap.folder;
  // Cards that appear get a place; cards you've moved keep theirs.
  const st = useDeck.getState();
  const keys = [...st.sessions.map((x) => `session:${x.id}`), ...Object.keys(st.agents), ...Object.keys(st.mcps)];
  const sig = keys.join("|");
  if (sig !== lastKeys) {
    lastKeys = sig;
    const missing = keys.filter((k) => !st.positions[k]);
    if (missing.length) {
      const tidy = tidyPositions();
      const fresh = Object.keys(st.positions).length === 0;
      useDeck.setState({ positions: fresh ? tidy : { ...st.positions, ...Object.fromEntries(missing.map((k) => [k, tidy[k]]).filter(([, p]) => p)) } });
    }
  }
}

export async function connectReal() {
  const api = window.crewglass!;
  useDeck.setState({ mode: "real", readOnly: false, onboarded: false, inbox: [], activity: [], formatIssues: [], summaries: [], undoStack: [], redoStack: [] });
  apply(await api.getSnapshot());
  api.onSnapshot(apply);
  api.onCommand((c) => {
    if (c === "open-inbox") useDeck.setState({ inboxOpen: true });
    if (c === "open-uninstall") useDeck.setState({ uninstallOpen: true });
    if (c === "choose-folder") void pickFolder();
    if (c === "edit-undo") editCommand("undo");
    if (c === "edit-redo") editCommand("redo");
    if (c === "find") focusSearch();
  });
  // Remember where you put the cards, per folder (in Crewglass's own storage, not the repo).
  useDeck.subscribe((st, prev) => {
    if (st.positions !== prev.positions && st.folder) {
      try { localStorage.setItem(POS_KEY(st.folder), JSON.stringify(st.positions)); } catch { /* storage unavailable */ }
    }
  });
}
