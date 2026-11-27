import { afterEach, expect, test } from "vitest";
import { compactCommand, compactFailed, compactFallback, COMPACT_MODES, DEFAULT_COMPACT_MODE, parseCompactMode } from "../src/core/compact";
import { getCompactMode, setCompactMode } from "../src/ui/compact-mode";

afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

function fakeStorage() {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  return data;
}

test("quick compaction is the first mode and the default; unknown stored values fall back to it", () => {
  expect(COMPACT_MODES[0]).toBe(DEFAULT_COMPACT_MODE);
  expect(DEFAULT_COMPACT_MODE).toBe("snapcompact");
  expect(parseCompactMode("remote")).toBe("remote");
  expect(parseCompactMode("shake")).toBe(DEFAULT_COMPACT_MODE);
  expect(parseCompactMode(null)).toBe(DEFAULT_COMPACT_MODE);
  expect(compactCommand("handoff")).toBe("/compact handoff");
});

test("the mode picked last is the default next time, and a browser without storage still works", () => {
  expect(getCompactMode()).toBe("snapcompact"); // no storage at all
  setCompactMode("soft");
  fakeStorage();
  expect(getCompactMode()).toBe("snapcompact");
  setCompactMode("soft");
  expect(getCompactMode()).toBe("soft");
  setCompactMode("handoff");
  expect(getCompactMode()).toBe("handoff");
});

test("only quick compaction has a fallback, and a failure is recognized by omp's report", () => {
  expect(compactFallback("snapcompact")).toBe("soft");
  expect(COMPACT_MODES.filter((m) => m !== "snapcompact").map(compactFallback)).toEqual([undefined, undefined, undefined]);
  expect(compactFailed("Compaction failed: boom")).toBe(true);
  expect(compactFailed("Compaction complete. Tokens: 1 -> 1 (saved 0).")).toBe(false);
});
