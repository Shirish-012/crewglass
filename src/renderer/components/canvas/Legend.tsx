import { useDeck } from "../../state/store";
import { Icon } from "../ui";

function Line({ color, dash, opacity = 1 }: { color: string; dash?: string; opacity?: number }) {
  return (
    <svg className="sample" height="10" viewBox="0 0 54 10" aria-hidden="true">
      <line x1="2" y1="5" x2="52" y2="5" stroke={color} strokeWidth="2" strokeDasharray={dash} opacity={opacity} />
    </svg>
  );
}

export function Legend() {
  return (
    <div className="legend-pop" role="dialog" aria-label="Legend">
      <div className="row"><strong className="grow">What the canvas shows</strong>
        <button className="icon-btn" onClick={() => useDeck.setState({ legendOpen: false })} aria-label="Close"><Icon name="x" /></button></div>
      <div className="row"><Line color="var(--ink-2)" /><span><b>Solid</b> — part of your team (you drew or kept it)</span></div>
      <div className="row"><Line color="var(--ink-2)" dash="7 5" /><span><b>Dashed</b> — Claude did this, but it isn't in your plan. Click <b>Keep</b> to add it</span></div>
      <div className="row"><Line color="var(--ink-2)" opacity={0.5} /><span><b>Faint</b> — planned but not used yet</span></div>
      <div className="row"><Line color="var(--accent)" /><span><b>Blue</b> — a subagent calling another directly (needs a Reason and an approval)</span></div>
      <div className="row"><Line color="var(--muted)" /><span><b>Grey</b> — an agent can use an MCP server</span></div>
      <div className="row"><Line color="var(--ink-2)" dash="2 4" /><span><b>Dotted</b> — work checked by another agent (✓ passed, ✗ failed, ⏳ checking)</span></div>
      <div className="divider" />
      <div className="row"><span className="status-dot st-running" /> Running <span className="status-dot st-waiting" style={{ marginLeft: 10 }} /> Waiting for you <span className="status-dot st-failed" style={{ marginLeft: 10 }} /> Failed</div>
      <div className="row"><Icon name="chat" size={14} /><span><b>Claude Code chat</b> — leads the team by default. Make an agent the orchestrator only if new chats should run as it</span></div>
      <div className="row"><span className="double-sample" aria-hidden="true" /><span><b>Double border</b> — the agent your open Claude chat runs as (none when the chat is plain Claude)</span></div>
      <div className="row"><Icon name="baton" size={14} /> Orchestrator <Icon name="lock" size={14} /> Kept private (not in git)</div>
      <div className="muted">Moving lines = happening right now. Right-click any card for more actions.</div>
    </div>
  );
}
