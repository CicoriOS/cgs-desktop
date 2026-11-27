import { afterEach, expect, test } from "vitest";
import { createClient } from "../../src/core/client";
import { applyFrame, initialState } from "../../src/core/reducer";
import { t } from "../../src/i18n";
import { fakeHost, fakeTransport, tick } from "./fake";

const clients = new Set<{ close(): void }>();
afterEach(() => {
  for (const c of clients) c.close();
  clients.clear();
});

test("a cgs_control frame records the controller and whether this page may write", () => {
  const locked = applyFrame(initialState(), { type: "cgs_control", childId: "a", controller: { kind: "remote", name: "Phone" }, you: false }, 1);
  expect(locked.control).toEqual({ controller: { kind: "remote", name: "Phone" }, you: false });
  const free = applyFrame(initialState(), { type: "cgs_control", childId: "a", controller: null, you: true }, 1);
  expect(free.control).toEqual({ controller: undefined, you: true });
});

/** A client attached to fake child `a`, hydrated and ready. */
async function connected(takeControl?: (childId: string) => Promise<void>) {
  const socket = fakeTransport();
  const c = createClient(() => socket.transport, { ...fakeHost, ...(takeControl ? { takeControl } : {}) }, { holdMs: 0 });
  clients.add(c);
  await tick();
  socket.open();
  await tick();
  socket.respond("set_title_language");
  socket.respond("get_state", { sessionFile: "/s.jsonl", isStreaming: false });
  await tick();
  socket.respond("get_entries", { entries: [], leafId: null });
  await tick();
  return { socket, client: c };
}

test("a controlled conversation refuses writes and keeps the text, while reads pass", async () => {
  const { socket, client } = await connected();
  socket.push({ type: "cgs_control", childId: "a", controller: { kind: "desktop", name: "MacBook" }, you: false });
  expect(client.getState().control).toEqual({ controller: { kind: "desktop", name: "MacBook" }, you: false });

  socket.sent.length = 0;
  await client.actions.send("hello");
  expect(socket.sent).toEqual([]);
  expect(client.getState().draftRestore?.text).toBe("hello");
  expect(client.getState().toast?.text).toBe(t("control.blocked"));

  // Reads are still sent: the page shows the conversation, only writes are held back.
  void client.actions.pickerRows();
  expect(socket.sent.some((f) => f.type === "get_model_picker")).toBe(true);
  socket.respond("get_model_picker", { rows: [], recent: 0, total: 0 });
  await tick();

  // A dialog answer is a write too.
  socket.push({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Go?", message: "Proceed?" });
  expect(client.getState().dialogs).toHaveLength(1);
  client.actions.answerDialog("ui-1", { confirmed: true });
  expect(socket.sent.some((f) => f.type === "extension_ui_response")).toBe(false);
  expect(client.getState().dialogs).toHaveLength(1);
});

test("once this page controls the conversation again its writes go through", async () => {
  const { socket, client } = await connected();
  socket.push({ type: "cgs_control", childId: "a", controller: { kind: "remote", name: "Phone" }, you: false });
  socket.push({ type: "cgs_control", childId: "a", controller: { kind: "remote", name: "Phone" }, you: true });
  socket.sent.length = 0;
  void client.actions.send("hello");
  await tick();
  expect(socket.sent.some((f) => f.type === "prompt")).toBe(true);
});

test("takeControl asks the host for the open conversation", async () => {
  const taken: string[] = [];
  const { client } = await connected(async (childId) => {
    taken.push(childId);
  });
  await client.actions.takeControl();
  expect(taken).toEqual(["a"]);
});
