import type { AssistantMessage, ToolCall, ToolResult } from "./types";

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
