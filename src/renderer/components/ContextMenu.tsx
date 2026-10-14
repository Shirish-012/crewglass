import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { actions, useDeck } from "../state/store";
import { MODELS, modelWithEffort } from "@shared/models";
import type { Effort } from "@shared/types";
import { Icon } from "./ui";
import { openInVSCode } from "../real/api";

const QUICK_MODELS: [string, Effort | undefined][] = [
  ["claude-opus-5-5", "high"], ["claude-opus-5-5", "medium"], ["claude-sonnet-5-5", "high"], ["claude-sonnet-5-5", "medium"],
  ["claude-sonnet-5-5", "low"], ["claude-haiku-4-5-20251001", undefined],
];

export function ContextMenu() {
  const { menu, agents, mcps, checks, orchestratorKey } = useDeck(useShallow((s) => ({ menu: s.menu, agents: s.agents, mcps: s.mcps, checks: s.checks, orchestratorKey: s.orchestratorKey })));
  const [sub, setSub] = useState<"model" | "check" | null>(null);
  useEffect(() => {
    setSub(null);
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") useDeck.setState({ menu: null }); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  if (!menu) return null;
  const close = () => useDeck.setState({ menu: null });
  const run = (fn: () => void) => () => { fn(); close(); };
  const style = { left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 360) };

  if (menu.key.startsWith("mcp:")) {
    const m = mcps[menu.key];
    return (
      <div className="menu" style={style} role="menu" onMouseLeave={close}>
        <div className="sub-title">{m?.name}</div>
        <button onClick={run(() => actions.removeMcp(menu.key))}><Icon name="trash" /> Remove server</button>
      </div>
    );
  }

  const a = agents[menu.key];
  if (!a) return null;
  const editable = a.kind !== "builtin";

  if (sub === "model") {
    const list: [string, Effort | undefined][] = a.kind === "agy" ? MODELS.filter((m) => m.family === "gemini").map((m) => [m.id, undefined]) : QUICK_MODELS;
    return (
      <div className="menu" style={style} role="menu" onMouseLeave={close}>
        <button onClick={() => setSub(null)}><Icon name="right" /> Back</button>
        <div className="sep" />
        {list.map(([m, e]) => <button key={`${m}${e}`} onClick={run(() => actions.setModel(a.key, m, e))}>{modelWithEffort(m, e)}</button>)}
      </div>
    );
  }
  if (sub === "check") {
    return (
      <div className="menu" style={style} role="menu" onMouseLeave={close}>
        <button onClick={() => setSub(null)}><Icon name="right" /> Back</button>
        <div className="sep" />
        {Object.values(checks).map((c) => <button key={c.key} onClick={run(() => actions.addCheck(a.key, c.key))}>{c.label}</button>)}
      </div>
    );
  }

  return (
    <div className="menu" style={style} role="menu" onMouseLeave={close}>
      <div className="sub-title">{a.name}</div>
      {editable && a.kind !== "agy" && a.key !== orchestratorKey && <button onClick={run(() => actions.makeOrchestrator(a.key))}><Icon name="baton" /> Make orchestrator</button>}
      {a.key === orchestratorKey && <button onClick={run(() => actions.letChatLead())}><Icon name="chat" /> Let the chat lead instead</button>}
      {editable && <button onClick={() => setSub("model")}><Icon name="sparkle" /> Change model <span className="muted" style={{ marginLeft: "auto" }}>▸</span></button>}
      {editable && <button onClick={() => setSub("check")}><Icon name="check" /> Add check <span className="muted" style={{ marginLeft: "auto" }}>▸</span></button>}
      {editable && <button onClick={run(() => actions.duplicate(a.key))}><Icon name="copy" /> Duplicate</button>}
      {editable && <div className="sep" />}
      {editable && <button onClick={run(() => actions.toggleDisabled(a.key))}><Icon name="eye" /> {a.disabled ? "Enable in this folder" : "Disable in this folder"}</button>}
      {editable && <button onClick={run(() => actions.deleteAgent(a.key))}><Icon name="trash" /> Delete file (backup kept)</button>}
      {a.file && <button onClick={run(() => openInVSCode(a.file))}><Icon name="code" /> Open file in VS Code</button>}
      {!editable && <div className="sub-title">Built-in agents are watch only</div>}
    </div>
  );
}
