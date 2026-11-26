import { expect, test } from "vitest";
import type { DiffLine } from "./diff";
import { highlightDiff, highlightLines, langOf, splitHighlighted } from "./highlight";

const plain = (html: string) => html.replace(/<[^>]+>/g, "");

test("a token that spans lines is closed and reopened on every line", () => {
  expect(splitHighlighted('<span class="a">x\ny</span>z')).toEqual(['<span class="a">x</span>', '<span class="a">y</span>z']);
  const lines = highlightLines("/* one\ntwo */\nconst a = 1;", "typescript")!;
  expect(lines.map(plain)).toEqual(["/* one", "two */", "const a = 1;"]);
  expect(lines[1]).toContain("hljs-comment");
});

test("file text is escaped, never injected", () => {
  const html = highlightLines('const s = "<img src=x onerror=alert(1)>";', "typescript")![0]!;
  expect(html).not.toContain("<img");
  expect(plain(html)).toContain("&lt;img");
});

test("language comes from the path; read selectors and unknown types are handled", () => {
  expect(langOf("/a/b/main.ts:10-20")).toBe("typescript");
  expect(langOf("Dockerfile")).toBe("dockerfile");
  expect(langOf("/a/data.bin")).toBeUndefined();
  expect(highlightLines("x", undefined)).toBeUndefined();
});

test("each diff line is highlighted in the version it belongs to", () => {
  const lines: DiffLine[] = [
    { kind: "ctx", no: 1, text: "/* start" },
    { kind: "del", no: 2, text: "old = 1" },
    { kind: "add", no: 2, text: "new = 2" },
    { kind: "ctx", no: 3, text: "end */" },
    { kind: "gap", text: "..." },
    { kind: "add", no: 9, text: "const x = 1;" },
  ];
  const html = highlightDiff(lines, "typescript");
  expect(html.map((h) => h && plain(h))).toEqual(["/* start", "old = 1", "new = 2", "end */", undefined, "const x = 1;"]);
  // inside the multi-line comment on both sides
  expect(html[1]).toContain("hljs-comment");
  expect(html[2]).toContain("hljs-comment");
  expect(highlightDiff(lines, undefined).every((h) => h === undefined)).toBe(true);
});
