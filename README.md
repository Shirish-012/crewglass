# Crewglass

**See, design and safeguard your Claude Code agent team.** A local-only macOS app: pick a folder, and Crewglass shows
what Claude Code is doing there (sessions, subagents, MCP servers, models, effort, tokens and cost) and can step in
when something goes wrong. Nothing leaves your Mac.

![Crewglass: the team canvas with live agents, links and usage](docs/images/canvas.png)

- **Watch:** every agent and subagent as a card, with its model, effort, status and what it's doing right now. Links
  show who handed work to whom. Usage is shown in **API-equivalent dollars**, which weigh cheap cache reads and costly
  cache writes honestly, plus tokens and cache traffic.
- **Safeguard (Live mode):** **Stop** Claude at its next step, **pause a command that keeps failing**, get a pop-up when
  Claude waits for your permission, run your **checks** (tests, lint) after an agent edits code and send failed work
  back to be fixed, and approve calls between agents.
- **Design:** build your team on a canvas, pick models and effort, and save it as real Claude Code files. You see the
  exact diff first, every save is backed up, and **Undo** puts it all back.
- **Private by design:** no network code (a build check enforces it), no prompt or reply text stored, and only the
  folder you choose is read. See [docs/security.md](docs/security.md).

## A tour

> Screenshots come from the built-in prototype (`npm run prototype`), which uses made-up data.

### Two modes: watch-only and Live mode

Without Live mode, Crewglass only reads, so it shows everything about a second behind and never changes a file. Live mode
adds a small hook to the folder's personal `.claude/settings.local.json`. You see the exact change before it's made, and
turning it off puts the file back byte for byte. With it on, Crewglass can **stop**, **pause** and **approve** while
Claude works.

![Turning on Live mode: the exact settings change is shown first](docs/images/live.png)

### The attention inbox

Things that need you: a command paused after failing 3 times in a row, an agent asking to call another agent (with its
reason, the model it would run on and a 2-minute timer), permission prompts, and checks that keep failing.

![The attention inbox: a paused command and an approval request](docs/images/inbox.png)

### Models and effort

The **Models** card in the Library: pick a model (Opus, Sonnet, Haiku, or Gemini through agy) and an effort level. A
hint explains each level, and the card shows the price per million tokens. From there you either apply it to the
selected agent or start a new agent with it. Every agent's panel has the same model and effort controls, plus its role,
max turns and tool access.

<table>
  <tr>
    <td><img src="docs/images/models.png" alt="The Models card: model dropdown, effort switch, price and new-agent button" width="300"></td>
    <td><img src="docs/images/agent.png" alt="An agent's details: live task, model, effort, max turns, tool access" width="300"></td>
    <td><img src="docs/images/addagent.png" alt="The Add agent dropdown with ready-made roles" width="300"></td>
  </tr>
  <tr>
    <td>Models card</td>
    <td>Agent details</td>
    <td>Add agent: ready-made roles with sensible models</td>
  </tr>
</table>

### Usage limits you can change in one click

The **Session** and **Today** meters in the top bar are in API-equivalent dollars. Click one to change the limit. You
get a warning at 80%; at 95% (Live mode) Claude is asked to wrap up and write a handoff note. Nothing is ever blocked.

![Clicking a meter opens the limits editor](docs/images/limits.png)

### Usage, cost and processes

Tokens per minute by model, tool calls (failures marked), cost per model, cache traffic, context use and the processes
Claude started.

![The usage panel](docs/images/usage.png)

### Status line and chat notice in Claude Code

With Live mode, Claude Code's own status line shows the model, context, this session's cost and today's spend against
your limit, plus a ✎ when a handoff note is waiting. Each new chat opens with a one-line notice of who leads and who
does what. The notice is shown to you only, so it costs no tokens. The image below is an illustration of the terminal.

![Claude Code's status line and the chat notice](docs/images/statusline.png)

### Run pipeline

Run your agents as fixed steps in a guaranteed order, with checks between steps and a stop if a step still fails after
2 fix rounds.

![Run pipeline](docs/images/run.png)

## Download

**[Download the latest .dmg from Releases](../../releases/latest)** (Apple Silicon Macs: M1 and later).

1. Open `Crewglass-<version>-arm64.dmg` and drag **Crewglass** onto **Applications**.
2. The first time you open it, macOS blocks it, because the app isn't signed with an Apple Developer ID. Go to
   **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. This is needed only once.
3. Pick a folder you use Claude Code in. The setup guide walks you through Live mode and limits.

**You need** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed. agy agents (Gemini as a team
member) also need agy (Google's Antigravity CLI) and Node.

### Publishing a new .dmg (maintainers)

```bash
npm install
npm run dmg     # builds, verifies and packages release/Crewglass-<version>-arm64.dmg
shasum -a 256 release/Crewglass-*-arm64.dmg   # checksum to post next to the download
```

Upload the `.dmg` to a GitHub Release (or any download page), along with its SHA-256 checksum. Builds made with
`npm run dmg` don't contain the path of the folder you built them in. The `.dmg` itself is git-ignored, so never commit it.

## Build from source

```bash
npm install          # once (downloads the build tools; the app itself never goes online)
npm run dist         # builds release/mac-arm64/Crewglass.app and checks it (fuses, signature, contents)
ditto "release/mac-arm64/Crewglass.app" "/Applications/Crewglass.app"
open "/Applications/Crewglass.app"
```

An app built on your own Mac opens with no warning. It starts at login, quietly in the menu bar, so the safeguards are
there whenever Claude runs (switch that off in Settings, ⌘,).

## Using it

- **⌘N** opens another folder in a new window. Closing a window keeps its folder watched from the menu bar ◆;
  *File → Stop Watching This Folder* ends that. **⌘F** searches the Library; **⌘Z / ⇧⌘Z** undo and redo canvas edits.
- **Settings** (⌘, or the cog): launch at login, usage limits, which pop-ups you want, the breaker threshold,
  **Delete all data**.
- **Usage limits** are per session and per folder per day, in API-equivalent dollars (what the usage would cost at
  Claude API prices, even on a subscription). You get warnings at 80% and 100%; at 95% (Live mode) Claude is asked to
  finish its step and write a handoff note. Nothing is ever blocked.
- **`/handoff` + `/pickup`** (optional, per folder): save where you are to a note and continue in a fresh, small chat,
  which costs much less than reviving a long one.
- **Status line** (with Live mode): model · context · today's spend vs your limit, at the bottom of Claude Code.
- **Uninstall** (*Crewglass → Uninstall…*): shows a checklist, then removes Live mode from every folder it touched
  (restoring each `settings.local.json` exactly), unregisters the agy bridge, deletes its data and quits. Your agent
  files, `.mcp.json` and team maps are kept. Then drag the app to the Trash.

## The designer

Add agents from the Library (role templates, models, team presets), connect them, pick models and effort, make one
the orchestrator, add MCP servers. Nothing is written until you open **Review changes**, which shows every file diff.
Then **Save** backs up the old files and writes:

- agents → `.claude/agents/<name>.md` (existing files are edited in place; unknown fields and comments are kept)
- the team map → `.claude/rules/crewglass-team.md` (Claude loads it in every session) and `/workflow`
- the orchestrator (and its effort — see below) and disabled agents → `.claude/settings.local.json` (personal, git-ignored)
- project MCP servers → `.mcp.json` with `${VAR}` references; private ones through `claude mcp add`

**Who leads:** by default your **Claude Code chat** (VS Code or terminal) leads the team — the chat card on top hands
work to your agents, and team presets never create an orchestrator agent. Type `/workflow <task>` for the full
plan → hand off → verify steps. If you **Make orchestrator** on an agent instead, every *new* chat in the folder runs
as it, starting on its model and effort (an open chat keeps running as it was); **Let the chat lead** goes back. The
agent an open chat runs as has a **double border**. What you type always goes straight to the chat. A model or effort you pick
in the chat (`/model`) still wins for that chat, and the orchestrator card shows **chat now: …** when they differ.
Claude Code can't start a chat at max effort, so an orchestrator set to max starts chats at xhigh.

The **secret guard** blocks saving anything that looks like a key into a file shared through git. **Undo last save**
puts every file back. A team preset only adds what's missing; it never removes your agents.

**Direct calls between agents** (Live mode): a subagent calling another agent must give a `Reason:` line. Links you
drew as *Allowed* go straight through; the orchestrator's `Allowed calls:` grants too. Calls to costly agents (Opus at
high effort or above, agy/Gemini) wait up to 2 minutes for your OK in the 🔔 inbox, then go to the orchestrator.
Anything else goes to the orchestrator as a `REQUEST`. If Crewglass is closed, Claude Code asks you itself.

## Live mode

Turn it on from the panel on the right (or in the first-run wizard). Crewglass shows the exact change first: it adds
its hook to **only** that folder's `.claude/settings.local.json` (personal and git-ignored). Then:

- **Stop** (top bar, ⌘.) halts Claude at its next step; your next message clears it.
- A command that **fails 3 times in a row** with no file changes in between is **paused**, and you choose: let the
  orchestrator handle it, give instructions, allow retries, or stop.
- If Claude waits **20 s** for your permission, you get a pop-up.
- Each new chat starts with a one-line note for you — e.g. *Crewglass: this chat runs as lead · starts on Opus 5.5 ·
  high · hands work to planner, coder, reviewer*. Claude never reads it (Settings can turn it off).

If Crewglass is closed, the hook allows everything and Claude works normally. Turning Live mode off removes only
Crewglass's entries — the file goes back byte-for-byte when nothing else changed.

## Checks

Drag a check from the Library onto an agent: `npm test`, `npm run lint`, `tsc`, or your own command (one command, no
shell). With Live mode on, when that agent **changed files** and finishes, Crewglass runs its checks in the folder.
A failure sends the agent back with the last lines of output — at most **2 fix rounds** — then you get an inbox card and
the orchestrator is told. Links show ✓ / ✗ fix round n/2 / ⏳. A **reviewer verdict** check is a "checked by" link: the
reviewer answers `VERDICT: PASS|FAIL`, and only that word is read.

Checks can also go **on a hand-off line** (drag a check onto the line, or use the link's panel): then they check the
receiving agent's work whenever that particular agent handed it over.

Check commands live in Crewglass's private data, never in the repo, and each new one is confirmed in Review changes
before it can run. Checks run without a shell, with a 5-minute limit, and npm/npx are kept offline. (A confirmed
`npm test` runs the project's own test script — confirm checks only in projects you trust.)

The 🔔 inbox also warns (no pop-up) when **Claude may be stuck** (5+ failed tool calls in 10 minutes), when an agent is
given the **same task 3+ times** in one turn, when an **MCP server's process dies**, and every +25% past a limit.
With Live mode on, those warnings let you hand it to the orchestrator, send instructions, or stop Claude. Pop-ups that
arrive within 10 seconds of each other are grouped into one.

**Mac notification when Claude finishes:** whenever Claude in a watched folder finishes a task and goes idle, macOS
shows "Claude finished in <folder>" (Settings: after every task, or only tasks longer than N minutes; a pipeline
notifies once when it ends). Not while a Crewglass window is in front. **Settings → Send a test notification**
checks that macOS allows them (System Settings → Notifications → Crewglass).

## Run pipeline

**Run pipeline** (top bar) runs steps in a guaranteed order: each step is one `claude -p --agent <name>` run in the
folder, given the task plus the previous step's answer, with that agent's checks in between. Steps are **read-only**
(Claude's plan mode) unless you choose "Can edit files"; "bypass permissions" is never used. Progress, tokens and output
are shown live (output can be copied, and isn't stored); **Stop** ends the running step.

## agy agents (Gemini)

Drag a Gemini model from the Library onto the canvas to make an **agy agent**: a small Haiku "relay" subagent whose only
tool is Crewglass's agy bridge. When you save, Crewglass registers the bridge **privately for that folder**
(`claude mcp add --scope local crewglass-agy …`). The bridge runs `agy -p … --sandbox` with Gemini models only, and
adds one numbers-only line to each answer so the card can show the real Gemini model, time and tokens (Google's quota,
counted apart from Claude's). agy sends the task to Google — that's agy's own data flow, not Crewglass's.

agy agents need Node (`/opt/homebrew/bin/node`) and agy (`~/.local/bin/agy`). **Refresh** in the Library runs
`agy models` once, only when you click it. More than 3 agy calls in one turn, or a relay that answers without asking
Gemini, shows up in the 🔔 inbox. Connectors (claude.ai, plugins) are signed in with `/mcp` in Claude Code; Crewglass
only shows the ones Claude uses here.

## Development

```bash
npm install          # once
npm run build        # build the app
npm start            # run it from the repo (keeps watching from the menu bar when its window is closed)
npm run dev          # development mode with live reload
```

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Unit tests (fixture folders only — never your real `~/.claude`) |
| `CREWGLASS_E2E=1 npx vitest run test/e2e.phase3.test.ts` | Opt-in checks with **real** Claude Code (Haiku, a throwaway folder; spends a few cents of tokens) |
| `CREWGLASS_E2E=1 npx vitest run test/e2e.phase4.test.ts` | Opt-in check with real Claude Code **and one real agy call** (Gemini quota) |
| `CREWGLASS_E2E=1 npx vitest run test/e2e.phase5.test.ts` | Opt-in checks with real Claude Code: a failing check sent back twice, and a 3-step pipeline (Haiku) |
| `npm run build:hook` | Rebuild the Swift hook helper and copy the agy bridge (`out/bin/crewglass-hook`, `out/bin/agy-bridge.mjs`) |
| `npm run dist` | Build `Crewglass.app` and verify it (`scripts/verify-dist.mjs`) |
| `npm run dmg` | Build the app and a shareable disk image (`release/Crewglass-<version>-arm64.dmg`) |
| `npm run check` | Type check, all tests, the no-network scan and `npm audit` |
| `npm run check:network` | Fail if any code could reach the network (`scripts/check-no-network.mjs`) |
| `npm run icon` | Redraw the app icon (`build/icon.icns`) |
| `npm run typecheck` | TypeScript check |
| `npm run prototype` | The clickable design prototype with fake data, opened in your browser |
| `npm run smoke` | Click-through test of the prototype (hidden Electron window) |
| `npm run shot` | Screenshots of the prototype into `screenshots/` |
| `node scripts/probe.ts --folder <path>` | Read-only report of Claude Code's data formats for a folder (field names only) |

## What it reads — and never reads

It reads only Claude Code's own records for the folder you pick (session status files, transcripts, agent files,
MCP config names) and the process list (program names only). It never reads `~/.gemini`, the Claude desktop app,
browser data, other folders' transcripts, or credential files. Prompt and reply text is never stored.
Details: [docs/PLAN.md §3.2](docs/PLAN.md) and [docs/data-sources.md](docs/data-sources.md).

App data lives in `~/Library/Application Support/Crewglass/` (settings, the hook helper, the socket, backups of
`settings.local.json` taken before Live mode changed it, and backups from every Save). Turn Live mode off in each
folder before deleting it.

## If Claude Code updates

A small "Unknown fields detected" box appears at the bottom-left when Claude Code's files change. It names the
fields and the file in this repo to update. Run `node scripts/probe.ts` to see the details.

## Project layout

| Path | What's there |
|---|---|
| `src/main/` | Electron main process: folder watcher (`deck.ts`), transcript reader, Live mode (`live/`), saving (`writers/`), checks, pipeline |
| `src/renderer/` | The window: React UI, canvas, state; `mock/` holds the fake data for the prototype |
| `src/preload/` | The only bridge between the window and the app (a fixed list of named calls) |
| `src/shared/` | Types, model catalog, pricing, team map and file formats used by both sides |
| `hook/main.swift` | The hook helper Claude Code runs on each event (Live mode) |
| `resources/agy-bridge/` | The MCP server behind agy agents |
| `scripts/` | Build, packaging, verification and the network scan |
| `test/` | Unit, integration and opt-in end-to-end tests |
| `docs/` | [Design plan](docs/PLAN.md), [Claude Code data sources](docs/data-sources.md), [security review](docs/security.md) |

## License

[MIT](LICENSE) © 2026 Shirish-012
