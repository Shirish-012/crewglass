import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOOK_EVENTS, hookCommand, install, isInstalled, outdatedHooks, planInstall, uninstall } from "../src/main/live/hookInstaller";
import { tempDir } from "./helpers";

const CMD = hookCommand("/Users/x/Library/Application Support/Crewglass/bin/crewglass-hook", "/Users/x/Library/Application Support/Crewglass/crewglass.sock");
const settings = (folder: string) => join(folder, ".claude", "settings.local.json");
const read = (folder: string) => readFileSync(settings(folder), "utf8");

function project(existing?: string) {
  const folder = tempDir("crewglass-proj-");
  if (existing !== undefined) { mkdirSync(join(folder, ".claude")); writeFileSync(settings(folder), existing); }
  return { folder, backups: tempDir("crewglass-backups-") };
}

describe("hook command", () => {
  it("quotes paths with spaces and refuses paths that could break out of the quotes", () => {
    expect(CMD).toBe('"/Users/x/Library/Application Support/Crewglass/bin/crewglass-hook" --socket "/Users/x/Library/Application Support/Crewglass/crewglass.sock"');
    expect(() => hookCommand('/tmp/a"; rm -rf ~; "', "/tmp/s")).toThrow();
    expect(() => hookCommand("/tmp/$(evil)", "/tmp/s")).toThrow();
    expect(() => hookCommand("relative/path", "/tmp/s")).toThrow();
  });
});

describe("Live mode install / remove", () => {
  const original = '{\n    "permissions": { "allow": ["Bash(npm test)"] },\n    "enabledMcpjsonServers": ["github"],\n    "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ] }\n}\n';

  it("adds our hooks for every event and keeps everything else", () => {
    const { folder, backups } = project(original);
    install(folder, CMD, backups);
    const s = JSON.parse(read(folder));
    expect(s.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(s.enabledMcpjsonServers).toEqual(["github"]);
    expect(s.hooks.Stop).toHaveLength(2); // the user's own Stop hook is kept
    for (const { event } of HOOK_EVENTS) expect(JSON.stringify(s.hooks[event])).toContain("crewglass-hook");
    expect(s.hooks.PreToolUse[0]).toMatchObject({ matcher: "*", hooks: [{ type: "command", command: CMD, timeout: 150 }] });
    expect(isInstalled(folder)).toBe(true);
  });

  it("installing twice changes nothing", () => {
    const { folder, backups } = project(original);
    install(folder, CMD, backups);
    const once = read(folder);
    install(folder, CMD, backups);
    expect(read(folder)).toBe(once);
  });

  it("removal restores the original file byte-for-byte", () => {
    const { folder, backups } = project(original);
    install(folder, CMD, backups);
    uninstall(folder, backups);
    expect(read(folder)).toBe(original);
    expect(isInstalled(folder)).toBe(false);
  });

  it("keeps changes Claude Code made in the meantime (e.g. an 'always allow')", () => {
    const { folder, backups } = project(original);
    install(folder, CMD, backups);
    const s = JSON.parse(read(folder));
    s.permissions.allow.push("Bash(git status)");
    writeFileSync(settings(folder), JSON.stringify(s, null, 2));
    uninstall(folder, backups);
    const after = JSON.parse(read(folder));
    expect(after.permissions.allow).toEqual(["Bash(npm test)", "Bash(git status)"]);
    expect(JSON.stringify(after)).not.toContain("crewglass-hook");
    expect(after.hooks.Stop).toHaveLength(1);
  });

  it("creates the file (and .claude) when missing, and removes both again", () => {
    const { folder, backups } = project();
    const plan = planInstall(folder, CMD);
    expect(plan.existed).toBe(false);
    install(folder, CMD, backups);
    expect(existsSync(settings(folder))).toBe(true);
    uninstall(folder, backups);
    expect(existsSync(settings(folder))).toBe(false);
    expect(existsSync(join(folder, ".claude"))).toBe(false);
  });

  it("refuses to write through a linked .claude folder", () => {
    const { folder, backups } = project();
    const elsewhere = tempDir("crewglass-elsewhere-");
    symlinkSync(elsewhere, join(folder, ".claude"));
    expect(() => install(folder, CMD, backups)).toThrow(/link/);
    expect(existsSync(join(elsewhere, "settings.local.json"))).toBe(false);
  });

  it("makes sure git ignores the file (adds it to .git/info/exclude only when needed)", () => {
    const { folder, backups } = project();
    execFileSync("/usr/bin/git", ["init", "-q", folder]);
    const plan = install(folder, CMD, backups);
    // If a global ignore already covers it (as on this Mac), nothing needs adding; otherwise it's excluded locally.
    const excluded = readFileSync(join(folder, ".git", "info", "exclude"), "utf8").includes("/.claude/settings.local.json");
    expect(plan.gitIgnored === true || excluded).toBe(true);
    expect(execFileSync("/usr/bin/git", ["-C", folder, "status", "--porcelain"]).toString()).not.toContain("settings.local.json");
  });
});

describe("hooks saved under the old name (Agent Deck)", () => {
  const OLD = hookCommand("/Users/x/Library/Application Support/Agent Deck/bin/agent-deck-hook", "/Users/x/Library/Application Support/Agent Deck/deck.sock");
  const original = '{\n  "permissions": { "allow": ["Bash(npm test)"] }\n}\n';

  it("are found, rewritten to the new helper, and removed byte-for-byte", () => {
    const { folder, backups } = project(original);
    install(folder, OLD, backups);
    expect(isInstalled(folder)).toBe(true);
    expect(outdatedHooks(folder, CMD)).toBe(true);
    install(folder, CMD, backups);
    expect(outdatedHooks(folder, CMD)).toBe(false);
    expect(read(folder)).not.toContain("agent-deck-hook");
    expect(JSON.parse(read(folder)).statusLine.command).toBe(`${CMD} --statusline`);
    uninstall(folder, backups);
    expect(read(folder)).toBe(original);
  });

  it("an up-to-date or absent install isn't outdated", () => {
    const { folder, backups } = project(original);
    expect(outdatedHooks(folder, CMD)).toBe(false);
    install(folder, CMD, backups);
    expect(outdatedHooks(folder, CMD)).toBe(false);
  });
});
