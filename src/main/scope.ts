// The folder rule (plan §3.1): Crewglass only looks at Claude Code activity whose folder is the selected
// folder or inside it. Paths are compared by their real location, so symlinks can't sneak others in.

import { realpathSync } from "node:fs";

export function realPath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** macOS's own aliases (/tmp is /private/tmp, …), resolved by text — no disk access. */
const aliased = (p: string) => p.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");

export class Scope {
  readonly folder: string;
  constructor(folder: string) { this.folder = realPath(folder); }

  /** True for the folder itself and anything inside it. "/a/agent app2" is NOT inside "/a/agent app".
   *  Paths that aren't under the folder by name are rejected WITHOUT touching the disk — so sessions in other
   *  folders (Downloads, Desktop, …) never make macOS ask for access. Paths under it are then resolved, so a link
   *  inside your folder that points elsewhere doesn't count. */
  contains(cwd: string | undefined | null): boolean {
    if (!cwd) return false;
    const inside = (p: string) => p === this.folder || p.startsWith(this.folder + "/");
    if (!inside(aliased(cwd))) return false;
    return inside(aliased(realPath(cwd)));
  }

  /** Subfolder of a session's cwd relative to the watched folder ("" for the folder itself). Only for paths inside it. */
  subfolder(cwd: string): string {
    const p = aliased(cwd);
    return p === this.folder || !p.startsWith(this.folder + "/") ? "" : p.slice(this.folder.length + 1);
  }
}

/** Claude Code names a project's transcript folder after its path with every non-alphanumeric character as "-". */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}
