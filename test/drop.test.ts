import { describe, expect, it } from "vitest";
import { mentionText } from "../src/ui/mentions";
import { planDrop } from "../src/ui/drop";

const file = (path: string, image = false) => ({ path, directory: false, image });
const dir = (path: string) => ({ path, directory: true, image: false });

describe("planDrop", () => {
  it("makes every dropped folder a workspace, wherever it lands", () => {
    expect(planDrop([dir("/a/x"), dir("/b/y")], false)).toEqual({ workspaces: ["/a/x", "/b/y"], refs: [] });
    expect(planDrop([dir("/a/x")], true)).toEqual({ workspaces: ["/a/x"], refs: [] });
  });

  it("references files dropped on the chat, leaving pictures to the image tray", () => {
    expect(planDrop([file("/w/a.ts"), file("/w/p.png", true)], false)).toEqual({ workspaces: [], refs: ["/w/a.ts"] });
  });

  it("opens the first file's folder as the workspace when files land on the sidebar, and references all of them, pictures too", () => {
    expect(planDrop([file("/w/src/a.ts"), file("/w/img/p.png", true)], true)).toEqual({ workspaces: ["/w/src"], refs: ["/w/src/a.ts", "/w/img/p.png"] });
  });

  it("keeps folders first so a mixed drop ends in the file's workspace", () => {
    expect(planDrop([file("/w/a.ts"), dir("/d")], true).workspaces).toEqual(["/d", "/w"]);
  });
});

describe("mentionText", () => {
  it("writes paths inside the workspace relative and quotes spaces", () => {
    expect(mentionText("/w", ["/w/src/a.ts", "/w/my notes.md", "/other/b.ts"])).toBe('@src/a.ts @"my notes.md" @/other/b.ts ');
  });
});
