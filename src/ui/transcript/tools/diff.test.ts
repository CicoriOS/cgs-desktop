import { expect, test } from "vitest";
import { diffStats, parseDiff } from "./diff";

test("parses omp's numbered diff", () => {
  const lines = parseDiff(" 1|alpha\n-2|beta\n+2|BETA-改过了\n 3|gamma");
  expect(lines).toEqual([
    { kind: "ctx", no: 1, text: "alpha" },
    { kind: "del", no: 2, text: "beta" },
    { kind: "add", no: 2, text: "BETA-改过了" },
    { kind: "ctx", no: 3, text: "gamma" },
  ]);
  expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
});

test("a pipe inside the text is kept and plain unified lines are understood", () => {
  expect(parseDiff("+10|a | b")[0]).toEqual({ kind: "add", no: 10, text: "a | b" });
  expect(parseDiff("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y").map((l) => l.kind)).toEqual(["gap", "del", "add"]);
});
