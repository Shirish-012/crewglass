// scripts/verify-dist.mjs — checks the packaged app after `npm run dist` (plan §9): Electron's risky switches are
// off, the bundle is signed and sealed, and it contains only the built app. Prints PASS/FAIL per check.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
const FuseState = { DISABLE: 48, ENABLE: 49 }; // "0" / "1" in the binary's fuse wire
const asar = require("@electron/asar");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = join(root, "release", "mac-arm64", "Crewglass.app");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

if (!existsSync(appPath)) { console.error(`Not built: ${appPath}`); process.exit(1); }

const wire = await getCurrentFuseWire(appPath);
const is = (opt, state) => wire[opt] === state;
check("fuse: RunAsNode off (can't be used as a plain Node.js)", is(FuseV1Options.RunAsNode, FuseState.DISABLE));
check("fuse: NODE_OPTIONS ignored", is(FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE));
check("fuse: --inspect flags ignored", is(FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE));
check("fuse: app.asar integrity checked", is(FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE));
check("fuse: loads only its own app.asar", is(FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE));
check("fuse: no cookie encryption (never touches your keychain)", is(FuseV1Options.EnableCookieEncryption, FuseState.DISABLE));

let signed = true, sigDetail = "";
try { execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" }); }
catch (e) { signed = false; sigDetail = String(e.stderr ?? e).split("\n")[0]; }
check("signed (ad hoc, on this Mac) and unmodified", signed, sigDetail);

const plist = join(appPath, "Contents", "Info.plist");
let integrity = false;
try { execFileSync("/usr/bin/plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", plist], { stdio: "pipe" }); integrity = true; } catch { /* missing */ }
check("Info.plist carries the app.asar hash", integrity);

const files = asar.listPackage(join(appPath, "Contents", "Resources", "app.asar"), { isPack: false });
const outside = files.filter((f) => !f.startsWith("/out") && f !== "/package.json");
check("app.asar holds only the built app (no node_modules, no sources)", !outside.length, outside.slice(0, 3).join(", "));
check("no source maps shipped", !files.some((f) => f.endsWith(".map")));
check("Electron's demo app removed", !existsSync(join(appPath, "Contents", "Resources", "default_app.asar")));

const helper = join(appPath, "Contents", "Resources", "app.asar.unpacked", "out", "bin", "crewglass-hook");
let exec = false; try { accessSync(helper, constants.X_OK); exec = true; } catch { /* not executable */ }
check("hook helper bundled (runnable)", exec);
check("agy bridge bundled", existsSync(join(appPath, "Contents", "Resources", "app.asar.unpacked", "out", "bin", "agy-bridge.mjs")));

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
