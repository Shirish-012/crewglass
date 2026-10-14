// The only bridge between the page and the app: a handful of named calls. The page gets no Node.js,
// no file system and no way to run commands — just these functions.

import { contextBridge, ipcRenderer } from "electron";
import type { DeckApi, Snapshot } from "../shared/ipc";

const api: DeckApi = {
  getSnapshot: () => ipcRenderer.invoke("deck:getSnapshot"),
  onSnapshot: (cb) => {
    const listener = (_e: unknown, s: Snapshot) => cb(s);
    ipcRenderer.on("deck:snapshot", listener);
    return () => ipcRenderer.removeListener("deck:snapshot", listener);
  },
  chooseFolder: () => ipcRenderer.invoke("deck:chooseFolder"),
  setFolder: (path) => ipcRenderer.invoke("deck:setFolder", path),
  setLimits: (limits) => ipcRenderer.invoke("deck:setLimits", limits),
  resolveInbox: (id, choice, note) => ipcRenderer.invoke("deck:resolveInbox", id, choice, note),
  livePreview: () => ipcRenderer.invoke("deck:livePreview"),
  setLiveMode: (on) => ipcRenderer.invoke("deck:setLiveMode", on),
  stop: (target) => ipcRenderer.invoke("deck:stop", target),
  resume: () => ipcRenderer.invoke("deck:resume"),
  planSave: (design) => ipcRenderer.invoke("deck:planSave", design),
  applySave: (planId, confirmUser, confirmChecks) => ipcRenderer.invoke("deck:applySave", planId, confirmUser, confirmChecks),
  undoLastSave: () => ipcRenderer.invoke("deck:undoLastSave"),
  refreshAgyModels: () => ipcRenderer.invoke("deck:refreshAgyModels"),
  uninstallPlan: () => ipcRenderer.invoke("deck:uninstallPlan"),
  uninstall: (opts) => ipcRenderer.invoke("deck:uninstall", opts),
  dismissFormatIssues: () => ipcRenderer.invoke("deck:dismissFormat"),
  openInVSCode: (path) => ipcRenderer.invoke("deck:openInVSCode", path),
  onCommand: (cb) => {
    const listener = (_e: unknown, c: string) => cb(c);
    ipcRenderer.on("deck:command", listener);
    return () => ipcRenderer.removeListener("deck:command", listener);
  },
};

contextBridge.exposeInMainWorld("crewglass", api);
