// Shared contract for the web client (ADR 0032). The UI renders omp RPC frames; it never assumes a transport.
// core/ turns frames into `ClientState` and implements `Actions`; ui/ only reads state and calls actions.
import type { CompactMode } from "./compact";
import type { RawMessage } from "./messages";
import type { SettingsApi } from "./settings";
import type { StatsView } from "./stats";

export type RingState = "idle" | "think" | "work" | "ok" | "fail" | "stop";

/** omp's thinking levels as `get_available_thinking_levels` returns them. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolResult {
  content: unknown[];
  isError: boolean;
  /** omp's `details` for the tool: edit carries `diff`/`oldText`/`newText`, read `displayContent`, grep `fileMatches`... */
  details?: unknown;
}

/** What a running tool streamed before its result exists (`tool_execution_update`, `tool_stream_update`). */
export interface ToolStream {
  /** The newest preview; the reducer keeps only the tail of a long one. */
  text: string;
  /** When the preview arrived (ms). */
  at: number;
  /** Older output was dropped to stay bounded. */
  truncated?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Full arguments as the model streamed them (`write` content lives here, not in `tool_execution_start`). */
  args: Record<string, unknown>;
  status: "running" | "ok" | "fail";
  result?: ToolResult;
  /** When `tool_execution_start` arrived: the running card's elapsed time. */
  startedAt?: number;
  /** Live output of a running call; the result replaces it. */
  stream?: ToolStream;
}

/** Text for the model, not the user (a harness reminder, a rule injected after a rewind): a quiet card, folded by default (ADR 0037). */
export interface NoticeItem {
  kind: "notice";
  id: string;
  tone: "reminder" | "notice" | "interrupt" | "rule" | "other";
  /** `rule`: the rule names. */
  names?: string;
  text: string;
}

/** One block of an assistant message, in stream order. Notices sit in a message of their own. */
export type AssistantItem =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; callId: string }
  | NoticeItem;

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
  user: { text: string; images?: ImageRef[] };
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

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

/** omp's todo list: phases of tasks (`get_state.todoPhases`, `todo` tool results). */
export interface TodoPhase {
  name?: string;
  tasks: { content: string; status: TodoStatus }[];
}

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** A subagent the main agent started (ADR 0037). Fields omp did not report stay undefined. */
export interface SubagentInfo {
  id: string;
  index: number;
  agent: string;
  status: SubagentStatus;
  description?: string;
  /** The task given to it (assignment); its transcript's first message is the full prompt. */
  task?: string;
  /** The subagent's own thinking level as omp resolved it (`resolvedThinkingLevel`): `auto`, `high`, ... */
  level?: string;
  model?: string;
  /** The `task` tool call that started it. */
  parentToolCallId?: string;
}

/** A slice of a subagent's transcript read with `get_subagent_messages`. */
export interface SubagentTranscript {
  messages: RawMessage[];
  /** Pass back as `fromByte` to read only what was appended since. */
  nextByte: number;
  /** The file shrank: the slice starts over and replaces what the caller held. */
  reset: boolean;
}

export interface QueuedMessage {
  text: string;
  mode: "steer" | "followUp";
}

/** A question omp asks the user: the `ask` tool's HTML form, or an extension's select/confirm/input/editor dialog. */
export type Dialog =
  | { id: string; method: "form"; html: string }
  | { id: string; method: "select"; title: string; options: string[]; details?: (string | undefined)[]; initialIndex?: number; marker?: "radio" | "checkbox"; checkedIndices?: number[]; markableCount?: number }
  | { id: string; method: "confirm"; title: string; message: string }
  | { id: string; method: "input"; title: string; placeholder?: string; secret?: boolean }
  | { id: string; method: "editor"; title: string; prefill?: string };

/** What goes back in `extension_ui_response` (the id is added by the client). */
export type DialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { data: Record<string, string | number | string[]> };

/**
 * The agent's own machinery while it works, drawn as one strip above the message box. Compaction, retry, fallback and
 * warming belong to a run and clear at its end; statuses, widgets, the goal and config warnings are session state.
 */
export interface RunProgress {
  compaction?: { kind: "auto" | "manual"; /** auto: why it ran (`threshold`, `overflow`, …). */ reason?: string; /** manual: the `/compact <mode>` subcommand. */ mode?: string; /** auto: what omp does (`context-full`, `remote`, …). */ action?: string; startedAt: number };
  retry?: { attempt: number; maxAttempts: number; delayMs?: number; reason: string; startedAt: number };
  fallback?: { from: string; to: string; role?: string; reason?: string; ok?: boolean };
  warming?: { phase?: string; method?: string; model?: string };
  /** Goal mode's objective (`goal_updated`); no goal when absent. */
  goal?: { objective: string; status?: string };
  /** Counts `config_warnings_changed` frames; the RPC frame carries no text, so the strip only says there are some. */
  warnings: number;
  /** Extension `setStatus` lines, by key, in the order they arrived. */
  statuses: Record<string, string>;
  /** Extension `setWidget` blocks, keyed and placed above or below the editor. */
  widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
}

export interface ClientState {
  connection: "connecting" | "ready" | "closed";
  /** A conversation's history is being fetched (opening a session, a reconnect, a fork). What is on screen may be the browser's copy. */
  loading: boolean;
  /** A manual compaction is running (asked by `compact`, ended by omp's `command_output`). */
  compacting: boolean;
  /** Name of the machine being controlled (from the host; empty when unknown). */
  device: string;
  /** Absent until the host answers, and for hosts that have no account (see `HostApi.account`). */
  account?: AccountSnapshot;
  /** Workspace and identity of the attached child. */
  activeCwd: string;
  childId?: string;
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
  /** Compaction, retries, extension statuses and widgets: what the agent reports about itself while it works. */
  progress: RunProgress;
  /** Messages sent while the agent was busy and not yet delivered (`queue_update`). */
  queue: QueuedMessage[];
  /** The session's todo list; empty when there is none. */
  todos: TodoPhase[];
  /** Subagents of this session, in the order they were started. */
  subagents: SubagentInfo[];
  workspaces: Workspace[];
  children: ChildStatus[];
  btw: BtwRecord[];
  /** Questions waiting for an answer, oldest first; the UI shows the first. */
  dialogs: Dialog[];
  /**
   * Who may write the open conversation (ADR 0047), from the host's `cgs_control`. `you` is true while this page may
   * write: it holds control, or nobody does and its next write takes it. Absent until the host first says.
   */
  control?: { controller?: Controller; you: boolean };
  /** Text (images, file references) the composer should take into its editor (interrupted turn, removed queue item); `seq` makes repeats distinct. */
  draftRestore?: { text: string; images?: ImageRef[]; /** Absolute paths of files to attach as @ references. */ refs?: string[]; seq: number };
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
  send(text: string, images?: ImageRef[]): Promise<void>;
  /** `abort`. */
  stop(): Promise<void>;
  /** `abort_and_deliver_queue`: interrupt the running output and continue with the queued messages now. */
  deliverQueueNow(): Promise<void>;
  /** Takes a queued message back into the composer draft (`remove_queued_message`). */
  removeQueued(index: number): Promise<void>;
  /** Shows a short notice (toast). */
  notify(text: string): void;
  /** Puts text, pictures and file references (absolute paths) into the composer editor. */
  restoreDraft(text: string, images?: ImageRef[], refs?: string[]): void;
  /** Answers (or cancels) the dialog with this id; omp stops waiting for it. */
  answerDialog(id: string, answer: DialogAnswer): void;
  /** Runs `/compact <mode>`: omp compacts the session context and reports the result as a notice. Refused while the agent runs. */
  compact(mode: CompactMode): Promise<void>;
  newSession(cwd?: string): Promise<void>;
  openSession(path: string, cwd: string): Promise<void>;
  /** Registers a (possibly new) directory as a workspace and opens a new session in it. */
  addWorkspace(cwd: string): Promise<void>;
  renameSession(name: string): Promise<void>;
  /** `fork` at the end of a turn (its last assistant message): the new session holds the path up to there and becomes current. */
  fork(turnIndex: number): Promise<void>;
  setModel(provider: string, modelId: string, role?: string): Promise<void>;
  setThinking(level: ThinkingLevel | "auto"): Promise<void>;
  pickerRows(query?: string): Promise<ModelPicker>;
  /** Efforts the live model offers, `off` first (`get_available_thinking_levels`). */
  thinkingLevels(): Promise<ThinkingLevel[]>;
  btw(question: string): Promise<void>;
  btwCancel(): Promise<void>;
  loadBtw(): Promise<void>;
  /** Token and cost use per model, cache hit rate, context fill per agent (`get_session_stats`, `get_entries`, `get_subagents`). */
  loadStats(): Promise<StatsView>;
  /** The transcript of a subagent (`get_subagent_messages`); rejects when omp cannot give it (the process restarted). */
  subagentTranscript(id: string, fromByte?: number): Promise<SubagentTranscript>;
  /** Sends a hand-written frame (RPC drawer). */
  sendRaw(json: string): void;
  clearRaw(): void;
  refreshSessions(): Promise<void>;
  /** Fetches the account snapshot now (the client also refreshes it every few minutes). */
  refreshAccount(): Promise<void>;
  /**
   * Asks the host to make this page the controller of the open conversation (ADR 0047). The host answers by broadcasting
   * `cgs_control`; a failure becomes a toast like other mutations.
   */
  takeControl(): Promise<void>;
  completePath(typed: string): Promise<{ exists: boolean; entries: string[] }>;
  /** The right panel's reads, for the active workspace. They reject when the host has no workspace API. */
  listDir(dir: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<FilePreview>;
  gitStatus(): Promise<GitStatus>;
  gitDiff(path: string, target: GitDiffTarget): Promise<string | undefined>;
  /** Git writes and reads that are not part of the status. Like the reads above they reject with Git's message; the Git panel shows it. */
  gitStage(paths: string[] | "all"): Promise<void>;
  gitUnstage(paths: string[] | "all"): Promise<void>;
  gitDiscard(paths: string[]): Promise<void>;
  gitCommit(message: string): Promise<void>;
  gitFetch(): Promise<void>;
  gitPull(): Promise<void>;
  gitPush(): Promise<void>;
  gitBranches(): Promise<GitBranch[]>;
  gitCheckout(branch: string, create?: boolean): Promise<void>;
  gitLog(limit: number): Promise<GitCommit[]>;
  gitCommitFiles(hash: string): Promise<GitFile[]>;
  /** Calls back when the active workspace's files or Git state change; returns the way to stop. Does nothing on a host without a workspace API. */
  watchWorkspace(listener: () => void): () => void;
}

/** The only thing core/ needs for omp itself. Dev: WebSocket to the bridge. Later: the cgsconnect channel. */
export interface RpcTransport {
  /** Sends one JSON frame (one JSON object, no trailing newline). */
  send(frame: string): boolean;
  onFrame(cb: (frame: string) => void): () => void;
  onStatus(cb: (s: "connecting" | "ready" | "closed") => void): () => void;
  close(): void;
}

/** Live processes overlaid on the session files listed by the host. */
export interface ChildStatus {
  id: string;
  cwd: string;
  sessionPath?: string;
  title?: string;
  updatedAt: number;
  ring: "idle" | "work" | "think";
  level: ThinkingLevel;
  unseen: boolean;
  /** Who may write to this conversation now (ADR 0047). Absent when nobody does. */
  controller?: Controller;
}

export interface Controller {
  kind: "desktop" | "remote" | "terminal";
  name: string;
  /** This listing's caller holds it (the host compares connection keys); the sidebar does not mark the page's own control. */
  mine?: boolean;
}

/** What the host provides beyond omp (session files, workspaces, process ownership). */
export interface HostApi {
  info(): Promise<{ cwd: string; device?: string }>;
  sessions(): Promise<Workspace[]>;
  complete(typed: string): Promise<{ exists: boolean; entries: string[] }>;
  addWorkspace(cwd: string): Promise<void>;
  children(): Promise<ChildStatus[]>;
  /** `yield` confirms taking the session from a terminal that is busy (the host answers `terminal_busy` otherwise, ADR 0047). */
  openChild(cwd: string, sessionPath?: string, options?: { yield?: boolean }): Promise<ChildStatus>;
  /** The workspace's files and Git state, for the right panel. A host without it (the dev bridge) leaves the panel with the task's own changes only. */
  workspace?: WorkspaceApi;
  /** The signed-in CGS account (no tokens: the host holds them, ADR 0010). Undefined means signed out; rejection leaves the last snapshot stale. */
  account?(): Promise<AccountSnapshot | undefined>;
  /** Makes this connection the controller of one conversation (`/api/children/<id>/control`, ADR 0047); a host without control leaves it out. */
  takeControl?(childId: string): Promise<void>;
  settings?: SettingsApi;
}

export type AccountTier = "free" | "go" | "pro" | "dedicated";

export interface Subscription {
  id: number;
  planTitle: string;
  /** No total amount: the plan is unlimited. */
  unlimited: boolean;
  amountUsed: number;
  amountTotal: number;
  /** Display strings come from the server, formatted as in its console. */
  usedDisplay: string;
  totalDisplay: string;
  resetPeriod: "never" | "daily" | "weekly" | "monthly" | "custom";
  /** Unix seconds; 0 when none. */
  nextResetAt: number;
  /** Unix seconds; 0 when it does not expire. */
  endTime: number;
}

/** `GET /api/device/usage` as the host normalises it (docs: desktop/account-billing.md, `account.snapshot`). */
export interface AccountSnapshot {
  username: string;
  /** A picture for the account; the page draws a placeholder from the name when it is absent. */
  avatarUrl?: string;
  tier: AccountTier;
  /** The balance as the server displays it, e.g. `¥199.99`. */
  balance: string;
  subscriptions: Subscription[];
  /** The host could not refresh; this is the last value it has. */
  stale: boolean;
  /** Unix milliseconds. */
  fetchedAt: number;
}

export interface FileEntry {
  name: string;
  /** Absolute path. */
  path: string;
  dir: boolean;
}

export type GitFileKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export interface GitFile {
  /** Absolute path. */
  path: string;
  status: GitFileKind;
  /** In the index (staged for the next commit). A file changed both in the index and after it appears twice, once per side. */
  staged: boolean;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitStatus {
  isRepo: boolean;
  /** Absent while HEAD is detached. */
  branch?: string;
  /** Short hash of a detached HEAD. */
  detached?: string;
  /** The remote branch this one follows, e.g. `origin/main`; absent for a branch that was never published. */
  upstream?: string;
  /** Commits here that the upstream lacks (to push) and commits there that this branch lacks (to pull); as of the last fetch. */
  ahead: number;
  behind: number;
  /** `user.name` and `user.email`: tells the user's own commits from a teammate's. */
  user?: GitIdentity;
  files: GitFile[];
}

export interface GitBranch {
  /** Local `feature/x`, or remote `origin/feature/x`. */
  name: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Author and time (ms) of the newest commit: who touched the branch last. */
  author: string;
  time: number;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  email: string;
  /** Unix milliseconds. */
  time: number;
  /** Against the upstream: `incoming` is on the remote only (a teammate's push to pull), `outgoing` is here only (to push), `shared` is on both. */
  direction: "incoming" | "outgoing" | "shared";
}

/** What a diff compares: the working tree with the index, the index with HEAD, or one commit with its parent. */
export type GitDiffTarget = "changes" | "staged" | { commit: string };

export type FilePreview =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "binary" }
  | { kind: "large"; size: number };

/** Everything takes the workspace's `cwd`: the host may serve several. Paths in and out are absolute. */
export interface WorkspaceApi {
  list(cwd: string, dir: string): Promise<FileEntry[]>;
  read(cwd: string, path: string): Promise<FilePreview>;
  gitStatus(cwd: string): Promise<GitStatus>;
  /** Unified diff of one file; undefined when none can be shown (binary, deleted, ignored). */
  gitDiff(cwd: string, path: string, target: GitDiffTarget): Promise<string | undefined>;
  /** Everything below rejects with a readable message when Git refuses (a rejected push, a checkout that would lose changes). `"all"` is every changed file. */
  gitStage(cwd: string, paths: string[] | "all"): Promise<void>;
  gitUnstage(cwd: string, paths: string[] | "all"): Promise<void>;
  /** Throws the working-tree changes of these files away (an untracked file is deleted). */
  gitDiscard(cwd: string, paths: string[]): Promise<void>;
  /** Commits what is staged. */
  gitCommit(cwd: string, message: string): Promise<void>;
  /** Asks the remote what is new; changes `behind` and the incoming commits only. */
  gitFetch(cwd: string): Promise<void>;
  /** Brings the upstream's commits in (fast-forward or merge). */
  gitPull(cwd: string): Promise<void>;
  /** Sends local commits; a branch without an upstream is published as `origin/<name>` and starts following it. */
  gitPush(cwd: string): Promise<void>;
  /** Local branches first, then the remote ones; a remote branch already followed by a local one is left out. */
  gitBranches(cwd: string): Promise<GitBranch[]>;
  /** Switches branch. `create` makes it from HEAD; a remote name creates the local branch that follows it. */
  gitCheckout(cwd: string, branch: string, create?: boolean): Promise<void>;
  /** Newest first: the current branch's commits together with the upstream's, so teammates' unpulled work shows too. */
  gitLog(cwd: string, limit: number): Promise<GitCommit[]>;
  /** The files one commit changed. */
  gitCommitFiles(cwd: string, hash: string): Promise<GitFile[]>;
  /** Calls `listener` whenever something under `cwd` changes on disk or in Git (a local host watches the files); returns the way to stop. Bursts may arrive as many calls. */
  watch(cwd: string, listener: () => void): () => void;
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
