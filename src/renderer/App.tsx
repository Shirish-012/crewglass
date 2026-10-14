import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { actions, useDeck } from "./state/store";
import { simTick } from "./mock/simulator";
import { TopBar } from "./components/TopBar";
import { Library } from "./components/Library";
import { Canvas } from "./components/canvas/Canvas";
import { Details } from "./components/Details";
import { LiveStrip } from "./components/LiveStrip";
import { Inbox, Toasts } from "./components/Inbox";
import { ReviewDialog } from "./components/ReviewDialog";
import { RunDialog } from "./components/RunDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ContextMenu } from "./components/ContextMenu";
import { Onboarding } from "./components/Onboarding";
import { LiveModeDialog } from "./components/LiveModeDialog";
import { focusSearch } from "./state/commands";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      const s = useDeck.getState();
      if (e.key === ".") { e.preventDefault(); if (!s.stopFlag) actions.stop("all"); }
      else if (e.key === "s") { e.preventDefault(); useDeck.setState({ reviewOpen: true }); }
      else if (e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); if (e.shiftKey) actions.redo(); else actions.undo(); }
      else if (e.key === "f") { e.preventDefault(); focusSearch(); }
      else if (["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        useDeck.setState({ bottomOpen: true, bottomTab: (["usage", "activity", "history"] as const)[Number(e.key) - 1] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const onboarded = useDeck((s) => s.onboarded);
  const mode = useDeck((s) => s.mode);
  useShortcuts();
  useEffect(() => {
    if (!onboarded || mode === "real") return; // the real app gets live data from Claude Code, not the simulator
    const t = setInterval(simTick, 1000);
    return () => clearInterval(t);
  }, [onboarded, mode]);

  if (!onboarded) return <><Onboarding /><Toasts /></>;
  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar />
        <div className="main">
          <Library />
          <Canvas />
          <Details />
        </div>
        <LiveStrip />
      </div>
      <Inbox />
      <ReviewDialog />
      <RunDialog />
      <SettingsDialog />
      <ContextMenu />
      <LiveModeDialog />
      <Toasts />
    </ReactFlowProvider>
  );
}
