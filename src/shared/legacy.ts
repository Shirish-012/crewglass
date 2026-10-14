// Crewglass was called Agent Deck before its public release. What it wrote under the old name — its data folder,
// Live mode hooks, the team map, the /handoff files, the agy bridge — is still recognised, and is moved to the new
// name or removed the next time Crewglass touches it, so nothing is left behind half-working.

export const LEGACY = {
  dataFolder: "Agent Deck",
  hookMark: "agent-deck-hook",
  teamMap: ".claude/rules/agent-deck-team.md",
  usageRules: ".claude/rules/agent-deck-usage.md",
  handoffMark: "<!-- agent-deck:handoff -->",
  excludeMark: "# Agent Deck: kept private",
  agyServer: "agent-deck-agy",
  storagePrefix: "agent-deck.",
} as const;
