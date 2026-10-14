// Where command-line tools live on a Mac (apps started from the Dock don't get your shell's PATH). Only fixed,
// well-known locations are checked — nothing is run to find them. Stable paths first (e.g. Homebrew's `node` link,
// which survives `brew upgrade`); a version manager's newest install (nvm) last.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths";

function nvmBins(): string[] {
  const base = join(HOME, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(base).filter((v) => /^v\d+\.\d+\.\d+$/.test(v));
    versions.sort((a, b) => b.slice(1).split(".").map(Number).reduce((d, n, i) => d || n - Number(a.slice(1).split(".")[i]), 0));
    return versions.map((v) => join(base, v, "bin"));
  } catch { return []; }
}

export function findTool(name: "claude" | "node" | "agy"): string | null {
  const dirs = [
    join(HOME, ".local", "bin"), ...(name === "claude" ? [join(HOME, ".claude", "local")] : []),
    "/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".volta", "bin"), join(HOME, ".bun", "bin"), join(HOME, ".npm-global", "bin"), join(HOME, "bin"),
    ...nvmBins(),
  ];
  // Node for the agy bridge: prefer Homebrew's stable link over ~/.local/bin copies.
  const ordered = name === "node" ? ["/opt/homebrew/bin", "/usr/local/bin", ...dirs] : dirs;
  for (const d of ordered) { const p = join(d, name); if (existsSync(p)) return p; }
  return null;
}
