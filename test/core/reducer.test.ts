import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { applyFrame, initialState, ringFor, type EventFrame } from "../../src/core/reducer";

const frames = readFileSync(new URL("../fixtures/tool-run.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as EventFrame);

test("a real tool run folds into one turn with every call finished and a reply", () => {
  let s = initialState();
  for (const f of frames) s = applyFrame(s, f, 1000);
  expect(s.turns).toHaveLength(1);
  const calls = Object.values(s.tools);
  expect(calls.map((c) => c.name).sort()).toEqual(["bash", "grep", "read"]);
  expect(calls.every((c) => c.status === "ok" && c.result)).toBe(true);
  const bash = calls.find((c) => c.name === "bash")!;
  expect(bash.args.command).toBe("cat /tmp/hello-demo.txt");
  const turn = s.turns[0]!;
  expect(turn.replyAt).toBe(1000);
  const last = turn.assistant.at(-1)!;
  expect(last.items.some((i) => i.kind === "text")).toBe(true);
});

test("a user message that matches the optimistic turn confirms it instead of adding another", () => {
  let s = initialState();
  s = { ...s, turns: [{ id: "p", user: { text: "你好" }, assistant: [], state: "running", startedAt: 1, pending: true }] };
  s = applyFrame(s, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "你好" }] } }, 2);
  expect(s.turns).toHaveLength(1);
  expect(s.turns[0]!.pending).toBe(false);
});

test("a steered user message starts a new turn and ends the running one", () => {
  let s = initialState();
  s = applyFrame(s, { type: "message_start", message: { role: "user", content: "first" } }, 1);
  s = applyFrame(s, { type: "message_start", message: { role: "user", content: "second" } }, 2);
  expect(s.turns.map((t) => [t.user.text, t.state])).toEqual([["first", "done"], ["second", "running"]]);
});

test("queue_update lists steering before follow-ups", () => {
  const s = applyFrame(initialState(), { type: "queue_update", steering: ["a"], followUp: ["b"] }, 1);
  expect(s.queue).toEqual([{ text: "a", mode: "steer" }, { text: "b", mode: "followUp" }]);
});

test("ringFor asks for thinking only while thinking streams", () => {
  expect(ringFor({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } })).toBe("think");
  expect(ringFor({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } })).toBe("work");
  expect(ringFor({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })).toBe("work");
  expect(ringFor({ type: "turn_end" })).toBeUndefined();
});

test("a result without its start is preserved when the assistant tool call arrives later", () => {
  const result = { type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] } };
  let s = applyFrame(initialState(), result, 1);
  const message = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "echo hi" } }] };
  s = applyFrame(s, { type: "message_update", messageId: "live", message }, 2);
  s = applyFrame(s, { type: "message_end", messageId: "live", message }, 3);
  expect(s.turns[0]?.assistant).toHaveLength(1);
  expect(s.tools.call).toMatchObject({ status: "ok", args: { command: "echo hi" }, result: result.result });
  expect(applyFrame(s, result, 4)).toBe(s);
});
