# Crewglass — security and privacy review

*Crewglass 1.0.0 · Claude Code 2.1.281 · Electron 44.4.5 · macOS (Apple Silicon)*

Crewglass is a local-only Mac app. This document says what it can do, what it will never do, how each risk is
handled, and the results of the checks run on the packaged app. Re-run them any time with the commands at the end.

## 1. In one paragraph

Crewglass **reads** Claude Code's own records for the folders you open, **writes** only the few files you review and
save (plus Live mode's hook entry in `.claude/settings.local.json`), and **runs** only three things: its own hook helper,
the official `claude` CLI (for private MCP servers and Run pipeline), and the check commands you confirmed. It makes no
network connections, keeps no prompt or reply text, and its window can't reach the internet or your files.

## 2. What it stores — and where

Everything is under `~/Library/Application Support/Crewglass/` (folder mode `0700`, files `0600`):

| What | Why | Kept |
|---|---|---|
| `settings.json` | your settings, recent folders, the folders with Live mode / the agy bridge (so Uninstall can clean them) | until you delete it |
| `history/<hash>.json` | per folder, one row per past session: when, how long, tokens, models, agent and MCP server names, failures | 90 days (30–365 in Settings) |
| `folders/<hash>.json` | per folder: which command checks each agent (and each hand-off) has, commands you typed, commands you confirmed | until you delete it |
| `backups/<hash>/<time>/` | the files as they were before each Save (for **Undo last save**) | 30 days |
| `backups/<hash>/settings.local.json.orig.json` | that folder's settings file before Live mode, so turning it off restores it byte for byte | while Live mode is on |
| `bin/crewglass-hook`, `bin/agy-bridge.mjs` | the hook helper and the agy bridge, at a path that never changes | until Uninstall |
| `crewglass.sock` | the private socket the hook helper talks to (`0600`, never a network port) | while running |

**Never stored:** prompt text, replies, thinking, tool output, file contents, the `Reason:` text of direct calls, check
output, pipeline output. Those live in memory only (inbox cards, the Run pipeline window) and vanish when you quit.
There are no log files; macOS notifications never contain text from your work (macOS keeps notification history on disk).

## 3. What leaves your Mac

**Nothing, from Crewglass.** It contains no network code, and every request from its window is refused (§5).

Things that *do* go online are the tools you already use, doing what they already do:

- **Claude Code** sends your prompts to Anthropic — unchanged by Crewglass.
- **agy** (only if you use agy agents) sends that agent's task to Google. The **Refresh** button in the Library runs
  `agy models` once, only when you click it.
- **Check commands** are your own commands (e.g. `npm test`); Crewglass keeps npm/npx **offline** while they run, so a
  check can't download a package on its own.

## 4. Threats and controls

| Threat | Controls | Checked by |
|---|---|---|
| **Data leaves the Mac** | No network code in the app — `npm run check:network` fails the build on any network API, internet socket or external-URL call. Every request that isn't a local app file is cancelled; strict Content Security Policy (`connect-src 'none'`); no auto-updater, no telemetry, no crash upload. | Network scan; network self-test in the packaged app; `lsof` shows 0 sockets; canary test |
| **A malicious repo** (a cloned project you open) | Repo files are only **parsed, never run**: YAML in safe mode (no custom tags, no aliases), strict JSON. Check commands are **never read from the repo** — only from Crewglass's private data, and only after you confirm them. (Note: a confirmed command like `npm test` runs *the project's own* test script — that's what a test is; confirm checks only in projects you trust.) **Run pipeline only runs in folders you've already trusted in Claude Code**, because `claude -p` skips Claude Code's trust prompt. Agent names validated. Every git call runs with `core.fsmonitor=false`. | `sources`, `savePlan`, `checks` tests |
| **Writing to the wrong place** | One gatekeeper (`guardPath`) for every save: real paths, an allow-list (`.claude/agents/*.md`, the team map, `/workflow`, `settings.local.json`, `.mcp.json`, `.git/info/exclude`, `~/.claude/agents/*.md` after you confirm), no `..`, **no writes through symbolic links**. Every file Crewglass writes in a project (saves, Live mode, Uninstall) goes through a temp file with a random name created fresh (`wx`), then a rename — a link planted at the temp name is never followed. Backups before every save; saving is refused if a file changed after you reviewed it. | `savePlan`, `hookInstaller` tests |
| **Command injection** | Every program is started **without a shell**, with an argument list. Check commands are split into arguments and refuse `\|`, `&&`, `;`, `>`, `<`, `$`, backticks. MCP names, addresses and variable names are validated before they reach `claude mcp add/remove` (no option-like names). The agy bridge passes the task to `agy` as one argument. The hook command is built only from validated absolute paths. | `checks`, `savePlan`, `agy` tests |
| **Fake events on the socket** | The socket file is `0600` in a `0700` folder (only you); 64 KB message limit, schema check on every field, rate limit. Decisions come only from Crewglass's state and your clicks, never from what an event claims. | Socket fuzz test (random bytes, huge lines, wrong types, floods) |
| **The window gets hijacked** (e.g. a hostile file name) | React escaping, no raw HTML, sandboxed renderer, `contextIsolation`, no Node in the page, no new windows, no navigation, no permissions, no webviews. The page gets a narrow API (26 named calls); every call checks it came from Crewglass's own page and checks its inputs. | Network self-test (page has no `require`, only the 26 calls) |
| **Secrets** | Token and key files are never read (`~/.claude.json`: only MCP names/commands and this folder's settings). The **secret guard** blocks keys from files shared through git and offers a `${VAR}` fix; MCP servers get `${VAR}` references, never values; check output has keys masked. | `guards`, `savePlan`, `checks` tests |
| **The Electron runtime is misused** | Electron **fuses** in the app binary: RunAsNode **off**, `NODE_OPTIONS` **off**, `--inspect` **off**, `app.asar` integrity **on**, load only from `app.asar` **on**. No `node_modules` or sources in the app, no source maps, Electron's demo app removed. Dev tools off in the installed app. Test-only switches (`--capture`, `--dump`, `--live`, …) and path overrides only work with `CREWGLASS_TEST=1`. | `scripts/verify-dist.mjs` (12 checks) |
| **Asking for access to your folders** | Crewglass only reads Claude Code's own files (`~/.claude…`), the folders you chose, and its own data. Sessions in other folders are rejected by their path text **without touching the disk**, so macOS never asks about Downloads, Desktop or Documents because of them. Its own source folder is only looked up when the "Unknown fields" box needs it. The one prompt you can expect: access to the folder you chose to watch, if it's inside Documents/Desktop/Downloads. | `scope` tests |
| **Writing Claude's instructions** | The 95% wrap-up note reaches Claude only after a tool step of the main chat, once a day, and never blocks. `/handoff`, `/pickup` and the usage-rules file are Crewglass's marked copies, written only through Review changes (a file you wrote is never touched); the handoff note stays out of git. The status line entry is added with Live mode, never over your own, and removed with it. | `costs` tests; real Claude Code run |
| **Build tools with advisories** | The app ships no npm packages (`verify-dist.mjs`). `npm run check` fails on any high/critical advisory except reviewed ones in `scripts/check-audit.mjs`, each with its reason. | `npm run check` |
| **Asking for your keychain password** | The cookie-encryption fuse is **off**: Crewglass has no cookies or secrets, so it never reads or writes your keychain (with it on, macOS asked for your login password to reach an "Crewglass Safe Storage" item — and again after every rebuild, since the app is signed on your Mac). | `verify-dist.mjs` checks the fuse |
| **Safeguards harm Claude** | The helper **allows everything** if Crewglass is absent or slow (3 slow answers in a row → it stops asking for 60 s) — except a subagent's direct call, which gets Claude Code's own permission prompt. At a chat's start it prints at most a one-line notice for you (a `systemMessage`, never read by Claude; anything else is dropped); for your own prompts, nothing. Retry caps (2 fix rounds, 3 direct calls, 2 levels deep). | `liveEngine`, `hookHelper` tests; real Claude Code runs (Phases 2–5) |
| **Run pipeline damage** | Read-only (Claude's plan mode) by default; "bypass permissions" can't be chosen; each step's turn limit; Stop kills the whole process group. | `pipeline` tests |
| **Uninstall leaves things behind** | Uninstall removes Live mode from every folder on its list **and** any recent/open folder where it finds its hooks, restores `settings.local.json` byte for byte, unregisters the agy bridge, deletes its data and turns off launch at login. Your agent files, `.mcp.json` and team maps are kept. | `app` test; packaged-app uninstall run |

## 5. Checks run on the packaged app (Phase 6)

| Check | Result |
|---|---|
| `scripts/verify-dist.mjs` — fuses, signature, `app.asar` hash in Info.plist, contents, helper and bridge | **12 / 12 pass** |
| `codesign --verify --deep --strict` on a copy **outside the repo** | pass — the app needs nothing from the repo |
| Network self-test inside the app: `fetch`, an image, a WebSocket, `window.open` to an outside site | **all blocked**; the page has no `require` and exactly 26 API calls |
| `lsof -i` on all Crewglass processes (2 windows; and no windows) | **0 network sockets** |
| Canary: a unique phrase typed into a real Claude prompt in a watched folder with Live mode on | **0 hits** in Crewglass's data; no log folder exists (the phrase is only in Claude Code's own transcript) |
| Uninstall via the real code path | `settings.local.json` restored **byte for byte**; data folder deleted |
| `npm audit` (build tools; the app ships no npm packages) | **0 vulnerabilities** |
| Unit tests (fixtures only, never your real `~/.claude`) | all pass (see `npm test`) |
| Opt-in real Claude Code tests, Phases 3–5 (Haiku, throwaway folders) | pass |

## 6. Honest limits

- **Signed "ad hoc", not notarized.** You build it on your own Mac, so macOS never quarantines it and it opens
  normally. Copied to another Mac, it would need your approval there (or a Developer ID signature).
- **Hardened runtime is off** (it needs a paid Apple Developer certificate to be meaningful). The fuses above cover the
  main runtime risks.
- **Anything running as you** can already read your files and talk to the socket; Crewglass doesn't try to defend
  against your own user account.
- **Check commands run your code** (your tests) with your permissions — that's their point. Only commands you
  confirmed ever run.
- **The team map is instructions for Claude,** written from your own text (roles, check names).
- **Memory:** about 335 MB while watching with no window open (two folders), ~480 MB with one window — above the
  300 MB target, mostly Electron's own processes.

## 7. Re-running the checks

```bash
npm run check                              # types, unit tests (incl. socket fuzzing), the no-network scan, npm audit
npm run dist                               # builds release/mac-arm64/Crewglass.app and runs scripts/verify-dist.mjs
# Network self-test and screenshots (test-only switches; a throwaway data folder):
CREWGLASS_TEST=1 CREWGLASS_USER_DATA=/tmp/ad-test "release/mac-arm64/Crewglass.app/Contents/MacOS/Crewglass" \
  --folder="$PWD" --selftest=/tmp/ad-selftest.json --capture=/tmp/ad.png --capture-delay=8000
# Real Claude Code (spends a few cents of Haiku tokens; the Phase 4 one also makes one agy call):
CREWGLASS_E2E=1 npx vitest run test/e2e.phase3.test.ts test/e2e.phase5.test.ts
```
