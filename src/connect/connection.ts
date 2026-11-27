// One browser <-> device connection through the relay (ADR 0036). It owns the socket and the phase the page shows;
// the mux (mux.ts) turns host calls and child streams into messages, and the shared wire library (@cgs/wire) does the
// handshake, the pin and the encryption. Nothing here reads message content except to route it.
import { BrowserSession, fingerprint, fromBase64, toBase64, UNKNOWN_CHILD_REASON, WireError, type Step, type WireEvent, type WireMessage } from "@cgs/wire";
import type { HostApi, RpcTransport } from "../core/types";
import { t } from "../i18n";
import { deviceStore, type DeviceStore } from "./browser-store";
import { deviceHistory, type DeviceHistory } from "./history-cache";
import { RelayMux, type MuxMessage } from "./mux";

/** One symbol of a device fingerprint, shown on the confirmation page (ADR 0036). */
export interface DeviceMark {
  readonly emoji: string;
  readonly zh: string;
  readonly en: string;
}

export type Phase = "connecting" | "missing" | "login" | "forbidden" | "disabled" | "offline" | "error" | "limited" | "revoked" | "locked" | "password" | "fingerprint" | "changed" | "busy" | "ready" | "readonly";

export interface RelayState {
  phase: Phase;
  /** The device's fingerprint when known: shown once, to confirm it. */
  emoji: readonly DeviceMark[];
  /** What the device lists this browser as, read from the user agent ("Chrome on Linux"). */
  name: string;
  problem?: string;
  /** Who holds control (busy) or took it (readonly). */
  by?: string;
  /** When a lock (locked) or a rate limit (limited) ends. */
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
  /** Wall clock in ms; tests move it. */
  now?(): number;
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
const LIMITED_RETRY_MS = 60_000;
const AUTH_LOCK = "new-api:auth-refresh";
/**
 * How long a fingerprint the user confirmed stays good while the password is typed and the link is re-made. The first
 * connection is split in two (fingerprint, then password) and the browser may be suspended or lose the network between
 * them, so nothing is held on the wire: the page remembers the confirmed key, and a new socket within this window
 * continues from it. Memory only; a reload starts over.
 */
const FINGERPRINT_WINDOW_MS = 15 * 60_000;
/** How long a returning tab waits for the device to answer before it calls the link dead. */
const PROBE_MS = 5000;

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

/** How long a 429 asks the page to wait (`Retry-After` in seconds), else a minute. */
function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : LIMITED_RETRY_MS;
}

class Failure extends Error {
  constructor(readonly phase: Phase, readonly detail?: string, readonly retryMs?: number) {
    super(detail ?? phase);
  }
}

export class RelayConnection {
  readonly #deps: RelayDeps;
  readonly #deviceId: number;
  readonly #store: DeviceStore;
  /** The conversations this browser keeps for the device; forgotten together with the pin. */
  readonly history: DeviceHistory;
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
  /** The device key the user confirmed on the fingerprint page, and when. */
  #confirmed: { pin: string; at: number } | null = null;
  /** Typed password, kept only while the handshake it is for may still be re-made inside the window. */
  #pendingPassword: string | undefined;
  /** The key a fingerprint or changed page is showing before the password step. Null when the page shows a saved key's. */
  #probedPin: string | null = null;
  /** The confirmed key this socket's password handshake was answered for: no second fingerprint after it. */
  #trusted: string | null = null;

  constructor(device: string, deps: RelayDeps = browserDeps()) {
    this.#deps = deps;
    this.#deviceId = /^[1-9][0-9]*$/.test(device) ? Number(device) : 0;
    this.#store = deviceStore(deps.idb, device);
    this.history = deviceHistory(deps.idb, device);
    this.#state = { phase: "connecting", emoji: [], name: defaultBrowserName(deps.userAgent) };
  }

  /** The pin and key go first (the next connection needs the password); what was read from the old device goes with them, best effort. */
  async #forget(): Promise<void> {
    await this.#store.clear();
    await this.history.clear().catch(() => {});
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

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** The key confirmed on the fingerprint page, while its window is open. An expired window also drops the password. */
  #trustedPin(): string | null {
    const c = this.#confirmed;
    if (c && this.#now() - c.at < FINGERPRINT_WINDOW_MS) return c.pin;
    this.#confirmed = null;
    this.#pendingPassword = undefined;
    return null;
  }

  /**
   * A saved key resumes without a password. Otherwise the device key comes first: connect once to read it and show the
   * fingerprint, and only after the user confirmed it ask for the password (`password()` connects again).
   */
  async start(): Promise<void> {
    if (this.#deviceId === 0) return this.#set({ phase: "missing" });
    const saved = await this.#store.load();
    if (saved) {
      this.#set({ phase: "connecting", emoji: marksOf(saved.pin) });
      return this.#connect(saved.name);
    }
    if (this.#trustedPin() !== null && this.#pendingPassword === undefined) return this.#set({ phase: "password" });
    this.#set({ phase: "connecting" });
    return this.#connect(this.#state.name);
  }

  password(password: string): void {
    this.#pendingPassword = password;
    this.#set({ phase: "connecting" });
    void this.#connect(this.#state.name);
  }

  retry(): void {
    if (this.#state.phase === "revoked") void this.#forget().then(() => this.#restart());
    else this.#restart();
  }

  /**
   * Confirms the fingerprint on screen. Before the password step that opens the window and asks for the password; for a
   * device that cannot announce its key it confirms the one shown after the handshake. A changed saved device forgets
   * the old pin so the first-connection flow starts again.
   */
  confirm(): void {
    const phase = this.#state.phase;
    if (this.#probedPin !== null && (phase === "fingerprint" || phase === "changed")) {
      this.#confirmed = { pin: this.#probedPin, at: this.#now() };
      this.#probedPin = null;
      this.#set({ phase: "password" });
      return;
    }
    if (phase === "changed") {
      void this.#forget().then(() => this.#restart());
      return;
    }
    this.#needsConfirm = false;
    this.#settle();
  }

  /**
   * The tab came back to the foreground or the network returned. A backgrounded Safari suspends timers and kills sockets
   * without always saying so, so neither the backoff timer nor `onclose` can be relied on: do not wait for them.
   */
  resume(): void {
    if (this.#closed) return;
    if (this.#retryTimer !== undefined) return this.#restart(); // waiting out a backoff that may have been suspended
    const socket = this.#socket;
    // A handshake in flight (the fingerprint probe, or the password step) on a socket the system closed silently.
    if (this.#state.phase === "connecting") return !socket || socket.readyState !== WebSocket.OPEN ? this.#restart() : undefined;
    if (this.#state.phase !== "ready") return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return this.#reconnectAsController();
    // Looks open, but may be a socket the system dropped: it must answer a request.
    const generation = this.#generation;
    let timer: unknown;
    const silence = new Promise<never>((_, reject) => {
      timer = this.#deps.setTimeout(() => reject(new Error("no answer")), PROBE_MS);
    });
    void Promise.race([this.#mux.host.info(), silence]).then(
      () => this.#deps.clearTimeout(timer),
      () => {
        this.#deps.clearTimeout(timer);
        if (generation === this.#generation && !this.#closed) this.#reconnectAsController();
      },
    );
  }

  /** The page held control before the link died, so it takes it back instead of asking again. */
  #reconnectAsController(): void {
    this.#wantControl = true;
    this.#restart();
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
      if (res.status === 429) throw new Failure("limited", undefined, retryAfterMs(res));
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
    if (res.status === 429) throw new Failure("limited", undefined, retryAfterMs(res));
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: { ticket?: string } } | null;
    if (!res.ok || !body?.success || !body.data?.ticket) throw new Failure("error", `HTTP ${res.status}`);
    return body.data.ticket;
  }

  async #connect(name: string): Promise<void> {
    const generation = ++this.#generation;
    try {
      const ticket = await this.#ticket();
      if (generation !== this.#generation) return;
      const url = new URL("/relay", this.#deps.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      this.#open(this.#deps.createSocket(url.href), generation, name);
    } catch (e) {
      if (generation !== this.#generation) return;
      this.#fail(e instanceof Failure ? e : new Failure("error", e instanceof Error ? e.message : String(e)));
    }
  }

  #fail(f: Failure): void {
    this.#teardownSocketOnly();
    this.#set({
      phase: f.phase,
      ...(f.phase === "error" ? { problem: f.detail } : {}),
      ...(f.retryMs === undefined ? {} : { until: Date.now() + f.retryMs }),
    });
    if (f.phase === "offline" || f.phase === "disabled") this.#retryLater(IDLE_RETRY_MS);
    if (f.phase === "limited") this.#retryLater(f.retryMs ?? LIMITED_RETRY_MS);
  }

  #teardownSocketOnly(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#session = null;
    this.#control = false;
    this.#mux.disconnect();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  #open(socket: WebSocket, generation: number, name: string): void {
    this.#socket = socket;
    this.#sid = ""; // every socket is a new relay session: the previous sid made a reconnect ignore the relay's "open"
    this.#seq = 0;
    this.#control = false;
    this.#needsConfirm = false;
    this.#probedPin = null;
    this.#trusted = null;
    this.#inbound = Promise.resolve();
    this.#outbound = Promise.resolve();
    this.#mux = new RelayMux((m) => this.#fromMux(m));
    const session = new BrowserSession({ store: this.#store, name });
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
    let answer: string | undefined;
    for (const event of step.events) {
      if (event.type === "challenged") answer = this.#challenged(event.pin);
      else this.#event(event);
    }
    if (generation !== this.#generation) return;
    for (const record of step.outgoing) this.#sendRecord(record);
    const session = this.#session;
    if (answer !== undefined && session) await this.#apply(await session.answer(answer), generation);
  }

  /**
   * The device answered the first-connection request with its key. Returns the password to answer with, or undefined when
   * the page has to show something first (this socket is then dropped: no state is kept on the wire).
   */
  #challenged(pin: string): string | undefined {
    const password = this.#pendingPassword;
    const trusted = this.#trustedPin();
    if (trusted === pin && password !== undefined) {
      this.#trusted = pin;
      return password;
    }
    this.#teardown();
    this.#pendingPassword = undefined; // never answer for a key the user has not confirmed, nor keep the password past that
    if (trusted === pin) return void this.#set({ phase: "password" });
    this.#probedPin = pin;
    // A key other than the one confirmed a moment ago is a changed device, not a new one.
    if (trusted !== null) this.#confirmed = null;
    this.#set({ phase: trusted !== null ? "changed" : "fingerprint", emoji: marksOf(pin) });
    return undefined;
  }

  #sendRecord(payload: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ v: 1, type: "data", sid: this.#sid, seq: this.#seq++, payload: toBase64(payload) }));
  }

  #event(e: WireEvent): void {
    switch (e.type) {
      case "pinned":
        this.#needsConfirm = this.#trusted !== e.pin;
        this.#state = { ...this.#state, emoji: marksOf(e.pin) };
        return;
      case "pin_mismatch":
        this.#teardownSocketOnly();
        this.#set({ phase: "changed", emoji: marksOf(e.received) });
        return;
      case "authenticated":
        this.#pendingPassword = undefined;
        this.#confirmed = null;
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
    this.#pendingPassword = undefined;
    this.#teardownSocketOnly();
    if (code === "bad_password") this.#set({ phase: "password", problem: t("connect.password.wrong") });
    else if (code === "device_outdated") this.#set({ phase: "error", problem: t("connect.error.outdated") });
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
