// /handoff and /pickup: save where you are to .claude/handoff.md, then continue later in a fresh, small chat.
// Cheaper than one very long chat (whose cache Claude re-writes after every break). Written to .claude/commands/
// on Save; the note itself is personal (kept out of git). The marker lets Crewglass update or remove only its own copy.

import { LEGACY } from "./legacy";

export const HANDOFF_MARK = "<!-- crewglass:handoff -->";
export const HANDOFF_FILES = { handoff: ".claude/commands/handoff.md", pickup: ".claude/commands/pickup.md", rules: ".claude/rules/crewglass-usage.md" } as const;
export const HANDOFF_NOTE = ".claude/handoff.md";
/** Crewglass's own copy of a /handoff file (also one saved under the old name, Agent Deck). */
export const isOurHandoffFile = (text: string) => text.includes(HANDOFF_MARK) || text.includes(LEGACY.handoffMark);

export const HANDOFF_COMMAND = `---
description: Save where you are to .claude/handoff.md so a fresh chat (or tomorrow) can continue. Cheaper than one long chat.
argument-hint: [optional note about what to emphasise]
---
${HANDOFF_MARK}

Write a **handoff note** to \`.claude/handoff.md\`, replacing any old one. Someone with **no memory of this conversation** (a fresh chat after \`/clear\`, or tomorrow) must be able to continue the work from this file alone.

Extra note from the user: $ARGUMENTS

Use exactly these sections. Be specific and short, at most about 400 words in total:

\`\`\`markdown
# Handoff: <one-line goal>
_Updated: <date and time> · Branch: <git branch>_

## Goal
What we're trying to achieve, and why (2–3 lines).

## Done
- Finished items, with key files (\`path\`).

## In progress
- What was being worked on when we stopped, and its exact state (what works, what doesn't yet).

## Next steps
1. The very next action, concrete enough to start immediately.
2. …

## Key files
- \`path\`: why it matters

## Decisions & gotchas
- Choices made and why; traps to avoid; commands that matter.

## How to resume
Start a chat and run \`/pickup\`.
\`\`\`

Then tell the user in one line that the handoff is saved, and that they can run \`/clear\` now and \`/pickup\` later to continue with a small context.
`;

export const PICKUP_COMMAND = `---
description: Continue earlier work from the handoff note (.claude/handoff.md) in a fresh, small chat.
---
${HANDOFF_MARK}

Read \`.claude/handoff.md\`. If it doesn't exist, say so and stop.

Then reply with:
1. **Where we are:** 2–3 lines on the goal and the current state.
2. **Next step:** the first item from "Next steps", and what you plan to do for it.

Don't re-read every key file up front: open only what the next step needs. Ask the user to confirm before starting if the note is more than a day old or the next step is unclear.
`;

/** Loaded as project instructions, so Claude knows the 95% notice comes from the user's own tool and follows it
 *  (text that arrives with a tool result is otherwise, rightly, treated with suspicion — seen in testing). */
export const USAGE_RULES = `${HANDOFF_MARK}
# Usage notices from Crewglass

Crewglass is the user's own usage monitor for this folder (set up by the user, through a Claude Code hook). When the user's usage limit is nearly reached, it adds a note after a tool step that starts with "USAGE NOTICE (from Crewglass)".

When you see that note: finish only the step you are on, write the handoff note to \`.claude/handoff.md\` in the \`/handoff\` format, and tell the user. It never blocks anything; the user decides whether to continue.
`;
