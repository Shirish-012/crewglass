// Small shared UI pieces: icons (inline SVG, nothing loaded from the network), model chips, status dots.

import type { ReactNode } from "react";
import type { AgentStatus, Effort } from "@shared/types";
import { findModel, modelWithEffort, modelSlot } from "@shared/models";

const PATHS: Record<string, ReactNode> = {
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h7A1.5 1.5 0 0 1 19 8.5v8A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5z" />,
  bell: <><path d="M6 15V10a5 5 0 0 1 10 0v5l1.5 2h-13z" /><path d="M9.5 19.5a1.6 1.6 0 0 0 3 0" /></>,
  stop: <rect x="6" y="6" width="10" height="10" rx="1.5" />,
  play: <path d="M8 5.5v11l9-5.5z" />,
  gear: <><circle cx="11" cy="11" r="2.4" /><path d="M9.6 3.5h2.8l.4 2.1 1.5.9 2-.8 1.4 2.4-1.6 1.4v1.7l1.6 1.4-1.4 2.4-2-.8-1.5.9-.4 2.1H9.6l-.4-2.1-1.5-.9-2 .8-1.4-2.4 1.6-1.4V9.5L4.3 8.1l1.4-2.4 2 .8 1.5-.9z" /></>,
  plus: <path d="M11 5v12M5 11h12" />,
  search: <><circle cx="10" cy="10" r="5.5" /><path d="m14 14 4 4" /></>,
  down: <path d="m6 9 5 5 5-5" />,
  right: <path d="m9 6 5 5-5 5" />,
  lock: <><rect x="5" y="10" width="12" height="8" rx="1.5" /><path d="M8 10V8a3 3 0 0 1 6 0v2" /></>,
  check: <path d="m5.5 11.5 3.5 3.5 7.5-8" />,
  x: <path d="m6 6 10 10M16 6 6 16" />,
  alert: <><path d="M11 4 3 18h16z" /><path d="M11 10v3.5M11 16v.2" /></>,
  info: <><circle cx="11" cy="11" r="7.5" /><path d="M11 10v5M11 7.2v.2" /></>,
  undo: <><path d="M8 8H5V5" /><path d="M5.5 8.5A7 7 0 1 1 5 13" /></>,
  plug: <><path d="M8 4v4M14 4v4" /><path d="M6 8h10v3a5 5 0 0 1-10 0z" /><path d="M11 16v3" /></>,
  shield: <path d="M11 3.5 5 6v5c0 3.5 2.6 6.4 6 7.5 3.4-1.1 6-4 6-7.5V6z" />,
  team: <><circle cx="8" cy="8" r="2.5" /><circle cx="15" cy="9" r="2" /><path d="M3.5 17a4.5 4.5 0 0 1 9 0M12.5 16a3.5 3.5 0 0 1 6.5-1" /></>,
  cpu: <><rect x="6" y="6" width="10" height="10" rx="1.5" /><path d="M9 3v3M13 3v3M9 16v3M13 16v3M3 9h3M3 13h3M16 9h3M16 13h3" /></>,
  help: <><circle cx="11" cy="11" r="7.5" /><path d="M9 9a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.5M11 15v.2" /></>,
  copy: <><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M5 13V5.5A.5.5 0 0 1 5.5 5H13" /></>,
  trash: <><path d="M5 7h12M9 7V5h4v2M7 7l.8 10h6.4L15 7" /></>,
  file: <><path d="M6 3.5h6l4 4v11H6z" /><path d="M12 3.5v4h4" /></>,
  flask: <><path d="M9 4h4M10 4v5l-4.5 7.5A1 1 0 0 0 6.4 18h9.2a1 1 0 0 0 .9-1.5L12 9V4" /></>,
  sparkle: <path d="M11 4v4M11 14v4M4 11h4M14 11h4M6.5 6.5l2 2M13.5 13.5l2 2M15.5 6.5l-2 2M8.5 13.5l-2 2" />,
  eye: <><path d="M3 11s3-5.5 8-5.5S19 11 19 11s-3 5.5-8 5.5S3 11 3 11z" /><circle cx="11" cy="11" r="2.2" /></>,
  code: <path d="m8 7-4 4 4 4M14 7l4 4-4 4" />,
  terminal: <><rect x="3.5" y="5" width="15" height="12" rx="1.5" /><path d="m7 9 2.5 2L7 13M11.5 13H15" /></>,
  sun: <><circle cx="11" cy="11" r="3.5" /><path d="M11 3.5v1.8M11 16.7v1.8M3.5 11h1.8M16.7 11h1.8M5.7 5.7l1.3 1.3M15 15l1.3 1.3M16.3 5.7 15 7M7 15l-1.3 1.3" /></>,
  moon: <path d="M16.5 13.5A6.5 6.5 0 0 1 8.5 5.5a6.5 6.5 0 1 0 8 8z" />,
  monitor: <><rect x="3.5" y="4.5" width="15" height="10" rx="1.5" /><path d="M8 18h6M11 14.5V18" /></>,
  baton: <><path d="M4 18 15 7" /><circle cx="16.5" cy="5.5" r="1.8" /><path d="M6 12.5c1.5-.3 3-1.3 3.5-3" /></>,
  chat: <path d="M4.5 5.5h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H10l-3.5 3v-3h-2a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z" />,
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.info}
    </svg>
  );
}

export const seriesVar = (slot: number) => `var(--series-${Math.min(Math.max(slot, 1), 6)})`;

/** "Opus 5.5 · medium" chip with the model's fixed color dot (identity never by color alone: the text names it). */
export function ModelChip({ model, effort, prefix, title }: { model: string; effort?: Effort; prefix?: string; title?: string }) {
  return (
    <span className="chip" title={title ?? findModel(model)?.id ?? model}>
      <span className="dot" style={{ background: seriesVar(modelSlot(model)) }} />
      {prefix}{modelWithEffort(model, effort)}
    </span>
  );
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: "Idle", running: "Running", waiting: "Waiting for you", failed: "Failed", done: "Done", stopped: "Stopped",
};

export function StatusText({ status, parallel }: { status: AgentStatus; parallel?: number }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`status-dot st-${status}`} />
      <span>{STATUS_TEXT[status]}{status === "running" && parallel && parallel > 1 ? ` ×${parallel}` : ""}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="badge mono" style={{ fontSize: 10.5 }}>{children}</span>;
}
