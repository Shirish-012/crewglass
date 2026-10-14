// The small bottom-left square that appears only when a Claude Code update adds or changes
// something in its files (D17). It names the change and where to fix it in Crewglass's own source.

import { useShallow } from "zustand/react/shallow";
import { toast, useDeck } from "../state/store";
import { deckApi, openInVSCode } from "../real/api";
import { Icon } from "./ui";

export function FormatNotice() {
  const { issues, open, sourceRepo, claudeVersion, testedVersion } = useDeck(useShallow((s) => ({
    issues: s.formatIssues, open: s.formatOpen, sourceRepo: s.sourceRepo, claudeVersion: s.claudeVersion, testedVersion: s.testedVersion,
  })));
  const SOURCE_REPO = sourceRepo;
  if (!issues.length) return null;
  const warn = issues.some((i) => i.severity === "warn");
  const files = [...new Set(issues.map((i) => i.fixFile))];

  const copyFix = async () => {
    const text = [
      "Crewglass detected Claude Code format changes (names and types only):",
      ...issues.map((i) => `- ${i.source}: ${i.kind} ${i.name} (${i.detail})`),
      `Claude Code version: ${claudeVersion ?? "unknown"} (Crewglass was tested with ${testedVersion}).`,
      `Please update ${files.join(" and ")} so these are handled, and add a test fixture for each.`,
    ].join("\n");
    try { await navigator.clipboard.writeText(text); toast("Copied", "Paste it into Claude Code inside the Crewglass repo."); }
    catch { toast("Couldn't copy", "Clipboard access was blocked in this preview."); }
  };

  return (
    <>
      <button className={`format-box ${warn ? "warn" : "info"}`} onClick={() => useDeck.setState({ formatOpen: !open })}
        aria-expanded={open} title="Claude Code's files changed after an update">
        <Icon name={warn ? "alert" : "info"} size={15} />
        <div style={{ marginTop: 4, fontWeight: 600 }}>{warn ? "Format changed" : "Unknown fields detected"} ({issues.length})</div>
      </button>
      {open && (
        <div className="format-panel" role="dialog" aria-label="Unknown fields detected">
          <div className="row">
            <Icon name={warn ? "alert" : "info"} />
            <strong className="grow">{warn ? "Format changed — some numbers may be missing" : "Unknown fields detected"}</strong>
            <span className="muted small">Claude Code {claudeVersion ?? "?"} · tested with {testedVersion}</span>
            <button className="icon-btn" onClick={() => useDeck.setState({ formatOpen: false })} aria-label="Close"><Icon name="x" /></button>
          </div>
          <table className="data" style={{ marginTop: 8 }}>
            <tbody>
              {issues.map((i) => (
                <tr key={i.name}>
                  <td className="muted">{i.source}</td>
                  <td><span className="mono">{i.name}</span> <span className="muted">({i.detail})</span></td>
                  <td>{i.severity === "info" ? <span className="badge">ignored — nothing affected</span> : <span className="badge warn">shows “—”</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }} className="small">{SOURCE_REPO ? "Where to fix it — Crewglass's own source code on this Mac:"
            : "Where to fix it — in Crewglass's source code, which isn't on this Mac (set its folder in Settings if you have it). Copy the fix request and send it to whoever builds your copy:"}</div>
          <div className="codebox" style={{ marginTop: 4 }}>{SOURCE_REPO || "Crewglass source"}{"\n"}{files.map((f) => `  → ${f}`).join("\n")}</div>
          <div className="row" style={{ marginTop: 10 }}>
            {SOURCE_REPO && <button className="btn primary small" onClick={() => openInVSCode(`${SOURCE_REPO}/${files[0]}`)}><Icon name="code" size={14} /> Open in VS Code</button>}
            <button className="btn small" onClick={copyFix}><Icon name="copy" size={14} /> Copy fix request for Claude</button>
            <div className="spacer" />
            <button className="btn ghost small" onClick={() => { void deckApi()?.dismissFormatIssues(); useDeck.setState({ formatIssues: [], formatOpen: false }); }}>Dismiss for this version</button>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>Only field names and types are recorded — never values. Everything else keeps working.</div>
        </div>
      )}
    </>
  );
}
