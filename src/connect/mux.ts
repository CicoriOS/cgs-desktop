// C3: one relay channel carries the host API and every child's RPC stream (ADR 0036, cgsconnect/remote.md).
//
// The channel is opaque here: `RelayMux` gets a `send(message) => boolean` and is fed inbound messages through
// `receive`. The controller wraps each `MuxMessage` as the payload of one authenticated relay frame, so this module
// has no knowledge of the wire format or of the handshake.
//
// Message shapes (mux -> device unless noted):
//   req    {type, id, path, body?}           host API call; `path` and `body` are exactly what `bridgeHost` sends
//   res    {type, id, status, body?}         device -> mux; the device answers with the bridge's own HTTP status and JSON
//   open   {type, cid, path}                 attach child `cid` at stream `path` (CHILD_PATH, the bridge's `/ws`)
//   ready  {type, cid}                       device -> mux; the child is attached and frames may flow (WebSocket `open`)
//   frame  {type, cid, text}                 one omp RPC JSON frame, either direction
//   close  {type, cid, code?, reason?}       either direction; device -> mux `code` 4004 means unknown child
//
// Timing, as the bridge behaves (bridge/server.ts, core/transport.ts):
// - A child transport reports "connecting" until `ready`. `send` returns false until then, so the client never writes
//   before it can hydrate. The client starts hydration on "ready".
// - Frames keep the device's order, which is also the order the client needs: the device must send `bridge_snapshot`
//   before the `get_entries`/`get_messages` response it accompanies, as the bridge does.
// - A device-initiated close reports "closed" and reopens after CHILD_RETRY_MS, except for code 4004 (unknown child).
//   The mux stops reconnecting when the transport is closed, replaced, or the mux is disconnected.

import { isReadOnlyFrame } from "../core/frames";
import type { ChildStatus, HostApi, RpcTransport, Workspace } from "../core/types";

/** Stream path a child is attached at; the bridge serves it as `/ws?child=<id>`. */
export const CHILD_PATH = "/ws";
/** Reconnect delay after a device-initiated close; equal to `webSocketTransport`'s default. */
export const CHILD_RETRY_MS = 1500;
/** Close code the bridge uses for an unknown child: reconnecting cannot succeed. */
const UNKNOWN_CHILD = 4004;

export type MuxMessage =
  | { type: "req"; id: string; path: string; body?: unknown }
  | { type: "res"; id: string; status: number; body?: unknown }
  | { type: "open"; cid: string; path: string }
  | { type: "ready"; cid: string }
  | { type: "frame"; cid: string; text: string }
  | { type: "close"; cid: string; code?: number; reason?: string };

type Status = "connecting" | "ready" | "closed";

interface Reply {
  status: number;
  body?: unknown;
}

interface Stream {
  readonly cid: string;
  status: Status;
  /** False once closed by the client, replaced by a newer transport for the same child, or the mux is disconnected. */
  live: boolean;
  cancelRetry?: () => void;
  readonly frames: Set<(frame: string) => void>;
  readonly statuses: Set<(status: Status) => void>;
  readonly transport: RpcTransport;
}

export class RelayMux {
  readonly #send: (message: MuxMessage) => boolean;
  readonly #pending = new Map<string, PromiseWithResolvers<Reply>>();
  readonly #streams = new Map<string, Stream>();
  #seq = 0;
  #readOnly = false;
  #disconnected = false;

  constructor(send: (message: MuxMessage) => boolean) {
    this.#send = send;
  }

  /** HostApi over `req`/`res`, with the same routes and bodies as `bridgeHost` (core/transport.ts). */
  readonly host: HostApi = {
    info: () => this.#request("/api/info"),
    sessions: async () => (await this.#request<{ workspaces: Workspace[] }>("/api/sessions")).workspaces,
    complete: (typed) => this.#request(`/api/complete?path=${encodeURIComponent(typed)}`),
    addWorkspace: async (cwd) => void (await this.#request("/api/workspace", { cwd }, true)),
    children: async () => (await this.#request<{ children: ChildStatus[] }>("/api/children")).children,
    openChild: (cwd, sessionPath, options) => this.#request("/api/children", { cwd, sessionPath, ...options }, true),
    account: () => this.#request("/api/account"),
    // Per conversation, so the controller of one conversation does not keep the others read-only (ADR 0047). Still a
    // mutation: while another browser controls the device the mux refuses it, and the viewer takes the device over first.
    takeControl: (childId) => this.#request(`/api/children/${encodeURIComponent(childId)}/control`, { take: true }, true),
  };

  /** One child's RpcTransport. Calling it again for the same child closes the earlier transport first. */
  readonly transport = (childId: string): RpcTransport => {
    const previous = this.#streams.get(childId);
    if (previous) this.#release(previous);

    const frames = new Set<(frame: string) => void>();
    const statuses = new Set<(status: Status) => void>();
    const stream: Stream = {
      cid: childId,
      status: "connecting",
      live: true,
      frames,
      statuses,
      transport: {
        send: (frame) => {
          if (stream.status !== "ready") return false;
          if (this.#readOnly && !isReadOnlyFrame(frame)) return false;
          return this.#emit({ type: "frame", cid: childId, text: frame });
        },
        onFrame: (cb) => {
          frames.add(cb);
          return () => frames.delete(cb);
        },
        onStatus: (cb) => {
          statuses.add(cb);
          return () => statuses.delete(cb);
        },
        close: () => this.#release(stream),
      },
    };
    this.#streams.set(childId, stream);
    this.#connect(stream);
    return stream.transport;
  };

  /** Feeds one inbound message (already decoded from the relay frame). Malformed input and unknown ids are ignored. */
  receive(input: unknown): void {
    if (this.#disconnected) return;
    const message = parseMessage(input);
    if (!message) return;
    switch (message.type) {
      case "res": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        pending.resolve({ status: message.status, body: message.body });
        return;
      }
      case "ready": {
        const stream = this.#streams.get(message.cid);
        if (stream?.status === "connecting") this.#setStatus(stream, "ready");
        return;
      }
      case "frame": {
        const stream = this.#streams.get(message.cid);
        if (stream) for (const cb of stream.frames) cb(message.text);
        return;
      }
      case "close": {
        const stream = this.#streams.get(message.cid);
        if (stream) this.#lost(stream, message.code);
        return;
      }
      default:
        // `req` and `open` travel mux -> device only.
        return;
    }
  }

  /** Blocks mutations from now on: host writes and frames outside READ_ONLY_FRAMES. Inbound messages keep flowing. One-way. */
  setReadOnly(): void {
    this.#readOnly = true;
  }

  /**
   * The link under the mux dropped but may come back (the relay socket, or the desktop sidecar restarting). Host calls in
   * flight fail and every child closes, so each one reopens through the normal retry path once `send` works again. Unlike
   * `disconnect`, this is not terminal: the mux stays usable and nothing tells the other end.
   */
  linkLost(): void {
    if (this.#disconnected) return;
    const error = new Error("relay link lost");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const stream of [...this.#streams.values()]) this.#lost(stream);
  }

  /** Rejects pending host requests, closes every child, and sends nothing further. Terminal: use a new mux to reconnect. */
  disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    const error = new Error("relay disconnected");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const stream of [...this.#streams.values()]) this.#release(stream);
  }

  #emit(message: MuxMessage): boolean {
    return !this.#disconnected && this.#send(message);
  }

  async #request<T = unknown>(path: string, body?: unknown, mutates = false): Promise<T> {
    if (mutates && this.#readOnly) throw new Error("relay is read-only");
    const id = String(++this.#seq);
    const deferred = Promise.withResolvers<Reply>();
    this.#pending.set(id, deferred);
    const message: MuxMessage = body === undefined ? { type: "req", id, path } : { type: "req", id, path, body };
    if (!this.#emit(message)) {
      this.#pending.delete(id);
      deferred.reject(new Error("relay unavailable"));
    }
    const reply = await deferred.promise;
    if (reply.status >= 400) {
      const data: unknown = reply.body;
      const error = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : `HTTP ${reply.status}`;
      throw new Error(error);
    }
    return reply.body as T;
  }

  #connect(stream: Stream): void {
    this.#setStatus(stream, "connecting");
    if (!this.#emit({ type: "open", cid: stream.cid, path: CHILD_PATH })) {
      // Deferred: the caller has not subscribed to status yet when `transport()` returns; a failed open retries like a lost one.
      queueMicrotask(() => {
        if (stream.live && stream.status === "connecting") this.#lost(stream);
      });
    }
  }

  /** Client-initiated end: sends `close` once, stops reconnecting, and drops the stream. */
  #release(stream: Stream): void {
    if (!stream.live) return;
    stream.live = false;
    stream.cancelRetry?.();
    if (this.#streams.get(stream.cid) === stream) this.#streams.delete(stream.cid);
    this.#emit({ type: "close", cid: stream.cid });
    this.#setStatus(stream, "closed");
  }

  /** Device-initiated close: the stream reports closed and reopens after the retry delay, unless the child is unknown. */
  #lost(stream: Stream, code?: number): void {
    if (!stream.live || stream.status === "closed") return;
    this.#setStatus(stream, "closed");
    if (code !== UNKNOWN_CHILD && !this.#disconnected) {
      const timer = setTimeout(() => {
        stream.cancelRetry = undefined;
        if (stream.live) this.#connect(stream);
      }, CHILD_RETRY_MS);
      stream.cancelRetry = () => clearTimeout(timer);
    }
  }

  #setStatus(stream: Stream, status: Status): void {
    stream.status = status;
    for (const cb of stream.statuses) cb(status);
  }
}

const REQUIRED_FIELDS: Record<MuxMessage["type"], readonly string[]> = {
  req: ["id", "path"],
  res: ["id"],
  open: ["cid", "path"],
  ready: ["cid"],
  frame: ["cid", "text"],
  close: ["cid"],
};

/** Checks the shape of an inbound message from the device; the cast is justified by the field checks above it. */
function parseMessage(input: unknown): MuxMessage | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const m = input as Record<string, unknown>;
  if (typeof m.type !== "string" || !Object.hasOwn(REQUIRED_FIELDS, m.type)) return undefined;
  const type = m.type as MuxMessage["type"];
  if (!REQUIRED_FIELDS[type].every((key) => typeof m[key] === "string")) return undefined;
  if (type === "res" && typeof m.status !== "number") return undefined;
  if (type === "close" && m.code !== undefined && typeof m.code !== "number") return undefined;
  return m as unknown as MuxMessage;
}
