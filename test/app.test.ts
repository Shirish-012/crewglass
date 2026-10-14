// Phase 6: settings validation, routing hook events between windows, and Uninstall.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, write } from "./helpers";

const home = tempDir();
process.env.CREWGLASS_HOME = home;
process.env.CREWGLASS_CLAUDE_DIR = join(home, ".claude");
const { cleanSettingsPatch, SettingsStore } = await import("../src/main/settings");
const { pickWatcher } = await import("../src/main/route");
const { planUninstall, runUninstall } = await import("../src/main/uninstall");
const { install, isInstalled, hookCommand } = await import("../src/main/live/hookInstaller");

describe("settings", () => {
  it("accepts only known settings with sane values", () => {
    expect(cleanSettingsPatch({ launchAtLogin: false, breakerThreshold: 9, permissionPopupSec: 30, longTaskMin: 0, evil: "x", sourceRepo: "/etc" }))
      .toEqual({ launchAtLogin: false, permissionPopupSec: 30 });
    expect(cleanSettingsPatch({ popups: { finished: false, bogus: false, limit: "no" } }).popups).toMatchObject({ finished: false, limit: true, permission: true });
    expect(cleanSettingsPatch({ limits: { session: 5, day: 1e6 } }).limits).toBeUndefined();
  });
  it("Delete all data keeps only what's needed to undo Live mode", () => {
    const s = new SettingsStore(tempDir());
    s.update({ recentFolders: ["/a"], hookFolders: ["/a"], agyFolders: ["/b"], breakerThreshold: 5 });
    s.reset({ hookFolders: s.data.hookFolders, agyFolders: s.data.agyFolders });
    expect(s.data).toMatchObject({ recentFolders: [], hookFolders: ["/a"], agyFolders: ["/b"], breakerThreshold: 3, launchAtLogin: true });
  });
});

describe("several windows", () => {
  const w = (folder: string, sessions: string[] = []) => ({ folder, contains: (c: string) => c === folder || c.startsWith(folder + "/"), knowsSession: (id: string) => sessions.includes(id) });
  it("sends a hook event to the most specific watched folder, else to whoever knows the session", () => {
    const a = w("/work/app"), b = w("/work/app/packages/api", ["s9"]), c = w("/other");
    expect(pickWatcher([a, b, c], "/work/app/packages/api/src", "s1")).toBe(b);
    expect(pickWatcher([a, b, c], "/work/app/docs", "s1")).toBe(a);
    expect(pickWatcher([a, b, c], undefined, "s9")).toBe(b);
    expect(pickWatcher([a, b, c], "/elsewhere", "s1")).toBeUndefined();
  });
});

describe("Uninstall", () => {
  it("removes Live mode from every folder, unregisters the agy bridge, and removes the orchestrator only if asked", () => {
    const backups = tempDir("un-bk-");
    const f1 = tempDir("un-a-"), f2 = tempDir("un-b-"), f3 = tempDir("un-c-");
    write(join(f1, ".claude", "settings.local.json"), '{\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}\n');
    const before = readFileSync(join(f1, ".claude", "settings.local.json"), "utf8");
    install(f1, hookCommand("/opt/crewglass-hook", "/tmp/d.sock"), backups);
    install(f2, hookCommand("/opt/crewglass-hook", "/tmp/d.sock"), backups);
    // f3: an orchestrator Crewglass set up, and the agy bridge registered for it (in ~/.claude.json, local scope).
    write(join(f3, ".claude", "settings.local.json"), { agent: "lead", effortLevel: "high", other: 1 });
    write(join(f3, ".claude", "rules", "crewglass-team.md"), "# team");
    write(join(home, ".claude.json"), { projects: { [f3]: { mcpServers: { "crewglass-agy": { type: "stdio", command: "node" } } } } });
    const plan = planUninstall({ hookFolders: [f1], agyFolders: [], recent: [f2, f3, "/gone/folder"] }, [tempDir("un-data-")]);
    expect(plan.hookFolders.sort()).toEqual([f1, f2].sort()); // f2 found on disk even though it wasn't on the list
    expect(plan.agyFolders).toEqual([f3]);
    expect(plan.orchestratorFolders).toEqual([{ folder: f3, agent: "lead" }]);
    const ran: [string, string[]][] = [];
    const r = runUninstall(plan, { removeOrchestrator: false }, { backups, runClaude: (f, argv) => { ran.push([f, argv]); return { ok: true }; } });
    expect(r.errors).toEqual([]);
    expect(isInstalled(f1) || isInstalled(f2)).toBe(false);
    expect(readFileSync(join(f1, ".claude", "settings.local.json"), "utf8")).toBe(before); // byte for byte
    expect(ran).toEqual([[f3, ["mcp", "remove", "--scope", "local", "crewglass-agy"]]]);
    expect(JSON.parse(readFileSync(join(f3, ".claude", "settings.local.json"), "utf8")).agent).toBe("lead");
    runUninstall({ ...plan, hookFolders: [], agyFolders: [] }, { removeOrchestrator: true }, { backups, runClaude: () => ({ ok: true }) });
    expect(JSON.parse(readFileSync(join(f3, ".claude", "settings.local.json"), "utf8"))).toEqual({ other: 1 });
    expect(existsSync(join(f3, ".claude", "rules", "crewglass-team.md"))).toBe(true); // your files are kept
  });
});
