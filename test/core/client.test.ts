import { expect, test } from "vitest";
import { createClient } from "../../src/core/client";
import { fakeHost, fakeTransport, tick } from "./fake";

async function connected(holdMs = 0) {
  const t = fakeTransport();
  const c = createClient(t.transport, fakeHost, { holdMs });
  t.open();
  await tick();
  t.respond("get_state", { model: { provider: "p", id: "m", name: "M" }, thinkingLevel: "high", configuredThinkingLevel: "auto", sessionFile: "/s.jsonl", isStreaming: false });
  await tick();
  t.respond("get_entries", { entries: [], leafId: null });
  await tick();
  return { t, c };
}

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
