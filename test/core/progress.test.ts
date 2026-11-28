import { expect, test } from "vitest";
import { applyFrame, type EventFrame, initialState, TOOL_STREAM_LIMIT } from "../../src/core/reducer";

const request = (extra: Partial<EventFrame>): EventFrame => ({ type: "extension_ui_request", ...extra });

test("a running tool keeps the newest preview, bounded to its tail, and the result replaces it", () => {
  let s = applyFrame(initialState(), { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "make" } }, 1000);
  expect(s.tools.t1).toMatchObject({ status: "running", startedAt: 1000, args: { command: "make" } });

  s = applyFrame(s, { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "step 1" }] } }, 1100);
  s = applyFrame(s, { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "step 2" }] } }, 1200);
  expect(s.tools.t1?.stream).toEqual({ text: "step 2", at: 1200 });

  s = applyFrame(s, { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "x".repeat(TOOL_STREAM_LIMIT + 10) }] } }, 1300);
  expect(s.tools.t1!.stream!.text).toHaveLength(TOOL_STREAM_LIMIT);
  expect(s.tools.t1!.stream!.truncated).toBe(true);

  s = applyFrame(s, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "done" }], details: { wallTimeMs: 900 } } }, 1400);
  expect(s.tools.t1?.stream).toBeUndefined();
  expect(s.tools.t1).toMatchObject({ status: "ok", result: { content: [{ type: "text", text: "done" }], isError: false } });

  // A preview that lost the race with the result must not paint over it.
  expect(applyFrame(s, { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "late" }] } }, 1500)).toBe(s);
});

test("an edit's streamed preview becomes text for its running card", () => {
  const s = applyFrame(initialState(), { type: "tool_stream_update", toolCallId: "e1", toolName: "edit", update: { streaming: true, files: [{ path: "src/a.ts", diff: "+1|new" }, { path: "src/b.ts", error: "stale" }] } }, 5);
  expect(s.tools.e1?.stream?.text).toBe("src/a.ts\n+1|new\n\nsrc/b.ts\nstale");
  expect(s.tools.e1?.name).toBe("edit");
});

test("compaction, retry, fallback and warming follow their start and end frames", () => {
  let s = initialState();
  s = applyFrame(s, { type: "auto_compaction_start", reason: "threshold", action: "remote" }, 10);
  expect(s.progress.compaction).toMatchObject({ kind: "auto", reason: "threshold", action: "remote", startedAt: 10 });
  s = applyFrame(s, { type: "auto_compaction_end", action: "remote", aborted: false, willRetry: false }, 20);
  expect(s.progress.compaction).toBeUndefined();

  s = applyFrame(s, { type: "manual_compaction_start", mode: "snapcompact" }, 30);
  expect(s.progress.compaction).toMatchObject({ kind: "manual", mode: "snapcompact" });
  s = applyFrame(s, { type: "manual_compaction_end", aborted: false }, 40);
  expect(s.progress.compaction).toBeUndefined();

  s = applyFrame(s, { type: "auto_retry_start", attempt: 2, maxAttempts: 4, delayMs: 5000, errorMessage: "overloaded" }, 50);
  expect(s.progress.retry).toEqual({ attempt: 2, maxAttempts: 4, delayMs: 5000, reason: "overloaded", startedAt: 50 });
  s = applyFrame(s, { type: "retry_fallback_applied", from: "a/x", to: "b/y", role: "default", reason: "overloaded" }, 60);
  expect(s.progress.fallback).toMatchObject({ from: "a/x", to: "b/y", role: "default" });
  s = applyFrame(s, { type: "retry_fallback_succeeded", model: "b/y", role: "default" }, 70);
  expect(s.progress.fallback).toMatchObject({ to: "b/y", ok: true });
  s = applyFrame(s, { type: "auto_retry_end", success: true, attempt: 2 }, 80);
  expect(s.progress.retry).toBeUndefined();

  s = applyFrame(s, { type: "cache_warming_start", phase: "idle", method: "prewarm", model: "m" }, 90);
  expect(s.progress.warming).toMatchObject({ phase: "idle", method: "prewarm", model: "m" });
  s = applyFrame(s, { type: "cache_warming_end", outcome: "hit" }, 100);
  expect(s.progress.warming).toBeUndefined();
});

test("agent_end clears the run's strip and keeps the session's extension state", () => {
  let s = applyFrame(initialState(), { type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: "x" }, 1);
  s = applyFrame(s, request({ method: "setStatus", statusKey: "build", statusText: "ok" }), 2);
  s = applyFrame(s, { type: "goal_updated", goal: { objective: "ship it", status: "active" } }, 3);
  s = applyFrame(s, { type: "config_warnings_changed" }, 4);
  s = applyFrame(s, { type: "agent_end" }, 5);
  expect(s.progress.retry).toBeUndefined();
  expect(s.progress.statuses).toEqual({ build: "ok" });
  expect(s.progress.goal).toEqual({ objective: "ship it", status: "active" });
  expect(s.progress.warnings).toBe(1);
});

test("extension statuses and widgets add, replace and remove by key, stripped of ANSI and capped", () => {
  let s = applyFrame(initialState(), request({ method: "setStatus", statusKey: "build", statusText: "\u001b[32m✓ built\u001b[0m" }), 1);
  expect(s.progress.statuses).toEqual({ build: "✓ built" });
  s = applyFrame(s, request({ method: "setStatus", statusKey: "build", statusText: undefined }), 2);
  expect(s.progress.statuses).toEqual({});

  s = applyFrame(s, request({ method: "setWidget", widgetKey: "ci", widgetLines: ["\u001b[1mline 1\u001b[0m"], widgetPlacement: "aboveEditor" }), 3);
  expect(s.progress.widgets).toEqual([{ key: "ci", lines: ["line 1"], placement: "aboveEditor" }]);
  s = applyFrame(s, request({ method: "setWidget", widgetKey: "ci", widgetLines: ["line 2"] }), 4);
  expect(s.progress.widgets).toEqual([{ key: "ci", lines: ["line 2"], placement: "belowEditor" }]);
  s = applyFrame(s, request({ method: "setWidget", widgetKey: "ci", widgetLines: undefined }), 5);
  expect(s.progress.widgets).toEqual([]);

  s = applyFrame(s, request({ method: "setWidget", widgetKey: "big", widgetLines: Array.from({ length: 30 }, (_, i) => `l${i}`) }), 6);
  expect(s.progress.widgets[0]!.lines).toHaveLength(12);
  expect(s.progress.widgets[0]!.lines[0]).toBe("l18");
});

test("a null goal clears the line", () => {
  let s = applyFrame(initialState(), { type: "goal_updated", goal: { objective: "ship" } }, 1);
  expect(s.progress.goal?.objective).toBe("ship");
  s = applyFrame(s, { type: "goal_updated", goal: null }, 2);
  expect(s.progress.goal).toBeUndefined();
});
