import { expect, test } from "vitest";
import { markdownBlocks } from "./markdown-blocks";

const html = (src: string) => markdownBlocks(src).map((b) => (b.kind === "html" ? b.html : `[mermaid:${b.src}]`)).join("");

test("raw html in model output is escaped, never passed through", () => {
  expect(html("<img src=x onerror=alert(1)> **bold**")).toBe("<p>&lt;img src=x onerror=alert(1)&gt; <strong>bold</strong></p>");
});

test("tables keep alignment and escape cells", () => {
  const out = html("| a | b |\n|:--|--:|\n| <1> | 2 |");
  expect(out).toContain('<th>a</th><th style="text-align:right">b</th>');
  expect(out).toContain("&lt;1&gt;");
});

test("nested and task lists", () => {
  const out = html("- a\n  - b\n- [x] done\n- [ ] todo");
  expect(out).toContain("<ul><li>a<ul><li>b</li></ul></li>");
  expect(out).toContain('<li class="task"><input type="checkbox" disabled checked> done</li>');
  expect(out).toContain('<input type="checkbox" disabled> todo');
});

test("a mermaid fence becomes its own block once closed; a streaming one stays code", () => {
  expect(markdownBlocks("前\n```mermaid\nflowchart LR\nA-->B\n```\n后").map((b) => b.kind)).toEqual(["html", "mermaid", "html"]);
  expect(markdownBlocks("```mermaid\nflowchart LR").map((b) => b.kind)).toEqual(["html"]);
});

test("links only allow http(s)", () => {
  expect(html("[x](javascript:alert(1)) [y](https://a.b/c)")).toBe('<p>[x](javascript:alert(1)) <a href="https://a.b/c" target="_blank" rel="noreferrer noopener">y</a></p>');
});
