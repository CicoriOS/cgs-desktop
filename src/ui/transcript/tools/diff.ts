export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  /** Line number in the old file (del, ctx) or the new file (add), when the diff carries one. */
  no?: number;
  text: string;
}

// omp's edit diff: " 1|alpha", "-2|beta", "+2|new". Plain unified diffs ("+text", "@@ ... @@") are accepted too.
const NUMBERED = /^([ +-])\s*(\d+)\|(.*)$/;

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of diff.split("\n")) {
    const m = NUMBERED.exec(line);
    if (m) {
      out.push({ kind: m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx", no: Number(m[2]), text: m[3]! });
    } else if (line.startsWith("@@") || line.trim() === "..." || line.trim() === "…") {
      out.push({ kind: "gap", text: line.trim() });
    } else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    } else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ kind: "ctx", text: line.slice(1) });
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/** A new file's content as an all-added diff. */
export function addedLines(content: string): DiffLine[] {
  return content.replace(/\n$/, "").split("\n").map((text, i) => ({ kind: "add" as const, no: i + 1, text }));
}

/** Old/new text of a single replacement, for showing the edit before omp reports its own diff. */
export function replacementPreview(oldText: string, newText: string): DiffLine[] {
  return [
    ...oldText.replace(/\n$/, "").split("\n").map((text) => ({ kind: "del" as const, text })),
    ...newText.replace(/\n$/, "").split("\n").map((text) => ({ kind: "add" as const, text })),
  ];
}
