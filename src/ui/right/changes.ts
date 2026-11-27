import type { ToolCall, Turn } from "../../core/types";
import { toolCardKind } from "../transcript/tools/cardKinds";
import { addedLines, type DiffLine, diffStats } from "../transcript/tools/diff";
import { str } from "../transcript/tools/details";
import { editFiles } from "../transcript/tools/ToolCard";

export interface TaskChange {
  /** As the tool reported it: usually relative to the workspace. */
  path: string;
  added: number;
  removed: number;
  /** Every edit of the file in order, separated by a gap row. */
  lines: DiffLine[];
  edits: number;
}

/** What this task did to files: the successful edit and write calls of the session, folded per file in the order the files were first touched. */
export function taskChanges(turns: readonly Turn[], tools: Record<string, ToolCall>): TaskChange[] {
  const byPath = new Map<string, TaskChange>();
  const add = (path: string, lines: DiffLine[]) => {
    if (!path || !lines.length) return;
    const stats = diffStats(lines);
    const known = byPath.get(path);
    if (!known) byPath.set(path, { path, added: stats.added, removed: stats.removed, lines, edits: 1 });
    else {
      known.added += stats.added;
      known.removed += stats.removed;
      known.lines = [...known.lines, { kind: "gap", text: "⋯" }, ...lines];
      known.edits += 1;
    }
  };
  for (const turn of turns) {
    for (const message of turn.assistant) {
      for (const item of message.items) {
        const call = item.kind === "tool" ? tools[item.callId] : undefined;
        if (!call?.result || call.result.isError) continue;
        const kind = toolCardKind(call.name);
        if (kind === "edit") for (const file of editFiles(call)) add(file.path, file.lines);
        else if (kind === "write") {
          const content = str(call.args.content);
          if (content !== undefined) add(str(call.args.path) ?? str(call.args.file_path) ?? "", addedLines(content));
        }
      }
    }
  }
  return [...byPath.values()];
}
