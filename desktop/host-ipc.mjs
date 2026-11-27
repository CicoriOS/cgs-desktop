// The renderer <-> main half of the local host (ADR 0046 §1). One sidecar serves every window; this module forwards MuxMessage
// objects in both directions, answers the renderer's `call`s and mirrors the link status. Messages stay structured-clone
// objects the whole way — the sidecar line is parsed once, in sidecar.mjs — and Electron's per-webContents IPC ordering keeps
// streams in order without a second framing layer.
//
// Every window shares one sidecar channel, whose streams and host requests are keyed by the ids the renderer chooses. Two
// windows would therefore collide on their first request id ("1") and on a child watched by both, so main prefixes both ids
// and cids with a per-window, per-document token on the way in and strips it on the way out. A stream's child is named in
// the open path (`/ws?child=<id>`) because the cid is occupied by that token.
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import { resolveSidecarCommand, sidecarEnv, sidecarLogFile } from "./platform.mjs";
import { createSidecar } from "./sidecar.mjs";

/** Channel names mirrored in desktop/preload.cjs. */
const SEND = "cgs:host:send";
const MESSAGE = "cgs:host:message";
const STATUS = "cgs:host:status";
const CALL = "cgs:host:call";
const EVENT = "cgs:host:event";

/** One window's token is `w<webContents id>.<document generation>:`; a reload bumps the generation so late answers cannot
 * reach the new document. */
const TOKEN = /^w(\d+)\.(\d+):/;
/** Main-process host requests are `main:<n>`; they have no window to be routed to. */
const MAIN_ID = "main:";
const REQUEST_TIMEOUT_MS = 15_000;

/** The running sidecar and the quit guard, reachable from the exported helpers below. */
let currentSidecar;
let stopping = false;
const mainPending = new Map();
let mainSeq = 0;

/**
 * One Host request from the main process (`/api/children` for notifications and quit confirmation). Resolves with
 * `{ status, body }`; rejects when the link is down. Answers are ordinary `res` messages on the same sidecar channel.
 */
export function requestHost(path, body) {
  if (!currentSidecar || currentSidecar.status !== "ready") return Promise.reject(new Error("link_not_ready"));
  const id = `${MAIN_ID}${++mainSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mainPending.delete(id);
      reject(new Error("timeout"));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    mainPending.set(id, { resolve, reject, timer });
    const sent = currentSidecar.send(body === undefined ? { type: "req", id, path } : { type: "req", id, path, body });
    if (!sent) {
      clearTimeout(timer);
      mainPending.delete(id);
      reject(new Error("link_not_ready"));
    }
  });
}

/** Stops the sidecar for a real quit (the updater's `quitAndInstall`): `will-quit` will not wait for it again. */
export function shutdownLocalHost() {
  stopping = true;
  return currentSidecar?.shutdown() ?? Promise.resolve();
}

function settleMainRequests(error) {
  for (const [id, pending] of mainPending) {
    clearTimeout(pending.timer);
    mainPending.delete(id);
    if (error) pending.reject(error);
    else pending.resolve(undefined);
  }
}

/**
 * Starts the sidecar and exposes `window.cgsDesktop.host` to every window. Called once from main.mjs.
 * Status is delivered by polling `STATUS` on subscribe (which survives a reload) and by broadcasts on change; the
 * revision counter keeps an older poll answer from overwriting a newer broadcast.
 */
export function startLocalHost({ env = process.env, cgs } = {}) {
  let sidecar;
  let revision = 0;

  /** webContents id -> { generation, cids } — cids are stored with their token, ready to close when the document goes. */
  const windows = new Map();

  const broadcast = (channel, ...args) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const contents = win.webContents;
      if (!contents.isDestroyed()) contents.send(channel, ...args);
    }
  };

  const scopeOf = (contents) => {
    let scope = windows.get(contents.id);
    if (!scope) {
      scope = { generation: 0, cids: new Set() };
      windows.set(contents.id, scope);
      contents.on("did-start-loading", () => {
        // A reload starts a new document: its streams are gone and a late answer must not resolve its requests.
        closeStreams(scope);
        scope.generation += 1;
      });
      contents.once("destroyed", () => {
        closeStreams(scope);
        windows.delete(contents.id);
      });
    }
    return scope;
  };

  const closeStreams = (scope) => {
    for (const cid of scope.cids) sidecar?.send({ type: "close", cid });
    scope.cids.clear();
  };

  const tokenOf = (contents) => {
    const scope = scopeOf(contents);
    return `w${contents.id}.${scope.generation}:`;
  };

  /** Adds the sender's token to the ids the sidecar sees. Not mutated in place: the object also lives in the renderer. */
  const scoped = (message, token) => {
    switch (message.type) {
      case "req":
        return typeof message.id === "string" ? { ...message, id: `${token}${message.id}` } : message;
      case "open": {
        if (typeof message.cid !== "string" || typeof message.path !== "string") return message;
        const path = `${message.path}${message.path.includes("?") ? "&" : "?"}child=${encodeURIComponent(message.cid)}`;
        return { ...message, cid: `${token}${message.cid}`, path };
      }
      case "frame":
      case "close":
        return typeof message.cid === "string" ? { ...message, cid: `${token}${message.cid}` } : message;
      default:
        return message;
    }
  };

  /** Delivers one sidecar message to the window that asked for it, with the token removed. */
  const route = (message) => {
    if (message.type === "res" && typeof message.id === "string" && message.id.startsWith(MAIN_ID)) {
      const pending = mainPending.get(message.id);
      if (pending) {
        mainPending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve({ status: message.status, body: message.body });
      }
      return;
    }
    const field = message.type === "res" ? "id" : message.type === "ready" || message.type === "frame" || message.type === "close" ? "cid" : undefined;
    const key = field ? message[field] : undefined;
    if (!field || typeof key !== "string") {
      broadcast(MESSAGE, message); // nothing this module scoped; the renderer's mux ignores what it does not know
      return;
    }
    const match = TOKEN.exec(key);
    if (!match) {
      broadcast(MESSAGE, message);
      return;
    }
    const id = Number(match[1]);
    const contents = webContents.fromId(id);
    const scope = windows.get(id);
    // Late answer for a reloaded document, or a window that is gone: drop it.
    if (!contents || contents.isDestroyed() || !scope || scope.generation !== Number(match[2])) return;
    const stripped = key.slice(match[0].length);
    if (field === "cid") {
      const full = `${match[0]}${stripped}`;
      if (message.type === "close") scope.cids.delete(full);
      // `ready`/`frame` only matter while the stream is open; keep the set for open/close bookkeeping.
    }
    contents.send(MESSAGE, { ...message, [field]: stripped });
  };

  ipcMain.on(SEND, (event, message) => {
    if (!sidecar || !message || typeof message !== "object") return;
    const token = tokenOf(event.sender);
    if (message.type === "open" && typeof message.cid === "string") scopeOf(event.sender).cids.add(`${token}${message.cid}`);
    if (message.type === "close" && typeof message.cid === "string") scopeOf(event.sender).cids.delete(`${token}${message.cid}`);
    sidecar.send(scoped(message, token));
  });
  ipcMain.handle(STATUS, () => (sidecar ? { status: sidecar.status, detail: sidecar.detail(), revision } : { status: "connecting", detail: {}, revision }));
  ipcMain.handle(CALL, (_event, method, params) => {
    if (!sidecar) return Promise.reject(new Error("link_not_ready"));
    return sidecar.call(method, params);
  });

  app.on("will-quit", (event) => {
    if (stopping) return;
    // Quitting immediately would cut the sidecar off from `shutdown`; wait for it (bounded) and then quit for real.
    stopping = true;
    event.preventDefault();
    void (sidecar?.shutdown() ?? Promise.resolve()).finally(() => app.quit());
  });

  void app.whenReady().then(() => {
    const spec = resolveSidecarCommand({ env, cgs });
    sidecar = createSidecar(
      spec.error
        ? { failure: { error: spec.error, log: spec.log } }
        : { command: spec.command, args: spec.args, env: sidecarEnv(env), logFile: sidecarLogFile(app) },
    );
    sidecar.on("status", (status, detail) => {
      if (status === "down" || status === "upgrade") settleMainRequests(new Error("link_down"));
      revision += 1;
      broadcast(STATUS, status, detail, revision);
    });
    sidecar.on("message", (message) => route(message));
    sidecar.on("event", (name, data) => broadcast(EVENT, name, data));
    currentSidecar = sidecar;
    // A window can only exist after this callback, but replaying the starting status keeps a reload in sync even then.
    revision += 1;
    broadcast(STATUS, sidecar.status, sidecar.detail(), revision);
    sidecar.start();
  });
}
