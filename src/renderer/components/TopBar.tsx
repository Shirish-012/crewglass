import { formatUsd } from "@shared/pricing";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { actions, sessionTotals, useDeck } from "../state/store";
import { usePendingFiles, useStatusLine } from "../state/hooks";
import { formatTokens } from "@shared/models";
import { FOLDER_SUGGESTIONS } from "../mock/fixtures";
import { pickFolder } from "../real/api";
import { Icon } from "./ui";
import { PrototypeControls } from "./PrototypeControls";
import { AppearanceToggle } from "./Appearance";

/** Spend against a limit, in API-equivalent dollars (tokens in the tooltip). */
function Meter({ label, used, limit, tokens, onClick }: { label: string; used: number; limit: number; tokens: number; onClick: (e: React.MouseEvent) => void }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tone = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "";
  return (
    <button className="meter meter-btn" onClick={onClick} aria-haspopup="dialog"
      title={`${label}: ${formatUsd(used)} of ${formatUsd(limit)} at Claude API prices (${formatTokens(tokens)} input + output tokens). Click to change your limits.`}>
      <div className="label"><span>{label}</span><span>{formatUsd(used)} / {formatUsd(limit)}</span></div>
      <div className={`track ${tone}`}><div className={`fill ${tone}`} style={{ width: `${pct}%` }} /></div>
    </button>
  );
}

/** Change both limits right from the top bar: type an amount, ±$5, or a quick pick. Saved at once. */
function LimitsPopover({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const limits = useDeck((s) => s.limits);
  const [v, setV] = useState({ session: limits.session, day: limits.day });
  const save = (next: { session: number; day: number }) => {
    const clean = { session: Math.min(100_000, Math.max(1, Math.round(next.session * 100) / 100)), day: Math.min(100_000, Math.max(1, Math.round(next.day * 100) / 100)) };
    setV(clean);
    useDeck.setState({ limits: clean });
    void window.crewglass?.updateSettings({ limits: clean });
  };
  const row = (key: "session" | "day", label: string, picks: number[]) => (
    <div className="col" style={{ gap: 6 }}>
      <label className="small"><b>{label}</b></label>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn small" onClick={() => save({ ...v, [key]: v[key] - 5 })} aria-label={`${label}: $5 less`}>− $5</button>
        <span className="muted">$</span>
        <input className="input" type="number" min={1} step={5} style={{ width: 90 }} value={v[key]} aria-label={label}
          onChange={(e) => setV({ ...v, [key]: Number(e.target.value) })} onBlur={() => save(v)} onKeyDown={(e) => e.key === "Enter" && save(v)} />
        <button className="btn small" onClick={() => save({ ...v, [key]: v[key] + 5 })} aria-label={`${label}: $5 more`}>+ $5</button>
      </div>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        {picks.map((p) => <button key={p} className={`chip selectable ${v[key] === p ? "on" : ""}`} onClick={() => save({ ...v, [key]: p })}>${p}</button>)}
      </div>
    </div>
  );
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={onClose} />
      <div className="popover col" role="dialog" aria-label="Usage limits" style={{ left: at.x, top: at.y, width: 300, padding: 14, gap: 14 }}>
        {row("session", "Per chat (session)", [10, 25, 50, 100, 1000])}
        {row("day", "Per day, this folder", [25, 50, 100, 200, 500])}
        <div className="muted small">API-equivalent dollars. Warning at 80%; with Live mode Claude is asked to wrap up at 95%. Nothing is ever blocked. Saved at once.</div>
      </div>
    </>
  );
}

export function TopBar() {
  const s = useDeck(useShallow((st) => ({
    folder: st.folder, sessions: st.sessions, limits: st.limits, todayTokens: st.todayTokens, todayUsd: st.todayUsd, stopFlag: st.stopFlag,
    inbox: st.inbox, lastBackup: st.lastBackup, liveMode: st.liveMode, mode: st.mode, suggestions: st.suggestions, readOnly: st.readOnly,
  })));
  const real = s.mode === "real";
  const suggestions = real ? s.suggestions : FOLDER_SUGGESTIONS;
  const totals = useDeck(useShallow((st) => sessionTotals(st)));
  const [limitsAt, setLimitsAt] = useState<{ x: number; y: number } | null>(null);
  const openLimits = (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setLimitsAt(limitsAt ? null : { x: Math.max(8, r.left - 40), y: r.bottom + 6 }); };
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

      <Meter label={`Session · ctx ${totals.contextPct}%`} used={totals.session?.usd ?? 0} tokens={totals.session?.tokens ?? 0} limit={s.limits.session} onClick={openLimits} />
      <Meter label="Today" used={s.todayUsd ?? 0} tokens={s.todayTokens} limit={s.limits.day} onClick={openLimits} />
      {limitsAt && <LimitsPopover at={limitsAt} onClose={() => setLimitsAt(null)} />}

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

      <AppearanceToggle />
      <button className="icon-btn" onClick={() => useDeck.setState({ settingsOpen: true })} title="Settings (⌘,)" aria-label="Settings"><Icon name="gear" size={17} /></button>
      {s.lastBackup && <button className="btn ghost small" onClick={() => actions.undoLastSave()} title="Restore the files from before your last save"><Icon name="undo" size={14} /> Undo last save</button>}
      <button className="icon-btn bell" onClick={() => useDeck.setState((st) => ({ inboxOpen: !st.inboxOpen }))} title="Attention inbox — things that need your decision" aria-label={`Attention inbox, ${open} open`}>
        <Icon name="bell" size={18} />
        {open > 0 && <span className="count">{open}</span>}
      </button>
      <PipelineButton />
      <button className={`btn ${pending.length ? "primary" : ""}`} disabled={!pending.length}
        onClick={() => useDeck.setState({ reviewOpen: true })} title="Review every file change before anything is written (⌘S)">
        Review changes{pending.length ? ` (${pending.length})` : ""}
      </button>
    </header>
  );
}

/** Run pipeline, or — while one runs — where it is ("Pipeline 2/3"). */
function PipelineButton() {
  const p = useDeck((st) => st.pipeline);
  const active = p?.status === "running" ? p.steps.findIndex((x) => x.status !== "done") : -1;
  return (
    <button className={`btn ${active >= 0 ? "" : "ghost"}`} onClick={() => useDeck.setState({ runOpen: true })}
      title="Run your steps in a guaranteed order, with checks in between">
      <Icon name="play" size={13} /> {active >= 0 ? `Pipeline ${active + 1}/${p!.steps.length}` : "Run pipeline"}
    </button>
  );
}
