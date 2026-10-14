// The one-line notice at the start of a Claude Code chat (Live mode): which agent the chat runs as (or that the chat
// itself leads the team), what it starts on, and who it hands work to. It's a hook `systemMessage`: shown to you in the
// chat, never read by Claude (verified on Claude Code 2.1.283), so it costs no tokens. Names only — never work text.

import { modelLabel, modelWithEffort } from "@shared/models";
import { CHAT_NAME, type TeamMapData } from "@shared/teamMap";
import type { Effort } from "@shared/types";

const MAX_NAMES = 6;
const MAX_LEN = 280; // the helper refuses anything over 300 characters
/** Names come from files in the folder: keep them short and plain. */
const clean = (s: string) => s.replace(/[^\w.\- ]/g, "").slice(0, 64);

function handsTo(team: TeamMapData | null, from: (name: string) => boolean): string {
  const names = [...new Set((team?.links ?? []).filter((l) => l.kind === "delegates" && from(l.from)).map((l) => clean(l.to)))];
  if (!names.length) return "";
  return `hands work to ${names.slice(0, MAX_NAMES).join(", ")}${names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : ""}`;
}

const cap = (parts: (string | null | false)[]) => {
  const line = parts.filter(Boolean).join(" · ");
  return line.length > MAX_LEN ? `${line.slice(0, MAX_LEN - 1)}…` : line;
};

export function chatNotice(opts: {
  /** The agent this chat runs as (SessionStart's `agent_type`), if any. */
  agentType?: string;
  /** Its file (the copy Claude uses), if Crewglass found one. */
  agent: { model: string } | null;
  /** The folder's `effortLevel` — what new chats start at. */
  startEffort: Effort | null;
  /** The saved team map, if any. */
  team: TeamMapData | null;
}): string | null {
  const { agentType, agent, startEffort, team } = opts;
  if (agentType) {
    const id = agent && agent.model !== "inherit" ? clean(agent.model) : "";
    const model = id ? (startEffort ? modelWithEffort(id, startEffort) : modelLabel(id)) : null;
    return cap([`Crewglass: this chat runs as ${clean(agentType)}`, model && `starts on ${model}`, handsTo(team, (n) => n === agentType)]);
  }
  if (!team) return null; // no team saved here: nothing to say
  // The chat leads (an older team map may still name a former orchestrator as the one handing work out).
  const fromChat = (n: string) => n === CHAT_NAME || n === team.orchestrator;
  return cap(["Crewglass: this chat leads your team", handsTo(team, fromChat) || "no hand-offs drawn yet", "/workflow <task> runs the full team steps"]);
}
