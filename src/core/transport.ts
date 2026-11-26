import type { ChildStatus, HostApi, RpcTransport, Workspace } from "./types";

/** Factory for one child's WebSocket: one JSON frame per message, reconnecting until detached. */
export function webSocketTransport(url: string, retryMs = 1500) {
  return (childId: string) => connectChild(`${url}?child=${encodeURIComponent(childId)}`, retryMs);
}

function connectChild(url: string, retryMs: number): RpcTransport {
  const frameListeners = new Set<(frame: string) => void>();
  const statusListeners = new Set<(s: "connecting" | "ready" | "closed") => void>();
  let ws: WebSocket | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const status = (s: "connecting" | "ready" | "closed") => {
    for (const cb of statusListeners) cb(s);
  };

  const connect = () => {
    status("connecting");
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => status("ready");
    socket.onmessage = (e) => {
      for (const cb of frameListeners) cb(String(e.data));
    };
    socket.onclose = (e) => {
      status("closed");
      if (!closed && e.code !== 4004) timer = setTimeout(connect, retryMs);
    };
  };
  connect();

  return {
    send: (frame) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(frame);
      return true;
    },
    onFrame: (cb) => {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onStatus: (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

/** The dev bridge's HTTP API (`bridge/server.ts`). */
export const bridgeHost: HostApi = {
  info: () => call("/api/info"),
  sessions: async () => (await call<{ workspaces: Workspace[] }>("/api/sessions")).workspaces,
  children: async () => (await call<{ children: ChildStatus[] }>("/api/children")).children,
  complete: (typed) => call(`/api/complete?path=${encodeURIComponent(typed)}`),
  addWorkspace: async (cwd) => void (await call("/api/workspace", { cwd })),
  openChild: (cwd, sessionPath) => call("/api/children", { cwd, sessionPath }),
};
