// Crewglass's own settings: ~/Library/Application Support/Crewglass/settings.json (numbers and paths only).
// Written to a temp file and renamed, so a crash never leaves half a file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PopupKind } from "@shared/ipc";

export interface Settings {
  folder: string | null;
  recentFolders: string[];
  /** Folders being watched (one per window); restored when Crewglass starts. */
  openFolders: string[];
  limits: { session: number; day: number };
  dismissedFormat: string | null;
  /** Every folder Live mode was turned on in, so Uninstall can remove the hooks from all of them. */
  hookFolders: string[];
  /** Every folder the agy bridge was registered for, so Uninstall can unregister it everywhere. */
  agyFolders: string[];
  /** Gemini model ids from the last "Refresh from agy" (only when you click it). */
  geminiModels: string[];
  launchAtLogin: boolean;
  /** Which pop-ups you want (plan §8); everything still goes to the inbox. */
  popups: Record<PopupKind, boolean>;
  permissionPopupSec: number;
  /** "Claude finished" pop-up after every task (true), or only after tasks of at least `longTaskMin` minutes. */
  notifyEveryFinish: boolean;
  longTaskMin: number;
  /** Live mode: a one-line note at the start of each Claude Code chat saying which agent it runs as. */
  chatNotice: boolean;
  /** The failing-command breaker pauses a command after this many failures in a row (2–5). */
  breakerThreshold: number;
  /** Crewglass's own source code, for the "Unknown fields" box (default: where it was built). */
  sourceRepo: string | null;
  /** How long the History tab keeps each session's numbers (Claude's own transcripts only go back 30 days). */
  historyDays: number;
  /** How tokens are counted: 2 = input + output (cache writes no longer included). Limits saved before are reset once. */
  tokenCount?: number;
}

/** Tokens are input + output since this version (cache writes used to be counted, which made usage look inflated). */
export const TOKEN_COUNT = 2;

export const DEFAULT_POPUPS: Record<PopupKind, boolean> = { permission: true, paused: true, approval: true, failed: true, finished: true, limit: true };

const DEFAULTS: Settings = {
  folder: null, recentFolders: [], openFolders: [], limits: { session: 1_000_000, day: 1_500_000 }, dismissedFormat: null, hookFolders: [], agyFolders: [],
  geminiModels: [], launchAtLogin: true, popups: DEFAULT_POPUPS, permissionPopupSec: 20, notifyEveryFinish: true, longTaskMin: 2, chatNotice: true, breakerThreshold: 3, sourceRepo: null,
  historyDays: 90, tokenCount: TOKEN_COUNT,
};

/** The settings you can change in the Settings screen, checked field by field. Unknown or bad values are ignored. */
export function cleanSettingsPatch(p: unknown): Partial<Settings> {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const out: Partial<Settings> = {};
  const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
  if (typeof o.launchAtLogin === "boolean") out.launchAtLogin = o.launchAtLogin;
  if (typeof o.notifyEveryFinish === "boolean") out.notifyEveryFinish = o.notifyEveryFinish;
  if (typeof o.chatNotice === "boolean") out.chatNotice = o.chatNotice;
  if (o.popups && typeof o.popups === "object") {
    const pp = { ...DEFAULT_POPUPS };
    for (const k of Object.keys(DEFAULT_POPUPS) as PopupKind[]) { const v = (o.popups as Record<string, unknown>)[k]; if (typeof v === "boolean") pp[k] = v; }
    out.popups = pp;
  }
  const sec = int(o.permissionPopupSec, 5, 600); if (sec !== undefined) out.permissionPopupSec = sec;
  const min = int(o.longTaskMin, 1, 120); if (min !== undefined) out.longTaskMin = min;
  const th = int(o.breakerThreshold, 2, 5); if (th !== undefined) out.breakerThreshold = th;
  const hd = int(o.historyDays, 30, 365); if (hd !== undefined) out.historyDays = hd;
  const l = o.limits as { session?: unknown; day?: unknown } | undefined;
  const lim = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 10_000 && n <= 1e10 ? Math.round(n) : undefined);
  if (l && lim(l.session) !== undefined && lim(l.day) !== undefined) out.limits = { session: lim(l.session)!, day: lim(l.day)! };
  return out;
}

export class SettingsStore {
  private path: string;
  data: Settings;
  constructor(userData: string) {
    this.path = join(userData, "settings.json");
    let loaded: Partial<Settings> = {};
    try { loaded = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>; } catch { /* first run */ }
    this.data = { ...DEFAULTS, ...loaded, limits: { ...DEFAULTS.limits, ...(loaded.limits ?? {}) }, popups: { ...DEFAULT_POPUPS, ...(loaded.popups ?? {}) } };
    // Limits saved when tokens still included cache writes are ~5–20× too high for the new count: start them again.
    if (Object.keys(loaded).length && loaded.tokenCount !== TOKEN_COUNT) {
      this.limitsReset = true;
      this.update({ limits: { ...DEFAULTS.limits }, tokenCount: TOKEN_COUNT });
    }
  }
  /** The limits were reset because tokens are now counted differently (the app says so once). */
  limitsReset = false;
  /** Back to defaults, keeping only `keep` (Delete all data). */
  reset(keep: Partial<Settings>) {
    this.data = { ...DEFAULTS };
    this.update(keep);
  }

  private frozen = false;
  /** Uninstall: nothing may be written any more (so the deleted data folder isn't created again). */
  freeze() { this.frozen = true; }

  update(patch: Partial<Settings>) {
    this.data = { ...this.data, ...patch };
    if (this.frozen) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
