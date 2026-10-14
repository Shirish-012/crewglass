import { useEffect, useMemo, useState } from "react";
import { actions, useDeck } from "../state/store";
import { usePendingFiles } from "../state/hooks";
import { lineDiff } from "@shared/lineDiff";
import { findSecrets } from "@shared/secretGuard";
import { Icon } from "./ui";
import type { SavePlan } from "@shared/ipc";
import { designPayload } from "../state/payload";
import { toast } from "../state/store";

/** Real app: the app itself computes the exact file plan; what you see here is exactly what Save writes. */
function RealReview() {
  const summaries = useDeck((s) => s.summaries);
  const [plan, setPlan] = useState<SavePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [confirmUser, setConfirmUser] = useState(false);
  const [confirmChecks, setConfirmChecks] = useState(false);
  const [busy, setBusy] = useState(false);
  const replan = () => {
    setPlan(null); setError(null);
    void window.crewglass!.planSave(designPayload()).then((r) => ("error" in r ? setError(r.error) : setPlan(r)));
  };
  useEffect(replan, []);
  const close = () => useDeck.setState({ reviewOpen: false });
  const file = plan?.files[sel];
  const ops = file ? lineDiff(file.before, file.after ?? "") : [];
  const save = async () => {
    if (!plan) return;
    setBusy(true);
    const r = await window.crewglass!.applySave(plan.id, confirmUser, confirmChecks);
    setBusy(false);
    if (!r.ok) { toast("Not saved", r.error ?? "Unknown error"); if (r.error?.includes("changed")) replan(); return; }
    toast("Saved", r.written ? `${r.written} file${r.written === 1 ? "" : "s"} written. A backup was kept — Undo last save restores them. Claude uses the changes on its next turn.`
      : "Your checks are saved in Crewglass (privately, not in the repo).");
    // "Undo last save" only makes sense after a save that wrote files (a checks-only save keeps no backup).
    useDeck.setState((st) => ({ summaries: [], undoStack: [], redoStack: [], reviewOpen: false, lastBackup: r.written ? st.saved : st.lastBackup }));
  };
  const fixSecret = () => {
    const st = useDeck.getState();
    for (const a of Object.values(st.agents)) {
      if (/ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}/.test(a.instructions)) {
        actions.updateAgent(a.key, { instructions: a.instructions.replace(/ghp_[A-Za-z0-9]{20,}/g, "${GITHUB_TOKEN}").replace(/sk-[A-Za-z0-9_-]{20,}/g, "${API_KEY}") },
          `Replace the pasted key in ${a.name} with a \${VARIABLE}`);
      }
    }
    replan();
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Review changes">
        <div className="dialog-head">
          <h2 className="grow">Review changes</h2>
          <span className="muted small">Nothing is written until you press Save. Old versions are backed up first.</span>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        {error ? <div style={{ padding: 20 }} className="hint"><Icon name="alert" size={15} /><span>{error}</span></div>
          : !plan ? <div style={{ padding: 20 }} className="muted">Working out exactly what will change…</div>
          : plan.files.length === 0 && plan.commands.length === 0 && !plan.checksChanged ? <div style={{ padding: 24 }} className="muted">Nothing on disk would change.</div>
          : (
          <div className="dialog-body">
            <div className="change-list">
              <div className="lib-sub" style={{ padding: "0 0 4px" }}>What you changed</div>
              <ol style={{ margin: "0 0 12px", paddingLeft: 18 }} className="small">{summaries.map((t, i) => <li key={i} style={{ marginBottom: 3 }}>{t}</li>)}</ol>
              <div className="lib-sub" style={{ padding: "0 0 4px" }}>Files that will be written</div>
              {plan.files.map((f, i) => (
                <div key={f.path} className={`file-item ${i === sel ? "on" : ""}`} onClick={() => setSel(i)} role="button" tabIndex={0}>
                  <Icon name={f.hits.length ? "alert" : "file"} size={14} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="mono truncate" style={{ fontSize: 11.5 }}>{f.display}</div>
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      {f.before === "" ? <span className="badge good">new</span> : f.after === null ? <span className="badge bad">removed</span> : <span className="badge">changed</span>}
                      {f.shared ? <span className="badge">shared via git</span> : <span className="badge"><Icon name="lock" size={10} /> private</span>}
                      {f.hits.length > 0 && <span className="badge bad">key found</span>}
                    </div>
                  </div>
                </div>
              ))}
              {plan.commands.length > 0 && <>
                <div className="lib-sub" style={{ padding: "8px 0 4px" }}>Commands that will run</div>
                {plan.commands.map((c) => <div key={c.label} className="mono small" style={{ padding: "3px 0", wordBreak: "break-all" }}>{c.label}</div>)}
              </>}
              {plan.checks.length > 0 && <>
                <div className="lib-sub" style={{ padding: "8px 0 4px" }}>Checks Crewglass will run (kept private, not in the repo)</div>
                {plan.checks.map((c) => (
                  <div key={`${c.agent}:${c.command}`} className="small" style={{ padding: "3px 0" }}>
                    after <b>{c.agent}</b> changes files: <span className="mono" style={{ wordBreak: "break-all" }}>{c.command}</span>
                    {c.isNew && <span className="badge warn" style={{ marginLeft: 6 }}>new here</span>}
                  </div>
                ))}
              </>}
              {plan.warnings.map((w) => <div key={w} className="hint" style={{ marginTop: 8 }}><Icon name="info" size={14} /><span>{w}</span></div>)}
            </div>
            <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
              {file && file.hits.length > 0 && (
                <div className="hint" style={{ margin: 10, background: "var(--critical-soft)", color: "var(--critical-ink)" }}>
                  <Icon name="shield" size={16} />
                  <span>Secret guard: line {file.hits[0].line} looks like a {file.hits[0].kind} (<span className="mono">{file.hits[0].preview}</span>). This file is shared through git, so saving is blocked.</span>
                  <button className="btn small x" onClick={fixSecret}>Use a ${"{VARIABLE}"} instead</button>
                </div>
              )}
              <div className="diff">{ops.map((o, i) => <div key={i} className={o.type}>{o.text || " "}</div>)}</div>
            </div>
          </div>
        )}
        <div className="dialog-foot">
          {plan?.needsUserConfirm && (
            <label className="checkbox"><input type="checkbox" checked={confirmUser} onChange={(e) => setConfirmUser(e.target.checked)} />
              I understand a change under ~/.claude affects all my projects</label>
          )}
          {plan?.needsCheckConfirm && (
            <label className="checkbox"><input type="checkbox" checked={confirmChecks} onChange={(e) => setConfirmChecks(e.target.checked)} />
              I trust the new check command{plan.checks.filter((c) => c.isNew).length === 1 ? "" : "s"} to run in this folder (e.g. <span className="mono">npm test</span> runs this project's own test script)</label>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={() => actions.discard()}>Discard all</button>
          <button className="btn" onClick={close}>Keep editing</button>
          <button className="btn primary" disabled={!plan || busy || plan.blocked || (plan.needsUserConfirm && !confirmUser) || (plan.needsCheckConfirm && !confirmChecks)
            || (!plan.files.length && !plan.commands.length && !plan.checksChanged)}
            onClick={() => void save()}>{!plan || plan.files.length || !plan.checksChanged ? `Save${plan ? ` ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}` : ""}` : "Save checks"}</button>
        </div>
      </div>
    </div>
  );
}

export function ReviewDialog() {
  const open = useDeck((s) => s.reviewOpen);
  const real = useDeck((s) => s.mode === "real");
  const summaries = useDeck((s) => s.summaries);
  const files = usePendingFiles();
  const [sel, setSel] = useState(0);
  const [confirmUser, setConfirmUser] = useState(false);
  useEffect(() => { if (sel >= files.length) setSel(0); }, [files.length, sel]);

  const secrets = useMemo(() => files.map((f) => (f.shared ? findSecrets(f.after) : [])), [files]);
  if (!open) return null;
  if (real) return <RealReview />;
  const blocked = secrets.some((h) => h.length > 0);
  const touchesUser = files.some((f) => f.path.startsWith("~/"));
  const file = files[sel];
  const ops = file ? lineDiff(file.before, file.after) : [];

  const fixSecret = () => {
    const st = useDeck.getState();
    for (const a of Object.values(st.agents)) {
      if (/ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}/.test(a.instructions)) {
        actions.updateAgent(a.key, { instructions: a.instructions.replace(/ghp_[A-Za-z0-9]{20,}/g, "${GITHUB_TOKEN}").replace(/sk-[A-Za-z0-9_-]{20,}/g, "${API_KEY}") },
          `Replace the pasted key in ${a.name} with \${GITHUB_TOKEN}`);
      }
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && useDeck.setState({ reviewOpen: false })}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Review changes">
        <div className="dialog-head">
          <h2 className="grow">Review changes</h2>
          <span className="muted small">Nothing is written until you press Save. Old versions are backed up first.</span>
          <button className="icon-btn" onClick={() => useDeck.setState({ reviewOpen: false })} aria-label="Close"><Icon name="x" /></button>
        </div>
        {files.length === 0 ? (
          <div style={{ padding: 24 }} className="muted">No changes. Edits you make on the canvas collect here.</div>
        ) : (
          <div className="dialog-body">
            <div className="change-list">
              <div className="lib-sub" style={{ padding: "0 0 4px" }}>What you changed</div>
              <ol style={{ margin: "0 0 12px", paddingLeft: 18 }} className="small">
                {summaries.map((t, i) => <li key={i} style={{ marginBottom: 3 }}>{t}</li>)}
              </ol>
              <div className="lib-sub" style={{ padding: "0 0 4px" }}>Files that will be written</div>
              {files.map((f, i) => (
                <div key={f.path} className={`file-item ${i === sel ? "on" : ""}`} onClick={() => setSel(i)} role="button" tabIndex={0}>
                  <Icon name={secrets[i].length ? "alert" : "file"} size={14} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="mono truncate" style={{ fontSize: 11.5 }}>{f.path}</div>
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      {f.before === "" ? <span className="badge good">new</span> : f.after === "" ? <span className="badge bad">removed</span> : <span className="badge">changed</span>}
                      {f.shared ? <span className="badge">shared via git</span> : <span className="badge"><Icon name="lock" size={10} /> private</span>}
                      {secrets[i].length > 0 && <span className="badge bad">key found</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
              {file && secrets[sel].length > 0 && (
                <div className="hint" style={{ margin: 10, background: "var(--critical-soft)", color: "var(--critical-ink)" }}>
                  <Icon name="shield" size={16} />
                  <span>Secret guard: line {secrets[sel][0].line} looks like a {secrets[sel][0].kind} (<span className="mono">{secrets[sel][0].preview}</span>). This file is shared through git, so saving it is blocked.</span>
                  <button className="btn small x" onClick={fixSecret}>Use ${"{GITHUB_TOKEN}"} instead</button>
                </div>
              )}
              <div className="diff">{ops.map((o, i) => <div key={i} className={o.type}>{o.text || " "}</div>)}</div>
            </div>
          </div>
        )}
        <div className="dialog-foot">
          {touchesUser && (
            <label className="checkbox"><input type="checkbox" checked={confirmUser} onChange={(e) => setConfirmUser(e.target.checked)} />
              I understand a change under ~/.claude affects all my projects</label>
          )}
          <div className="spacer" />
          {files.length > 0 && <button className="btn ghost" onClick={() => actions.discard()}>Discard all</button>}
          <button className="btn" onClick={() => useDeck.setState({ reviewOpen: false })}>Keep editing</button>
          <button className="btn primary" disabled={!files.length || blocked || (touchesUser && !confirmUser)} onClick={() => actions.save(files.length)}
            title={blocked ? "Fix the flagged key first" : undefined}>Save {files.length} file{files.length === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}
