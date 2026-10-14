#!/usr/bin/env node
// Probe hook: logs every hook payload to events.jsonl, and optionally answers
// with a canned response from control.json (used to test stop/deny/block/context).
//
// control.json shape: [{ "event": "PreToolUse", "match": {"tool_name": "Bash"}, "times": 1, "output": {...} }]
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
let input = "";
for await (const chunk of process.stdin) input += chunk;

let event = {};
try { event = JSON.parse(input); } catch { event = { _unparsed: input.slice(0, 200) }; }
appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ _t: t0, ...event }) + "\n");

const controlPath = join(dir, "control.json");
if (existsSync(controlPath)) {
  const rules = JSON.parse(readFileSync(controlPath, "utf8"));
  const i = rules.findIndex((r) =>
    r.event === event.hook_event_name &&
    (r.times ?? 1) > 0 &&
    Object.entries(r.match ?? {}).every(([k, v]) => {
      const actual = k.split(".").reduce((o, p) => (o == null ? o : o[p]), event);
      return typeof v === "string" && v.startsWith("~") ? String(actual ?? "").includes(v.slice(1)) : actual === v;
    }));
  if (i >= 0) {
    const rule = rules[i];
    rule.times = (rule.times ?? 1) - 1;
    writeFileSync(controlPath, JSON.stringify(rules, null, 2));
    appendFileSync(join(dir, "answers.jsonl"), JSON.stringify({ _t: Date.now(), event: event.hook_event_name, output: rule.output }) + "\n");
    process.stdout.write(JSON.stringify(rule.output));
  }
}
process.exit(0);
