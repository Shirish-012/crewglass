import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Scope, encodeProjectDir } from "../src/main/scope";
import { tempDir } from "./helpers";

describe("folder scope", () => {
  const root = tempDir();
  const folder = join(root, "agent app");
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(root, "agent app2"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  symlinkSync(join(folder, "src"), join(root, "link-into"));
  symlinkSync(join(root, "elsewhere"), join(folder, "link-out"));
  const scope = new Scope(folder);

  it("includes the folder and its subfolders", () => {
    expect(scope.contains(folder)).toBe(true);
    expect(scope.contains(join(folder, "src"))).toBe(true);
    expect(scope.subfolder(join(folder, "src"))).toBe("src");
  });
  it("excludes look-alike names and other folders", () => {
    expect(scope.contains(join(root, "agent app2"))).toBe(false);
    expect(scope.contains(join(root, "elsewhere"))).toBe(false);
    expect(scope.contains(undefined)).toBe(false);
  });
  it("a link inside the folder that points elsewhere doesn't count", () => {
    expect(scope.contains(join(folder, "link-out"))).toBe(false);
  });
  it("never touches paths outside the folder (so macOS never asks about Downloads, Desktop, …)", () => {
    // Claude Code reports real paths, so a path that isn't under the folder by name is rejected without a disk lookup.
    expect(scope.contains(join(root, "link-into"))).toBe(false);
    expect(scope.contains("/Users/someone/Downloads/project")).toBe(false);
    expect(scope.contains(join(folder.replace(/^\/private/, ""), "src"))).toBe(true); // /tmp vs /private/tmp by text
  });
  it("encodes project folder names like Claude Code (spaces and look-alikes collide)", () => {
    expect(encodeProjectDir("/Users/a/agent app")).toBe("-Users-a-agent-app");
    expect(encodeProjectDir("/Users/a/agent-app")).toBe("-Users-a-agent-app");
  });
});
