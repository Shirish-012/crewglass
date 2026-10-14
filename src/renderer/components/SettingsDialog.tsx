import { useEffect, useState } from "react";
import { toast, useDeck } from "../state/store";
import type { UninstallPlan } from "@shared/ipc";
import { Icon } from "./ui";

const close = () => useDeck.setState({ uninstallOpen: false });

function Uninstall({ onCancel }: { onCancel: () => void }) {
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [orch, setOrch] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void window.crewglass!.uninstallPlan().then(setPlan); }, []);
  const go = async () => {
    setBusy(true);
    const r = await window.crewglass!.uninstall({ removeOrchestrator: orch });
    if (!r.ok) toast("Uninstall finished with problems", r.error ?? "");
  };
  const list = (items: string[]) => items.length ? items.map((f) => <div key={f} className="mono small truncate" title={f}>{f}</div>) : <div className="muted small">none</div>;
  return (
    <div className="col" style={{ gap: 12, padding: 16, overflow: "auto" }}>
      <div className="hint"><Icon name="alert" size={15} /><span>Crewglass will undo everything it set up on this Mac, then quit. Nothing happens until you press Uninstall.</span></div>
      {!plan ? <div className="muted">Checking what Crewglass changed…</div> : <>
        <div><b>1. Remove Live mode (always)</b> — from {plan.hookFolders.length} folder{plan.hookFolders.length === 1 ? "" : "s"}' <span className="mono">.claude/settings.local.json</span>{list(plan.hookFolders)}</div>
        <div><b>2. Unregister the agy bridge</b> — {plan.agyFolders.length} folder{plan.agyFolders.length === 1 ? "" : "s"} (<span className="mono">claude mcp remove --scope local crewglass-agy</span>){list(plan.agyFolders)}</div>
        <div>
          <label className="checkbox"><input type="checkbox" checked={orch} onChange={(e) => setOrch(e.target.checked)} disabled={!plan.orchestratorFolders.length} />
            <b>3. Also remove the orchestrator setting</b> (optional) — {plan.orchestratorFolders.length ? plan.orchestratorFolders.map((o) => `${o.folder.split("/").pop()} → ${o.agent}`).join(", ") : "none set"}</label>
        </div>
        <div><b>4. Keep your files</b> — agent files, <span className="mono">.mcp.json</span> and team maps stay; they're yours.</div>
        <div><b>5. Delete Crewglass's data</b>{list(plan.dataFolders)}</div>
        <div className="muted small">Then drag Crewglass to the Trash.</div>
      </>}
      <div className="row" style={{ gap: 8 }}>
        <div className="spacer" />
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn danger" disabled={!plan || busy} onClick={() => void go()}><Icon name="trash" size={13} /> {busy ? "Uninstalling…" : "Uninstall"}</button>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useDeck((st) => st.uninstallOpen);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Uninstall Crewglass" style={{ maxWidth: 760 }}>
        <div className="dialog-head">
          <h2 className="grow">Uninstall Crewglass</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        {!window.crewglass ? <div style={{ padding: 20 }} className="muted">Uninstall is part of the real app.</div>
          : <Uninstall onCancel={close} />}
      </div>
    </div>
  );
}
