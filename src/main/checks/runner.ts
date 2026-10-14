// Runs one command check (plan §6.4): split into arguments and started WITHOUT a shell, in the agent's folder,
// with a time limit. Only the last 40 lines of output are kept, with anything that looks like a key masked;
// they're held in memory (and sent to the agent to fix), never written to disk.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { maskSecrets } from "@shared/secretGuard";
import { checkCommandProblem } from "@shared/checks";
import { HOME } from "../paths";

export interface CheckDef { key: string; label: string; command: string; timeoutMs?: number }
export interface CheckResult { key: string; label: string; ok: boolean; exitCode: number | null; timedOut: boolean; ms: number; tail: string }

export const DEFAULT_CHECK_MS = 5 * 60_000;
const TAIL_LINES = 40;

/** `npm run test -- --grep "a b"` → ["npm","run","test","--","--grep","a b"]. Shell features are refused, not interpreted. */
export function splitCommand(command: string): string[] {
  const problem = checkCommandProblem(command);
  if (problem) throw new Error(problem);
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  if (!out.length) throw new Error("The check command is empty.");
  return out;
}

/** Commands like npm and npx live in Homebrew's folder, which apps started from the Dock don't have on their PATH. */
function checkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ELECTRON_|NODE_OPTIONS$|CLAUDECODE$)/.test(k)) env[k] = v;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".local/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  env.PATH = [...new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), ...extra])].join(":");
  // No terminal is attached, so test runners run once instead of watching. And npm/npx never reach the registry on
  // their own (e.g. `npx tsc` without TypeScript installed): a check only runs what's already installed.
  delete env.CI;
  env.npm_config_yes = "false";
  env.npm_config_offline = "true";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

export function runCheck(def: CheckDef, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  const limit = def.timeoutMs ?? DEFAULT_CHECK_MS;
  return new Promise((resolve) => {
    let argv: string[];
    try { argv = splitCommand(def.command); } catch (e) {
      resolve({ key: def.key, label: def.label, ok: false, exitCode: null, timedOut: false, ms: 0, tail: (e as Error).message });
      return;
    }
    // The time budget for this agent's checks already ran out (e.g. an earlier check used it): don't start another.
    if (signal?.aborted) {
      resolve({ key: def.key, label: def.label, ok: false, exitCode: null, timedOut: true, ms: 0, tail: "Not run: the 5-minute limit for this agent's checks was used up." });
      return;
    }
    let out = "";
    let timedOut = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env: checkEnv(), shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d: Buffer) => { out += d.toString("utf8"); if (out.length > 256 << 10) out = out.slice(-128 << 10); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // The whole process group, so a test runner's children stop too.
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, limit);
    signal?.addEventListener("abort", () => { timedOut = true; kill(); }, { once: true });
    const finish = (exitCode: number | null, extra = "") => {
      clearTimeout(timer);
      const lines = maskSecrets(out + extra).replace(/\u001b\[[0-9;]*m/g, "").trimEnd().split("\n");
      resolve({ key: def.key, label: def.label, ok: exitCode === 0 && !timedOut, exitCode, timedOut, ms: Date.now() - started,
        tail: lines.slice(-TAIL_LINES).join("\n") + (timedOut ? `\n(stopped after ${Math.round(limit / 1000)} s)` : "") });
    };
    child.on("error", (e) => finish(null, `\n${e.message}`));
    child.on("close", (code) => finish(code));
  });
}
