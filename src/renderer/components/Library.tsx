import { useState, type DragEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { actions, toast, useDeck } from "../state/store";
import { EFFORTS, LISTED_CLAUDE, geminiModels, modelWithEffort } from "@shared/models";
import { checkCommandProblem } from "@shared/checks";
import type { Effort, McpScope } from "@shared/types";
import { BUILTIN_AGENTS, ROLE_TEMPLATES, TEAM_PRESETS } from "../mock/fixtures";
import { Icon, seriesVar } from "./ui";
import { FormatNotice } from "./FormatNotice";

export const DND_TYPE = "application/x-crewglass";
export type DragPayload =
  | { t: "template"; id: string }
  | { t: "model"; model: string; effort?: Effort }
  | { t: "user-agent"; key: string }
  | { t: "mcp"; key: string }
  | { t: "check"; id: string };

const drag = (p: DragPayload) => (e: DragEvent) => {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(p));
  e.dataTransfer.effectAllowed = "copy";
};

export function nextFreePosition() {
  const n = Object.keys(useDeck.getState().agents).length;
  return { x: 300 * (n % 6), y: 250 + 220 * Math.floor(n / 6) };
}

function Section({ title, children, open: initial = true, count }: { title: string; children: ReactNode; open?: boolean; count?: number }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="lib-section">
      <button className="lib-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "down" : "right"} size={13} /> {title}
        {count !== undefined && <span className="muted" style={{ fontWeight: 400, textTransform: "none" }}>{count}</span>}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function Item({ icon, title, sub, payload, onAdd, addTitle, right }: {
  icon: ReactNode; title: string; sub?: ReactNode; payload?: DragPayload; onAdd?: () => void; addTitle?: string; right?: ReactNode;
}) {
  return (
    <div className="lib-item" draggable={!!payload} onDragStart={payload ? drag(payload) : undefined} title={payload ? "Drag onto the canvas, or use +" : undefined}>
      {icon}
      <div className="grow">
        <div className="title truncate">{title}</div>
        {sub && <div className="muted small truncate">{sub}</div>}
      </div>
      {right}
      {onAdd && <button className="icon-btn add" onClick={onAdd} title={addTitle ?? "Add"} aria-label={addTitle ?? `Add ${title}`}><Icon name="plus" size={15} /></button>}
    </div>
  );
}

function AddMcpForm() {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<McpScope>("project");
  const [env, setEnv] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [how, setHow] = useState("");
  const howOk = kind === "http" ? /^https?:\/\/\S+$/.test(how) : how.trim().length > 0 && !/[;&|`$<>]/.test(how);
  const valid = /^[a-z0-9][a-z0-9-]{0,40}$/.test(name) && howOk;
  return (
    <div className="card-box col" style={{ margin: "4px 2px" }}>
      <div className="field"><label>Server name</label><input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. linear" /></div>
      <div className="field"><label>Who gets it</label>
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value as McpScope)}>
          <option value="project">Shared with the repo (.mcp.json)</option>
          <option value="local">Only me, this folder</option>
          <option value="user">Only me, all my projects</option>
        </select>
      </div>
      <div className="field"><label>How Claude reaches it</label>
        <div className="seg"><button className={kind === "stdio" ? "on" : ""} onClick={() => setKind("stdio")}>Runs a command</button>
          <button className={kind === "http" ? "on" : ""} onClick={() => setKind("http")}>Web address</button></div>
        <input className="input" value={how} onChange={(e) => setHow(e.target.value)} placeholder={kind === "http" ? "https://mcp.example.com/mcp" : "npx -y @linear/mcp-server"} />
        {!howOk && how && <span className="small" style={{ color: "var(--critical-ink)" }}>{kind === "http" ? "Use a full https:// address." : "Just the command and its arguments (no ; & | $ or backticks)."}</span>}
      </div>
      <div className="field"><label>Secret names (values are never stored here)</label><input className="input" value={env} onChange={(e) => setEnv(e.target.value.toUpperCase())} placeholder="e.g. LINEAR_API_KEY" /></div>
      <div className="muted small">The file will say <code>${"{"}{env.split(",")[0]?.trim() || "LINEAR_API_KEY"}{"}"}</code>. You put the real value in your shell or private config.</div>
      <div className="row">
        <button className="btn primary small" disabled={!valid} onClick={() => actions.addMcp(name, scope, env.split(",").map((x) => x.trim()).filter(Boolean), kind === "http" ? { url: how.trim() } : { command: how.trim() })}>Add</button>
        <button className="btn ghost small" onClick={() => useDeck.setState({ addMcpOpen: false })}>Cancel</button>
      </div>
    </div>
  );
}

/** Your own command check: one command, run without a shell, e.g. `npm run test:unit` or `pytest -q`. */
function CustomCheck({ onAdd }: { onAdd: (command: string) => boolean }) {
  const [cmd, setCmd] = useState("");
  const problem = cmd.trim() ? checkCommandProblem(cmd) : null;
  return (
    <div className="col" style={{ gap: 4, padding: "6px 8px" }}>
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono grow" placeholder="Your own command, e.g. pytest -q" value={cmd} aria-label="Command for a new check"
          onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !problem && cmd.trim() && onAdd(cmd)) setCmd(""); }} />
        <button className="btn small" disabled={!cmd.trim() || !!problem} onClick={() => { if (onAdd(cmd)) setCmd(""); }}>Add</button>
      </div>
      {problem && <span className="small" style={{ color: "var(--warning-ink)" }}>{problem}</span>}
    </div>
  );
}

export function Library() {
  const [q, setQ] = useState("");
  const s = useDeck(useShallow((st) => ({ agents: st.agents, userAgents: st.userAgents, mcps: st.mcps, checks: st.checks, selection: st.selection, addMcpOpen: st.addMcpOpen, agy: st.agy })));
  const [refreshing, setRefreshing] = useState(false);
  const refreshGemini = async () => {
    const api = window.crewglass;
    if (!api) { toast("Refresh from agy", "Runs `agy models` only when you click. agy may contact Google to answer."); return; }
    setRefreshing(true);
    const r = await api.refreshAgyModels();
    setRefreshing(false);
    if (!r.ok) toast("Couldn't refresh from agy", r.error ?? "Unknown error");
    else toast("Gemini models updated", `${r.models?.length ?? 0} Gemini models found in agy.`);
  };
  const match = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q.toLowerCase()));
  const selectedAgent = s.selection?.type === "agent" ? s.agents[s.selection.id] : undefined;

  const addModel = (model: string, effort?: Effort) => {
    if (selectedAgent) actions.setModel(selectedAgent.key, model, effort);
    else actions.addAgentFromModel(model, effort, nextFreePosition());
  };
  const needAgent = (what: string, fn: (key: string) => void) => {
    if (!selectedAgent) { toast("Select an agent first", `Click an agent on the canvas, then add ${what} — or drag it straight onto the agent.`); return; }
    fn(selectedAgent.key);
  };

  const projectAgents = Object.values(s.agents).filter((a) => a.kind !== "builtin");

  return (
    <aside className="panel left" aria-label="Library">
      <div className="lib-search">
        <div className="row" style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 8, top: 6, color: "var(--muted)" }}><Icon name="search" size={15} /></span>
          <input id="library-search" className="input" style={{ paddingLeft: 28 }} placeholder="Search agents, servers… ⌘F" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }} aria-label="Search the Library" />
        </div>
      </div>
      <div className="lib-body">
        <Section title="Team presets" open={false}>
          {TEAM_PRESETS.filter((p) => match(p.name, p.detail)).map((p) => (
            <div key={p.id} className="preset">
              <div className="row"><strong className="grow">{p.name}</strong>
                {p.id !== "watch" && <button className="btn small" onClick={() => actions.applyPreset(p.id)}>Apply</button>}</div>
              <div className="muted small" style={{ marginTop: 3 }}>{p.detail}</div>
            </div>
          ))}
        </Section>

        <Section title="Agents" count={projectAgents.length}>
          <div className="lib-sub">In this folder</div>
          {projectAgents.length === 0 && <div className="muted small" style={{ padding: "2px 8px 6px" }}>No agents yet — Claude works alone here.</div>}
          {projectAgents.filter((a) => match(a.name, a.role)).map((a) => (
            <Item key={a.key} icon={<Icon name={a.kind === "orchestrator" ? "baton" : a.kind === "agy" ? "sparkle" : "file"} />} title={a.name}
              sub={a.kind === "agy" ? `agy · ${modelWithEffort(a.geminiModel ?? "")}` : modelWithEffort(a.model, a.effort)}
              right={a.keepPrivate ? <span title="Kept private (not in git)"><Icon name="lock" size={13} /></span> : undefined} />
          ))}
          <div className="lib-sub">Add a new agent from a role — drag onto the canvas or click</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 5, padding: "2px 8px 6px" }}>
            {ROLE_TEMPLATES.filter((t) => match(t.name, t.role)).map((t) => (
              <span key={t.id} className="chip selectable" draggable onDragStart={drag({ t: "template", id: t.id })}
                onClick={() => actions.addAgentFromTemplate(t.id, nextFreePosition())} title={`${t.role} (${modelWithEffort(t.model, t.effort)})`}>
                <Icon name="plus" size={12} /> {t.name}
              </span>
            ))}
          </div>
          {s.userAgents.length > 0 && <div className="lib-sub">Available in all your projects</div>}
          {s.userAgents.filter((a) => match(a.name, a.role)).map((a) => (
            <Item key={a.key} icon={<Icon name="team" />} title={a.name}
              sub={a.sameName && !a.sameName.usedByClaude ? "Hidden by this folder's version" : modelWithEffort(a.model, a.effort)}
              payload={{ t: "user-agent", key: a.key }} onAdd={() => actions.addUserAgentToCanvas(a.key, nextFreePosition())} addTitle="Add to this team" />
          ))}
          <div className="lib-sub">Built-in (watch only; appear when used)</div>
          {BUILTIN_AGENTS.filter((b) => match(b.name, b.detail)).map((b) => (
            <Item key={b.name} icon={<Icon name="eye" />} title={b.name} sub={b.detail} />
          ))}
        </Section>

        <Section title="Models">
          <div className="lib-sub">Claude — drag onto an agent to set its model and effort</div>
          {LISTED_CLAUDE().filter((m) => match(m.label)).map((m) => (
            <div key={m.id} className="model-row" draggable onDragStart={drag({ t: "model", model: m.id, effort: m.usesEffort ? "medium" : undefined })}>
              <div className="row">
                <span className="dot" style={{ background: seriesVar(m.colorSlot) }} />
                <strong className="grow">{m.label}</strong>
                <span className="muted small">{m.contextWindow >= 1_000_000 ? "1M" : "200k"} context</span>
                <button className="icon-btn add" onClick={() => addModel(m.id, m.usesEffort ? "medium" : undefined)}
                  title={selectedAgent ? `Set ${selectedAgent.name} to ${m.label}` : `New agent on ${m.label}`}><Icon name="plus" size={15} /></button>
              </div>
              {m.usesEffort ? (
                <div className="efforts">
                  {EFFORTS.map((e) => (
                    <span key={e} className="chip selectable" draggable onDragStart={(ev) => { ev.stopPropagation(); drag({ t: "model", model: m.id, effort: e })(ev); }}
                      onClick={() => addModel(m.id, e)} title={selectedAgent ? `Set ${selectedAgent.name} to ${m.label} · ${e}` : `Drag onto an agent`}>{e}</span>
                  ))}
                </div>
              ) : <div className="muted small" style={{ marginTop: 3 }}>No effort setting for this model</div>}
            </div>
          ))}
          <div className="lib-sub row"><span className="grow">Gemini via agy (runs through a tiny Haiku relay)</span>
            <button className="btn ghost small" disabled={refreshing} onClick={() => void refreshGemini()}
              title="Runs `agy models` once, only now. agy may contact Google to answer.">{refreshing ? "Asking agy…" : "Refresh"}</button></div>
          {!s.agy.ready && <div className="hint small" style={{ margin: "0 8px 6px" }}><Icon name="info" size={13} /><span>agy agents can't run here yet: {s.agy.missing}.</span></div>}
          {geminiModels(s.agy.models.map((id) => ({ id }))).filter((m) => match(m.label)).map((m) => (
            <Item key={m.id} icon={<span className="dot" style={{ background: seriesVar(m.colorSlot) }} />} title={m.label} sub="agy agent"
              payload={{ t: "model", model: m.id }} onAdd={() => addModel(m.id)} addTitle={selectedAgent?.kind === "agy" ? `Set ${selectedAgent.name} to ${m.label}` : "New agy agent"} />
          ))}
        </Section>

        <Section title="MCP servers" count={Object.keys(s.mcps).length}>
          {Object.values(s.mcps).filter((m) => match(m.name)).map((m) => (
            <Item key={m.key} icon={<Icon name="plug" />} title={m.name}
              sub={m.scope === "inherited" ? `Inherited · ${m.source}` : m.scope === "project" ? "Shared (.mcp.json)" : m.scope === "local" ? "Only me, this folder" : "Only me, all projects"}
              payload={{ t: "mcp", key: m.key }} onAdd={() => needAgent(m.name, (k) => actions.connect(k, m.key))} addTitle="Let the selected agent use it" />
          ))}
          {s.addMcpOpen ? <AddMcpForm /> : (
            <button className="btn ghost small" style={{ margin: "4px 6px" }} onClick={() => useDeck.setState({ addMcpOpen: true })}><Icon name="plus" size={14} /> Add MCP server</button>
          )}
        </Section>

        <Section title="Checks">
          {Object.values(s.checks).filter((c) => match(c.label)).map((c) => (
            <Item key={c.key} icon={<Icon name={c.kind === "command" ? "terminal" : "check"} />} title={c.label}
              sub={c.kind === "command" ? "Command · runs when files changed" : c.kind === "verdict" ? "Checker answers VERDICT: PASS/FAIL" : "Different model family"}
              payload={{ t: "check", id: c.key }} onAdd={() => needAgent(c.label, (k) => actions.addCheck(k, c.key))} addTitle="Add to the selected agent" />
          ))}
          <CustomCheck onAdd={(cmd) => {
            const key = actions.addCustomCheck(cmd);
            if (key && selectedAgent) actions.addCheck(selectedAgent.key, key);
            else if (key) toast("Check added", "Drag it onto an agent (or select one and press +) to check its work with it.");
            return !!key;
          }} />
        </Section>
      </div>
      <FormatNotice />
    </aside>
  );
}
