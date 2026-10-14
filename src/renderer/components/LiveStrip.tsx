import { useShallow } from "zustand/react/shallow";
import { sessionTotals, useDeck, type BottomTab } from "../state/store";
import { formatTokens, modelWithEffort } from "@shared/models";
import { Icon, ModelChip } from "./ui";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Cache traffic, shown apart from the tokens: in a long chat Claude re-saves (writes) and re-reads the whole
 *  conversation, so these numbers dwarf the real work and would make usage look inflated if counted in. */
function CacheLine({ c }: { c: { write: number; read: number } }) {
  return (
    <div className="muted small" title="Cache writes: Claude saving the conversation for reuse (again after the cache expires, e.g. when you come back to a long chat). Cache reads: reusing it on each turn. Claude Code's /cost lists them separately too.">
      Not counted: {formatTokens(c.write)} cache writes · {formatTokens(c.read)} cache reads
    </div>
  );
}

function Usage() {
  const s = useDeck(useShallow((st) => ({ processes: st.processes, limits: st.limits, todayTokens: st.todayTokens, todayCache: st.todayCache })));
  const totals = useDeck(useShallow((st) => sessionTotals(st)));
  const sessionPct = Math.round(((totals.session?.tokens ?? 0) / s.limits.session) * 100);
  const ctxTone = totals.contextPct >= 85 ? "warn" : "";
  return (
    <div className="usage">
      <div className="col">
        <div className="tile"><div className="label">This session</div><div className="value">{formatTokens(totals.session?.tokens ?? 0)}</div>
          <div className="muted small">{sessionPct}% of your {formatTokens(s.limits.session)} limit · input + output</div>
          {totals.session?.cache && <CacheLine c={totals.session.cache} />}</div>
        <div className="tile"><div className="label">Today in this folder</div><div className="value">{formatTokens(s.todayTokens)}</div>
          <div className="muted small">{Math.round((s.todayTokens / s.limits.day) * 100)}% of {formatTokens(s.limits.day)} · input + output</div>
          {s.todayCache && <CacheLine c={s.todayCache} />}</div>
        <div className="tile"><div className="label">Context window</div>
          <div className="meter" style={{ marginTop: 6 }}><div className="label"><span>{totals.session ? modelWithEffort(totals.session.model) : ""}</span><span>{totals.contextPct}%</span></div>
            <div className={`track ${ctxTone}`}><div className={`fill ${ctxTone}`} style={{ width: `${totals.contextPct}%` }} /></div></div>
          <div className="muted small" style={{ marginTop: 4 }}>Warns at 85%</div></div>
      </div>
      <div className="col">
        <div className="chart-box">
          <div className="chart-title">Processes Claude started</div>
          <table className="data"><thead><tr><th>Process</th><th>CPU</th><th>Memory</th></tr></thead>
            <tbody>{s.processes.map((p) => <tr key={p.pid}><td className="truncate" style={{ maxWidth: 200 }}><Icon name={p.kind === "mcp" ? "plug" : p.kind === "claude" ? "sparkle" : "terminal"} size={12} /> {p.label}</td><td>{p.cpu.toFixed(1)}%</td><td>{p.memMb} MB</td></tr>)}</tbody></table>
          <div className="muted small" style={{ marginTop: 4 }}>Program names only — arguments are never read.</div>
        </div>
      </div>
    </div>
  );
}

function Activity() {
  const activity = useDeck((s) => s.activity);
  return (
    <div style={{ padding: "8px 14px" }}>
      <div className="muted small" style={{ marginBottom: 6 }}>Live, in memory only — the last 500 events. Nothing here is written to disk.</div>
      <table className="data">
        <thead><tr><th>Time</th><th>Agent</th><th>Tool</th><th>Target</th><th>Model</th><th>Took</th><th>Result</th></tr></thead>
        <tbody>
          {activity.length === 0 && <tr><td colSpan={7} className="muted">Waiting for Claude to do something in this folder…</td></tr>}
          {activity.slice(0, 120).map((e) => (
            <tr key={e.id}>
              <td>{time(e.at)}</td><td>{e.agent}</td><td className="mono">{e.tool}</td><td className="truncate" style={{ maxWidth: 380 }} title={e.target}>{e.target}</td>
              <td>{e.model ? modelWithEffort(e.model, e.effort) : "—"}</td><td>{e.durationMs ? `${(e.durationMs / 1000).toFixed(1)} s` : ""}</td>
              <td>{e.result === "ok" ? <span className="badge good">ok</span> : e.result === "error" ? <span className="badge bad">failed</span> : e.result === "denied" ? <span className="badge warn">denied</span> : e.result === "stopped" ? <span className="badge warn">stop</span> : <span className="badge">running</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History() {
  const history = useDeck((s) => s.history);
  return (
    <div style={{ padding: "8px 14px" }}>
      <div className="muted small" style={{ marginBottom: 6 }}>Past sessions in this folder — numbers only. Crewglass keeps them for 90 days, longer than Claude Code's own 30.</div>
      <table className="data">
        <thead><tr><th>Started</th><th>From</th><th>Length</th><th>Tokens</th><th>Models</th><th>Agents</th><th>MCP servers</th><th>Failures</th></tr></thead>
        <tbody>{history.map((h) => (
          <tr key={h.id}><td>{h.started}</td><td>{h.source === "vscode" ? "VS Code" : h.source === "terminal" ? "Terminal" : h.source === "pipeline" ? "Pipeline" : "Headless"}</td><td>{h.durationMin} min</td>
            <td>{formatTokens(h.tokens)}</td><td>{h.models.join(", ")}</td><td>{h.agents.join(", ") || "—"}</td><td>{h.mcps.join(", ") || "—"}</td><td>{h.failures}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function LiveStrip() {
  const s = useDeck(useShallow((st) => ({ open: st.bottomOpen, tab: st.bottomTab, series: st.series, activity: st.activity, inbox: st.inbox, sessions: st.sessions })));
  const perMin = s.series.map((p) => Object.values(p.byModel).reduce((a, b) => a + b, 0));
  const last = s.activity[0];
  const warn = s.inbox.find((i) => !i.resolved && (i.kind === "failing-command" || i.kind === "check-failed" || i.kind === "approval"));
  const setTab = (tab: BottomTab) => useDeck.setState({ bottomTab: tab, bottomOpen: true });
  return (
    <section className="bottom" aria-label="Live activity">
      <div className="strip">
        <strong style={{ fontSize: 11, letterSpacing: "0.05em", color: "var(--muted)" }}>LIVE</strong>
        <span className="small" style={{ fontVariantNumeric: "tabular-nums" }}>{formatTokens(perMin[perMin.length - 1] ?? 0)} tok/min</span>
        <span className="last truncate grow">
          {last ? <>{last.agent}: <span className="mono">{last.tool}</span> {last.target}{last.model && <> · <ModelChip model={last.model} effort={last.effort} /></>}</> : "Waiting for Claude…"}
        </span>
        {warn && <button className="btn small" onClick={() => useDeck.setState({ inboxOpen: true })} style={{ color: "var(--warning-ink)" }}><Icon name="alert" size={13} /> {warn.title}</button>}
        <div className="tabs">
          {(["usage", "activity", "history"] as const).map((t) => (
            <button key={t} className={s.open && s.tab === t ? "on" : ""} onClick={() => (s.open && s.tab === t ? useDeck.setState({ bottomOpen: false }) : setTab(t))}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => useDeck.setState({ bottomOpen: !s.open })} aria-label={s.open ? "Collapse" : "Expand"}><Icon name={s.open ? "down" : "right"} /></button>
      </div>
      {s.open && <div className="bottom-panel">{s.tab === "usage" ? <Usage /> : s.tab === "activity" ? <Activity /> : <History />}</div>}
    </section>
  );
}
