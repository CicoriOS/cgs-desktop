// The demo backend: the same two seams the real client uses (an RPC transport per child, and the host's HTTP-shaped API), answered in
// memory. Selected with `?demo` (see main.tsx); nothing else in the app knows it exists.
import type { AccountSnapshot, ChildStatus, HostApi, RpcTransport, Workspace } from "../core/types";
import { Log } from "./log";
import { createSession, demoSessions } from "./scenarios";
import type { DemoSession } from "./session";
import { demoSettings } from "./settings";
import { demoWorkspace } from "./workspace";

const HOME = "/home/demo";
const DIRS = ["cgs-web", "payments-api", "progress", "notes", "playground"];

export interface DemoBackend {
  connect: (childId: string) => RpcTransport;
  host: HostApi;
}

const DAY_S = 86_400;

/** Pay-as-you-go balance plus one monthly plan that is about a third used. */
function demoAccount(): AccountSnapshot {
  const now = Date.now();
  return {
    username: "林枫",
    tier: "pro",
    balance: "¥128.40",
    stale: false,
    fetchedAt: now,
    subscriptions: [
      {
        id: 1,
        planTitle: "Pro 月度套餐",
        unlimited: false,
        amountUsed: 36.8,
        amountTotal: 100,
        usedDisplay: "¥36.80",
        totalDisplay: "¥100.00",
        resetPeriod: "monthly",
        nextResetAt: Math.floor(now / 1000) + 12 * DAY_S,
        endTime: 0,
      },
    ],
  };
}

export function createDemoBackend(): DemoBackend {
  const sessions: DemoSession[] = [];
  const extraWorkspaces = new Set<string>();
  const archive = (s: DemoSession) => void sessions.push(s);
  sessions.push(...demoSessions(archive));
  for (const s of sessions) s.live = true;
  let fresh = 0;
  let signedIn = true;

  const byId = (id: string) => sessions.find((s) => s.id === id);

  const host: HostApi = {
    workspace: demoWorkspace,
    account: async () => signedIn ? demoAccount() : undefined,
    settings: demoSettings(() => { signedIn = false; }),
    info: async () => ({ cwd: sessions[0]?.cwd ?? `${HOME}/${DIRS[0]}`, device: "CGS 演示设备" }),
    sessions: async () => {
      const byCwd = new Map<string, Workspace>();
      for (const cwd of extraWorkspaces) byCwd.set(cwd, { cwd, sessions: [] });
      for (const s of sessions) {
        if (!s.log.entries.length) continue; // omp writes the file with the first message
        const ws = byCwd.get(s.cwd) ?? { cwd: s.cwd, sessions: [] };
        ws.sessions.push({ path: s.path, id: s.id, title: s.shownTitle, updatedAt: s.updatedAt });
        byCwd.set(s.cwd, ws);
      }
      for (const ws of byCwd.values()) ws.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return [...byCwd.values()].sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
    },
    children: async () => sessions.filter((s) => s.live).map((s) => s.child()),
    complete: async (typed) => {
      const base = typed.slice(0, typed.lastIndexOf("/") + 1);
      const prefix = typed.slice(base.length);
      if (base !== `${HOME}/`) return { exists: typed === HOME, entries: base === "/" ? [HOME] : [] };
      const entries = DIRS.filter((d) => d.startsWith(prefix)).map((d) => `${base}${d}`);
      return { exists: DIRS.includes(prefix), entries };
    },
    addWorkspace: async (cwd) => void extraWorkspaces.add(cwd),
    openChild: async (cwd, sessionPath): Promise<ChildStatus> => {
      let s = sessionPath ? sessions.find((x) => x.path === sessionPath) : sessions.find((x) => x.cwd === cwd && !x.log.entries.length);
      if (!s) {
        const id = `child-new-${++fresh}`;
        s = createSession({ id, cwd, path: `${cwd.replace(/\//g, "-")}/new-${fresh}.jsonl`, log: new Log(Date.now()) }, archive);
        sessions.push(s);
      }
      s.live = true;
      return s.child();
    },
    // One viewer per conversation in the demo: the click on the lock makes it the controller (ADR 0047).
    takeControl: async (childId) => byId(childId)?.takeControl(),
  };

  const connect = (childId: string): RpcTransport => {
    const frames = new Set<(f: string) => void>();
    const statuses = new Set<(s: "connecting" | "ready" | "closed") => void>();
    const session = byId(childId);
    let closed = false;
    const deliver = (f: string) => {
      if (!closed) for (const cb of frames) cb(f);
    };
    setTimeout(() => {
      if (closed) return;
      if (!session) return void statuses.forEach((cb) => cb("closed"));
      statuses.forEach((cb) => cb("ready"));
      session.attach(deliver);
    }, 0);
    return {
      send: (frame) => {
        if (closed || !session) return false;
        const cmd = JSON.parse(frame);
        setTimeout(() => !closed && session.handle(cmd, deliver), 0);
        return true;
      },
      onFrame: (cb) => (frames.add(cb), () => frames.delete(cb)),
      onStatus: (cb) => (statuses.add(cb), () => statuses.delete(cb)),
      close: () => {
        closed = true;
        session?.detach(deliver);
      },
    };
  };

  return { connect, host };
}
