import { expect, test } from "vitest";
import { turnsFromMessages } from "../src/core/history";
import { assistantMessage, call, diffLines, text, toolResultMessage } from "../src/demo/log";
import { unifiedPatch } from "../src/demo/patch";
import { demoWorkspace, editDemoFile } from "../src/demo/workspace";
import { taskChanges } from "../src/ui/right/changes";
import { parseUnified } from "../src/ui/right/patch";

test("a git patch is numbered by the new file for added and context lines, by the old file for removed ones", () => {
  const patch = unifiedPatch("a.ts", "one\ntwo\nthree\nfour\n", "one\n2\nthree\nfour\nfive\n");
  expect(parseUnified(patch)).toEqual([
    { kind: "ctx", no: 1, text: "one" },
    { kind: "del", no: 2, text: "two" },
    { kind: "add", no: 2, text: "2" },
    { kind: "ctx", no: 3, text: "three" },
    { kind: "ctx", no: 4, text: "four" },
    { kind: "add", no: 5, text: "five" },
  ]);
});

test("changes far apart in a file become separate hunks with a gap between them", () => {
  const from = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const to = from.replace("line 2\n", "LINE 2\n").replace("line 29\n", "LINE 29\n");
  const lines = parseUnified(unifiedPatch("b.ts", from, to));
  expect(lines.filter((l) => l.kind === "gap")).toHaveLength(1);
  expect(lines.filter((l) => l.kind === "add").map((l) => l.no)).toEqual([2, 29]);
  expect(lines.filter((l) => l.kind === "del").map((l) => l.no)).toEqual([2, 29]);
});

test("the demo workspace reports Git state from each file's HEAD copy", async () => {
  const cwd = "/home/demo/cgs-web";
  const status = await demoWorkspace.gitStatus(cwd);
  const kinds = Object.fromEntries(status.files.map((f) => [`${f.staged ? "staged" : "changes"}:${f.path.slice(cwd.length + 1)}`, f.status]));
  expect(kinds).toMatchObject({
    "changes:src/pages/LoginForm.tsx": "modified",
    "changes:src/lib/validators.ts": "untracked",
    "staged:src/lib/validators.test.ts": "added",
    "changes:src/lib/legacy-auth.ts": "deleted",
    // edited in the index and again after it: listed on both sides
    "staged:src/lib/api.ts": "modified",
    "changes:src/lib/api.ts": "modified",
  });
  expect(await demoWorkspace.gitDiff(cwd, `${cwd}/src/lib/legacy-auth.ts`, "changes")).toBeUndefined();
  const root = await demoWorkspace.list(cwd, cwd);
  expect(root.map((e) => e.name)).toEqual(["public", "src", "package.json", "README.md", "vite.config.ts"]);
});

test("a file edited on the demo's disk is reported to watchers and shows up in Git", async () => {
  const cwd = "/home/demo/cgs-web";
  const path = `${cwd}/src/ui/transcript/tools/highlight.ts`;
  const heard: string[] = [];
  const stop = demoWorkspace.watch(cwd, () => heard.push("change"));
  expect((await demoWorkspace.gitStatus(cwd)).files.some((f) => f.path === path)).toBe(false);
  editDemoFile(cwd, "src/ui/transcript/tools/highlight.ts", (text) => `${text}// edited\n`);
  stop();
  editDemoFile(cwd, "src/ui/transcript/tools/highlight.ts", (text) => `${text}// again\n`);
  expect(heard).toEqual(["change"]); // the second edit came after the watcher left
  expect((await demoWorkspace.gitStatus(cwd)).files.find((f) => f.path === path)).toMatchObject({ status: "modified", staged: false });
  expect(await demoWorkspace.gitDiff(cwd, path, "changes")).toContain("+// edited");
});

test("task changes fold the successful edits of a file together and skip failed ones", () => {
  const edit = (id: string, diff: string) => [assistantMessage([text("edit"), call(id, "edit", { path: "src/a.ts" })], "toolUse"), toolResultMessage(id, "edit", "ok", { path: "src/a.ts", diff })];
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...edit("e1", diffLines([[" ", 1, "keep"], ["-", 2, "old"], ["+", 2, "new"]])),
    ...edit("e2", diffLines([["+", 5, "more"]])),
    assistantMessage([call("e3", "edit", { path: "src/b.ts" })], "toolUse"),
    toolResultMessage("e3", "edit", "no match", undefined, true),
    assistantMessage([call("w1", "write", { path: "src/c.ts", content: "x\ny\n" })], "toolUse"),
    toolResultMessage("w1", "write", "wrote"),
  ];
  const { turns, tools } = turnsFromMessages(messages.map((message) => ({ message })));
  const changes = taskChanges(turns, tools);
  expect(changes.map((c) => [c.path, c.added, c.removed, c.edits])).toEqual([
    ["src/a.ts", 2, 1, 2],
    ["src/c.ts", 2, 0, 1],
  ]);
});
