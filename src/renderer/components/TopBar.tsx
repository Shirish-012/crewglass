import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { actions, sessionTotals, useDeck } from "../state/store";
import { usePendingFiles, useStatusLine } from "../state/hooks";
import { formatTokens } from "@shared/models";
import { FOLDER_SUGGESTIONS } from "../mock/fixtures";
import { pickFolder } from "../real/api";
import { Icon } from "./ui";
import { PrototypeControls } from "./PrototypeControls";

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tone = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "";
  return (
    <div className="meter" title={`${label}: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens. Warnings at 80% and 100%; Claude is never stopped automatically.`}>
      <div className="label"><span>{label}</span><span>{formatTokens(used)} / {formatTokens(limit)}</span></div>
      <div className={`track ${tone}`}><div className={`fill ${tone}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function TopBar() {
  const s = useDeck(useShallow((st) => ({
    folder: st.folder, sessions: st.sessions, limits: st.limits, todayTokens: st.todayTokens, stopFlag: st.stopFlag,
    inbox: st.inbox, lastBackup: st.lastBackup, liveMode: st.liveMode, mode: st.mode, suggestions: st.suggestions, readOnly: st.readOnly,
  })));
  const real = s.mode === "real";
  const suggestions = real ? s.suggestions : FOLDER_SUGGESTIONS;
  const totals = useDeck(useShallow((st) => sessionTotals(st)));
  const status = useStatusLine();
  const localPending = usePendingFiles();
  const edits = useDeck((st) => st.summaries.length);
  const pending = s.mode === "real" ? { length: edits } : localPending;
  const [folderMenu, setFolderMenu] = useState(false);
  const [stopMenu, setStopMenu] = useState(false);
  const open = s.inbox.filter((i) => !i.resolved).length;
  const folderName = s.folder.split("/").pop();

  const onStop = () => {
    if (s.sessions.length > 1) { setStopMenu((v) => !v); return; }
    actions.stop("all");
  };

  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" />Crewglass</div>

      <div style={{ position: "relative" }}>
        <button className="btn folder-btn" onClick={() => setFolderMenu((v) => !v)} title={s.folder} aria-haspopup="menu">
          <Icon name="folder" /> <span className="truncate">{folderName}</span> <Icon name="down" size={14} />
        </button>
        {folderMenu && (
          <div className="menu" style={{ position: "absolute", top: 32, left: 0 }} role="menu" onMouseLeave={() => setFolderMenu(false)}>
            <div className="sub-title">Watching only this folder (and its subfolders)</div>
            <div className="sub-title mono">{s.folder}</div>
            <div className="sep" />
            {suggestions.filter((f) => f.path !== s.folder).map((f) => (
              <button key={f.path} onClick={() => { setFolderMenu(false); void pickFolder(f.path); }}>
                <Icon name="folder" /> <span className="grow truncate">{f.path.split("/").pop()}</span> <span className="muted small">{f.why}</span>
              </button>
            ))}
            <div className="sep" />
            <button onClick={() => { setFolderMenu(false); void pickFolder(); }}>
              <Icon name="plus" /> Choose folder… <span className="muted small" style={{ marginLeft: "auto" }}>⌘O</span>
            </button>
          </div>
        )}
      </div>

      <div className="status-pill" title={s.liveMode ? "Live mode is on for this folder" : "Live mode is off"}>
        <span className={`status-dot st-${status.tone === "running" ? "running" : status.tone === "waiting" ? "waiting" : status.tone === "stopped" ? "stopped" : "idle"}`} />
        {status.text}
        {s.sessions.length > 1 && <span className="badge">{s.sessions.length} sessions</span>}
      </div>

      {real ? (s.readOnly && <span className="badge info" title="Editing agents arrives with the designer (Phase 3). Live mode's Stop and safeguards work now.">{s.liveMode ? "Live mode · editing in Phase 3" : "Read-only · watching"}</span>) : <PrototypeControls />}

      <div className="spacer" />

      <Meter label={`Session · ctx ${totals.contextPct}%`} used={totals.session?.tokens ?? 0} limit={s.limits.session} />
      <Meter label="Today" used={s.todayTokens} limit={s.limits.day} />

      {status.anyRunning && !s.stopFlag && !s.liveMode && real && (
        <button className="btn stop-btn" disabled title="Stop needs Live mode — turn it on in the panel on the right">
          <Icon name="stop" size={14} /> Stop
        </button>
      )}
      {status.anyRunning && !s.stopFlag && (s.liveMode || !real) && (
        <div style={{ position: "relative" }}>
          <button className="btn stop-btn" onClick={onStop} title="Stop Claude cleanly at its next step (⌘.)">
            <Icon name="stop" size={14} /> Stop {s.sessions.length > 1 && <Icon name="down" size={13} />}
          </button>
          {stopMenu && (
            <div className="menu" style={{ position: "absolute", top: 32, right: 0 }} onMouseLeave={() => setStopMenu(false)}>
              <button onClick={() => { actions.stop("all"); setStopMenu(false); }}><Icon name="stop" /> Stop all sessions</button>
              <div className="sep" />
              {s.sessions.map((x) => (
                <button key={x.id} onClick={() => { actions.stop(x.id); setStopMenu(false); }}>
                  <Icon name={x.source === "vscode" ? "code" : "terminal"} /> Stop {x.name}
                  <span className="muted small" style={{ marginLeft: "auto" }}>{x.source === "vscode" ? "VS Code" : "Terminal"}{x.subfolder ? ` · /${x.subfolder}` : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {s.stopFlag && <button className="btn" onClick={() => actions.resume()}><Icon name="play" size={14} /> Resume</button>}

      {s.lastBackup && <button className="btn ghost small" onClick={() => actions.undoLastSave()} title="Restore the files from before your last save"><Icon name="undo" size={14} /> Undo last save</button>}
      <button className="icon-btn bell" onClick={() => useDeck.setState((st) => ({ inboxOpen: !st.inboxOpen }))} title="Attention inbox — things that need your decision" aria-label={`Attention inbox, ${open} open`}>
        <Icon name="bell" size={18} />
        {open > 0 && <span className="count">{open}</span>}
      </button>
      <button className={`btn ${pending.length ? "primary" : ""}`} disabled={!pending.length}
        onClick={() => useDeck.setState({ reviewOpen: true })} title="Review every file change before anything is written (⌘S)">
        Review changes{pending.length ? ` (${pending.length})` : ""}
      </button>
    </header>
  );
}
