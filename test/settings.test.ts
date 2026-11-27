import { describe, expect, it } from "vitest";
import type { UsageEntry } from "../src/core/settings";
import type { MessageKey } from "../src/i18n";
import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";
import { searchSettings } from "../src/ui/settings/schema";
import { groupUsage, sumUsage, usageWindow } from "../src/ui/settings/usage";

const chinese = (k: MessageKey) => zh[k];
const english = (k: MessageKey) => en[k];

describe("settings search", () => {
  it("matches names, help, sections and pages, and needs every word", () => {
    expect(searchSettings("   ", chinese)).toEqual([]);
    expect(searchSettings("界面 词语补全", chinese).map((h) => h.row?.id)).toEqual(["set.row.wordCompletion"]);
    expect(searchSettings("压缩 自动", chinese).map((h) => h.row?.id)).toContain("set.row.autoCompact");
    expect(searchSettings("压缩 不存在的词", chinese)).toEqual([]);
    expect(searchSettings("智能 压缩方式", chinese).map((h) => h.row?.id)).toEqual(["set.row.compactMethod"]);
  });

  it("searches in the language on screen", () => {
    expect(searchSettings("WORD COMPLETION", english).map((h) => h.row?.id)).toEqual(["set.row.wordCompletion"]);
    expect(searchSettings("词语补全", english)).toEqual([]);
  });

  it("directs panel-specific queries to the new pages and no longer offers the old pages", () => {
    expect(searchSettings("统计范围", chinese).map((h) => [h.page.group, h.page.id])).toEqual([["app", "usage"]]);
    expect(searchSettings("网络搜索方式", chinese).map((h) => h.page.id)).toEqual(["agents"]);
    expect(searchSettings("退出登录", chinese).map((h) => h.page.id)).toEqual(["hosts"]);
    expect(searchSettings("完成提示音", chinese)).toEqual([]);
    expect(searchSettings("账单", chinese)).toEqual([]);
  });
});

describe("usage report", () => {
  it("applies the requested date range to both totals and groupings across a month boundary", () => {
    const entry = (at: string, model: string, cost: number): UsageEntry => ({
      at: Date.parse(at), model, project: "desktop", input: 12, cacheRead: 5, output: 3, cost, cacheSavings: 0,
    });
    const entries = [
      entry("2026-10-26T23:59:59Z", "old", 100),
      entry("2026-10-27T00:00:00Z", "sonnet", 4),
      entry("2026-10-30T12:00:00Z", "opus", 8),
      entry("2026-11-02T12:00:00Z", "opus", 6),
      entry("2026-11-02T12:00:01Z", "future", 100),
    ];
    const week = usageWindow(entries, 7, Date.parse("2026-11-02T12:00:00Z"));
    expect(sumUsage(week)).toMatchObject({ tokens: 60, cost: 18 });
    expect(groupUsage(week, "model").map(({ key, cost }) => [key, cost])).toEqual([["opus", 14], ["sonnet", 4]]);
    expect(groupUsage(week, "month").map(({ key, cost }) => [key, cost])).toEqual([["2026-10", 12], ["2026-11", 6]]);
  });
});
