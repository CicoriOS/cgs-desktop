import { afterEach, expect, test, vi } from "vitest";
import { CHILD_RETRY_MS, RelayMux, type MuxMessage } from "../src/connect/mux";

afterEach(() => vi.useRealTimers());

/** A mux whose outbound channel records every message; `setAccepting(false)` makes `send` refuse, like a dropped relay. */
function harness(accepting = true) {
  const sent: MuxMessage[] = [];
  let open = accepting;
  const mux = new RelayMux((message) => {
    sent.push(message);
    return open;
  });
  return { mux, sent, setAccepting: (value: boolean) => (open = value) };
}

function lastRequest(sent: MuxMessage[]) {
  const req = sent.findLast((m) => m.type === "req");
  if (req?.type !== "req") throw new Error("no req was sent");
  return req;
}

test("host calls go out as req and resolve from the matching res", async () => {
  const { mux, sent } = harness();
  const info = mux.host.info();
  const req = lastRequest(sent);
  expect(req).toEqual({ type: "req", id: req.id, path: "/api/info" });
  mux.receive({ type: "res", id: req.id, status: 200, body: { cwd: "/w", device: "box" } });
  await expect(info).resolves.toEqual({ cwd: "/w", device: "box" });
});

test("mutating host calls carry the same body the bridge receives", async () => {
  const { mux, sent } = harness();
  const opened = mux.host.openChild("/w", "/s.jsonl");
  const req = lastRequest(sent);
  expect(req).toEqual({ type: "req", id: req.id, path: "/api/children", body: { cwd: "/w", sessionPath: "/s.jsonl" } });
  mux.receive({ type: "res", id: req.id, status: 200, body: { id: "a", cwd: "/w", ring: "idle", level: "high", updatedAt: 0, unseen: false } });
  await expect(opened).resolves.toMatchObject({ id: "a", cwd: "/w" });
});

test("a res with status 400 or more rejects with the device's error", async () => {
  const { mux, sent } = harness();
  const added = mux.host.addWorkspace("relative");
  const req = lastRequest(sent);
  mux.receive({ type: "res", id: req.id, status: 400, body: { error: "cwd must be an absolute path" } });
  await expect(added).rejects.toThrow("cwd must be an absolute path");
});

test("a res without an error body rejects with the HTTP status", async () => {
  const { mux, sent } = harness();
  const info = mux.host.info();
  const req = lastRequest(sent);
  mux.receive({ type: "res", id: req.id, status: 500 });
  await expect(info).rejects.toThrow("HTTP 500");
});

test("a child opens at /ws, reports connecting until ready, and accepts writes only once ready", () => {
  const { mux, sent } = harness();
  const t = mux.transport("a");
  const states: string[] = [];
  t.onStatus((s) => states.push(s));
  expect(sent).toEqual([{ type: "open", cid: "a", path: "/ws" }]);
  expect(t.send('{"type":"prompt"}')).toBe(false);
  mux.receive({ type: "ready", cid: "a" });
  expect(states).toEqual(["ready"]);
  expect(t.send('{"type":"prompt"}')).toBe(true);
  expect(sent.at(-1)).toEqual({ type: "frame", cid: "a", text: '{"type":"prompt"}' });
});

test("inbound frames reach only their child's subscribers, in arrival order", () => {
  const { mux } = harness();
  const a = mux.transport("a");
  const b = mux.transport("b");
  const framesA: string[] = [];
  const framesB: string[] = [];
  a.onFrame((f) => framesA.push(f));
  b.onFrame((f) => framesB.push(f));
  mux.receive({ type: "frame", cid: "a", text: "1" });
  mux.receive({ type: "frame", cid: "b", text: "x" });
  mux.receive({ type: "frame", cid: "a", text: "2" });
  expect(framesA).toEqual(["1", "2"]);
  expect(framesB).toEqual(["x"]);
});

test("closing a child sends close once and never reconnects", () => {
  vi.useFakeTimers();
  const { mux, sent } = harness();
  const t = mux.transport("a");
  mux.receive({ type: "ready", cid: "a" });
  t.close();
  t.close();
  expect(sent.filter((m) => m.type === "close")).toEqual([{ type: "close", cid: "a" }]);
  vi.advanceTimersByTime(CHILD_RETRY_MS * 10);
  expect(sent.filter((m) => m.type === "open")).toHaveLength(1);
});

test("a device-side close reports closed and reopens after the retry delay", () => {
  vi.useFakeTimers();
  const { mux, sent } = harness();
  const t = mux.transport("a");
  const states: string[] = [];
  t.onStatus((s) => states.push(s));
  mux.receive({ type: "ready", cid: "a" });
  mux.receive({ type: "close", cid: "a", code: 1006 });
  expect(states).toEqual(["ready", "closed"]);
  vi.advanceTimersByTime(CHILD_RETRY_MS - 1);
  expect(sent.filter((m) => m.type === "open")).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(sent.filter((m) => m.type === "open")).toHaveLength(2);
  expect(states).toEqual(["ready", "closed", "connecting"]);
});

test("close code 4004 (unknown child) does not reconnect", () => {
  vi.useFakeTimers();
  const { mux, sent } = harness();
  mux.transport("a");
  mux.receive({ type: "close", cid: "a", code: 4004 });
  vi.advanceTimersByTime(CHILD_RETRY_MS * 10);
  expect(sent.filter((m) => m.type === "open")).toHaveLength(1);
});

test("an open the relay refuses retries like a lost child", async () => {
  vi.useFakeTimers();
  const { mux, sent, setAccepting } = harness(false);
  mux.transport("a");
  await Promise.resolve(); // the refusal is handled in a microtask, after the caller has subscribed
  setAccepting(true);
  vi.advanceTimersByTime(CHILD_RETRY_MS);
  expect(sent.filter((m) => m.type === "open")).toHaveLength(2);
});

test("replacing a child's transport closes the earlier one", () => {
  const { mux, sent } = harness();
  const first = mux.transport("a");
  mux.receive({ type: "ready", cid: "a" });
  const second = mux.transport("a");
  expect(sent).toContainEqual({ type: "close", cid: "a" });
  expect(sent.filter((m) => m.type === "open")).toHaveLength(2);
  expect(first.send('{"type":"prompt"}')).toBe(false);
  expect(second.send('{"type":"prompt"}')).toBe(false);
});

test("read-only blocks host writes and mutating frames but keeps reads and inbound frames", async () => {
  const { mux, sent } = harness();
  const t = mux.transport("a");
  mux.receive({ type: "ready", cid: "a" });
  const frames: string[] = [];
  t.onFrame((f) => frames.push(f));
  mux.setReadOnly();

  await expect(mux.host.addWorkspace("/w")).rejects.toThrow("read-only");
  expect(sent.some((m) => m.type === "req" && m.path === "/api/workspace")).toBe(false);
  expect(t.send('{"type":"prompt"}')).toBe(false);
  expect(t.send('{"type":"get_state"}')).toBe(true);
  expect(sent.at(-1)).toEqual({ type: "frame", cid: "a", text: '{"type":"get_state"}' });

  const children = mux.host.children();
  const req = lastRequest(sent);
  expect(req.path).toBe("/api/children");
  mux.receive({ type: "res", id: req.id, status: 200, body: { children: [] } });
  await expect(children).resolves.toEqual([]);

  mux.receive({ type: "frame", cid: "a", text: '{"type":"message_start"}' });
  expect(frames).toEqual(['{"type":"message_start"}']);
});

test("disconnect rejects pending host calls, closes children, and stops all traffic and retries", async () => {
  vi.useFakeTimers();
  const { mux, sent } = harness();
  const t = mux.transport("a");
  mux.receive({ type: "ready", cid: "a" });
  const states: string[] = [];
  t.onStatus((s) => states.push(s));
  const pending = mux.host.sessions();

  mux.disconnect();
  await expect(pending).rejects.toThrow("relay disconnected");
  expect(states).toEqual(["closed"]);
  await expect(mux.host.info()).rejects.toThrow("relay unavailable");
  expect(t.send('{"type":"prompt"}')).toBe(false);

  const count = sent.length;
  mux.receive({ type: "frame", cid: "a", text: "{}" });
  vi.advanceTimersByTime(CHILD_RETRY_MS * 10);
  expect(sent).toHaveLength(count);
  expect(states).toEqual(["closed"]);
});

test("disconnect stops a pending retry from reopening a child", () => {
  vi.useFakeTimers();
  const { mux, sent } = harness();
  mux.transport("a");
  mux.receive({ type: "close", cid: "a", code: 1006 });
  mux.disconnect();
  vi.advanceTimersByTime(CHILD_RETRY_MS * 10);
  expect(sent.filter((m) => m.type === "open")).toHaveLength(1);
});

test("malformed inbound messages are ignored", () => {
  const { mux } = harness();
  const t = mux.transport("a");
  const frames: string[] = [];
  t.onFrame((f) => frames.push(f));
  mux.receive(null);
  mux.receive("frame");
  mux.receive({ type: "bogus", cid: "a" });
  mux.receive({ type: "frame", cid: "a" });
  mux.receive({ type: "res", id: "1" });
  mux.receive({ type: "close", cid: 7 });
  expect(frames).toEqual([]);
});
