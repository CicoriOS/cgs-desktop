import { expect, test } from "vitest";
import { buildStats, cacheHitRate, fill, type UsageMessage } from "../src/core/stats";

const reply = (model: string, input: number, cacheRead: number, cost: number, provider = "cgs-openai"): UsageMessage => ({
  role: "assistant",
  provider,
  model,
  usage: { input, output: 10, cacheRead, cacheWrite: 0, cost: { total: cost } },
});

test("usage is summed per provider/model across the main agent and subagents, dearest first", () => {
  const main = [{ role: "user" }, reply("a", 100, 900, 0.5), reply("a", 50, 950, 0.25), reply("b", 10, 0, 2, "cgs-claude")];
  const sub = [reply("a", 20, 0, 0.1)];
  const v = buildStats({ tokens: { input: 180, output: 40, cacheRead: 1850 }, cost: 2.85 }, [main, sub], []);
  expect(v.rows.map((r) => [r.model, r.requests, r.input, r.cost])).toEqual([
    ["cgs-claude/b", 1, 10, 2],
    ["cgs-openai/a", 3, 170, 0.85],
  ]);
  expect(v.other).toBeUndefined();
});

test("what the messages do not account for (finished subagents, titles) shows as its own remainder", () => {
  const v = buildStats({ tokens: { input: 500, output: 60, cacheRead: 100 }, cost: 3 }, [[reply("a", 100, 100, 1)]], []);
  expect(v.other).toEqual({ input: 400, output: 50, cacheRead: 0, cacheWrite: 0, cost: 2 });
});

test("finished subagents come from the task result, one row per model with the thinking suffix dropped", () => {
  const task = {
    role: "toolResult",
    toolName: "task",
    details: {
      results: [
        { resolvedModel: "cgs-openai/deepseek-v4.1-flash:max", requests: 4, usage: { input: 100, output: 20, cacheRead: 400, cacheWrite: 0, cost: { total: 0.3 } } },
        { resolvedModel: "cgs-openai/deepseek-v4.1-flash", requests: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
      ],
    },
  };
  const v = buildStats({ tokens: { input: 110, output: 25, cacheRead: 400 }, cost: 0.4 }, [[task]], []);
  expect(v.rows).toEqual([{ model: "cgs-openai/deepseek-v4.1-flash", requests: 5, input: 110, output: 25, cacheRead: 400, cacheWrite: 0, cost: 0.4 }]);
  expect(v.other).toBeUndefined();
});

test("cache hit rate is cached prompt tokens over all prompt tokens, undefined with no prompt", () => {
  expect(cacheHitRate({ input: 100, cacheRead: 900, cacheWrite: 0 })).toBe(0.9);
  expect(cacheHitRate({ input: 100, cacheRead: 700, cacheWrite: 200 })).toBe(0.7);
  expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
});

test("subagent gauges keep what omp reports and fill clamps to the window", () => {
  const v = buildStats(
    { contextUsage: { tokens: 50_000, contextWindow: 200_000 } },
    [],
    [
      { id: "s1", agent: "task", status: "running", progress: { contextTokens: 30_000, contextWindow: 100_000 } },
      { id: "s2", agent: "sonic", status: "pending" },
    ],
  );
  expect(fill(v.main)).toBe(0.25);
  expect(v.subagents.map((s) => fill(s))).toEqual([0.3, undefined]);
  expect(fill({ used: 300, window: 200 })).toBe(1);
});
