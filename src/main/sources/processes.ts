// CPU and memory of the Claude sessions in the folder and everything they started.
// `ps` is asked for pid, parent, %CPU, memory and the program NAME only — never its arguments. We use `ucomm`
// (the executable's own name, up to 16 characters) rather than `comm`, because programs can put their
// arguments into `comm` by changing their process title.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ProcessRow } from "@shared/types";

export interface Row { pid: number; ppid: number; cpu: number; rssKb: number; comm: string }

function ps(): Promise<Row[]> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss=,ucomm="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      const rows: Row[] = [];
      for (const line of out.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
        if (m) rows.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], rssKb: +m[4], comm: basename(m[5].trim()) });
      }
      resolve(rows);
    });
  });
}

export async function processTree(rootPids: number[], mcpNames: string[], labels: Map<number, string> = new Map()): Promise<ProcessRow[]> {
  if (!rootPids.length) return [];
  return treeFrom(await ps(), rootPids, mcpNames, labels);
}

/** Only the folder's Claude sessions and what THEY started: an agy or Gemini run started any other way never appears. */
export function treeFrom(rows: Row[], rootPids: number[], mcpNames: string[], labels: Map<number, string> = new Map()): ProcessRow[] {
  const children = new Map<number, Row[]>();
  for (const r of rows) (children.get(r.ppid) ?? children.set(r.ppid, []).get(r.ppid)!).push(r);
  const out: ProcessRow[] = [];
  const walk = (pid: number, depth: number) => {
    for (const c of children.get(pid) ?? []) {
      if (depth > 6 || out.length > 60) return;
      const lower = c.comm.toLowerCase();
      const kind: ProcessRow["kind"] = lower === "agy" ? "agy" : mcpNames.some((n) => lower.includes(n.toLowerCase())) || lower.includes("mcp") ? "mcp" : "tool";
      out.push({ pid: c.pid, label: c.comm, kind, cpu: c.cpu, memMb: Math.round(c.rssKb / 1024) });
      walk(c.pid, depth + 1);
    }
  };
  for (const root of rootPids) {
    const r = rows.find((x) => x.pid === root);
    if (r) out.push({ pid: r.pid, label: labels.get(root) ?? "claude", kind: "claude", cpu: r.cpu, memMb: Math.round(r.rssKb / 1024) });
    walk(root, 0);
  }
  return out;
}
