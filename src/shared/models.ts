// Model catalog: friendly names, whether a model uses effort, context windows, and chart colors.
// Context windows come from Claude Code's own model table (Phase 0a, docs/data-sources.md #23).

import type { Effort } from "./types";
import { geminiLabel } from "./agy";

export interface ModelInfo {
  id: string;
  alias?: string;
  label: string;
  family: "claude" | "gemini";
  /** Haiku records no effort (Phase 0a #22), so it gets no effort chips. */
  usesEffort: boolean;
  contextWindow: number;
  /** Fixed categorical slot (1-based) — color follows the model, never its rank. Older models share slot 6. */
  colorSlot: number;
  /** Other ids Claude Code may write for the same model (e.g. without the date). */
  altIds?: string[];
  /** false = named correctly when Claude uses it, but not offered in the Library (older or limited-access models). */
  listed?: boolean;
  /** Opus-class price or above: an unplanned direct call to it at high effort needs your OK (D18). */
  premium?: boolean;
}

// The aliases follow Claude Code's own catalog (2.1.284): opus → Opus 5.5, sonnet → Sonnet 5.5, haiku → Haiku 4.5,
// fable → Fable 5.1. An agent file with `model: sonnet` runs whatever Claude Code maps the alias to.
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", alias: "opus", label: "Opus 5.5", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 1, premium: true },
  { id: "claude-sonnet-5-5", alias: "sonnet", label: "Sonnet 5.5", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 2 },
  { id: "claude-haiku-4-5-20251001", alias: "haiku", label: "Haiku 4.5", family: "claude", usesEffort: false, contextWindow: 200_000, colorSlot: 3, altIds: ["claude-haiku-4-5"] },
  { id: "claude-fable-5-1", alias: "fable", label: "Fable 5.1", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 5, premium: true },
  // Earlier or limited-access Claude models: shown by name when Claude uses them.
  { id: "claude-sonnet-5", label: "Sonnet 5", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false },
  { id: "claude-opus-5", label: "Opus 5", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-fable-5", label: "Fable 5", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-mythos-5-1", label: "Mythos 5.1", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-mythos-5", label: "Mythos 5", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-opus-4-8", label: "Opus 4.8", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-opus-4-7", label: "Opus 4.7", family: "claude", usesEffort: true, contextWindow: 1_000_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-opus-4-6", label: "Opus 4.6", family: "claude", usesEffort: true, contextWindow: 200_000, colorSlot: 6, listed: false, premium: true },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "claude", usesEffort: true, contextWindow: 200_000, colorSlot: 6, listed: false },
  { id: "claude-opus-4-5-20251101", label: "Opus 4.5", family: "claude", usesEffort: false, contextWindow: 200_000, colorSlot: 6, listed: false, premium: true, altIds: ["claude-opus-4-5"] },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", family: "claude", usesEffort: false, contextWindow: 200_000, colorSlot: 6, listed: false, altIds: ["claude-sonnet-4-5"] },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro · high", family: "gemini", usesEffort: false, contextWindow: 1_000_000, colorSlot: 4 },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash · high", family: "gemini", usesEffort: false, contextWindow: 1_000_000, colorSlot: 4 },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash · medium", family: "gemini", usesEffort: false, contextWindow: 1_000_000, colorSlot: 4 },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash · low", family: "gemini", usesEffort: false, contextWindow: 1_000_000, colorSlot: 4 },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro · low", family: "gemini", usesEffort: false, contextWindow: 1_000_000, colorSlot: 4 },
];

/** The Claude models the Library and model pickers offer (the current ones). */
export const LISTED_CLAUDE = () => MODELS.filter((m) => m.family === "claude" && m.listed !== false);

/** Gemini models for agy agents: the bundled list, plus any found by "Refresh from agy". */
export function geminiModels(extra: { id: string }[] = []): ModelInfo[] {
  const list = MODELS.filter((m) => m.family === "gemini");
  for (const e of extra) if (!list.some((m) => m.id === e.id)) list.push({ id: e.id, label: geminiLabel(e.id), family: "gemini", usesEffort: false, contextWindow: 1_000_000, colorSlot: 4 });
  return list;
}

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function findModel(idOrAlias: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === idOrAlias || m.alias === idOrAlias || m.altIds?.includes(idOrAlias));
}

/** "claude-opus-5-5" → "Opus 5.5"; unknown ids are shown as they are. */
export function modelLabel(idOrAlias: string): string {
  if (idOrAlias === "inherit") return "Inherits session";
  if (idOrAlias === "unknown") return "Model not seen yet";
  return findModel(idOrAlias)?.label ?? (idOrAlias.startsWith("gemini-") || idOrAlias === "agy-default" ? geminiLabel(idOrAlias) : idOrAlias);
}

/** "Opus 5.5 · medium", or just "Haiku 4.5" for models without effort. */
export function modelWithEffort(idOrAlias: string, effort?: Effort): string {
  const m = findModel(idOrAlias);
  return m?.usesEffort && effort ? `${m.label} · ${effort}` : modelLabel(idOrAlias);
}

/** The effort a chat running as this agent starts at. Claude Code ignores an agent file's `effort` for the main chat, so
 *  Crewglass writes it to the folder's `effortLevel` — which can't hold max (verified on 2.1.283): max starts at xhigh. */
export function chatStartEffort(idOrAlias: string, effort?: Effort): Effort | undefined {
  if (!effort || findModel(idOrAlias)?.usesEffort === false) return undefined;
  return effort === "max" ? "xhigh" : effort;
}

/** Did a run use a different model or effort than the agent is set to? (Only compares what both sides know.) */
export function runDiffers(set: { model: string; effort?: Effort }, ran: { model: string; effort?: Effort }): boolean {
  const setId = findModel(set.model)?.id;
  if (setId && ran.model !== setId) return true;
  return !!(set.effort && ran.effort && findModel(ran.model)?.usesEffort && ran.effort !== set.effort);
}

export function modelSlot(idOrAlias: string): number {
  return findModel(idOrAlias)?.colorSlot ?? (/^gemini/i.test(idOrAlias) ? 4 : 6);
}

/** Costly = the caller needs YOUR approval for an unplanned direct call (D18): an Opus-class model or above (Opus,
 *  Fable, Mythos) at high+ effort, or agy/Gemini. */
export function isCostly(idOrAlias: string, effort: Effort | undefined, isAgy: boolean): boolean {
  if (isAgy) return true;
  const m = findModel(idOrAlias);
  return !!m?.premium && (effort === "high" || effort === "xhigh" || effort === "max");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
