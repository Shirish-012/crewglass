// scripts/screenshot.mjs — open the built prototype in Electron (hidden), capture screens, and prove it stays offline.
//
// Run:  npm run prototype:build && npm run shot [-- name=hash ...]
// Writes screenshots/<name>.png. Any request other than the local file is BLOCKED and reported;
// console errors from the page are reported too.

import { app, BrowserWindow, session } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(join(root, "prototype/dist/index.html")).href;
const outDir = join(root, "screenshots");

const DEFAULT_SHOTS = {
  "01-onboard-folder": "onboard=0",
  "02-onboard-live": "onboard=1",
  "03-onboard-limits": "onboard=2",
  "04-onboard-team": "onboard=3",
  "05-main": "main",
  "06-main-dark": "main&theme=dark",
  "07-agent-selected": "main&select=agent:project:coder",
  "08-direct-link": "main&select=link:l9",
  "09-inbox-approval": "main&scenario=approval,failing-command&inbox",
  "10-usage": "main&bottom=usage",
  "11-activity": "main&bottom=activity",
  "12-review-secret": "main&scenario=secret",
  "13-unknown-fields": "main&scenario=unknown-fields&format",
  "14-legend-menu": "main&legend&menu=project:coder",
  "15-preset-review": "preset=code-test-review&main&review",
};

const args = process.argv.slice(2).filter((a) => a.includes("="));
const shots = args.length ? Object.fromEntries(args.map((a) => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)]; })) : DEFAULT_SHOTS;

// Throwaway profile in the temp folder, so test runs leave nothing in ~/Library and share no state between runs.
app.setPath("userData", join(tmpdir(), `crewglass-test-${process.pid}`));
const PARTITION = "crewglass-test"; // no "persist:" prefix → storage lives in memory only

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const blocked = [];
  session.fromPartition(PARTITION).webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith("file://") || details.url.startsWith("data:") || details.url.startsWith("devtools://");
    if (!ok) blocked.push(details.url);
    cb({ cancel: !ok });
  });
  const errors = [];
  let current = "";
  // One window, reloaded per shot (a changing query string forces a full reload so the app re-reads the hash).
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: PARTITION } });
  win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === "warning") errors.push(`${current}: [${e.level}] ${e.message}`); });
  for (const [name, hash] of Object.entries(shots)) {
    current = name;
    try {
      await win.loadURL(`${page}?shot=${encodeURIComponent(name)}#${hash}`);
    } catch (err) {
      errors.push(`${name}: load failed ${err.message}`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 2200));
    const img = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), img.toPNG());
    console.log(`saved screenshots/${name}.png`);
  }
  win.destroy();
  console.log(`\nnetwork requests blocked: ${blocked.length}${blocked.length ? "\n  " + blocked.join("\n  ") : ""}`);
  console.log(`console errors/warnings: ${errors.length}${errors.length ? "\n  " + errors.slice(0, 20).join("\n  ") : ""}`);
  app.quit();
});
