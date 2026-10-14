// Minimal line diff (longest common subsequence) for the "Review changes" dialog.
// Config files are small, so the O(n·m) table is fine.

export type DiffOp = { type: "same" | "add" | "del"; text: string };

export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ type: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ type: "del", text: a[i++] });
    else ops.push({ type: "add", text: b[j++] });
  }
  while (i < a.length) ops.push({ type: "del", text: a[i++] });
  while (j < b.length) ops.push({ type: "add", text: b[j++] });
  return ops;
}
