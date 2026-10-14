// API-equivalent dollars: what Claude Code usage would cost at Claude API prices. On a Pro/Max subscription you don't
// pay per token, but dollars weigh each kind of token honestly — cache reads are cheap, cache writes cost more than
// input — so they're the yardstick for limits. Prices: USD per million tokens (Claude API reference, 2026-09-25).

import { findModel } from "./models";

export const PRICES_AS_OF = "2026-09-25";

export interface Price { input: number; output: number; cacheRead: number }
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
};
/** Models without a known price are priced like the default model, and marked as estimates. */
const FALLBACK = "claude-opus-5-5";

/** One reply's usage, as Claude Code records it. Cache writes split into 5-minute (1.25× input) and 1-hour (2× input). */
export interface PricedUsage { input: number; output: number; cacheRead: number; write5m: number; write1h: number; fast?: boolean }

/** USD per million tokens (input, output, cache read), or undefined when the price isn't known. */
export function priceOf(model: string): Price | undefined {
  return PRICES[findModel(model)?.id ?? model];
}

export function priceKnown(model: string): boolean {
  return !!PRICES[findModel(model)?.id ?? model];
}

export function costOf(model: string, u: PricedUsage): number {
  const p = PRICES[findModel(model)?.id ?? model] ?? PRICES[FALLBACK];
  const usd = (u.input * p.input + u.write5m * p.input * 1.25 + u.write1h * p.input * 2 + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
  return u.fast ? usd * 2 : usd;
}

/** "$0.42", "$12.30", "$1,240" */
export function formatUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}
