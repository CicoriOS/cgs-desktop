import { afterEach, expect, test } from "vitest";
import { createClient } from "../../src/core/client";
import { applyFrame, initialState, subagentsFromTools, type EventFrame } from "../../src/core/reducer";
import { subagentsFromSnapshot, taskCallOf } from "../../src/core/subagents";
import { parsePhases, summarizeTodos } from "../../src/core/todos";
import type { ToolCall } from "../../src/core/types";
import { childA, fakeHost, fakeTransport, tick } from "./fake";

const PHASES = [
  { name: "Plan", tasks: [{ content: "read the code", status: "completed" }, { content: "write the fix", status: "in_progress" }, { content: "old idea", status: "abandoned" }] },
  { name: "Ship", tasks: [{ content: "run tests", status: "pending" }] },
];

const todoCall = (phases: unknown): EventFrame => ({ type: "tool_execution_end", toolCallId: "td1", toolName: "todo", result: { content: [], details: { phases } } });

test("a todo result replaces the list and an abandoned item leaves the count", () => {
  const s = applyFrame(initialState(), todoCall(PHASES), 1);
  expect(s.todos).toHaveLength(2);
  expect(summarizeTodos(s.todos)).toEqual({ done: 1, total: 3, current: "write the fix" });
  expect(applyFrame(s, { ...todoCall([]), toolCallId: "td2" }, 2).todos).toEqual([]);
});

test("a failed todo call leaves the list alone", () => {
  const s = applyFrame(initialState(), todoCall(PHASES), 1);
  const failed = applyFrame(s, { type: "tool_execution_end", toolCallId: "td3", toolName: "todo", isError: true, result: { content: [], details: { phases: [] } } }, 2);
  expect(failed.todos).toEqual(s.todos);
});

test("parsePhases drops entries without text, defaults an unknown status to pending and skips empty phases", () => {
  expect(parsePhases([{ name: "x", tasks: [{ content: "a", status: "weird" }, { status: "completed" }] }, { name: "empty", tasks: [] }, "junk"])).toEqual([{ name: "x", tasks: [{ content: "a", status: "pending" }] }]);
});

const started = (id: string, extra: Record<string, unknown> = {}): EventFrame => ({ type: "subagent_lifecycle", payload: { id, agent: "scout", description: "map the repo", status: "started", index: 0, ...extra } });
const progress = (id: string, level: string, status = "running"): EventFrame => ({
  type: "subagent_progress",
  payload: { index: 0, agent: "scout", task: "t", assignment: "Find every caller", progress: { id, status, resolvedThinkingLevel: level, resolvedModel: "p/m:high" } },
});

test("lifecycle and progress frames build one subagent that carries its own thinking level and task", () => {
  let s = applyFrame(initialState(), started("Sage"), 1);
  s = applyFrame(s, progress("Sage", "xhigh"), 2);
  expect(s.subagents).toEqual([{ id: "Sage", index: 0, agent: "scout", status: "running", description: "map the repo", task: "Find every caller", level: "xhigh", model: "p/m:high" }]);
});

test("a finished subagent does not go back to running on a late progress frame, but a new start does", () => {
  let s = applyFrame(initialState(), started("Sage"), 1);
  s = applyFrame(s, { type: "subagent_lifecycle", payload: { id: "Sage", agent: "scout", status: "completed", index: 0 } }, 2);
  s = applyFrame(s, progress("Sage", "high"), 3);
  expect(s.subagents[0]!.status).toBe("completed");
  expect(s.subagents[0]!.level).toBe("high");
  s = applyFrame(s, started("Sage"), 4);
  expect(s.subagents[0]!.status).toBe("running");
});

const taskResult = (details: unknown): ToolCall => ({ id: "task1", name: "task", args: { tasks: [{ name: "Sage", task: "Find every caller" }] }, status: "ok", result: { content: [], isError: false, details } });

test("a task result lists the subagents it ran, with their level and outcome, so a reloaded history shows them", () => {
  const call = taskResult({ results: [{ index: 0, id: "Sage", agent: "scout", description: "map the repo", exitCode: 0, output: "found 3", resolvedThinkingLevel: "low" }, { index: 1, id: "Ash", agent: "scout", exitCode: 1, error: "boom" }] });
  const list = subagentsFromTools({ task1: call });
  expect(list.map((x) => [x.id, x.status, x.level, x.parentToolCallId])).toEqual([["Sage", "completed", "low", "task1"], ["Ash", "failed", undefined, "task1"]]);
  expect(taskCallOf(call, "Sage")).toEqual({ task: "Find every caller", output: "found 3" });
  expect(taskCallOf(call, "Ash").output).toBe("boom");
});

test("the registry snapshot becomes subagents; entries without an id or agent are ignored", () => {
  expect(subagentsFromSnapshot({ subagents: [{ id: "Sage", index: 2, agent: "scout", status: "running", progress: { resolvedThinkingLevel: "medium" } }, { agent: "x" }, null] })).toEqual([{ id: "Sage", index: 2, agent: "scout", status: "running", level: "medium" }]);
});

const clients = new Set<{ close(): void }>();
afterEach(() => { for (const c of clients) c.close(); clients.clear(); });

test("connecting reads the todo list from get_state, subscribes to subagent progress and reads the roster", async () => {
  const t = fakeTransport();
  const c = createClient(() => t.transport, fakeHost, { holdMs: 0 });
  clients.add(c);
  await tick();
  t.open();
  await tick();
  t.respond("set_title_language");
  t.respond("get_state", { model: { provider: "p", id: "m" }, thinkingLevel: "high", sessionFile: childA.sessionPath, isStreaming: false, todoPhases: PHASES });
  await tick();
  t.respond("get_entries", { entries: [], leafId: null });
  await tick();
  expect(t.sent.find((f) => f.type === "set_subagent_subscription")).toMatchObject({ level: "progress" });
  t.respond("set_subagent_subscription", {});
  await tick();
  t.respond("get_subagents", { subagents: [{ id: "Sage", index: 0, agent: "scout", status: "running", progress: { resolvedThinkingLevel: "high" } }] });
  await tick();
  const s = c.getState();
  expect(summarizeTodos(s.todos).done).toBe(1);
  expect(s.subagents.map((x) => [x.id, x.level])).toEqual([["Sage", "high"]]);
});

test("reading a subagent transcript passes the byte offset and reports where to continue", async () => {
  const t = fakeTransport();
  const c = createClient(() => t.transport, fakeHost, { holdMs: 0 });
  clients.add(c);
  await tick();
  const pending = c.actions.subagentTranscript("Sage", 120);
  expect(t.sent.at(-1)).toMatchObject({ type: "get_subagent_messages", subagentId: "Sage", fromByte: 120 });
  t.respond("get_subagent_messages", { messages: [{ role: "user", content: "go" }], nextByte: 200, reset: false });
  expect(await pending).toEqual({ messages: [{ role: "user", content: "go" }], nextByte: 200, reset: false });
});
