// agy agents (plan §6.3): a Haiku relay subagent whose only tool is Crewglass's agy bridge.
// The bridge is registered privately per folder as the MCP server "crewglass-agy" (a distinct name, so it never
// replaces an "agy" server a project already has). Its answers end with one report line, parsed here.

export const AGY_SERVER = "crewglass-agy";
export const AGY_TOOL = `mcp__${AGY_SERVER}__ask_agy`;
export const GEMINI_ID_RE = /^gemini-[a-z0-9][a-z0-9.-]{0,60}$/;

/** Is this tool call a call to agy through a bridge? (Crewglass's own, or a hand-made one.) */
export function isAgyTool(name: string): boolean {
  return name === AGY_TOOL || /^mcp__[A-Za-z0-9_-]*agy[A-Za-z0-9_-]*__(ask_agy|ask-gemini)$/.test(name);
}

export function agyRelayInstructions(geminiModel: string): string {
  return [
    "You are a relay to Gemini (through agy). Never do the work yourself.",
    "1. Call the ask_agy tool exactly once, with:",
    "   - prompt: the complete task you were given, word for word, plus any context agy needs (agy can't see this conversation; mention files in this folder as @path so it can read them).",
    `   - model: "${geminiModel}"`,
    "2. Reply with agy's answer exactly as returned, including its last line that starts with [crewglass:agy].",
    "If the tool fails, reply with its error text exactly as returned. If the ask_agy tool isn't available, reply only: \"agy isn't reachable from this session.\"",
    "Never answer the task yourself, not even a simple question: the answer must come from Gemini.",
  ].join("\n");
}

/** The Gemini model an agy agent's instructions tell the relay to use. */
export function geminiFromInstructions(text: string): string | undefined {
  const m = text.match(/model:\s*"(gemini-[a-z0-9][a-z0-9.-]{0,60})"/);
  return m?.[1];
}

export interface AgyReport { model: string; seconds: number; in: number; out: number; thinking: number; status: string }

const REPORT_RE = /\[crewglass:agy\] model=(\S{1,80}) seconds=(\d{1,6}(?:\.\d)?) in=(\d{1,10}) out=(\d{1,10}) thinking=(\d{1,10}) status=([A-Z_]{1,40})/;

/** Reads the bridge's report line (numbers and the model id only) from a tool result. */
export function parseAgyReport(text: string): AgyReport | null {
  const all = [...text.matchAll(new RegExp(REPORT_RE, "g"))];
  const m = all[all.length - 1];
  if (!m) return null;
  return { model: m[1], seconds: Number(m[2]), in: Number(m[3]), out: Number(m[4]), thinking: Number(m[5]), status: m[6] };
}

/** "gemini-3.8-flash-low" → "Gemini 3.8 Flash · low"; "gemini-3.1-pro-high" → "Gemini 3.1 Pro · high". */
export function geminiLabel(id: string): string {
  const m = id.match(/^gemini-(\d+(?:\.\d+)?)-([a-z]+)(?:-([a-z]+))?$/);
  if (!m) return id === "agy-default" ? "Gemini (agy's default)" : id;
  const family = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return `Gemini ${m[1]} ${family}${m[3] ? ` · ${m[3]}` : ""}`;
}
