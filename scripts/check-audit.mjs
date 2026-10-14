// scripts/check-audit.mjs — `npm audit` for `npm run check`: fails on any high or critical advisory, except the few
// reviewed below. Every exception must say why it can't affect Crewglass and be removed once a fixed version exists.
// (The installed app ships no npm packages at all — scripts/verify-dist.mjs checks that — so these are build tools.)

import { execFileSync } from "node:child_process";

const REVIEWED = {
  // braces: stack-exhaustion DoS from deeply nested glob patterns. Every version is affected (no fix published).
  // Used only while building (Vite's file matching, the prototype's single-file plugin) on our own fixed patterns.
  "GHSA-vfj7-8cjw-p6xm": "braces — build-time only, our own glob patterns, no fixed version yet (2026-10-07)",
};

let report;
try {
  report = JSON.parse(execFileSync("npm", ["audit", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch (e) {
  report = JSON.parse(e.stdout); // npm audit exits non-zero when it finds anything
}
const advisories = new Map();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via) if (typeof via === "object") advisories.set(via.url.split("/").pop(), { pkg: via.name, severity: via.severity, title: via.title });
}
const serious = [...advisories].filter(([, a]) => a.severity === "high" || a.severity === "critical");
const open = serious.filter(([id]) => !REVIEWED[id]);
for (const [id] of serious.filter(([id]) => REVIEWED[id])) console.log(`reviewed: ${id} ${REVIEWED[id]}`);
const others = [...advisories].length - serious.length;
if (open.length) {
  console.error(`High/critical advisories (${open.length}):\n${open.map(([id, a]) => `  ${a.severity} ${a.pkg}: ${a.title} (${id})`).join("\n")}`);
  process.exit(1);
}
console.log(`npm audit: no unreviewed high or critical advisories (${others} moderate/low in build tools; run \`npm audit\` for details).`);
