import { expect, test } from "vitest";
import { turnsFromEntries, turnTailIds } from "../../src/core/history";
import type { SessionEntry } from "../../src/core/history";

const msg = (id: string, parentId: string | null, message: SessionEntry["message"]): SessionEntry => ({ id, parentId, type: "message", message });

test("history follows the active branch; fork targets are the ends of each turn", () => {
  const entries: SessionEntry[] = [
    msg("u1", null, { role: "user", content: "写个文件", timestamp: 1 }),
    msg("a1", "u1", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "/x", content: "hi" } }], timestamp: 2 }),
    msg("r1", "a1", { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 }),
    msg("a2", "r1", { role: "assistant", content: [{ type: "text", text: "写好了" }], timestamp: 4 }),
    msg("u2", "a2", { role: "user", content: "abandoned", timestamp: 5 }),
    msg("u3", "a2", { role: "user", content: "再来", timestamp: 6 }),
  ];
  const { turns, tools } = turnsFromEntries(entries, "u3");
  expect(turns.map((t) => t.user.text)).toEqual(["写个文件", "再来"]);
  expect(turnTailIds(entries, "u3")).toEqual(["a2", "u3"]);
  expect(turns[0]!.replyAt).toBe(4);
  expect(tools.c1).toMatchObject({ name: "write", status: "ok", args: { content: "hi" } });
});

test("an assistant error marks the turn failed", () => {
  const { turns } = turnsFromEntries([
    msg("u1", null, { role: "user", content: "x" }),
    msg("a1", "u1", { role: "assistant", content: [], stopReason: "error", errorMessage: "404" }),
  ]);
  expect(turns[0]).toMatchObject({ state: "failed", errorText: "404" });
});
