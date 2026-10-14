// scripts/check-no-network.mjs — fails if Crewglass's code could reach the network (plan §9: "a lint rule bans
// http, https, fetch and host connections"). Scans src/, resources/ and hook/. Dependency-free on purpose.
//
// Allowed: node:net ONLY in src/main/live/hookServer.ts (the private Unix socket), and lines inside
//   // network-check: allow-start … // network-check: allow-end   (the in-app network self-test, which must be blocked)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RULES = [
  [/from\s+["'](node:)?(http|https|http2|tls|dgram|dns|undici|ws)["']/, "imports a network module"],
  [/require\(\s*["'](node:)?(http|https|http2|tls|dgram|dns|undici|ws)["']\s*\)/, "requires a network module"],
  [/from\s+["'](node:)?net["']/, "imports node:net (only the hook server's Unix socket may)"],
  [/\bfetch\s*\(/, "calls fetch()"],
  [/\bXMLHttpRequest\b/, "uses XMLHttpRequest"],
  [/\bnew\s+WebSocket\b/, "opens a WebSocket"],
  [/\bEventSource\s*\(/, "opens an EventSource"],
  [/\bsendBeacon\s*\(/, "sends a beacon"],
  [/\bnet\.(request|fetch)\b/, "uses Electron's net module"],
  [/\b(session|defaultSession)\.fetch\b/, "uses Electron's session.fetch"],
  [/\bopenExternal\s*\(/, "opens an external URL"],
  [/\bAF_INET6?\b/, "opens an internet socket"],
  [/\.listen\(\s*\d/, "listens on a network port"],
  [/\b(createConnection|connect)\(\s*\{?\s*(port|host)\b/, "connects to a network host"],
  [/\bURLSession\b|\bNSURLConnection\b/, "makes an HTTP request (Swift)"],
];
const ALLOW_NET = new Set(["src/main/live/hookServer.ts"]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if ([".ts", ".tsx", ".mjs", ".cjs", ".js", ".swift"].includes(extname(p))) yield p;
  }
}

const problems = [];
let scanned = 0;
for (const top of ["src", "resources", "hook"]) {
  for (const p of files(join(root, top))) {
    scanned++;
    const rel = relative(root, p);
    let allowed = false;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("network-check: allow-start")) allowed = true;
      if (line.includes("network-check: allow-end")) { allowed = false; return; }
      if (allowed || /^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments explain; they don't run
      if (/^\s*import\s+type\b/.test(line)) return; // type-only imports are erased at build time
      for (const [re, why] of RULES) {
        if (!re.test(line)) continue;
        if (why.startsWith("imports node:net") && ALLOW_NET.has(rel) && !/connect\(/.test(line)) continue;
        problems.push(`${rel}:${i + 1}  ${why}\n    ${line.trim().slice(0, 140)}`);
      }
    });
  }
}

if (problems.length) {
  console.error(`Network code found (${problems.length}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`No network code: ${scanned} files checked (only the hook server's private Unix socket uses node:net).`);
