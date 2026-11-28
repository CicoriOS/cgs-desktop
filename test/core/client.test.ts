import { afterEach, expect, test } from "vitest";
import { createClient } from "../../src/core/client";
import { getLocale, setLocale, t } from "../../src/i18n";
import { childA, fakeHost, fakeTransport, tick } from "./fake";

const clients = new Set<{ close(): void }>();
afterEach(() => { for (const c of clients) c.close(); clients.clear(); });

async function connected(holdMs = 0) {
  const t = fakeTransport();
  const c = createClient(() => t.transport, fakeHost, { holdMs });
  clients.add(c);
  await tick();
  t.open();
  await tick();
  t.respond("set_title_language");
  t.respond("get_state", { model: { provider: "p", id: "m", name: "M" }, thinkingLevel: "high", configuredThinkingLevel: "auto", sessionFile: "/s.jsonl", isStreaming: false });
  await tick();
  t.respond("get_entries", { entries: [], leafId: null });
  await tick();
  return { t, c };
}

test("title language follows the UI on each attachment and locale change without surfacing unsupported-command errors", async () => {
  const original = getLocale();
  const t = fakeTransport();
  const c = createClient(() => t.transport, fakeHost);
  clients.add(c);
  await tick();
  const languages = () => t.sent.filter((f) => f.type === "set_title_language").map((f) => f.language);
  try {
    setLocale("zh");
    expect(languages()).toEqual([]);
    t.open();
    t.push({ type: "ready" }); // the WebSocket ready callback sends the command only once
    expect(languages()).toEqual(["Chinese (Simplified)"]);
    t.fail("set_title_language", "Unknown command");
    t.respond("get_state", {});
    await tick();
    t.respond("get_entries", { entries: [] });
    await tick();
    expect(c.getState().toast).toBeUndefined();

    setLocale("en");
    expect(languages()).toEqual(["Chinese (Simplified)", "English"]);
    t.respond("set_title_language");
    t.open(); // new socket connection to the same child
    expect(languages()).toEqual(["Chinese (Simplified)", "English", "English"]);
    t.respond("set_title_language");
  } finally {
    c.close();
    setLocale(original);
  }
});

test.each([false, true])("send from an empty workspace waits for the fresh child (New chat: %s)", async (newChat) => {
  const socket = fakeTransport();
  const child = Promise.withResolvers<typeof childA>();
  const opened: string[] = [];
  const c = createClient(() => socket.transport, {
    ...fakeHost,
    info: async () => ({ cwd: "" }),
    sessions: async () => [{ cwd: "/remembered", sessions: [] }],
    children: async () => [],
    openChild: (cwd) => {
      opened.push(cwd);
      return child.promise;
    },
  });
  clients.add(c);
  if (newChat) {
    await tick();
    void c.actions.newSession();
  }
  const send = c.actions.send("first prompt");
  await tick();
  expect(opened).toEqual(newChat ? ["/remembered", "/remembered"] : ["/remembered"]);
  expect(socket.sent).toEqual([]);
  child.resolve({ ...childA, cwd: "/remembered" });
  await tick();
  socket.open();
  socket.respond("set_title_language");
  socket.respond("get_state", {});
  await tick();
  expect(socket.sent.some((frame) => frame.type === "prompt")).toBe(false);
  socket.respond("get_entries", { entries: [] });
  await tick();
  expect(socket.sent.filter((frame) => frame.type === "prompt")).toMatchObject([{ message: "first prompt" }]);
  socket.respond("prompt", { agentInvoked: true });
  await send;
  expect(c.getState().toast).toBeUndefined();
});

test("idle send shows the message at once and sends prompt; the echo does not duplicate it", async () => {
  const { t, c } = await connected();
  const sending = c.actions.send(" 你好 ");
  expect(c.getState().turns).toMatchObject([{ user: { text: "你好" }, pending: true }]);
  expect(c.getState().run).toMatchObject({ streaming: true, state: "work" });
  expect(t.sent.at(-1)).toMatchObject({ type: "prompt", message: "你好" });
  t.respond("prompt", { agentInvoked: true });
  await sending;
  t.push({ type: "message_start", message: { role: "user", content: "你好" } });
  expect(c.getState().turns).toHaveLength(1);
  expect(c.getState().turns[0]!.pending).toBe(false);
});

test("sending while the agent is busy steers instead of prompting", async () => {
  const { t, c } = await connected();
  t.push({ type: "agent_start" });
  const sending = c.actions.send("改用 pnpm");
  expect(t.sent.at(-1)).toMatchObject({ type: "steer", message: "改用 pnpm" });
  t.respond("steer");
  await sending;
  t.push({ type: "queue_update", steering: ["改用 pnpm"], followUp: [] });
  expect(c.getState().queue).toEqual([{ text: "改用 pnpm", mode: "steer" }]);
});

test("a failed prompt removes the message and hands the text back", async () => {
  const { t, c } = await connected();
  const sending = c.actions.send("hi");
  t.fail("prompt", "boom");
  await sending;
  expect(c.getState().turns).toEqual([]);
  expect(c.getState().draftRestore?.text).toBe("hi");
  expect(c.getState().toast?.text).toBe("boom");
  expect(c.getState().run.streaming).toBe(false);
});

test("a prompt that fails before the model produced anything leaves the transcript and returns to the draft", async () => {
  const { t, c } = await connected();
  const sending = c.actions.send("问题");
  t.respond("prompt", { agentInvoked: true });
  await sending;
  t.push({ type: "message_start", message: { role: "user", content: "问题" } });
  t.push({ type: "prompt_result", status: "error", error: { message: "404 no model" }, sessionSettled: true });
  expect(c.getState().turns).toEqual([]);
  expect(c.getState().draftRestore?.text).toBe("问题");
  expect(c.getState().toast?.text).toBe("404 no model");
});

test("an interrupted turn that already produced work stays and is marked", async () => {
  const { t, c } = await connected();
  t.push({ type: "agent_start" });
  t.push({ type: "message_start", message: { role: "user", content: "写首诗" } });
  t.push({ type: "message_update", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: "春" }] }, assistantMessageEvent: { type: "text_delta" } });
  t.push({ type: "prompt_result", status: "aborted", sessionSettled: true });
  expect(c.getState().turns).toMatchObject([{ user: { text: "写首诗" }, state: "interrupted" }]);
  expect(c.getState().draftRestore).toBeUndefined();
});

test("deliver-now continues the run with the queue: the aborted result of the cut prompt is ignored, session_settled ends it", async () => {
  // Frame order captured from omp: agent_end, agent_start, the queued user message, then prompt_result(aborted, sessionSettled:false).
  const { t, c } = await connected();
  t.push({ type: "agent_start" });
  t.push({ type: "message_start", message: { role: "user", content: "first" } });
  t.push({ type: "queue_update", steering: ["用英文回答"], followUp: [] });
  const d = c.actions.deliverQueueNow();
  expect(t.sent.at(-1)).toMatchObject({ type: "abort_and_deliver_queue" });
  t.respond("abort_and_deliver_queue", { aborted: true });
  await d;
  t.push({ type: "agent_start" });
  t.push({ type: "message_start", message: { role: "user", content: "用英文回答" } });
  t.push({ type: "queue_update", steering: [], followUp: [] });
  t.push({ type: "prompt_result", status: "aborted", sessionSettled: false });
  expect(c.getState().run.streaming).toBe(true);
  expect(c.getState().turns.map((x) => [x.user.text, x.state])).toEqual([["first", "done"], ["用英文回答", "running"]]);
  t.push({ type: "message_update", messageId: "m2", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, assistantMessageEvent: { type: "text_delta" } });
  t.push({ type: "session_settled" });
  expect(c.getState().turns.map((x) => x.state)).toEqual(["done", "done"]);
  expect(c.getState().draftRestore).toBeUndefined();
  expect(c.getState().toast).toBeUndefined();
});

test("a later real abort is not swallowed when deliver-now found nothing to deliver", async () => {
  const { t, c } = await connected();
  t.push({ type: "agent_start" });
  t.push({ type: "message_start", message: { role: "user", content: "first" } });
  const d = c.actions.deliverQueueNow();
  t.respond("abort_and_deliver_queue", { aborted: false });
  await d;
  t.push({ type: "message_update", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "x" }] }, assistantMessageEvent: { type: "text_delta" } });
  t.push({ type: "prompt_result", status: "aborted", sessionSettled: true });
  expect(c.getState().turns).toMatchObject([{ state: "interrupted" }]);
});

test("the thinking ring stays visible for the hold time before the next state", async () => {
  const { t, c } = await connected(40);
  t.push({ type: "agent_start" });
  t.push({ type: "message_update", messageId: "m", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }] }, assistantMessageEvent: { type: "thinking_delta" } });
  expect(c.getState().run.state).toBe("think");
  t.push({ type: "message_update", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "好" }] }, assistantMessageEvent: { type: "text_delta" } });
  expect(c.getState().run.state).toBe("think");
  await new Promise((r) => setTimeout(r, 70));
  expect(c.getState().run.state).toBe("work");
});

test("removing a queued message returns it to the draft only when omp removed it", async () => {
  const { t, c } = await connected();
  t.push({ type: "agent_start" });
  t.push({ type: "queue_update", steering: ["稍后"], followUp: [] });
  const r = c.actions.removeQueued(0);
  expect(t.sent.at(-1)).toMatchObject({ type: "remove_queued_message", message: "稍后", queue: "steering" });
  t.respond("remove_queued_message", { removed: true });
  await r;
  expect(c.getState().draftRestore?.text).toBe("稍后");
});

test("an ask form becomes a dialog; answering sends extension_ui_response and closes it; omp's cancel closes it too", async () => {
  const { t, c } = await connected();
  t.push({ type: "extension_ui_request", id: "ui1", method: "form", html: "<form></form>" });
  t.push({ type: "extension_ui_request", id: "ui2", method: "confirm", title: "Run it?", message: "rm -rf" });
  expect(c.getState().dialogs.map((d) => [d.id, d.method])).toEqual([["ui1", "form"], ["ui2", "confirm"]]);
  c.actions.answerDialog("ui1", { data: { db: "pg" } });
  expect(t.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ui1", data: { db: "pg" } });
  expect(c.getState().dialogs.map((d) => d.id)).toEqual(["ui2"]);
  t.push({ type: "extension_ui_request", id: "ui3", method: "cancel", targetId: "ui2" });
  expect(c.getState().dialogs).toEqual([]);
});

test("slash-command dialogs send the replies omp expects without a model turn", async () => {
  const { t, c } = await connected();
  const prompt = c.actions.send("/dialog-verification");
  const dialogs = [
    [{ method: "confirm", title: "Confirm verification", message: "Approve?" }, { confirmed: true }],
    [{ method: "select", title: "Select verification", options: ["Alpha", "Beta"] }, { value: "Beta" }],
    [{ method: "input", title: "Input verification", placeholder: "Single-line placeholder" }, { value: "verified input" }],
    [{ method: "editor", title: "Editor verification", prefill: "First line\nSecond line" }, { value: "Edited line one\nEdited line two" }],
  ] as const;
  for (const [request, answer] of dialogs) {
    const id = `dialog-${request.method}`;
    t.push({ type: "extension_ui_request", id, ...request });
    expect(c.getState().dialogs).toMatchObject([{ id, ...request }]);
    c.actions.answerDialog(id, answer);
    expect(t.sent.at(-1)).toEqual({ type: "extension_ui_response", id, ...answer });
    expect(c.getState().dialogs).toEqual([]);
  }
  t.respond("prompt", { agentInvoked: false });
  await prompt;
  expect(c.getState().run.streaming).toBe(false);
  c.close();
});

test("notify shows a toast and set_editor_text fills the draft; neither opens a dialog", async () => {
  const { t, c } = await connected();
  t.push({ type: "extension_ui_request", id: "n1", method: "notify", message: "heads up" });
  t.push({ type: "extension_ui_request", id: "n2", method: "set_editor_text", text: "draft" });
  expect(c.getState().toast?.text).toBe("heads up");
  expect(c.getState().draftRestore?.text).toBe("draft");
  expect(c.getState().dialogs).toEqual([]);
});

test("attaching while the ask tool waits restores its pending form from the snapshot", async () => {
  const t = fakeTransport();
  const c = createClient(() => t.transport, fakeHost, { holdMs: 0 });
  clients.add(c);
  await tick();
  t.open();
  t.respond("set_title_language");
  await tick();
  t.push({ type: "extension_ui_request", id: "old", method: "form", html: "<form>a</form>" });
  t.respond("get_state", { isStreaming: true, sessionFile: "/s.jsonl" });
  await tick();
  t.push({ type: "bridge_snapshot", ring: "work", dialogs: [{ type: "extension_ui_request", id: "live", method: "form", html: "<form>b</form>" }] });
  t.respond("get_entries", { entries: [], leafId: null });
  expect(c.getState().dialogs.map((d) => d.id)).toEqual(["live"]);
});

test("images ride along with prompt and steer, and show in the optimistic message", async () => {
  const { t, c } = await connected();
  const img = { mimeType: "image/png", data: "AAAA" };
  const sending = c.actions.send("看图", [img]);
  expect(c.getState().turns[0]!.user.images).toEqual([img]);
  expect(t.sent.at(-1)).toMatchObject({ type: "prompt", message: "看图", images: [{ type: "image", mimeType: "image/png", data: "AAAA" }] });
  t.respond("prompt", { agentInvoked: true });
  await sending;
  t.push({ type: "agent_start" });
  const steering = c.actions.send("", [img]); // images alone are a message
  expect(t.sent.at(-1)).toMatchObject({ type: "steer", message: "", images: [{ type: "image" }] });
  t.respond("steer");
  await steering;
});

test("New chat uses the active workspace, detaches without aborting, and reattaches to a running tool", async () => {
  const a = fakeTransport();
  const b = fakeTransport();
  const again = fakeTransport();
  const opened: unknown[] = [];
  const aChild = { ...childA, cwd: "/active" };
  let first = true;
  const c = createClient((id) => id === "b" ? b.transport : (first ? (first = false, a.transport) : again.transport), {
    ...fakeHost,
    children: async () => [aChild],
    sessions: async () => [{ cwd: "/most-recent-workspace", sessions: [] }, { cwd: "/active", sessions: [] }],
    openChild: async (cwd, file) => {
      opened.push([cwd, file]);
      return file ? aChild : { ...aChild, id: "b", sessionPath: "/b.jsonl" };
    },
  }, { holdMs: 0 });
  clients.add(c);
  await tick();
  a.open();
  a.respond("set_title_language");
  a.respond("get_state", { isStreaming: false, sessionFile: "/s.jsonl" });
  await tick();
  a.respond("get_entries", { entries: [] });
  const send = c.actions.send("Run the long command");
  a.push({ type: "agent_start" });

  await c.actions.newSession();
  expect(opened).toEqual([["/active", undefined]]);
  expect(a.isClosed()).toBe(true);
  expect(a.sent.map((f) => f.type)).not.toContain("abort");
  expect(c.getState()).toMatchObject({ childId: "b", turns: [], run: { streaming: false } });
  await send; // the detached prompt's admission response must not clear B's state or restore a draft there
  expect(c.getState().draftRestore).toBeUndefined();
  b.open();
  b.respond("set_title_language");
  b.respond("get_state", {});
  await tick();
  b.respond("get_entries", { entries: [] });

  await c.actions.openSession("/s.jsonl", "/active");
  expect(opened.at(-1)).toEqual(["/active", "/s.jsonl"]);
  expect(b.isClosed()).toBe(true);
  again.open();
  again.respond("set_title_language");
  again.respond("get_state", { isStreaming: true });
  await tick();
  const user = { role: "user", content: "Run the long command" };
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "sleep 20" } }] };
  again.push({ type: "message_start", message: user }); // already included in the snapshot; must not create another turn
  again.push({ type: "bridge_snapshot", ring: "work" });
  again.respond("get_entries", { entries: [
    { id: "u", parentId: null, type: "message", message: user },
    { id: "a", parentId: "u", type: "message", message: assistant },
  ] });
  expect(c.getState().tools.call?.status).toBe("running");
  again.push({ type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: "done" }] } });
  again.push({ type: "message_update", messageId: "live", message: { role: "assistant", content: [{ type: "text", text: "d" }] } });
  again.push({ type: "message_end", messageId: "live", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  again.push({ type: "session_settled" });
  expect(c.getState().tools.call).toMatchObject({ status: "ok", args: { command: "sleep 20" } });
  expect(c.getState().turns).toHaveLength(1);
  expect(c.getState().turns[0]).toMatchObject({ state: "done", assistant: [{ id: "a" }, { id: "live", items: [{ text: "done" }] }] });
});

const userEntry = (id: string, parentId: string | null, text: string) => ({ id, parentId, type: "message", message: { role: "user", content: text } });
const replyEntry = (id: string, parentId: string, text: string) => ({ id, parentId, type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

function memoryCache() {
  const rows = new Map<string, import("../../src/core/history").CachedSession>();
  const saved: string[] = [];
  return {
    rows,
    saved,
    cache: {
      load: async (path: string) => rows.get(path),
      save: async (path: string, s: import("../../src/core/history").CachedSession) => { saved.push(path); rows.set(path, s); },
    },
  };
}

test("a loaded history is kept; opening that session again shows the copy while the child starts, and the device's history replaces it", async () => {
  const mem = memoryCache();
  const t = fakeTransport();
  const child = Promise.withResolvers<typeof childA>();
  const host = { ...fakeHost, children: async () => [], openChild: () => child.promise };
  const c = createClient(() => t.transport, host, { holdMs: 0, cache: mem.cache });
  clients.add(c);
  await tick();

  // First open: nothing cached, the page shows the loading state with no turns; the history that arrives is saved.
  void c.actions.openSession("/s.jsonl", "/work");
  await tick();
  expect(c.getState()).toMatchObject({ loading: true, sessionFile: "/s.jsonl", connection: "connecting", turns: [] });
  child.resolve({ ...childA, sessionPath: "/s.jsonl" });
  await tick();
  t.open();
  await tick();
  t.respond("set_title_language");
  t.respond("get_state", { sessionFile: "/s.jsonl", isStreaming: false });
  await tick();
  t.respond("get_entries", { entries: [userEntry("u1", null, "hello"), replyEntry("a1", "u1", "hi there")], leafId: "a1" });
  await tick();
  expect(c.getState()).toMatchObject({ loading: false, connection: "ready" });
  expect(mem.saved).toEqual(["/s.jsonl"]);
  expect(mem.rows.get("/s.jsonl")?.turns[0]?.user.text).toBe("hello");

  // Open another session, then this one again: the copy shows before the child answers.
  const second = Promise.withResolvers<typeof childA>();
  host.openChild = () => second.promise;
  void c.actions.openSession("/s.jsonl", "/work"); // same session while ready is a no-op
  await tick();
  expect(c.getState().loading).toBe(false);
  void c.actions.openSession("/other.jsonl", "/work");
  await tick();
  expect(c.getState()).toMatchObject({ loading: true, sessionFile: "/other.jsonl", turns: [] });
  void c.actions.openSession("/s.jsonl", "/work");
  await tick();
  const s = c.getState();
  expect(s).toMatchObject({ loading: true, connection: "connecting", sessionFile: "/s.jsonl" });
  expect(s.turns.map((x) => x.user.text)).toEqual(["hello"]);
  expect(s.turns[0]!.state).toBe("done");
});

test("a session that cannot be opened stops loading instead of spinning forever", async () => {
  const mem = memoryCache();
  const t = fakeTransport();
  const host = { ...fakeHost, children: async () => [], openChild: async () => { throw new Error("no such session"); } };
  const c = createClient(() => t.transport, host, { cache: mem.cache });
  clients.add(c);
  await tick();
  await c.actions.openSession("/gone.jsonl", "/work");
  expect(c.getState()).toMatchObject({ loading: false, connection: "closed" });
  expect(c.getState().toast?.text).toBe("no such session");
});

test("a conversation held by a busy terminal asks, then reopens with yield (ADR 0047)", async () => {
  const socket = fakeTransport();
  const calls: { cwd: string; file?: string; options?: { yield?: boolean } }[] = [];
  const host = {
    ...fakeHost,
    openChild: async (cwd: string, file?: string, options?: { yield?: boolean }) => {
      calls.push({ cwd, file, options });
      if (!options?.yield) throw new Error("terminal_busy");
      return { ...childA, cwd, sessionPath: file };
    },
  };
  const c = createClient(() => socket.transport, host, { holdMs: 0 });
  clients.add(c);
  await tick();
  const opening = c.actions.openSession("/busy.jsonl", "/work");
  await tick();
  const dialog = c.getState().dialogs[0];
  expect(dialog).toMatchObject({ method: "confirm", title: t("session.busy.title") });
  expect(c.getState()).toMatchObject({ connection: "connecting", childId: undefined, sessionFile: "/busy.jsonl" });
  c.actions.answerDialog(dialog!.id, { confirmed: true });
  await opening;
  expect(calls).toEqual([
    { cwd: "/work", file: "/busy.jsonl", options: undefined },
    { cwd: "/work", file: "/busy.jsonl", options: { yield: true } },
  ]);
  expect(c.getState()).toMatchObject({ childId: "a", sessionFile: "/busy.jsonl", dialogs: [] });
});

test("declining the takeover leaves the conversation closed and does not retry", async () => {
  const t = fakeTransport();
  let calls = 0;
  const host = { ...fakeHost, openChild: async () => { calls++; throw new Error("terminal_busy"); } };
  const c = createClient(() => t.transport, host, { holdMs: 0 });
  clients.add(c);
  await tick();
  const opening = c.actions.openSession("/busy.jsonl", "/work");
  await tick();
  const dialog = c.getState().dialogs[0];
  expect(dialog).toMatchObject({ method: "confirm" });
  c.actions.answerDialog(dialog!.id, { confirmed: false });
  await opening;
  expect(calls).toBe(1);
  expect(c.getState()).toMatchObject({ connection: "closed", loading: false, dialogs: [] });
  expect(c.getState().toast).toBeUndefined();
});

test("compact sends the slash command once, stays busy until omp reports, and shows the report", async () => {
  const { t, c } = await connected();
  const commands = () => t.sent.filter((f) => f.type === "prompt").map((f) => f.message);
  void c.actions.compact("snapcompact");
  await tick();
  expect(commands()).toEqual(["/compact snapcompact"]);
  expect(c.getState().compacting).toBe(true);
  t.respond("prompt", { agentInvoked: false });
  await tick();
  expect(c.getState().compacting).toBe(true); // omp compacts in the background: the prompt answer is not the result
  void c.actions.compact("soft"); // refused while one runs
  await tick();
  expect(commands()).toEqual(["/compact snapcompact"]);
  t.push({ type: "command_output", text: "Compaction complete. Tokens: 90000 -> 12000 (saved 78000)." });
  await tick();
  expect(c.getState()).toMatchObject({ compacting: false, toast: { text: "Compaction complete. Tokens: 90000 -> 12000 (saved 78000)." } });
  void c.actions.compact("handoff");
  await tick();
  expect(commands()).toEqual(["/compact snapcompact", "/compact handoff"]);
});

test("a compaction omp refuses frees the button and tells why; one asked while the agent runs is not sent", async () => {
  const { t, c } = await connected();
  void c.actions.compact("remote");
  await tick();
  t.fail("prompt", "no compaction model");
  await tick();
  expect(c.getState()).toMatchObject({ compacting: false, toast: { text: "no compaction model" } });

  t.push({ type: "agent_start" });
  await tick();
  expect(c.getState().run.streaming).toBe(true);
  const before = t.sent.length;
  await c.actions.compact("snapcompact");
  expect(t.sent.length).toBe(before);
  expect(c.getState().compacting).toBe(false);
});

test("quick compaction that fails falls back to the local summary once; a failing fallback is reported as is", async () => {
  const { t, c } = await connected();
  const commands = () => t.sent.filter((f) => f.type === "prompt").map((f) => f.message);
  void c.actions.compact("snapcompact");
  await tick();
  t.respond("prompt", { agentInvoked: false });
  t.push({ type: "command_output", text: "Compaction failed: the model does not take image input" });
  await tick();
  expect(commands()).toEqual(["/compact snapcompact", "/compact soft"]);
  expect(c.getState().compacting).toBe(true); // still one compaction, now by summary
  t.respond("prompt", { agentInvoked: false });
  t.push({ type: "command_output", text: "Compaction complete. Tokens: 9000 -> 2000 (saved 7000)." });
  await tick();
  expect(c.getState()).toMatchObject({ compacting: false, toast: { text: "Compaction complete. Tokens: 9000 -> 2000 (saved 7000)." } });

  void c.actions.compact("snapcompact");
  await tick();
  t.respond("prompt", { agentInvoked: false });
  t.push({ type: "command_output", text: "Compaction failed: no image" });
  await tick();
  t.respond("prompt", { agentInvoked: false });
  t.push({ type: "command_output", text: "Compaction failed: no compaction model" });
  await tick();
  expect(commands().slice(2)).toEqual(["/compact snapcompact", "/compact soft"]); // no third try
  expect(c.getState()).toMatchObject({ compacting: false, toast: { text: "Compaction failed: no compaction model" } });

  void c.actions.compact("remote"); // a mode without a fallback is reported, not retried
  await tick();
  t.respond("prompt", { agentInvoked: false });
  t.push({ type: "command_output", text: "Compaction failed: x" });
  await tick();
  expect(commands().slice(4)).toEqual(["/compact remote"]);
  expect(c.getState().compacting).toBe(false);
});

test("removing the workspace on screen moves to another one, or back to the first-run state when none is left", async () => {
  const lists = [[{ cwd: "/work", sessions: [] }, { cwd: "/other", sessions: [] }], [{ cwd: "/other", sessions: [] }], []];
  let read = 0;
  const removed: string[] = [];
  const opened: string[] = [];
  const host = {
    ...fakeHost,
    sessions: async () => lists[Math.min(read++, lists.length - 1)]!,
    removeWorkspace: async (cwd: string) => void removed.push(cwd),
    openChild: async (cwd: string, sessionPath?: string) => (opened.push(cwd), { ...childA, id: `c-${cwd}`, cwd, sessionPath }),
  };
  const t = fakeTransport();
  const c = createClient(() => t.transport, host);
  clients.add(c);
  await tick();
  await tick();
  expect(c.getState().activeCwd).toBe("/work");

  await c.actions.removeWorkspace("/work");
  await tick();
  expect(removed).toEqual(["/work"]);
  expect(opened.at(-1)).toBe("/other");
  expect(c.getState().activeCwd).toBe("/other");

  await c.actions.removeWorkspace("/other");
  await tick();
  expect(c.getState()).toMatchObject({ activeCwd: "", workspaces: [], workspacesLoaded: true, connection: "closed" });
});
