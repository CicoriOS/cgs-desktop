import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClient } from "../src/core/client";
import { createDemoBackend } from "../src/demo/backend";

const clients = new Set<{ close(): void }>();
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const c of clients) c.close();
  clients.clear();
  vi.useRealTimers();
});

function demo() {
  const { connect, host } = createDemoBackend();
  const client = createClient(connect, host, { holdMs: 0 });
  clients.add(client);
  return client;
}

/** Runs the demo's scripted clock forward until `check` holds. */
async function until(check: () => boolean, what: string, limitMs = 60_000): Promise<void> {
  for (let spent = 0; !check(); spent += 50) {
    if (spent > limitMs) throw new Error(`timed out waiting for ${what}`);
    await vi.advanceTimersByTimeAsync(50);
  }
}

test("the demo opens its newest conversation with history, todos and three sessions listed", async () => {
  const c = demo();
  await until(() => c.getState().connection === "ready" && !c.getState().loading, "the first session");
  const s = c.getState();
  expect(s.turns).toHaveLength(3);
  expect(Object.values(s.tools).map((t) => t.name)).toEqual(expect.arrayContaining(["todo", "grep", "read", "edit", "write", "bash", "web_search", "eval"]));
  expect(s.todos[0]?.tasks.some((t) => t.status === "in_progress")).toBe(true);
  await until(() => c.getState().workspaces.flatMap((w) => w.sessions).length === 3, "the session list");
});

test("a session opened while it waits for the user shows the question, and answering lets the run finish", async () => {
  const c = demo();
  await until(() => c.getState().connection === "ready" && c.getState().workspaces.length > 0, "the first session");
  const workspace = c.getState().workspaces.find((w) => w.sessions.some((x) => x.title.includes("支付回调")))!;
  const session = workspace.sessions.find((x) => x.title.includes("支付回调"))!;
  await c.actions.openSession(session.path, workspace.cwd);
  await until(() => c.getState().dialogs.length === 1 && c.getState().connection === "ready", "the ask form");
  expect(c.getState().run.streaming).toBe(true);
  const dialog = c.getState().dialogs[0]!;
  expect(dialog.method).toBe("form");
  c.actions.answerDialog(dialog.id, { data: { strategy: "index" } });
  await until(() => !c.getState().run.streaming, "the run to finish");
  expect(c.getState().turns.at(-1)!.state).toBe("done");
  expect(Object.values(c.getState().tools).find((t) => t.name === "ask")?.status).toBe("ok");
});

test("a prompt about subagents streams a run that fills the dock and settles", async () => {
  const c = demo();
  await until(() => c.getState().connection === "ready" && !c.getState().loading, "the first session");
  void c.actions.send("并行检查一下项目规模"); // resolves when the demo's clock admits it, so it is not awaited before the clock runs
  await until(() => c.getState().subagents.some((x) => x.id === "scan-a"), "a subagent");
  await until(() => !c.getState().run.streaming && c.getState().turns.length === 4, "the run to settle");
  expect(c.getState().subagents.filter((x) => x.id.startsWith("scan-")).every((x) => x.status === "completed")).toBe(true);
});
