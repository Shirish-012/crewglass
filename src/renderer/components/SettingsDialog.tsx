import { useEffect, useState } from "react";
import { toast, useDeck } from "../state/store";
import type { AppSettings, PopupKind, UninstallPlan } from "@shared/ipc";
import { Icon } from "./ui";

const POPUPS: { kind: PopupKind; label: string; hint: string }[] = [
  { kind: "permission", label: "Claude needs your permission", hint: "only if it's still waiting after the delay below" },
  { kind: "paused", label: "A failing command was paused", hint: "you choose what happens next" },
  { kind: "approval", label: "A costly direct call needs your OK", hint: "the agent waits up to 2 minutes" },
  { kind: "failed", label: "Work failed for good", hint: "checks still failing after 2 fix rounds, or Claude stopped with an error" },
  { kind: "finished", label: "Claude finished a task", hint: "when it goes idle, waiting for your next message (and when a pipeline ends)" },
  { kind: "limit", label: "A token limit was reached", hint: "once per session or day" },
];

const close = () => useDeck.setState({ settingsOpen: false, uninstallOpen: false });

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`seg-toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

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

function Settings({ s, set }: { s: AppSettings; set: (patch: Partial<AppSettings>) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
  const deleteAll = async () => {
    const r = await window.crewglass!.deleteAllData();
    setConfirmDelete(false);
    if (r.ok) { toast("Data deleted", "Crewglass's stored data is gone. Live mode can still be turned off from each folder."); close(); }
    else toast("Couldn't delete everything", r.error ?? "");
  };
  return (
    <div className="col settings" style={{ gap: 18, padding: 16, overflow: "auto" }}>
      <section className="col" style={{ gap: 8 }}>
        <h3>General</h3>
        <div className="row" style={{ gap: 10 }}>
          <Toggle on={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} label="Launch at login" />
          <div className="grow"><div>Open Crewglass when you log in</div>
            <div className="muted small">{s.canLaunchAtLogin ? "It starts quietly in the menu bar, so the safeguards are there whenever Claude runs." : "Works in the installed app (npm run dist), not when run from the repo."}</div></div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Toggle on={s.statusLine} onChange={(v) => set({ statusLine: v })} label="Status line in Claude Code" />
          <div className="grow"><div>Status line in Claude Code (Live mode folders)</div>
            <div className="muted small">Model · context · today's spend vs your limit, at the bottom of Claude Code (terminal). Never replaces a status line set in that folder's own settings; switching this updates every Live mode folder at once.</div></div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Toggle on={s.chatNotice} onChange={(v) => set({ chatNotice: v })} label="Say which agent a chat runs as" />
          <div className="grow"><div>Say which agent a new Claude Code chat runs as</div>
            <div className="muted small">A one-line note at the top of each new chat in a Live mode folder, e.g. “this chat runs as lead · starts on Opus 5.5 · high”. Only you see it; Claude never reads it.</div></div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div className="grow"><div>Crewglass's source code</div><div className="mono muted small truncate" title={s.sourceRepo}>{s.sourceRepo || "Not set"}</div>
            <div className="muted small">Used by the “Unknown fields” box to point at the file to fix.</div></div>
          <button className="btn small" onClick={() => void window.crewglass!.chooseSourceRepo().then((n) => set(n))}>Change…</button>
        </div>
      </section>

      <section className="col" style={{ gap: 8 }}>
        <h3>Token limits <span className="muted small">(warnings only — Claude is never stopped automatically)</span></h3>
        <div className="muted small">In API-equivalent dollars: what the usage would cost at Claude API prices (cache reads and writes at their real price), even on a subscription. Warning at 80%; with Live mode, Claude is asked at 95% to finish its step and write a handoff note.</div>
        <div className="row" style={{ gap: 14 }}>
          <div className="field"><label>Per session</label>
            <input className="input" type="number" min={1} step={5} value={s.limits.session} onChange={(e) => set({ limits: { ...s.limits, session: num(e.target.value, 1, 100_000) } })} />
            <span className="muted small">US dollars</span></div>
          <div className="field"><label>Per day, this folder</label>
            <input className="input" type="number" min={1} step={5} value={s.limits.day} onChange={(e) => set({ limits: { ...s.limits, day: num(e.target.value, 1, 100_000) } })} />
            <span className="muted small">US dollars</span></div>
        </div>
      </section>

      <section className="col" style={{ gap: 8 }}>
        <h3>Mac notifications <span className="muted small">(shown by macOS, not inside Crewglass — and not while a Crewglass window is in front)</span></h3>
        {POPUPS.map((p) => (
          <div key={p.kind} className="row" style={{ gap: 10 }}>
            <Toggle on={s.popups[p.kind]} onChange={(v) => set({ popups: { ...s.popups, [p.kind]: v } })} label={p.label} />
            <div className="grow"><div>{p.label}</div><div className="muted small">{p.hint}</div></div>
          </div>
        ))}
        {s.popups.finished && (
          <div className="col" style={{ gap: 6, paddingLeft: 44 }}>
            <label className="checkbox"><input type="radio" name="finish" checked={s.notifyEveryFinish} onChange={() => set({ notifyEveryFinish: true })} /> After every task</label>
            <label className="checkbox" style={{ gap: 6 }}><input type="radio" name="finish" checked={!s.notifyEveryFinish} onChange={() => set({ notifyEveryFinish: false })} /> Only tasks longer than
              <input className="input" type="number" min={1} max={120} style={{ width: 64 }} value={s.longTaskMin} disabled={s.notifyEveryFinish}
                onChange={(e) => set({ longTaskMin: num(e.target.value, 1, 120) })} aria-label="Minutes" /> min</label>
          </div>
        )}
        <div className="row" style={{ gap: 14, alignItems: "flex-end" }}>
          <div className="field" style={{ width: 260 }}><label>Permission notification after (seconds)</label>
            <input className="input" type="number" min={5} max={600} value={s.permissionPopupSec} onChange={(e) => set({ permissionPopupSec: num(e.target.value, 5, 600) })} /></div>
          <button className="btn small" onClick={() => void window.crewglass!.testNotification().then((r) => toast(r.ok ? "Test notification sent" : "Couldn't send it",
            r.ok ? "If nothing appeared: System Settings → Notifications → Crewglass → Allow Notifications." : r.error ?? ""))}>
            <Icon name="bell" size={13} /> Send a test notification</button>
        </div>
      </section>

      <section className="col" style={{ gap: 8 }}>
        <h3>Safeguards</h3>
        <div className="field"><label>Pause a command after it fails this many times in a row (no file changes in between)</label>
          <div className="seg" role="radiogroup">
            {[2, 3, 4, 5].map((n) => <button key={n} className={s.breakerThreshold === n ? "on" : ""} role="radio" aria-checked={s.breakerThreshold === n} onClick={() => set({ breakerThreshold: n })}>{n}</button>)}
          </div>
        </div>
      </section>

      <section className="col" style={{ gap: 8 }}>
        <h3>Your data</h3>
        <div className="muted small">Stored only on this Mac, in <span className="mono">{s.dataFolder}</span>: settings, backups from each save (kept 30 days), your confirmed check commands, and each session's numbers for the History tab. Numbers and names only — never prompt or reply text.</div>
        <div className="field" style={{ width: 260 }}><label>Keep usage history for (days)</label>
          <input className="input" type="number" min={30} max={365} value={s.historyDays} onChange={(e) => set({ historyDays: num(e.target.value, 30, 365) })} />
          <span className="muted small">Claude Code's own transcripts only go back 30 days.</span></div>
        <div className="row" style={{ gap: 8 }}>
          {confirmDelete
            ? <><span className="small">Delete settings, backups and checks? Live mode stays removable.</span><button className="btn danger small" onClick={() => void deleteAll()}>Delete</button><button className="btn small" onClick={() => setConfirmDelete(false)}>Cancel</button></>
            : <button className="btn small" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={13} /> Delete all data…</button>}
          <div className="spacer" />
          <button className="btn small" onClick={() => useDeck.setState({ uninstallOpen: true })}>Uninstall Crewglass…</button>
        </div>
      </section>
      <div className="muted small">Crewglass {s.version} · local only · no network</div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useDeck((st) => st.settingsOpen || st.uninstallOpen);
  const uninstall = useDeck((st) => st.uninstallOpen);
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => { if (open && window.crewglass) void window.crewglass.getSettings().then(setS); }, [open]);
  if (!open) return null;
  const set = (patch: Partial<AppSettings>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    void window.crewglass?.updateSettings(patch).then((n) => {
      setS(n);
      if (patch.limits) useDeck.setState({ limits: n.limits });
    });
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={uninstall ? "Uninstall Crewglass" : "Settings"} style={{ maxWidth: 760 }}>
        <div className="dialog-head">
          <h2 className="grow">{uninstall ? "Uninstall Crewglass" : "Settings"}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        {!window.crewglass ? <div style={{ padding: 20 }} className="muted">Settings are part of the real app.</div>
          : uninstall ? <Uninstall onCancel={() => useDeck.setState({ uninstallOpen: false })} />
          : s ? <Settings s={s} set={set} /> : <div style={{ padding: 20 }} className="muted">Loading…</div>}
      </div>
    </div>
  );
}
