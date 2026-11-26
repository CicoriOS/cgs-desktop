// Shared contract for the web client (ADR 0032). The UI renders omp RPC frames; it never assumes a transport.
// core/ owns the reducer that turns frames into `ClientState` and the `Actions` that send commands.
// ui/ only reads `ClientState` and calls `Actions`.

export type RingState = "idle" | "think" | "work" | "ok" | "fail" | "stop";

/** omp's thinking levels as `get_available_thinking_levels` returns them; `auto` is a client-side selector. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolResult {
  content: unknown[];
  isError: boolean;
  /** omp's `details` for the tool (diff data for edit/write when present). */
  details?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "fail";
  result?: ToolResult;
}

/** One block of an assistant message, in stream order. */
export type AssistantItem =
  | { kind: "thinking"; text: string; done: boolean }
  | { kind: "text"; text: string; done: boolean }
  | { kind: "tool"; callId: string };

export interface AssistantMessage {
  id: string;
  items: AssistantItem[];
  stopReason?: string;
  errorMessage?: string;
}

/** Everything between one user message and the end of the reply. */
export interface Turn {
  id: string;
  user: { text: string; images?: { mimeType: string; data: string }[]; entryId?: string };
  assistant: AssistantMessage[];
  state: "running" | "done" | "interrupted" | "failed";
  startedAt: number;
  endedAt?: number;
  /** Optimistic: sent by this client, not yet confirmed by `message_start`. */
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
  done: boolean;
}

export interface QueuedMessage {
  text: string;
  mode: "steer" | "followUp";
}

export interface ClientState {
  connection: "connecting" | "ready" | "closed";
  cwd: string;
  sessionFile?: string;
  title: string;
  model?: ModelRef;
  /** Level omp resolved for the running model, and the level the user configured (`auto` possible). */
  thinking: { resolved?: ThinkingLevel; configured?: ThinkingLevel | "auto"; available: ThinkingLevel[] };
  turns: Turn[];
  /** toolCallId -> call. Turn items refer to it by id. */
  tools: Record<string, ToolCall>;
  run: { state: RingState; streaming: boolean; interrupted?: boolean };
  /** Messages sent while the agent was busy and not yet delivered (`queue_update`). */
  queue: QueuedMessage[];
  workspaces: Workspace[];
  btw: BtwRecord[];
  /** Newest-last raw frames for the RPC drawer; each has a direction. */
  rawFrames: { dir: "in" | "out"; text: string; at: number }[];
  toast?: string;
}

export interface ModelPickerRow {
  provider: string;
  id: string;
  name: string;
  role?: string;
  roles?: string[];
  current?: boolean;
  thinking?: ThinkingLevel[];
}

/** Commands the UI can issue. core/ implements them over `RpcTransport`. All reject with `Error(message)` on `success:false`. */
export interface Actions {
  /** Idle: `prompt`. Busy: `steer` (delivered before the next model call). Returns after omp acknowledged. */
  send(text: string, images?: { mimeType: string; data: string }[]): Promise<void>;
  /** `abort`. */
  stop(): Promise<void>;
  /** `abort_and_deliver_queue`: interrupt the running output and continue with the queued messages now. */
  deliverQueueNow(): Promise<void>;
  /** Take a queued message back into the draft (`remove_queued_message`); resolves to its text/images. */
  removeQueued(index: number): Promise<{ text: string }>;
  newSession(): Promise<void>;
  openSession(path: string, cwd: string): Promise<void>;
  /** Restarts omp in another cwd on the dev bridge (`POST /api/workspace`); caller must confirm when streaming. */
  switchWorkspace(cwd: string): Promise<void>;
  renameSession(name: string): Promise<void>;
  /** `fork` with `entryId`: new session file holding the path up to and including that entry; the new session becomes current. */
  fork(entryId: string): Promise<void>;
  setModel(provider: string, modelId: string, role?: string): Promise<void>;
  setThinking(level: ThinkingLevel | "auto"): Promise<void>;
  pickerRows(query?: string): Promise<ModelPickerRow[]>;
  btw(question: string): Promise<void>;
  btwCancel(): Promise<void>;
  /** Sends a hand-written frame (RPC drawer). */
  sendRaw(json: string): void;
  refreshSessions(): Promise<void>;
  /** Completion for the workspace dialog (`GET /api/complete`). */
  completePath(typed: string): Promise<{ exists: boolean; entries: string[] }>;
}

/** The only thing core/ needs from the outside. Dev: WebSocket to the bridge. Later: the cgsconnect channel. */
export interface RpcTransport {
  /** Sends one JSON frame (one JSON object, no trailing newline). */
  send(frame: string): void;
  onFrame(cb: (frame: string) => void): () => void;
  onStatus(cb: (s: "connecting" | "ready" | "closed") => void): () => void;
  close(): void;
}

export interface Client {
  getState(): ClientState;
  subscribe(cb: () => void): () => void;
  actions: Actions;
}
