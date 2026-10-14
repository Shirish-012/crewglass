// Agent file headers that aren't strict YAML — e.g. `description: Use when: reviewing` — are still read by Claude Code.
// Crewglass reads them the same forgiving way (one `key: value` per line, split at the first colon), so such agents
// are never missing from the canvas. Saving one from Crewglass rewrites its header as proper YAML (shown in the diff).

export function lenientFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,63}):[ \t]*(.*)$/);
    if (!m) continue;
    let v: string = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = /^\d{1,6}$/.test(v) ? Number(v) : v;
  }
  return out;
}
