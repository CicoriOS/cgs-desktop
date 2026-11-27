import type { ToolCall } from "../../../core/types";

export const str = (v: unknown) => typeof v === "string" ? v : undefined;
export const rec = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
export const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

export function evalCells(call: ToolCall) {
  const details = rec(call.result?.details);
  const cells = list(details.cells).map(rec).filter(c => typeof c.code === "string");
  const fallback = str(call.args.code);
  return (cells.length ? cells : fallback === undefined ? [] : [{ code: fallback } as Record<string, unknown>]).map(cell => {
    const language = str(cell.language) ?? str(details.language) ?? str(call.args.language);
    return { code: str(cell.code) ?? "", language: language === "py" ? "python" : language === "js" ? "javascript" : language,
      title: str(cell.title), status: str(cell.status), output: str(cell.output), duration: cell.durationMs };
  });
}

/**
 * Images a tool result carries, as data URLs. The result's own content blocks come first: they are what was sent to the model,
 * so omp has already scaled and recompressed them (the same bytes the terminal shows). `details.images` is only a fallback.
 * Only inline raster images are accepted.
 */
export function resultImages(call: ToolCall): string[] {
  const inline = (values: unknown[]) => values.flatMap(value => {
    const { type, mimeType, data } = rec(value);
    return type === "image" && typeof mimeType === "string" && /^image\/(png|jpeg|gif|webp)$/.test(mimeType)
      && typeof data === "string" && /^[A-Za-z0-9+/]+=*$/.test(data) ? [`data:${mimeType};base64,${data}`] : [];
  });
  const fromContent = inline(list(call.result?.content));
  return fromContent.length ? fromContent : inline(list(rec(call.result?.details).images));
}

export const TODO_STATES = ["pending", "in_progress", "completed", "abandoned"] as const;
type TodoState = typeof TODO_STATES[number];

export function todoPhases(details: unknown) {
  return list(rec(details).phases).map(phase => ({
    name: str(rec(phase).name),
    tasks: list(rec(phase).tasks).flatMap(value => {
      const { content, status } = rec(value);
      return typeof content === "string" ? [{ content, status: TODO_STATES.find(s => s === status) ?? ("pending" satisfies TodoState) }] : [];
    }),
  }));
}
