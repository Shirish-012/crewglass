import type { ReactElement } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { actions, AGY_SEEN, useDeck } from "../../state/store";
import type { Link } from "@shared/types";
import { Icon } from "../ui";

export type EdgeData = { linkId: string };

const KIND_TEXT: Record<Link["kind"], string> = { delegates: "hands work to", direct: "direct call", uses: "can use", checkedBy: "checked by" };

export function linkStroke(l: Link): { stroke: string; dash?: string; width: number; opacity: number } {
  const unusedPlan = l.planned && !l.observed && !l.active;
  const base = { width: 1.6, opacity: unusedPlan ? 0.5 : 1 };
  let stroke = "var(--ink-2)";
  if (l.kind === "direct") stroke = l.directState === "blocked" ? "var(--baseline)" : "var(--accent)";
  if (l.kind === "uses") { stroke = "var(--muted)"; base.width = 1.3; }
  if (l.kind === "checkedBy") stroke = l.check?.state === "failed" ? "var(--critical)" : "var(--ink-2)";
  const dash = !l.planned ? "7 5" : l.kind === "checkedBy" ? "2 4" : undefined;
  return { stroke, dash, ...base };
}

export function LinkEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data } = props;
  const link = useDeck((s) => s.links.find((l) => l.id === (data as EdgeData).linkId));
  const checks = useDeck((s) => s.checks);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!link) return null;
  const st = linkStroke(link);
  // Short links (neighbouring cards) only have room for an icon; the full text is in the tooltip and on selection.
  const compact = Math.hypot(targetX - sourceX, targetY - sourceY) < 140 && !selected;

  const chips: ReactElement[] = [];
  if (!link.planned && link.from !== AGY_SEEN && link.to !== AGY_SEEN) {
    chips.push(
      <span key="keep" className="edge-chip keep" role="button" tabIndex={0} title="Seen in use but not planned. Keep it as part of the team."
        onClick={(e) => { e.stopPropagation(); actions.keepLink(link.id); }}>
        {compact ? "Keep" : `Keep · seen ${link.observed?.calls ?? 1}×`}
      </span>,
    );
  }
  if (link.kind === "direct" && link.planned) {
    const map = {
      allowed: { icon: "check", text: "allowed", cls: "" },
      orchestrator: { icon: "baton", text: "orchestrator decides", cls: "" },
      you: { icon: "lock", text: "needs your OK", cls: "warn" },
      blocked: { icon: "x", text: "blocked", cls: "" },
    } as const;
    const m = map[link.directState ?? "orchestrator"];
    chips.push(<span key="st" className={`edge-chip ${m.cls}`} title={`Direct call: ${m.text}. Click the link to change who approves.`}><Icon name={m.icon} size={11} />{compact ? "" : ` ${m.text}`}</span>);
  }
  if (link.check) {
    const c = link.check;
    const cls = c.state === "passed" ? "good" : c.state === "failed" ? "bad" : "";
    const text = c.state === "passed" ? (compact ? "✓" : "✓ checked") : c.state === "failed" ? `✗ ${compact ? "" : "try "}${c.tries}/2` : compact ? "⏳" : "⏳ checking";
    chips.push(<span key="chk" className={`edge-chip ${cls}`} title={c.label}>{text}</span>);
  }
  if (link.checks?.length) {
    const labels = link.checks.map((k) => checks[k]?.label ?? k);
    chips.push(<span key="lc" className="edge-chip" title={`Checked when ${link.kind === "direct" ? "called" : "handed work"}: ${labels.join(", ")}`}><Icon name="terminal" size={11} />{compact ? "" : ` ${labels.join(", ")}`}</span>);
  }
  if ((link.active || selected) && link.lastReason && !compact) {
    chips.push(<span key="why" className="edge-chip" title={link.lastReason} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>Reason: {link.lastReason}</span>);
  }
  if (selected && chips.length === 0) chips.push(<span key="kind" className="edge-chip">{KIND_TEXT[link.kind]}</span>);

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18}
        style={{ stroke: st.stroke, strokeWidth: selected ? st.width + 1.2 : st.width, strokeDasharray: link.active ? undefined : st.dash, opacity: st.opacity }} />
      {chips.length > 0 && (
        <EdgeLabelRenderer>
          <div className="edge-label nodrag nopan" style={{ left: lx, top: ly }} data-link-id={link.id}
            onClick={() => actions.select({ type: "link", id: link.id })}>{chips}</div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
