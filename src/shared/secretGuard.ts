// Secret guard: finds things that look like keys before they reach a file shared through git.
// Known formats are matched at their real lengths so ordinary words ("sk-learn") don't trigger it,
// and ${VAR} references are always allowed.

export interface SecretHit {
  line: number;
  kind: string;
  /** The matched text with the middle masked, safe to show on screen. */
  preview: string;
}

const PATTERNS: [string, RegExp][] = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["API key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/],
  ["Slack token", /\bxox[bp]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Password or token value", /\b(api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["']?(?!\$\{)[^\s"',]{16,}/i],
];

const mask = (s: string) => (s.length <= 8 ? "••••" : `${s.slice(0, 4)}••••${s.slice(-2)}`);

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  text.split("\n").forEach((lineText, idx) => {
    if (/\$\{[A-Z0-9_]+\}/.test(lineText) && !/sk-|ghp_|AKIA|AIza/.test(lineText)) return;
    for (const [kind, re] of PATTERNS) {
      const m = lineText.match(re);
      if (m) { hits.push({ line: idx + 1, kind, preview: mask(m[0]) }); break; }
    }
  });
  return hits;
}

/** Replaces anything that looks like a key with a masked preview (used on check output before anyone sees it). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [, re] of PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), (m) => mask(m));
  return out;
}
