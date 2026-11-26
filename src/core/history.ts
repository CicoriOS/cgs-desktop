import { assistantFrom, imagesOf, isReply, noticeFrom, type RawMessage, resultFrom, textOf } from "./messages";
import { newTurnId } from "./reducer";
import type { ToolCall, Turn } from "./types";

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  message?: RawMessage;
  /** `custom_message` entries carry their message fields at the top level. */
  customType?: string;
  content?: unknown;
  details?: unknown;
}

/** The entries on the path from the root to `leafId` (default: the last entry), oldest first. */
export function activeBranch(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: SessionEntry[] = [];
  for (let e = byId.get(leafId ?? entries.at(-1)?.id ?? ""); e; e = e.parentId ? byId.get(e.parentId) : undefined) path.push(e);
  return path.reverse();
}

interface Item {
  id?: string;
  message: RawMessage;
}

/**
 * Rebuilds turns from a saved transcript: a user message starts a turn, assistant messages and tool results attach to it.
 * `id` is the session entry id when known; it becomes the assistant message id.
 */
export function turnsFromMessages(items: Item[]): { turns: Turn[]; tools: Record<string, ToolCall> } {
  const turns: Turn[] = [];
  const tools: Record<string, ToolCall> = {};
  const results: Record<string, RawMessage> = {};
  for (const { message } of items) if (message.role === "toolResult" && message.toolCallId) results[message.toolCallId] = message;

  let n = 0;
  for (const { id, message: m } of items) {
    if (m.role === "user") {
      const images = imagesOf(m.content);
      turns.push({
        id: newTurnId(),
        user: { text: textOf(m.content), ...(images.length ? { images } : {}) },
        assistant: [],
        state: "done",
        startedAt: m.timestamp ?? 0,
      });
    } else if (m.role === "assistant") {
      let turn = turns.at(-1);
      if (!turn) {
        turn = { id: newTurnId(), user: { text: "" }, assistant: [], state: "done", startedAt: m.timestamp ?? 0 };
        turns.push(turn);
      }
      const { message, calls } = assistantFrom(id ?? `h${n}`, m);
      n++;
      for (const c of calls) {
        const r = results[c.id];
        tools[c.id] = r ? { ...c, result: resultFrom(r), status: r.isError ? "fail" : "ok" } : { ...c, status: "ok" };
      }
      turn.assistant.push(message);
      if (isReply(message)) turn.replyAt ??= m.timestamp ?? turn.startedAt;
      if (m.stopReason === "error") {
        turn.state = "failed";
        turn.errorText = m.errorMessage;
      }
    } else if (m.role === "developer" || m.role === "custom") {
      const notice = noticeFrom(id ?? `h${n}`, m);
      if (!notice) continue;
      let turn = turns.at(-1);
      if (!turn) {
        turn = { id: newTurnId(), user: { text: "" }, assistant: [], state: "done", startedAt: m.timestamp ?? 0 };
        turns.push(turn);
      }
      turn.assistant.push({ id: `notice-${notice.id}`, items: [notice] });
    }
  }
  return { turns, tools };
}

/** From `get_tree`-style entries: only the active branch, only message entries, with entry ids. */
export function turnsFromEntries(entries: SessionEntry[], leafId?: string | null) {
  const items = activeBranch(entries, leafId).flatMap((e) => {
    if (e.type === "message" && e.message) return [{ id: e.id, message: e.message }];
    // A custom message (a rule injected after a rewind) is stored beside the entry's own fields, not under `message`.
    if (e.type === "custom_message") return [{ id: e.id, message: { role: "custom", customType: e.customType, content: e.content, details: e.details } }];
    return [];
  });
  return turnsFromMessages(items);
}

/** For each turn of the active branch, the entry a fork should end at: its last assistant message, else the user message. */
export function turnTailIds(entries: SessionEntry[], leafId?: string | null): string[] {
  const tails: string[] = [];
  for (const e of activeBranch(entries, leafId)) {
    const role = e.type === "message" ? e.message?.role : undefined;
    if (role === "user") tails.push(e.id);
    else if (role === "assistant" && tails.length) tails[tails.length - 1] = e.id;
  }
  return tails;
}
