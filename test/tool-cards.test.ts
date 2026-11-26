import { expect, test } from "vitest";
import type { ToolCall } from "../src/core/types";
import { TOOL_CARD_KINDS, toolCardKind } from "../src/ui/transcript/tools/cardKinds";
import { evalCells, evalImages, todoPhases } from "../src/ui/transcript/tools/details";

// Snapshot of BUILTIN_TOOL_NAMES + HIDDEN_TOOL_NAMES in omp tools/builtin-names.ts.
const registered = `read bash edit ast_grep ast_edit ask debug eval github glob grep find lsp checkpoint rewind context_notes new_context security_scan task wait todo web_search write memory_edit retain recall reflect learn manage_skill yield goal think`.split(" ");

test("every registered omp tool has an explicit card policy", () => {
  for (const name of registered) {
    expect(Object.hasOwn(TOOL_CARD_KINDS, name)).toBe(true);
    expect(toolCardKind(name)).toBe(name === "think" ? "generic" : TOOL_CARD_KINDS[name]!);
    if (name !== "think") expect(toolCardKind(name)).not.toBe("generic");
  }
  expect(toolCardKind("apply_patch")).toBe("edit");
  expect(toolCardKind("search")).toBe("text");
  expect(toolCardKind("mcp__example_read")).toBe("mcp");
  expect(toolCardKind("gh_pr_view")).toBe("operation");
  expect(toolCardKind("unknown_plugin")).toBe("generic");
  expect(toolCardKind("constructor")).toBe("generic");
});

const pending: ToolCall = { id: "test", name: "eval", args: { code: "print(sum(range(10)))", language: "py" }, status: "running" };

test("eval prefers recorded cells but previews pending and legacy arguments", () => {
  expect(evalCells(pending)[0]).toMatchObject({ code: "print(sum(range(10)))", language: "python" });
  const call: ToolCall = { ...pending, status: "ok", result: { content: [], isError: false, details: { cells: [null,
    { code: pending.args.code, language: "python", status: "complete", output: "45", durationMs: 12 },
    { code: "console.log(1)", language: "js", title: "Next", status: "error", output: "test error" },
  ] } } };
  expect(evalCells(call)).toEqual([
    { code: pending.args.code, language: "python", status: "complete", output: "45", duration: 12, title: undefined },
    { code: "console.log(1)", language: "javascript", status: "error", output: "test error", duration: undefined, title: "Next" },
  ]);
});

test("eval accepts only inline raster image blocks", () => {
  expect(evalImages({ ...pending, result: { isError: false, content: [
    { type: "image", mimeType: "image/png", data: "YQ==" },
    { type: "image", mimeType: "image/svg+xml", data: "YQ==" },
    { type: "image", mimeType: "image/png", data: "https://example.com" },
  ] } })).toEqual(["data:image/png;base64,YQ=="]);
});

test("todo retains phase and checklist states, tolerating partial results", () => {
  const statuses = ["pending", "in_progress", "completed", "abandoned"];
  expect(todoPhases(null)).toEqual([]);
  expect(todoPhases({ phases: [{ name: "Test", tasks: [...statuses.map(status => ({ content: status, status })), { content: "legacy", status: "unknown" }, null] }] })).toEqual([
    { name: "Test", tasks: [...statuses.map(status => ({ content: status, status })), { content: "legacy", status: "pending" }] },
  ]);
});
