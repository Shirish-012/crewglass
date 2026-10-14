// scripts/smoke.mjs — click through the built prototype in a hidden Electron window and check that the
// main interactions really work (not just that screens render). Prints PASS/FAIL per step.
//
// Run:  npm run prototype:build && npx electron scripts/smoke.mjs   (unset ELECTRON_RUN_AS_NODE first if set)

import { app, BrowserWindow, session } from "electron";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(join(root, "prototype/dist/index.html")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: helpers to find and click things by their visible text.
const HELPERS = `
  window.__byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(text));
  window.__click = (sel, text) => { const el = __byText(sel, text); if (!el) return false; el.click(); return true; };
  true;
`;

// Throwaway profile in the temp folder, so test runs leave nothing in ~/Library and share no state between runs.
app.setPath("userData", join(tmpdir(), `crewglass-test-${process.pid}`));
const PARTITION = "crewglass-test"; // no "persist:" prefix → storage lives in memory only

app.whenReady().then(async () => {
  let blocked = 0;
  session.fromPartition(PARTITION).webRequest.onBeforeRequest((d, cb) => {
    const ok = d.url.startsWith("file://") || d.url.startsWith("data:") || d.url.startsWith("devtools://");
    if (!ok) blocked++;
    cb({ cancel: !ok });
  });
  const errors = [];
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: PARTITION } });
  win.webContents.on("console-message", (e) => { if (e.level === "error") errors.push(e.message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const check = async (name, code) => {
    let ok = false;
    try { ok = !!(await js(code)); } catch (err) { errors.push(`${name}: ${err.message}`); }
    results.push([ok, name]);
  };

  // 1. First-run wizard end to end.
  await win.loadURL(`${page}?smoke=1`);
  await sleep(800);
  await js(HELPERS);
  await check("wizard: Continue is disabled until a folder is chosen", `__byText("button", "Continue").disabled`);
  await js(`__click("button", "agent-app")`); await sleep(100);
  await js(`__click("button", "Continue")`); await sleep(100);
  await check("wizard: step 2 shows the Live mode hooks preview", `document.body.innerText.includes("settings.local.json")`);
  await js(`__click("button", "Continue")`); await sleep(100);
  await js(`__click("button", "Continue")`); await sleep(100);
  await js(`__click("button", "Finish")`); await sleep(900);
  await check("wizard: preset creates pending changes (Review changes shows a count)", `/Review changes \\(\\d+\\)/.test(document.body.innerText)`);
  await check("canvas: team cards are on the canvas", `document.querySelectorAll(".react-flow__node").length >= 5`);

  // 2. Review and save, then undo the save.
  await js(`__click("button", "Review changes")`); await sleep(300);
  await check("review: diff lists .claude/agents files", `document.body.innerText.includes(".claude/agents/")`);
  await js(`__click("button", "Save ")`); await sleep(300);
  await check("save: pending count cleared", `!/Review changes \\(\\d+\\)/.test(document.body.innerText)`);
  await check("save: 'Undo last save' appears", `!!__byText("button", "Undo last save")`);

  // 3. Select an agent and change its effort → becomes a pending change.
  await js(`[...document.querySelectorAll(".react-flow__node")].find((n) => n.innerText.startsWith("coder"))?.click()`); await sleep(300);
  await check("details: coder selected", `document.querySelector(".details h2")?.textContent === "coder"`);
  await js(`__click(".details .seg button", "xhigh")`); await sleep(300);
  await check("edit: effort change becomes pending (agent file + team map)", `/Review changes \\(2\\)/.test(document.body.innerText)`);
  await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }))`); await sleep(300);
  await check("undo: ⌘Z removes the pending change", `!/Review changes \\(\\d+\\)/.test(document.body.innerText)`);

  // 3b. Drag and drop (real DragEvents with a DataTransfer, like a mouse drag from the Library).
  await js(`window.__drop = (payload, x, y) => {
    const dt = new DataTransfer(); dt.setData("application/x-crewglass", JSON.stringify(payload));
    const wrap = document.querySelector(".canvas-wrap");
    for (const type of ["dragover", "drop"]) wrap.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }; true`);
  await js(`(() => { const n = [...document.querySelectorAll(".react-flow__node")].find((n) => n.innerText.startsWith("coder")); const r = n.getBoundingClientRect();
    __drop({ t: "model", model: "claude-sonnet-5", effort: "high" }, r.x + r.width / 2, r.y + r.height / 2); })()`); await sleep(400);
  await check("drag: dropping Sonnet 5 · high onto coder sets its model", `[...document.querySelectorAll(".react-flow__node")].find((n) => n.innerText.startsWith("coder"))?.innerText.includes("Sonnet 5 · high")`);
  await js(`(() => { const r = document.querySelector(".canvas-wrap").getBoundingClientRect(); __drop({ t: "template", id: "tester" }, r.x + 60, r.y + r.height - 60); })()`); await sleep(400);
  await check("drag: dropping the tester role on empty canvas creates an agent", `[...document.querySelectorAll(".react-flow__node")].some((n) => n.innerText.startsWith("tester"))`);
  await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }))`); await sleep(300);
  await check("undo: both drag edits undone", `!/Review changes \\(\\d+\\)/.test(document.body.innerText)`);

  // 4. Failing-command breaker → inbox decision.
  await js(`__click("button", "Prototype: try a situation")`); await sleep(200);
  await js(`__click(".proto-panel button", "A command fails 3 times")`); await sleep(300);
  await check("breaker: bell shows 1 open item", `document.querySelector(".bell .count")?.textContent === "1"`);
  await js(`document.querySelector(".bell").click()`); await sleep(300);
  await js(`__click("button", "Let the orchestrator handle it")`); await sleep(300);
  await check("breaker: choice resolves the item", `document.body.innerText.includes("Handed to the orchestrator")`);

  // 5. Direct-call approval → Always allow becomes a pending edit.
  await js(`__click("button", "Prototype: try a situation")`); await sleep(200);
  await js(`__click(".proto-panel button", "costly direct call")`); await sleep(300);
  await js(`if (!document.querySelector(".drawer")) document.querySelector(".bell").click()`); await sleep(300);
  await js(`__click("button", "Always allow coder")`); await sleep(300);
  await check("approval: 'Always allow' adds a pending change", `/Review changes \\(\\d+\\)/.test(document.body.innerText)`);

  // 6. Stop and resume.
  await js(`__click("button", "Stop")`); await sleep(1500);
  await check("stop: status shows Stopped", `document.querySelector(".status-pill")?.innerText.includes("Stopped")`);
  await js(`__click("button", "Resume")`); await sleep(400);
  await check("resume: status back to Working", `document.querySelector(".status-pill")?.innerText.includes("Working")`);

  // 7. Secret guard blocks saving a pasted token.
  await js(`__click("button", "Prototype: try a situation")`); await sleep(200);
  await js(`__click(".proto-panel button", "Paste a GitHub token")`); await sleep(400);
  await check("secret guard: Save is disabled", `[...document.querySelectorAll(".dialog-foot button")].find((b) => b.textContent.startsWith("Save"))?.disabled === true`);
  await js(`__click("button", "instead")`); await sleep(400);
  await check("secret guard: one-click fix unblocks Save", `[...document.querySelectorAll(".dialog-foot button")].find((b) => b.textContent.startsWith("Save"))?.disabled === false`);

  // 7b. Appearance: System / Light / Dark.
  await js(`document.querySelector('.appearance [aria-label="Light"]').click()`); await sleep(150);
  await check("appearance: Light sets light mode", `document.documentElement.dataset.theme === "light" && getComputedStyle(document.body).backgroundColor === "rgb(249, 249, 247)"`);
  await js(`document.querySelector('.appearance [aria-label="Dark"]').click()`); await sleep(150);
  await check("appearance: Dark sets dark mode", `document.documentElement.dataset.theme === "dark" && getComputedStyle(document.body).backgroundColor === "rgb(13, 13, 13)"`);
  await js(`document.querySelector('.appearance [aria-label^="System"]').click()`); await sleep(150);
  await check("appearance: System follows macOS (no override)", `!document.documentElement.hasAttribute("data-theme")`);
  await check("appearance: choice is remembered", `localStorage.getItem("crewglass.appearance") === "system"`);

  // 8. One agent only (like a plain chat): a single Main session card, which merges into the orchestrator once a team exists.
  await js(`__click("button", "Keep editing")`); await sleep(200);
  await js(`__click("button", "Prototype: try a situation")`); await sleep(200);
  await js(`__click(".proto-panel button", "Just this chat")`); await sleep(1300);
  await check("one agent: exactly one card, the Claude Code chat", `(() => { const n = document.querySelectorAll(".react-flow__node"); return n.length === 1 && n[0].innerText.includes("Claude Code chat"); })()`);
  await check("one agent: status says main session", `document.querySelector(".status-pill")?.innerText.includes("main session")`);
  await js(`__click(".canvas-banner button", "Plan")`); await sleep(500);
  await check("one agent → team: session merges into the orchestrator card", `(() => { const t = [...document.querySelectorAll(".react-flow__node")].map((n) => n.innerText); return t.length > 3 && !t.some((x) => x.includes("Main session")) && t.some((x) => x.includes("ORCHESTRATOR")); })()`);

  for (const [ok, name] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`\n${results.filter(([ok]) => ok).length}/${results.length} passed · network requests blocked: ${blocked} · page errors: ${errors.length}`);
  if (errors.length) console.log("  " + errors.join("\n  "));
  app.exit(results.every(([ok]) => ok) && !errors.length ? 0 : 1);
});
