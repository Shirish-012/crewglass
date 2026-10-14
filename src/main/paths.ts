// Where Claude Code keeps its files. CREWGLASS_CLAUDE_DIR / CREWGLASS_HOME exist only so tests can point
// Crewglass at fixture folders instead of your real ~/.claude.

import { homedir } from "node:os";
import { join } from "node:path";

// Honoured only in tests (vitest, or CREWGLASS_TEST=1): the installed app always reads the real locations.
const overrides = !!process.env.VITEST || process.env.CREWGLASS_TEST === "1";
export const HOME = (overrides && process.env.CREWGLASS_HOME) || homedir();
export const CLAUDE_DIR = (overrides && process.env.CREWGLASS_CLAUDE_DIR) || join(HOME, ".claude");
export const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
export const IDE_DIR = join(CLAUDE_DIR, "ide");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const USER_AGENTS_DIR = join(CLAUDE_DIR, "agents");
export const CLAUDE_JSON = join(HOME, ".claude.json");
