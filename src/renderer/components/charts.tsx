// Small SVG charts following the dataviz spec: thin marks, 2px surface gaps between stacked segments,
// 4px rounded data-ends, hairline grid, legend for ≥2 series, hover tooltip, and a table view.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatTokens, modelLabel, modelSlot } from "@shared/models";
import { seriesVar } from "./ui";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(400);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

/** Single-series sparkline (no legend box: the label next to it names it). */
export function Sparkline({ values, width = 120, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [2 + (i / Math.max(values.length - 1, 1)) * (width - 8), height - 3 - (v / max) * (height - 6)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const [lx, ly] = pts[pts.length - 1] ?? [0, 0];
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

/** Rect with only the top corners rounded (data end), square at the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface StackPoint { label: string; values: Record<string, number> }

export function StackedBars({ points, series, height = 150, valueFormat = formatTokens, title, sub }: {
  points: StackPoint[]; series: string[]; height?: number; valueFormat?: (n: number) => string; title: string; sub?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const padL = 40, padB = 18, padT = 6;
  const innerW = width - padL - 8;
  const innerH = height - padB - padT;
  const totals = points.map((p) => series.reduce((s, k) => s + (p.values[k] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const band = innerW / Math.max(points.length, 1);
  const barW = Math.min(24, band - 2);
  const ticks = [0, max / 2, max];
  const active = series.filter((k) => points.some((p) => (p.values[k] ?? 0) > 0));

  return (
    <div className="chart-box" ref={ref}>
      <div className="row"><div className="grow"><div className="chart-title">{title}</div>{sub && <div className="chart-sub">{sub}</div>}</div>
        <button className="btn ghost small" onClick={() => setTable(!table)} aria-pressed={table}>{table ? "Chart" : "Table"}</button></div>
      <div className="legend">{active.map((k) => <span key={k}><span className="sw" style={{ background: seriesVar(modelSlot(k)) }} />{modelLabel(k)}</span>)}</div>
      {table ? (
        <div style={{ maxHeight: height, overflow: "auto" }}>
          <table className="data"><thead><tr><th>Point</th>{active.map((k) => <th key={k}>{modelLabel(k)}</th>)}<th>Total</th></tr></thead>
            <tbody>{points.map((p, i) => <tr key={i}><td>{p.label}</td>{active.map((k) => <td key={k}>{valueFormat(p.values[k] ?? 0)}</td>)}<td>{valueFormat(totals[i])}</td></tr>)}</tbody></table>
        </div>
      ) : (
        <svg width={width} height={height} role="img" aria-label={`${title}, stacked by model`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => {
            const y = padT + innerH - (t / max) * innerH;
            return <g key={t}><line x1={padL} x2={width - 8} y1={y} y2={y} stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth={1} />
              <text x={padL - 6} y={y + 3.5} textAnchor="end" fontSize={10.5} fill="var(--muted)" style={{ fontVariantNumeric: "tabular-nums" }}>{valueFormat(t)}</text></g>;
          })}
          {points.map((p, i) => {
            const x = padL + i * band + (band - barW) / 2;
            let y = padT + innerH;
            const segs = active.filter((k) => (p.values[k] ?? 0) > 0);
            return (
              <g key={i}>
                <rect x={padL + i * band} y={padT} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                {segs.map((k, si) => {
                  const h = ((p.values[k] ?? 0) / max) * innerH;
                  y -= h;
                  const top = si === segs.length - 1;
                  // 2px surface gap under every segment except the bottom one.
                  const hh = Math.max(0, h - (si > 0 ? 2 : 0));
                  return top
                    ? <path key={k} d={topRounded(x, y, barW, hh)} fill={seriesVar(modelSlot(k))} opacity={hover === null || hover === i ? 1 : 0.55} pointerEvents="none" />
                    : <rect key={k} x={x} y={y} width={barW} height={hh} fill={seriesVar(modelSlot(k))} opacity={hover === null || hover === i ? 1 : 0.55} pointerEvents="none" />;
                })}
              </g>
            );
          })}
          {[0, Math.floor(points.length / 2), points.length - 1].map((i) => points[i] && (
            <text key={i} x={padL + i * band + band / 2} y={height - 4} textAnchor="middle" fontSize={10.5} fill="var(--muted)">{points[i].label}</text>
          ))}
        </svg>
      )}
      {!table && hover !== null && points[hover] && (
        <div className="tooltip" style={{ left: Math.min(padL + hover * band + 20, width - 180), top: 40 }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>{points[hover].label}</div>
          {active.map((k) => <div key={k} className="r"><span><span className="sw" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 5, background: seriesVar(modelSlot(k)) }} />{modelLabel(k)}</span><span>{valueFormat(points[hover].values[k] ?? 0)}</span></div>)}
          <div className="r" style={{ borderTop: "1px solid var(--border)", marginTop: 3, paddingTop: 3 }}><span>Total</span><span>{valueFormat(totals[hover])}</span></div>
        </div>
      )}
    </div>
  );
}

/** Tool calls per point; failed calls marked with a labeled critical marker (never color alone: tooltip + legend text). */
export function CallBars({ points, height = 150 }: { points: { label: string; calls: number; failures: number }[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 28, padB = 18, padT = 12;
  const innerW = width - padL - 8;
  const innerH = height - padB - padT;
  const max = niceMax(Math.max(...points.map((p) => p.calls), 1));
  const band = innerW / Math.max(points.length, 1);
  const barW = Math.min(24, band - 2);
  const totalFail = points.reduce((s, p) => s + p.failures, 0);
  return (
    <div className="chart-box" ref={ref}>
      <div className="chart-title">Tool calls</div>
      <div className="chart-sub">{points.reduce((s, p) => s + p.calls, 0)} calls · {totalFail} failed (marked ✗)</div>
      <svg width={width} height={height} role="img" aria-label="Tool calls per minute with failures marked" onMouseLeave={() => setHover(null)}>
        {[0, max / 2, max].map((t) => {
          const y = padT + innerH - (t / max) * innerH;
          return <g key={t}><line x1={padL} x2={width - 8} y1={y} y2={y} stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} />
            <text x={padL - 5} y={y + 3.5} textAnchor="end" fontSize={10.5} fill="var(--muted)">{t}</text></g>;
        })}
        {points.map((p, i) => {
          const h = (p.calls / max) * innerH;
          const x = padL + i * band + (band - barW) / 2;
          const y = padT + innerH - h;
          return (
            <g key={i}>
              <rect x={padL + i * band} y={padT} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
              <path d={topRounded(x, y, barW, h)} fill="var(--series-1)" opacity={hover === null || hover === i ? 0.85 : 0.45} pointerEvents="none" />
              {p.failures > 0 && <text x={x + barW / 2} y={y - 3} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--critical)" pointerEvents="none">✗</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && points[hover] && (
        <div className="tooltip" style={{ left: Math.min(padL + hover * band + 20, width - 170), top: 40 }}>
          <div style={{ fontWeight: 600 }}>{points[hover].label}</div>
          <div className="r"><span>Tool calls</span><span>{points[hover].calls}</span></div>
          <div className="r"><span>Failed</span><span>{points[hover].failures}</span></div>
        </div>
      )}
    </div>
  );
}
