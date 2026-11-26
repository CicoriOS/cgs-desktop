import type { NoticeItem, ToolCall, Turn } from "../../core/types";
import { t } from "../../i18n";

/** One line of a turn's process: a thought, a run of consecutive tool calls, or a note the model wrote between calls. */
export type Step =
  | { kind: "thought"; text: string }
  | { kind: "note"; text: string }
  | { kind: "calls"; calls: ToolCall[] }
  /** The ask tool: the question and the user's answer are part of the conversation, so it is never folded into the process. */
  | { kind: "ask"; call: ToolCall }
  /** Text the harness gave the model (a reminder, an injected rule): a folded card. */
  | { kind: "notice"; item: NoticeItem };

export interface TurnView {
  steps: Step[];
  /** Text of assistant messages that carry no tool call: the answer itself. */
  replies: { id: string; text: string; stopReason?: string }[];
  callCount: number;
  hasThinking: boolean;
}

/**
 * Splits a turn the way the UI shows it. Thinking, tool calls and any text that comes together with tool calls are the process;
 * text in a message without tool calls is the reply. Once a reply exists the process folds into one summary line.
 */
export function viewTurn(turn: Turn, tools: Record<string, ToolCall>): TurnView {
  const steps: Step[] = [];
  const replies: TurnView["replies"] = [];
  let callCount = 0;
  let hasThinking = false;
  const pushCall = (call: ToolCall) => {
    if (call.name === "ask") {
      steps.push({ kind: "ask", call });
      return;
    }
    callCount++;
    const last = steps.at(-1);
    if (last?.kind === "calls") last.calls.push(call);
    else steps.push({ kind: "calls", calls: [call] });
  };
  for (const m of turn.assistant) {
    const hasCall = m.items.some((i) => i.kind === "tool");
    const texts: string[] = [];
    for (const item of m.items) {
      if (item.kind === "tool") {
        const call = tools[item.callId];
        if (call) pushCall(call);
      } else if (item.kind === "notice") {
        steps.push({ kind: "notice", item });
      } else if (item.kind === "thinking") {
        hasThinking = true;
        steps.push({ kind: "thought", text: item.text });
      } else if (hasCall) steps.push({ kind: "note", text: item.text });
      else texts.push(item.text);
    }
    if (texts.length) replies.push({ id: m.id, text: texts.join("\n\n"), stopReason: m.stopReason });
  }
  return { steps, replies, callCount, hasThinking };
}

/** Names of a call run: `read ×3、bash`. */
export function callNames(calls: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(t("sep.list"));
}
