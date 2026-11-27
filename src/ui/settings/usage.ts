import type { UsageEntry } from "../../core/settings";

export type Dimension = "day" | "month" | "model" | "project";

const DAY_MS = 86_400_000;

export function usageWindow(entries: UsageEntry[], days: number, now: number): UsageEntry[] {
  const start = (Math.floor(now / DAY_MS) - days + 1) * DAY_MS;
  return entries.filter(({ at }) => at >= start && at <= now);
}

interface UsageTotals {
  cost: number;
  tokens: number;
  input: number;
  cacheRead: number;
  output: number;
  cacheSavings: number;
}

const emptyUsage = (): UsageTotals => ({ cost: 0, tokens: 0, input: 0, cacheRead: 0, output: 0, cacheSavings: 0 });

function addUsage(total: UsageTotals, e: UsageEntry): void {
  total.cost += e.cost;
  total.input += e.input;
  total.cacheRead += e.cacheRead;
  total.output += e.output;
  total.cacheSavings += e.cacheSavings;
  total.tokens += e.input + e.cacheRead + e.output;
}

export function sumUsage(entries: UsageEntry[]): UsageTotals {
  const total = emptyUsage();
  for (const e of entries) addUsage(total, e);
  return total;
}

export function groupUsage(entries: UsageEntry[], by: Dimension): (UsageTotals & { key: string })[] {
  const groups = new Map<string, UsageTotals & { key: string }>();
  for (const entry of entries) {
    const key = by === "model" || by === "project" ? entry[by] : new Date(entry.at).toISOString().slice(0, by === "month" ? 7 : 10);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, ...emptyUsage() });
    addUsage(group, entry);
  }
  return [...groups.values()].sort((a, b) => by === "day" || by === "month" ? a.key.localeCompare(b.key) : b.cost - a.cost);
}
