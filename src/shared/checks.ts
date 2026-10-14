// Checks (plan §6.4): the built-in catalog, and the one rule every command check follows — it's ONE command,
// run without a shell (so a check can never chain, redirect or expand anything).

import type { Check } from "./types";

export const BUILTIN_CHECKS: Record<string, Check> = {
  "npm-test": { key: "npm-test", kind: "command", label: "npm test", command: "npm test" },
  "npm-lint": { key: "npm-lint", kind: "command", label: "npm run lint", command: "npm run lint" },
  "tsc": { key: "tsc", kind: "command", label: "tsc --noEmit", command: "npx tsc --noEmit" },
  // Verdict checks name their checker agent by NAME (Claude runs agents by name).
  "reviewer-verdict": { key: "reviewer-verdict", kind: "verdict", label: "Reviewer verdict", checkerAgent: "reviewer" },
  "second-opinion": { key: "second-opinion", kind: "second-opinion", label: "Second opinion (Gemini)", checkerAgent: "gemini-reviewer" },
};

/** Why a command can't be a check (or null if it's fine). */
export function checkCommandProblem(command: string): string | null {
  if (!command.trim()) return "Type the command to run, e.g. npm test.";
  if (command.length > 500) return "That command is too long.";
  if (/[|&;<>`$(){}\n\r]/.test(command.replace(/"[^"]*"|'[^']*'/g, ""))) {
    return "A check is one command, run without a shell: no |, &&, ;, >, <, $ or backticks. Use one check per command.";
  }
  return null;
}

/** A stable key for a check you typed yourself. */
export const customCheckKey = (command: string) => `cmd:${command.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

/** VERDICT: PASS / VERDICT: FAIL — the only word read from a checker's reply. */
export function verdictOf(text: string): "PASS" | "FAIL" | null {
  const all = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)\b/g)];
  return all.length ? (all[all.length - 1][1] as "PASS" | "FAIL") : null;
}
