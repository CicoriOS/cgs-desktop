// A stand-in for one `omp --mode rpc-ui` child. It keeps a conversation, answers the RPC commands the client sends, and plays scripted
// runs as the same frames omp streams (message_*, tool_execution_*, subagent_*, extension_ui_request, prompt_result, session_settled).
import type { SessionEntry } from "../core/history";
import { type RawMessage, textOf } from "../core/messages";
import type { UsageMessage } from "../core/stats";
import type { BtwRecord, ChildStatus, ModelPicker, ThinkingLevel } from "../core/types";
import { assistantMessage, type Block, Log, MODEL, toolResultMessage } from "./log";

export type Listener = (frame: string) => void;
export type Script = (run: Run) => Promise<void>;
type Cmd = { type: string; id?: string } & Record<string, unknown>;
type Frame = Record<string, unknown>;

export const MODELS = [
  { provider: "cgs-claude", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", role: "default" },
  { provider: "cgs-claude", id: "claude-opus-5", name: "Claude Opus 5", role: "slow" },
  { provider: "cgs-openai", id: "gpt-5.5", name: "GPT-5.5" },
  { provider: "cgs-gemini", id: "gemini-3-pro", name: "Gemini 3 Pro" },
  { provider: "cgs-openai", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", role: "smol" },
];
const LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

export interface SubagentRec {
  id: string;
  agent: string;
  index: number;
  description: string;
  assignment: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  level: string;
  model: string;
  parentToolCallId?: string;
  contextTokens: number;
}

export interface ToolSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** How long the tool runs. */
  ms: number;
  output: string;
  details?: unknown;
  isError?: boolean;
  /** What the tool did beside answering: runs when it finishes (a file edit lands on the demo's disk). */
  effect?: () => void;
}

class Aborted extends Error {}

const chunks = (s: string, n: number): string[] => {
  const chars = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(""));
  return out;
};

export interface SessionInit {
  id: string;
  cwd: string;
  path: string;
  title?: string;
  log: Log;
  todos?: unknown[];
  subagents?: SubagentRec[];
  transcripts?: Record<string, RawMessage[]>;
  /** Runs the first time a client attaches (a conversation that is "in progress" the moment it is opened). */
  onFirstAttach?: { prompt: string; script: Script };
  /** Runs for every prompt the user sends. */
  pick: (prompt: string) => Script;
  /** The session as it was before a fork becomes a session of its own. */
  archive: (entries: SessionEntry[], title: string, cwd: string, path: string, at: number) => void;
}

export class DemoSession {
  readonly id: string;
  readonly cwd: string;
  path: string;
  title: string;
  log: Log;
  todos: unknown[];
  live = false;
  unseen = false;
  model: { provider: string; id: string; name: string } = MODEL;
  level: ThinkingLevel = "high";
  configured: ThinkingLevel | "auto" = "auto";
  run?: { ac: AbortController; thinking: boolean };
  partial?: Frame;
  readonly dialogs = new Map<string, { frame: Frame; answer: PromiseWithResolvers<Record<string, unknown>> }>();
  steering: string[] = [];
  followUp: string[] = [];
  readonly subagents = new Map<string, SubagentRec>();
  readonly transcripts = new Map<string, RawMessage[]>();
  private readonly listeners = new Set<Listener>();
  private btw: BtwRecord[] = [];
  private btwAbort?: AbortController;
  private msgSeq = 0;
  private forkSeq = 0;
  private first?: SessionInit["onFirstAttach"];
  private takeover?: string;

  constructor(private readonly init: SessionInit) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.path = init.path;
    this.title = init.title ?? "";
    this.log = init.log;
    this.todos = init.todos ?? [];
    this.first = init.onFirstAttach;
    for (const s of init.subagents ?? []) this.subagents.set(s.id, s);
    for (const [id, m] of Object.entries(init.transcripts ?? {})) this.transcripts.set(id, m);
  }

  // ------------------------------------------------------------------ outward state
  get ring(): "idle" | "work" | "think" {
    return this.run ? (this.run.thinking ? "think" : "work") : "idle";
  }

  get updatedAt(): number {
    return this.log.lastTime;
  }

  get shownTitle(): string {
    if (this.title) return this.title;
    const first = this.log.entries.find((e) => e.message?.role === "user");
    return first?.message ? textOf(first.message.content).slice(0, 60) : "";
  }

  child(): ChildStatus {
    return { id: this.id, cwd: this.cwd, sessionPath: this.path, title: this.shownTitle || undefined, updatedAt: this.updatedAt, ring: this.ring, level: this.level, unseen: this.unseen };
  }

  // ------------------------------------------------------------------ attachments
  attach(listener: Listener): void {
    this.listeners.add(listener);
    this.unseen = false;
    if (this.first && !this.run) {
      const { prompt, script } = this.first;
      this.first = undefined;
      this.startRun(prompt, script);
    }
  }

  detach(listener: Listener): void {
    this.listeners.delete(listener);
  }

  emit(frame: Frame): void {
    const text = JSON.stringify(frame);
    for (const l of this.listeners) l(text);
  }

  nextMessageId(): string {
    return `msg-${this.id}-${++this.msgSeq}`;
  }

  // ------------------------------------------------------------------ runs
  startRun(prompt: string, script: Script): void {
    const ac = new AbortController();
    this.run = { ac, thinking: false };
    this.emit({ type: "agent_start" });
    this.log.touch(Date.now());
    const user: RawMessage = { role: "user", content: [{ type: "text", text: prompt }] };
    this.log.add(user, 0);
    this.emit({ type: "message_start", message: user });
    this.emit({ type: "message_end", message: user });
    void (async () => {
      let status = "completed";
      let error: string | undefined;
      try {
        await script(new Run(this, ac.signal));
      } catch (e) {
        if (e instanceof Aborted) status = "aborted";
        else {
          status = "error";
          error = e instanceof Error ? e.message : String(e);
        }
      }
      this.finishRun(status, error);
    })();
  }

  private finishRun(status: string, error?: string): void {
    this.run = undefined;
    this.partial = undefined;
    this.dialogs.clear();
    this.emit({ type: "agent_end" });
    const handoff = this.takeover;
    this.takeover = undefined;
    if (status === "aborted" && handoff) {
      this.emit({ type: "prompt_result", status: "aborted", sessionSettled: false });
      this.startRun(handoff, this.init.pick(handoff));
      return;
    }
    const queued = [...this.steering, ...this.followUp];
    if (status === "completed" && queued.length) {
      this.steering = [];
      this.followUp = [];
      this.emit({ type: "queue_update", steering: [], followUp: [] });
      this.emit({ type: "prompt_result", status, sessionSettled: false });
      const next = queued.join("\n");
      this.startRun(next, this.init.pick(next));
      return;
    }
    this.emit({ type: "prompt_result", status, sessionSettled: status !== "completed", ...(error ? { error: { message: error } } : {}) });
    if (status === "completed") this.emit({ type: "session_settled" });
    if (!this.listeners.size) this.unseen = true;
  }

  // ------------------------------------------------------------------ commands
  handle(cmd: Cmd, from: Listener): void {
    const ok = (data: unknown = {}) => from(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data }));
    const fail = (error: string) => from(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: false, error }));
    const str = (k: string) => (typeof cmd[k] === "string" ? (cmd[k] as string) : "");
    switch (cmd.type) {
      case "get_state":
        return ok({
          model: this.model, thinkingLevel: this.level, configuredThinkingLevel: this.configured, sessionFile: this.path,
          isStreaming: !!this.run, isSettled: !this.run, queuedMessages: { steering: this.steering, followUp: this.followUp }, todoPhases: this.todos,
        });
      case "get_entries": {
        const leafId = this.log.entries.at(-1)?.id ?? null;
        if (cmd.bridgeSnapshot) {
          from(JSON.stringify({
            type: "bridge_snapshot", ring: this.ring, level: this.level, partial: this.partial,
            dialogs: [...this.dialogs.values()].map((d) => d.frame), queue: { type: "queue_update", steering: this.steering, followUp: this.followUp },
          }));
        }
        return ok({ entries: this.log.entries, leafId });
      }
      case "set_title_language":
      case "set_subagent_subscription":
        return ok();
      case "get_subagents":
        return ok({ subagents: [...this.subagents.values()].map((s) => ({
          id: s.id, agent: s.agent, index: s.index, description: s.description, assignment: s.assignment, status: s.status,
          resolvedThinkingLevel: s.level, resolvedModel: s.model, parentToolCallId: s.parentToolCallId,
          progress: { contextTokens: s.contextTokens, contextWindow: 200_000 },
        })) });
      case "get_subagent_messages": {
        const messages = this.transcripts.get(str("subagentId"));
        if (!messages) return fail("Unknown subagent");
        const from0 = typeof cmd.fromByte === "number" ? cmd.fromByte : 0;
        return ok({ messages: messages.slice(from0), nextByte: messages.length, reset: false });
      }
      case "get_model_picker": {
        const q = str("query").toLowerCase();
        const rows = MODELS.filter((m) => !q || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q))
          .map((m) => ({ ...m, current: m.id === this.model.id && m.provider === this.model.provider }));
        const picker: ModelPicker = { rows, recent: q ? 0 : Math.min(2, rows.length), total: rows.length };
        return ok(picker);
      }
      case "get_available_thinking_levels":
        return ok({ levels: LEVELS });
      case "set_model": {
        const m = MODELS.find((x) => x.provider === str("provider") && x.id === str("modelId"));
        if (!m) return fail("Unknown model");
        this.model = m;
        ok();
        return this.emit({ type: "model_changed" });
      }
      case "set_thinking_level": {
        const level = str("level");
        this.configured = level === "auto" ? "auto" : (level as ThinkingLevel);
        this.level = level === "auto" ? "high" : (level as ThinkingLevel);
        ok();
        return this.emit({ type: "thinking_level_changed", resolved: this.level, configured: this.configured });
      }
      case "set_session_name":
        this.title = str("name");
        return ok();
      case "prompt": {
        const message = str("message").trim();
        if (this.run) return fail("Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.");
        if (message.startsWith("/")) {
          ok({ agentInvoked: false });
          setTimeout(() => this.emit({ type: "command_output", text: message.startsWith("/compact") ? "Compacted context: 142k → 31k tokens (snapcompact)." : `Unknown command: ${message}` }), 1400);
          return;
        }
        ok({ agentInvoked: true });
        return this.startRun(message, this.init.pick(message));
      }
      case "steer": {
        const message = str("message").trim();
        if (!this.run) {
          ok({ agentInvoked: true });
          return this.startRun(message, this.init.pick(message));
        }
        this.steering.push(message);
        ok();
        return this.emit({ type: "queue_update", steering: this.steering, followUp: this.followUp });
      }
      case "abort":
        this.run?.ac.abort();
        return ok();
      case "abort_and_deliver_queue": {
        const queued = [...this.steering, ...this.followUp];
        if (!this.run || !queued.length) return ok({ aborted: false });
        this.steering = [];
        this.followUp = [];
        this.emit({ type: "queue_update", steering: [], followUp: [] });
        this.takeover = queued.join("\n");
        this.run.ac.abort();
        return ok({ aborted: true });
      }
      case "remove_queued_message": {
        const list = cmd.queue === "steering" ? this.steering : this.followUp;
        const i = list.indexOf(str("message"));
        if (i >= 0) list.splice(i, 1);
        ok({ removed: i >= 0 });
        return this.emit({ type: "queue_update", steering: this.steering, followUp: this.followUp });
      }
      case "fork": {
        const entryId = str("entryId");
        if (!this.log.entries.some((e) => e.id === entryId)) return fail("Unknown entry");
        const at = Date.now();
        this.init.archive(this.log.entries, this.shownTitle, this.cwd, this.path, this.log.lastTime);
        this.log.entries = this.log.upTo(entryId);
        this.path = `${this.path.replace(/(-fork\d+)?\.jsonl$/, "")}-fork${++this.forkSeq}.jsonl`;
        this.title = `${this.shownTitle} (分叉)`;
        this.log.touch(at);
        return ok({ cancelled: false });
      }
      case "btw":
        return this.askBtw(str("question"), ok);
      case "btw_cancel":
        this.btwAbort?.abort();
        return ok();
      case "get_btw_history":
        return ok({ records: this.btw });
      case "get_session_stats": {
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, context = 0;
        for (const e of this.log.entries) {
          const message = e.message as UsageMessage | undefined; // entries of this demo carry omp's usage block on assistant messages
          const u = message?.usage;
          if (!u) continue;
          input += u.input ?? 0; output += u.output ?? 0; cacheRead += u.cacheRead ?? 0; cacheWrite += u.cacheWrite ?? 0; cost += u.cost?.total ?? 0;
          context = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0);
        }
        return ok({ tokens: { input, output, cacheRead, cacheWrite }, cost, contextUsage: { tokens: context, contextWindow: 200_000, percent: Math.round((context / 200_000) * 100) } });
      }
      case "extension_ui_response": {
        const d = this.dialogs.get(str("id"));
        if (d) d.answer.resolve(cmd);
        return;
      }
      default:
        return fail(`Unknown command: ${cmd.type}`);
    }
  }

  /** A side question: answered beside the conversation, never part of it. */
  private askBtw(question: string, ok: (data?: unknown) => void): void {
    const record: BtwRecord = { id: `btw-${this.btw.length + 1}`, question, answer: "", status: "running" };
    this.btw.unshift(record);
    ok({ record: { ...record } });
    const ac = (this.btwAbort = new AbortController());
    const answer = `（旁路回答，不进入主对话）关于「${question}」：简单说，先看调用方是否带了超时，再看重试是否放大了尾延迟；这两点占了大部分情况。需要展开的话告诉我。`;
    void (async () => {
      try {
        await sleep(300, ac.signal);
        for (const delta of chunks(answer, 4)) {
          await sleep(35, ac.signal);
          record.answer += delta;
          this.emit({ type: "btw_delta", recordId: record.id, delta });
        }
        record.status = "complete";
      } catch {
        record.status = "cancelled";
      }
      this.emit({ type: "btw_record", record: { ...record } });
    })();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) {
    reject(new Aborted());
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Aborted());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** What a script may do during one run. Every step stops with `Aborted` once the user presses stop. */
export class Run {
  constructor(readonly session: DemoSession, private readonly signal: AbortSignal) {}

  sleep = (ms: number) => sleep(ms, this.signal);

  /** Streams one assistant message block by block and stores it. Tool calls in it are started by `tools`. */
  async assistant(blocks: Block[], stop = blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop"): Promise<void> {
    const s = this.session;
    const messageId = s.nextMessageId();
    const content: Block[] = [];
    const base = { role: "assistant", api: "anthropic-messages", provider: MODEL.provider, model: MODEL.id, timestamp: Date.now() };
    const update = (type: string, delta?: string) => {
      const partial = { ...base, content: structuredClone(content) };
      const frame: Frame = { type: "message_update", messageId, message: partial, assistantMessageEvent: { type, ...(delta ? { delta } : {}), partial } };
      s.partial = frame;
      s.emit(frame);
    };
    s.emit({ type: "message_start", messageId, message: { ...base, content: [] } });
    try {
      for (const block of blocks) {
        if (block.type === "toolCall") {
          content.push({ ...block, arguments: {} });
          update("toolcall_start");
          await this.sleep(250);
          content[content.length - 1] = block;
          update("toolcall_delta", JSON.stringify(block.arguments).slice(0, 40));
          await this.sleep(150);
          update("toolcall_end");
          continue;
        }
        const thinking = block.type === "thinking";
        const entry: Block = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
        content.push(entry);
        if (s.run) s.run.thinking = thinking;
        update(thinking ? "thinking_start" : "text_start");
        for (const delta of chunks(block.type === "thinking" ? block.thinking : block.text, 5)) {
          if (entry.type === "thinking") entry.thinking += delta;
          else if (entry.type === "text") entry.text += delta;
          update(thinking ? "thinking_delta" : "text_delta", delta);
          await this.sleep(16);
        }
        update(thinking ? "thinking_end" : "text_end");
      }
    } finally {
      if (s.run) s.run.thinking = false;
    }
    s.partial = undefined;
    const final = assistantMessage(blocks, stop);
    s.log.touch(Date.now());
    s.log.add(final, 0);
    s.emit({ type: "message_end", messageId, message: final });
  }

  /** Runs tool calls the last assistant message made, all at once, and stores their results. */
  async tools(specs: ToolSpec[]): Promise<void> {
    const s = this.session;
    for (const t of specs) s.emit({ type: "tool_execution_start", toolCallId: t.id, toolName: t.name, args: t.args });
    const done = new Set<string>();
    const finish = (t: ToolSpec, output: string, details: unknown, isError: boolean) => {
      done.add(t.id);
      if (!isError) t.effect?.();
      s.emit({ type: "tool_execution_end", toolCallId: t.id, toolName: t.name, result: { content: [{ type: "text", text: output }], details }, isError });
      const message = toolResultMessage(t.id, t.name, output, details, isError);
      s.log.touch(Date.now());
      s.log.add(message, 0);
      s.emit({ type: "message_start", messageId: s.nextMessageId(), message });
      s.emit({ type: "message_end", messageId: s.nextMessageId(), message });
    };
    try {
      await Promise.all(specs.map(async (t) => {
        await this.sleep(t.ms);
        finish(t, t.output, t.details, !!t.isError);
      }));
    } catch (e) {
      for (const t of specs) if (!done.has(t.id)) finish(t, "Aborted by user", undefined, true);
      throw e;
    }
  }

  /** Asks the user a question (the `ask` tool's HTML form) and waits for the answer. */
  async ask(id: string, html: string): Promise<Record<string, unknown>> {
    const s = this.session;
    const frame: Frame = { type: "extension_ui_request", id, method: "form", html };
    const answer = Promise.withResolvers<Record<string, unknown>>();
    s.dialogs.set(id, { frame, answer });
    s.emit(frame);
    const abort = () => answer.reject(new Aborted());
    this.signal.addEventListener("abort", abort, { once: true });
    try {
      return await answer.promise;
    } finally {
      s.dialogs.delete(id);
      this.signal.removeEventListener("abort", abort);
    }
  }

  // ------------------------------------------------------------------ subagents (ADR 0037)
  /** A subagent starts: it joins the roster and the dock. */
  startSubagent(rec: SubagentRec): void {
    const s = this.session;
    s.subagents.set(rec.id, rec);
    s.emit({ type: "subagent_lifecycle", payload: this.payload(rec, "started") });
  }

  /** A subagent says or does something: its transcript grows and its context fills. */
  progressSubagent(id: string, message: RawMessage, contextTokens: number): void {
    const s = this.session;
    const rec = s.subagents.get(id);
    if (!rec) return;
    rec.contextTokens = contextTokens;
    const list = s.transcripts.get(id) ?? [];
    list.push({ ...message, timestamp: Date.now() });
    s.transcripts.set(id, list);
    s.emit({ type: "subagent_progress", payload: { agent: rec.agent, index: rec.index, assignment: rec.assignment, parentToolCallId: rec.parentToolCallId, progress: { id, status: "running", description: rec.description, resolvedThinkingLevel: rec.level, resolvedModel: rec.model } } });
  }

  endSubagent(id: string, status: "completed" | "failed"): void {
    const rec = this.session.subagents.get(id);
    if (!rec) return;
    rec.status = status;
    this.session.emit({ type: "subagent_lifecycle", payload: this.payload(rec, status) });
  }

  private payload(rec: SubagentRec, status: string) {
    return { id: rec.id, agent: rec.agent, index: rec.index, status, description: rec.description, assignment: rec.assignment, parentToolCallId: rec.parentToolCallId, resolvedThinkingLevel: rec.level, resolvedModel: rec.model };
  }
}
