// The desktop backend over a fake window.cgsDesktop.host: RelayMux wiring, no queueing while the link is down, pending host
// calls failing on link loss, and child streams reopening after a sidecar restart.
import { afterEach, expect, test, vi } from "vitest";
import { CHILD_RETRY_MS, type MuxMessage } from "../../src/connect/mux";
import { createDesktopBackend } from "../../src/desktop/backend";
import type { DesktopHost, HostLinkStatus } from "../../src/desktop/protocol";

afterEach(() => vi.useRealTimers());

/** A fake preload link: records outbound messages, lets the test push inbound ones and move the link status. */
function fakeLink(initial: HostLinkStatus = "ready") {
  let status = initial;
  const sent: MuxMessage[] = [];
  const messageListeners = new Set<(message: MuxMessage) => void>();
  const statusListeners = new Set<(status: HostLinkStatus) => void>();
  const host: DesktopHost = {
    send(message) {
      if (status !== "ready") return false;
      sent.push(message);
      return true;
    },
    onMessage(callback) {
      messageListeners.add(callback);
      return () => messageListeners.delete(callback);
    },
    onStatus(callback) {
      statusListeners.add(callback);
      callback(status); // the preload answers with the current status right away, like the real one
      return () => statusListeners.delete(callback);
    },
    call: () => Promise.reject(new Error("unused in these tests")),
    onEvent: () => () => {},
  };
  return {
    host,
    sent,
    status: () => status,
    setStatus(next: HostLinkStatus) {
      status = next;
      for (const callback of statusListeners) callback(next);
    },
    receive(message: unknown) {
      for (const callback of messageListeners) callback(message as MuxMessage);
    },
  };
}

const requests = (sent: MuxMessage[]) => sent.filter((message) => message.type === "req");
const opens = (sent: MuxMessage[]) => sent.filter((message) => message.type === "open");

test("host calls travel as req over the link and resolve from the matching res", async () => {
  const link = fakeLink();
  const backend = createDesktopBackend(link.host);
  const info = backend.host.info();
  const req = requests(link.sent).at(-1);
  expect(req).toMatchObject({ type: "req", path: "/api/info" });
  link.receive({ type: "res", id: req?.type === "req" ? req.id : "", status: 200, body: { cwd: "/w", device: "box" } });
  await expect(info).resolves.toEqual({ cwd: "/w", device: "box" });
});

test("a dropped link fails pending calls instead of leaving them hanging", async () => {
  const link = fakeLink();
  const backend = createDesktopBackend(link.host);
  const info = backend.host.info();
  link.setStatus("down");
  await expect(info).rejects.toThrow("relay link lost");
});

test("a child stream closes on link loss and reopens once the link is back", async () => {
  vi.useFakeTimers();
  const link = fakeLink();
  const backend = createDesktopBackend(link.host);
  const seen: string[] = [];
  const transport = backend.connect("child-1");
  transport.onStatus((status) => seen.push(status));
  expect(opens(link.sent)).toHaveLength(1);

  link.setStatus("down");
  expect(seen.at(-1)).toBe("closed");
  expect(transport.send('{"type":"prompt"}')).toBe(false);

  link.setStatus("ready");
  await vi.advanceTimersByTimeAsync(CHILD_RETRY_MS + 10);
  expect(opens(link.sent)).toHaveLength(2);
  expect(opens(link.sent).at(-1)).toMatchObject({ cid: "child-1", path: "/ws" });
});

test("nothing is queued while the link is down: the stream opens only after the link returns", async () => {
  vi.useFakeTimers();
  const link = fakeLink("down");
  const backend = createDesktopBackend(link.host);
  const seen: string[] = [];
  const transport = backend.connect("child-2");
  transport.onStatus((status) => seen.push(status));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toContain("closed");
  expect(opens(link.sent)).toHaveLength(0);

  link.setStatus("ready");
  await vi.advanceTimersByTimeAsync(CHILD_RETRY_MS * 3);
  expect(opens(link.sent)).toHaveLength(1);
});

test("a protocol mismatch ends the mux for good, with no fallback", async () => {
  vi.useFakeTimers();
  const link = fakeLink();
  const backend = createDesktopBackend(link.host);
  const transport = backend.connect("child-3");
  const pending = backend.host.info();
  link.setStatus("upgrade");
  await expect(pending).rejects.toThrow("relay disconnected");
  await vi.advanceTimersByTimeAsync(CHILD_RETRY_MS * 4);
  expect(opens(link.sent)).toHaveLength(1);
  // The transport was retired, not restarted.
  expect(transport.send('{"type":"prompt"}')).toBe(false);
});
