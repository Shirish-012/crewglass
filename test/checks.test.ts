// The command-check runner: one command, no shell, a time limit, the last 40 lines with keys masked.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCheck, splitCommand } from "../src/main/checks/runner";
import { tempDir } from "./helpers";

const node = process.execPath;

describe("check commands", () => {
  it("are split into arguments, quotes respected", () => {
    expect(splitCommand(`npm run test -- --grep "a b" 'c d'`)).toEqual(["npm", "run", "test", "--", "--grep", "a b", "c d"]);
  });
  it("refuse shell features instead of interpreting them", () => {
    for (const c of ["npm test && rm -rf ~", "npm test | tee x", "npm test; ls", "echo $(whoami)", "echo `id`", "npm test > out"]) expect(() => splitCommand(c)).toThrow(/without a shell/);
    expect(splitCommand(`node -e "console.log(1 && 2)"`)).toEqual(["node", "-e", "console.log(1 && 2)"]); // inside quotes it's just text
  });
});

describe("running a check", () => {
  const dir = tempDir("check-run-");
  it("passes on exit 0 and runs in the given folder", async () => {
    const r = await runCheck({ key: "k", label: "ok", command: `${node} -e "require('fs').writeFileSync('ran.txt','1')"` }, dir);
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(existsSync(join(dir, "ran.txt"))).toBe(true);
  });
  it("fails with the last 40 lines of output, keys masked", async () => {
    const script = "for(let i=1;i<=60;i++)console.log('line '+i);console.error('token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');process.exit(3)";
    const r = await runCheck({ key: "k", label: "t", command: `${node} -e "${script}"` }, dir);
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    const lines = r.tail.split("\n");
    expect(lines.length).toBe(40);
    expect(r.tail).not.toContain("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    expect(r.tail).not.toContain("line 1\n");
  });
  it("stops a check that runs too long", async () => {
    const r = await runCheck({ key: "k", label: "slow", command: `${node} -e "setTimeout(()=>{},60000)"`, timeoutMs: 300 }, dir);
    expect(r).toMatchObject({ ok: false, timedOut: true });
  });
  it("keeps npm and npx offline, and doesn't pass on Electron's switches", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const r = await runCheck({ key: "k", label: "env", command: `${node} -e "console.log(process.env.npm_config_offline, process.env.npm_config_yes, process.env.ELECTRON_RUN_AS_NODE)"` }, dir);
    delete process.env.ELECTRON_RUN_AS_NODE;
    expect(r.tail.trim()).toBe("true false undefined");
  });
  it("reports a missing program instead of crashing", async () => {
    const r = await runCheck({ key: "k", label: "nope", command: "definitely-not-a-real-program-xyz" }, dir);
    expect(r.ok).toBe(false);
  });
});

describe("which checks run (private data only)", async () => {
  const { planChecks, checksFor } = await import("../src/main/folderData");
  const { customCheckKey } = await import("@shared/checks");
  const agent = (name: string, checks: string[]) => ({ key: `project:.claude/agents/${name}.md`, name, kind: "subagent", checks }) as never;
  const design = (agents: unknown[], checks: Record<string, unknown> = {}) => ({ agents, mcps: [], links: [], orchestratorKey: null, orchestratorPaused: false, checks, deletedKeys: [], removedMcpKeys: [] }) as never;
  const empty = { checks: {}, commands: {}, confirmed: [] };

  it("asks you to confirm a command the first time, then runs only confirmed commands", () => {
    const p = planChecks(empty, design([agent("coder", ["npm-test"])]));
    expect(p).toMatchObject({ changed: true, needsConfirm: true, checks: [{ agent: "coder", command: "npm test", isNew: true }] });
    expect(checksFor(empty, "coder")).toEqual([]); // not saved/confirmed yet: nothing runs
    expect(checksFor(p.next, "coder")).toEqual([{ key: "npm-test", label: "npm test", command: "npm test" }]);
    expect(planChecks(p.next, design([agent("coder", ["npm-test"])]))).toMatchObject({ changed: false, needsConfirm: false });
  });

  it("uses Crewglass's own command for built-in checks, whatever the page sends", () => {
    const p = planChecks(empty, design([agent("coder", ["npm-test"])], { "npm-test": { key: "npm-test", kind: "command", label: "npm test", command: "rm -rf ~" } }));
    expect(p.checks[0].command).toBe("npm test");
  });

  it("checks commands you type: one command, and the key must match it", () => {
    const key = customCheckKey("pytest -q");
    const p = planChecks(empty, design([agent("coder", [key])], { [key]: { key, kind: "command", label: "pytest -q", command: "pytest -q" } }));
    expect(p.next.commands[key]).toEqual({ label: "pytest -q", command: "pytest -q" });
    const bad = customCheckKey("pytest && rm x");
    expect(() => planChecks(empty, design([agent("coder", [bad])], { [bad]: { key: bad, kind: "command", command: "pytest && rm x" } }))).toThrow(/without a shell/);
    expect(() => planChecks(empty, design([agent("coder", [key])], { [key]: { key, kind: "command", command: "make deploy" } }))).toThrow(/doesn't match/);
  });
});
