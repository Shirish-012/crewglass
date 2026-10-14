# Crewglass: data sources (Phase 0a findings)

Checked on 2026-09-24/25 against **Claude Code v2.1.281** on this Mac (Apple Silicon, macOS, Node 26.7, Swift 6.4).

Evidence comes from three places:
- **Local files:** `~/.claude/…`, read-only, with `scripts/probe.ts`.
- **The Claude Code binary:** schemas and strings.
- **Live experiments** in a throwaway folder in the scratchpad, using `claude -p --model haiku`. The harness is in `scripts/probe-live/`, and it cost a few cents in total.

None of your real projects or global settings were changed.

**Legend:**
- ✅ confirmed
- ⚠️ confirmed, but it changes the plan
- ⏳ not testable yet (deferred to the phase shown)

---

## 1. Checklist results

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Hook payload fields | ✅ | See §2 for the per-event table |
| 2 | Where subagent transcripts live | ✅ | `~/.claude/projects/<enc>/<sessionId>/subagents/agent-<agentId>.jsonl`, plus `agent-<agentId>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape`, `requestNonInteractive`, `parentAgentId`). The main transcript does **not** repeat subagent messages (0 sidechain entries in main files) |
| 3 | `message.id` split | ⚠️ | One reply is split over 2–3 lines with the same `message.id`. **Usage can differ between those lines** (a streaming snapshot: `output_tokens` 4 → 125). **Always use the LAST line per id**, not the first |
| 4 | Headless `claude -p` runs | ⚠️ | **No file in `~/.claude/sessions/`** for `-p` runs. `entrypoint` is inherited from the environment (`claude-vscode` when launched from VS Code's terminal). Visible only through hooks, or through new transcript files in the folder's project directory |
| 5 | Subagents calling subagents (nesting) | ⚠️ | **Possible.** A subagent with the `Agent` tool launched another subagent. Events carry the nested agent's own `agent_id` / `agent_type`, and `meta.json` has `parentAgentId` |
| 6 | Subagents run async | ⚠️ | The Agent tool often runs **in the background**: `PostToolUse(Agent)` returns immediately with `{isAsync:true, status:"async_launched", agentId, resolvedModel, outputFile}`. When the subagent finishes, the main agent is woken by a **`UserPromptSubmit` whose prompt starts with `<task-notification>`**. Sometimes it runs in the foreground instead, and then `PostToolUse(Agent)` carries the result. Both must be handled |
| 7 | `Stop` while subagents run | ⚠️ | The main `Stop` fires while background subagents are still working. Its payload has `background_tasks: [{id, type:"subagent", status, agent_type, …}]`. **"Finished" = main `Stop` with an empty `background_tasks`** |
| 8 | `continue:false` (Stop) | ⚠️ | On main `PostToolUse` it stops **immediately**: no further turn and **no `Stop` event**. On a subagent's event it stops **only that subagent**; the main agent continues. On `PreToolUse`, calls already issued **in the same batch still run**. Fix: while stopping, answer every `PreToolUse` with `continue:false` **plus** `permissionDecision:"deny"`, so nothing else runs (verified) |
| 9 | Deny with reason | ✅ | Claude receives `PreToolUse:Bash hook error: <reason>` and does not retry |
| 10 | `additionalContext` | ✅ | Works on `PostToolUse` and on `UserPromptSubmit` (including task notifications), so check results can reach the orchestrator either way |
| 11 | `SubagentStop` → `decision:block` | ✅ | The subagent continued and ran the extra command. `stop_hook_active` was **not** seen as `true` on later stops (they were new continuations), so **the app must count retries itself per `agent_id`** |
| 12 | Failed Bash command | ✅ | `PostToolUseFailure` with `error: "Exit code 1"`, `is_interrupt: false`. The transcript has `tool_result.is_error: true` |
| 13 | `mcp__server__*` in an agent's `tools:` | ✅ | `probe-helper` with `tools: Bash, mcp__echo__*` called `mcp__echo__echo` |
| 14 | MCP events show the server's scope | ✅ | MCP tool events include `mcp_server: {name, source}` (e.g. `source:"project"`), so inherited servers can be recognized directly |
| 15 | `permissions.deny: ["Agent(<name>)"]` | ✅ | The agent disappears from Claude's list ("not listed in the available agent types"). No `PermissionDenied` event fires |
| 16 | Same-name agents | ✅ | Two files in one folder, both `name: dup-agent`: **the first file alphabetically won** (`dup-a.md` over `dup-b.md`). **Project beats user:** a temporary `~/.claude/agents/crewglass-probe-dup.md` with the same name lost to the project's `dup-a.md`. The temp file and the `~/.claude/agents/` folder it needed were removed right after, so your setup is unchanged |
| 17 | `agent` setting → folder runs as the orchestrator | ✅ | `"agent": "probe-helper"` in `settings.local.json` → the session used that agent's prompt and model. Main-session events then carry `agent_type` **without** `agent_id` (subagent events always have `agent_id`). The transcript gets an `agent-setting` entry, so the orchestrator is visible without hooks |
| 18 | `claude -p --agent <name>` + `stream-json` | ✅ | Ran as `probe-helper` (Haiku), with `agent_type` on every event |
| 19 | Live reload mid-session | ✅/⏳ | A **new agent file**, **settings changes** and **newly added hooks** all took effect on the very next turn of a running headless session. `ConfigChange` fires with `source: "local_settings"` or `"skills"` (agent files). Re-check in a VS Code interactive session in Phase 2 |
| 20 | Subfolder sessions | ✅ | A session started in `<folder>/sub` used `<folder>/.claude` hooks and rules (the folder was a git repo) |
| 21 | `.claude/rules/*.md` loads automatically | ✅ | Claude knew the rule's secret word. The `InstructionsLoaded` hook reports `file_path`, `memory_type: "Project"`, `load_reason: "session_start"` |
| 22 | Effort per model | ⚠️ | Opus 5.5 records `effort` (`xhigh` in your transcripts) and Sonnet 5 records `low`. **Haiku 4.5 records no effort**, so no effort chips for Haiku, and relay agents have no `effort` field. The subagent schema accepts `low · medium · high · xhigh · max` or an integer (`xhigh` on a subagent: ⏳ Phase 3) |
| 23 | Context windows | ✅ | From Claude Code's own model table: **Opus 5.5 1M, Sonnet 5 1M, Fable 5.1 1M, Haiku 4.5 200k**. `claude -p --output-format json` also reports `contextWindow` per model. Transcripts don't, so the app keeps an editable table |
| 24 | Skill use | ✅ | The `Skill` tool input is `{skill, args?}`. The subagent tool is named `Agent`, or `Task` in older transcripts; handle both |
| 25 | `node:sqlite` in Electron | ✅ | Electron **44.4.5** → Node **24.21.0**. `node:sqlite` works (`DatabaseSync`). No native modules needed |
| 26 | Swift hook helper speed | ✅ | Round trip with the app answering: **median 2.8 ms**. App missing: **2.6 ms**. The same thing in Node: 31 ms. A 5 MB payload took 146 ms when forwarded whole, so the real helper must send only whitelisted fields (fast path for huge events) |
| 27 | Unix socket path limit | ⚠️ | macOS limit: 104 characters. The scratchpad path failed (`EINVAL`), which proves the check is needed. The planned `~/Library/Application Support/Crewglass/crewglass.sock` is 67 characters for you; fall back to `$TMPDIR` if a path is ever too long |
| 28 | Session `status` values | ✅/⏳ | Seen: `busy`. The sessions file has `status` + `statusUpdatedAt`. Other values (`idle`, …) will be recorded by the unknown-fields check |
| 29 | Teammates / background sessions → lead | ⏳ | Agent teams aren't in use on this Mac yet. The kinds `teammate` / `background` exist in the binary. Verify the first time you use agent teams |
| 30 | `cwd` for agents in a git worktree | ⏳ | Phase 5, when checks are built |
| 31 | `mcpServers` field in agent files | not needed | The plan registers the agy bridge at local scope and gives agents access through `tools:` |

**Other things learned:**
- **Stable Node path:** `process.execPath` is `/opt/homebrew/Cellar/node/26.7.0/bin/node`, which breaks on `brew upgrade`. Always register `/opt/homebrew/bin/node` (the stable link).
- **`disallowedTools` is ignored when `tools` is set** (from the schema description). The editor must not write both.
- **Small token undercount:** Claude Code makes small internal calls (e.g. Haiku for session titles). These appear in its own cost totals but **not in transcripts**, so transcript-based numbers run slightly low.
- **Transcript entry types seen:**
  - `user`, `assistant`, `attachment`, `system` (`stop_hook_summary` with `hookErrors`, `preventedContinuation`);
  - `cost-state`, `agent-setting`, `ai-title`, `last-prompt`, `queue-operation`, `file-history-snapshot`, `file-history-delta`, `atis-latch`.
- **Hook payload text fields that must never be forwarded:** `prompt`, `tool_input`, `tool_response`, `last_assistant_message`, `error` (can contain output).

---

## 2. Hook payload fields (v2.1.281)

**Common to all events:**
- `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `scratchpad_dir`;
- most events also have `permission_mode` and `prompt_id`;
- subagent events add `agent_id` + `agent_type`;
- a session running *as* an agent has `agent_type` only.

| Event | Extra fields |
|---|---|
| `SessionStart` | `source` (`startup`, …) |
| `InstructionsLoaded` | `file_path`, `memory_type`, `load_reason` |
| `UserPromptSubmit` | `prompt` (text; a `<task-notification>` prefix means a subagent finished) |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`; MCP tools add `mcp_server {name, source}` |
| `PostToolUse` | as `PreToolUse` + `tool_response`, `duration_ms` |
| `PostToolUseFailure` | as `PreToolUse` + `error`, `is_interrupt`, `duration_ms` |
| `SubagentStart` | `agent_id`, `agent_type` |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` |
| `ConfigChange` | `source` (`local_settings`, `skills`, …), `file_path` |
| `SessionEnd` | `reason` |

**Answers verified:**
- `PostToolUse` / `UserPromptSubmit`: `hookSpecificOutput.additionalContext`.
- `PreToolUse`: `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`.
- Any event: `continue: false` + `stopReason`.
- `SubagentStop`: `decision: "block"` + `reason`.

---

## 3. Changes this makes to the plan

These are folded into `docs/PLAN.md`:

1. **Stop:**
   - While the Stop flag is set, every `PreToolUse` answers `continue:false` **and** a deny, and `PostToolUse` answers `continue:false`.
   - Claude halts after the call it's in, no other call in the batch runs, and no new turn starts.
   - No `Stop` event follows, so the app marks the turn "stopped" itself.
2. **The Stop flag clears only on a real message from you.** A `UserPromptSubmit` that starts with `<task-notification>` is a subagent finishing, not you.
3. **Background subagents:**
   - Check results reach the orchestrator via `additionalContext` on `PostToolUse(Agent)` (foreground) **or** on the task-notification `UserPromptSubmit` (background).
   - "Finished" = main `Stop` with no `background_tasks`.
4. **Retry cap:** "send back to fix" is counted by the app per `agent_id`; `stop_hook_active` isn't relied on.
5. **Token counting:** keep the **last** transcript line per `message.id`.
6. **Effort chips** only for models that use effort (Opus, Sonnet, Fable); not Haiku. The context-window table defaults are the numbers in #23.
7. **Headless `claude -p` runs** are detected from new transcript files in the folder (and from hooks); they have no session file. Other Agent SDK apps are excluded by the transcript's `entrypoint` (`sdk-ts` / `sdk-py`).
8. **Hand-offs can be direct.** A subagent that has the `Agent` tool can call another subagent. A link A → B gives A the `Agent` tool (when A uses "Only what I connect") and is written in the team map. The canvas draws real parentage from `agent_id` / `parentAgentId`.
9. **No "restart Claude" notes** for agents, settings or hooks, because they reload live (re-check in a VS Code session in Phase 2).
10. **Inherited MCP servers** are recognized from `mcp_server.source`. Rule files that load are confirmed with `InstructionsLoaded`.
11. **The agy bridge** is registered with the stable `/opt/homebrew/bin/node` path.
12. **The Swift helper** sends only whitelisted fields, with a fast path for very large events.

---

## 4. Re-running the checks

- **Read-only, free:** `node scripts/probe.ts --folder <path>` (add `--json` for machine-readable output). It prints field names, types and small enum values only.
- **Live hook checks** (few cents, Haiku):
  1. Run `node scripts/probe-live/setup.mjs <new-empty-folder>`.
  2. In that folder, run `claude -p --model haiku --allowedTools "Bash(echo:*),Agent,mcp__echo__echo"` with prompts that use `probe-helper`, `nester` and a failing `false` command.
  3. Read `events.jsonl`.
  4. To test answers, put rules in `control.json`, e.g. `[{"event":"PreToolUse","match":{"tool_name":"Bash"},"times":1,"output":{…}}]`.
