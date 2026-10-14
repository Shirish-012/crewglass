// The Unix socket the hook helper talks to (plan §4.2, §9). It's a file only you can open — never a network port.
// Messages are one JSON line each, at most 64 KB, shape-checked and rate-limited; decisions come only from Agent
// Deck's own state and your clicks, never from what a message says.

import { createServer, type Server } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Waiting, type Answer, type HookMsg } from "./liveEngine";

const MAX_BYTES = 64 * 1024;
const MAX_PER_SECOND = 500;
const STRING_FIELDS = ["event", "session_id", "cwd", "transcript_path", "agent_id", "agent_type", "tool_name", "tool_use_id", "permission_mode",
  "notification_type", "source", "end_reason", "command", "file_path", "subagent_type", "skill", "call_reason", "error_kind"];

/** ~/Library/Application Support/Crewglass/crewglass.sock, or a private temp path if that's too long for macOS (104 chars). */
export function socketPathFor(userData: string): string {
  const preferred = join(userData, "crewglass.sock");
  if (Buffer.byteLength(preferred) < 100) return preferred;
  return join(tmpdir(), `crewglass-${createHash("sha256").update(userData).digest("hex").slice(0, 8)}.sock`);
}

export function validMessage(m: unknown): m is HookMsg {
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  if (typeof o.event !== "string" || o.event.length > 40) return false;
  for (const k of STRING_FIELDS) if (o[k] !== undefined && (typeof o[k] !== "string" || (o[k] as string).length > 1000)) return false;
  if (o.background_count !== undefined && typeof o.background_count !== "number") return false;
  if (o.task_notification !== undefined && typeof o.task_notification !== "boolean") return false;
  if (o.allowed_calls !== undefined && (!Array.isArray(o.allowed_calls) || o.allowed_calls.length > 20 || !o.allowed_calls.every((x) => typeof x === "string" && x.length < 80))) return false;
  return true;
}

export function startHookServer(socketPath: string, onMessage: (m: HookMsg) => Answer | Waiting): Server {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) unlinkSync(socketPath); // stale socket from a crash
  let windowStart = Date.now();
  let count = 0;
  const server = createServer((conn) => {
    let buf = "";
    let answered = false;
    conn.setTimeout(2000, () => { if (!answered) conn.destroy(); });
    conn.on("error", () => {});
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > MAX_BYTES) { conn.destroy(); return; }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      answered = true;
      let reply: Answer | Waiting = {};
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count <= MAX_PER_SECOND) {
        try {
          const m = JSON.parse(buf.slice(0, nl)) as unknown;
          if (validMessage(m)) reply = onMessage(m) ?? {};
        } catch { /* bad message: allow */ }
      }
      if (reply instanceof Waiting) {
        // Waiting for you (an approval) or for checks: tell the helper how long to wait, then send the real answer.
        const { answer, ms } = reply;
        conn.setTimeout(ms + 5000, () => conn.destroy());
        conn.write(JSON.stringify({ wait: true, ms }) + "\n");
        // Backstop only (the engine answers first): hang up rather than answer, so the helper falls back to its safe default.
        const limit = new Promise<null>((r) => setTimeout(() => r(null), ms));
        void Promise.race([answer, limit]).then((a) => { if (conn.destroyed) return; if (a) conn.end(JSON.stringify(a) + "\n"); else conn.destroy(); },
          () => conn.destroy());
        return;
      }
      conn.end(JSON.stringify(reply) + "\n");
    });
  });
  server.listen(socketPath, () => { try { chmodSync(socketPath, 0o600); } catch { /* best effort */ } });
  return server;
}

/** Copies a bundled program (the hook helper, the agy bridge) into Crewglass's data folder, so moving the app never
 *  breaks the hooks or the MCP registration that point at it. Returns its path. */
export function installHelper(bundledPath: string, userData: string, fileName = "crewglass-hook"): string | null {
  if (!existsSync(bundledPath)) return null;
  const dest = join(userData, "bin", fileName);
  const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  if (!existsSync(dest) || statSync(dest).size !== statSync(bundledPath).size || hash(dest) !== hash(bundledPath)) {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(bundledPath, dest);
    chmodSync(dest, 0o755);
  }
  return dest;
}
