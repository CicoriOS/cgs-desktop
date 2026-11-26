import { expect, test } from "vitest";
import { turnsFromEntries } from "../../src/core/history";
import { applyFrame, initialState, type EventFrame } from "../../src/core/reducer";
import { reconcileRoster } from "../../src/core/subagents";
import type { NoticeItem, SubagentInfo, Turn } from "../../src/core/types";

const noticesOf = (turn: Turn | undefined): NoticeItem[] => (turn?.assistant ?? []).flatMap((a) => a.items.filter((i): i is NoticeItem => i.kind === "notice"));

const reminder = "<system-reminder>\nYou stopped with 2 incomplete todo item(s).\n(Reminder 1/3)\n</system-reminder>";
const developer = (messageId: string, type = "message_end"): EventFrame => ({ type, messageId, message: { role: "developer", content: [{ type: "text", text: reminder }] } });

test("a developer reminder becomes a notice without its harness tags, once however many frames carry it", () => {
  let s = applyFrame(initialState(), { type: "message_start", message: { role: "user", content: "go" } }, 1);
  s = applyFrame(s, developer("m1", "message_start"), 2);
  s = applyFrame(s, developer("m1"), 3);
  expect(s.turns).toHaveLength(1);
  expect(noticesOf(s.turns[0])).toEqual([{ kind: "notice", id: "m1", tone: "reminder", text: "You stopped with 2 incomplete todo item(s).\n(Reminder 1/3)" }]);
  expect(s.turns[0]!.user.text).toBe("go");
});

test("a rule injected after a rewind is a notice that names its rules", () => {
  const text = '<system-interrupt reason="rule_violation" rule="no-any" path="x.md">\nDo not use any.\n</system-interrupt>';
  const s = applyFrame(initialState(), { type: "message_end", messageId: "r1", message: { role: "custom", customType: "ttsr-injection", content: text, details: { rules: ["no-any", "no-var"] } } }, 1);
  expect(noticesOf(s.turns[0])).toEqual([{ kind: "notice", id: "r1", tone: "rule", names: "no-any, no-var", text: "Do not use any." }]);
});

test("other custom messages stay out of the transcript", () => {
  const s = applyFrame(initialState(), { type: "message_end", messageId: "c1", message: { role: "custom", customType: "something-else", content: "x" } }, 1);
  expect(s.turns).toEqual([]);
});

test("saved history shows the same notices: developer messages and custom_message entries", () => {
  const { turns } = turnsFromEntries([
    { id: "1", parentId: null, type: "message", message: { role: "user", content: "go" } },
    { id: "2", parentId: "1", type: "message", message: { role: "developer", content: [{ type: "text", text: reminder }] } },
    { id: "3", parentId: "2", type: "custom_message", customType: "ttsr-injection", content: "<system-interrupt reason=\"rule_violation\" rule=\"r\">\nbody\n</system-interrupt>", details: { rules: ["r"] } },
    { id: "4", parentId: "3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
  ]);
  expect(turns).toHaveLength(1);
  expect(noticesOf(turns[0]).map((n) => [n.tone, n.names])).toEqual([["reminder", undefined], ["rule", "r"]]);
  expect(turns[0]!.assistant.at(-1)!.items).toEqual([{ kind: "text", text: "done" }]);
});

const sub = (id: string, status: SubagentInfo["status"]): SubagentInfo => ({ id, index: 0, agent: "scout", status });

test("history that lists a subagent as running but omp's roster does not know it marks it aborted; finished and live ones are kept", () => {
  const list = [sub("a", "running"), sub("b", "completed"), sub("c", "pending")];
  expect(reconcileRoster(list, [sub("c", "running")]).map((s) => [s.id, s.status])).toEqual([["a", "aborted"], ["b", "completed"], ["c", "pending"]]);
});
