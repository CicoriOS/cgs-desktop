import { expect, test } from "vitest";
import type { ToolCall, Turn } from "../../core/types";
import { callNames, viewTurn } from "./process";

const call = (id: string, name: string): ToolCall => ({ id, name, args: {}, status: "ok" });

test("thinking and tool calls are process, the tool-free text is the reply", () => {
  const tools = { a: call("a", "read"), b: call("b", "read"), c: call("c", "bash") };
  const turn: Turn = {
    id: "t", user: { text: "x" }, state: "done", startedAt: 0,
    assistant: [
      { id: "m1", items: [{ kind: "thinking", text: "想" }, { kind: "text", text: "先看看" }, { kind: "tool", callId: "a" }, { kind: "tool", callId: "b" }] },
      { id: "m2", items: [{ kind: "tool", callId: "c" }] },
      { id: "m3", items: [{ kind: "text", text: "完成" }] },
    ],
  };
  const v = viewTurn(turn, tools);
  expect(v.steps.map((s) => s.kind)).toEqual(["thought", "note", "calls"]);
  expect((v.steps[2] as { calls: ToolCall[] }).calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
  expect(v.replies).toEqual([{ id: "m3", text: "完成", stopReason: undefined }]);
  expect(v.callCount).toBe(3);
  expect(callNames(tools.a ? [tools.a, tools.b, tools.c] : [])).toBe("read ×2、bash");
});
