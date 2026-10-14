// Turning Live mode on or off in the real app: shows exactly what changes in <folder>/.claude/settings.local.json first.
import { useEffect, useState } from "react";
import type { LivePlan } from "@shared/ipc";
import { lineDiff } from "@shared/lineDiff";
import { toast, useDeck } from "../state/store";
import { Icon } from "./ui";

export function LiveModeDialog() {
  const open = useDeck((s) => s.liveDialogOpen);
  const [plan, setPlan] = useState<LivePlan | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) { setPlan(null); return; }
    void window.crewglass?.livePreview().then(setPlan);
  }, [open]);
  if (!open) return null;
  const close = () => useDeck.setState({ liveDialogOpen: false });
  const turningOn = plan ? !plan.installed : true;
  const apply = async () => {
    setBusy(true);
    const r = await window.crewglass!.setLiveMode(turningOn);
    setBusy(false);
    if (!r.ok) { toast("Couldn't change Live mode", r.error ?? "Unknown error"); return; }
    toast(turningOn ? "Live mode is on" : "Live mode is off", turningOn
      ? "New Claude turns in this folder now report to Crewglass. Stop and the safeguards are ready."
      : "The hooks were removed and settings.local.json is back to how it was.");
    close();
  };
  const ops = plan ? lineDiff(plan.before, plan.after) : [];
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" style={{ width: "min(860px, 94vw)" }} role="dialog" aria-modal="true" aria-label="Live mode">
        <div className="dialog-head">
          <h2 className="grow">{turningOn ? "Turn on Live mode for this folder" : "Turn off Live mode"}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
          {!plan ? <div className="muted">Preparing…</div> : plan.error ? <div className="hint"><Icon name="alert" size={15} /><span>{plan.error}</span></div> : <>
            <div className="small">{turningOn
              ? "Crewglass adds its hook to this one file. Nothing else in the folder is touched, and if Crewglass is closed the hook simply allows everything."
              : "Only Crewglass's own entries are removed. If nothing else changed, the file goes back byte-for-byte to how it was."}</div>
            <div className="row small"><Icon name="file" size={14} /><span className="mono grow truncate">{plan.path}</span>
              {plan.gitIgnored === true && <span className="badge good">git-ignored</span>}
              {plan.gitIgnored === false && <span className="badge warn">will be added to .git/info/exclude</span>}
              {plan.gitIgnored === null && <span className="badge">not a git repo</span>}
              {!plan.existed && turningOn && <span className="badge">new file</span>}</div>
            <div className="diff" style={{ maxHeight: "50vh", border: "1px solid var(--border)", borderRadius: 8 }}>
              {ops.map((o, i) => <div key={i} className={o.type}>{o.text || " "}</div>)}
            </div>
          </>}
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <button className="btn" onClick={close}>Cancel</button>
          <button className={`btn ${turningOn ? "primary" : "danger"}`} disabled={!plan || !!plan.error || busy} onClick={() => void apply()}>
            {turningOn ? "Turn on Live mode" : "Turn off and restore the file"}
          </button>
        </div>
      </div>
    </div>
  );
}
