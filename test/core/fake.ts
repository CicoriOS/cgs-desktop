import type { ChildStatus, HostApi, RpcTransport } from "../../src/core/types";

/** In-memory transport: `sent` holds the frames the client wrote; `push` delivers a frame from "omp". */
export function fakeTransport() {
  const frames = new Set<(f: string) => void>();
  const status = new Set<(s: "connecting" | "ready" | "closed") => void>();
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const transport: RpcTransport = {
    send: (f) => (sent.push(JSON.parse(f)), true),
    onFrame: (cb) => (frames.add(cb), () => frames.delete(cb)),
    onStatus: (cb) => (status.add(cb), () => status.delete(cb)),
    close: () => { closed = true; },
  };
  return {
    transport,
    sent,
    isClosed: () => closed,
    push: (f: unknown) => frames.forEach((cb) => cb(typeof f === "string" ? f : JSON.stringify(f))),
    open: () => status.forEach((cb) => cb("ready")),
    /** Answers the next command of `type` with `data`. */
    respond(type: string, data: unknown = {}) {
      const cmd = [...sent].reverse().find((c) => c.type === type && !("__answered" in c));
      if (!cmd) throw new Error(`no ${type} command was sent`);
      (cmd as Record<string, unknown>).__answered = true;
      frames.forEach((cb) => cb(JSON.stringify({ type: "response", id: cmd.id, command: type, success: true, data })));
    },
    fail(type: string, error: string) {
      const cmd = [...sent].reverse().find((c) => c.type === type && !("__answered" in c));
      if (!cmd) throw new Error(`no ${type} command was sent`);
      (cmd as Record<string, unknown>).__answered = true;
      frames.forEach((cb) => cb(JSON.stringify({ type: "response", id: cmd.id, command: type, success: false, error })));
    },
  };
}

export const childA: ChildStatus = { id: "a", cwd: "/work", sessionPath: "/s.jsonl", ring: "idle", level: "high", updatedAt: 0, unseen: false };

export const fakeHost: HostApi = {
  info: async () => ({ cwd: "/work" }),
  sessions: async () => [],
  complete: async () => ({ exists: false, entries: [] }),
  addWorkspace: async () => {},
  children: async () => [childA],
  openChild: async (cwd, sessionPath) => ({ ...childA, cwd, sessionPath }),
};

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
