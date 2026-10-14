// Folder suggestions ("open in VS Code now") from ~/.claude/ide/*.lock.
// Only `workspaceFolders` is used; the authToken in the same file is never kept or passed on.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IDE_DIR } from "../paths";

export function openWorkspaceFolders(): string[] {
  const out = new Set<string>();
  let files: string[] = [];
  try { files = readdirSync(IDE_DIR).filter((f) => f.endsWith(".lock")); } catch { return []; }
  for (const f of files) {
    try {
      const { workspaceFolders } = JSON.parse(readFileSync(join(IDE_DIR, f), "utf8")) as { workspaceFolders?: unknown };
      if (Array.isArray(workspaceFolders)) for (const w of workspaceFolders) if (typeof w === "string") out.add(w);
    } catch { /* unreadable lock file: skip */ }
  }
  return [...out];
}
