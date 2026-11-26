// One browser <-> device connection through the relay (ADR 0036). It owns the socket and the phase the page shows;
// the mux (mux.ts) turns host calls and child streams into messages, and the shared wire library (@cgs/wire) does the
// handshake, the pin and the encryption. Nothing here reads message content except to route it.
import { BrowserSession, fingerprint, fromBase64, toBase64, UNKNOWN_CHILD_REASON, WireError, type Step, type WireEvent, type WireMessage } from "@cgs/wire";
import type { HostApi, RpcTransport } from "../core/types";
import { t } from "../i18n";
import type { DeviceMark } from "../ui/client-context";
import { deviceStore, type DeviceStore } from "./browser-store";
import { RelayMux, type MuxMessage } from "./mux";

export type Phase = "connecting" | "missing" | "login" | "forbidden" | "disabled" | "offline" | "error" | "revoked" | "locked" | "password" | "fingerprint" | "changed" | "busy" | "ready" | "readonly";

export interface RelayState {
  phase: Phase;
  /** The device's fingerprint when known: shown to confirm, and as the mark in the sidebar. */
  emoji: readonly DeviceMark[];
  /** Name offered for this browser in the password form. */
  name: string;
  problem?: string;
  /** Who holds control (busy) or took it (readonly). */
  by?: string;
  until?: number;
}

export interface RelayDeps {
  fetch: typeof fetch;
  createSocket(url: string): WebSocket;
  idb: IDBFactory;
  origin: URL;
  locks?: LockManager;
  userAgent: string;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export function browserDeps(): RelayDeps {
  return {
    fetch: (...a) => fetch(...a),
    createSocket: (url) => new WebSocket(url),
    idb: indexedDB,
    origin: new URL(location.href),
    locks: navigator.locks,
    userAgent: navigator.userAgent,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

/** Relay close codes (relay-protocol.md). */
const CLOSE_PHASE: Record<number, Phase> = { 4401: "login", 4403: "forbidden", 4404: "missing", 4409: "disabled", 4410: "offline" };
const UNKNOWN_CHILD_CODE = 4004;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const IDLE_RETRY_MS = 10_000;
const AUTH_LOCK = "new-api:auth-refresh";

/** A short, human name for this browser: "Chrome on Linux". The user can change it in the password form. */
export function defaultBrowserName(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function marksOf(pin: string): DeviceMark[] {
  const fp = fingerprint(fromBase64(pin));
  return fp.emoji.map((emoji, i) => ({ emoji, zh: fp.zh[i] ?? emoji, en: fp.en[i] ?? emoji }));
}

function toWire(m: MuxMessage): WireMessage | null {
  switch (m.type) {
    // The body is what the bridge would have sent as JSON: keys holding undefined do not exist there, and the wire refuses them.
    case "req": return m.body === undefined ? { k: "req", id: m.id, method: "GET", path: m.path } : { k: "req", id: m.id, method: "POST", path: m.path, body: JSON.parse(JSON.stringify(m.body)) };
    // The device attaches a stream to the child named in the path, as the bridge does for `/ws?child=<id>`.
    case "open": return { k: "open", cid: m.cid, path: `${m.path}?child=${encodeURIComponent(m.cid)}` };
    case "frame": return { k: "frame", cid: m.cid, text: m.text };
    case "close": return { k: "close", cid: m.cid };
    default: return null;
  }
}

function toMux(m: WireMessage): MuxMessage | null {
  switch (m.k) {
    case "res": return { type: "res", id: m.id, status: m.status, body: m.body };
    case "ready": return { type: "ready", cid: m.cid };
    case "frame": return { type: "frame", cid: m.cid, text: m.text };
    case "close": return { type: "close", cid: m.cid, reason: m.reason, ...(m.reason === UNKNOWN_CHILD_REASON ? { code: UNKNOWN_CHILD_CODE } : {}) };
    default: return null;
  }
}

class Failure extends Error {
  constructor(readonly phase: Phase, readonly detail?: string) {
    super(detail ?? phase);
  }
}

export class RelayConnection {
  readonly #deps: RelayDeps;
  readonly #deviceId: number;
  readonly #store: DeviceStore;
  readonly #listeners = new Set<() => void>();
  #state: RelayState;
  #mux = new RelayMux(() => false);
  #socket: WebSocket | null = null;
  #session: BrowserSession | null = null;
  #sid = "";
  #seq = 0;
  #inbound: Promise<void> = Promise.resolve();
  #outbound: Promise<void> = Promise.resolve();
  #generation = 0;
  #retryTimer: unknown;
  #retries = 0;
  #control = false;
  #wantControl = false;
  #needsConfirm = false;
  #closed = false;

  constructor(device: string, deps: RelayDeps = browserDeps()) {
    this.#deps = deps;
    this.#deviceId = /^[1-9][0-9]*$/.test(device) ? Number(device) : 0;
    this.#store = deviceStore(deps.idb, device);
    this.#state = { phase: "connecting", emoji: [], name: defaultBrowserName(deps.userAgent) };
  }

  get host(): HostApi { return this.#mux.host; }
  get transport(): (childId: string) => RpcTransport { return this.#mux.transport; }

  readonly subscribe = (cb: () => void): (() => void) => {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  };
  readonly getSnapshot = (): RelayState => this.#state;

  #set(patch: Partial<RelayState> & { phase: Phase }): void {
    this.#state = { emoji: this.#state.emoji, name: this.#state.name, ...patch };
    for (const cb of this.#listeners) cb();
  }

  /** First connection: ask for the password before touching the network. A saved key resumes without one. */
  async start(): Promise<void> {
    if (this.#deviceId === 0) return this.#set({ phase: "missing" });
    const saved = await this.#store.load();
    if (saved) {
      this.#set({ phase: "connecting", emoji: marksOf(saved.pin) });
      return this.#connect(undefined, saved.name);
    }
    this.#set({ phase: "password" });
  }

  password(password: string, name: string): void {
    this.#state = { ...this.#state, name };
    this.#set({ phase: "connecting" });
    void this.#connect(password, name);
  }

  retry(): void {
    if (this.#state.phase === "revoked") void this.#store.clear().then(() => this.#restart());
    else this.#restart();
  }

  /** Confirms a first fingerprint, or after a changed device forgets the old pin so the password is asked again. */
  confirm(): void {
    if (this.#state.phase === "changed") {
      void this.#store.clear().then(() => this.#restart());
      return;
    }
    this.#needsConfirm = false;
    this.#settle();
  }

  takeover(): void {
    if (this.#state.phase === "busy" && this.#session) {
      this.#wantControl = true;
      this.#say({ k: "takeover" });
      this.#set({ phase: "connecting", emoji: this.#state.emoji });
      return;
    }
    this.#wantControl = true;
    this.#restart();
  }

  close(): void {
    this.#closed = true;
    this.#teardown();
  }

  #restart(): void {
    this.#retries = 0;
    this.#teardown();
    this.#set({ phase: "connecting", emoji: this.#state.emoji });
    void this.start();
  }

  #teardown(): void {
    this.#generation++;
    this.#deps.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#mux.disconnect();
    this.#mux = new RelayMux(() => false);
    const socket = this.#socket;
    this.#socket = null;
    this.#session = null;
    this.#control = false;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  #retryLater(ms: number): void {
    if (this.#closed) return;
    const generation = this.#generation;
    this.#retryTimer = this.#deps.setTimeout(() => {
      if (generation === this.#generation && !this.#closed) this.#restart();
    }, ms);
  }

  async #accessToken(): Promise<string> {
    const refresh = async () => {
      const res = await this.#deps.fetch("/api/user/auth/refresh", { method: "POST", credentials: "same-origin" });
      if (res.status === 401 || res.status === 403) throw new Failure("login");
      if (!res.ok) throw new Failure("error", `HTTP ${res.status}`);
      const body = (await res.json()) as { success?: boolean; data?: { access_token?: string } };
      if (!body.success || !body.data?.access_token) throw new Failure("login");
      return body.data.access_token;
    };
    return this.#deps.locks ? this.#deps.locks.request(AUTH_LOCK, { mode: "exclusive" }, refresh) : refresh();
  }

  async #ticket(): Promise<string> {
    const token = await this.#accessToken();
    const res = await this.#deps.fetch("/api/remote/ticket", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ device: this.#deviceId }),
    });
    if (res.status === 401) throw new Failure("login");
    if (res.status === 403) throw new Failure("forbidden");
    if (res.status === 404) throw new Failure("missing");
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: { ticket?: string } } | null;
    if (!res.ok || !body?.success || !body.data?.ticket) throw new Failure("error", `HTTP ${res.status}`);
    return body.data.ticket;
  }

  async #connect(password: string | undefined, name: string): Promise<void> {
    const generation = ++this.#generation;
    try {
      const ticket = await this.#ticket();
      if (generation !== this.#generation) return;
      const url = new URL("/relay", this.#deps.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      this.#open(this.#deps.createSocket(url.href), generation, password, name);
    } catch (e) {
      if (generation !== this.#generation) return;
      this.#fail(e instanceof Failure ? e : new Failure("error", e instanceof Error ? e.message : String(e)));
    }
  }

  #fail(f: Failure): void {
    this.#teardownSocketOnly();
    this.#set({ phase: f.phase, ...(f.phase === "error" ? { problem: f.detail } : {}) });
    if (f.phase === "offline" || f.phase === "disabled") this.#retryLater(IDLE_RETRY_MS);
  }

  #teardownSocketOnly(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#session = null;
    this.#control = false;
    this.#mux.disconnect();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  #open(socket: WebSocket, generation: number, password: string | undefined, name: string): void {
    this.#socket = socket;
    this.#seq = 0;
    this.#control = false;
    this.#needsConfirm = false;
    this.#inbound = Promise.resolve();
    this.#outbound = Promise.resolve();
    this.#mux = new RelayMux((m) => this.#fromMux(m));
    const session = new BrowserSession({ store: this.#store, name, ...(password === undefined ? {} : { password }) });
    this.#session = session;
    socket.onmessage = (ev) => {
      if (generation !== this.#generation || typeof ev.data !== "string") return;
      this.#inbound = this.#inbound.then(() => this.#frame(ev.data as string, session, generation)).catch((e) => this.#protocolError(e, generation));
    };
    socket.onclose = (ev) => {
      if (generation !== this.#generation) return;
      this.#closedByRelay(ev.code);
    };
  }

  #closedByRelay(code: number): void {
    this.#teardownSocketOnly();
    const phase = CLOSE_PHASE[code];
    const current = this.#state.phase;
    if (phase) return this.#fail(new Failure(phase));
    // Terminal screens and a password retry keep their state: the page already knows why the link ended.
    if (current === "readonly" || current === "locked" || current === "revoked" || current === "changed" || current === "password" || current === "error") return;
    if (current === "busy") return;
    if (current === "ready" || current === "connecting" || current === "fingerprint") {
      this.#set({ phase: "connecting", emoji: this.#state.emoji });
      this.#retryLater(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.#retries++));
    }
  }

  #protocolError(e: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    console.warn("connect: protocol error", e);
    this.#teardownSocketOnly();
    this.#set({ phase: "error", problem: e instanceof WireError ? t("connect.error.protocol") : e instanceof Error ? e.message : String(e) });
  }

  async #frame(text: string, session: BrowserSession, generation: number): Promise<void> {
    let envelope: { v?: unknown; type?: unknown; sid?: unknown; payload?: unknown };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new WireError("envelope is not JSON");
    }
    if (envelope.v !== 1 || typeof envelope.sid !== "string") return;
    if (envelope.type === "ctl") {
      const op = (envelope.payload as { op?: unknown } | null)?.op;
      if (op === "open" && !this.#sid) {
        this.#sid = envelope.sid;
        await this.#apply(await session.start(), generation);
      } else if (op === "close") {
        this.#closedByRelay(1006);
      }
      return;
    }
    if (envelope.type !== "data" || typeof envelope.payload !== "string") return;
    await this.#apply(await session.receive(fromBase64(envelope.payload)), generation);
  }

  /** Events first (a pin or a registration must be recorded before anything is forwarded), then the outgoing records. */
  async #apply(step: Step, generation: number): Promise<void> {
    for (const event of step.events) this.#event(event);
    if (generation !== this.#generation) return;
    for (const record of step.outgoing) this.#sendRecord(record);
  }

  #sendRecord(payload: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ v: 1, type: "data", sid: this.#sid, seq: this.#seq++, payload: toBase64(payload) }));
  }

  #event(e: WireEvent): void {
    switch (e.type) {
      case "pinned":
        this.#needsConfirm = true;
        this.#state = { ...this.#state, emoji: marksOf(e.pin) };
        return;
      case "pin_mismatch":
        this.#teardownSocketOnly();
        this.#set({ phase: "changed", emoji: marksOf(e.received) });
        return;
      case "auth_failed":
        this.#authFailed(e.code);
        return;
      case "message":
        this.#message(e.message);
        return;
      default:
        return;
    }
  }

  #authFailed(code: string): void {
    this.#teardownSocketOnly();
    if (code === "bad_password") this.#set({ phase: "password", problem: t("connect.password.wrong") });
    else if (code === "locked") this.#set({ phase: "locked" });
    else if (code === "unknown_browser" || code === "bad_signature") this.#set({ phase: "revoked" });
    else if (code === "no_password") this.#set({ phase: "disabled" });
    else this.#set({ phase: "error", problem: code });
  }

  #message(m: WireMessage): void {
    switch (m.k) {
      case "hello":
        this.#control = true;
        this.#retries = 0;
        this.#settle();
        return;
      case "busy":
        if (this.#wantControl) {
          this.#say({ k: "takeover" });
          return;
        }
        this.#set({ phase: "busy", by: m.by, emoji: this.#state.emoji });
        return;
      case "taken_over":
        this.#control = false;
        this.#mux.setReadOnly();
        this.#set({ phase: "readonly", by: m.by, emoji: this.#state.emoji });
        return;
      case "error":
        this.#teardownSocketOnly();
        this.#set({ phase: "error", problem: m.code });
        return;
      default: {
        const mux = toMux(m);
        if (mux) this.#mux.receive(mux);
      }
    }
  }

  #settle(): void {
    if (!this.#control) return;
    if (this.#needsConfirm) this.#set({ phase: "fingerprint", emoji: this.#state.emoji });
    else if (this.#state.phase !== "ready") this.#set({ phase: "ready", emoji: this.#state.emoji });
    this.#wantControl = false;
  }

  /** Mux -> device. False when this page does not hold control, so the client never writes into a dead link. */
  #fromMux(m: MuxMessage): boolean {
    const wire = toWire(m);
    if (!wire || !this.#control) return false;
    return this.#say(wire);
  }

  #say(message: WireMessage): boolean {
    const session = this.#session;
    if (!session || this.#socket?.readyState !== WebSocket.OPEN) return false;
    // Serialized: records of one message must never interleave with another's.
    this.#outbound = this.#outbound
      .then(async () => {
        for (const record of await session.send(message)) this.#sendRecord(record);
      })
      .catch((e) => this.#protocolError(e, this.#generation));
    return true;
  }
}
