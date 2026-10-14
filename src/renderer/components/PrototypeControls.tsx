// Prototype-only panel: triggers the situations you'd otherwise have to wait for, so every screen can be tried.
// Not part of the real app.

import { actions, useDeck } from "../state/store";
import { Icon } from "./ui";

const SCENARIOS: [string, string][] = [
  ["this-chat", "Just this chat (one agent, no team)"],
  ["failing-command", "A command fails 3 times"],
  ["approval", "A costly direct call needs your OK"],
  ["check-fails", "Coder's work fails its check (2 tries)"],
  ["permission", "Claude waits for permission (pop-up after 20 s)"],
  ["limit-80", "Session at 80% of its limit"],
  ["limit-100", "Session reaches its limit"],
  ["context", "Context window 86% full"],
  ["stuck", "Claude may be stuck"],
  ["mcp-died", "An MCP server stops"],
  ["two-sessions", "Add a terminal session in /src"],
  ["unknown-fields", "Claude Code update: unknown fields"],
  ["secret", "Paste a GitHub token into an agent"],
  ["reset", "Start over (first-run wizard)"],
];

export function PrototypeControls() {
  const open = useDeck((s) => s.protoOpen);
  return (
    <>
      <button className="btn small proto-btn" onClick={() => useDeck.setState({ protoOpen: !open })} title="Prototype only: trigger situations to try each screen">
        <Icon name="flask" size={14} /> Prototype: try a situation
      </button>
      {open && (
        <div className="proto-panel" role="dialog" aria-label="Prototype situations">
          <div className="row"><strong className="grow">Prototype: try a situation</strong>
            <button className="icon-btn" onClick={() => useDeck.setState({ protoOpen: false })} aria-label="Close"><Icon name="x" /></button></div>
          <div className="muted small">These fake events show how each part behaves. The real app gets them from Claude Code.</div>
          {SCENARIOS.map(([id, label]) => (
            <button key={id} className="btn small" onClick={() => { actions.scenario(id); if (id !== "reset") useDeck.setState({ protoOpen: false }); }}>{label}</button>
          ))}
        </div>
      )}
    </>
  );
}
