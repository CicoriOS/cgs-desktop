import { expect, test } from "vitest";
import { byteTarget, keepOriginal, resizeSteps } from "../src/ui/attachment-policy";

const steps = (width: number, height: number) => [...resizeSteps(width, height)];
const canvases = (width: number, height: number) => steps(width, height).map((s) => [s.width, s.height]);

test("byte target is the 500 KiB cap, or the largest raw size whose base64 fits the budget", () => {
  expect(byteTarget(900_000)).toBe(512_000);
  expect(byteTarget(2_000_000)).toBe(512_000);
  expect(byteTarget(400)).toBe(300);
  expect(byteTarget(403)).toBe(300);
  expect(byteTarget(4)).toBe(3);
});

test("byte target's base64 fits the budget exactly: one more byte would overflow it", () => {
  for (const budget of [400, 403, 1_000, 60_000]) {
    const bytes = byteTarget(budget);
    expect(Buffer.alloc(bytes).toString("base64").length).toBeLessThanOrEqual(budget);
    expect(Buffer.alloc(bytes + 1).toString("base64").length).toBeGreaterThan(budget);
  }
});

test("keepOriginal accepts the four allowed formats at full size and byte target", () => {
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    expect(keepOriginal(800, 600, mime, 100, 100)).toBe(true);
  }
});

test("keepOriginal refuses other formats even when small", () => {
  for (const mime of ["image/bmp", "image/svg+xml", "image/heic", "image/avif", "application/octet-stream", "constructor"]) {
    expect(keepOriginal(800, 600, mime, 1, 100)).toBe(false);
  }
});

test("keepOriginal long-side boundary: 1568 keeps, 1569 re-encodes", () => {
  expect(keepOriginal(1568, 200, "image/png", 1, 100)).toBe(true);
  expect(keepOriginal(200, 1568, "image/png", 1, 100)).toBe(true);
  expect(keepOriginal(1569, 500, "image/png", 1, 100)).toBe(false);
  expect(keepOriginal(500, 1569, "image/png", 1, 100)).toBe(false);
});

test("keepOriginal short-side boundary: 200 keeps, 199 re-encodes", () => {
  expect(keepOriginal(200, 1000, "image/jpeg", 1, 100)).toBe(true);
  expect(keepOriginal(1000, 199, "image/jpeg", 1, 100)).toBe(false);
});

test("keepOriginal byte boundary: exactly the target keeps, one more byte re-encodes", () => {
  expect(keepOriginal(800, 600, "image/webp", 100, 100)).toBe(true);
  expect(keepOriginal(800, 600, "image/webp", 101, 100)).toBe(false);
});

test("in-bounds 800x600 targets itself and steps down by 0.75, 0.5, 0.35 and 0.25", () => {
  expect(canvases(800, 600)).toEqual([
    [800, 600],
    [600, 450],
    [400, 300],
    [280, 210],
    [200, 200],
  ]);
  const last = steps(800, 600).at(-1);
  expect([last?.drawWidth, last?.drawHeight]).toEqual([200, 150]);
});

test("oversized 4000x3000 caps the long side at 1568 and keeps the 4:3 ratio", () => {
  const [first] = steps(4000, 3000);
  expect([first?.width, first?.height, first?.drawWidth, first?.drawHeight]).toEqual([1568, 1176, 1568, 1176]);
  expect(canvases(4000, 3000)).toEqual([
    [1568, 1176],
    [1176, 882],
    [784, 588],
    [549, 412],
    [392, 294],
  ]);
});

test("long side just over the cap scales to exactly 1568 and the short side rounds", () => {
  const [first] = steps(1569, 1000);
  expect([first?.width, first?.height]).toEqual([1568, 999]);
});

test("wide strip 401x41 scales up to 1568x160 and pads to a 200-px-tall white canvas, centered", () => {
  const all = steps(401, 41);
  expect(canvases(401, 41)).toEqual([
    [1568, 200],
    [1176, 200],
    [784, 200],
    [549, 200],
    [392, 200],
  ]);
  const [first] = all;
  expect([first?.drawWidth, first?.drawHeight]).toEqual([1568, 160]);
  expect(Math.floor(((first?.height ?? 0) - (first?.drawHeight ?? 0)) / 2)).toBe(20);
});

test("tall strip 41x401 mirrors the wide one: 200-px-wide canvases, padded horizontally", () => {
  const [first] = steps(41, 401);
  expect([first?.width, first?.height, first?.drawWidth, first?.drawHeight]).toEqual([200, 1568, 160, 1568]);
  expect(steps(41, 401).every((s) => s.width === 200)).toBe(true);
});

test("tiny 50x50 scales up to 200x200 and yields that one size once, since smaller steps dedupe", () => {
  expect(canvases(50, 50)).toEqual([[200, 200]]);
  const [only] = steps(50, 50);
  expect([only?.drawWidth, only?.drawHeight]).toEqual([200, 200]);
});

test("a 200x200 picture is one step, already at the floor", () => {
  expect(canvases(200, 200)).toEqual([[200, 200]]);
});

test("extreme 10000x100 strip caps the long side and pads the short side up to 200", () => {
  const [first] = steps(10000, 100);
  expect([first?.width, first?.height, first?.drawWidth, first?.drawHeight]).toEqual([1568, 200, 1568, 16]);
});

test("every step lists q75 then 70, 60, 50, 40", () => {
  for (const s of steps(800, 600)) expect(s.qualities).toEqual([75, 70, 60, 50, 40]);
});

test("every step stays within 200–1568 px per canvas side and draws inside its canvas", () => {
  const sizes = [
    [1, 1],
    [50, 50],
    [401, 41],
    [41, 401],
    [4000, 3000],
    [3000, 150],
    [1568, 200],
    [1569, 1569],
    [10000, 100],
    [100, 10000],
  ];
  for (const [w, h] of sizes) {
    for (const s of steps(w ?? 0, h ?? 0)) {
      expect(s.width).toBeGreaterThanOrEqual(200);
      expect(s.width).toBeLessThanOrEqual(1568);
      expect(s.height).toBeGreaterThanOrEqual(200);
      expect(s.height).toBeLessThanOrEqual(1568);
      expect(s.drawWidth).toBeGreaterThanOrEqual(1);
      expect(s.drawWidth).toBeLessThanOrEqual(s.width);
      expect(s.drawHeight).toBeGreaterThanOrEqual(1);
      expect(s.drawHeight).toBeLessThanOrEqual(s.height);
    }
  }
});

test("no two steps share an output size", () => {
  for (const [w, h] of [
    [50, 50],
    [800, 600],
    [4000, 3000],
    [401, 41],
  ] as const) {
    const sizes = canvases(w, h).map(([cw, ch]) => `${cw}x${ch}`);
    expect(new Set(sizes).size).toBe(sizes.length);
  }
});
