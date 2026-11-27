// The local host sidecar (ADR 0046 §1, cgsconnect/local-channel.md §2): one long-lived `cgs __cgs_worker_module` process,
// spoken to over JSONL on stdio. This module supervises it — handshake, restart with backoff, shutdown — and turns stdout
// lines into events. It assumes nothing about MuxMessage payloads: the renderer's RelayMux owns those.
import { spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { SIDECAR_PROTOCOL, killChild, spawnOptions } from "./platform.mjs";

/** How much of the sidecar's stderr and startup diagnostics stays in memory for the error page. */
const MAX_LOG_LINES = 60;
const LOG_LINE_LIMIT = 400;
/** A line bigger than this without a newline is a protocol violation; drop it rather than grow without bound. */
const MAX_BUFFER = 64 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 2000;
const SHUTDOWN_KILL_MS = 1000;
/** A sidecar that stayed ready this long starts its next crash with the base delay again. */
const STABLE_MS = 10_000;
const MUX_TYPES = new Set(["req", "res", "open", "ready", "frame", "close"]);

export function createSidecar(options = {}) {
  return new Sidecar(options);
}

/**
 * Events:
 * - `status` (status, detail) — `connecting | ready | down | upgrade`, detail is `{ error?, log?, protocol?, cli? }`
 * - `message` (object) — one outbound MuxMessage from the sidecar, already parsed
 * - `event` (name, data) — the sidecar's own pushes (`state`, `account`, …)
 */
export class Sidecar extends EventEmitter {
  #command;
  #args;
  #env;
  #cwd;
  #spawn;
  #logFile;
  #protocol;
  #restartBaseMs;
  #restartMaxMs;
  #handshakeTimeoutMs;
  #now;

  #child;
  #generation = 0;
  #status = "connecting";
  #detail = {};
  #pending = new Map();
  #seq = 0;
  #attempts = 0;
  #readySince = 0;
  #handshakeSeen = false;
  #reason;
  #fatal;
  #stopping = false;
  #shutdown;
  #restartTimer;
  #handshakeTimer;

  #lines = [];
  #logStream;
  #logBroken = false;

  constructor({
    command,
    args = [],
    env = process.env,
    cwd,
    spawn = defaultSpawn,
    logFile,
    failure,
    protocol = SIDECAR_PROTOCOL,
    restartBaseMs = 500,
    restartMaxMs = 10_000,
    handshakeTimeoutMs = 15_000,
    now = Date.now,
  } = {}) {
    super();
    this.#command = command;
    this.#args = args;
    this.#env = env;
    this.#cwd = cwd;
    this.#spawn = spawn;
    this.#logFile = logFile;
    this.#protocol = protocol;
    this.#restartBaseMs = restartBaseMs;
    this.#restartMaxMs = restartMaxMs;
    this.#handshakeTimeoutMs = handshakeTimeoutMs;
    this.#now = now;
    if (!command) {
      // Nothing to run: the page gets the reason instead of a restart loop (cgs not found, protocol override broken).
      const reason = failure ?? { error: "cgs_not_found" };
      if (typeof reason.log === "string") for (const line of reason.log.split("\n")) this.#pushLine(line);
      this.#status = "down";
      this.#detail = { error: reason.error ?? "cgs_not_found" };
    }
  }

  get status() {
    return this.#status;
  }

  /** The current status detail plus the log tail (what the error pages show). */
  detail() {
    const log = this.logTail();
    return log ? { ...this.#detail, log } : { ...this.#detail };
  }

  /** Last lines of stderr and startup diagnostics, newest last. */
  logTail(lines = 20) {
    return this.#lines.slice(-lines).join("\n");
  }

  start() {
    if (this.#stopping || this.#fatal || !this.#command || this.#child || this.#restartTimer) return;
    this.#spawnChild();
  }

  /** Forwards one MuxMessage; false when the link is not usable right now (nothing is queued). */
  send(message) {
    if (this.#status !== "ready" || !this.#child?.stdin?.writable) return false;
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** The sidecar's own calls (`state`, login, settings, …); rejects with the sidecar's error code as the message. */
  call(method, params) {
    if (this.#status !== "ready" || !this.#child) return Promise.reject(new Error("link_not_ready"));
    const id = `call-${++this.#seq}`;
    const deferred = Promise.withResolvers();
    this.#pending.set(id, deferred);
    if (!this.send(params === undefined ? { type: "call", id, method } : { type: "call", id, method, params })) {
      this.#pending.delete(id);
      deferred.reject(new Error("link_not_ready"));
    }
    return deferred.promise;
  }

  /** Sends `shutdown`, waits for the sidecar to leave, then escalates to signals. Resolves once it is gone or out of time. */
  shutdown() {
    this.#shutdown ??= this.#shutdownOnce();
    return this.#shutdown;
  }

  async #shutdownOnce() {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    this.#clearHandshake();
    const child = this.#child;
    if (!child) {
      this.#status = "down";
      this.#detail = {};
      return;
    }
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      child.stdin?.write('{"type":"shutdown"}\n');
      child.stdin?.end();
    } catch {
      /* the pipe is already gone */
    }
    if (await settles(closed, SHUTDOWN_GRACE_MS)) return;
    killChild(child, "SIGTERM");
    if (await settles(closed, SHUTDOWN_KILL_MS)) return;
    killChild(child, "SIGKILL");
    await settles(closed, SHUTDOWN_KILL_MS);
  }

  #spawnChild() {
    const generation = ++this.#generation;
    let child;
    try {
      child = this.#spawn(this.#command, this.#args, {
        ...spawnOptions(this.#command),
        env: this.#env,
        cwd: this.#cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#record(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      this.#setStatus("down", { error: "spawn_failed" });
      this.#scheduleRestart();
      return;
    }
    this.#child = child;
    this.#handshakeSeen = false;
    this.#reason = undefined;
    let settled = false;
    const settle = (info) => {
      if (settled) return;
      settled = true;
      this.#onExit(child, generation, info);
    };
    // A dying pipe reports EPIPE asynchronously; without a listener Node would take the whole app down.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (error) => {
      this.#record(`process error: ${error instanceof Error ? error.message : String(error)}`);
      settle({ spawnError: true });
    });
    child.on("close", (code, signal) => settle({ code, signal }));
    if (child.stdout) {
      readLines(child.stdout, (line) => {
        if (generation === this.#generation) this.#onStdout(line);
      });
    }
    if (child.stderr) readLines(child.stderr, (line) => this.#record(line));
    this.#clearHandshake();
    this.#handshakeTimer = setTimeout(() => {
      this.#handshakeTimer = undefined;
      if (generation !== this.#generation || this.#handshakeSeen) return;
      this.#reason = { error: "handshake_timeout" };
      this.#record("the sidecar did not send hello in time");
      killChild(child, "SIGTERM");
    }, this.#handshakeTimeoutMs);
  }

  #onStdout(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.#record(`unparsable sidecar output (${text.length} bytes)`);
      return;
    }
    if (typeof message !== "object" || message === null || typeof message.type !== "string") {
      this.#record("sidecar output without a type");
      return;
    }
    if (!this.#handshakeSeen) {
      if (message.type === "hello") {
        this.#onHello(message);
        return;
      }
      // local-channel.md §2: the first line must be hello. Anything else is a broken pairing, not mux traffic.
      this.#reason = { error: "bad_handshake" };
      this.#record(`unexpected first line: ${message.type}`);
      if (this.#child) killChild(this.#child, "SIGTERM");
      return;
    }
    switch (message.type) {
      case "hello":
        this.#record("duplicate hello ignored");
        return;
      case "callres": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error(typeof message.error === "string" && message.error ? message.error : "call_failed"));
        return;
      }
      case "event":
        if (typeof message.name === "string") this.emit("event", message.name, message.data);
        return;
      default:
        if (MUX_TYPES.has(message.type)) this.emit("message", message);
        else this.#record(`unknown sidecar message: ${message.type}`);
    }
  }

  #onHello(message) {
    this.#handshakeSeen = true;
    this.#clearHandshake();
    const cli = typeof message.cli === "string" ? message.cli : "";
    if (message.protocol !== this.#protocol) {
      // No fallback to an older or newer protocol (ADR 0041, local-channel.md §2): the page asks the user to update.
      this.#fatal = { error: "protocol_mismatch", protocol: typeof message.protocol === "number" ? message.protocol : 0, cli };
      this.#record(`protocol mismatch: sidecar speaks ${String(message.protocol)}, this app speaks ${this.#protocol}`);
      this.#setStatus("upgrade", { protocol: this.#fatal.protocol, cli });
      if (this.#child) killChild(this.#child, "SIGTERM");
      return;
    }
    this.#readySince = this.#now();
    this.#setStatus("ready", {});
  }

  #onExit(child, generation, info) {
    if (generation !== this.#generation || child !== this.#child) return;
    this.#child = undefined;
    this.#clearHandshake();
    this.#rejectPending("link_down");
    if (this.#stopping) {
      this.#status = "down";
      this.#detail = {};
      return;
    }
    if (this.#fatal) return; // stays "upgrade": killing it was deliberate and there is nothing to retry
    if (this.#readySince && this.#now() - this.#readySince >= STABLE_MS) this.#attempts = 0;
    this.#readySince = 0;
    const error = this.#reason?.error ?? (info.spawnError ? "spawn_failed" : "sidecar_exited");
    if (!info.spawnError && info.code !== undefined) this.#record(`sidecar exited (code ${String(info.code)}${info.signal ? `, signal ${info.signal}` : ""})`);
    this.#setStatus("down", { error });
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    clearTimeout(this.#restartTimer);
    const delay = Math.min(this.#restartBaseMs * 2 ** this.#attempts, this.#restartMaxMs);
    this.#attempts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#stopping) this.#spawnChild();
    }, delay);
  }

  #rejectPending(code) {
    if (this.#pending.size === 0) return;
    const error = new Error(code);
    for (const deferred of this.#pending.values()) deferred.reject(error);
    this.#pending.clear();
  }

  #setStatus(status, detail) {
    this.#status = status;
    this.#detail = detail;
    this.emit("status", status, this.detail());
  }

  #clearHandshake() {
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }

  #record(line) {
    for (const part of String(line).split("\n")) this.#pushLine(part);
  }

  #pushLine(line) {
    const text = line.replace(/\r$/, "");
    if (!text) return;
    this.#lines.push(text.length > LOG_LINE_LIMIT ? `${text.slice(0, LOG_LINE_LIMIT)}…` : text);
    if (this.#lines.length > MAX_LOG_LINES) this.#lines.splice(0, this.#lines.length - MAX_LOG_LINES);
    const stream = this.#fileStream();
    if (!stream) return;
    try {
      stream.write(`${new Date().toISOString()} ${text}\n`);
    } catch {
      /* the file is a diagnostic, never a reason to fail the link */
    }
  }

  #fileStream() {
    if (!this.#logFile || this.#logBroken) return undefined;
    if (this.#logStream) return this.#logStream;
    try {
      fs.mkdirSync(path.dirname(this.#logFile), { recursive: true });
      this.#logStream = fs.createWriteStream(this.#logFile, { flags: "a" });
      this.#logStream.on("error", () => {
        this.#logBroken = true;
      });
      return this.#logStream;
    } catch {
      this.#logBroken = true;
      return undefined;
    }
  }
}

/** Splits a child stream into lines; partial data at EOF is reported too. */
function readLines(stream, onLine) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
    if (buffer.length > MAX_BUFFER) {
      onLine(`oversized sidecar output dropped (${buffer.length} bytes)`);
      buffer = "";
    }
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
    buffer = "";
  });
}

function settles(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
