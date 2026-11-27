// A unified patch the demo can print for any two texts (the real host asks `git diff`).

/** A plain line diff (longest common subsequence) printed as a unified patch with three lines of context. */
export function unifiedPatch(path: string, from: string, to: string): string {
  const a = from.split("\n").slice(0, from.endsWith("\n") ? -1 : undefined);
  const b = to.split("\n").slice(0, to.endsWith("\n") ? -1 : undefined);
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const ops: { op: " " | "+" | "-"; text: string; a: number; b: number }[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ op: " ", text: a[i++]!, a: i, b: ++j });
    else if (i < a.length && (j === b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) ops.push({ op: "-", text: a[i++]!, a: i, b: j });
    else ops.push({ op: "+", text: b[j++]!, a: i, b: j });
  }
  const changed = ops.flatMap((o, i) => (o.op === " " ? [] : [i]));
  if (!changed.length) return "";
  const out = [`diff --git a/${path} b/${path}`, `--- ${from ? `a/${path}` : "/dev/null"}`, `+++ b/${path}`];
  const CONTEXT = 3;
  // Changes closer than two contexts apart share a hunk.
  const groups: [number, number][] = [];
  for (const c of changed) {
    const last = groups.at(-1);
    if (last && c - last[1] <= CONTEXT * 2) last[1] = c;
    else groups.push([c, c]);
  }
  for (const [first, last] of groups) {
    const hunk = ops.slice(Math.max(0, first - CONTEXT), Math.min(ops.length, last + CONTEXT + 1));
    const oldStart = hunk.find((o) => o.op !== "+")?.a ?? hunk[0]!.a;
    const newStart = hunk.find((o) => o.op !== "-")?.b ?? hunk[0]!.b;
    out.push(`@@ -${oldStart},${hunk.filter((o) => o.op !== "+").length} +${newStart},${hunk.filter((o) => o.op !== "-").length} @@`);
    for (const o of hunk) out.push(`${o.op}${o.text}`);
  }
  return out.join("\n");
}
