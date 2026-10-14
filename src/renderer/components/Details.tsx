import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { actions, AGY_SEEN, linkCostly, toast, useDeck } from "../state/store";
import { EFFORTS, MODELS, findModel, formatTokens, geminiModels, modelLabel, modelWithEffort } from "@shared/models";
import type { Agent, DirectState, Effort, Link } from "@shared/types";
import { Icon, ModelChip, StatusText } from "./ui";
import { openInVSCode } from "../real/api";
import { CHAT_KEY } from "@shared/teamMap";

const BUILTIN_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Skill"];

/** Text field that commits once on blur, so each edit is one undo step with one plain-English summary. */
function CommitField({ label, value, onCommit, multiline, rows, validate, hint }: {
  label: string; value: string; onCommit: (v: string) => void; multiline?: boolean; rows?: number; validate?: (v: string) => string | null; hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = validate?.(draft) ?? null;
  const commit = () => { if (draft !== value && !error) onCommit(draft); };
  return (
    <div className="field">
      <label>{label}</label>
      {multiline
        ? <textarea className="textarea" rows={rows ?? 3} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
        : <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />}
      {error ? <span className="small" style={{ color: "var(--critical-ink)" }}>{error}</span> : hint ? <span className="muted small">{hint}</span> : null}
    </div>
  );
}

function hintsFor(s: ReturnType<typeof useDeck.getState>): string[] {
  const hints: string[] = [];
  const orch = s.orchestratorKey ? s.agents[s.orchestratorKey] : undefined;
  const leader = orch?.key ?? CHAT_KEY;
  const team = Object.values(s.agents).some((a) => a.kind === "subagent" || a.kind === "agy");
  if ((orch || team) && !s.links.some((l) => l.from === leader && l.kind === "delegates" && l.planned))
    hints.push(orch ? `The orchestrator (${orch.name}) has no agents to hand work to.` : "Your chat has no agents to hand work to. Drag from the chat card to an agent.");
  const coder = s.agents["project:coder"];
  const reviewer = s.agents["project:reviewer"];
  if (coder && reviewer && coder.model === reviewer.model) hints.push("reviewer uses the same model as coder. A different model catches more mistakes.");
  for (const a of Object.values(s.agents)) {
    if (a.kind === "agy" && a.model !== "haiku") hints.push(`${a.name} is a relay; Haiku is enough for it.`);
    if (a.kind === "subagent" && /cod|build|impl/.test(a.name) && a.checks.length === 0 && !s.links.some((l) => l.kind === "checkedBy" && l.from === a.key)) hints.push(`${a.name} has no checks — its work isn't verified.`);
  }
  if (!s.liveMode && s.mode !== "real") hints.push("Live mode is off, so reasons and approvals for direct calls can't be checked.");
  return hints;
}

function AgentDetails({ a }: { a: Agent }) {
  const s = useDeck(useShallow((st) => ({ links: st.links, mcps: st.mcps, checks: st.checks, orchestratorKey: st.orchestratorKey, orchestratorPaused: st.orchestratorPaused, agents: st.agents, agy: st.agy })));
  const editable = a.kind !== "builtin" && a.scope !== "builtin";
  const model = findModel(a.model);
  const uses = s.links.filter((l) => l.from === a.key && l.kind === "uses" && l.planned).map((l) => s.mcps[l.to]?.name).filter(Boolean);
  const outgoing = s.links.filter((l) => l.from === a.key && l.kind === "direct" && l.planned && l.directState !== "blocked");
  const isOrch = a.key === s.orchestratorKey;
  const [showInstr, setShowInstr] = useState(false);
  const upd = (patch: Partial<Agent>, summary: string) => actions.updateAgent(a.key, patch, summary);

  return (
    <>
      <div>
        <div className="row"><h2 className="grow truncate">{a.name}</h2>{a.keepPrivate && <span className="badge"><Icon name="lock" size={11} /> private</span>}</div>
        <div className="row small muted" style={{ marginTop: 3 }}>
          <span>{isOrch ? "Orchestrator" : a.kind === "agy" ? "agy agent" : a.kind === "builtin" ? "Built-in · watch only" : a.scope === "user" ? "All-projects agent" : "Subagent"}</span>
          <span>·</span><StatusText status={a.status} parallel={a.parallel} />
        </div>
        {a.file && <div className="mono muted" style={{ marginTop: 4, fontSize: 11 }}>{a.file}</div>}
      </div>

      {editable && a.kind !== "agy" && (isOrch ? (
        <div className="card-box col">
          <div className="small">Every <b>new</b> Claude Code chat in this folder (VS Code or terminal) runs as <b>{a.name}</b> and hands the work out. It always keeps the Agent tool.</div>
          <button className="btn small" onClick={() => actions.letChatLead()}><Icon name="chat" size={13} /> Let the chat lead instead (default)</button>
        </div>
      ) : (
        <div className="col" style={{ gap: 4 }}>
          <button className="btn" onClick={() => actions.makeOrchestrator(a.key)}><Icon name="baton" size={14} /> Make orchestrator</button>
          <span className="muted small">Your Claude Code chat leads by default. Make an agent the orchestrator only if you want new chats to run as it.</span>
        </div>
      ))}

      {a.lenientHeader && (
        <div className="hint"><Icon name="info" size={15} />
          <span>This file's header isn't strict YAML (for example a description containing “: ”). Claude Code reads it anyway; if you save this agent from here, its header is rewritten properly — you'll see it in the diff.</span></div>
      )}

      {a.sameName && (
        <div className="hint col" style={{ alignItems: "stretch" }}>
          <div className="row" style={{ gap: 8, alignItems: "flex-start" }}><Icon name="info" size={15} />
            <span>{a.sameName.usedByClaude
              ? "Another agent is also named “" + a.name + "”. Claude uses this one, so the other copy never runs."
              : "Claude uses the other “" + a.name + "” instead of this one, so this copy never runs."} Claude picks agents by name, so give one of them a new name to use both.</span></div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {editable && <button className="btn small" onClick={() => actions.renameCopy(a.key)}>Rename this copy</button>}
            <button className="btn small" onClick={() => {
              const other = a.sameName!.otherKey;
              if (useDeck.getState().agents[other]) actions.select({ type: "agent", id: other });
              else toast("The other copy", "It's in the Library, under your all-projects agents.");
            }}>Show the other copy</button>
          </div>
        </div>
      )}

      {a.kind === "agy" && (
        <div className="card-box col" style={{ gap: 6 }}>
          <h3 style={{ margin: 0 }}>Gemini through agy</h3>
          <dl className="kv">
            <dt>Last call</dt>
            <dd>{a.gemini?.model ? <><ModelChip model={a.gemini.model} prefix="agy · " />{a.gemini.lastSeconds !== null && ` ${a.gemini.lastSeconds.toFixed(1)} s`}</> : "No call seen yet"}</dd>
            <dt>Today</dt>
            <dd>{a.gemini?.callsToday ?? 0} call{a.gemini?.callsToday === 1 ? "" : "s"} · {formatTokens(a.gemini?.tokensToday ?? 0)} Gemini tokens <span className="muted small">(Google's quota, counted apart from Claude's)</span></dd>
          </dl>
          {a.gemini?.model && a.geminiModel && a.geminiModel !== "agy-default" && a.gemini.model !== a.geminiModel && (
            <div className="small" style={{ color: "var(--warning-ink)" }}>Set to {modelLabel(a.geminiModel)}, but the last call ran on {modelLabel(a.gemini.model)}.</div>
          )}
          <div className="muted small">{a.scope === "builtin"
            ? "Claude ran agy itself here (not through an agy agent). agy sends the task to Google."
            : "The relay hands the task to Crewglass's agy bridge, set up privately for this folder (only on this Mac). agy sends the task to Google."}</div>
          {!s.agy.ready && <div className="hint"><Icon name="alert" size={15} /><span>Can't run here yet: {s.agy.missing}.</span></div>}
        </div>
      )}

      {a.actualModel && (
        <div className="hint"><Icon name="alert" size={15} /><span>{a.kind === "orchestrator"
          ? `The chat running as ${a.name} is on ${modelWithEffort(a.actualModel, a.actualEffort)}, not what's set here. A model or effort you pick in the chat wins for that chat; new chats start on what's set here.`
          : `Its last run used ${modelWithEffort(a.actualModel, a.actualEffort)}, not what's set here.`}</span></div>
      )}
      {a.kind === "orchestrator" && a.effort === "max" && findModel(a.model)?.usesEffort !== false && (
        <div className="muted small">Claude Code can't start a chat at max effort, so new chats start at xhigh. Pick max in the chat (/model) when you need it.</div>
      )}

      {a.liveNow && a.status === "running" && (
        <div className="card-box col" style={{ gap: 4 }}>
          <h3 style={{ margin: 0 }}>Live now</h3>
          <div>{a.liveNow.action}</div>
          <div className="row small ink2"><ModelChip model={a.liveNow.model} effort={a.liveNow.effort} /> {formatTokens(a.liveNow.tokens)} tokens this task</div>
        </div>
      )}

      {!editable ? (
        <div className="col">
          <div className="ink2">{a.role}</div>
          {a.kind !== "agy" && <div className="row"><ModelChip model={a.model} effort={a.effort} /></div>}
          <div className="muted small">{a.kind === "agy"
            ? "To give agy a role on your team, drag a Gemini model from the Library onto the canvas: that makes an agy agent you can edit."
            : "Built-in agents come with Claude Code and can't be edited. They appear here once Claude uses them."}</div>
        </div>
      ) : (
        <>
          <CommitField label="Name" value={a.name} onCommit={(v) => upd({ name: v }, `Rename ${a.name} to ${v}`)}
            validate={(v) => (/^[a-z0-9][a-z0-9-]{0,63}$/.test(v) ? null : "Use lowercase letters, numbers and hyphens.")} />
          <CommitField label="Role — when Claude should use it" value={a.role} multiline rows={3} onCommit={(v) => upd({ role: v }, `Edit ${a.name}'s role`)}
            hint="Claude reads this to decide when to delegate. Start with “Use when…”." />

          {a.kind === "agy" ? (
            <div className="field">
              <label>Gemini model (via agy)</label>
              <select className="select" value={a.geminiModel} onChange={(e) => actions.setModel(a.key, e.target.value)}>
                {geminiModels(s.agy.models.map((id) => ({ id }))).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <span className="muted small">Relay: {modelLabel(a.model)} · max {a.maxTurns} turns — it only forwards the task, so it stays cheap.</span>
            </div>
          ) : (
            <>
              <div className="field">
                <label>Model</label>
                <select className="select" value={model?.id ?? a.model} onChange={(e) => actions.setModel(a.key, e.target.value, a.effort)}>
                  {MODELS.filter((m) => m.family === "claude" && (m.listed !== false || m.id === model?.id)).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Effort</label>
                {model?.usesEffort ? (
                  <div className="seg" role="radiogroup">
                    {EFFORTS.map((e) => <button key={e} className={a.effort === e ? "on" : ""} role="radio" aria-checked={a.effort === e}
                      onClick={() => actions.setModel(a.key, a.model, e as Effort)}>{e}</button>)}
                  </div>
                ) : <span className="muted small">{modelLabel(a.model)} has no effort setting.</span>}
              </div>
            </>
          )}

          <div className="row">
            <div className="field" style={{ width: 110 }}>
              <label>Max turns</label>
              <input className="input" type="number" min={1} max={200} value={a.maxTurns ?? ""} onChange={(e) => upd({ maxTurns: Number(e.target.value) || undefined }, `Set ${a.name}'s max turns to ${e.target.value}`)} />
            </div>
            <div className="muted small grow" style={{ paddingTop: 16 }}>Caps runaway work; Claude Code enforces it.</div>
          </div>

          {a.kind !== "agy" && (
            <div className="field">
              <label>Tool access</label>
              <div className="seg">
                <button className={a.toolAccess === "inherit" ? "on" : ""} onClick={() => upd({ toolAccess: "inherit" }, `${a.name} inherits every tool`)}>Inherit everything</button>
                <button className={a.toolAccess === "connected" ? "on" : ""} onClick={() => upd({ toolAccess: "connected" }, `${a.name} gets only what you connect`)}>Only what I connect</button>
              </div>
              {a.toolAccess === "connected" ? (
                <>
                  <div className="tools-grid" style={{ marginTop: 6 }}>
                    {BUILTIN_TOOLS.map((t) => (
                      <label key={t} className="checkbox">
                        <input type="checkbox" checked={a.builtinTools.includes(t)}
                          onChange={(e) => upd({ builtinTools: e.target.checked ? [...a.builtinTools, t] : a.builtinTools.filter((x) => x !== t) }, `${e.target.checked ? "Give" : "Take"} ${a.name} ${e.target.checked ? "" : "away "}${t}`)} /> {t}
                      </label>
                    ))}
                  </div>
                  <span className="muted small">
                    MCP: {uses.length ? uses.join(", ") : "none connected"}.
                    {(outgoing.length > 0 || isOrch) && " Also gets the Agent tool" + (isOrch ? " (orchestrator)." : ` (it may call ${outgoing.map((l) => s.agents[l.to]?.name).join(", ")}).`)}
                  </span>
                </>
              ) : <span className="muted small">No tools list is written, so it can use every tool and every MCP server.</span>}
            </div>
          )}

          <div className="field">
            <label>Checks on its work</label>
            {a.checks.length === 0 && !s.links.some((l) => l.kind === "checkedBy" && l.from === a.key) && <span className="muted small">None yet — drag a check from the Library onto this agent.</span>}
            {a.checks.map((c) => (
              <div key={c} className="row small"><Icon name="terminal" size={13} /><span className="grow">{s.checks[c]?.label}</span><span className="muted">runs when files changed · 2 fix tries</span>
                <button className="icon-btn" onClick={() => actions.removeCheck(a.key, c)} aria-label="Remove check"><Icon name="x" size={13} /></button></div>
            ))}
            {s.links.filter((l) => l.kind === "checkedBy" && l.from === a.key).map((l) => (
              <div key={l.id} className="row small"><Icon name="check" size={13} /><span className="grow">{l.check?.label} by {s.agents[l.to]?.name}</span>
                <span className={`badge ${l.check?.state === "passed" ? "good" : l.check?.state === "failed" ? "bad" : ""}`}>{l.check?.state}</span></div>
            ))}
          </div>

          <div className="field">
            <label>Where it lives</label>
            <div className="seg">
              <button className={a.scope === "project" ? "on" : ""} onClick={() => upd({ scope: "project", file: `.claude/agents/${a.name}.md` }, `Move ${a.name} to this project`)}>This project</button>
              <button className={a.scope === "user" ? "on" : ""} onClick={() => { upd({ scope: "user", file: `~/.claude/agents/${a.name}.md` }, `Move ${a.name} to all my projects`); toast("Affects every project", `${a.name} will be available in all your projects. You'll confirm this again when saving.`); }}>All my projects</button>
            </div>
            <label className="checkbox" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={a.keepPrivate} onChange={(e) => upd({ keepPrivate: e.target.checked }, `${e.target.checked ? "Keep" : "Stop keeping"} ${a.name} private`)} />
              Keep private (not in git)
            </label>
            {a.keepPrivate && <span className="muted small">Added to .git/info/exclude. If the file was already committed, you'll be shown the one command to untrack it.</span>}
          </div>

          <div className="field">
            <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setShowInstr(!showInstr)}>
              <Icon name={showInstr ? "down" : "right"} size={13} /> Instructions
            </button>
            {showInstr && <CommitField label="" value={a.instructions} multiline rows={6} onCommit={(v) => upd({ instructions: v }, `Edit ${a.name}'s instructions`)} />}
          </div>
        </>
      )}

      <dl className="kv"><dt>Calls today</dt><dd>{a.calls}</dd><dt>Tokens today</dt><dd>{formatTokens(a.tokens)}</dd>
        {a.skillsUsed.length > 0 && <><dt>Skills used</dt><dd>{a.skillsUsed.join(", ")}</dd></>}</dl>

      {editable && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn small" onClick={() => openInVSCode(a.file)}><Icon name="code" size={13} /> Open file</button>
          <button className="btn small" onClick={() => actions.duplicate(a.key)}><Icon name="copy" size={13} /> Duplicate</button>
          <button className="btn small" onClick={() => actions.toggleDisabled(a.key)}>{a.disabled ? "Enable here" : "Disable here"}</button>
          <button className="btn small" onClick={() => actions.deleteAgent(a.key)}><Icon name="trash" size={13} /> Delete</button>
        </div>
      )}
    </>
  );
}

const DIRECT_OPTIONS: { v: DirectState; title: string; text: string }[] = [
  { v: "allowed", title: "Allowed", text: "Approved by you in advance. A Reason line is still required." },
  { v: "orchestrator", title: "Orchestrator decides", text: "The subagent asks the orchestrator with REQUEST <agent>: <reason>." },
  { v: "you", title: "Needs your OK", text: "You get a pop-up. No answer in 2 min → it goes to the orchestrator." },
  { v: "blocked", title: "Blocked", text: "Never allowed." },
];

function LinkDetails({ l }: { l: Link }) {
  const s = useDeck(useShallow((st) => ({ agents: st.agents, mcps: st.mcps, checks: st.checks })));
  const costly = useDeck((st) => linkCostly(st, l.to));
  const from = l.from === CHAT_KEY ? "Your chat" : s.agents[l.from]?.name ?? l.from;
  const to = s.agents[l.to]?.name ?? s.mcps[l.to]?.name ?? l.to;
  const meaning = {
    delegates: `${from} hands work to ${to}.`,
    direct: `${from} may call ${to} directly, without going back through the orchestrator. It must give a Reason, and someone must approve.`,
    uses: `${from} can use the ${to} MCP server.`,
    checkedBy: `${from}'s work is checked by ${to}.`,
  }[l.kind];
  const target = s.agents[l.to];

  return (
    <>
      <div><h2>{from} → {to}</h2><div className="ink2" style={{ marginTop: 4 }}>{meaning}</div></div>
      {!l.planned && (l.to === AGY_SEEN || l.from === AGY_SEEN ? (
        <div className="hint"><Icon name="info" size={15} /><span>Claude ran the agy command here (it sent Gemini a task). This isn't a team link — to give Gemini a role, drag a Gemini model from the Library onto the canvas.</span></div>
      ) : (
        <div className="hint"><Icon name="info" size={15} /><span>Claude did this, but it isn't part of your team plan yet.</span>
          <button className="btn primary small x" onClick={() => actions.keepLink(l.id)}>Keep</button></div>
      ))}
      {l.kind === "direct" && (
        <div className="field">
          <label>Who approves {from} → {to}?</label>
          {DIRECT_OPTIONS.map((o) => (
            <button key={o.v} className={`choice ${l.directState === o.v ? "on" : ""}`} onClick={() => actions.setDirectState(l.id, o.v)} role="radio" aria-checked={l.directState === o.v}>
              <div><div style={{ fontWeight: 600 }}>{o.title}</div><div className="muted small">{o.text}</div></div>
            </button>
          ))}
          {costly && <span className="small" style={{ color: "var(--warning-ink)" }}>{to} is costly ({target?.kind === "agy" ? "agy · Gemini" : modelWithEffort(target?.model ?? "", target?.effort)}) — unplanned calls to it always need your OK.</span>}
          <span className="muted small">Limits: at most 2 levels deep, 3 direct calls per agent run.</span>
        </div>
      )}
      {(l.kind === "delegates" || l.kind === "direct") && (s.agents[l.from] || l.from === CHAT_KEY) && s.agents[l.to] && (
        <div className="field">
          <label>Checks on this {l.kind === "direct" ? "call" : "hand-off"}</label>
          <span className="muted small">They check {to}'s work whenever {from} {l.kind === "direct" ? "calls it" : "hands it work"} (on top of {to}'s own checks).</span>
          {(l.checks ?? []).map((k) => (
            <div key={k} className="row" style={{ gap: 6 }}><Icon name="terminal" size={13} /><span className="grow mono small">{s.checks[k]?.label ?? k}</span>
              <button className="icon-btn" onClick={() => actions.removeLinkCheck(l.id, k)} aria-label={`Remove ${s.checks[k]?.label ?? k}`}><Icon name="x" size={12} /></button></div>
          ))}
          <select className="select" value="" onChange={(e) => { if (e.target.value) actions.addLinkCheck(l.id, e.target.value); }} aria-label="Add a check to this hand-off">
            <option value="">Add a check…</option>
            {Object.values(s.checks).filter((c) => c.kind === "command" && !(l.checks ?? []).includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </div>
      )}
      {l.lastReason && <div className="card-box"><h3>Latest reason (not saved)</h3><div>“{l.lastReason}”</div></div>}
      {l.check && (
        <div className="card-box"><h3>{l.check.label}</h3>
          <div className="row"><span className={`badge ${l.check.state === "passed" ? "good" : l.check.state === "failed" ? "bad" : ""}`}>{l.check.state}</span>
            {l.check.tries > 0 && <span className="muted small">fix tries used: {l.check.tries} of 2</span>}</div></div>
      )}
      {l.observed ? (
        <dl className="kv"><dt>Calls</dt><dd>{l.observed.calls}</dd>{l.observed.tokens > 0 && <><dt>Tokens</dt><dd>{formatTokens(l.observed.tokens)}</dd></>}<dt>Last seen</dt><dd>{l.observed.lastSeen}</dd></dl>
      ) : <div className="muted small">Planned, not used yet.</div>}
      {l.planned && <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => actions.removeLink(l.id)}><Icon name="trash" size={13} /> Remove link</button>}
    </>
  );
}

function McpDetails({ k }: { k: string }) {
  const s = useDeck(useShallow((st) => ({ m: st.mcps[k], links: st.links, agents: st.agents })));
  const m = s.m;
  if (!m) return null;
  const users = s.links.filter((l) => l.to === k).map((l) => s.agents[l.from]?.name).filter(Boolean);
  return (
    <>
      <div><h2>{m.name}</h2><div className="ink2" style={{ marginTop: 4 }}>
        {m.scope === "inherited" ? `Inherited from a ${m.source}. It appears because Claude used it here. Sign-in and reconnecting happen in Claude Code (/mcp) or your claude.ai settings — Crewglass never handles connector sign-ins.` : m.scope === "project" ? "Shared with the repo in .mcp.json." : m.scope === "local" ? "Only you, only this folder (your private Claude config)." : "Only you, all your projects."}</div></div>
      <dl className="kv"><dt>State</dt><dd>{m.state}</dd><dt>Calls today</dt><dd>{m.calls}</dd>
        {m.cpu !== undefined && <><dt>Process</dt><dd>{m.cpu}% CPU · {m.memMb} MB</dd></>}
        <dt>Used by</dt><dd>{users.length ? users.join(", ") : "nobody yet"}</dd>
        {m.envNames?.length ? <><dt>Secrets</dt><dd>{m.envNames.map((n) => <code key={n}>${"{"}{n}{"}"} </code>)} <span className="muted small">(values never shown)</span></dd></> : null}</dl>
      {m.state === "needs-approval" && <div className="hint"><Icon name="info" size={15} /><span>Claude will ask you to approve this project server once.</span></div>}
      {m.state === "failing" && <div className="hint"><Icon name="alert" size={15} /><span>Its process stopped. Reconnect it in Claude with /mcp.</span></div>}
      {m.scope !== "inherited" && <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => actions.removeMcp(k)}><Icon name="trash" size={13} /> Remove server</button>}
    </>
  );
}

/** Your Claude Code chat: it leads the team by default (no orchestrator agent). */
function ChatDetails() {
  const { all, links, agents } = useDeck(useShallow((st) => ({ all: st.sessions, links: st.links, agents: st.agents })));
  const sessions = all.filter((x) => x.id !== "none");
  const handsTo = links.filter((l) => l.from === CHAT_KEY && l.kind === "delegates" && l.planned).map((l) => agents[l.to]?.name).filter(Boolean);
  const main = sessions.find((x) => x.status === "busy") ?? sessions[0];
  const pct = main ? Math.round((main.contextTokens / (findModel(main.model)?.contextWindow ?? 200_000)) * 100) : 0;
  return (
    <>
      <div><h2>Claude Code chat</h2><div className="row small muted" style={{ marginTop: 3 }}><Icon name="baton" size={13} /> Leads the team (default)</div></div>
      <div className="ink2">Your VS Code or terminal chat hands work to your agents itself — there's no orchestrator agent. The model is whatever you pick in the chat (/model).</div>
      <dl className="kv">
        <dt>Hands work to</dt><dd>{handsTo.length ? handsTo.join(", ") : "nobody yet — drag from the chat card to an agent"}</dd>
        <dt>Chats open</dt><dd>{sessions.length || "none right now"}</dd>
        {main && <><dt>Now</dt><dd><ModelChip model={main.model} effort={main.effort} /> {main.status === "busy" ? "working" : main.status} · {formatTokens(main.tokens)} tokens · context {pct}%</dd></>}
        {main?.liveNow && <><dt>Doing now</dt><dd>{main.liveNow}</dd></>}
      </dl>
      {sessions.length > 0 && (
        <div className="card-box col" style={{ gap: 4 }}>
          {sessions.map((x) => (
            <div key={x.id} className="row small">
              <Icon name={x.source === "vscode" ? "code" : "terminal"} size={14} />
              <span className="grow truncate">{x.name}{x.subfolder ? ` · /${x.subfolder}` : ""}</span>
              <span className="muted">{x.runsAs ? `runs as ${x.runsAs}` : "plain chat"}</span>
            </div>
          ))}
        </div>
      )}
      <div className="muted small">Type <span className="mono">/workflow &lt;task&gt;</span> in the chat to run the full plan → hand off → verify steps. To have new chats run as an agent instead, right-click that agent → Make orchestrator.</div>
      {!Object.values(agents).some((a) => a.kind === "subagent" || a.kind === "agy") && (
        <button className="btn" onClick={() => actions.applyPreset("plan-code-review")}><Icon name="team" size={14} /> Set up a team (Plan → Code → Review)</button>
      )}
    </>
  );
}

function FolderOverview() {
  const s = useDeck(useShallow((st) => ({ folder: st.folder, sessions: st.sessions, liveMode: st.liveMode, liveActive: st.liveActive, orchestratorKey: st.orchestratorKey, agents: st.agents, orchestratorPaused: st.orchestratorPaused, real: st.mode === "real", loading: st.loading })));
  const hints = useDeck(useShallow((st) => hintsFor(st)));
  const [dismissed, setDismissed] = useState<string[]>([]);
  const orch = s.orchestratorKey ? s.agents[s.orchestratorKey] : undefined;
  return (
    <>
      <div><h2>{s.folder.split("/").pop()}</h2><div className="mono muted" style={{ fontSize: 11, marginTop: 3 }}>{s.folder}</div></div>
      <div className="card-box col" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>Claude Code sessions here</h3>
        {s.sessions.map((x) => (
          <div key={x.id} className="row small">
            <Icon name={x.source === "vscode" ? "code" : "terminal"} size={14} />
            <div className="grow col" style={{ minWidth: 0 }}>
              <span className="truncate" title={x.name}>{x.name}{x.subfolder ? ` · /${x.subfolder}` : ""}</span>
              {x.id !== "none" && <span className="muted truncate">{x.runsAs ? `runs as ${x.runsAs}` : "plain Claude (no agent)"}</span>}
            </div>
            <ModelChip model={x.model} effort={x.effort} />
          </div>
        ))}
        <div className="muted small">Only sessions in this folder are shown. Everything else is ignored.</div>
      </div>
      <div className="card-box col" style={{ gap: 6 }}>
        <div className="row"><span className={`status-dot ${s.liveMode ? "st-running" : "st-idle"}`} /><strong className="grow">Live mode {s.liveMode ? "on" : "off"}</strong>
          <button className="btn small" onClick={() => {
            if (s.real) { useDeck.setState({ liveDialogOpen: true }); return; }
            useDeck.setState({ liveMode: !s.liveMode });
            toast(s.liveMode ? "Live mode off" : "Live mode on", s.liveMode ? "Hooks removed from this folder's settings.local.json. Watching continues from transcripts." : "Hooks added to this folder's settings.local.json (git-ignored).");
          }}>{s.liveMode ? "Turn off" : "Turn on"}</button></div>
        <div className="muted small">
          {s.real && s.liveMode ? (s.liveActive ? "Working ✓ — Claude in this folder reports to Crewglass. Stop and the safeguards are ready." : "Installed. It starts working on Claude's next turn in this folder.")
            : "Adds Stop, the failing-command breaker and permission alerts. Only this folder's settings.local.json is changed, after you see the diff."}
        </div>
        <div className="row"><Icon name="baton" size={14} /><span className="grow">Leads the team: {orch ? `${orch.name} (${modelWithEffort(orch.model, orch.effort)}) — new chats run as it` : "your Claude Code chat (default)"}</span></div>
      </div>
      {s.real && !s.loading.done && <div className="hint"><Icon name="info" size={15} /><span>Reading the last 30 days of Claude Code activity in this folder…</span></div>}
      {hints.filter((h) => !dismissed.includes(h)).map((h) => (
        <div key={h} className="hint"><Icon name="info" size={15} /><span>{h}</span>
          <button className="icon-btn x" onClick={() => setDismissed([...dismissed, h])} aria-label="Dismiss hint"><Icon name="x" size={13} /></button></div>
      ))}
      <div className="muted small">Tip: click a card or a line to edit it. Right-click a card for more. Drag anything from the Library.</div>
    </>
  );
}

export function Details() {
  const sel = useDeck((s) => s.selection);
  const agent = useDeck((s) => (sel?.type === "agent" ? s.agents[sel.id] : undefined));
  const link = useDeck((s) => (sel?.type === "link" ? s.links.find((l) => l.id === sel.id) : undefined));
  return (
    <aside className="panel right" aria-label="Details">
      <div className="details">
        {agent ? <AgentDetails a={agent} /> : link ? <LinkDetails l={link} /> : sel?.type === "mcp" ? <McpDetails k={sel.id} />
          : sel?.type === "session" ? <ChatDetails /> : <FolderOverview />}
      </div>
    </aside>
  );
}
