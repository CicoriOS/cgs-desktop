/**
 * Development bridge: one headless omp per open session behind the built web client (dist/).
 * Not the cgsconnect remote (ADR 0025/0026 put that in omp's daemon behind a relay); it lets the UI and the RPC surface be worked on.
 *
 * Usage: bun bridge/server.ts [-- command args...]     default command: cgs --mode rpc-ui
 * Env:   PORT (8787), HOST (127.0.0.1), WORKDIR (optional default workspace),
 *        AGENT_DIR (where omp keeps sessions/, default $PI_CODING_AGENT_DIR or ~/.cgs/agent).
 * Anyone who can reach the port controls the agent: keep HOST on loopback unless the network is trusted.
 *
 * HTTP API (JSON):
 *   GET  /api/info                -> { cwd, agentDir }
 *   GET  /api/sessions            -> { workspaces: [{ cwd, sessions: [{ path, id, title, updatedAt }] }] }   newest first; updatedAt in ms
 *   POST /api/workspace {cwd}     -> { cwd }          creates the directory and remembers it as a (possibly empty) workspace
 *   GET  /api/children            -> { children: ChildStatus[] }
 *   POST /api/children {cwd, sessionPath?} -> ChildStatus   creates or reuses the process owning the session file
 * WebSocket /ws?child=<id>: raw JSONL frames, one per message. A snapshot request also gets bridge_snapshot metadata.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialogFrom, ringFor, type EventFrame } from "../src/core/reducer";
import { textOf } from "../src/core/messages";
import type { ChildStatus } from "../src/core/types";

const dist = path.resolve(process.env.DIST ?? path.join(import.meta.dir, "..", "dist"));
// Bun strips the `--` separator from script arguments; also accept it if the runtime preserves it.
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const command = args.length ? args : ["cgs", "--mode", "rpc-ui"];
const agentDir = process.env.AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".cgs", "agent");
const workspacesFile = path.join(agentDir, "cgs", "web-workspaces.json");
const defaultCwd = process.env.WORKDIR ? path.resolve(process.env.WORKDIR) : "";
const CHILD_LIMIT = 8;
const IDLE_MS = 15 * 60_000;
const ATTACH_GRACE_MS = 5_000;
const RPC_MS = 30_000;
type SocketData = { child?: Child; snapshotId?: string };
type Socket = Bun.ServerWebSocket<SocketData>;
interface Child {
  status: ChildStatus;
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  sockets: Set<Socket>;
  dialogs: Map<string, EventFrame>;
  partial?: EventFrame;
  queue?: EventFrame;
  admission: Set<string>;
  ready: boolean;
  stopping: boolean;
  idleSince: number;
  requestedPath?: string;
  rebinding?: Promise<void>;
  pending: Map<string, (response?: Frame) => void>;
}

type Frame = EventFrame & {
  command?: string; success?: boolean; error?: string; sessionSettled?: boolean; agentInvoked?: boolean;
  resolved?: ChildStatus["level"];
  data?: { sessionFile?: string; thinkingLevel?: ChildStatus["level"]; isStreaming?: boolean; isSettled?: boolean; cancelled?: boolean; agentInvoked?: boolean };
};

const children = new Map<string, Child>();
const opening = new Map<string, Promise<ChildStatus>>();
let exiting = false;
const isIdle = (child: Child) => child.ready && !child.stopping && !child.sockets.size && child.status.ring === "idle" && !child.admission.size && !child.dialogs.size;
const fileKey = (file: string) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };

function rpc(child: Child, type: string, args: Record<string, unknown> = {}): Promise<Frame["data"]> {
  const id = `bridge-${crypto.randomUUID()}`;
  const { promise, resolve, reject } = Promise.withResolvers<Frame["data"]>();
  const finish = (frame?: Frame) => {
    clearTimeout(timer);
    child.pending.delete(id);
    if (frame?.success) resolve(frame.data);
    else reject(new Error(frame?.error ?? `omp did not answer ${type}`));
  };
  const timer = setTimeout(finish, RPC_MS);
  child.pending.set(id, finish);
  try { write(child, { type, id, ...args }); } catch { finish(); }
  return promise;
}

function write(child: Child, frame: unknown): void {
  child.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  child.proc.stdin.flush();
}

function setFile(child: Child, sessionFile: string): void {
  const sessionPath = fileKey(sessionFile);
  if (child.status.sessionPath === sessionPath) return;
  child.status.sessionPath = sessionPath;
  child.status.unseen = false;
  child.status.updatedAt = Date.now();
  // A fork changes file identity in this same process.
  try { child.status.title = readSession(sessionPath)?.row.title; } catch { child.status.title = undefined; }
}

function publish(child: Child, line: string): void {
  let f: Frame;
  try { f = JSON.parse(line); } catch { return; }
  const s = child.status;
  if (f.type === "agent_start") {
    s.ring = "work";
    s.unseen = false;
    s.updatedAt = Date.now();
  } else if (f.type === "session_settled" || (f.type === "prompt_result" && f.sessionSettled)) {
    if (s.ring !== "idle") {
      s.unseen = child.sockets.size === 0;
      s.updatedAt = child.idleSince = Date.now();
    }
    s.ring = "idle";
    child.partial = undefined;
  } else if (s.ring !== "idle") {
    s.ring = ringFor(f) ?? s.ring;
  }
  if (f.type === "thinking_level_changed" && f.resolved) s.level = f.resolved;
  if (f.type === "queue_update") child.queue = f;
  const message = typeof f.message === "object" ? f.message : f.assistantMessageEvent?.partial;
  if (f.type === "message_start" && message?.role === "user" && !s.title) {
    s.title = textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 80) || "…";
    s.updatedAt = Date.now();
  }
  if ((f.type === "message_start" || f.type === "message_update") && message?.role === "assistant") {
    // A single bounded partial, never the transcript: get_entries already includes finished messages.
    child.partial = line.length <= 1024 * 1024 ? f : undefined;
  } else if (f.type === "agent_end" || (f.type === "message_end" && child.partial?.messageId === f.messageId)) {
    child.partial = undefined;
  }
  if (f.type === "extension_ui_request") {
    if (f.method === "cancel" && f.targetId) child.dialogs.delete(f.targetId);
    else if (f.id && dialogFrom(f)) child.dialogs.set(f.id, f);
    else if (f.method === "setTitle") s.updatedAt = Date.now();
  }
  if (f.type === "tool_execution_end" && f.toolName === "ask") {
    for (const [id, dialog] of child.dialogs) if (dialog.method === "form") child.dialogs.delete(id);
  }
  if (f.type === "response") {
    if (f.command === "get_state" && f.success) {
      if (f.data?.sessionFile) setFile(child, f.data.sessionFile);
      s.level = f.data?.thinkingLevel ?? s.level;
      if (!(f.data?.isSettled ?? !f.data?.isStreaming) && s.ring === "idle") s.ring = "work";
    }
    if (f.command === "fork" && f.success && !f.data?.cancelled) {
      const rebinding = rpc(child, "get_state").then(() => {}, () => {}).finally(() => {
        if (child.rebinding === rebinding) child.rebinding = undefined;
      });
      child.rebinding = rebinding;
      child.queue = undefined;
    }
    if (f.id && child.admission.delete(f.id)) child.idleSince = Date.now();
    const internal = f.id && child.pending.get(f.id);
    if (internal) { internal(f); return; }
  }
  for (const ws of child.sockets) {
    if (f.type === "response" && f.id === ws.data.snapshotId && f.id !== undefined) {
      ws.data.snapshotId = undefined;
      if (f.success) ws.send(JSON.stringify({ type: "bridge_snapshot", ring: s.ring, level: s.level, partial: child.partial, dialogs: [...child.dialogs.values()], queue: child.queue }));
    }
    ws.send(line);
  }
}

function stop(child: Child): void {
  if (child.stopping) return;
  child.stopping = true;
  child.proc.kill();
}

function spawn(cwd: string, requestedPath?: string): Child {
  const proc = Bun.spawn(command, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const child: Child = {
    proc, requestedPath, ready: false, stopping: false, idleSince: Date.now(), sockets: new Set(), dialogs: new Map(), admission: new Set(), pending: new Map(),
    status: { id: crypto.randomUUID(), cwd, ring: "idle", level: "high", updatedAt: Date.now(), unseen: false },
  };
  children.set(child.status.id, child);
  void (async () => {
    try {
      const decoder = new TextDecoder();
      let rest = "";
      for await (const chunk of proc.stdout) {
        rest += decoder.decode(chunk, { stream: true });
        for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
          const line = rest.slice(0, i);
          rest = rest.slice(i + 1);
          if (line.trim()) publish(child, line);
        }
      }
    } catch (e) {
      console.error(e);
      stop(child);
    } finally {
      const exitCode = await proc.exited;
      children.delete(child.status.id);
      for (const finish of child.pending.values()) finish();
      for (const ws of child.sockets) {
        ws.send(JSON.stringify({ type: "bridge_exit", exitCode }));
        ws.close(4004, "omp exited");
      }
    }
  })();
  return child;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function startChild(cwd: string, sessionPath?: string): Promise<ChildStatus> {
  if (exiting) throw new ApiError("Bridge is shutting down", 503);
  if (children.size >= CHILD_LIMIT) {
    const now = Date.now();
    const oldest = [...children.values()].filter((c) => isIdle(c) && now - c.idleSince >= ATTACH_GRACE_MS).sort((a, b) => a.idleSince - b.idleSince)[0];
    if (!oldest) throw new ApiError("All 8 omp session slots are in use", 409);
    stop(oldest);
    await oldest.proc.exited;
    children.delete(oldest.status.id);
    // A concurrent request may have claimed the slot while we waited.
    return startChild(cwd, sessionPath);
  }
  const child = spawn(cwd, sessionPath);
  try {
    if (sessionPath && (await rpc(child, "switch_session", { sessionPath }))?.cancelled) throw new ApiError("Switch cancelled", 409);
    await rpc(child, "get_state");
    child.ready = true;
    child.idleSince = Date.now();
    return child.status;
  } catch (e) {
    stop(child);
    throw e;
  }
}

async function openChild(cwd: string, file?: string): Promise<ChildStatus> {
  if (!file) return startChild(cwd);
  const sessionPath = fileKey(file);
  const rebinding = [...children.values()].flatMap((c) => c.rebinding ? [c.rebinding] : []);
  if (rebinding.length) await Promise.all(rebinding);
  const existing = [...children.values()].find((c) => (c.status.sessionPath ?? c.requestedPath) === sessionPath && c.ready);
  if (existing && !existing.stopping) {
    existing.idleSince = Date.now();
    return existing.status;
  }
  const pending = opening.get(sessionPath);
  if (pending) return pending;
  const task = (async () => {
    if (existing) await existing.proc.exited;
    return startChild(cwd, sessionPath);
  })();
  opening.set(sessionPath, task);
  try { return await task; } finally { opening.delete(sessionPath); }
}

function remembered(): string[] {
  try {
    const list: unknown = JSON.parse(fs.readFileSync(workspacesFile, "utf8"));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface SessionRow { path: string; id: string; title: string; updatedAt: number }

/** The head of a session file is enough: a padded title line, the header with cwd and id, then the first user message. */
function readSession(file: string): { cwd: string; row: SessionRow } | undefined {
  const fd = fs.openSync(file, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(256 * 1024);
    head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
  let title = "", id = "", sessionCwd = "", first = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "title" && typeof e.title === "string") title = e.title.trim();
    else if (e.type === "session") { id = String(e.id ?? ""); sessionCwd = String(e.cwd ?? ""); }
    else if (e.type === "message" && e.message?.role === "user" && !first) {
      const c = e.message.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ") : "";
      first = text.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    if (title && first && sessionCwd) break;
  }
  if (!sessionCwd || (!title && !first)) return undefined; // never used
  return { cwd: sessionCwd, row: { path: file, id, title: title || first, updatedAt: fs.statSync(file).mtimeMs } };
}

function sessions(): { workspaces: { cwd: string; sessions: SessionRow[] }[] } {
  const byCwd: Record<string, SessionRow[]> = {};
  for (const known of remembered()) byCwd[known] = [];
  if (defaultCwd) byCwd[defaultCwd] ??= [];
  const root = path.join(agentDir, "sessions");
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    try {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
        try {
          const s = readSession(path.join(root, dir, name));
          if (s) (byCwd[s.cwd] ??= []).push(s.row);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    } catch (e) {
      if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
  }
  const newest = (rows: SessionRow[]) => rows.reduce((m, r) => Math.max(m, r.updatedAt), 0);
  return {
    workspaces: Object.entries(byCwd)
      .map(([c, rows]) => ({ cwd: c, sessions: rows.sort((a, b) => b.updatedAt - a.updatedAt) }))
      .sort((a, b) => newest(b.sessions) - newest(a.sessions) || a.cwd.localeCompare(b.cwd)),
  };
}

/** Directory suggestions for a path being typed: the directories under its parent that start with its last segment (hidden ones only when asked for). */
function complete(typed: string): { exists: boolean; entries: string[] } {
  if (!path.isAbsolute(typed)) return { exists: false, entries: [] };
  const inDir = typed.endsWith("/");
  const dir = inDir ? typed : path.dirname(typed);
  const prefix = inDir ? "" : path.basename(typed).toLowerCase();
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch {}
  const entries = names
    .filter((n) => n.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !n.startsWith(".")) && isDir(path.join(dir, n)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 40)
    .map((n) => path.join(dir, n));
  return { exists: isDir(typed), entries };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function api(req: Request, route: string): Promise<Response> {
  if (route === "/api/info" && req.method === "GET") return json({ cwd: defaultCwd, agentDir });
  if (route === "/api/children" && req.method === "GET") {
    return json({ children: [...children.values()].filter((c) => c.ready && !c.stopping).map((c) => c.status) });
  }
  if (route === "/api/sessions" && req.method === "GET") return json(sessions());
  if (route === "/api/complete" && req.method === "GET") return json(complete(new URL(req.url).searchParams.get("path") ?? "/"));
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  const body = (await req.json().catch(() => null)) as { cwd?: unknown; sessionPath?: unknown } | null;
  if (typeof body?.cwd !== "string" || !path.isAbsolute(body.cwd)) return json({ error: "cwd must be an absolute path" }, 400);
  const cwd = path.resolve(body.cwd);
  if (route === "/api/workspace") {
    fs.mkdirSync(cwd, { recursive: true });
    const list = remembered();
    if (!list.includes(cwd)) {
      fs.mkdirSync(path.dirname(workspacesFile), { recursive: true });
      fs.writeFileSync(workspacesFile, `${JSON.stringify([...list, cwd], null, 2)}\n`);
    }
    return json({ cwd });
  }
  if (route === "/api/children") {
    const file = body.sessionPath;
    if (file !== undefined && (typeof file !== "string" || !path.isAbsolute(file))) return json({ error: "sessionPath must be an absolute path" }, 400);
    return json(await openChild(cwd, file), file ? 200 : 201);
  }
  return json({ error: "not found" }, 404);
}

const server = Bun.serve<SocketData>({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  async fetch(req, srv) {
    const url = new URL(req.url);
    const route = url.pathname;
    if (route === "/ws") {
      const child = children.get(url.searchParams.get("child") ?? "");
      return srv.upgrade(req, { data: { child } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (route.startsWith("/api/")) {
      try { return await api(req, route); }
      catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof ApiError ? e.status : 500); }
    }
    // The built SPA (`bun run build`): real files by path, everything else is the app shell.
    const file = path.join(dist, path.normalize(route));
    if (file.startsWith(dist + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(Bun.file(file), { headers: { "cache-control": route.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store" } });
    }
    return new Response(Bun.file(path.join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
  websocket: {
    open(ws) {
      const child = ws.data.child;
      if (!child?.ready || child.stopping) { ws.close(4004, "Unknown omp child"); return; }
      child.sockets.add(ws);
      child.status.unseen = false;
    },
    close(ws) {
      const child = ws.data.child;
      if (child?.sockets.delete(ws) && !child.sockets.size) child.idleSince = Date.now();
    },
    message(ws, message) {
      const child = ws.data.child;
      if (!child?.sockets.has(ws) || child.stopping) return;
      try {
        const f = JSON.parse(String(message));
        if (typeof f?.type !== "string") return;
        // Session selection is a bridge operation. Fork is a deliberate RPC transition to a new file.
        if (["new_session", "switch_session", "open_session", "branch"].includes(f.type)) {
          ws.send(JSON.stringify({ type: "response", command: f.type, id: f.id, success: false, error: "Use /api/children to open a session" }));
          return;
        }
        if (f.bridgeSnapshot && (f.type === "get_entries" || f.type === "get_messages")) ws.data.snapshotId = f.id;
        delete f.bridgeSnapshot;
        if (f.type === "extension_ui_response") child.dialogs.delete(f.id);
        if (f.type === "prompt") {
          f.id ??= `prompt-${crypto.randomUUID()}`;
          child.admission.add(f.id);
        }
        write(child, f);
      } catch { /* malformed frame or child already exited */ }
    },
  },
});

setInterval(() => {
  const now = Date.now();
  for (const child of children.values()) if (isIdle(child) && now - child.idleSince >= IDLE_MS) stop(child);
}, 60_000).unref();

async function shutdown() {
  if (exiting) return;
  exiting = true;
  server.stop(true);
  const processes = [...children.values()];
  for (const child of processes) stop(child);
  const timer = setTimeout(() => {
    for (const child of processes) if (child.proc.exitCode === null) child.proc.kill("SIGKILL");
  }, 1500);
  await Promise.all(processes.map((c) => c.proc.exited));
  clearTimeout(timer);
  process.exit(0);
}

console.log(`rpc-web: http://${server.hostname}:${server.port}  ->  ${command.join(" ")}${defaultCwd ? `  (default cwd ${defaultCwd})` : ""}`);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
