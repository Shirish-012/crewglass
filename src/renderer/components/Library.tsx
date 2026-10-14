import { useState, type DragEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { actions, toast, useDeck } from "../state/store";
import { EFFORTS, LISTED_CLAUDE, findModel, geminiModels, modelLabel, modelWithEffort } from "@shared/models";
import { priceOf } from "@shared/pricing";
import { checkCommandProblem } from "@shared/checks";
import type { Agent, Effort, McpScope } from "@shared/types";
import { BUILTIN_AGENTS, ROLE_TEMPLATES, TEAM_PRESETS } from "../mock/fixtures";
import { Icon } from "./ui";
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

const EFFORT_HINT: Record<Effort, string> = {
  low: "fastest, cheapest — quick lookups and simple edits", medium: "balanced — most everyday work",
  high: "more careful — tricky changes and reviews", xhigh: "deep — long, hard coding tasks", max: "deepest, priciest — when correctness matters most",
};
/** One compact picker instead of a row of effort chips per model: choose a model and effort, then apply it to the
 *  selected agent or start a new agent with it — or drag the card onto any agent. */
function ModelPicker({ selected, onApply, geminiExtra }: { selected?: Agent; onApply: (model: string, effort?: Effort) => void; geminiExtra: string[] }) {
  const [model, setModel] = useState("claude-opus-5-5");
  const [effort, setEffort] = useState<Effort>("medium");
  const m = findModel(model);
  const gemini = model.startsWith("gemini-") || m?.family === "gemini";
  const usesEffort = !gemini && m?.usesEffort !== false;
  const price = priceOf(model);
  const chosenEffort = usesEffort ? effort : undefined;
  const label = gemini ? `agy · ${modelLabel(model)}` : modelWithEffort(model, chosenEffort);
  const target = selected && selected.kind !== "builtin" && (gemini ? selected.kind === "agy" : selected.kind !== "agy") ? selected : undefined;
  return (
    <div className="model-picker" draggable onDragStart={drag({ t: "model", model, effort: chosenEffort })} title="Drag onto an agent, or use the button">
      <div className="field"><label>Model</label>
        <select className="select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          <optgroup label="Claude">{LISTED_CLAUDE().map((x) => <option key={x.id} value={x.id}>{x.label} · {x.contextWindow >= 1_000_000 ? "1M" : "200k"} context</option>)}</optgroup>
          <optgroup label="Gemini via agy">{geminiModels(geminiExtra.map((id) => ({ id }))).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>
        </select>
      </div>
      {usesEffort ? (
        <div className="field"><label>Effort</label>
          <div className="seg" role="radiogroup" aria-label="Effort">
            {EFFORTS.map((e) => <button key={e} className={effort === e ? "on" : ""} role="radio" aria-checked={effort === e} onClick={() => setEffort(e)}>{e}</button>)}
          </div>
          <span className="muted small">{EFFORT_HINT[effort]}</span>
        </div>
      ) : <span className="muted small">{gemini ? "Gemini runs through agy; its effort is part of the model name." : "This model has no effort setting."}</span>}
      {price && <span className="muted small">${price.input} in · ${price.output} out per million tokens (Claude API prices)</span>}
      <button className="btn primary small" onClick={() => onApply(model, chosenEffort)}>
        <Icon name={target ? "check" : "plus"} size={13} /> {target ? `Set ${target.name} to ${label}` : `New ${gemini ? "agy agent" : "agent"} · ${label}`}
      </button>
      <span className="muted small">Select an agent first to change its model, or drag this card onto it.</span>
    </div>
  );
}

/** "Add agent ▾": one tidy menu of ready-made roles (what each is for, and its model) instead of a cloud of chips. */
const ROLE_HINT: Record<string, string> = {
  explorer: "finds where/how things work · read-only", planner: "plans before code is written", coder: "writes and changes code",
  reviewer: "reviews changes · PASS / FAIL", tester: "runs and fixes tests", researcher: "answers questions with sources", "docs-writer": "updates README and docs",
};
function AddAgentMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const add = (id: string) => { setAt(null); actions.addAgentFromTemplate(id, nextFreePosition()); };
  return (
    <div style={{ padding: "4px 8px 8px" }}>
      <button className="btn small" style={{ width: "100%", justifyContent: "center" }} aria-haspopup="menu" aria-expanded={!!at}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom + 4 }); }}>
        <Icon name="plus" size={13} /> Add agent <Icon name="down" size={12} />
      </button>
      {at && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={() => setAt(null)} />
          <div className="menu" role="menu" style={{ left: at.x, top: at.y, width: 300 }}>
            <div className="sub-title">Add an agent to this team (you can edit everything after)</div>
            {ROLE_TEMPLATES.map((t) => (
              <button key={t.id} role="menuitem" onClick={() => add(t.id)} title={t.role}>
                <span className="grow"><b>{t.name}</b> <span className="muted small">— {ROLE_HINT[t.id] ?? t.role}</span></span>
                <span className="muted small">{modelWithEffort(t.model, t.effort)}</span>
              </button>
            ))}
            <div className="sep" />
            <div className="sub-title">Or drag a model from Models onto the canvas for a blank agent</div>
          </div>
        </>
      )}
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
          <AddAgentMenu />
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
          <ModelPicker selected={selectedAgent} onApply={addModel} geminiExtra={s.agy.models} />
          <div className="lib-sub row"><span className="grow">Gemini models come from agy (via a tiny Haiku relay)</span>
            <button className="btn ghost small" disabled={refreshing} onClick={() => void refreshGemini()}
              title="Runs `agy models` once, only now. agy may contact Google to answer.">{refreshing ? "Asking agy…" : "Refresh list"}</button></div>
          {!s.agy.ready && <div className="hint small" style={{ margin: "0 8px 6px" }}><Icon name="info" size={13} /><span>agy agents can't run here yet: {s.agy.missing}.</span></div>}
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
