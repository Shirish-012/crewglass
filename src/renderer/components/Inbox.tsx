import { useEffect, useState } from "react";
import { actions, useDeck } from "../state/store";
import type { InboxItem } from "@shared/types";
import { Icon } from "./ui";
import { deckApi, openInVSCode } from "../real/api";

function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((deadline - now) / 1000));
  return <span className="badge warn">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left, then it goes to the orchestrator</span>;
}

function NoteBox({ placeholder, cta, onSend, onCancel }: { placeholder: string; cta: string; onSend: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="col" style={{ marginTop: 8 }}>
      <textarea className="textarea" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
      <div className="row"><button className="btn primary small" disabled={!text.trim()} onClick={() => onSend(text.trim())}>{cta}</button>
        <button className="btn ghost small" onClick={onCancel}>Cancel</button>
        <span className="muted small">Held in memory only.</span></div>
    </div>
  );
}

function Card({ item }: { item: InboxItem }) {
  const [note, setNote] = useState<null | "instructions" | "deny">(null);
  const api = deckApi();
  const r = (choice: string, text?: string) => {
    if (!api) { actions.resolveInbox(item.id, choice, text); return; }
    void api.resolveInbox(item.id, choice, text);
    // "Always allow" also draws the Allowed link, so it's kept once you Save (it's allowed right away either way).
    if (item.kind === "approval" && choice === "always") actions.allowDirect(String(item.data?.caller), String(item.data?.callee));
  };
  const phase1 = item.data?.phase1 === true;
  const liveOn = useDeck((s) => s.mode !== "real" || s.liveActive);
  const icon = item.kind === "approval" ? "lock" : item.kind === "failing-command" || item.kind === "check-failed" || item.kind === "turn-failed" || item.kind === "stuck" || item.kind === "mcp-died" ? "alert" : item.kind === "permission" ? "bell" : item.kind === "agy-calls" ? "sparkle" : "info";

  return (
    <div className={`inbox-card ${item.resolved ? "resolved" : ""}`}>
      <div className="row"><Icon name={icon} /><span className="t grow">{item.title}</span>
        <span className="muted small">{new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
      <div className="d">{item.detail}</div>
      {item.kind === "approval" && !item.resolved && (
        <div className="col" style={{ gap: 4, marginTop: 8 }}>
          <div className="small">Would run on <b>{String(item.data?.model)}</b>. The agent is waiting for your answer.</div>
          {typeof item.data?.deadline === "number" && <Countdown deadline={item.data.deadline} />}
        </div>
      )}
      {item.resolved ? (
        <div className="row small" style={{ marginTop: 8 }}><Icon name="check" size={14} /> {item.resolved}</div>
      ) : note ? (
        <NoteBox placeholder={note === "instructions" ? "e.g. The build needs NODE_ENV=production; set it and try once more." : "Why not? The subagent will see this."}
          cta={note === "instructions" ? "Send to Claude" : "Deny with this note"} onCancel={() => setNote(null)} onSend={(t) => r(note === "instructions" ? "instructions" : "deny", t)} />
      ) : (
        <div className="actions">
          {item.kind === "failing-command" && phase1 && <>
            <button className="btn small" onClick={() => openInVSCode(useDeck.getState().folder)}><Icon name="code" size={13} /> Open VS Code</button>
            <button className="btn ghost small" onClick={() => r("ok")}>OK</button>
          </>}
          {item.kind === "failing-command" && !phase1 && <>
            <button className="btn primary small" onClick={() => r("orchestrator")}><Icon name="baton" size={13} /> Let the orchestrator handle it</button>
            <button className="btn small" onClick={() => setNote("instructions")}>Give instructions…</button>
            <button className="btn small" onClick={() => r("allow")}>Allow retries</button>
            <button className="btn small" onClick={() => r("stop")}><Icon name="stop" size={12} /> Stop Claude</button>
          </>}
          {item.kind === "approval" && <>
            <button className="btn primary small" onClick={() => r("once")}>Approve once</button>
            <button className="btn small" onClick={() => r("always")}>Always allow {String(item.data?.caller)} → {String(item.data?.callee)}</button>
            <button className="btn small" onClick={() => r("orchestrator")}><Icon name="baton" size={13} /> Send to orchestrator</button>
            <button className="btn small" onClick={() => setNote("deny")}>Deny + note…</button>
          </>}
          {item.kind === "permission" && <>
            <button className="btn primary small" onClick={() => openInVSCode(useDeck.getState().folder)}><Icon name="code" size={13} /> Open VS Code</button>
            <button className="btn small" onClick={() => r("answered")}>I answered it</button>
          </>}
          {item.kind === "limit" && <>
            <button className="btn small" onClick={() => r("raise")}>Raise limit by 50%</button>
            {!api && <button className="btn small" onClick={() => r("stop")}><Icon name="stop" size={12} /> Stop Claude</button>}
            <button className="btn ghost small" onClick={() => r("ok")}>OK</button>
          </>}
          {item.kind === "stuck" && (!api || item.data?.live === true) && <>
            <button className="btn small" onClick={() => r("orchestrator")}><Icon name="baton" size={13} /> Let the orchestrator handle it</button>
            <button className="btn small" onClick={() => setNote("instructions")}>Give instructions…</button>
            <button className="btn small" onClick={() => r("stop")}><Icon name="stop" size={12} /> Stop Claude</button>
          </>}
          {item.kind === "stuck" && api && item.data?.live !== true && <button className="btn small" onClick={() => openInVSCode(useDeck.getState().folder)}><Icon name="code" size={13} /> Open VS Code</button>}
          {item.kind === "agy-calls" && liveOn && <button className="btn small" onClick={() => r("stop")}><Icon name="stop" size={12} /> Stop Claude</button>}
          {(item.kind === "check-failed" || item.kind === "context" || item.kind === "mcp-died" || item.kind === "agy-calls" || item.kind === "turn-failed" || item.kind === "stuck") && <button className="btn ghost small" onClick={() => r("ok")}>OK</button>}
        </div>
      )}
    </div>
  );
}

export function Inbox() {
  const open = useDeck((s) => s.inboxOpen);
  const inbox = useDeck((s) => s.inbox);
  if (!open) return null;
  const openItems = inbox.filter((i) => !i.resolved);
  const done = inbox.filter((i) => i.resolved);
  return (
    <aside className="drawer" aria-label="Attention inbox">
      <div className="drawer-head"><Icon name="bell" /><strong className="grow">Needs your attention</strong>
        <button className="icon-btn" onClick={() => useDeck.setState({ inboxOpen: false })} aria-label="Close"><Icon name="x" /></button></div>
      <div className="drawer-body">
        {openItems.length === 0 && <div className="muted">Nothing needs you right now. Things that need a decision show up here; only urgent ones also pop up.</div>}
        {openItems.map((i) => <Card key={i.id} item={i} />)}
        {done.length > 0 && <div className="lib-sub" style={{ padding: "6px 0 0" }}>Done</div>}
        {done.slice(0, 20).map((i) => <Card key={i.id} item={i} />)}
      </div>
    </aside>
  );
}

export function Toasts() {
  const toasts = useDeck((s) => s.toasts);
  const inboxOpen = useDeck((s) => s.inboxOpen);
  // Pop-ups about inbox items are redundant once the inbox itself is open.
  const visible = inboxOpen ? toasts.filter((t) => !t.inboxId) : toasts;
  return (
    <div className="toasts" aria-live="polite">
      {visible.map((t) => (
        <div key={t.id} className="toast" role="status" onClick={() => {
          useDeck.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id), inboxOpen: t.inboxId ? true : s.inboxOpen }));
        }}>
          <div className="from">{t.inboxId ? "macOS notification (simulated)" : "Crewglass"}</div>
          <div className="t">{t.title}</div>
          <div className="d">{t.body}</div>
        </div>
      ))}
    </div>
  );
}
