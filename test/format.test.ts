import { expect, test } from "vitest";
import { plainTitle } from "../src/ui/format";

test("a title made in a terminal loses its Nerd Font glyph; an emoji icon, code and text stay", () => {
  expect(plainTitle("\u{F0121} PWA: 修复CGSConnect PWA移动端问题")).toBe("PWA: 修复CGSConnect PWA移动端问题");
  expect(plainTitle("\u{F1821} HELLO: Greet in cgscli workspace")).toBe("HELLO: Greet in cgscli workspace");
  expect(plainTitle("\uE0A0 BRANCH: main")).toBe("BRANCH: main");
  expect(plainTitle("🅿️ PARK: Fix flaky park tests")).toBe("🅿️ PARK: Fix flaky park tests");
});
