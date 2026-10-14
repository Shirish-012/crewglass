// Crewglass — Electron main process. Each open folder is a "workspace": a watcher (Deck) plus, when you want to see
// it, a window. Closing a window keeps its folder watched from the menu bar; ⌘N opens another folder.
// No network, no telemetry, no auto-update.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, Tray, type IpcMainInvokeEvent } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockDown } from "./privacy";
import { cleanSettingsPatch, SettingsStore } from "./settings";
import { Deck } from "./deck";
import { Scope } from "./scope";
import { installHelper, socketPathFor, startHookServer } from "./live/hookServer";
import { findAgyEnv, parseAgyModels } from "./agyEnv";
import { hookCommand, install as installHooks, isInstalled, missingStatusLine, outdatedHooks, setStatusLine, planInstall, planUninstall as planHookRemoval, uninstall as uninstallHooks } from "./live/hookInstaller";
import type { Server } from "node:net";
import { applySave, planSave, undoLastSave, type AgyEnv } from "./writers/savePlan";
import { checksFor, planChecks, readFolderData, writeFolderData } from "./folderData";
import { PipelineRunner, validSpec } from "./pipeline/runner";
import { runCheck } from "./checks/runner";
import { planUninstall, runUninstall } from "./uninstall";
import { pickWatcher } from "./route";
import { deleteHistory } from "./history";
import { findTool } from "./tools";
import { readFolderConfig } from "./sources/configFiles";
import { AGY_SERVER } from "@shared/agy";
import { LEGACY } from "@shared/legacy";
import type { AppSettings, DesignPayload, PopupKind } from "@shared/ipc";
import type { Answer, HookMsg, Waiting } from "./live/liveEngine";

declare const __SOURCE_REPO__: string;

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(here, "../renderer/index.html");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// Test-only switches work only with CREWGLASS_TEST=1 (and a separate data folder only then, or when run from the repo).
const testing = process.env.CREWGLASS_TEST === "1";
const captureFile = testing ? arg("capture") : undefined;
let uninstalling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

app.setName("Crewglass");
if (process.env.CREWGLASS_USER_DATA && (testing || !app.isPackaged)) app.setPath("userData", process.env.CREWGLASS_USER_DATA);
else if (app.isPackaged && !testing) moveLegacyData();
if (!app.requestSingleInstanceLock()) app.exit(0);

/** Crewglass was called Agent Deck: on first start, its data and logs folders move to the new name (settings, private
 *  checks, history, save backups, window state). Skipped while the old app is still running, or if both exist. */
function moveLegacyData() {
  const pairs = [[join(app.getPath("appData"), LEGACY.dataFolder), app.getPath("userData")],
    [join(app.getPath("home"), "Library", "Logs", LEGACY.dataFolder), join(app.getPath("home"), "Library", "Logs", app.getName())]];
  const [oldData] = pairs[0];
  try {
    // Chromium's lock is a link named "<host>-<pid>": a live pid means the old app is open, so leave everything alone.
    const pid = Number(readlinkSync(join(oldData, "SingletonLock")).split("-").pop());
    if (pid > 0) { try { process.kill(pid, 0); return; } catch { /* not running */ } }
  } catch { /* no lock: not running */ }
  // Electron may have created the new folder already (empty) by the time this runs; an empty one is replaced.
  const empty = (p: string) => { try { return readdirSync(p).length === 0; } catch { return false; } };
  for (const [from, to] of pairs) {
    try {
      if (!existsSync(from) || (existsSync(to) && !empty(to))) continue;
      if (existsSync(to)) rmdirSync(to);
      renameSync(from, to);
    } catch { /* keep the old folder; start fresh */ }
  }
}

interface Workspace {
  id: number;
  deck: Deck;
  win: BrowserWindow | null;
  pipeline: PipelineRunner | null;
  pendingChecks: Map<string, ReturnType<typeof planChecks>>;
}

const workspaces: Workspace[] = [];
let wsSeq = 0;
let tray: Tray | null = null;
let settings: SettingsStore;
let userData = "";
let hookServer: Server | null = null;
let helperPath: string | null = null;
let agyEnv: AgyEnv = { node: null, bridge: null, agy: null };
let socketPath = "";
const backups = () => join(userData, "backups");

function send(ws: Workspace, channel: string, payload: unknown) {
  if (ws.win && !ws.win.isDestroyed()) ws.win.webContents.send(channel, payload);
}

/** Only our own page may call the API. */
function fromOurPage(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? "";
  return devUrl ? url.startsWith(devUrl) : url.startsWith(pathToFileURL(rendererFile).href);
}

const POPUP_OF: Record<string, PopupKind> = {
  permission: "permission", "failing-command": "paused", approval: "approval", "check-failed": "failed", "turn-failed": "failed", limit: "limit", finished: "finished",
};

/** Pop-ups within 10 s of one another (per folder) are grouped: the first shows at once, the rest become one. */
const popupGroups = new Map<number, { extra: number }>();

function notify(ws: Workspace, title: string, body: string, inboxId?: string, kind?: string) {
  const type = kind ? POPUP_OF[kind] : undefined;
  if (type && settings.data.popups[type] === false) return; // you switched this kind of pop-up off (it's still in the inbox)
  if (ws.win?.isFocused()) return; // no pop-ups while that window is in front — it's already on screen
  if (!Notification.isSupported()) return;
  const group = popupGroups.get(ws.id);
  if (group) { group.extra++; return; }
  const g = { extra: 0 };
  popupGroups.set(ws.id, g);
  setTimeout(() => {
    popupGroups.delete(ws.id);
    const name = ws.deck.scope ? ws.deck.scope.folder.split("/").pop() : "Crewglass";
    if (g.extra) showPopup(ws, `${g.extra} more thing${g.extra === 1 ? " needs" : "s need"} you in ${name}`, "Open Crewglass to see them in the inbox.", true);
  }, 10_000);
  showPopup(ws, title, body, !!inboxId);
}

function showPopup(ws: Workspace, title: string, body: string, openInbox: boolean) {
  const n = new Notification({ title, body, silent: false });
  n.on("click", () => {
    if (!workspaces.includes(ws)) { if (workspaces[0]) showWindow(workspaces[0]); return; } // that folder isn't watched any more
    showWindow(ws);
    if (openInbox) send(ws, "deck:command", "open-inbox");
  });
  n.show();
}

function makeWorkspace(folder: string | null): Workspace {
  const ws: Workspace = { id: ++wsSeq, win: null, pipeline: null, pendingChecks: new Map(), deck: null as unknown as Deck };
  ws.deck = new Deck(settings, (t, b, id, kind) => notify(ws, t, b, id, kind), __SOURCE_REPO__, userData);
  ws.deck.helperReady = !!helperPath;
  ws.deck.agyEnv = agyEnv;
  ws.deck.setFolder(folder);
  workspaces.push(ws);
  rememberOpenFolders();
  return ws;
}

function rememberOpenFolders() {
  const open = workspaces.map((w) => w.deck.scope?.folder).filter((f): f is string => !!f);
  if (settings) settings.update({ openFolders: [...new Set(open)] });
}

/** "Stop watching": the folder's window closes and its watcher ends (Live mode there then allows everything). */
function closeWorkspace(ws: Workspace) {
  ws.pipeline?.stop();
  const i = workspaces.indexOf(ws);
  if (i >= 0) workspaces.splice(i, 1);
  if (ws.win && !ws.win.isDestroyed()) ws.win.destroy();
  if (!workspaces.length) makeWorkspace(null); // there's always somewhere to pick a folder
  rememberOpenFolders();
  updateTray(true);
}

function focusedWorkspace(): Workspace {
  const w = BrowserWindow.getFocusedWindow();
  return workspaces.find((x) => x.win === w) ?? workspaces[0];
}

function showWindow(ws: Workspace = workspaces[0]) {
  if (!ws.win || ws.win.isDestroyed()) createWindow(ws);
  ws.win!.show();
  ws.win!.focus();
}

function createWindow(ws: Workspace, hash?: string) {
  const offset = (workspaces.indexOf(ws) % 6) * 28;
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680, show: false, title: "Crewglass", backgroundColor: "#0d0d0d",
    ...(offset ? { x: 80 + offset, y: 60 + offset } : {}),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false, devTools: !app.isPackaged,
    },
  });
  ws.win = win;
  if (devUrl) void win.loadURL(`${devUrl}${hash ? `#${hash}` : ""}`);
  else void win.loadFile(rendererFile, hash ? { hash } : undefined);
  win.once("ready-to-show", () => { if (!captureFile) win.show(); });
  // Closing a window frees its memory; the folder keeps being watched from the menu bar.
  win.on("closed", () => { if (ws.win === win) ws.win = null; });
}

// ── menu bar icon ──
let traySig = "";
function updateTray(force = false) {
  if (!tray) return;
  const rows = workspaces.map((ws) => {
    const { busy, waiting, open } = ws.deck.quickStatus();
    const name = ws.deck.scope ? ws.deck.scope.folder.split("/").pop()! : "No folder";
    return { ws, name, state: waiting ? "waiting for you" : busy ? "working" : "", open };
  });
  const top = rows.find((r) => r.state === "waiting for you") ?? rows.find((r) => r.state === "working") ?? rows[0];
  const open = rows.reduce((n, r) => n + r.open, 0);
  tray.setTitle(`◆ ${top?.name ?? ""}${top?.state ? ` · ${top.state}` : ""}${rows.length > 1 ? ` +${rows.length - 1}` : ""}${open ? ` · ${open}!` : ""}`);
  const sig = rows.map((r) => `${r.ws.id}:${r.name}:${r.state}:${r.open}`).join("|");
  if (!force && sig === traySig) return;
  traySig = sig;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...rows.map((r) => ({ label: `${r.name}${r.state ? ` — ${r.state}` : ""}${r.open ? ` (${r.open})` : ""}`, click: () => showWindow(r.ws) })),
    { type: "separator" },
    { label: "Needs your attention…", enabled: open > 0, click: () => { const r = rows.find((x) => x.open) ?? rows[0]; showWindow(r.ws); send(r.ws, "deck:command", "open-inbox"); } },
    { label: "New Window", click: () => showWindow(makeWorkspace(null)) },
    { label: "Settings…", click: () => { const ws = workspaces[0]; showWindow(ws); send(ws, "deck:command", "open-settings"); } },
    { type: "separator" },
    { label: "Quit Crewglass", click: quit },
  ]));
}

function quit() { app.quit(); }

function setupMenus() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Crewglass");
  updateTray(true);
  const command = (c: string) => () => { const ws = focusedWorkspace(); showWindow(ws); send(ws, "deck:command", c); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Crewglass", submenu: [
      { role: "about" }, { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: command("open-settings") },
      { label: "Uninstall Crewglass…", click: command("open-uninstall") },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" },
      { label: "Quit Crewglass", accelerator: "CmdOrCtrl+Q", click: quit },
    ] },
    { label: "File", submenu: [
      { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => showWindow(makeWorkspace(null)) },
      { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: command("choose-folder") },
      { type: "separator" },
      { label: "Stop Watching This Folder", click: () => closeWorkspace(focusedWorkspace()) },
      { role: "close" },
    ] },
    // Undo/redo go to the page, which decides: text you're typing, or your last canvas edit. ⌘F finds in the Library.
    { label: "Edit", submenu: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: command("edit-undo") },
      { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: command("edit-redo") },
      { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      { type: "separator" },
      { label: "Find…", accelerator: "CmdOrCtrl+F", click: command("find") },
    ] },
    { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }])] },
    { role: "windowMenu" },
  ]));
}

// ── hook events: to the workspace whose folder they belong to ──
function routeHook(m: HookMsg): Answer | Waiting {
  const ws = pickWatcher(workspaces.map((w) => ({
    w, folder: w.deck.scope?.folder ?? null, contains: (cwd: string) => !!w.deck.scope?.contains(cwd), knowsSession: (id: string) => w.deck.knowsSession(id),
  })), m.cwd, m.session_id)?.w;
  return ws ? ws.deck.handleHook(m) : {}; // a folder no window watches: allow, ignore
}

function appSettings(): AppSettings {
  const s = settings.data;
  return {
    launchAtLogin: s.launchAtLogin, canLaunchAtLogin: app.isPackaged && !testing, popups: s.popups, permissionPopupSec: s.permissionPopupSec, notifyEveryFinish: s.notifyEveryFinish,
    longTaskMin: s.longTaskMin, chatNotice: s.chatNotice, statusLine: s.statusLine, breakerThreshold: s.breakerThreshold, historyDays: s.historyDays, limits: s.limits, sourceRepo: s.sourceRepo ?? __SOURCE_REPO__,
    dataFolder: userData, version: app.getVersion(),
  };
}

function applyLoginItem() {
  // Only the installed app registers itself (never the development build or a test run).
  if (app.isPackaged && !testing) app.setLoginItemSettings({ openAtLogin: settings.data.launchAtLogin });
}

/** A path inside Crewglass's own data or logs folder — the only places it ever deletes whole folders. */
function ownPath(p: string): boolean {
  const roots = [userData, app.getPath("logs")].filter((r) => r.endsWith("Crewglass") || (testing && r === userData));
  return roots.some((r) => p === r || p.startsWith(r + "/"));
}

function registerIpc() {
  const handle = (channel: string, fn: (ws: Workspace, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromOurPage(e)) throw new Error("not allowed");
      if (uninstalling) throw new Error("Crewglass is uninstalling");
      const ws = workspaces.find((w) => w.win && !w.win.isDestroyed() && w.win.webContents.id === e.sender.id);
      if (!ws) throw new Error("no workspace for this window");
      return fn(ws, ...args);
    });

  handle("deck:getSnapshot", (ws) => ws.deck.snapshot());
  handle("deck:chooseFolder", async (ws) => {
    const r = await dialog.showOpenDialog(ws.win!, { title: "Choose a folder to watch", properties: ["openDirectory"] });
    return r.canceled ? null : Deck.validFolder(r.filePaths[0]);
  });
  handle("deck:setFolder", (ws, path) => {
    const folder = Deck.validFolder(path);
    if (!folder) return false;
    // Already watched in another window: go there instead of watching it twice.
    const other = workspaces.find((w) => w !== ws && w.deck.scope?.folder === folder);
    if (other) { showWindow(other); return false; }
    settings.update({ folder, recentFolders: [folder, ...settings.data.recentFolders.filter((f) => f !== folder)].slice(0, 8) });
    ws.pipeline?.stop();
    ws.deck.setFolder(folder);
    rememberOpenFolders();
    void ws.deck.poll().then(() => send(ws, "deck:snapshot", ws.deck.snapshot()));
    return true;
  });
  handle("deck:setLimits", (_ws, limits) => {
    const clean = cleanSettingsPatch({ limits });
    if (clean.limits) settings.update({ limits: clean.limits });
  });
  handle("deck:resolveInbox", (ws, id, choice, note) => {
    if (typeof id !== "string" || typeof choice !== "string") return;
    ws.deck.resolveInbox(id, choice, typeof note === "string" ? note.slice(0, 2000) : undefined);
  });
  handle("deck:livePreview", (ws) => {
    const folder = ws.deck.scope?.folder;
    if (!folder) return { installed: false, path: "", before: "", after: "", existed: false, gitIgnored: null, error: "Choose a folder first." };
    try {
      const installed = isInstalled(folder);
      if (installed) return { installed, ...planHookRemoval(folder, backups()) };
      if (!helperPath) throw new Error("The hook helper is missing from this build (run npm run build).");
      return { installed, ...planInstall(folder, hookCommand(helperPath, socketPath)) };
    } catch (e) {
      return { installed: false, path: "", before: "", after: "", existed: false, gitIgnored: null, error: (e as Error).message };
    }
  });
  handle("deck:setLiveMode", (ws, on) => {
    const folder = ws.deck.scope?.folder;
    if (!folder || typeof on !== "boolean") return { ok: false, error: "Choose a folder first." };
    try {
      if (on) {
        if (!helperPath) throw new Error("The hook helper is missing from this build (run npm run build).");
        installHooks(folder, hookCommand(helperPath, socketPath), backups());
        settings.update({ hookFolders: [...new Set([...settings.data.hookFolders, folder])] });
      } else {
        uninstallHooks(folder, backups());
        settings.update({ hookFolders: settings.data.hookFolders.filter((f) => f !== folder) });
      }
      ws.deck.liveInstalled = on;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  // ── Save: plan (you review it) → apply (checked, backed up) → undo ──
  handle("deck:planSave", (ws, design) => {
    const folder = ws.deck.scope?.folder;
    if (!folder) return { error: "Choose a folder first." };
    const d = validDesign(design);
    if (!d) return { error: "That design couldn't be read." };
    try {
      const plan = planSave(folder, d, agyEnv, helperPath ? hookCommand(helperPath, socketPath) : null);
      const c = planChecks(readFolderData(userData, folder), d);
      ws.pendingChecks.set(plan.id, c);
      if (ws.pendingChecks.size > 20) ws.pendingChecks.delete(ws.pendingChecks.keys().next().value!); // old reviews
      return { ...plan, checks: c.checks, checksChanged: c.changed, needsCheckConfirm: c.needsConfirm };
    } catch (e) { return { error: (e as Error).message }; }
  });
  handle("deck:applySave", (ws, planId, confirmUser, confirmChecks) => {
    const folder = ws.deck.scope?.folder;
    if (!folder || typeof planId !== "string") return { ok: false, error: "Nothing to save." };
    const c = ws.pendingChecks.get(planId);
    // A command new to this folder never runs until you've confirmed it (plan §6.4).
    if (c?.needsConfirm && confirmChecks !== true) return { ok: false, error: "Confirm the check commands first." };
    const r = applySave(planId, confirmUser === true, backups(), (argv) => runClaude(folder, argv));
    if (r.ok && c) {
      writeFolderData(userData, folder, c.next); // stored privately, never in the repo
      ws.pendingChecks.delete(planId);
    }
    // Remember where the agy bridge is registered, so Uninstall can remove it everywhere.
    if (r.ok && readFolderConfig(folder).mcps.some((m) => m.name === AGY_SERVER && m.scope === "local") && !settings.data.agyFolders.includes(folder)) {
      settings.update({ agyFolders: [...settings.data.agyFolders, folder] });
    }
    return r;
  });
  handle("deck:undoLastSave", (ws) => {
    const folder = ws.deck.scope?.folder;
    return folder ? undoLastSave(folder, backups()) : { ok: false, error: "Choose a folder first." };
  });
  // ── Run pipeline: one at a time per window, in its folder, with the agents you saved ──
  handle("deck:runPipeline", (ws, spec) => startPipeline(ws, spec));
  handle("deck:stopPipeline", (ws) => { ws.pipeline?.stop(); });
  let refreshing = false;
  handle("deck:refreshAgyModels", async () => {
    // Only when you click it: agy may contact Google to answer. Its output is used for model ids only.
    if (!agyEnv.agy) return { ok: false, error: "agy isn't installed." };
    if (refreshing) return { ok: false, error: "Already asking agy." };
    refreshing = true;
    const out = await new Promise<string | null>((resolve) =>
      execFile(agyEnv.agy!, ["models"], { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout))))
      .finally(() => { refreshing = false; });
    if (out === null) return { ok: false, error: "agy models didn't answer." };
    const models = parseAgyModels(out);
    settings.update({ geminiModels: models });
    return { ok: true, models };
  });
  handle("deck:stop", (ws, target) => { if (typeof target === "string" && target.length < 100) ws.deck.stop(target); });
  handle("deck:resume", (ws) => ws.deck.resume());
  handle("deck:dismissFormat", (ws) => ws.deck.dismissFormat());
  handle("deck:openInVSCode", (ws, path) => {
    if (typeof path !== "string") return;
    // Only the watched folder or Crewglass's own source code may be opened.
    const allowed = [ws.deck.scope?.folder, settings.data.sourceRepo ?? __SOURCE_REPO__].filter(Boolean).some((root) => new Scope(root!).contains(path));
    if (allowed) execFile("/usr/bin/open", ["-a", "Visual Studio Code", path], () => {});
  });

  // ── Settings, data, uninstall ──
  handle("deck:getSettings", () => appSettings());
  handle("deck:updateSettings", (_ws, patch) => {
    const clean = cleanSettingsPatch(patch);
    settings.update(clean);
    if ("launchAtLogin" in clean) applyLoginItem();
    if ("statusLine" in clean) {
      // You flipped the switch: update every folder that has Live mode (only Crewglass's own entries change).
      setStatusLine(settings.data.statusLine);
      if (helperPath) for (const f of settings.data.hookFolders) {
        try { if (isInstalled(f)) installHooks(f, hookCommand(helperPath, socketPath), backups()); } catch { /* a folder that moved or changed: skip */ }
      }
    }
    for (const w of workspaces) w.deck.applySettings();
    return appSettings();
  });
  handle("deck:chooseSourceRepo", async (ws) => {
    const r = await dialog.showOpenDialog(ws.win!, { title: "Where is Crewglass's source code?", properties: ["openDirectory"] });
    const folder = r.canceled ? null : Deck.validFolder(r.filePaths[0]);
    if (folder) settings.update({ sourceRepo: folder });
    return appSettings();
  });
  handle("deck:deleteAllData", () => {
    try {
      deleteAllData();
      for (const w of workspaces) w.deck.setFolder(null);
      rememberOpenFolders();
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  handle("deck:testNotification", () => {
    if (!Notification.isSupported()) return { ok: false, error: "This Mac doesn't allow notifications from apps right now." };
    new Notification({ title: "Crewglass notifications work", body: "You'll get one like this when Claude finishes a task in a folder Crewglass watches." }).show();
    return { ok: true };
  });
  handle("deck:uninstallPlan", () => uninstallPlanNow());
  handle("deck:uninstall", (_ws, opts) =>
    uninstallNow(!!(opts && typeof opts === "object" && (opts as { removeOrchestrator?: unknown }).removeOrchestrator === true)));
}

async function uninstallNow(removeOrchestrator: boolean): Promise<{ ok: boolean; error?: string }> {
  if (uninstalling) return { ok: false, error: "Already uninstalling." };
  // From here on nothing may write to Crewglass's data again (the page, the menus and the watchers are frozen).
  uninstalling = true;
  settings.freeze();
  if (pollTimer) clearInterval(pollTimer);
  for (const w of workspaces) w.pipeline?.stop();
  const plan = uninstallPlanNow();
  const { errors } = runUninstall(plan, { removeOrchestrator }, { backups: backups(), runClaude });
  if (app.isPackaged && !testing) app.setLoginItemSettings({ openAtLogin: false });
  hookServer?.close();
  for (const d of plan.dataFolders) if (ownPath(d)) rmSync(d, { recursive: true, force: true });
  if (!testing) {
    for (const w of workspaces) if (w.win && !w.win.isDestroyed()) w.win.hide();
    await dialog.showMessageBox({
      type: errors.length ? "warning" : "info", buttons: ["Quit"],
      message: "Crewglass is uninstalled",
      detail: `Live mode was removed from ${plan.hookFolders.length} folder${plan.hookFolders.length === 1 ? "" : "s"}${plan.agyFolders.length ? ` and the agy bridge from ${plan.agyFolders.length}` : ""}. Crewglass's data is deleted. Your agent files, .mcp.json and team maps are kept.\n\nTo finish, drag Crewglass to the Trash.${errors.length ? `\n\nNot everything worked:\n${errors.join("\n")}` : ""}`,
    });
  }
  setTimeout(() => app.exit(0), 200);
  return { ok: errors.length === 0, error: errors.join("\n") || undefined };
}

function uninstallPlanNow() {
  const s = settings.data;
  return planUninstall({ hookFolders: s.hookFolders, agyFolders: s.agyFolders, recent: [...s.recentFolders, ...s.openFolders] }, [userData, app.getPath("logs")]);
}

/** Deletes what Crewglass stored — settings, private checks, save backups — keeping only what undoing Live mode needs:
 *  the helper, the list of folders with Live mode / the agy bridge, and each folder's original settings.local.json. */
function deleteAllData() {
  const s = settings.data;
  // Kept: what undoing Live mode / the agy bridge needs, and your launch-at-login choice (it's a system setting).
  const keep = { hookFolders: s.hookFolders, agyFolders: s.agyFolders, launchAtLogin: s.launchAtLogin };
  const b = backups();
  if (existsSync(b)) {
    for (const folder of readdirSync(b)) {
      const dir = join(b, folder);
      if (!statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory() && ownPath(p)) rmSync(p, { recursive: true, force: true }); // save backups
      }
    }
  }
  const folders = join(userData, "folders");
  if (ownPath(folders)) rmSync(folders, { recursive: true, force: true });
  deleteHistory(userData);
  const logs = app.getPath("logs");
  if (ownPath(logs)) rmSync(logs, { recursive: true, force: true });
  settings.reset(keep);
}

/** Backups of your files from each Save are kept for 30 days (plan §10). */
function pruneBackups() {
  const b = backups();
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  try {
    for (const folder of readdirSync(b)) {
      const dir = join(b, folder);
      if (!statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        // Each save is a timestamped folder; Live mode's original settings.local.json (a file) is always kept.
        const p = join(dir, entry);
        if (statSync(p).isDirectory() && statSync(p).mtimeMs < cutoff && ownPath(p)) rmSync(p, { recursive: true, force: true });
      }
    }
  } catch { /* no backups yet */ }
}

/** Light shape check of a design sent by the page (the page is ours, but every input is checked anyway). */
function validDesign(d: unknown): DesignPayload | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const arr = (k: string) => Array.isArray(o[k]);
  if (!arr("agents") || !arr("mcps") || !arr("links") || !arr("deletedKeys") || !arr("removedMcpKeys")) return null;
  const tooBig = JSON.stringify(d).length > 2_000_000;
  const agentsOk = (o.agents as unknown[]).every((a) => a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string"
    && typeof (a as { instructions?: unknown }).instructions === "string" && typeof (a as { key?: unknown }).key === "string");
  return tooBig || !agentsOk ? null : (o as unknown as DesignPayload);
}

const notifiedPipelines = new Set<string>();

function startPipeline(ws: Workspace, spec: unknown): { ok: boolean; error?: string } {
  const folder = ws.deck.scope?.folder;
  if (!folder) return { ok: false, error: "Choose a folder first." };
  const bin = claudeBinary();
  if (!bin) return { ok: false, error: "The claude command wasn't found." };
  const v = validSpec(spec);
  if (typeof v === "string") return { ok: false, error: v };
  if (ws.pipeline?.running) return { ok: false, error: "A pipeline is already running." };
  // `claude -p` skips Claude Code's "trust this folder?" prompt, so a pipeline only runs where you already said yes.
  if (!readFolderConfig(folder).trusted) {
    return { ok: false, error: "Claude Code hasn't been trusted in this folder yet. Open it in Claude Code once (VS Code or terminal) and accept the trust prompt, then run the pipeline." };
  }
  ws.pipeline = new PipelineRunner({
    claudeBin: bin, folder,
    checksFor: (agent, caller) => checksFor(readFolderData(userData, folder), agent, caller),
    runCheck: (def, cwd, signal) => runCheck(def, cwd, signal),
    onProgress: (p) => {
      send(ws, "deck:pipeline", p);
      // One Mac notification when the whole pipeline ends (not one per step; none if you pressed Stop).
      if (p.status === "done" || p.status === "failed") {
        if (notifiedPipelines.has(p.id)) return;
        notifiedPipelines.add(p.id);
        const failed = p.steps.find((x) => x.status === "failed");
        notify(ws, p.status === "done" ? `Pipeline finished in ${folder.split("/").pop()}` : `Pipeline stopped at a failed step in ${folder.split("/").pop()}`,
          p.status === "done" ? `All ${p.steps.length} steps are done.` : `Step ${failed ? failed.index + 1 : "?"} (${failed?.agent ?? "?"}) failed. Open Crewglass for details.`,
          undefined, p.status === "done" ? "finished" : "check-failed");
      }
    },
    onSession: (id) => ws.deck.markPipelineSession(id),
  });
  ws.pipeline.start(v);
  return { ok: true };
}

/** The official `claude` CLI, found by absolute path (apps started from the Dock have a minimal PATH). */
function claudeBinary(): string | null {
  return findTool("claude");
}

/** Runs the official `claude` CLI (for private MCP servers) — no shell. */
function runClaude(folder: string, argv: string[]): { ok: boolean; error?: string } {
  const bin = claudeBinary();
  if (!bin) return { ok: false, error: "The claude command wasn't found." };
  try { execFileSync(bin, argv, { cwd: folder, timeout: 30_000, stdio: "pipe" }); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).split("\n")[0].slice(0, 200) }; }
}

app.whenReady().then(() => {
  lockDown(devUrl);
  // Crewglass's data folder is readable only by you (plan §9).
  userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  try { chmodSync(userData, 0o700); } catch { /* best effort */ }
  settings = new SettingsStore(userData);
  setStatusLine(settings.data.statusLine);
  applyLoginItem();
  pruneBackups();
  // Live mode: the helper lives in Crewglass's data folder; hooks talk to it over a private Unix socket.
  helperPath = installHelper(join(here, "../bin/crewglass-hook"), userData);
  // agy agents: the bridge also lives in the data folder, so its registered path never changes.
  agyEnv = findAgyEnv(installHelper(join(here, "../bin/agy-bridge.mjs"), userData, "agy-bridge.mjs"));
  socketPath = socketPathFor(userData);
  hookServer = startHookServer(socketPath, routeHook);
  // Folders with Live mode are brought up to date: hooks that run an older helper (e.g. the Agent Deck name's) are
  // rewritten, and folders from before the status line existed get it too (only where there's none at all).
  if (helperPath) for (const f of settings.data.hookFolders) {
    const cmd = hookCommand(helperPath, socketPath);
    try { if (outdatedHooks(f, cmd) || (settings.data.statusLine && missingStatusLine(f))) installHooks(f, cmd, backups()); } catch { /* moved or changed: skip */ }
  }

  // Which folders to watch: --folder (this run only), else the ones open last time, else the last folder.
  const cliFolder = Deck.validFolder(arg("folder"));
  const restore = cliFolder ? [cliFolder] : settings.data.openFolders.map((f) => Deck.validFolder(f)).filter((f): f is string => !!f);
  if (!restore.length) restore.push(Deck.validFolder(settings.data.folder) ?? "");
  for (const f of [...new Set(restore)]) makeWorkspace(f || null);
  if (settings.limitsReset) workspaces[0]?.deck.noteLimitsReset();

  // Test-only switches: --live=on|off for the --folder, --dump=<file> writes each snapshot, --run-pipeline=<spec.json>.
  if (testing && cliFolder && helperPath) {
    if (arg("live") === "on") installHooks(cliFolder, hookCommand(helperPath, socketPath), backups());
    if (arg("live") === "off") uninstallHooks(cliFolder, backups());
  }
  const dump = testing ? arg("dump") : undefined;
  const runSpec = testing ? arg("run-pipeline") : undefined;
  if (runSpec && cliFolder) setTimeout(() => { try { startPipeline(workspaces[0], JSON.parse(readFileSync(runSpec, "utf8"))); } catch { /* bad spec file */ } }, 3000);

  registerIpc();
  setupMenus();
  // Started at login: watch quietly from the menu bar. Otherwise show a window per folder. (--hidden: tests only.)
  const atLogin = (app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin) || (testing && process.argv.includes("--hidden"));
  if (!atLogin) workspaces.forEach((ws, i) => createWindow(ws, i === 0 ? arg("hash") : undefined));
  // --selftest=<file.json> (tests only): the page tries to reach the internet; every attempt must be blocked.
  const selftest = testing ? arg("selftest") : undefined;
  if (selftest && workspaces[0]?.win) {
    workspaces[0].win.webContents.once("did-finish-load", () => setTimeout(async () => {
      // network-check: allow-start — this probe must be BLOCKED; it proves the page can't reach the internet
      const probe = `Promise.all([
        fetch("https://example.com/").then(() => "reached").catch(() => "blocked"),
        new Promise((r) => { const i = new Image(); i.onload = () => r("reached"); i.onerror = () => r("blocked"); i.src = "https://example.com/x.png"; }),
        new Promise((r) => { try { const w = new WebSocket("wss://example.com/"); w.onopen = () => r("reached"); w.onerror = () => r("blocked"); } catch { r("blocked"); } }),
        Promise.resolve(window.open("https://example.com/") ? "reached" : "blocked"),
      ]).then(([fetch, image, socket, popup]) => ({ fetch, image, socket, popup, api: Object.keys(window.crewglass ?? {}).length, node: typeof require }))`;
      // network-check: allow-end
      const r = await workspaces[0].win!.webContents.executeJavaScript(probe);
      writeFileSync(selftest, JSON.stringify(r));
    }, 1500));
  }
  // --uninstall=yes (tests only): the same Uninstall as the menu, without clicking.
  if (testing && arg("uninstall") === "yes") setTimeout(() => void uninstallNow(arg("remove-orchestrator") === "yes"), 2000);

  let running = false;
  pollTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const ws of [...workspaces]) {
        await ws.deck.poll();
        if (ws.win && !ws.win.isDestroyed()) send(ws, "deck:snapshot", ws.deck.snapshot());
      }
      if (dump && workspaces[0]) writeFileSync(dump, JSON.stringify(workspaces[0].deck.snapshot()));
      updateTray();
    }
    catch (err) { console.error("[deck] poll failed:", (err as Error).message); }
    finally { running = false; }
  }, 1000);

  // --capture=<file.png> (tests only): screenshot every window (file.png, file-2.png, …) after a few seconds and quit.
  const capture = captureFile;
  if (capture) {
    setTimeout(async () => {
      let n = 0;
      for (const ws of workspaces) {
        if (!ws.win || ws.win.isDestroyed()) continue;
        const img = await ws.win.webContents.capturePage();
        writeFileSync(++n === 1 ? capture : capture.replace(/\.png$/, `-${n}.png`), img.toPNG());
      }
      app.exit(0);
    }, Number(arg("capture-delay") ?? 5000));
  }
});

app.on("second-instance", () => { if (workspaces.length && !uninstalling) showWindow(focusedWorkspace()); });
app.on("activate", () => {
  if (!workspaces.length || uninstalling) return; // not started yet, or on the way out
  if (!workspaces.some((w) => w.win && !w.win.isDestroyed() && w.win.isVisible())) showWindow(workspaces[0]);
});
app.on("before-quit", () => { hookServer?.close(); for (const w of workspaces) w.pipeline?.stop(); });
app.on("window-all-closed", () => { /* keep watching from the menu bar */ });
