import type { DiffLine } from "../transcript/tools/diff";

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `git diff` of one file as numbered lines: added and context lines carry the new line number, removed lines the old one. */
export function parseUnified(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      if (out.length) out.push({ kind: "gap", text: "⋯" });
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
    } else if (!inHunk) continue; // the file header lines before the first hunk
    else if (line.startsWith("+")) out.push({ kind: "add", no: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", no: oldNo++, text: line.slice(1) });
    else if (line.startsWith(" ")) {
      out.push({ kind: "ctx", no: newNo++, text: line.slice(1) });
      oldNo++;
    }
    // "\ No newline at end of file" and the trailing empty line carry no content.
  }
  return out;
}
