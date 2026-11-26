import { type EventFrame, applyFrame, initialState, newTurnId, ringFor } from "./reducer";
import { type SessionEntry, turnsFromEntries, turnsFromMessages, turnTailIds } from "./history";
import type { RawMessage } from "./messages";
import type { Actions, BtwRecord, Client, ClientState, HostApi, ModelPicker, RawLog, RingState, RpcTransport, ThinkingLevel, Turn } from "./types";
import { t } from "../i18n";

const RAW_CAP = 3000;
const RPC_TIMEOUT_MS = 60_000;
/** A fast model thinks for a fraction of a second: once the blue thinking ring shows, the next state waits this long. */
const THINK_HOLD_MS = 1500;

export interface ClientOptions {
  now?: () => number;
  holdMs?: number;
  rpcTimeoutMs?: number;
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
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createClient(transport: RpcTransport, host: HostApi, opts: ClientOptions = {}): Client {
  const now = opts.now ?? Date.now;
  const holdMs = opts.holdMs ?? THINK_HOLD_MS;
  const rpcTimeout = opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS;

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
  const rawPush = (dir: "in" | "out", text: string) => {
    rawFrames.push({ dir, text });
    if (rawFrames.length > RAW_CAP) rawFrames.splice(0, rawFrames.length - RAW_CAP);
    for (const cb of rawListeners) cb();
  };

  // ------------------------------------------------------------------ rpc
  const page = Math.random().toString(36).slice(2, 8); // the bridge replays old responses on connect: ids are unique per page load
  let seq = 0;
  const pending = new Map<string, Pending>();
  let replaying = true;
  let ready = Promise.withResolvers<void>();

  function sendFrame(text: string): boolean {
    if (!transport.send(text)) return false;
    rawPush("out", text);
    return true;
  }

  function rpc<T = unknown>(cmd: { type: string; [k: string]: unknown }): Promise<T> {
    const id = `${page}-${++seq}`;
    const p = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      pending.delete(id);
      p.reject(new Error(t("err.timeout", { cmd: cmd.type, n: Math.round(rpcTimeout / 1000) })));
    }, rpcTimeout);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), p.resolve(v as T)),
      reject: (e) => (clearTimeout(timer), p.reject(e)),
    });
    if (!sendFrame(JSON.stringify({ ...cmd, id }))) {
      pending.delete(id);
      clearTimeout(timer);
      p.reject(new Error(t("err.notConnected")));
    }
    return p.promise;
  }

  const toast = (text: string) => set((s) => ({ ...s, toast: { text, seq: (s.toast?.seq ?? 0) + 1 } }));
  const restoreDraft = (text: string) => set((s) => ({ ...s, draftRestore: { text, seq: (s.draftRestore?.seq ?? 0) + 1 } }));

  /** Runs a mutating action: failures become a toast instead of a rejection. */
  async function guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e));
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
  function finishTurns(turns: Turn[], status: string | undefined, message: string | undefined): { turns: Turn[]; restore?: string } {
    let restore: string | undefined;
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
      const started = t.assistant.some((a) => a.items.length > 0);
      if (!started) {
        restore = t.user.text;
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
    let restore: string | undefined;
    set((s) => {
      const r = finishTurns(s.turns, info?.status, info?.message);
      restore = r.restore;
      return { ...s, turns: r.turns, run: { ...s.run, streaming: false } };
    });
    if (restore !== undefined) restoreDraft(restore);
    if (info?.message && info.status !== "completed") toast(info.message);
    runEnded = true;
    endInfo = undefined;
    requestRing("idle");
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
      run: { ...s.run, streaming: !!st.isStreaming },
    }));
    if (st.isStreaming && state.run.state === "idle") requestRing("work");
  }

  async function refreshState(): Promise<void> {
    try {
      applyState(await rpc<StateData>({ type: "get_state" }));
    } catch {
      /* a later frame or action reports a real outage */
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      const workspaces = await host.sessions();
      set((s) => {
        const cur = workspaces.flatMap((w) => w.sessions).find((x) => x.path === s.sessionFile);
        return { ...s, workspaces, title: cur?.title ?? s.title };
      });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  function resetSession(): void {
    clearTimeout(hold?.timer);
    hold = undefined;
    runEnded = false;
    endInfo = undefined;
    set((s) => ({ ...s, turns: [], tools: {}, queue: [], btw: [], title: "", run: { state: "idle", streaming: false } }));
  }

  async function loadSession(): Promise<void> {
    try {
      let built: ReturnType<typeof turnsFromEntries>;
      try {
        const d = await rpc<{ entries: SessionEntry[]; leafId?: string | null }>({ type: "get_entries" });
        built = turnsFromEntries(d.entries, d.leafId);
      } catch {
        const d = await rpc<{ messages?: RawMessage[] } | RawMessage[]>({ type: "get_messages" });
        built = turnsFromMessages((Array.isArray(d) ? d : (d.messages ?? [])).map((message) => ({ message })));
      }
      set((s) => {
        const turns = built.turns.slice();
        const last = turns.at(-1);
        if (last && s.run.streaming) turns[turns.length - 1] = { ...last, state: "running" };
        return { ...s, turns, tools: built.tools, title: turns[0]?.user.text.slice(0, 60) ?? "" };
      });
    } catch (e) {
      toast(errorMessage(e));
    }
    await refreshSessions();
    if (state.run.streaming) requestRing("work");
  }

  async function enter(cwd: string): Promise<void> {
    if (cwd === state.cwd) return;
    const r = await host.enter(cwd);
    set((s) => ({ ...s, cwd: r.cwd }));
    if (r.restarted) await ready.promise;
  }

  // ------------------------------------------------------------------ frames
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
    if (ev.type === "ready") ready.resolve();
    if (replaying) return; // backlog from before this page connected: the chat is rebuilt from get_state and the session file
    switch (ev.type) {
      case "bridge_restart":
        ready = Promise.withResolvers<void>();
        resetSession();
        set((s) => ({ ...s, cwd: String(ev.cwd ?? s.cwd) }));
        return;
      case "bridge_exit":
        toast(t("toast.exited", { code: String(ev.exitCode) }));
        return;
      case "agent_start":
        set((s) => applyFrame(s, ev, now()));
        startRun();
        return;
      case "thinking_level_changed":
        set((s) => ({ ...s, thinking: { resolved: (ev.resolved as ThinkingLevel) ?? s.thinking.resolved, configured: (ev.configured as ThinkingLevel | "auto") ?? s.thinking.configured } }));
        return;
      case "model_changed":
        void refreshState();
        return;
      case "prompt_result":
        onPromptResult(ev as unknown as PromptResult);
        return;
      case "session_settled":
        settle();
        return;
      case "extension_ui_request":
        if (ev.method === "setTitle") void refreshSessions(); // omp named the session; the title itself is read from the session file
        return;
    }
    set((s) => applyFrame(s, ev, now()));
    const ring = ringFor(ev);
    if (ring && state.run.streaming && !runEnded) requestRing(ring);
  }

  transport.onFrame(onFrame);
  transport.onStatus((status) => {
    set((s) => ({ ...s, connection: status }));
    if (status === "closed") {
      for (const p of pending.values()) p.reject(new Error("disconnected"));
      pending.clear();
      replaying = true;
      return;
    }
    if (status !== "ready") return;
    replaying = true;
    void (async () => {
      await refreshState();
      replaying = false;
      await loadSession();
    })();
  });

  // ------------------------------------------------------------------ actions
  const actions: Actions = {
    async send(text) {
      const t = text.trim();
      if (!t) return;
      if (state.run.streaming) {
        try {
          await rpc({ type: "steer", message: t });
        } catch (e) {
          restoreDraft(t);
          toast(errorMessage(e));
        }
        return;
      }
      const turn: Turn = { id: newTurnId(), user: { text: t }, assistant: [], state: "running", startedAt: now(), pending: true };
      runEnded = false;
      endInfo = undefined;
      set((s) => ({ ...s, turns: [...s.turns, turn], title: s.title || t.slice(0, 60), run: { ...s.run, streaming: true } }));
      requestRing("work");
      try {
        const r = await rpc<{ agentInvoked?: boolean }>({ type: "prompt", message: t });
        if (r?.agentInvoked === false) {
          // handled locally (a slash command): no model turn follows, the message stays
          set((s) => ({ ...s, turns: s.turns.map((x) => (x.id === turn.id ? { ...x, pending: false, state: "done" } : x)), run: { ...s.run, streaming: false } }));
          requestRing("idle");
        }
      } catch (e) {
        set((s) => ({ ...s, turns: s.turns.filter((x) => x.id !== turn.id), run: { ...s.run, streaming: false } }));
        requestRing("idle");
        restoreDraft(t);
        toast(errorMessage(e));
      }
    },
    stop: () => guard(async () => void (await rpc({ type: "abort" }))),
    deliverQueueNow: () =>
      guard(async () => {
        deliveringQueue = true;
        try {
          const r = await rpc<{ aborted?: boolean }>({ type: "abort_and_deliver_queue" });
          if (!r?.aborted) deliveringQueue = false; // nothing was queued or running: no aborted result will follow
        } catch (e) {
          deliveringQueue = false;
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
    newSession: (cwd) =>
      guard(async () => {
        const target = cwd ?? (state.activeCwd || state.cwd);
        await enter(target);
        const r = await rpc<{ cancelled?: boolean }>({ type: "new_session" });
        if (r?.cancelled) {
          toast(t("toast.switchCancelled"));
          return;
        }
        set((s) => ({ ...s, activeCwd: target }));
        resetSession();
        await refreshState();
        await refreshSessions();
      }),
    openSession: (path, cwd) =>
      guard(async () => {
        if (path === state.sessionFile) return;
        await enter(cwd);
        const r = await rpc<{ cancelled?: boolean }>({ type: "switch_session", sessionPath: path });
        if (r?.cancelled) {
          toast(t("toast.switchCancelled"));
          return;
        }
        set((s) => ({ ...s, activeCwd: cwd }));
        resetSession();
        await refreshState();
        await loadSession();
      }),
    addWorkspace: (cwd) =>
      guard(async () => {
        await host.addWorkspace(cwd);
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
        await refreshState();
        await loadSession();
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
    sendRaw: (json) => void sendFrame(json),
    clearRaw: () => {
      rawFrames.length = 0;
      for (const cb of rawListeners) cb();
    },
    refreshSessions,
    completePath: (typed) => host.complete(typed),
  };

  void host.info().then(
    (i) => set((s) => ({ ...s, cwd: i.cwd, activeCwd: s.activeCwd || i.cwd })),
    (e) => toast(errorMessage(e)),
  );

  return {
    getState: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    actions,
    raw,
    close: () => transport.close(),
  };
}
