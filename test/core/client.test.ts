import { expect, test } from "vitest";
import { createClient } from "../../src/core/client";
import { getLocale, setLocale } from "../../src/i18n";
import { fakeHost, fakeTransport, tick } from "./fake";

async function connected(holdMs = 0) {
  const t = fakeTransport();
  const c = createClient(t.transport, fakeHost, { holdMs });
  t.open();
  await tick();
  t.respond("set_title_language");
  t.respond("get_state", { model: { provider: "p", id: "m", name: "M" }, thinkingLevel: "high", configuredThinkingLevel: "auto", sessionFile: "/s.jsonl", isStreaming: false });
  await tick();
  t.respond("get_entries", { entries: [], leafId: null });
  await tick();
  return { t, c };
}

test("title language follows the UI on ready, locale change, and agent restart without surfacing unsupported-command errors", async () => {
  const original = getLocale();
  const t = fakeTransport();
  const c = createClient(t.transport, fakeHost);
  const languages = () => t.sent.filter((f) => f.type === "set_title_language").map((f) => f.language);
  try {
    setLocale("zh");
    expect(languages()).toEqual([]);
    t.open();
    t.push({ type: "ready" }); // omp's ready frame (possibly replayed) doesn't send the command twice
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
    t.push({ type: "bridge_restart", cwd: "/other" });
    expect(languages()).toHaveLength(2);
    t.push({ type: "ready" });
    expect(languages()).toEqual(["Chinese (Simplified)", "English", "English"]);
    t.respond("set_title_language");
  } finally {
    c.close();
    setLocale(original);
  }
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

test("a page that connects while the ask tool waits gets the form back from the backlog", async () => {
  const t = fakeTransport();
  const c = createClient(t.transport, fakeHost, { holdMs: 0 });
  t.open();
  t.respond("set_title_language");
  await tick();
  // backlog replayed before get_state answers: one form still waiting, one cancelled, one finished by the tool
  t.push({ type: "extension_ui_request", id: "old", method: "form", html: "<form>a</form>" });
  t.push({ type: "extension_ui_request", id: "x", method: "cancel", targetId: "old" });
  t.push({ type: "extension_ui_request", id: "live", method: "form", html: "<form>b</form>" });
  t.respond("get_state", { isStreaming: true, sessionFile: "/s.jsonl" });
  await tick();
  expect(c.getState().dialogs.map((d) => d.id)).toEqual(["live"]);
  t.respond("get_entries", { entries: [], leafId: null });
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
