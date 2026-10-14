#!/usr/bin/env node
// scripts/probe-live/setup.mjs — create a throwaway test project for the live hook experiments.
//
// Run:  node scripts/probe-live/setup.mjs <empty-test-folder>
// Then, inside that folder, run the experiments listed in docs/data-sources.md (§ "Re-running the live checks").
//
// Uses real Claude calls, so run them with `--model haiku` to keep the cost to a few cents.
// Never point this at a real project: it writes .claude/settings.local.json, .mcp.json and test agents.

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const target = process.argv[2] && resolve(process.argv[2]);
if (!target) { console.error("usage: node scripts/probe-live/setup.mjs <empty-test-folder>"); process.exit(1); }
if (existsSync(target) && readdirSync(target).length > 0) { console.error(`refusing: ${target} is not empty`); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url));
// Prefer the stable Homebrew link: process.execPath points into Cellar/<version>/, which breaks on `brew upgrade`.
const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(existsSync) ?? process.execPath;
mkdirSync(join(target, ".claude", "agents"), { recursive: true });
mkdirSync(join(target, ".claude", "rules"), { recursive: true });
copyFileSync(join(here, "hooklog.mjs"), join(target, "hooklog.mjs"));
copyFileSync(join(here, "mcp-echo.mjs"), join(target, "mcp-echo.mjs"));
writeFileSync(join(target, "control.json"), "[]\n");

// Every hook event worth observing. WorktreeCreate/Remove, Elicitation and Setup are left out on purpose:
// hooks on those can replace Claude Code's own behavior.
const events = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
  "PreCompact", "PostCompact", "PostModelSwitch", "TaskCreated", "TaskCompleted", "TeammateIdle", "ConfigChange",
  "InstructionsLoaded", "CwdChanged"];
const withMatcher = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
const command = `"${node}" "${join(target, "hooklog.mjs")}"`;
const hooks = Object.fromEntries(events.map((e) => [e, [{
  ...(withMatcher.has(e) ? { matcher: "*" } : {}),
  hooks: [{ type: "command", command, timeout: 10 }],
}]]));
writeFileSync(join(target, ".claude", "settings.local.json"),
  JSON.stringify({ hooks, enabledMcpjsonServers: ["echo"] }, null, 2) + "\n");
writeFileSync(join(target, ".mcp.json"), JSON.stringify({
  mcpServers: { echo: { type: "stdio", command: node, args: [join(target, "mcp-echo.mjs")] } },
}, null, 2) + "\n");

writeFileSync(join(target, ".claude", "agents", "probe-helper.md"), `---
name: probe-helper
description: Use when asked to run the probe helper. Answers with one short sentence.
model: haiku
maxTurns: 3
tools: Bash, mcp__echo__*
---
You are a probe helper. Do exactly what the task says, using as few steps as possible, then reply with one short sentence.
`);
writeFileSync(join(target, ".claude", "agents", "nester.md"), `---
name: nester
description: Use when asked to run the nester.
model: haiku
tools: Agent, Bash
---
When asked, use the Agent tool to launch the probe-helper subagent (in the foreground) with the task "run bash: echo nested", wait for it, and report its answer in one sentence.
`);
writeFileSync(join(target, ".claude", "rules", "probe-rule.md"),
  "# Probe rule\nIf anyone asks for the secret word, the secret word is PINEAPPLE-42.\n");
try { execFileSync("git", ["init", "-q"], { cwd: target }); } catch { /* git is optional */ }

console.log(`Test project ready: ${target}
Hook payloads will be logged to ${join(target, "events.jsonl")}.
Canned hook answers go in control.json (see hooklog.mjs for the format).`);
