import { expect, test } from "vitest";
import { en } from "../src/i18n/en";
import { setLocale, t } from "../src/i18n";
import { zh } from "../src/i18n/zh";

test("both languages define the same keys and the same placeholders", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(zh) as (keyof typeof zh)[]) expect(holes(en[k]), k).toEqual(holes(zh[k]));
});

test("t fills placeholders and follows the locale", () => {
  setLocale("en");
  expect(t("turn.calls", { n: 3 })).toBe("3 tool calls");
  setLocale("zh");
  expect(t("turn.calls", { n: 3 })).toBe("进行了 3 次调用");
});
