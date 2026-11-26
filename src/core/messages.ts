import { isRecord } from "./guards";
import type { AssistantMessage, NoticeItem, ToolCall, ToolResult } from "./types";

/** An omp message as it appears in frames and session entries (only the fields the client reads). */
export interface RawMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
  /** `custom` messages: which kind (`ttsr-injection`, ...). */
  customType?: string;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

/** Plain text of a message's content (a string, or the text blocks of a block list). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content).map((b) => (b?.type === "text" ? (b.text ?? "") : "")).join("");
}

/** Image blocks of a user message, so history can show what was attached. */
export function imagesOf(content: unknown): { mimeType: string; data: string }[] {
  const out: { mimeType: string; data: string }[] = [];
  for (const b of blocks(content) as { type?: string; mimeType?: string; data?: string }[]) {
    if (b?.type === "image" && b.mimeType && b.data) out.push({ mimeType: b.mimeType, data: b.data });
  }
  return out;
}

/** Splits an assistant snapshot into render items and the tool calls it contains. Empty text/thinking blocks are dropped. */
export function assistantFrom(id: string, m: RawMessage): { message: AssistantMessage; calls: ToolCall[] } {
  const message: AssistantMessage = { id, items: [], stopReason: m.stopReason, errorMessage: m.errorMessage };
  const calls: ToolCall[] = [];
  for (const b of blocks(m.content)) {
    if (b.type === "toolCall" && b.id) {
      message.items.push({ kind: "tool", callId: b.id });
      const args = b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
      calls.push({ id: b.id, name: b.name ?? "", args, status: "running" });
    } else if (b.type === "text" && b.text) message.items.push({ kind: "text", text: b.text });
    else if (b.type === "thinking" && b.thinking) message.items.push({ kind: "thinking", text: b.thinking });
  }
  return { message, calls };
}

export function resultFrom(m: RawMessage): ToolResult {
  return { content: Array.isArray(m.content) ? m.content : [], isError: !!m.isError, details: m.details };
}

/** An assistant message with text and no tool calls is the reply (everything before it is process). */
export function isReply(m: AssistantMessage): boolean {
  return m.items.some((i) => i.kind === "text") && !m.items.some((i) => i.kind === "tool");
}

/** The tags the harness wraps its own text in; the model is told such blocks are not the user's. */
const HARNESS_BLOCK = /^<(system-[a-z][a-z-]*|irc|tangent-notice)\b[^>]*>\s*([\s\S]*?)\s*<\/\1>$/i;
const TONES: Record<string, NoticeItem["tone"]> = { "system-reminder": "reminder", "system-notice": "notice", "system-interrupt": "interrupt" };

/**
 * Text the harness put in front of the model, not the user: a rule injected after a stream rewind (`custom` message of type
 * `ttsr-injection`) and the reminders and notices omp adds as `developer` messages. They are shown as quiet cards (ADR 0037).
 */
export function noticeFrom(id: string, m: RawMessage): NoticeItem | undefined {
  const raw = textOf(m.content).trim();
  if (m.role === "custom" && m.customType === "ttsr-injection") {
    const rules = isRecord(m.details) && Array.isArray(m.details.rules) ? m.details.rules.filter((r): r is string => typeof r === "string") : [];
    return { kind: "notice", id, tone: "rule", ...(rules.length ? { names: rules.join(", ") } : {}), text: HARNESS_BLOCK.exec(raw)?.[2] ?? raw };
  }
  if (m.role !== "developer" || !raw) return undefined;
  const block = HARNESS_BLOCK.exec(raw);
  return { kind: "notice", id, tone: (block && TONES[block[1]!.toLowerCase()]) || "other", text: block?.[2] ?? raw };
}
