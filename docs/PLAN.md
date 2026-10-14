# Crewglass: see, design and safeguard your Claude Code agent team (macOS, 100% local)

> This is the design plan the app was built from, kept as a record of the decisions and of what was verified
> against real Claude Code along the way. Code comments refer to its sections (e.g. "plan §4.2"). For using the
> app, see the [README](../README.md).

## Context

You want a Mac app where you **pick a folder** (e.g. `~/projects/my-app`) and then, for **Claude Code only** in that folder:

1. **See it live:** the orchestrator, subagents, teammates, MCP servers and `agy` agents, each with **the model and effort it's using** (e.g. "Opus 5.5 · high", "agy · Gemini 3.1 Pro").
2. **Design it easily:** drag agents, models, MCP servers and checks from a side library onto a StarUML-style canvas and connect them. Make any agent **the orchestrator**.
3. **Trust the output:** the orchestrator checks each agent's work (tests, reviewer verdicts, a second opinion from another model) and sends failed work back to be fixed.
4. **Protect your tokens:** warnings as you near your limits, a one-click **Stop**, and a breaker that pauses a command that keeps failing and asks you what to do.
5. **Stay private and safe:** runs on its own (this repo is only for building it), nothing leaves your Mac, and it's built and reviewed with security in mind.

It grew out of an earlier agent-orchestration prototype and reuses ideas from it: observer-hook rules, hook event
wiring, a sandboxed agy bridge and a Gemini model list.

**Working agreement:** nothing is built until you approve this plan. The **first deliverable is a clickable UI prototype** for you to try. I stop after every phase for your review and ask before every git commit.

### Decisions (all confirmed by you)

| # | Topic | Decision |
|---|---|---|
| D1 | Name and tech | **Crewglass**. Electron + React + TypeScript, Apple Silicon. Data in `~/Library/Application Support/Crewglass/`, logs in `~/Library/Logs/Crewglass/` |
| D2 | What is watched | **Only the folder you select**, plus its subfolders |
| D3 | Which sessions | Claude Code from **VS Code and the terminal**, plus the teammates and background agents they start in that folder |
| D4 | agy | Shown only when Claude Code uses it. `~/.gemini` is never read. An agy agent is a **tiny Haiku 4.5 relay subagent** that hands the task to Gemini |
| D5 | MCP servers | Configured for the folder (project, local and user scope) **plus** any other server Claude actually uses there, marked "inherited" |
| D6 | Connectors | Drawn automatically from what really happens. You can keep, add or change them. **Run pipeline** guarantees the order |
| D7 | Orchestrator | **Your Claude Code chat leads the team by default** (D20). Any Claude agent can be made the folder's orchestrator when you want new chats to run as it |
| D8 | Checks | A failed check sends the work **back to be fixed, at most 2 times**, then it's reported to the orchestrator and to you |
| D9 | Usage limits | **Warn, never stop automatically.** A one-click **Stop** is always visible. Since D21 the limits are in API-equivalent **dollars**, and at 95% (Live mode) Claude is *asked* to wrap up — still never blocked |
| D10 | Failing commands | The same command fails **3 times** → it's paused and **you choose**: let the orchestrator handle it, give instructions, allow retries, or stop |
| D11 | Storage | **Numbers and names only**. Prompt and reply text is never written to disk. Past **30 days** loaded when you select a folder; numbers kept **90 days** (adjustable, plus a **Delete all data** button) |
| D12 | Git | Agent, MCP and team files are normal project files, with a per-agent "Keep private" switch and a **secret guard** |
| D13 | Notifications | **Few pop-ups:** only when you must act or something important finished or failed. Everything else waits quietly in the 🔔 inbox (§8) |
| D14 | v1 scope | Subagents, models, MCP servers, checks, orchestrator. Skills are **shown when used** (read-only chips); editing skills, slash commands and permission rules comes later |
| D15 | Process | **Clickable prototype first**, then the real app |
| D16 | Same-name agents | **Allowed.** Each card is tracked by its file, not its name, and shows which copy Claude will actually use |
| D17 | Claude Code updates | A small **"Unknown fields detected"** box in the bottom-left shows what changed and where in *this* project's source code to fix it (§13.1) |
| D18 | Subagent → subagent calls | **Allowed, with a clear `Reason:` and an approval.** Links you drew = approved by you in advance. Other calls: the **orchestrator** approves, and **you** approve costly ones (Opus at high effort or above, or agy / Gemini). No answer from you within 2 min → it goes to the orchestrator (§6.5) |
| D21 | Limits in dollars | Per session and per day per folder, in **API-equivalent USD** (what the usage would cost at Claude API prices; cache reads and 5-minute / 1-hour cache writes at their own rates). Tokens (input + output) and cache stay visible. Defaults $25 / session, $50 / day. Spend counts only the chosen folder (D2) |
| D22 | Near the limit | 80% inbox warning · **95%: the main chat is asked once a day, after a tool step, to finish its step and write `.claude/handoff.md`** · 100% pop-up. Nothing is ever blocked (a hard block at 100% was considered and declined) |
| D23 | Extras for long work | **`/handoff` + `/pickup`** (optional per folder, through Review changes; the note is kept out of git; a usage-rules file tells Claude the 95% notice is from your own tool) · **status line** in Live mode folders (model · ctx · today $/limit · session $ · runs-as · handoff ✎) · **subagent templates**: new `explorer`, every role returns a short summary, self-contained read-only roles start without CLAUDE.md (`omitClaudeMd`) |
| D20 | Who leads | **The Claude Code chat (VS Code or terminal) is the orchestrator by default**: team presets never create an orchestrator agent, and hand-offs start at the chat card. Only when you **Make orchestrator** on an agent do new chats run as it (**Let the chat lead** goes back). The agent an open chat runs as gets a **double border**; a plain chat marks no agent |
| D19 | Connector sign-in | **Done in Claude Code, not in Crewglass.** Plugin connectors are signed in with `/mcp` in Claude Code and claude.ai connectors in your claude.ai settings. Crewglass never handles sign-ins or tokens (that would mean going online and touching credentials); it only shows the connectors Claude actually uses in the folder, marked "inherited" |

### Verified on your Mac (Claude Code v2.1.281)

**Subagent files accept:**
- `model`, **`effort`** (`low` · `medium` · `high` · `xhigh` · `max`), `tools`, `disallowedTools`;
- **`maxTurns`**, **`mcpServers`** (servers connected only while that agent runs), **`hooks`** (hooks active only while that agent runs);
- `permissionMode`, `initialPrompt`, `memory`, `isolation`, `background`, `color`.

**Settings:**
- An **`agent` setting** makes a folder's sessions run as a chosen agent. This is the orchestrator mechanism.

**Hooks:**
- They can **stop Claude** (`continue: false` + `stopReason`).
- They can **deny one tool call with a reason Claude reads** (`permissionDecisionReason`).
- They can **add context** (`additionalContext`) and **send a finishing agent back to work** (`decision: block`, with `stop_hook_active` to prevent loops).
- They report `agent_id`, `agent_type` and `agent_transcript_path`.
- 28 hook events exist, including `CwdChanged`, `PermissionRequest`, `StopFailure`, `SubagentStart/Stop`, `PostModelSwitch` and `TeammateIdle`.

**Phase 0a (live experiments):** see `docs/data-sources.md` for all 31 findings with evidence. The plan below already includes them.

**Other:**
- Session kinds: `interactive`, `teammate`, `background`, `sdk`. Entrypoints on your Mac: `claude-vscode`, `cli`.
- Transcripts record `message.model`, `usage`, `effort`, `isSidechain`, and split one reply over several lines (`apiBlockIndex`).
- `CLAUDE.local.md` and `.claude/rules/` are supported. `**/.claude/settings.local.json` is already in your global git ignore.
- The CLI has `claude -p --agent <name> --effort <level> --output-format stream-json`.
- Your agy supports `agy -p --sandbox --model --output-format stream-json`.

---

## 1. How it works (plain version)

```
 ① You pick a folder in Crewglass
        │
 ② Claude Code (VS Code or terminal) working in that folder…
        ├─ keeps a status file  ~/.claude/sessions/<pid>.json   → running? busy / idle? which folder?
        ├─ writes a transcript  ~/.claude/projects/…/<id>.jsonl  → model, effort, tokens, every tool call (≈1 s behind)
        └─ Live mode: runs Crewglass's hook from <folder>/.claude/settings.local.json
               → tiny compiled helper → Unix socket file → Crewglass (instant)
               ← Crewglass can answer back: "stop", "pause this failing command", "fix this and try again"
        │
 ③ Crewglass keeps only what belongs to your folder → canvas, models, usage, alerts, safeguards
        │
 ④ You design on the canvas → Review changes → Save → backup → Claude Code's own config files
        │
 ⑤ The next Claude session in that folder runs as your orchestrator, with your agents, models, checks and limits
```

Crewglass reads the records Claude Code already keeps on your Mac. Through Claude's official hooks it can also **answer back**, which is how Stop, the failing-command breaker and "send it back to fix" work.

**Nothing blocks Claude if the app is closed.** The hook helper finds no app, allows everything, and exits in milliseconds.

---

## 2. The screens (designed to be easy)

### 2.1 Main window

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 📁 agent app ▾   ● Working · 2 agents running   Session 1.2M / 2M ▓▓▓▓▓▓░░  Today 3.4M / 10M   [■ Stop]   🔔 1   [Review changes (3)] │
├───────────────┬──────────────────────────────────────────────────────────────┬───────────────────────┤
│ LIBRARY   🔍  │                          CANVAS                               │ DETAILS · coder       │
│ ▸ Team presets│                 ┌─────────────────────────────┐              │ Role                  │
│ ▾ Agents      │                 │ 🎼 ORCHESTRATOR · lead       │              │  Writes and edits     │
│   ＋ New agent │                 │ Opus 5.5 · high              │              │  code for a task      │
│   lead        │                 │ ● planning · 41k tokens      │              │ Model   [Opus 5.5 ▾]  │
│   planner     │                 └──┬────────────┬───────────┬──┘              │ Effort  low [med] high│
│   coder       │        hands work to│            │           │                 │ Checks  ✓ npm test    │
│   reviewer    │       ┌──────────────▼┐   ┌──────▼───────┐  ┌▼────────────────┐│         ✓ reviewer OK │
│ ▾ Models      │       │ planner       │   │ coder        │  │ gemini-reviewer ││ Limits  40 turns      │
│   Opus 5.5    │       │ Opus 5.5·high │   │ Opus 5.5·med │  │ agy·Gemini 3.1  ││ Tools   Only connected│
│   Sonnet 5    │       │ ✓ done        │   │ ● editing    │  │ via Haiku relay ││ ☐ Keep private        │
│   Haiku 4.5   │       └───────────────┘   └──┬────────┬──┘  └─────────┬───────┘│ [Open file] [Disable] │
│   Gemini 3.1… │                     can use  │        │ ✓ checked by ┘        │                       │
│ ▾ MCP servers │                      (github MCP)     [✓ npm test]            │ Live now              │
│   github      │                                                                │  Edit src/app.ts · 2s │
│   ＋ Add MCP   │                                                                │  Opus 5.5 · medium    │
│ ▾ Checks      │                                                                │  18k tokens this task │
│   npm test    │                                                                │                       │
│   Reviewer OK │                                                                │                       │
├───────────────┴──────────────────────────────────────────────────────────────┴───────────────────────┤
│ ┌───────────────┐                                                                                     │
│ │⚠ Unknown      │ LIVE ▁▂▅▇▅▂ 3.1k tok/min · coder: Edit src/app.ts (Opus 5.5·med) · ⚠ `npm test` failed 2×  [⌃ Usage · Activity · History] │
│ │ fields (2)    │                                                                                     │
│ └───────────────┘  ← appears only after a Claude Code update adds or changes something (§13.1)         │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar:**
  - folder switcher;
  - plain status ("Working · 2 agents running", "Waiting for you", "Idle");
  - limit meters (the session meter follows the session you've selected, by default the most recently active one);
  - **Stop**, visible whenever Claude is running. With several sessions it becomes a small menu: **Stop all** or stop one;
  - 🔔 **Attention inbox** (things that need a decision);
  - **Review changes (N)**.
- **Library (left):** everything you can add, searchable.
  - **Team presets:** Plan → Code → Review; Code + Test + Review; Research + Write; Just watch.
  - **Agents:** yours plus role templates.
  - **Models:** Claude and Gemini via agy, each with effort chips.
  - **MCP servers**.
  - **Checks**.

  Every item can be **dragged onto the canvas or added with its ＋ button**, so dragging is never required.
- **Canvas (center):** the orchestrator on top and the team below, connected with plain-language links: *hands work to*, *can use*, *checked by*.
  - Each card shows name, role, **model · effort**, live status and tokens.
  - Live activity animates along the links.
  - **Only your team is on the canvas:** this folder's agents, plus anything used or connected here. Every other available agent (your all-projects agents, templates) waits in the Library, so the canvas stays uncluttered.
- **Menu bar icon:** status ("● agent app: working" / "waiting for you"), **Stop**, open window, **Quit**. Closing the window keeps Crewglass watching in the background.
- **Details (right):** changes with what's selected.
  - **Nothing selected:** folder overview, quick actions, hints.
  - **Agent selected:** role, model, effort, checks, limits, tools, what it's doing now.
  - **Link selected:** its meaning, calls, tokens, check results.
- **Live strip (bottom):** a one-line summary. Expand it for the **Usage**, **Activity** and **History** tabs.
- **Unknown-fields box (bottom-left):** a small square that appears **only** when Claude Code's files contain something Crewglass doesn't recognize. Click it for details and a fix path (§13.1).
- **Skills chips:** when Claude or an agent uses a skill (the `Skill` tool), the card shows a small chip, e.g. "skills: pdf, docx". It's for seeing only, not editing, in v1.

### 2.2 What makes it easy

- **Drag a model** onto an agent to set its model and effort. Drop one on empty space to create an agent with that model. A Gemini model creates an agy agent.
- **Right-click an agent:** Make orchestrator · Change model ▸ · Duplicate · Add check ▸ · Disable · Delete · Open file in VS Code.
- **Plain words everywhere.** Every icon and line style has a tooltip, and there's a **Legend** button.
- **Smart hints** (local rules, dismissible):
  - "The orchestrator has no agents to hand work to."
  - "reviewer uses the same model as coder. A different model catches more mistakes."
  - "The relay agent is set to Opus xhigh; Haiku low is enough."
  - "coder has no checks."
- **Nothing is written silently.** Edits collect in **Review changes**, which lists them in plain English (e.g. "Create agent *coder* (Opus 5.5 · medium)", "Let *coder* use *github*") → then a file diff → **Save**.
- **Undo everywhere:** ⌘Z for canvas edits, **Undo last save** restores files.
- **Keyboard:** ⌘O folder · ⌘S review and save · ⌘Z / ⇧⌘Z · ⌘F find · ⌘. Stop · ⌘1/2/3 tabs.

### 2.3 Status colors

- grey: idle
- green pulse: running (×N when parallel)
- amber: waiting for you
- red: failed
- ✓ / ✗: check passed / failed, e.g. "✗ try 1/2"

---

## 3. Scope: exactly what counts, exactly what is read

### 3.1 Which sessions are shown

A session is shown only if **all** of these are true:
1. Its status file exists in `~/.claude/sessions/` and its process is alive.
2. Its `cwd` (real path) **is** the folder or is **inside** it.
3. It's one of these kinds:
   - `interactive` with entrypoint `claude-vscode` or `cli`;
   - `teammate` or `background`;
   - a headless `claude -p` run you start from a terminal (shown as "Terminal · headless"). Phase 0a found these have **no session file**, so they're detected from new transcript files in the folder and from Live-mode hooks. Transcripts from other Agent SDK apps (`entrypoint` `sdk-ts` / `sdk-py`) are skipped;
   - anything Crewglass started itself (Run pipeline).

   **Excluded:** other apps built on the Claude Agent SDK, and the Claude desktop app.

Status files that don't match are dropped on the spot and never stored, counted or shown. `CwdChanged` or a changed `cwd` is checked again immediately.

### 3.2 The complete list of what the app reads

| Source | Fields used |
|---|---|
| `~/.claude/sessions/*.json` (**never** `*.key`) | pid, sessionId, cwd, kind, entrypoint, status, updatedAt, version |
| `~/.claude/ide/*.lock` | `workspaceFolders` only (**never `authToken`**), for folder suggestions |
| Transcripts of this folder's sessions (live ones, plus the last 30 days for History) + their subagent transcripts | `message.id`, `message.model`, `usage`, `effort`, `isSidechain`, `timestamp`, `cwd`, and `tool_use` / `tool_result` metadata (§4.1). To find past sessions, only folders in `~/.claude/projects/` whose name starts with this folder's encoded path are opened, and only their first line is read to confirm the `cwd` |
| `<folder>/.claude/agents/*.md`, `~/.claude/agents/*.md` | whole file |
| `<folder>/.mcp.json` | server names, type, command or URL (env **names** only) |
| `<folder>/.claude/settings.json`, `settings.local.json` | `hooks`, `agent`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `permissions.deny` entries shaped like `Agent(...)` |
| `~/.claude.json` | **only** `mcpServers` and `projects["<folder>"].mcpServers`; the rest is dropped once parsed |
| Process list (`ps`) | pid, parent pid, %CPU, memory, **program name only** (never arguments) |
| Files Crewglass manages | `.claude/rules/crewglass-team.md`, `.claude/commands/workflow.md`, and only its own lines in `.git/info/exclude` (plus `git check-ignore` to confirm a file is ignored) |

**Never read:**
- `~/.gemini`, the Claude desktop app's data, browser data;
- other folders' transcripts;
- credential files.

**Finding transcripts:** use the hook's `transcript_path`, or the `sessionId`, then **check the `cwd` inside the file**. Directory names alone aren't enough: `agent app` and `agent-app` encode to the same name.

---

## 4. Live data

### 4.1 Transcript reader (always on)

- **Reads only new lines:** from a remembered byte offset. A partial last line waits for the next change.
- **Fields used:**
  - usage (`input`, `output`, `cache_read`, `cache_creation`);
  - `message.model` and the entry's `effort`;
  - `tool_use` (`id`, `name`, and from the input only: `subagent_type`, `file_path`, a **normalized command signature**, the MCP server and tool, the skill name for `Skill`, for `agy` commands the `--model` value, and for the `Agent` tool a **one-way hash** of the task, used to spot identical re-launches without keeping any text);
  - `tool_result` (`tool_use_id`, `is_error`, and for checker agents only the word **PASS** or **FAIL** from a `VERDICT:` line; the rest of the reply is not kept).
- **Ignored:** text, thinking, attachments.
- **Counted once per `message.id`, using the LAST line for that id.** Earlier lines are streaming snapshots with smaller numbers (Phase 0a). Subagent transcripts (`<session>/subagents/agent-<id>.jsonl`) are added up separately; the main transcript never repeats them.
- **Small known undercount:** Claude Code's own small internal calls (e.g. naming the session) aren't in transcripts.
- **30-day backfill:** a cancellable background job stores per-minute numbers and shares file offsets with the live reader, so nothing is counted twice.

### 4.2 Live mode (hooks, per folder; recommended in the first-run wizard)

- **Where:** only `<folder>/.claude/settings.local.json`.
  - It's personal and already git-ignored on your Mac. The app double-checks with `git check-ignore` and falls back to `.git/info/exclude`.
  - No other folder is ever touched.
- **The helper:** a tiny **compiled Swift program**, `crewglass-hook`.
  - Built with the `swiftc` you already have, and copied to `~/Library/Application Support/Crewglass/bin/`.
  - It needs no Node, starts in about 5 ms, and lets the Electron app turn off risky runtime features (§9).
  - One command for every event: `"<abs path>/crewglass-hook"`, fully quoted. The helper reads the event from stdin, sends the whitelisted fields to the app, waits for the app's answer, and prints only what that answer requires.
  - It is replaced automatically when you rebuild the app. The path never changes, so the hook entries stay valid.
- **What the app can answer, per event:**

  | Events | Possible answers |
  |---|---|
  | `SessionStart` | **Nothing Claude reads, ever.** Only a one-line notice for you (`systemMessage`: shown in the chat, never added to Claude's context; verified): which agent the chat runs as, what it starts on, who it hands work to. The helper drops anything else. Can be switched off in Settings |
  | `UserPromptSubmit` | **For your own messages: nothing, ever**, and the Stop flag **clears**, so your next message after a Stop works normally. **For a `<task-notification>`** (a background subagent finished; verified in Phase 0a) the Stop flag stays set, and the app may add a note with that agent's check results (`additionalContext`) |
  | `PreToolUse` (all tools, including `Agent`) | **allow** (prints nothing) · **stop** (`continue:false` **plus** `permissionDecision:"deny"`, so no other call in the same batch runs; verified) · **pause this command** (`permissionDecision: "deny"` + a reason Claude reads) · for an `Agent` call **made by a subagent**: check the `Reason:` line, then allow, refuse with a reason, or **wait for your approval** (up to 2 min, then route to the orchestrator) (§6.5) |
  | `PostToolUse`, `PostToolUseFailure` | nothing · **stop** · **pass a note to Claude** (`additionalContext`): your instructions, or check results for the orchestrator after a foreground `Agent` call |
  | `SubagentStop`, main `Stop` | allow · **send back to fix** (`{"decision":"block","reason":<failure summary>}`), at most 2 times, also guarded by `stop_hook_active` |
  | All other events (`SessionEnd`, `CwdChanged`, `StopFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `SubagentStart`, `Pre/PostCompact`, `PostModelSwitch`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`) | Observed only; prints nothing |

- **Installed once, controlled live.** The hook entries are written one time. After that, turning Stop, the breaker, checks or limits on or off happens **inside the app, instantly**, because the helper asks the app on each event. Changing a safeguard never means editing files or restarting Claude.
- **Stop acts fast** (verified in Phase 0a).
  - Stop is answered on the next `PreToolUse`, `PostToolUse` or `PostToolUseFailure` of that session, including its subagents' events, usually within 1–2 s of active work.
  - Claude finishes only the call it's already in; every other call in that batch is denied, and no new turn starts.
  - A stopped subagent stops alone, so the flag applies to **every** agent in the session, and the main agent stops at its own next event.
  - No `Stop` event follows a stop, so the app marks the turn "Stopped" itself.
- **Timeouts per hook entry:**
  - **check timeout + 30 s** for `SubagentStop` / `Stop`, because checks like `npm test` can take minutes;
  - **150 s** for `PreToolUse`, so an approval can wait up to 2 min. The helper itself answers normal calls in milliseconds, so this only matters while you're deciding;
  - 5 s for everything else.
- **Never slows Claude down:**
  - When the app is running it answers in a few milliseconds.
  - If it fails to answer within 300 ms three times in a row (for example, it's frozen), the helper stops waiting for 60 s (a small marker file) and simply allows. The exception is direct subagent calls, which get Claude's own prompt instead (§6.5).
  - Approvals don't count as slow: the app answers "waiting for approval" at once, and the helper then waits for your decision.
  - Large events (e.g. a big file write) are read fully but only the whitelisted fields are parsed.
- **Fields forwarded:**
  - Forwarded: `hook_event_name`, `session_id`, `cwd`, `transcript_path`, `agent_id`, `agent_type`, `tool_name`, `tool_use_id`, `permission_mode`, `notification_type`, error type, `stop_hook_active`, and a short `target` (a relative file path, the command signature cut to 80 characters, a subagent type, an MCP tool, an agy model).
  - For `Agent` calls only, two small structured pieces, held in memory only (§6.5): the `Reason:` line (up to 200 characters), and the agent **names** from an `Allowed calls:` line.
  - **Never forwarded:** `prompt`, the rest of `tool_input`, `tool_response`, assistant messages.
- **Fail-open:** if the app isn't running, or doesn't answer within 300 ms (gates: within your check timeout), the helper **allows** and exits 0. Claude is never blocked by Crewglass being absent.
- **Install and remove:**
  - You see a diff first.
  - Running it twice changes nothing.
  - The file is re-read just before writing, because Claude Code writes to it too.
  - Only entries pointing at `crewglass-hook` are touched.
  - Removal restores the file exactly.
  - Every folder with hooks is kept on a list, so Uninstall cleans them all.
  - **No restart needed:** Phase 0a showed hooks added to a running session work from its next turn (re-checked in a VS Code session in Phase 2). The first-run wizard shows a live check: "Live mode active ✓".
  - **Launch at login is on by default**, so the safeguards are there whenever Claude runs (you can turn it off).

### 4.3 Processes, agy, MCP servers

- **Processes:** every 2 s, `ps` walks down the tree under each included Claude pid. Child processes are labeled MCP server, `agy`, or other tools, using program names only.
- **agy:** shown when Claude runs `agy …`, calls the agy bridge, or starts an `agy` process.
- **MCP states:** configured, needs approval, disabled, running (with process), in use, failing, remote.
- **Inherited servers** (`mcp__claude_ai_*`, `mcp__plugin_*`) appear only once used here. Their scope comes straight from the `mcp_server.source` field on MCP tool events (verified in Phase 0a).

---

## 5. Models everywhere

- **Configured model:** from each agent's `model` and `effort`, and for the orchestrator from the `agent` setting. Shown as a chip on every card, e.g. "Opus 5.5 · high".
- **Actual model** (what really ran):
  - Claude: `message.model` + `effort` from the transcript, updated live by `PostModelSwitch`.
  - agy: the model **reported by the bundled bridge** (the model it ran agy with; agy's own output doesn't name a model), else the `--model` value from an `agy` command, else "Gemini (agy's default)".
  - Shown in the live ring on a running card, on each link (per call), in the Activity "Model" column, in Usage (tokens stacked **by model**) and in History.
- **Mismatch warning,** e.g. "Set to Sonnet 5, but ran on Opus 5.5 (inherited)".
- **Friendly names:**
  - `claude-opus-5-5` → Opus 5.5
  - `claude-sonnet-5-5` → Sonnet 5.5 (and earlier ids such as `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, Mythos and the 4.x models are named too)
  - `claude-haiku-4-5-20251001` → Haiku 4.5
  - `claude-fable-5-1` → Fable 5.1
  - `gemini-3.1-pro-high` → Gemini 3.1 Pro · high
  - unknown ids are shown as they are.
- **Model library:**
  - **Claude:** Opus 5.5, Sonnet 5.5, Fable 5.1 with effort chips low · medium · high · xhigh · max, and Haiku 4.5 **without** effort (Phase 0a: Haiku records no effort). The aliases follow Claude Code's catalog: `sonnet` → Sonnet 5.5, `opus` → Opus 5.5, `fable` → Fable 5.1, `haiku` → Haiku 4.5. Earlier or limited-access models are named when Claude uses them but not offered in the Library.
  - **Context windows** (from Claude Code's own model table, editable): Opus 5.5, Sonnet 5.5 and Fable 5.1 are 1M; Haiku 4.5 is 200k.
  - **Gemini via agy:** a bundled list (`gemini-3.1-pro-high`, `gemini-3.8-flash-high/medium/low`).
  - A **Refresh from agy** button runs `agy models` only when you click it. It's labeled, because agy may contact Google.
  - The list is editable.
- **Drag a model:**
  - onto an agent → sets its `model` and `effort`;
  - onto empty canvas → a new agent with that model;
  - a Gemini model → a new **agy agent** (§6.3).

---

## 6. Orchestrator, team, verification

### 6.1 The orchestrator

- **Make orchestrator** (right-click, or drag onto the 🎼 slot) writes `"agent": "<name>"` to `<folder>/.claude/settings.local.json`, which is personal.
  - Every new Claude session in that folder, from VS Code or the terminal, then **runs as that agent**, with its prompt, model and effort (e.g. Opus 5.5 · high).
  - Claude Code ignores an agent file's `effort` for the chat that runs as it, so Save also writes the orchestrator's effort to the folder's `effortLevel` (which can't hold max: max starts at xhigh). A model or effort you pick in a chat still wins for that chat.
  - There's one orchestrator per folder. The live main session merges into the orchestrator card.
  - **Let the chat lead** (one click; it replaced *Pause orchestrator*) removes the setting and moves the hand-offs back to the chat card; the agent becomes a regular one. This is the default (D20).
  - The orchestrator **always keeps the `Agent` tool**, even with "Only what I connect", because it needs it to hand work out.
- **How hand-offs really work** (verified in Phase 0a):
  - The orchestrator hands work to subagents.
  - **A subagent can also call another subagent directly, but only with a clear reason and an approval** (D18, §6.5). This saves tokens, because the work doesn't have to go back through the orchestrator's large context each time.
  - The canvas draws the **real** route from each event's `agent_id` and the subagent's `parentAgentId`: direct, or via the orchestrator.
  - Without an orchestrator agent — the default — the same rules apply, and your chat plays the orchestrator's part: the team map tells it which agent to hand each kind of work to, to answer quick questions itself, and to end with a verification table only when it handed work out. Checks on a hand-off from the chat are stored under `@chat`.
- **Subagents often run in the background** (verified). The orchestrator is woken when each one finishes. Crewglass follows this through `SubagentStop`, and the canvas shows background agents as running until then.
- **Bundled orchestrator template** (editable), with these steps:
  1. Plan.
  2. Split into tasks with **acceptance criteria**.
  3. Delegate following the **team map**. When a subagent will clearly need a helper, grant it in the brief (`Allowed calls: tester — to run the integration tests`). Answer any `REQUEST <agent>: <reason>` a subagent returns with (approve by calling that agent yourself, or say no and why).
  4. **Verify every result:** read the diff, confirm the checks passed, get the checker's `VERDICT: PASS|FAIL`.
  5. Send failed work back with specific feedback, **at most 2 times**.
  6. Escalate to the user.
  7. Finish with a report that includes a verification table.

  It also says: *"If Crewglass denies a tool call, don't retry it; follow the reason."*
- **The team map** is generated from the canvas into `.claude/rules/crewglass-team.md`, which is loaded in every session in the folder. It lists each agent, its role, model, effort and checks, and the **hand-off order**. `CLAUDE.md` is never edited. (Phase 0 confirms `.claude/rules/` loads automatically; the fallback is a marked block in `CLAUDE.md`.)

### 6.2 Agents

- **Card editor:**
  - **Name:** lowercase-with-hyphens, checked for clashes.
  - **Role / when to use:** the `description` field, with "Use when…" phrasing suggested.
  - **Instructions:** the prompt body.
  - **Model** + **Effort**.
  - **Max turns:** role defaults: coder 40, planner 20, reviewer 15, relay 3.
  - **Tool access:** "Inherit everything", or "Only what I connect", which writes an explicit `tools:` list of ticked built-in tools + `mcp__<server>__*`.
  - **Scope:** this project, or all my projects (extra confirmation).
  - **Keep private:** adds the file to `.git/info/exclude`.
    - This only works for files git isn't tracking yet. If the file was already committed, the app tells you and shows the `git rm --cached <file>` command for you to run.
    - The app never runs git commands that change your repo.
  - **Advanced:** `permissionMode`, `disallowedTools`. Claude ignores `disallowedTools` when `tools` is set, so the editor offers it only with "Inherit everything".
  - **Round-trip safe:** unknown fields, comments and field order are kept (`yaml` Document API).
- **Same-name agents are allowed (D16).**
  - Each card is identified by its **file** (scope + path), not its name, so a project `reviewer` and a user `reviewer` (or two files that both say `name: reviewer`) all appear as separate cards.
  - A small label shows which one Claude will actually use, e.g. "Claude uses this one" / "Hidden by the project version". Phase 0a confirmed the order: **a project agent beats a user agent**, and within one folder **the first file alphabetically wins**.
  - One honest limit: Claude Code picks agents **by name**, so when two share a name only one of them can run.
    - If you connect the hidden copy, the link shows "Claude will use the other *reviewer*", with one-click fixes: **Rename this copy** (e.g. `reviewer-strict`) or **Disable the other one here**.
    - Nothing is blocked, and nothing is changed until you click a fix.
- **Removing an agent** from the team disables it **for you in this folder**, via `permissions.deny: ["Agent(<name>)"]` in `settings.local.json` (syntax checked in Phase 0; fallback: move the file to `.claude/agents.disabled/`). **Delete file** is a separate action, and a backup is kept.

### 6.3 agy agents (Haiku relay)

- **An agy agent is a real Claude subagent**, e.g. `gemini-reviewer.md`:
  - `model: haiku`, `maxTurns: 3` (no `effort`, because Haiku doesn't use it);
  - its only tool is the bundled agy bridge;
  - its prompt: *"Forward the task verbatim to agy with model `<gemini id>`; return agy's answer verbatim; never do the work yourself."*
- **The bundled bridge** is a small MCP server (`resources/agy-bridge/agy-bridge.mjs`, no dependencies):
  - it runs `agy -p --sandbox --output-format json`;
  - it refuses non-Gemini models;
  - it reports the model, duration and Gemini tokens in one numbers-only line at the end of its answer, which Crewglass reads from the transcript (no socket or network needed).

  - It's registered **privately** with `claude mcp add --scope local crewglass-agy …`, so its path lives only in your own `~/.claude.json`. (A distinct name, so it never replaces an `agy` server a project already has.)
  - agy agent files default to **Keep private**, because the bridge exists only on this Mac. Someone cloning your repo would get an agent that can't reach agy.
  - The bridge is a small Node program, so agy agents need Node. It's registered with the **stable** `/opt/homebrew/bin/node` link, never the versioned `Cellar/…` path that breaks on `brew upgrade` (Phase 0a). If Node is missing, the card says so; nothing else is affected.
- **Cost:** a few hundred Claude tokens per call for the relay, plus agy's Google quota (about 12k tokens per call). Both are shown on the card.

### 6.4 Checks: verifying output

- **Kinds of check** (in Library → Checks):
  - **Command:** e.g. `npm test`, `npm run lint`, `tsc --noEmit`. Use **one check per command** (no `&&` needed), because commands never go through a shell. A check runs with a timeout (default 5 min), and its output is cut to the last 40 lines with secrets masked.
  - **Reviewer verdict:** a checker agent must answer `VERDICT: PASS` or `VERDICT: FAIL + reasons`.
  - **Second opinion:** the same, but the checker is an agy / Gemini agent, a different model family, so it catches different mistakes.
- **Attaching checks:** drag a check onto an agent (it checks that agent's output) or onto a hand-off link (it checks before the work is passed on).
- **How checks are enforced (D8):**
  - **Command checks:** when an agent that has checks finishes (`SubagentStop`, or `Stop` for the orchestrator), Crewglass runs its checks.
    - **They only run if that agent changed files during this run.** A plain question-and-answer turn never triggers `npm test`, which saves time and tokens.
    - They run in the agent's own working folder (the event's `cwd`). If the agent used an isolated git worktree, the checks run in that worktree.
    - On failure, the agent is sent back with the failure summary, **at most 2 times**.
    - The app counts the tries itself per agent run (`agent_id`), because Claude's `stop_hook_active` flag isn't reliable across continuations (Phase 0a).
    - After that the agent may stop, and you get an inbox item and a pop-up (§8).
    - The orchestrator gets a note ("coder FAILED `npm test` after 2 fix attempts: …"): on the `Agent` call's result if the subagent ran in the foreground, or on the task notification if it ran in the background (both verified).
  - **Verdict checks:** written into the team map as required steps. Crewglass confirms each one happened by reading **only** the `VERDICT: PASS|FAIL` word from the checker's reply. A missing or failed verdict shows ✗ on the link.
- **Command checks are stored privately** in the app's data per folder, not in the repo. A cloned or malicious repo can never make Crewglass run commands. The first time a check is enabled, you confirm its exact command.
- **On the canvas:** each link shows ✓ passed · ✗ failed (try 1/2) · ⏳ checking.

### 6.5 Direct calls between subagents: reason + approval (D18)

**Why:** a subagent calling a helper directly skips a round trip through the orchestrator's large context, which saves tokens. But unchecked calls can fan out and burn tokens. So every direct call needs **a clear reason** and **an approval**.

**1. A reason is always required.**
- The team map tells every agent: *"To call another agent, the first line of your request must be `Reason: <why you need them>`."*
- When a subagent calls the `Agent` tool (Live mode sees it as a `PreToolUse` whose event has an `agent_id`), Crewglass checks for that line.
- If it's missing or too vague (under 10 characters), the call is refused with: *"Add a first line `Reason: …` explaining why you need <agent>."*
- The app reads **only** that one line (up to 200 characters) and shows it live on the link and in the approval card. It's held in memory and never saved.

**2. Who approves:**

| Situation | Approved by | What happens |
|---|---|---|
| You drew that link on the canvas (e.g. *coder → tester*) and left it on **Allowed** | **You, in advance** | The call goes straight through; the reason is still required and shown |
| The orchestrator granted it in its brief (`Allowed calls: tester — …`) | **The orchestrator, in advance** | Goes straight through, for that agent run only. The app reads only the agent names on the `Allowed calls:` line |
| Anything else, and the agent being called is **not** costly | **The orchestrator** | The call is refused with: *"Direct calls to tester need the orchestrator's OK. Finish and reply with `REQUEST tester: <reason>`; the orchestrator will decide."* The orchestrator then calls tester itself, or declines |
| Anything else, and the agent being called **is costly**: Opus at high / xhigh / max effort, or an agy / Gemini agent (the thresholds are adjustable) | **You** | The subagent waits. You get a pop-up and a 🔔 card (see below). **If you don't answer within 2 minutes**, the call goes to the orchestrator as a `REQUEST` instead |

**3. The approval card:**
```
coder → tester          wants to call directly
Reason: "need the integration tests run against my change"
tester runs on Sonnet 5 · medium · this link used 0 times today
[Approve once]  [Always allow coder → tester]  [Send to orchestrator]  [Deny + note]
```
- **Always allow** turns the link into a drawn, **Allowed** link. It appears in **Review changes** like any other edit.
- **Deny + note:** your note reaches the subagent as the refusal reason. It's held in memory only.

**4. Limits that always apply:**
- At most **2 levels deep** (A → B → C), taken from `parentAgentId` / spawn depth.
- At most **3 direct calls per agent run** (adjustable).
- The identical-task loop check (§7).

Going over a limit is refused with a reason, and the subagent is told to return to the orchestrator.

**5. On the canvas** a subagent-to-subagent link shows its state:
- **Allowed** (solid);
- **Orchestrator decides** (dashed, 🎼 icon);
- **Needs your OK** (dashed, 🔒 icon);
- **Blocked** (grey).

Clicking a link changes its state.

**6. When Crewglass can't check:**
- **App closed (Live mode on):** the helper answers direct calls from a subagent with Claude Code's **own permission prompt** (`permissionDecision: "ask"`), so they're never silently allowed (verified in Phase 3 with `claude -p`; the VS Code prompt is still to be checked). Every other hook event still allows everything when the app is absent.
- **Live mode off:** there are no hooks, so reasons can't be checked. The only control is that just the subagents with a drawn outgoing link get the `Agent` tool. The Details panel says so: "Turn on Live mode to require reasons and approvals."

**How it's saved:**
- Link states and thresholds are written into the team map (`.claude/rules/crewglass-team.md`), so Claude knows the rules.
- A subagent with at least one outgoing link gets the `Agent` tool (when it uses "Only what I connect"). A subagent with no outgoing links doesn't get it, so it can't make direct calls at all.

---

## 7. Safeguards: token burn and loops

| Safeguard | What happens | Needs Live mode? |
|---|---|---|
| **Token limits** (per session, including its subagents, and per folder per day) | Warnings at **80%, 100%**, then every +25%. **Claude is never stopped automatically.** "Tokens" means input + output, like the Input and Output lines of Claude Code's `/cost`; cache writes and reads are shown separately (counting cache writes made long chats look inflated — see "Token counting" below). The "today" counters start again at each midnight. agy's Google tokens are tracked separately (a different quota). The suggested limits come from your last 30 days | No |
| **Stop button** (top bar, menu bar, every warning, ⌘.) | The session's next tool event answers `continue: false` (plus a deny on `PreToolUse`). Claude finishes only the call it's in; nothing else runs and no new turn starts, usually within 1–2 s of active work. Its subagents stop at their next event too. The Stop flag **clears automatically when you send your next message** (not when a background subagent reports in), or when you press **Resume** | Yes |
| **Failing-command breaker (D10)** | The same command signature fails in a session (a normalized Bash command, or the same MCP tool + arguments) **with no file edits in between**. Re-running `npm test` after Claude changed code is a fair retry and resets the count, so normal fix-and-retest cycles are never paused. 2nd failure → amber heads-up in 🔔. **3rd failure** (you can choose 2–5) → notification, and **that command is paused** (its next `PreToolUse` is denied with a reason; Claude can keep doing other work). **You choose:** ① **Let the orchestrator handle it**: Claude is told "don't retry as-is; find the root cause or try another approach, or escalate". ② **Give instructions**: your text reaches Claude with the next denied call or through `additionalContext`, held in memory only. ③ **Allow retries**: unpause and reset the count. ④ **Stop Claude**. Until you choose, the command stays paused | Yes (without it: warning only) |
| **"Claude may be stuck"** | 5 or more failures of any kind within 10 min → the same four choices. Nothing is paused automatically | Warning: no · choices: yes |
| **Subagent loop** | The same subagent launched with an **identical task** 3 or more times in one turn (compared by a one-way hash, never the text) → warning + choices. Sending coder several *different* tasks is normal and never triggers it | Warning: no · choices: yes |
| **Check retry cap** | At most 2 automatic "fix it" rounds per check (§6.4) | Yes |
| **Direct-call approvals (D18)** | A subagent calling another subagent needs a `Reason:` line and an approval: you in advance (drawn link), the orchestrator, or you for costly calls. At most 2 levels deep and 3 direct calls per agent run (§6.5) | Yes (without it: only subagents with a drawn link can call at all) |
| **Per-agent caps** | `maxTurns` in every agent file; relays capped at 3 | No (Claude Code enforces it) |
| **agy call cap** | Warn after more than 3 agy calls in one turn, i.e. from your message until Claude finishes  | No |
| **Context almost full** | Warn at 85%, once per session, reset after a compaction | No |

All decisions wait in the 🔔 **Attention inbox**, and notifications link straight to them.

---

## 8. Notifications: fewer pop-ups

The rule: **a macOS pop-up only when you need to act, or when a long task ends.** Everything else goes quietly into the 🔔 inbox. You see it as a count on the bell and on the menu bar icon, with no sound and no pop-up.

| Event | Pop-up? | Otherwise |
|---|---|---|
| **Claude needs permission** (`permission_prompt` / `PermissionRequest`) | ✅ Yes, but only if it's **still waiting after 20 s** (adjustable). If you're already looking at VS Code you'll have answered, and the pop-up is cancelled | Answered within 20 s: nothing |
| **A failing command was paused** (needs your choice) | ✅ Yes | — |
| **A costly direct call needs your OK** (§6.5) | ✅ Yes; the subagent is waiting (2 min, then it goes to the orchestrator) | Calls the orchestrator decides, and pre-approved calls: Activity tab only |
| **Work failed for good** (a check still failing after 2 tries, `StopFailure`) | ✅ Yes | — |
| **Claude finished a task** (it goes idle, waiting for your next message) — changed at your request: **after every task** by default, or only tasks longer than N min (Settings). Never for "waiting for permission", a Stop you pressed, or single pipeline steps; a pipeline notifies once when it ends | ✅ Yes (Mac notification) | — |
| **Limit reached (100%)** | ✅ Once per session or day | 80%: inbox + amber meter only |
| Context ≥ 85%, "Claude may be stuck", subagent loop, an MCP process died, the first check failure (being fixed automatically), second failure of a command | ❌ | 🔔 inbox |

- **Even fewer pop-ups:**
  - **No pop-ups while the Crewglass window is in front** (you already see it).
  - **Grouping:** several events within 10 s become one pop-up ("3 things need you in *agent app*").
  - **Cooldown:** 2 min per type per session.
  - macOS **Focus / Do Not Disturb** is respected.
- **Clicking a pop-up:**
  - If you need to act inside VS Code (e.g. permission): `open -a "Visual Studio Code" "<folder>"` brings that window forward.
  - If it's a decision (paused command): it opens that 🔔 item, with the 4 choices and **Stop**.

---

## 9. Security: purely local, no holes

### 9.1 Threats and controls

| Threat | Controls |
|---|---|
| **Data leaves your Mac** | No network code. Every request that isn't to a local app file is blocked. Strict Content Security Policy. Bundled fonts. No auto-updater, no crash-report upload (crash dumps stay local). A lint rule bans `http`, `https`, `fetch` and host connections in the backend. **An automated test** tries to fetch an outside site and must be blocked |
| **A malicious repo** (you open a cloned project) | Repo files are **only parsed, never run**: YAML in safe mode with no custom tags, strict JSON. Markdown is shown as text, with no raw HTML. Check commands are never read from the repo. Names and paths are validated. A symlinked `.claude` pointing outside the folder is **refused** |
| **Writing to the wrong place** | Every write goes through `pathGuard`: real path + allowlist (`<folder>/.claude/**`, `.mcp.json`, `.git/info/exclude`, `~/.claude/agents/*.md` after confirmation, app data). No writes through symlinks. Agent names must match `^[a-z0-9][a-z0-9-]{0,63}$` (no `../`). Files are written to a temp file and renamed, after a backup |
| **Command injection** | Every child process uses `spawn(file, args[], {shell:false})`. Check commands are split into arguments and never run through a shell. Hook command strings are built only from validated absolute paths (no quotes, `$` or backticks) |
| **Fake events sent to the socket** | The socket lives in a folder only you can open (`0700`), and the socket itself is `0600`. macOS limits socket paths to 104 characters; yours is 67 (`~/Library/Application Support/Crewglass/crewglass.sock`). If a path would ever be too long, the app falls back to your private temp folder (`$TMPDIR`, also only yours). Messages are limited to 64 KB, checked against a schema and rate-limited. Decisions (stop, pause) come only from the app's own state and your clicks, never from what an event says |
| **The UI gets hijacked** (e.g. by a hostile file name) | React escaping, no `dangerouslySetInnerHTML`, no inline scripts, sandboxed renderer, `contextIsolation`, `nodeIntegration: false`, no navigating away and no new windows. The preload script exposes a narrow typed API, and every message is checked for sender and schema (`zod`) |
| **Secrets** | Token and key files are never read. Env values are never shown. The **secret guard** blocks keys from shared files and offers a one-click `${VAR}` fix. It looks for:
  - known key formats **at their real lengths** (e.g. `sk-ant-…`, `sk-` + 20 or more characters, `ghp_`/`github_pat_`, `xox[bp]-`, `AKIA` + 16, `AIza` + 35), so ordinary words like "sk-learn" don't trigger it;
  - private-key blocks;
  - `key`/`token`/`secret`/`password` followed by a long value;
  - long random-looking strings.

  `${VAR}` references are always allowed. **Your home-folder path is never written into a shared file.** Logs contain no event text |
| **Supply chain** | Few dependencies, exact versions and a lockfile, `npm ci`, `npm audit` and install-script review in `npm run check`, no telemetry packages. Building downloads open-source packages once; **the running app never goes online** |
| **The Electron runtime is misused** | Electron fuses: RunAsNode **off**, NODE_OPTIONS **off**, the inspector CLI **off**, asar integrity **on**, load only from the app bundle **on**. That's possible because the hook helper is a separate Swift program. The app data folder is `0700` |
| **Safeguards harm Claude** | The helper allows everything if the app is absent or slow. On `SessionStart` it prints at most a notice for you (never context for Claude); on your own prompts, nothing. Hard timeouts. Retry caps and `stop_hook_active` prevent loops |

### 9.2 How it's checked

- **Every phase:**
  - `/security-review` on that phase's code;
  - `npm audit`;
  - the Electron security checklist;
  - unit tests for `pathGuard`, the secret guard, the socket-message schemas and the IPC schemas;
  - socket fuzzing with random data;
  - the network-block test;
  - `lsof -i -a -p <pid>` shows **no network connections**;
  - a unique phrase typed into a prompt is **not found** anywhere under the app's data or logs.
- **Phase 6:** a full review written up in `docs/security.md`.
- **One honest limit:** Claude Code (and agy, when used) still sends prompts to Anthropic (and Google), as it does today. Crewglass adds no new data flow.

---

## 10. Saving changes

Every save follows the same sequence:
1. **Review changes:** the plain-English list.
2. **Diff:** every file that will change.
3. **Secret guard:** a match blocks that file and offers the `${VAR}` fix.
4. **Backup:** to `…/Crewglass/backups/<folder>/<time>/`, kept 30 days.
5. **Safe write:** a temp file, then rename.
6. **Changed on disk?** If you, Claude or `/agents` changed a file since the app loaded it, you choose to reload or overwrite.
7. **Claude picks it up on its next turn.** Phase 0a showed agents, settings and hooks reload live, so no restart is needed. For the team-map rules file, the app watches the `InstructionsLoaded` event to confirm Claude loaded it.

**What gets written:**

| Change | File |
|---|---|
| Agent created or edited | New agents: `.claude/agents/<name>.md` or `~/.claude/agents/<name>.md`. Existing agents stay in the file they came from, which matters for same-name agents |
| Orchestrator | `settings.local.json` → `agent` |
| Team map, hand-offs, direct-call rules (link states, the `Reason:` protocol, costly thresholds) | `.claude/rules/crewglass-team.md` + `.claude/commands/workflow.md` (`/workflow <task>`) |
| An agent gets or loses outgoing links | Its `tools:` gains or loses `Agent` (only when it uses "Only what I connect") |
| Disable an agent | `settings.local.json` → `permissions.deny` |
| Project MCP server | `.mcp.json` (written directly; a documented format) |
| Local or user MCP server | Official `claude mcp add\|remove --scope local\|user`; `~/.claude.json` is never hand-edited |
| MCP enable or disable | `settings.local.json` → `enabled`/`disabledMcpjsonServers` |
| Live mode (one helper for all events) | `settings.local.json` → `hooks`, written once |
| Check commands, limits, layout | The app's private data only |

**Uninstall** (menu: *Crewglass → Uninstall…*) shows a checklist first, then:
1. Removes Crewglass's hook entries from **every folder on its list**. This step is always included.
2. Optionally removes the orchestrator setting and the "disable agent" rules it added.
3. **Keeps your agent files, `.mcp.json` and the team map.** They're yours, and you can delete them yourself.
4. Unregisters the private agy bridge.
5. Deletes `~/Library/Application Support/Crewglass/` and `~/Library/Logs/Crewglass/`.

Then you drag the app to the Trash.

---

## 11. Code layout, tools, commands

```
package.json · electron.vite.config.ts · electron-builder.yml (fuses) · tsconfig*.json · vitest.config.ts · eslint.config.js
src/shared/       types.ts · ipc.ts (typed channels + zod) · models.ts (friendly names, effort levels)
src/main/
  index.ts          window, menu bar, login item, single instance, notifications
  privacy.ts        request blocking, CSP, field whitelists
  scope.ts          folder + session inclusion (§3.1)
  pathGuard.ts      write allowlist, symlink refusal, secret guard, home-path guard
  sources/          claudeSessions · ideLocks · transcripts (tail + dedupe) · backfill.worker · hookSocket (request/response)
                    mcpConfigs · agentFiles · settingsFiles · processes · agyDetect
  model/            ingest (disk vs memory) · graphBuilder · metrics · models · conformance · alerts
  formatWatch.ts    known-field schemas per source → unknown/missing field report (names only) for the bottom-left box
  buildInfo.ts      the source-repo path and Claude Code version tested, written in at build time (§13.1)
  safeguards/       budgets · breaker (command signatures, pause state, your choices) · stopControl · decisions (the per-event answers in §4.2)
  checks/           runner (spawn, timeout, trim, mask) · verdicts
  writers/          agentWriter · settingsWriter · teamMapWriter · mcpWriter · hookInstaller · backups · atomicWrite
  pipeline/runner.ts
  db.ts             node:sqlite (numbers, layouts, drafts, limits, checks, hook-folder list)
src/preload/index.ts
src/renderer/       App.tsx · stores/ · components/ Onboarding, TopBar, Library, Canvas (@xyflow/react), cards/, links/,
                    Details, LiveStrip, UsageTab (uPlot), ActivityTab, HistoryTab, AttentionInbox, ReviewChanges, DiffDialog,
                    RunDialog, Legend, FormatNotice (bottom-left box), Settings · mock/ (fake data source for the prototype and tests)
hook/               main.swift (crewglass-hook: one helper for all events; asks the app, prints only what the answer requires) · build.sh (swiftc -O)
resources/          agy-bridge/server.js · templates/roles/*.md · templates/teams/*.json · models.json
scripts/probe.ts · docs/data-sources.md · docs/security.md · test/ (+ fixtures with all text removed)
```

- **Libraries:**
  - `electron`, `electron-vite`, `react`, `typescript`
  - `@xyflow/react`, `elkjs`, `zustand`, `chokidar`, `yaml`, `zod`, `uplot`
  - `vitest`, `eslint`, `electron-builder`, `vite-plugin-singlefile` (prototype only)
  - No native Node modules. Storage uses Electron's built-in `node:sqlite`; if Phase 0a finds it missing, the fallback is `sql.js` (pure WebAssembly, still nothing to compile).
- **Commands:**
  - `npm install` (once)
  - `npm run prototype`: builds the UI with fake data into one local HTML file and opens it in your browser (no server, no network). It uses the same React components as the real app, so the approved design carries straight over. Its scripts are inlined so it works from a file; the real app keeps scripts in separate files under a strict CSP
  - `npm run dev`
  - `npm test`
  - `npm run check`: lint, audit, security tests
  - `npm run dist` → `release/Crewglass.app` → drag it to `/Applications`. **After that the repo isn't needed.**
- **Performance targets:**
  - under 1% CPU when idle, and under 5% while Claude is busy;
  - under 300 MB of memory;
  - under 10 ms added per hook;
  - a guard answer in under 50 ms;
  - at most 10 UI updates a second.

---

## 12. Build phases (I stop after each one for your review, and ask before any commit)

| Phase | What you get | Done when |
|---|---|---|
| **0a. Check the data sources** ✅ done | `scripts/probe.ts`, `scripts/probe-live/`, `docs/data-sources.md` (31 items; findings folded into this plan) | I've shown you the findings and we've adjusted the plan where needed |
| **0b. Clickable prototype** ✅ done (approved) | The real React UI running on **fake data** as a local HTML file: first-run wizard, Library drag and drop, model chips, orchestrator, checks, live animation, Attention inbox with the failing-command choice, Review changes → diff, the unknown-fields box, same-name agent cards, subagent-to-subagent link states + the approval card | You've clicked through it and approved the design, or we've iterated |
| **1. Read-only monitor** ✅ done | Electron shell with real data in the approved UI: folder rules, transcript reader + backfill, models everywhere, skills chips, Usage, Activity and History, the inbox, alerts that need no hooks, the **unknown-fields box** | A VS Code session and a terminal session in your folder both appear with the right model and effort; another folder never appears; token counts match `/context`; a test file with a made-up field shows the blue box with this repo's path |
| **2. Live mode + safeguards** ✅ done | Swift hook helper, socket, permission alerts, **Stop**, the **failing-command breaker** with your 4 choices, limit warnings | Stop halts Claude within seconds; a command that keeps failing is paused on the 3rd failure and each choice works; quitting the app never blocks Claude |
| **3. Designer** ✅ done | Library, drag and drop, presets, cards, orchestrator, models and effort, MCP add/remove/enable, Review changes → diff → secret guard → backup → write, Undo, **direct-call approvals** (link states, reason check, approval card, orchestrator grants and requests, limits) | The new team shows up in `/agents`; a new VS Code session runs as the orchestrator with the right model; a planted fake key is blocked; a subagent's direct call without `Reason:` is refused; a costly call pops up for approval, and after 2 min unanswered goes to the orchestrator |
| **4. agy agents + inherited MCPs** ✅ done | Bundled bridge, Haiku relay agents, Gemini model chips, agy model reporting | "Have gemini-reviewer check this" shows **agy · Gemini 3.1 Pro** live; standalone Gemini or agy sessions never appear |
| **5. Checks + Run pipeline** ✅ done | Command checks with send-back-to-fix (2 tries, only when files changed), verdict checks, ✓/✗ on links, the orchestrator report, the pipeline runner | A failing `npm test` sends coder back twice, then the orchestrator and you are told; a 3-step pipeline runs in order |
| **6. Package + harden** ✅ done | `Crewglass.app` (built and signed on your Mac, so it opens normally), fuses, launch at login, Settings, ⌘N windows, **Uninstall** (hooks removed from every folder on the list), `docs/security.md` | It runs from `/Applications` with this repo closed; the full security checklist passes |

**Phase 0a checklist.** Each item gets a yes/no answer with evidence:
- the payload fields per hook event;
- where subagent transcripts live, and the `message.id` split;
- how teammates and background sessions link to their lead;
- how headless `claude -p` runs and other Agent SDK apps are labeled (`kind` / `entrypoint`), so the first are shown and the second are excluded;
- whether subagents can start other subagents (nesting), which confirms the hand-off model in §6.1;
- whether `continue: false` from a subagent's event stops only that subagent or the whole session;
- the `cwd` in hook events for agents working in a git worktree (for §6.4);
- every session `status` value;
- whether `settings.local.json` hooks and the `agent` setting apply in subfolders and in VS Code sessions;
- `continue: false` stop timing in VS Code and the terminal;
- that a deny reason reaches Claude;
- `additionalContext` on `PostToolUse` of the `Agent` tool;
- `SubagentStop` `block` + `stop_hook_active`;
- how a failed Bash command shows up (`PostToolUseFailure` or `is_error`);
- the `mcp__server__*` form in `tools:`;
- the `mcpServers` field format;
- the `Agent(<name>)` deny rule;
- which copy wins when two agents share a name (project vs user, and two files in one folder);
- whether a running session picks up agent and settings changes live (`ConfigChange`), which would remove the "restart Claude" step;
- which events honor `continue: false`, for the fastest Stop;
- how skill use shows up (the `Skill` tool and its input fields), for the skills chips;
- `.claude/rules/` loading automatically;
- `xhigh` in subagent `effort`;
- `claude -p --agent` with `stream-json`;
- context window sizes;
- `node:sqlite` in Electron;
- the Swift helper's speed.

---

### Phase 1 findings (folded into the code)

- **Process names:** `ps -o comm` can include a program's arguments (a Node server showed `npm exec @modelcontextprotocol/server-pdf --stdio`). Crewglass uses `ucomm`, which is only the program's name.
- **Notifications:** macOS keeps notification history on disk, so pop-ups never contain commands, paths or other text from your work; the detail stays in the in-memory inbox.
- **Memory:** about 470 MB across Electron's four processes (Electron alone is ~250–300 MB). Turning GPU acceleration off made it worse (560 MB). The 300 MB target is carried to Phase 6.
- **Environment:** VS Code's extension environment sets `ELECTRON_RUN_AS_NODE=1`; the npm scripts clear it so Electron starts as an app.
- **Stop** stays disabled until Live mode (Phase 2), with a tooltip saying so. Editing shows "This version only watches" until Phase 3.

### Phase 2 findings (verified with real Claude Code runs)

- **Breaker:** `false` run up to 5 times → exactly 3 ran; the 4th was denied with Crewglass's reason and Claude stopped retrying.
- **Stop:** pressed at the 2nd tool call → that call was denied, nothing else ran, Claude ended within ~8 s of starting.
- **App closed, hooks installed:** Claude ran normally (the helper allows everything in ~3 ms when the app is absent).
- **Turning Live mode off:** `settings.local.json` restored byte-for-byte; git never saw the file.
- **Headless runs:** a `claude -p` run can have a session file after all; if it doesn't, Live mode's hook events still show it as "Terminal · headless" (and Stop reaches it).
- **Helper:** first launch after a build is slowed by macOS scanning the new program (~50–600 ms); afterwards ~3.5 ms.
- **Test-only switches** (`--live=on|off`, `--dump=<file>`, `CREWGLASS_TEST_STOP_AFTER_TOOLS`) work only with `CREWGLASS_TEST=1`.

### Phase 3 findings (verified with real Claude Code runs, Haiku, throwaway folder)

- **Saved team = Claude's team:** after Save, a new `claude -p` session listed `lead`, `coder`, `tester`, `architect` as its agents and ran on **Haiku 4.5**, the orchestrator's model (from the `agent` setting).
- **Secret guard:** a planted `ghp_…` key in a shared agent file blocked the save; the file on disk was unchanged.
- **Subagents follow the `Reason:` rule on their own:** with the team map loaded, `coder` added `Reason: …` to its call without being told. With the map hidden, the call had no reason and was refused with *"the first line of your request must be `Reason: …`"*; `coder` then retried with a reason.
- **Costly call:** `coder` → `architect` (Opus 5.5 · high) waited exactly as long as the approval window, then was refused with *"REQUEST architect: …"* for the orchestrator. `architect` never ran. The pop-up said only "coder wants to call architect" (no work text). Seen live in the real app's inbox with the countdown and all four choices.
- **App closed:** the helper answered a subagent's direct call with Claude Code's own permission prompt (`ask`); in `claude -p` nobody can answer, so it was refused. The same happened when the app quit **while** a call was waiting for approval. How the prompt looks in a VS Code session is still to check with you.
- **Main session events carry the orchestrator's name:** with the `agent` setting, hook events from the main session report `agent_type: "lead"` but no `agent_id`, so "is this a subagent?" is decided by `agent_id` only.
- **Fixed during review:** new agent files are now written with a real YAML writer (a role like "Use when: reviewing" produced invalid YAML, and a line break could add a field); MCP names, addresses and variable names are checked before they reach `claude mcp add/remove`; removing a project MCP server no longer runs `claude mcp remove --scope local`; temp files can't follow a planted link; the team map's data survives a `-->` in a label; in a real folder a team preset only adds (it used to swap in the prototype's sample team).
- **Test-only switch:** `CREWGLASS_TEST_APPROVAL_MS` shortens the 2-minute approval window (needs `CREWGLASS_TEST=1` in the app).

### Phase 4 findings (verified with real Claude Code + real agy, Haiku relay, Gemini 3.1 Pro · low)

- **The whole chain works:** "Have gemini-reviewer check this" → `lead` → `gemini-reviewer` (Haiku relay) → Crewglass's bridge → `agy -p … --sandbox --model gemini-3.1-pro-low` → Gemini. The card showed **agy · Gemini 3.1 Pro · low** while running and after, with **13.9k Gemini tokens** counted apart from Claude's (5.3k for the relay).
- **agy's JSON output has no model name** (only status, answer, duration and token usage), so the bridge reports the model it asked for; it always passes one.
- **The bridge has no dependencies** (it speaks MCP itself), never contacts anything, writes nothing, and adds one numbers-only report line to each answer. Crewglass reads only the **last** such line, so an answer that contains a look-alike line can't fake it.
- **A Haiku relay can skip agy:** in one run the relay answered a trivial question itself (15 s, no agy call) and the answer looked like Gemini's. The relay's instructions are now stricter, and Crewglass flags any relay run that ends without an agy call ("answered without asking Gemini") in the inbox.
- **Standalone agy never appears:** processes are only listed under the folder's Claude sessions, transcripts are only Claude's, and `~/.gemini` is never read.
- **"Keep private" is now read back** from `.git/info/exclude` (it was lost after a save), and turning it off removes only the lines Crewglass added.
- **Registration is cleaned up by the test:** after each run, `claude mcp remove --scope local crewglass-agy` and the throwaway folder's transcripts are removed; `~/.claude.json` keeps Claude Code's own entry for the folder (Crewglass never hand-edits that file).
- **Still to check with you:** the first time an agy agent runs in a VS Code session, Claude Code asks you to allow the bridge's tool (`mcp__crewglass-agy__ask_agy`); "always allow" there is your choice.

### Phase 5 findings (verified with real Claude Code runs, Haiku, throwaway folder)

- **Send back to fix works:** with an `npm test` that always fails, `coder` was sent back **twice** with the failure (`decision: block` on `SubagentStop`, the test's last lines included), then you got an inbox card + pop-up and the orchestrator was told — it repeated Crewglass's words: *"coder FAILED `npm test` failed (exit code 1) after 2 fix rounds"*. The hand-off link showed **✗ 2/2**.
- **An agent can run out of turns while fixing:** then Claude Code sends **no** `SubagentStop`. Crewglass now treats the end of the orchestrator's Agent call (or a background agent's task notification) as the end of that run, so you and the orchestrator are still told ("… after 1 fix round (it ran out of turns while fixing)").
- **The pipeline runs in order:** planner → reviewer → planner, each a separate `claude -p --agent … --permission-mode plan` run given the previous step's answer; each ran on Haiku 4.5 (from its agent file); live progress, tokens and output in the app; Stop ends the step's whole process group.
- **Checks can take minutes:** Live mode's `Stop`/`SubagentStop` entries now allow 6 minutes, and the helper waits exactly as long as Crewglass says (`{"wait":true,"ms":…}`). Existing installs are updated through Review changes (shown in the diff), never silently.
- **Check commands are yours, confirmed once:** only commands you confirmed in Review changes run, stored in Crewglass's private data (never the repo). Built-in checks always use Crewglass's own command text. Commands run without a shell, and npm/npx are kept **offline** (`npm_config_offline`), so a check like `npx tsc` can never download a package on its own.
- **Session files have a new `agent` field** (a session running as an agent, e.g. `--agent` or your orchestrator): it showed up in the "Unknown fields" box during a pipeline run — the box worked as designed. It's now known and used to show which agent a session runs as.
- **Agent files that aren't strict YAML** (e.g. `description: Orchestrator: plans…`) are read by Claude Code anyway; Crewglass now reads them the same forgiving way (they were missing from the canvas), shows a hint, and rewrites the header properly if you save that agent.
- **Test-only switch:** `--run-pipeline=<spec.json>` (needs `CREWGLASS_TEST=1`) starts a pipeline at launch, for screenshots.

### Phase 6 findings (packaged app, checked on this Mac)

- **`npm run dist`** builds `release/mac-arm64/Crewglass.app` with electron-builder from the Electron already in `node_modules` (no download), signs it ad hoc, and runs `scripts/verify-dist.mjs`: fuses (RunAsNode, `NODE_OPTIONS`, `--inspect` off; asar integrity and asar-only on), signature, the asar hash in Info.plist, only `out/` inside (every library is bundled — **no `node_modules` ships**), no source maps, Electron's demo app removed, helper and bridge bundled — **12/12**.
- **Runs without the repo:** installed to `/Applications/Crewglass.app` (signature intact), launched from there with the repo closed: helper and bridge set up in `~/Library/Application Support/Crewglass/` (folder `0700`), registered as a login item, **0 network sockets**.
- **Privacy checks on the packaged app:** in-window `fetch`/image/WebSocket/`window.open` to an outside site all blocked; the page has no Node and only its 26 API calls; `lsof` shows **0 network sockets**; a canary phrase typed into a real Claude prompt was found **nowhere** in Crewglass's data (and there's no log folder).
- **Uninstall** (real code path): the folder's `settings.local.json` restored byte for byte, Crewglass's data deleted. It also finds its hooks in recent/open folders not on its list.
- **Several windows:** each open folder is a workspace (a watcher plus an optional window); hook events go to the most specific folder that contains them. Closing a window frees its memory while the folder stays watched.
- **Memory:** ~335 MB with no window open (watching two folders, one of them this repo with a very large 30-day history; main process 167 MB), ~480 MB with one window, ~730 MB with two. The 300 MB target isn't met: Electron's own GPU/network/helper processes account for most of the difference.
- **New Claude Code formats seen on this Mac** (the "Unknown fields" box caught them): session kind `bg` (background `claude --bg` sessions, now shown like background sessions), session fields `jobId` and `formerNames`, transcript entries `mode`, `permission-mode` and `agent-name` (recognized and ignored).
- **Tightened:** test-only switches (`--capture`, `--dump`, `--live`, `--run-pipeline`, `--selftest`, `--uninstall`, `--hidden`) and data/path overrides work only with `CREWGLASS_TEST=1`; launch at login is only registered by the installed app. `npm audit`: 0 vulnerabilities. Socket fuzzing added to the tests.
- **Security review:** [docs/security.md](security.md).

### Orchestrator model and effort (checked on Claude Code 2.1.283, one-word Sonnet/Haiku replies in a throwaway folder)

- The orchestrator's `model:` is used by chats that run as it — it wins over a `model` in the folder's settings. A model picked for the chat itself (`/model`, `--model`) wins over the orchestrator's.
- Its `effort:` is **ignored** for that chat (set to low, ran at high: your own effort setting). The folder's `effortLevel` works (medium → medium), and an effort picked in the chat still wins over it. `effortLevel` can't hold max (ignored). The `CLAUDE_CODE_EFFORT_LEVEL` variable would work but overrides even your in-chat choice, so Crewglass doesn't use it.
- So Save writes the orchestrator's effort to `effortLevel` (max → xhigh, with a note in Review changes), and removes it when the orchestrator is paused or removed (Uninstall's optional step too).
- The orchestrator card shows **chat now: …** (amber) when the chat running as it is on a different model or effort; other agents show **last run: …** when their last run differed. (The warning was computed before but never drawn.)
- The session list said "runs as lead" for chats opened before the orchestrator was set; it now uses what each chat itself records.
- **Start-of-chat notice** (Live mode): SessionStart's `agent_type` names the agent a chat runs as. Crewglass answers with a `systemMessage` — recorded by Claude Code as a `hook_system_message` for you, and Claude answered "NONE" when asked to quote it, so it adds nothing to its context. E.g. *Crewglass: this chat runs as lead · starts on Opus 5.5 · high · hands work to planner, coder, reviewer*; a plain chat in a folder with a team says so and suggests `/workflow`. Settings → General can turn it off.

### The chat leads by default (D20)

- One **Claude Code chat** card replaces the per-session cards. It leads the team unless an agent is the orchestrator; drawing from it makes a hand-off, and it can't receive links or MCP servers (the chat already has every server Claude Code has).
- Team presets add only the role agents, with hand-offs from the chat. **Make orchestrator** moves the chat's hand-offs to the agent (dropping its own, never making a loop or a duplicate); **Let the chat lead** moves them back.
- The team map says *"Orchestrator: your Claude Code chat … answer quick questions yourself"* and *"Your Claude Code chat hands work to: …"*; its data names the chat `@chat`. A map saved earlier with a paused orchestrator reads as the chat leading, and the former orchestrator shows as a regular agent.
- A chat's own activity is drawn from the agent it runs as (e.g. a `claude --agent coder` chat, or a pipeline step), else the orchestrator, else the chat card. The orchestrator is only ever the `agent` setting — no longer guessed from what a chat ran as.
- **Double border** on an agent card = an open Claude Code chat runs as that agent (Claude runs agents by name, so only the copy it uses). A plain chat marks no agent.
- The start-of-chat note for a chat-led folder: *Crewglass: this chat leads your team · hands work to coder, reviewer · /workflow <task> runs the full team steps*.

### Token counting and new models (Claude Code 2.1.284)

- **Checked against the transcripts:** the app's totals matched an independent count exactly (this folder: 8,804,104 for the long chat, 423,542 "today"), with no message counted twice across files.
- **Why it looked inflated:** "tokens" included cache writes. In a long chat Claude re-saves the whole conversation whenever its cache expires, so one message after a break "cost" ~400k: today's 423k was ~410k cache writes and 13.7k of real input + output. Tokens are now **input + output** (Claude Code's `/cost` lists Input, Output, Cache read and Cache write separately); cache writes and reads show in the Usage tab as "Not counted".
- **A real bug:** the "today" counters (folder, agents, agy) were never reset at midnight — the app runs for days, so "Today" kept every day since it started. They now start again at each midnight.
- **Limits:** saved limits were set for the old count (e.g. 10M/day) and would never warn; they're reset once to **1M per session, 1.5M per day** (your heaviest day so far was ~675k input + output), with a note in the inbox.
- **Models:** Sonnet 5.5 (`claude-sonnet-5-5`) is now `sonnet` in Claude Code, so an agent set to `sonnet` isn't flagged when it runs on 5.5. Opus 5, Sonnet 5, Fable 5, Mythos 5/5.1 and Opus/Sonnet 4.x are named correctly. Calls to Fable/Mythos at high effort need your OK like Opus. The usage chart shows every model (earlier ones folded into "Earlier models") — before, only a fixed list was charted.
- An agent card with a chat running as it adds that chat's **today** tokens (it added the chat's whole total).

### Final review and completion (after Phase 6)

**Review fixes** (committed separately): planted-link temp files (Live mode, Uninstall), links in `.git/info/exclude`, git fsmonitor, Run pipeline limited to folders trusted in Claude Code, the first-run wizard (its folder and limits were reset every second, presets were locked), stale folder data on switch, ⌘. without Live mode, MCP approvals from `~/.claude.json`, early transcript lines, hook answers during big reads, Uninstall writes after it started, and smaller items.

**The remaining plan items, now built:**
- "Claude may be stuck" (5+ failed tool calls in 10 min), subagent loop (identical task 3+ times in a turn, compared by a one-way hash), MCP server died (its calls fail with "connection closed"; the card shows *Failing*), limit reminders every +25% past 100% — all inbox-only; with Live mode they offer the orchestrator / instructions / Stop.
- Checks on hand-off links (`folders/*.json` → `linkChecks`, by agent names): they check the receiving agent's work when that caller handed it over — Live mode tracks the caller per subagent run; the pipeline uses the previous step.
- Same-name agents: **Rename this copy** / **Show the other copy** (a per-copy "disable" isn't possible — Claude Code disables agents by name).
- Pop-up grouping: the first shows at once, the rest within 10 s become one.
- Usage history kept for 90 days (30–365 in Settings) in `history/*.json` — numbers and names only.
- ⌘F (Library search), ⇧⌘Z (redo); the Edit menu now routes ⌘Z/⇧⌘Z to text or the canvas (before, the menu swallowed ⌘Z in the app).
- `npm run check` (types, tests, `scripts/check-no-network.mjs`, audit) — the scan fails on any network API, internet socket or external-URL call.
- Sharing: `npm run dmg`; tools are found in more places (Claude's local install, Volta, Bun, npm-global, nvm); the "Unknown fields" box copes when the source code isn't on the Mac.

## 13. Pitfalls: removed by design where possible

### 13.1 Claude Code updates → the "Unknown fields detected" box (D17)

Claude Code updates often, and its internal files can gain or change fields. Crewglass handles that like this:

1. **It keeps working.** Every reader in `src/main/sources/` accepts unknown fields and ignores them. Nothing crashes.
2. **A self-check on start and on every Claude Code version change.** `formatWatch.ts` compares what it sees with the known shape of each source (session files, transcripts, hook events, agent files, settings, `.mcp.json`) and records **only field names and types, never values**.
3. **The small square in the bottom-left** appears only when something is found:
   - **Blue: "Unknown fields detected (N)":** new fields, entry types or values (e.g. a new session `kind`). Nothing is affected; they're ignored.
   - **Amber: "Format changed: some numbers may be missing":** a field Crewglass relies on is missing or has a different type (e.g. `usage` renamed). That part (e.g. token counts) shows "—" rather than wrong numbers.
4. **Clicking it opens a small panel:**
   ```
   ⚠ Unknown fields detected · Claude Code 2.1.290 (Crewglass was tested with 2.1.281)
   • transcripts: new field  message.usage.reasoning_tokens (number)        → ignored
   • sessions:    new value  kind = "remote"                                → ignored
   Where to fix it (Crewglass's own source code on this Mac):
     /Users/you/projects/crewglass
       → src/main/sources/transcripts.ts
       → src/main/sources/claudeSessions.ts
   [Open in VS Code]   [Copy fix request for Claude]   [Dismiss for this version]
   ```
   - **Open in VS Code** opens *this* project (the Crewglass source repo) in VS Code at the right file.
   - **Copy fix request for Claude** copies a ready-to-paste prompt: the field names, types, the Claude Code version and the file to change (no values or content). Paste it into Claude Code inside the Crewglass repo, rebuild (`npm run dist`), done.
   - **Dismiss for this version** hides it until the next Claude Code version.
5. **Where the source path comes from:** it's written into the app at build time from the folder you build in (left empty in `npm run dmg` builds meant for sharing). If you move the repo, change it in Settings.

### 13.2 Pitfalls removed by design (you should never see these)

| Former pitfall | How the design removes it |
|---|---|
| Restarting Claude every time a safeguard changes | The hook entries are written **once**; everything after that is switched inside the app live (§4.2) |
| Safeguards missing because the app wasn't open | **Launch at login is on** by default; the helper still fails open, so Claude is never blocked |
| Routine "fix → re-test" runs being paused | The breaker counts only **repeats with no file edits in between** (§7) |
| Too many notifications | Pop-ups only when you must act (§8); everything else goes to the inbox, with no pop-ups while the app is in front, grouping, cooldowns and Focus support |
| Same-name agents | Cards are tracked by file; both are shown; one-click fixes when needed (§6.2) |
| macOS blocking the app | You build it **on your own Mac**, so it never gets the "downloaded from the internet" quarantine flag, and it opens normally. No right-click workaround needed |
| Tokens counted twice | Counted once per `message.id`; subagent transcripts added up separately; the backfill and the live reader share file offsets |
| Look-alike folders or paths with spaces | Sessions are matched by the real `cwd` inside the files, and every path is quoted; tested with `agent app` and `Application Support` |
| Two copies of the app, or a stale socket | Single-instance lock, and the socket is cleaned up automatically on start. Invisible to you |
| Clashing with Claude writing `settings.local.json` | The app writes that file only on rare, explicit actions (Live mode on or off, orchestrator, disable an agent), re-reads it just before writing, touches only its own entries, and retries if the file changed |
| Slow with big projects | Incremental reads, a worker thread for the backfill, UI updates capped at 10 a second |
| The app slowing Claude down | The helper stops waiting after 3 slow answers in a row and allows everything for 60 s (§4.2) |
| Your next message being stopped after you pressed Stop | The Stop flag clears automatically when you send your next message |
| Checks running on every chat reply | Checks run only when that agent changed files (§6.4) |
| False "subagent loop" warnings | Only **identical** tasks count, never different tasks for the same agent (§7) |
| Permission pop-ups for prompts you already answered | Pop-up only if still waiting after 20 s (§8) |
| Socket path too long for macOS | Checked at start, with a private `$TMPDIR` fallback |

### 13.3 What remains (small, and visible when it happens)

| Remaining | What you see |
|---|---|
| A **new MCP server** added while a Claude session is running may need `/mcp` → reconnect. Agents, settings and hooks reload live (Phase 0a) | A small "Reconnect in Claude (/mcp)" note on the new MCP card, only if Claude hasn't picked it up. Nothing breaks |
| Stop acts at Claude's **next** event, so a long reply with no tool calls finishes first | The top bar shows "Stopping…" until Claude halts |
| New **project** MCP servers need your one-time approval in Claude | The card says "Approve in Claude" |
| Your Claude plan's usage limits live on Anthropic's servers | Not shown (the app never goes online); the app's own token limits cover the day-to-day need |

## 14. Working alongside Claude Code and VS Code

**Short answer: nothing you do in Claude Code or VS Code breaks the app. The app just follows along.**

| What you do | What Crewglass does |
|---|---|
| **Use skills** in Claude Code (VS Code or terminal) | Shows them live as skill chips on the agent card and in Activity ("Skill: pdf"), and counts their tokens. It never changes or blocks skills |
| Create or edit agents with `/agents`, or by editing `.claude/agents/*.md` in VS Code | The canvas updates within about a second. If you also have unsaved edits to that agent in the app, it asks which version to keep |
| Add or remove MCP servers (`claude mcp add`, `/mcp`, editing `.mcp.json`) | Picked up automatically and shown on the canvas |
| Change model or effort (`/model`, settings) | Shown live on the card (`PostModelSwitch` + transcript) |
| Edit `settings.local.json` by hand, or delete Crewglass's hooks | The app re-reads it. Live mode shows "off" with a **Turn back on** button. Your edits are never overwritten without the diff dialog |
| Edit `CLAUDE.md`, your code, or anything else | Ignored. The app only writes what you save from it |
| Work in a **different** folder | Invisible to the app, unless you switch to that folder in Crewglass |
| **Update Claude Code** | The self-check runs; if anything changed, the bottom-left box tells you (§13.1) |
| Update VS Code or the Claude extension | No effect. The app reads Claude Code's files, not VS Code's |

**The other direction:** the app only affects Claude Code through things you switched on:
- the files you save;
- Live mode safeguards (Stop, paused commands, check retries).

With Live mode off, Crewglass is purely a viewer.

## 15. Not in v1

- **Editing** skills (they are shown when used), slash-command editing (except the generated `/workflow`), permission-rule editing, `CLAUDE.md` editing.
- Plan usage limits (they live on Anthropic's servers), dollar costs.
- VS Code Remote, SSH and dev containers.
- Standalone agy or Gemini sessions, the Claude desktop app, Windows and Linux, syncing between Macs.
