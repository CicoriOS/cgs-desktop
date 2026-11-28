import { type CompactMode, compactCommand, compactFailed, compactFallback } from "./compact";
import { isReadOnlyFrame } from "./frames";
import { type EventFrame, applyFrame, initialState, newTurnId, ringFor, subagentsFromTools } from "./reducer";
import { type HistoryCache, type SessionEntry, activeBranch, turnsFromEntries, turnsFromMessages, turnTailIds } from "./history";
import type { RawMessage } from "./messages";
import { buildStats, type SessionTotals, type StatsView, type SubagentSnapshot, type UsageMessage } from "./stats";
import { mergeSubagents, reconcileRoster, subagentsFromSnapshot } from "./subagents";
import { parsePhases } from "./todos";
import type { Actions, BtwRecord, ChildStatus, Client, ClientState, DialogAnswer, HostApi, ImageRef, ModelPicker, RawLog, RingState, RpcTransport, SubagentTranscript, ThinkingLevel, ToolCall, Turn } from "./types";
import { getLocale, subscribeLocale, t } from "../i18n";

const RAW_CAP = 3000;
const RPC_TIMEOUT_MS = 60_000;
/** A fast model thinks for a fraction of a second: once the blue thinking ring shows, the next state waits this long. */
const THINK_HOLD_MS = 1500;
const CHILD_POLL_MS = 2000;
/** How often coalesced tool previews reach the state; 10 fps is smooth for a tail and cheap to render. */
const TOOL_UPDATE_FLUSH_MS = 100;
/** The server refreshes usage figures on this order (account-billing.md: every 5 minutes). */
const ACCOUNT_POLL_MS = 5 * 60_000;
/** The host's answer when a terminal runs the session a desktop wants to open (ADR 0047); `yield` takes it over. */
const TERMINAL_BUSY = "terminal_busy";
const TERMINAL_DID_NOT_EXIT = "terminal_did_not_exit";
/** A question this browser asks itself: ids stay out of omp's namespace and are answered locally. */
const LOCAL_DIALOG_PREFIX = "local:";

export interface ClientOptions {
  now?: () => number;
  holdMs?: number;
  rpcTimeoutMs?: number;
  /** Where this browser keeps finished conversations: opening one shows its copy at once while the device sends the current history. */
  cache?: HistoryCache;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface Response {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PromptResult {
  status?: string;
  sessionSettled?: boolean;
  error?: { message?: string };
}

interface StateData {
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: ThinkingLevel;
  configuredThinkingLevel?: ThinkingLevel | "auto";
  sessionFile?: string;
  isStreaming?: boolean;
  isSettled?: boolean;
  queuedMessages?: { steering?: string[]; followUp?: string[] };
  todoPhases?: unknown;
}

const toImageContent = (images: ImageRef[] | undefined) => (images?.length ? { images: images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data })) } : {});
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createClient(connect: (childId: string) => RpcTransport, host: HostApi, opts: ClientOptions = {}): Client {
  const now = opts.now ?? Date.now;
  const holdMs = opts.holdMs ?? THINK_HOLD_MS;
  const rpcTimeout = opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  const cache = opts.cache;

  let state = initialState();
  const listeners = new Set<() => void>();
  const set = (next: (s: ClientState) => ClientState) => {
    state = next(state);
    for (const cb of listeners) cb();
  };

  const rawFrames: { dir: "in" | "out"; text: string }[] = [];
  const rawListeners = new Set<() => void>();
  const raw: RawLog = {
    frames: () => rawFrames,
    subscribe: (cb) => {
      rawListeners.add(cb);
      return () => rawListeners.delete(cb);
    },
  };
  /** Questions this browser asks itself (a terminal holds the conversation): id -> how the user answered. */
  const localAnswers = new Map<string, (confirmed: boolean) => void>();
  let localSeq = 0;

  /** Asks in the app's own dialog area; false when cancelled or superseded by a newer navigation. */
  function askConfirm(title: string, message: string): Promise<boolean> {
    const id = `${LOCAL_DIALOG_PREFIX}${++localSeq}`;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    localAnswers.set(id, resolve);
    set((s) => ({ ...s, dialogs: [...s.dialogs, { id, method: "confirm", title, message }] }));
    return promise;
  }

  /** Drops questions nobody can answer anymore: the asker sees "no" and navigation does not hang. */
  function cancelLocalDialogs(): void {
    if (localAnswers.size === 0) return;
    const pending = [...localAnswers.values()];
    localAnswers.clear();
    set((s) => ({ ...s, dialogs: s.dialogs.filter((d) => !d.id.startsWith(LOCAL_DIALOG_PREFIX)) }));
    for (const resolve of pending) resolve(false);
  }
  const rawPush = (dir: "in" | "out", text: string) => {
    rawFrames.push({ dir, text });
    if (rawFrames.length > RAW_CAP) rawFrames.splice(0, rawFrames.length - RAW_CAP);
    for (const cb of rawListeners) cb();
  };

  // ------------------------------------------------------------------ rpc
  const page = Math.random().toString(36).slice(2, 8); // ids distinguish responses across tabs sharing a child
  let seq = 0;
  const pending = new Map<string, Pending>();
  let transport: RpcTransport | undefined;
  let unsubscribeTransport: (() => void) | undefined;
  let epoch = 0;
  let navigation = 0;
  let opening: Promise<boolean> | undefined;
  let attached: PromiseWithResolvers<boolean> | undefined;
  let closed = false;
  let hydrating = false;
  let snapshot: (EventFrame & { ring?: ChildStatus["ring"]; level?: ThinkingLevel; partial?: EventFrame; toolUpdates?: EventFrame[]; dialogs?: EventFrame[]; queue?: EventFrame }) | undefined;

  /** True while this page may change the conversation: it holds control, or nobody does (ADR 0047). */
  const canWrite = (): boolean => !state.control || state.control.you;
  /** The error a refused mutation shows: controlled elsewhere, or the link is gone. */
  const notWritable = (): Error => new Error(t(canWrite() ? "err.notConnected" : "control.blocked"));

  function sendFrame(text: string): boolean {
    // A conversation controlled elsewhere is read-only here (the host would drop the frame anyway, ADR 0047).
    if (!canWrite() && !isReadOnlyFrame(text)) return false;
    if (!transport?.send(text)) return false;
    rawPush("out", text);
    return true;
  }

  function rpc<T = unknown>(cmd: { type: string; [k: string]: unknown }, apply?: (data: T) => void): Promise<T> {
    const id = `${page}-${++seq}`;
    const p = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      pending.delete(id);
      p.reject(new Error(t("err.timeout", { cmd: cmd.type, n: Math.round(rpcTimeout / 1000) })));
    }, rpcTimeout);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        try { apply?.(v as T); p.resolve(v as T); } catch (e) { p.reject(e); }
      },
      reject: (e) => (clearTimeout(timer), p.reject(e)),
    });
    if (!sendFrame(JSON.stringify({ ...cmd, id }))) {
      pending.delete(id);
      clearTimeout(timer);
      p.reject(notWritable());
    }
    return p.promise;
  }

  const toast = (text: string) => set((s) => ({ ...s, toast: { text, seq: (s.toast?.seq ?? 0) + 1 } }));
  const restoreDraft = (text: string, images?: ImageRef[], refs?: string[]) => set((s) => ({ ...s, draftRestore: { text, ...(images?.length ? { images } : {}), ...(refs?.length ? { refs } : {}), seq: (s.draftRestore?.seq ?? 0) + 1 } }));

  /** Runs a mutating action: failures become a toast instead of a rejection. */
  async function guard(fn: () => Promise<void>): Promise<void> {
    const current = epoch;
    try {
      await fn();
    } catch (e) {
      if (current === epoch && !closed) toast(errorMessage(e));
    }
  }

  // ------------------------------------------------------------------ ring (ADR 0030)
  let hold: { until: number; want?: RingState; timer?: ReturnType<typeof setTimeout> } | undefined;
  const showRing = (ring: RingState) => set((s) => (s.run.state === ring ? s : { ...s, run: { ...s.run, state: ring } }));

  function requestRing(ring: RingState): void {
    if (hold && ring !== "think" && now() < hold.until) {
      hold.want = ring;
      const h = hold;
      h.timer ??= setTimeout(() => {
        h.timer = undefined;
        if (hold === h) hold = undefined;
        showRing(h.want ?? "idle");
      }, h.until - now());
      return;
    }
    if (ring === "think" && state.run.state !== "think") hold = { until: now() + holdMs };
    else if (!hold?.timer) hold = undefined;
    showRing(ring);
  }

  // ------------------------------------------------------------------ run lifecycle
  let runEnded = false;
  let endInfo: { status?: string; message?: string } | undefined;
  let deliveringQueue = false;

  function startRun(): void {
    runEnded = false;
    endInfo = undefined;
    set((s) => ({ ...s, run: { ...s.run, streaming: true } }));
    requestRing("work");
  }

  /**
   * A turn that ended in an error or a stop. Nothing of the model's work yet: the message leaves the transcript and returns to the
   * editor. Otherwise the work stays and the turn is marked, so the user message can offer "edit".
   */
  function finishTurns(turns: Turn[], status: string | undefined, message: string | undefined): { turns: Turn[]; restore?: { text: string; images?: ImageRef[] } } {
    let restore: { text: string; images?: ImageRef[] } | undefined;
    const out: Turn[] = [];
    for (const [i, t] of turns.entries()) {
      if (t.state !== "running" && !t.pending) {
        out.push(t);
        continue;
      }
      const isLast = i === turns.length - 1;
      if (!isLast || !status || status === "completed") {
        out.push({ ...t, state: "done", pending: false });
        continue;
      }
      const started = t.assistant.some((a) => a.items.some((i) => i.kind !== "notice"));
      if (!started) {
        restore = { text: t.user.text, images: t.user.images };
        continue;
      }
      out.push({ ...t, pending: false, state: status === "error" ? "failed" : "interrupted", errorText: message });
    }
    return { turns: out, restore };
  }

  function settle(): void {
    if (!state.run.streaming && !state.turns.some((t) => t.pending || t.state === "running")) {
      requestRing("idle");
      return;
    }
    const info = endInfo;
    let restore: { text: string; images?: ImageRef[] } | undefined;
    set((s) => {
      const r = finishTurns(s.turns, info?.status, info?.message);
      restore = r.restore;
      return { ...s, turns: r.turns, run: { ...s.run, streaming: false } };
    });
    if (restore) restoreDraft(restore.text, restore.images);
    if (info?.message && info.status !== "completed") toast(info.message);
    runEnded = true;
    endInfo = undefined;
    requestRing("idle");
    remember();
    void refreshState();
    void refreshSessions();
  }

  function onPromptResult(f: PromptResult): void {
    // Deliver-now cuts the running prompt short and continues with the queue in the same run (agent_end, agent_start, then this
    // `aborted` result): the run is not over, the session_settled that ends the continuation settles it.
    if (deliveringQueue && f.status === "aborted") {
      deliveringQueue = false;
      return;
    }
    runEnded = true;
    endInfo = { status: f.status, message: f.error?.message };
    requestRing(f.status === "error" ? "fail" : "idle");
    if (f.sessionSettled) settle(); // an aborted prompt reports its settling here and sends no session_settled frame
  }

  // ------------------------------------------------------------------ state from omp
  function applyState(st: StateData): void {
    set((s) => ({
      ...s,
      model: st.model ? { provider: st.model.provider, id: st.model.id, name: st.model.name ?? st.model.id } : s.model,
      thinking: { resolved: st.thinkingLevel ?? s.thinking.resolved, configured: st.configuredThinkingLevel ?? s.thinking.configured },
      sessionFile: st.sessionFile ?? s.sessionFile,
      todos: st.todoPhases === undefined ? s.todos : parsePhases(st.todoPhases),
      run: { ...s.run, streaming: !(st.isSettled ?? !st.isStreaming) },
    }));
    if (state.run.streaming && state.run.state === "idle") requestRing("work");
  }

  async function refreshState(): Promise<void> {
    const current = epoch;
    try {
      const st = await rpc<StateData>({ type: "get_state" });
      if (current === epoch) applyState(st);
    } catch {
      /* a later frame or action reports a real outage */
    }
  }

  function syncTitleLanguage(): void {
    if (!transport || (!hydrating && state.connection !== "ready")) return;
    const language = getLocale() === "zh" ? "Chinese (Simplified)" : "English";
    // Older omp versions don't recognize this optional command.
    void rpc({ type: "set_title_language", language }).catch(() => {});
  }

  let listRequest = 0;
  async function refreshSessions(): Promise<void> {
    const request = ++listRequest;
    try {
      const workspaces = await host.sessions();
      if (closed || request !== listRequest) return;
      set((s) => {
        const cur = workspaces.flatMap((w) => w.sessions).find((x) => x.path === s.sessionFile);
        return { ...s, workspaces, title: cur?.title ?? s.title };
      });
    } catch (e) {
      if (!closed && request === listRequest) toast(errorMessage(e));
    }
  }

  let accountRequest = 0;
  /** Quiet on failure: a host without an account, or one that is briefly unreachable, keeps the last snapshot (marked stale) or none. */
  async function refreshAccount(): Promise<void> {
    if (!host.account) return;
    const request = ++accountRequest;
    try {
      const account = await host.account();
      if (!closed && request === accountRequest) set((s) => ({ ...s, account }));
    } catch {
      if (!closed && request === accountRequest) set((s) => (s.account && !s.account.stale ? { ...s, account: { ...s.account, stale: true } } : s));
    }
  }

  let statusRequest = 0;
  async function refreshChildren(): Promise<void> {
    const request = ++statusRequest;
    try {
      const children = await host.children();
      if (closed || request !== statusRequest) return;
      const previous = state.children;
      set((s) => ({ ...s, children }));
      if (children.length !== previous.length || children.some((c, i) => c.updatedAt !== previous[i]?.updatedAt || c.id !== previous[i]?.id)) {
        void refreshSessions();
      }
    } catch {
      // Polling may fail while the bridge is offline; the active socket reports its own status.
    }
  }

  /** Asks omp for subagent progress frames (ADR 0037) and reads the roster: frames sent before this point are not replayed. */
  async function syncSubagents(): Promise<void> {
    const current = epoch;
    try {
      await rpc({ type: "set_subagent_subscription", level: "progress" });
      const roster = subagentsFromSnapshot(await rpc({ type: "get_subagents" }));
      // What history lists as running but omp does not know is over; what omp lists is merged in.
      if (current === epoch) set((s) => ({ ...s, subagents: mergeSubagents(reconcileRoster(s.subagents, roster), roster) }));
    } catch {
      /* an omp without subagent frames: the task results still list them */
    }
  }

  /** Starts a history load. `keepView` leaves the conversation on screen (a cached copy, or the last one before a reconnect) until the load replaces it. */
  function resetSession(keepView = false): void {
    cancelLocalDialogs();
    clearTimeout(hold?.timer);
    hold = undefined;
    runEnded = false;
    endInfo = undefined;
    deliveringQueue = false;
    dropToolUpdates();
    set((s) => ({
      ...s,
      ...(keepView ? {} : { turns: [], tools: {}, subagents: [], title: "" }),
      queue: [], todos: [], dialogs: [], btw: [], loading: true, compacting: false, run: { state: "idle", streaming: false },
      progress: { warnings: 0, statuses: {}, widgets: [] },
    }));
  }

  // ------------------------------------------------------------------ browser copy of conversations
  /** Keeps the finished conversation. A running turn is not kept: the settle that ends it saves the whole. */
  function remember(): void {
    const path = state.sessionFile;
    if (!cache || !path || state.connection !== "ready" || !state.turns.length) return;
    if (state.turns.some((t) => t.pending || t.state === "running")) return;
    void cache.save(path, { turns: state.turns, tools: state.tools, title: state.title }).catch(() => {});
  }

  /** Shows the browser's copy of `path` while the device is still being reached; the history that arrives replaces it. */
  async function preview(path: string): Promise<void> {
    if (!cache) return;
    let copy;
    try {
      copy = await cache.load(path);
    } catch {
      return;
    }
    if (!copy || closed || state.sessionFile !== path || !state.loading || state.turns.length) return;
    // Turn ids are per page load: a saved one could collide with a new one and remount (or merge) rows.
    const turns = copy.turns.map((t) => ({ ...t, id: newTurnId() }));
    set((s) => ({ ...s, turns, tools: copy.tools, subagents: subagentsFromTools(copy.tools), title: copy.title || s.title }));
  }

  /** Opening a saved session: the previous one is let go at once (its frames must not paint over the next), and its copy shows while the child starts. */
  function beginOpening(cwd: string, path: string): void {
    detach();
    resetSession();
    set((s) => ({ ...s, childId: undefined, activeCwd: cwd, sessionFile: path, connection: "connecting", model: undefined, draftRestore: undefined, control: undefined }));
    void preview(path);
  }

  async function hydrate(): Promise<void> {
    const current = epoch;
    hydrating = true;
    snapshot = undefined;
    try {
      const st = await rpc<StateData>({ type: "get_state" });
      if (current !== epoch) return;
      applyState(st);
      const applyHistory = (built: { turns: Turn[]; tools: Record<string, ToolCall> }) => {
        const nowMs = now();
        const { ring, level, partial, toolUpdates, dialogs, queue } = snapshot ?? {};
        const streaming = ring ? ring !== "idle" : state.run.streaming;
        const last = built.turns.at(-1);
        if (last && streaming) {
          last.state = "running";
          for (const a of last.assistant) for (const item of a.items) {
            const tool = item.kind === "tool" ? built.tools[item.callId] : undefined;
            if (tool && !tool.result) tool.status = "running";
          }
        }
        set((s) => {
          let next: ClientState = {
            ...s, ...built, subagents: subagentsFromTools(built.tools), title: built.turns[0]?.user.text.slice(0, 60) || s.title,
            run: { streaming, state: ring ?? (streaming ? "work" : "idle") },
            thinking: { ...s.thinking, resolved: level ?? s.thinking.resolved },
            dialogs: [],
          };
          if (queue || st.queuedMessages) next = applyFrame(next, queue ?? { type: "queue_update", ...st.queuedMessages }, nowMs);
          if (partial) next = applyFrame(next, partial, nowMs);
          // What running tools streamed before this page attached: without it a reload shows an empty card.
          for (const update of toolUpdates ?? []) next = applyFrame(next, update, nowMs);
          for (const dialog of dialogs ?? []) next = applyFrame(next, dialog, nowMs);
          return { ...next, connection: "ready", loading: false };
        });
        remember();
        hydrating = false;
        snapshot = undefined;
        attached?.resolve(true);
      };
      // Apply on the response frame itself, before any subsequent live event. Earlier persisted events are in the entries.
      try {
        await rpc<{ entries: SessionEntry[]; leafId?: string | null }>({ type: "get_entries", bridgeSnapshot: true },
          (d) => applyHistory(turnsFromEntries(d.entries, d.leafId)));
      } catch (e) {
        if (current !== epoch) return;
        await rpc<{ messages?: RawMessage[] } | RawMessage[]>({ type: "get_messages", bridgeSnapshot: true },
          (d) => applyHistory(turnsFromMessages((Array.isArray(d) ? d : (d.messages ?? [])).map((message) => ({ message })))));
      }
    } catch (e) {
      if (current !== epoch) return;
      hydrating = false;
      set((s) => ({ ...s, connection: "closed", loading: false }));
      attached?.resolve(false);
      toast(errorMessage(e));
    }
    if (current === epoch && state.connection === "ready") void syncSubagents();
    if (current === epoch) void refreshSessions();
  }

  function rejectPending(): void {
    for (const p of pending.values()) p.reject(new Error(t("err.notConnected")));
    pending.clear();
  }

  function detach(): void {
    ++epoch;
    attached?.resolve(false);
    attached = undefined;
    rejectPending();
    unsubscribeTransport?.();
    unsubscribeTransport = undefined;
    transport?.close();
    transport = undefined;
  }

  function attach(child: ChildStatus): void {
    if (state.childId === child.id && state.connection !== "closed") return;
    const keepView = !!child.sessionPath && child.sessionPath === state.sessionFile && state.turns.length > 0;
    detach();
    resetSession(keepView);
    hydrating = true;
    attached = Promise.withResolvers<boolean>();
    const ready = attached;
    const timer = setTimeout(() => ready.resolve(false), rpcTimeout);
    void ready.promise.then(() => clearTimeout(timer));
    set((s) => ({
      ...s, childId: child.id, activeCwd: child.cwd, sessionFile: child.sessionPath, connection: "connecting",
      model: undefined, draftRestore: undefined, control: undefined, title: child.title ?? (keepView ? s.title : ""), thinking: { resolved: child.level, configured: "auto" },
      children: [...s.children.filter((c) => c.id !== child.id), { ...child, unseen: false }],
    }));
    if (child.sessionPath) void preview(child.sessionPath);
    transport = connect(child.id);
    const offFrame = transport.onFrame(onFrame);
    const offStatus = transport.onStatus((status) => {
      if (status !== "ready") {
        ++epoch;
        rejectPending();
        if (status === "closed") attached?.resolve(false);
        else attached = Promise.withResolvers<boolean>();
        set((s) => ({ ...s, connection: status, loading: status === "closed" ? false : s.loading }));
        return;
      }
      resetSession(true);
      hydrating = true;
      syncTitleLanguage();
      void hydrate();
    });
    unsubscribeTransport = () => { offFrame(); offStatus(); };
  }

  function navigate(cwd: string, path?: string): Promise<boolean> {
    const request = ++navigation;
    cancelLocalDialogs();
    if (path) beginOpening(cwd, path);
    const pending = (async (): Promise<boolean> => {
      /** Whether the user allowed taking the conversation from a terminal (ADR 0047). */
      let taking = false;
      for (;;) {
        try {
          const child = await host.openChild(cwd, path, taking ? { yield: true } : undefined);
          if (request !== navigation || closed) return false;
          attach(child);
          return true;
        } catch (e) {
          if (request !== navigation || closed) return false;
          const code = errorMessage(e);
          if (path && !taking && code === TERMINAL_BUSY) {
            if (!await askConfirm(t("session.busy.title"), t("session.busy.message"))) {
              if (request !== navigation || closed) return false;
              set((s) => ({ ...s, connection: "closed", loading: false }));
              return false;
            }
            if (request !== navigation || closed) return false;
            taking = true;
            continue;
          }
          if (path) set((s) => ({ ...s, connection: "closed", loading: false }));
          if (code === TERMINAL_DID_NOT_EXIT) toast(t("err.terminalDidNotExit"));
          else if (code === TERMINAL_BUSY) toast(t("session.busy.title"));
          else toast(code);
          return false;
        }
      }
    })();
    opening = pending;
    void pending.then(() => { if (opening === pending) opening = undefined; });
    return pending;
  }

  // A quick send must wait for the requested child, not land in the previous attachment.
  async function prepareSend(): Promise<boolean> {
    if (!navigation && !state.childId) await bootstrap;
    if (closed) return false;
    if (!opening && !state.childId) {
      const cwd = state.activeCwd || state.workspaces[0]?.cwd;
      if (cwd) void navigate(cwd);
      else {
        toast(t("err.addWorkspace"));
        return false;
      }
    }
    const request = navigation;
    if (opening && !await opening) return false;
    if (request !== navigation || closed) return false;
    if (state.connection === "ready") return true;
    const ready = await attached?.promise;
    if (request !== navigation || closed) return false;
    if (!ready) toast(t("err.notConnected"));
    return !!ready;
  }

  // ------------------------------------------------------------------ frames
  /**
   * A streaming tool can send hundreds of previews per second. Only the newest one per call is worth drawing, so they
   * are coalesced here and the state is updated at most every TOOL_UPDATE_FLUSH_MS; the reducer keeps the order of one
   * call's previews by replacing its tail.
   */
  let toolUpdates = new Map<string, EventFrame>();
  let toolUpdateTimer: ReturnType<typeof setTimeout> | undefined;

  function flushToolUpdates(): void {
    if (toolUpdateTimer) {
      clearTimeout(toolUpdateTimer);
      toolUpdateTimer = undefined;
    }
    if (!toolUpdates.size) return;
    const frames = [...toolUpdates.values()];
    toolUpdates = new Map();
    const at = now();
    set((s) => frames.reduce((acc, f) => applyFrame(acc, f, at), s));
  }

  function dropToolUpdates(): void {
    clearTimeout(toolUpdateTimer);
    toolUpdateTimer = undefined;
    toolUpdates = new Map();
  }

  function onFrame(text: string): void {
    rawPush("in", text);
    let f: EventFrame | Response;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (f.type === "response") {
      const r = f as Response;
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.success) p.resolve(r.data);
      else p.reject(new Error(r.error ?? "failed"));
      return;
    }
    const ev = f as EventFrame & Record<string, unknown>;
    if (ev.type === "cgs_control") {
      // Control is independent of the history load: the host sends it right after the stream opens, and a page that
      // dropped it while hydrating would keep writing into a conversation it no longer controls (ADR 0047).
      set((s) => applyFrame(s, ev, now()));
      return;
    }
    if (ev.type === "bridge_snapshot") {
      if (hydrating) snapshot = ev;
      return;
    }
    if (hydrating && ev.type !== "bridge_exit") return;
    if (ev.type === "tool_execution_update" || ev.type === "tool_stream_update") {
      if (!ev.toolCallId) return;
      toolUpdates.set(ev.toolCallId, ev);
      toolUpdateTimer ??= setTimeout(flushToolUpdates, TOOL_UPDATE_FLUSH_MS);
      return;
    }
    // Whatever ends or replaces the run must not be drawn before the previews that led to it.
    if (ev.type === "tool_execution_end" || ev.type === "agent_end" || ev.type === "prompt_result" || ev.type === "session_settled" || ev.type === "bridge_exit") flushToolUpdates();
    switch (ev.type) {
      case "bridge_exit":
        clearTimeout(hold?.timer);
        hold = undefined;
        set((s) => ({ ...s, run: { state: "idle", streaming: false } }));
        toast(t("toast.exited", { code: String(ev.exitCode) }));
        return;
      case "agent_start":
        set((s) => applyFrame(s, ev, now()));
        startRun();
        return;
      case "thinking_level_changed":
        set((s) => ({ ...s, thinking: { resolved: (ev.resolved as ThinkingLevel) ?? s.thinking.resolved, configured: (ev.configured as ThinkingLevel | "auto") ?? s.thinking.configured } }));
        return;
      case "todo_auto_clear":
        void refreshState();
        return;
      case "model_changed":
        void refreshState();
        return;
      case "command_output":
        // What a slash command printed; the compaction in flight is the one this client asked for.
        if (state.compacting) {
          const text = String(ev.text ?? "");
          const next = compactFailed(text) ? compactFallbackMode : undefined;
          compactFallbackMode = undefined;
          if (next) {
            toast(t("compact.fallback", { mode: t(`compact.mode.${next}`) }));
            void startCompaction(next);
            return;
          }
          set((s) => ({ ...s, compacting: false }));
          toast(text);
          void refreshState();
        }
        return;
      case "prompt_result":
        onPromptResult(ev as unknown as PromptResult);
        return;
      case "session_settled":
        settle();
        return;
      case "extension_ui_request":
        if (ev.method === "setTitle") void refreshSessions(); // omp named the session; the title itself is read from the session file
        else if (ev.method === "notify") toast(String(ev.message ?? ""));
        else if (ev.method === "set_editor_text") restoreDraft(String(ev.text ?? ""));
        else set((s) => applyFrame(s, ev, now())); // dialogs and cancel; other presentation requests are not drawn
        return;
    }
    set((s) => applyFrame(s, ev, now()));
    const ring = ringFor(ev);
    if (ring && state.run.streaming && !runEnded) requestRing(ring);
  }

  const unsubscribeLocale = subscribeLocale(syncTitleLanguage);

  // ------------------------------------------------------------------ compaction
  /** The mode to run when the one in flight fails (quick compaction falls back to a local summary); cleared once it is used or the run ends. */
  let compactFallbackMode: CompactMode | undefined;

  /** Sends `/compact <mode>`; the result arrives as `command_output`. A refusal frees the button. */
  async function startCompaction(mode: CompactMode): Promise<void> {
    const current = epoch;
    set((s) => ({ ...s, compacting: true }));
    try {
      await rpc({ type: "prompt", message: compactCommand(mode) });
    } catch (e) {
      if (epoch === current) {
        compactFallbackMode = undefined;
        set((s) => ({ ...s, compacting: false }));
        toast(errorMessage(e));
      }
    }
  }

  function workspace() {
    if (!host.workspace) throw new Error(t("err.noWorkspace"));
    return host.workspace;
  }

  // ------------------------------------------------------------------ actions
  const actions: Actions = {
    async send(text, images) {
      const textTrimmed = text.trim();
      if (!textTrimmed && !images?.length) return;
      if (opening || state.connection !== "ready") {
        if (!await prepareSend()) {
          if (!closed) restoreDraft(textTrimmed, images);
          return;
        }
      }
      if (!canWrite()) {
        // Another client controls the conversation (ADR 0047): the text goes back to the editor, nothing is sent.
        restoreDraft(textTrimmed, images);
        toast(t("control.blocked"));
        return;
      }
      const current = epoch;
      if (state.run.streaming) {
        try {
          await rpc({ type: "steer", message: textTrimmed, ...toImageContent(images) });
        } catch (e) {
          if (epoch !== current) return;
          restoreDraft(textTrimmed, images);
          toast(errorMessage(e));
        }
        return;
      }
      const turn: Turn = { id: newTurnId(), user: { text: textTrimmed, ...(images?.length ? { images } : {}) }, assistant: [], state: "running", startedAt: now(), pending: true };
      runEnded = false;
      endInfo = undefined;
      set((s) => ({ ...s, turns: [...s.turns, turn], title: s.title || textTrimmed.slice(0, 60) || "…", run: { ...s.run, streaming: true } }));
      requestRing("work");
      try {
        const r = await rpc<{ agentInvoked?: boolean }>({ type: "prompt", message: textTrimmed, ...toImageContent(images) });
        if (epoch !== current) return;
        if (r?.agentInvoked === false) {
          // handled locally (a slash command): no model turn follows, the message stays
          set((s) => ({ ...s, turns: s.turns.map((x) => (x.id === turn.id ? { ...x, pending: false, state: "done" } : x)), run: { ...s.run, streaming: false } }));
          requestRing("idle");
        }
      } catch (e) {
        if (epoch !== current) return;
        set((s) => ({ ...s, turns: s.turns.filter((x) => x.id !== turn.id), run: { ...s.run, streaming: false } }));
        requestRing("idle");
        restoreDraft(textTrimmed, images);
        toast(errorMessage(e));
      }
    },
    stop: () => guard(async () => void (await rpc({ type: "abort" }))),
    deliverQueueNow: () =>
      guard(async () => {
        deliveringQueue = true;
        const current = epoch;
        try {
          const r = await rpc<{ aborted?: boolean }>({ type: "abort_and_deliver_queue" });
          if (epoch !== current) return;
          if (!r?.aborted) deliveringQueue = false; // nothing was queued or running: no aborted result will follow
        } catch (e) {
          if (epoch === current) deliveringQueue = false;
          throw e;
        }
      }),
    removeQueued: (index) =>
      guard(async () => {
        const item = state.queue[index];
        if (!item) return;
        const r = await rpc<{ removed?: boolean }>({ type: "remove_queued_message", message: item.text, queue: item.mode === "steer" ? "steering" : "followUp" });
        if (r?.removed) restoreDraft(item.text);
      }),
    restoreDraft,
    notify: toast,
    answerDialog: (id: string, answer: DialogAnswer) => {
      const settle = localAnswers.get(id);
      if (settle) {
        localAnswers.delete(id);
        set((s) => ({ ...s, dialogs: s.dialogs.filter((d) => d.id !== id) }));
        settle("confirmed" in answer && answer.confirmed);
        return;
      }
      if (!canWrite()) {
        toast(t("control.blocked"));
        return;
      }
      sendFrame(JSON.stringify({ type: "extension_ui_response", id, ...answer }));
      set((s) => ({ ...s, dialogs: s.dialogs.filter((d) => d.id !== id) }));
    },
    compact: (mode) =>
      guard(async () => {
        if (state.compacting || state.run.streaming || state.connection !== "ready") return;
        compactFallbackMode = compactFallback(mode);
        await startCompaction(mode);
      }),
    newSession: async (cwd) => {
      const target = cwd || state.activeCwd || state.workspaces[0]?.cwd;
      if (target) await navigate(target);
    },
    openSession: async (path, cwd) => {
      if (path !== state.sessionFile || state.connection === "closed") await navigate(cwd, path);
    },
    addWorkspace: (cwd) =>
      guard(async () => {
        await host.addWorkspace(cwd);
        void refreshSessions();
        await actions.newSession(cwd);
      }),
    renameSession: (name) =>
      guard(async () => {
        await rpc({ type: "set_session_name", name });
        set((s) => ({ ...s, title: name }));
        await refreshSessions();
      }),
    fork: (turnIndex) =>
      guard(async () => {
        const d = await rpc<{ entries: SessionEntry[]; leafId?: string | null }>({ type: "get_entries" });
        const entryId = turnTailIds(d.entries, d.leafId)[turnIndex];
        if (!entryId) throw new Error(t("err.forkTarget"));
        const r = await rpc<{ cancelled?: boolean }>({ type: "fork", entryId });
        if (r?.cancelled) {
          toast(t("toast.forkCancelled"));
          return;
        }
        resetSession();
        await hydrate();
      }),
    setModel: (provider, modelId, role) =>
      guard(async () => {
        await rpc({ type: "set_model", provider, modelId, ...(role ? { role } : {}) });
        await refreshState();
      }),
    setThinking: (level) =>
      guard(async () => {
        await rpc({ type: "set_thinking_level", level });
        await refreshState();
      }),
    pickerRows: (query) => rpc<ModelPicker>({ type: "get_model_picker", ...(query ? { query } : {}), limit: 60 }),
    thinkingLevels: async () => (await rpc<{ levels?: ThinkingLevel[] }>({ type: "get_available_thinking_levels" })).levels ?? [],
    btw: (question) =>
      guard(async () => {
        const r = await rpc<{ record?: BtwRecord }>({ type: "btw", question });
        if (r?.record) set((s) => applyFrame(s, { type: "btw_record", record: r.record }, now()));
      }),
    btwCancel: () => guard(async () => void (await rpc({ type: "btw_cancel" }))),
    loadBtw: () =>
      guard(async () => {
        const r = await rpc<{ records?: BtwRecord[] }>({ type: "get_btw_history" });
        set((s) => ({ ...s, btw: (r.records ?? []).map((x) => ({ id: x.id, question: x.question, answer: x.answer ?? "", status: x.status })) }));
      }),
    subagentTranscript: async (id, fromByte): Promise<SubagentTranscript> => {
      const r = await rpc<{ messages?: RawMessage[]; nextByte?: number; reset?: boolean }>({ type: "get_subagent_messages", subagentId: id, ...(fromByte ? { fromByte } : {}) });
      return { messages: r.messages ?? [], nextByte: r.nextByte ?? fromByte ?? 0, reset: r.reset === true };
    },
    loadStats: async () => {
      const [totals, entries, subs] = await Promise.all([
        rpc<SessionTotals>({ type: "get_session_stats" }),
        rpc<{ entries: SessionEntry[]; leafId?: string | null }>({ type: "get_entries" }),
        rpc<{ subagents?: SubagentSnapshot[] }>({ type: "get_subagents" }).catch(() => ({ subagents: [] as SubagentSnapshot[] })),
      ]);
      const subagents = subs.subagents ?? [];
      const main = activeBranch(entries.entries, entries.leafId).flatMap((e) => (e.message ? [e.message as UsageMessage] : []));
      // Only live ones are read from their transcripts: finished runs are already in the task tool result above.
      const theirs = await Promise.all(
        subagents.filter((s) => s.status === "running" || s.status === "pending").map((s) =>
          rpc<{ messages?: UsageMessage[] }>({ type: "get_subagent_messages", subagentId: s.id }).then(
            (r) => r.messages ?? [],
            () => [] as UsageMessage[],
          ),
        ),
      );
      return buildStats(totals, [main, ...theirs], subagents);
    },
    sendRaw: (json) => void sendFrame(json),
    clearRaw: () => {
      rawFrames.length = 0;
      for (const cb of rawListeners) cb();
    },
    refreshSessions,
    refreshAccount,
    takeControl: () =>
      guard(async () => {
        const child = state.childId;
        if (!child) throw new Error(t("control.unavailable"));
        if (!host.takeControl) throw new Error(t("control.unavailable"));
        await host.takeControl(child);
      }),
    completePath: (typed) => host.complete(typed),
    listDir: (dir) => workspace().list(state.activeCwd, dir),
    readFile: (path) => workspace().read(state.activeCwd, path),
    gitStatus: () => workspace().gitStatus(state.activeCwd),
    gitDiff: (path, target) => workspace().gitDiff(state.activeCwd, path, target),
    gitStage: (paths) => workspace().gitStage(state.activeCwd, paths),
    gitUnstage: (paths) => workspace().gitUnstage(state.activeCwd, paths),
    gitDiscard: (paths) => workspace().gitDiscard(state.activeCwd, paths),
    gitCommit: (message) => workspace().gitCommit(state.activeCwd, message),
    gitFetch: () => workspace().gitFetch(state.activeCwd),
    gitPull: () => workspace().gitPull(state.activeCwd),
    gitPush: () => workspace().gitPush(state.activeCwd),
    gitBranches: () => workspace().gitBranches(state.activeCwd),
    gitCheckout: (branch, create) => workspace().gitCheckout(state.activeCwd, branch, create),
    gitLog: (limit) => workspace().gitLog(state.activeCwd, limit),
    gitCommitFiles: (hash) => workspace().gitCommitFiles(state.activeCwd, hash),
    watchWorkspace: (listener) => host.workspace?.watch(state.activeCwd, listener) ?? (() => {}),
  };

  const poll = setInterval(() => void refreshChildren(), CHILD_POLL_MS);
  const accountPoll = setInterval(() => void refreshAccount(), ACCOUNT_POLL_MS);
  void refreshAccount();
  const stopAccountWatch = host.watchAccount?.((account) => {
    // Pushed by the host the moment its poll answers; a request still in flight must not overwrite it with an older answer.
    accountRequest++;
    if (!closed) set((s) => ({ ...s, account: account ?? undefined }));
  });
  const bootstrap = Promise.all([host.info(), host.children(), host.sessions()]).then(
    ([info, children, workspaces]) => {
      if (closed || navigation) return;
      set((s) => ({ ...s, children, workspaces, device: info.device ?? "" }));
      const existing = children.reduce<ChildStatus | undefined>((recent, c) => !recent || c.updatedAt >= recent.updatedAt ? c : recent, undefined);
      const cwd = info.cwd || workspaces[0]?.cwd;
      if (existing) attach(existing);
      else if (cwd) {
        set((s) => ({ ...s, activeCwd: cwd }));
        void navigate(cwd);
      } else set((s) => ({ ...s, connection: "closed" }));
    },
    (e) => {
      if (!closed && !navigation) {
        set((s) => ({ ...s, connection: "closed" }));
        toast(errorMessage(e));
      }
    },
  );

  return {
    getState: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    actions,
    raw,
    close: () => {
      closed = true;
      cancelLocalDialogs();
      clearInterval(poll);
      clearInterval(accountPoll);
      stopAccountWatch?.();
      clearTimeout(hold?.timer);
      dropToolUpdates();
      unsubscribeLocale();
      detach();
    },
  };
}
