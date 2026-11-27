// Builders for omp session entries, shared by the demo's seed conversations and its scripted runs.
import type { SessionEntry } from "../core/history";
import type { RawMessage } from "../core/messages";

export const MODEL = { provider: "cgs-claude", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export const text = (t: string): Block => ({ type: "text", text: t });
export const think = (t: string): Block => ({ type: "thinking", thinking: t });
export const call = (id: string, name: string, args: Record<string, unknown>): Block => ({ type: "toolCall", id, name, arguments: args });

/** Token use that grows with what was written, so the stats panel has something to show. */
function usageFor(blocks: Block[]) {
  const size = blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : b.type === "thinking" ? b.thinking.length : JSON.stringify(b.arguments).length), 0);
  const input = 900 + size * 2;
  const output = Math.ceil(size / 2.2);
  const cacheRead = 14_000 + size * 6;
  const cost = (input * 3 + output * 15 + cacheRead * 0.3) / 1_000_000;
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: Math.round(cost * 10_000) / 10_000 } };
}

export function assistantMessage(blocks: Block[], stopReason = "stop", timestamp = Date.now()): RawMessage & Record<string, unknown> {
  return { role: "assistant", content: blocks, api: "anthropic-messages", provider: MODEL.provider, model: MODEL.id, usage: usageFor(blocks), stopReason, timestamp };
}

export function toolResultMessage(callId: string, toolName: string, output: string, details?: unknown, isError = false, timestamp = Date.now()): RawMessage & Record<string, unknown> {
  return { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: output }], details, isError, timestamp };
}

/** An append-only conversation: each entry's parent is the one before it. */
export class Log {
  entries: SessionEntry[] = [];
  private n = 0;

  constructor(private clock: number) {}

  get lastTime(): number {
    return this.clock;
  }

  /** Live appends are stamped with the wall clock. */
  touch(now: number): void {
    this.clock = Math.max(this.clock, now);
  }

  add(message: RawMessage, gapMs = 4000): string {
    this.clock += gapMs;
    const id = `e${++this.n}`;
    this.entries.push({ id, parentId: this.entries.at(-1)?.id ?? null, type: "message", timestamp: new Date(this.clock).toISOString(), message: { ...message, timestamp: this.clock } });
    return id;
  }

  user(t: string, gapMs = 20_000) {
    return this.add({ role: "user", content: [{ type: "text", text: t }] }, gapMs);
  }

  assistant(blocks: Block[], stop = "stop") {
    return this.add(assistantMessage(blocks, stop));
  }

  result(callId: string, toolName: string, output: string, details?: unknown, isError = false) {
    return this.add(toolResultMessage(callId, toolName, output, details, isError), 1500);
  }

  developer(t: string) {
    return this.add({ role: "developer", content: [{ type: "text", text: t }] }, 500);
  }

  /** The entries up to and including `id`. */
  upTo(id: string): SessionEntry[] {
    const i = this.entries.findIndex((e) => e.id === id);
    return i < 0 ? this.entries.slice() : this.entries.slice(0, i + 1);
  }
}

/** omp's numbered edit diff: ` 3|context`, `-4|old`, `+4|new`. */
export const diffLines = (rows: [" " | "+" | "-", number, string][]): string => rows.map(([k, n, s]) => `${k}${n}|${s}`).join("\n");
