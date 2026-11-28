import { t } from "../i18n";
import { isRecord } from "./guards";
import { assistantFrom, imagesOf, isReply, noticeFrom, type RawMessage, resultFrom, textOf } from "./messages";
import { mergeSubagents, subagentFromFrame, subagentsFromTaskDetails } from "./subagents";
import { parsePhases } from "./todos";
import type { ClientState, Controller, Dialog, NoticeItem, RingState, RunProgress, SubagentInfo, ToolCall, Turn } from "./types";

/** A streaming tool preview is kept to its tail: a long build log must not grow the state without bound. */
export const TOOL_STREAM_LIMIT = 64 * 1024;
/** Extension widgets are small text blocks; more or longer lines are clipped, and only the newest keys stay. */
const WIDGETS_MAX = 8;
const WIDGET_LINES = 12;
const WIDGET_LINE_CHARS = 400;
const STATUS_CHARS = 200;
/** Terminal colour codes in extension status/widget text (they are plain strings over RPC, but not guaranteed plain). */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function initialState(): ClientState {
  return {
    connection: "connecting",
    loading: false,
    compacting: false,
    device: "",
    activeCwd: "",
    title: "",
    thinking: { resolved: "high", configured: "auto" },
    turns: [],
    tools: {},
    run: { state: "idle", streaming: false },
    progress: { warnings: 0, statuses: {}, widgets: [] },
    queue: [],
    todos: [],
    subagents: [],
    dialogs: [],
    workspaces: [],
    workspacesLoaded: false,
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
  /** `tool_execution_update` (an `AgentToolResult`) and `tool_stream_update` (an edit preview). */
  partialResult?: unknown;
  update?: unknown;
  isError?: boolean;
  steering?: string[];
  followUp?: string[];
  record?: { id: string; question: string; answer?: string; status?: string };
  recordId?: string;
  delta?: string;
  /** subagent_lifecycle / subagent_progress */
  payload?: unknown;
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
  // extension_ui_request setStatus / setWidget
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  // The agent's own machinery: compaction, retries, cache warming, goal mode, reminders.
  reason?: string;
  action?: string;
  mode?: string;
  aborted?: boolean;
  willRetry?: boolean;
  skipped?: boolean;
  outcome?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  phase?: string;
  model?: string;
  from?: string;
  to?: string;
  role?: string;
  success?: boolean;
  goal?: { objective?: unknown; status?: unknown } | null;
  todos?: unknown[];
  // cgs_control (ADR 0047): the conversation, who controls it now, and whether this client may write.
  childId?: string;
  controller?: Controller | null;
  you?: boolean;
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

const setProgress = (s: ClientState, patch: Partial<RunProgress>): ClientState => ({ ...s, progress: { ...s.progress, ...patch } });

/** A toast is one state field; the component shows the newest text for a few seconds. */
const withToast = (s: ClientState, text: string): ClientState =>
  text ? { ...s, toast: { text: text.length > 300 ? `${text.slice(0, 299)}…` : text, seq: (s.toast?.seq ?? 0) + 1 } } : s;

/**
 * The text of a streaming update. `tool_execution_update` carries an `AgentToolResult` (bash/eval send their preview in
 * its text blocks); `tool_stream_update` carries an edit preview with per-file diffs.
 */
function previewText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []));
    return parts.length ? parts.join("") : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.content)) return previewText(value.content);
  if (Array.isArray(value.files)) {
    const files = value.files.flatMap((f) => {
      if (!isRecord(f)) return [];
      const body = typeof f.diff === "string" ? f.diff : typeof f.error === "string" ? f.error : "";
      return [typeof f.path === "string" ? [f.path, body].filter(Boolean).join("\n") : body];
    });
    return files.length ? files.join("\n\n") : undefined;
  }
  return undefined;
}

/** Folds a streaming preview into the call; a finished call ignores late frames. */
function applyToolStream(s: ClientState, f: EventFrame, now: number): ClientState {
  const id = f.toolCallId;
  if (!id) return s;
  const call = s.tools[id];
  if (call?.result) return s;
  const text = previewText(f.type === "tool_stream_update" ? f.update : f.partialResult);
  if (text === undefined) return s;
  const truncated = text.length > TOOL_STREAM_LIMIT;
  return {
    ...s,
    tools: {
      ...s.tools,
      [id]: {
        ...(call ?? { id, name: "", args: {}, status: "running" as const }),
        name: call?.name || f.toolName || "",
        stream: { text: truncated ? text.slice(-TOOL_STREAM_LIMIT) : text, at: now, ...(truncated ? { truncated: true } : {}) },
      },
    },
  };
}

/** `extension_ui_request` setStatus: text replaces the key's line, no text removes it. */
function applyExtensionStatus(s: ClientState, f: EventFrame): ClientState {
  if (!f.statusKey) return s;
  const statuses = { ...s.progress.statuses };
  const text = typeof f.statusText === "string" ? f.statusText.replace(ANSI, "").trim().slice(0, STATUS_CHARS) : "";
  if (text) statuses[f.statusKey] = text;
  else delete statuses[f.statusKey];
  return setProgress(s, { statuses });
}

/** `extension_ui_request` setWidget: lines replace the block's, no lines removes it. */
function applyExtensionWidget(s: ClientState, f: EventFrame): ClientState {
  if (!f.widgetKey) return s;
  const lines = Array.isArray(f.widgetLines)
    ? f.widgetLines.filter((l): l is string => typeof l === "string").map((l) => l.replace(ANSI, "").slice(0, WIDGET_LINE_CHARS)).slice(-WIDGET_LINES)
    : [];
  const rest = s.progress.widgets.filter((w) => w.key !== f.widgetKey);
  const widgets = lines.length
    ? [...rest, { key: f.widgetKey, lines, placement: f.widgetPlacement === "aboveEditor" ? ("aboveEditor" as const) : ("belowEditor" as const) }].slice(-WIDGETS_MAX)
    : rest;
  return setProgress(s, { widgets });
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
    next[c.id] = {
      ...c, status: old?.status ?? "running", result: old?.result, name: c.name || old?.name || "", args: { ...old?.args, ...c.args },
      ...(old?.startedAt !== undefined ? { startedAt: old.startedAt } : {}), ...(old?.stream ? { stream: old.stream } : {}),
    };
  }
  return next;
}

function setResult(tools: Record<string, ToolCall>, id: string, result: ToolCall["result"], name = ""): Record<string, ToolCall> {
  if (!result) return tools;
  const call = tools[id] ?? { id, name, args: {} };
  return { ...tools, [id]: { ...call, result, status: result.isError ? "fail" : "ok", stream: undefined } };
}

/** What a finished tool call tells beyond its own card: a `todo` result is the new list, a `task` result lists the subagents it ran. */
function foldToolResult(s: ClientState, call: ToolCall | undefined): ClientState {
  if (!call?.result || call.result.isError) return s;
  const details = call.result.details;
  if (call.name === "todo") return isRecord(details) && Array.isArray(details.phases) ? { ...s, todos: parsePhases(details.phases) } : s;
  if (call.name === "task") return { ...s, subagents: mergeSubagents(s.subagents, subagentsFromTaskDetails(details, call.id)) };
  return s;
}

/** The subagents the `task` results of a rebuilt history list. */
export function subagentsFromTools(tools: Record<string, ToolCall>): SubagentInfo[] {
  return mergeSubagents([], Object.values(tools).flatMap((c) => (c.name === "task" && c.result && !c.result.isError ? subagentsFromTaskDetails(c.result.details, c.id) : [])));
}

/** A notice goes in as a message of its own, in arrival order; the same frame twice (start, end) adds it once. */
function addNotice(s: ClientState, notice: NoticeItem, now: number): ClientState {
  const turns = s.turns.length ? s.turns : [{ id: newTurnId(), user: { text: "" }, assistant: [], state: "running" as const, startedAt: now }];
  const last = turns.at(-1)!;
  if (last.assistant.some((a) => a.items.some((i) => i.kind === "notice" && i.id === notice.id))) return s;
  // An IPC message can arrive as an `irc_message` frame and as a message of its own: the same text right after itself is one.
  const prev = last.assistant.at(-1)?.items[0];
  if (notice.tone === "ipc" && prev?.kind === "notice" && prev.tone === "ipc" && prev.text === notice.text) return s;
  return { ...s, turns: replaceLast(turns, (t) => ({ ...t, assistant: [...t.assistant, { id: `notice-${notice.id}`, items: [notice] }] })) };
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
    if (!m.toolCallId) return s;
    const tools = setResult(s.tools, m.toolCallId, resultFrom(m));
    return foldToolResult({ ...s, tools }, tools[m.toolCallId]);
  }

  if (m.role === "developer" || m.role === "custom") {
    const notice = noticeFrom(f.messageId ?? `n${s.turns.length}:${textOf(m.content).length}`, m);
    return notice ? addNotice(s, notice, now) : s;
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
      return {
        ...s,
        tools: {
          ...s.tools,
          [f.toolCallId]: {
            id: f.toolCallId, name: f.toolName ?? old?.name ?? "", args: { ...f.args, ...old?.args }, status: "running",
            startedAt: old?.startedAt ?? now, ...(old?.stream ? { stream: old.stream } : {}),
          },
        },
      };
    }
    case "tool_execution_update":
    case "tool_stream_update":
      return applyToolStream(s, f, now);
    case "agent_end":
      // Compaction, retries and warming describe one run; the result frames that follow carry the outcome.
      return setProgress(s, { compaction: undefined, retry: undefined, fallback: undefined, warming: undefined });
    case "tool_execution_end": {
      if (!f.toolCallId || s.tools[f.toolCallId]?.result) return s;
      const tools = setResult(s.tools, f.toolCallId, { content: f.result?.content ?? [], details: f.result?.details, isError: !!f.isError }, f.toolName);
      return foldToolResult({ ...s, tools }, tools[f.toolCallId]);
    }
    case "auto_compaction_start":
      return setProgress(s, { compaction: { kind: "auto", reason: f.reason, action: f.action, startedAt: now } });
    case "manual_compaction_start":
      return setProgress(s, { compaction: { kind: "manual", mode: f.mode, startedAt: now } });
    case "auto_compaction_end":
    case "manual_compaction_end":
      return setProgress(s, { compaction: undefined });
    case "auto_retry_start":
      return setProgress(s, {
        retry: {
          attempt: typeof f.attempt === "number" ? f.attempt : 1,
          maxAttempts: typeof f.maxAttempts === "number" ? f.maxAttempts : 1,
          delayMs: typeof f.delayMs === "number" ? f.delayMs : undefined,
          reason: f.errorMessage ?? "",
          startedAt: now,
        },
      });
    case "auto_retry_end":
      return setProgress(s, { retry: undefined });
    case "retry_fallback_applied":
      if (!f.to) return s;
      return setProgress(s, { fallback: { from: f.from ?? "", to: f.to, role: f.role, reason: f.reason } });
    case "retry_fallback_succeeded":
      return f.model
        ? setProgress(s, { fallback: { from: s.progress.fallback?.from ?? "", to: f.model, role: f.role ?? s.progress.fallback?.role, reason: s.progress.fallback?.reason, ok: true } })
        : s;
    case "cache_warming_start":
      return setProgress(s, { warming: { phase: f.phase, method: f.method, model: f.model } });
    case "cache_warming_end":
      return setProgress(s, { warming: undefined });
    case "config_warnings_changed":
      return setProgress(s, { warnings: s.progress.warnings + 1 });
    case "goal_updated": {
      const goal = isRecord(f.goal) && typeof f.goal.objective === "string" ? { objective: f.goal.objective, status: typeof f.goal.status === "string" ? f.goal.status : undefined } : undefined;
      return setProgress(s, { goal });
    }
    case "todo_reminder":
      // The reminder itself reaches the transcript as the developer message omp sends with it (a `todo` notice).
      return s;
    case "irc_message": {
      const notice = typeof f.message === "object" ? noticeFrom(`irc${now}`, f.message) : undefined;
      return notice ? addNotice(s, notice, now) : s;
    }
    case "subagent_lifecycle":
    case "subagent_progress": {
      const info = subagentFromFrame(f);
      const started = f.type === "subagent_lifecycle" && isRecord(f.payload) && f.payload.status === "started";
      return info ? { ...s, subagents: mergeSubagents(s.subagents, [info], started) } : s;
    }
    case "extension_ui_request": {
      if (f.method === "cancel") return { ...s, dialogs: s.dialogs.filter((d) => d.id !== f.targetId) }; // omp closed it (timeout, abort)
      if (f.method === "setStatus") return applyExtensionStatus(s, f);
      if (f.method === "setWidget") return applyExtensionWidget(s, f);
      const d = dialogFrom(f);
      return d && !s.dialogs.some((x) => x.id === d.id) ? { ...s, dialogs: [...s.dialogs, d] } : s;
    }
    case "queue_update":
      return { ...s, queue: [...(f.steering ?? []).map((text) => ({ text, mode: "steer" as const })), ...(f.followUp ?? []).map((text) => ({ text, mode: "followUp" as const }))] };
    case "cgs_control": {
      const c = f.controller;
      const controller: Controller | undefined = c && typeof c.name === "string" ? { kind: c.kind, name: c.name } : undefined;
      return { ...s, control: { controller, you: f.you === true } };
    }
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
