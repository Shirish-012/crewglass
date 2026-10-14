#!/usr/bin/env node
// Crewglass's agy bridge (plan §6.3) — a tiny MCP server Claude Code starts for agy agents.
//
//   node agy-bridge.mjs --agy /Users/you/.local/bin/agy [--timeout 300]
//
// It offers one tool, ask_agy, which runs `agy -p <prompt> --output-format json --sandbox` and returns agy's answer.
// Compared with a typical hand-made agy MCP bridge:
//   • no dependencies (MCP's JSON-RPC over stdin/stdout is handled here), so it runs from Crewglass's data folder;
//   • it never contacts anything itself — no dashboard, no network, nothing written to disk;
//   • it adds one report line to the answer: `[crewglass:agy] model=… seconds=… in=… out=… thinking=… status=…`
//     (numbers only), which Crewglass reads from Claude Code's transcript to show the model and Gemini tokens.
// stdout is the protocol channel: nothing else is ever printed there.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const AGY = opt("agy") ?? "";
const TIMEOUT_S = Math.min(Math.max(Number(opt("timeout") ?? 300) || 300, 10), 1800);
const MAX_OUTPUT = 4 << 20;
const MAX_PARALLEL = 3;
const GEMINI_RE = /^gemini-[a-z0-9][a-z0-9.-]{0,60}$/;
const PREAMBLE = "You are being consulted by another AI agent (Claude Code) for an independent opinion. " +
  "ANALYZE ONLY: do not edit files, do not run commands. Be concise and concrete.\n\n";

const TOOL = {
  name: "ask_agy",
  title: "Ask agy (Gemini)",
  description: "Ask Google's Antigravity agent (agy, Gemini models) for an independent opinion. agy can't see this conversation, " +
    "so include everything it needs in `prompt` (it can read files in this folder you mention as @path). Analysis only; agy won't edit files.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, description: "The complete question for agy, with all the context it needs." },
      model: { type: "string", description: "A Gemini model id from `agy models`, e.g. gemini-3.1-pro-high. Only gemini-* models are allowed." },
      effort: { type: "string", enum: ["low", "medium", "high"], description: "agy reasoning effort. Omit for agy's default." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const running = new Map(); // request id → child process
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function report(r) {
  return `[crewglass:agy] model=${r.model} seconds=${r.seconds.toFixed(1)} in=${r.in} out=${r.out} thinking=${r.thinking} status=${r.status}`;
}

function runAgy(id, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(AGY, args, { stdio: ["ignore", "pipe", "pipe"], shell: false }); }
    catch (e) { resolve({ code: -1, stdout: "", stderr: String(e) }); return; }
    running.set(id, child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 64 << 10) stderr += d; });
    const killer = setTimeout(() => child.kill("SIGKILL"), (TIMEOUT_S + 15) * 1000);
    const done = (code) => { clearTimeout(killer); running.delete(id); resolve({ code, stdout, stderr }); };
    child.on("error", (e) => { stderr += String(e); done(-1); });
    child.on("close", (code) => done(code ?? -1));
  });
}

async function askAgy(id, input) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const model = typeof input?.model === "string" && input.model ? input.model : "";
  const effort = typeof input?.effort === "string" ? input.effort : "";
  if (!prompt.trim()) return text("Refused: `prompt` is empty.", true);
  // A second opinion from Claude-inside-agy would defeat the purpose: Gemini models only, enforced here in code.
  if (model && !GEMINI_RE.test(model)) return text(`Refused: "${model}" is not a Gemini model. This bridge only allows gemini-* models.`, true);
  if (effort && !["low", "medium", "high"].includes(effort)) return text("Refused: effort must be low, medium or high.", true);
  if (!AGY.startsWith("/")) return text("agy wasn't found when Crewglass set up this bridge. Install agy, then save the team in Crewglass again.", true);
  if (running.size >= MAX_PARALLEL) return text(`Refused: ${MAX_PARALLEL} agy calls are already running. Wait for one to finish.`, true);

  const args = ["-p", PREAMBLE + prompt, "--output-format", "json", "--sandbox", "--print-timeout", `${TIMEOUT_S}s`];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  const started = Date.now();
  const { code, stdout, stderr } = await runAgy(id, args);
  const seconds = (Date.now() - started) / 1000;
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* not JSON: use the raw text */ }
  const status = typeof parsed?.status === "string" && /^[A-Z_]{1,40}$/.test(parsed.status) ? parsed.status : code === 0 ? "UNPARSED" : "FAILED";
  const ok = code === 0 && status === "SUCCESS";
  const answer = typeof parsed?.response === "string" ? parsed.response : stdout.trim() || stderr.trim().slice(0, 2000) || `agy exited with code ${code}`;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const u = parsed?.usage ?? {};
  const line = report({ model: model || "agy-default", seconds, in: n(u.input_tokens), out: n(u.output_tokens), thinking: n(u.thinking_tokens), status });
  return text(`${String(answer).trim()}\n\n${line}`, !ok);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => { if (id !== undefined) send({ id, result }); };
  switch (method) {
    case "initialize": {
      const v = typeof params?.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ? params.protocolVersion : "2025-06-18";
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: "crewglass-agy", version: "1.0.0" } });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: [TOOL] });
    case "tools/call":
      if (params?.name !== "ask_agy") return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      return reply(await askAgy(id, params.arguments));
    case "notifications/cancelled": {
      const child = running.get(params?.requestId);
      if (child) child.kill("SIGTERM");
      return;
    }
    default:
      if (id !== undefined && !String(method).startsWith("notifications/")) send({ id, error: { code: -32601, message: "Method not found" } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim() || line.length > 8 << 20) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  void handle(msg).catch((e) => { if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e).slice(0, 200) } }); });
});
rl.on("close", () => { for (const c of running.values()) c.kill("SIGTERM"); });
