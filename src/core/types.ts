// Shared contract for the web client (ADR 0032). The UI renders omp RPC frames; it never assumes a transport.
// core/ turns frames into `ClientState` and implements `Actions`; ui/ only reads state and calls actions.

export type RingState = "idle" | "think" | "work" | "ok" | "fail" | "stop";

/** omp's thinking levels as `get_available_thinking_levels` returns them. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolResult {
  content: unknown[];
  isError: boolean;
  /** omp's `details` for the tool: edit carries `diff`/`oldText`/`newText`, read `displayContent`, grep `fileMatches`... */
  details?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Full arguments as the model streamed them (`write` content lives here, not in `tool_execution_start`). */
  args: Record<string, unknown>;
  status: "running" | "ok" | "fail";
  result?: ToolResult;
}

/** One block of an assistant message, in stream order. */
export type AssistantItem =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; callId: string };

export interface AssistantMessage {
  id: string;
  items: AssistantItem[];
  stopReason?: string;
  errorMessage?: string;
}

export interface ImageRef {
  mimeType: string;
  data: string;
}

/** Everything between one user message and the end of the reply. */
export interface Turn {
  id: string;
  user: { text: string; images?: ImageRef[]; /** session entry id, needed to fork from here */ entryId?: string };
  assistant: AssistantMessage[];
  state: "running" | "done" | "interrupted" | "failed";
  startedAt: number;
  /** When the final reply (text of a message without tool calls) started: ends the "thought for Xs" span. */
  replyAt?: number;
  errorText?: string;
  /** Optimistic: sent by this client, `message_start` has not confirmed it yet. */
  pending?: boolean;
}

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
}

export interface SessionRow {
  path: string;
  id: string;
  title: string;
  updatedAt: number;
}

export interface Workspace {
  cwd: string;
  sessions: SessionRow[];
}

export interface BtwRecord {
  id: string;
  question: string;
  answer: string;
  status?: string;
}

export interface QueuedMessage {
  text: string;
  mode: "steer" | "followUp";
}

export interface ClientState {
  connection: "connecting" | "ready" | "closed";
  /** Where omp runs now / the workspace the UI treats as current (they differ until the bridge restarts omp). */
  cwd: string;
  activeCwd: string;
  sessionFile?: string;
  title: string;
  model?: ModelRef;
  /** Level omp resolved for the running model, and the level the user configured (`auto` possible). */
  thinking: { resolved: ThinkingLevel; configured: ThinkingLevel | "auto" };
  turns: Turn[];
  /** toolCallId -> call. Turn items refer to it by id. */
  tools: Record<string, ToolCall>;
  /** `state` is what the ring shows (it already includes the thinking hold); `streaming` is omp's own flag. */
  run: { state: RingState; streaming: boolean };
  /** Messages sent while the agent was busy and not yet delivered (`queue_update`). */
  queue: QueuedMessage[];
  workspaces: Workspace[];
  btw: BtwRecord[];
  /** Text the composer should take into its editor (interrupted turn, removed queue item); `seq` makes repeats distinct. */
  draftRestore?: { text: string; seq: number };
  toast?: { text: string; seq: number };
}

export interface ModelPickerRow {
  provider: string;
  id: string;
  name?: string;
  role?: string;
  roles?: string[];
  current?: boolean;
  thinking?: string;
}

export interface ModelPicker {
  rows: ModelPickerRow[];
  /** Leading rows that belong to the Recent block. */
  recent: number;
  total: number;
}

/**
 * Commands the UI can issue. Mutating actions never reject: a failure becomes `state.toast` (and, for `send`, the text
 * returns to the draft). Query actions (`pickerRows`, `thinkingLevels`, `completePath`) reject with `Error(message)`.
 */
export interface Actions {
  /** Idle: `prompt`. Busy: `steer` (delivered before the next model call). Resolves once omp admitted it. */
  send(text: string): Promise<void>;
  /** `abort`. */
  stop(): Promise<void>;
  /** `abort_and_deliver_queue`: interrupt the running output and continue with the queued messages now. */
  deliverQueueNow(): Promise<void>;
  /** Takes a queued message back into the composer draft (`remove_queued_message`). */
  removeQueued(index: number): Promise<void>;
  /** Puts text into the composer editor. */
  restoreDraft(text: string): void;
  newSession(cwd?: string): Promise<void>;
  openSession(path: string, cwd: string): Promise<void>;
  /** Registers a (possibly new) directory as a workspace and opens a new session in it. */
  addWorkspace(cwd: string): Promise<void>;
  renameSession(name: string): Promise<void>;
  /** `fork` at an entry: the new session holds the path up to and including it and becomes current. */
  fork(entryId: string): Promise<void>;
  setModel(provider: string, modelId: string, role?: string): Promise<void>;
  setThinking(level: ThinkingLevel | "auto"): Promise<void>;
  pickerRows(query?: string): Promise<ModelPicker>;
  /** Efforts the live model offers, `off` first (`get_available_thinking_levels`). */
  thinkingLevels(): Promise<ThinkingLevel[]>;
  btw(question: string): Promise<void>;
  btwCancel(): Promise<void>;
  loadBtw(): Promise<void>;
  /** Sends a hand-written frame (RPC drawer). */
  sendRaw(json: string): void;
  clearRaw(): void;
  refreshSessions(): Promise<void>;
  completePath(typed: string): Promise<{ exists: boolean; entries: string[] }>;
}

/** The only thing core/ needs for omp itself. Dev: WebSocket to the bridge. Later: the cgsconnect channel. */
export interface RpcTransport {
  /** Sends one JSON frame (one JSON object, no trailing newline). */
  send(frame: string): boolean;
  onFrame(cb: (frame: string) => void): () => void;
  onStatus(cb: (s: "connecting" | "ready" | "closed") => void): () => void;
  close(): void;
}

/** What the dev bridge provides beyond omp (session list, workspaces, restarting omp in another cwd). */
export interface HostApi {
  info(): Promise<{ cwd: string }>;
  sessions(): Promise<Workspace[]>;
  complete(typed: string): Promise<{ exists: boolean; entries: string[] }>;
  addWorkspace(cwd: string): Promise<void>;
  /** Makes omp run in `cwd`; resolves `restarted` when it had to restart (the transport then sends `bridge_restart`). */
  enter(cwd: string): Promise<{ cwd: string; restarted: boolean }>;
}

/** Every frame sent (`out`) and received (`in`), newest last; kept apart from the state so streaming does not re-render the UI twice. */
export interface RawLog {
  frames(): readonly { dir: "in" | "out"; text: string }[];
  subscribe(cb: () => void): () => void;
}

export interface Client {
  getState(): ClientState;
  subscribe(cb: () => void): () => void;
  actions: Actions;
  raw: RawLog;
  close(): void;
}
