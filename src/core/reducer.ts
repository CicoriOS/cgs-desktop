import { assistantFrom, imagesOf, isReply, type RawMessage, resultFrom, textOf } from "./messages";
import type { ClientState, Dialog, RingState, ToolCall, Turn } from "./types";

export function initialState(): ClientState {
  return {
    connection: "connecting",
    device: "",
    activeCwd: "",
    title: "",
    thinking: { resolved: "high", configured: "auto" },
    turns: [],
    tools: {},
    run: { state: "idle", streaming: false },
    queue: [],
    dialogs: [],
    workspaces: [],
    children: [],
    btw: [],
  };
}

/** A frame from omp (or the bridge) that is not a command response. Unknown fields stay untyped on purpose: omp adds them. */
export interface EventFrame {
  type: string;
  messageId?: string;
  /** A message object in message_* frames; a string in the confirm dialog and notify requests. */
  message?: RawMessage | string;
  assistantMessageEvent?: { type?: string; partial?: RawMessage };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { content?: unknown[]; details?: unknown };
  isError?: boolean;
  steering?: string[];
  followUp?: string[];
  record?: { id: string; question: string; answer?: string; status?: string };
  recordId?: string;
  delta?: string;
  // extension_ui_request
  id?: string;
  method?: string;
  title?: string;
  text?: string;
  options?: string[];
  optionDetails?: { description?: string }[];
  initialIndex?: number;
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: number[];
  markableCount?: number;
  placeholder?: string;
  secret?: boolean;
  prefill?: string;
  html?: string;
  targetId?: string;
}

/** The dialog an `extension_ui_request` asks for, if its method is one the client answers. */
export function dialogFrom(f: EventFrame): Dialog | undefined {
  if (!f.id) return undefined;
  switch (f.method) {
    case "form":
      return typeof f.html === "string" ? { id: f.id, method: "form", html: f.html } : undefined;
    case "select":
      return { id: f.id, method: "select", title: f.title ?? "", options: f.options ?? [], details: f.optionDetails?.map((d) => d.description), initialIndex: f.initialIndex, marker: f.selectionMarker, checkedIndices: f.checkedIndices, markableCount: f.markableCount };
    case "confirm":
      return { id: f.id, method: "confirm", title: f.title ?? "", message: typeof f.message === "string" ? f.message : "" };
    case "input":
      return { id: f.id, method: "input", title: f.title ?? "", placeholder: f.placeholder, secret: f.secret };
    case "editor":
      return { id: f.id, method: "editor", title: f.title ?? "", prefill: f.prefill };
    default:
      return undefined;
  }
}

let turnSeq = 0;
export const newTurnId = () => `t${++turnSeq}`;

function replaceLast(turns: Turn[], f: (t: Turn) => Turn): Turn[] {
  const last = turns.at(-1);
  return last ? [...turns.slice(0, -1), f(last)] : turns;
}

function upsertTools(tools: Record<string, ToolCall>, calls: ToolCall[]): Record<string, ToolCall> {
  if (!calls.length) return tools;
  const next = { ...tools };
  for (const c of calls) {
    const old = next[c.id];
    next[c.id] = { ...c, status: old?.status ?? "running", result: old?.result, name: c.name || old?.name || "", args: { ...old?.args, ...c.args } };
  }
  return next;
}

function setResult(tools: Record<string, ToolCall>, id: string, result: ToolCall["result"], name = ""): Record<string, ToolCall> {
  if (!result) return tools;
  const call = tools[id] ?? { id, name, args: {} };
  return { ...tools, [id]: { ...call, result, status: result.isError ? "fail" : "ok" } };
}

function onMessage(s: ClientState, f: EventFrame, now: number): ClientState {
  const m = (typeof f.message === "object" ? f.message : undefined) ?? f.assistantMessageEvent?.partial;
  if (!m) return s;

  if (m.role === "user") {
    if (f.type !== "message_start") return s;
    const text = textOf(m.content);
    const pendingIdx = s.turns.findIndex((t) => t.pending && t.user.text.trim() === text.trim());
    if (pendingIdx >= 0) {
      const turns = s.turns.slice();
      turns[pendingIdx] = { ...turns[pendingIdx]!, pending: false };
      return { ...s, turns };
    }
    const closed = s.turns.map((t) => (t.state === "running" ? { ...t, state: "done" as const } : t));
    const images = imagesOf(m.content);
    const turn: Turn = { id: newTurnId(), user: { text, ...(images.length ? { images } : {}) }, assistant: [], state: "running", startedAt: now };
    return { ...s, turns: [...closed, turn], title: s.title || text.slice(0, 60) };
  }

  if (m.role === "toolResult") {
    return m.toolCallId ? { ...s, tools: setResult(s.tools, m.toolCallId, resultFrom(m)) } : s;
  }

  if (m.role !== "assistant" || !f.messageId) return s;
  const { message, calls } = assistantFrom(f.messageId, m);
  const turns = s.turns.length
    ? s.turns
    : [{ id: newTurnId(), user: { text: "" }, assistant: [], state: "running" as const, startedAt: now }];
  const next = replaceLast(turns, (t) => {
    const i = t.assistant.findIndex((a) => a.id === message.id);
    const assistant = i >= 0 ? t.assistant.map((a, k) => (k === i ? message : a)) : [...t.assistant, message];
    return { ...t, assistant, replyAt: t.replyAt ?? (isReply(message) ? now : undefined), ...(t.pending ? { pending: false } : {}) };
  });
  return { ...s, turns: next, tools: upsertTools(s.tools, calls) };
}

/** Folds one event frame into the state. Pure: `now` is passed in. Frames it does not know leave the state untouched. */
export function applyFrame(s: ClientState, f: EventFrame, now: number): ClientState {
  switch (f.type) {
    case "ready":
      return { ...s, connection: "ready" };
    case "message_start":
    case "message_update":
    case "message_end":
      return onMessage(s, f, now);
    case "agent_start":
      return { ...s, run: { ...s.run, streaming: true }, turns: replaceLast(s.turns, (t) => (t.state === "running" || t.pending ? t : { ...t, state: "running" })) };
    case "tool_execution_start": {
      if (!f.toolCallId) return s;
      const old = s.tools[f.toolCallId];
      if (old?.result) return s;
      return { ...s, tools: { ...s.tools, [f.toolCallId]: { id: f.toolCallId, name: f.toolName ?? old?.name ?? "", args: { ...f.args, ...old?.args }, status: "running" } } };
    }
    case "tool_execution_end": {
      if (!f.toolCallId || s.tools[f.toolCallId]?.result) return s;
      return { ...s, tools: setResult(s.tools, f.toolCallId, { content: f.result?.content ?? [], details: f.result?.details, isError: !!f.isError }, f.toolName) };
    }
    case "extension_ui_request": {
      if (f.method === "cancel") return { ...s, dialogs: s.dialogs.filter((d) => d.id !== f.targetId) }; // omp closed it (timeout, abort)
      const d = dialogFrom(f);
      return d && !s.dialogs.some((x) => x.id === d.id) ? { ...s, dialogs: [...s.dialogs, d] } : s;
    }
    case "queue_update":
      return { ...s, queue: [...(f.steering ?? []).map((text) => ({ text, mode: "steer" as const })), ...(f.followUp ?? []).map((text) => ({ text, mode: "followUp" as const }))] };
    case "btw_record": {
      const rec = f.record;
      if (!rec) return s;
      const row = { id: rec.id, question: rec.question, answer: rec.answer ?? "", status: rec.status };
      const i = s.btw.findIndex((r) => r.id === rec.id);
      return { ...s, btw: i >= 0 ? s.btw.map((r, k) => (k === i ? row : r)) : [row, ...s.btw] };
    }
    case "btw_delta":
      return { ...s, btw: s.btw.map((r) => (r.id === f.recordId ? { ...r, answer: r.answer + (f.delta ?? "") } : r)) };
    default:
      return s;
  }
}

/** The ring state a frame asks for while a prompt runs, if any. The client applies it with the thinking hold. */
export function ringFor(f: EventFrame): RingState | undefined {
  if (f.type === "tool_execution_start") return "work";
  if (f.type !== "message_update") return undefined;
  const ev = f.assistantMessageEvent?.type ?? "";
  if (ev.startsWith("thinking_") && ev !== "thinking_end") return "think";
  if (ev.startsWith("text_") || ev.startsWith("toolcall_") || ev === "thinking_end") return "work";
  return undefined;
}
