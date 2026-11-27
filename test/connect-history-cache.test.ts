import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";
import { deviceHistory, KEPT_SESSIONS } from "../src/connect/history-cache";
import type { CachedSession } from "../src/core/history";

const session = (title: string): CachedSession => ({ turns: [{ id: "t1", user: { text: title }, assistant: [], state: "done", startedAt: 1 }], tools: {}, title });

test("a saved conversation comes back whole and belongs to its device and session file", async () => {
  const idb = new IDBFactory();
  const a = deviceHistory(idb, "7");
  await a.save("/s.jsonl", session("one"));
  expect(await a.load("/s.jsonl")).toEqual(session("one"));
  expect(await a.load("/other.jsonl")).toBeUndefined();
  expect(await deviceHistory(idb, "8").load("/s.jsonl")).toBeUndefined();
});

test("only the most recently saved sessions are kept", async () => {
  const idb = new IDBFactory();
  let clock = 0;
  const h = deviceHistory(idb, "7", () => ++clock);
  for (let i = 0; i < KEPT_SESSIONS + 3; i++) await h.save(`/s${i}.jsonl`, session(`s${i}`));
  expect(await h.load("/s0.jsonl")).toBeUndefined();
  expect(await h.load("/s2.jsonl")).toBeUndefined();
  expect((await h.load("/s3.jsonl"))?.title).toBe("s3");
  expect((await h.load(`/s${KEPT_SESSIONS + 2}.jsonl`))?.title).toBe(`s${KEPT_SESSIONS + 2}`);
  await h.save("/s3.jsonl", session("again")); // saving refreshes a session's age
  await h.save("/new.jsonl", session("new"));
  expect((await h.load("/s3.jsonl"))?.title).toBe("again");
  expect(await h.load("/s4.jsonl")).toBeUndefined();
});

test("forgetting a device drops only its conversations", async () => {
  const idb = new IDBFactory();
  const a = deviceHistory(idb, "7");
  const b = deviceHistory(idb, "8");
  await a.save("/s.jsonl", session("a"));
  await b.save("/s.jsonl", session("b"));
  await a.clear();
  expect(await a.load("/s.jsonl")).toBeUndefined();
  expect((await b.load("/s.jsonl"))?.title).toBe("b");
});
