// Where agy agents' pieces live on this Mac. Only fixed, well-known locations are checked (nothing is run),
// and Node is the stable Homebrew link, never a versioned Cellar path that breaks on `brew upgrade`.

import type { AgyEnv } from "./writers/savePlan";
import { findTool } from "./tools";

export function findAgyEnv(bridge: string | null): AgyEnv {
  return { node: findTool("node"), agy: findTool("agy"), bridge };
}

/** `agy models` output → Gemini ids only (the bridge refuses every other model family). */
export function parseAgyModels(out: string): string[] {
  const ids = out.split("\n").map((l) => l.split("\t")[0].trim()).filter((id) => /^gemini-[a-z0-9][a-z0-9.-]{0,60}$/.test(id));
  return [...new Set(ids)].slice(0, 50);
}
