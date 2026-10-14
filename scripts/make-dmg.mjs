// scripts/make-dmg.mjs — turns release/mac-arm64/Crewglass.app into a disk image to share:
// release/Crewglass-<version>-arm64.dmg, which opens as a window with the app and an Applications shortcut
// (drag one onto the other). Uses macOS's own hdiutil — nothing is downloaded.
//
// Run:  npm run dmg        (builds and checks the app first)

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "release", "mac-arm64", "Crewglass.app");
if (!existsSync(app)) { console.error("Build the app first: npm run dist"); process.exit(1); }
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release", `Crewglass-${version}-arm64.dmg`);

const stage = mkdtempSync(join(tmpdir(), "crewglass-dmg-"));
try {
  execFileSync("/usr/bin/ditto", [app, join(stage, "Crewglass.app")]); // keeps the signature intact
  symlinkSync("/Applications", join(stage, "Applications"));
  execFileSync("/usr/bin/hdiutil", ["create", "-volname", "Crewglass", "-srcfolder", stage, "-ov", "-format", "UDZO", "-fs", "HFS+", out], { stdio: "inherit" });
  execFileSync("/usr/bin/hdiutil", ["verify", out], { stdio: "ignore" });
  console.log(`\nDisk image ready: ${out}`);
  console.log("Signed ad hoc on this Mac: people you send it to open it once via System Settings → Privacy & Security → Open Anyway.");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
