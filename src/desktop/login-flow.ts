// The login page's state machine (ADR 0046 §4): browser device login (progress -> waiting -> done) and email
// registration (form -> verify -> done), plus cancel and the error screens. Kept out of the component so tests drive it
// with a fake `host.call`/`host.onEvent`.
import type { DesktopHost } from "./protocol";

export type LoginScreen = "idle" | "progress" | "waiting" | "register" | "verify" | "done" | "error";
export type LoginFlowName = "login" | "register";
export type LoginStep = "creating" | "solving" | "sending" | "registering";

export interface LoginView {
  screen: LoginScreen;
  /** Which flow the screen belongs to: a stray event of the other one is ignored. */
  flow: LoginFlowName;
  /** The current step while `screen === "progress"`. */
  step?: LoginStep;
  verificationUrl?: string;
  /** Unix milliseconds. */
  expiresAt?: number;
  email?: string;
  sessionId?: string;
  /** Unix milliseconds; resending before it is refused. */
  resendAt?: number;
  username?: string;
  tier?: string;
  /** Stable error code (`cgsconnect/local-channel.md` §6.1) of the last failure. */
  error?: string;
}

/** What the page needs from the preload link. */
export type LoginHost = Pick<DesktopHost, "call" | "onEvent">;

export interface LoginFlowOptions {
  now?: () => number;
}

/** Codes after which the registration session is gone: the form, not the code screen, is the way back. */
const RESTART_CODES: Record<string, true> = { too_many_attempts: true, session_expired: true, challenge_failed: true, registration_closed: true };

const CODE = /^[a-z][a-z0-9_.-]*$/;

/** A `host.call` rejection carries the sidecar's stable code as its message (desktop/preload.cjs). */
function codeOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return CODE.test(text) ? text : "call_failed";
}

interface RegisterCodeReply {
  sessionId: string;
  expiresAt: number;
  resendAt: number;
}

function isRegisterCodeReply(value: unknown): value is RegisterCodeReply {
  if (!value || typeof value !== "object") return false;
  const reply = value as Record<string, unknown>;
  return typeof reply.sessionId === "string" && reply.sessionId !== "" && Number.isFinite(reply.expiresAt) && Number.isFinite(reply.resendAt);
}

const idle: LoginView = { screen: "idle", flow: "login" };

export class LoginFlow {
  readonly #host: LoginHost;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #view: LoginView = idle;
  #unsubscribe: (() => void) | null = null;

  constructor(host: LoginHost, options: LoginFlowOptions = {}) {
    this.#host = host;
    this.#now = options.now ?? Date.now;
  }

  /** Subscribes to the sidecar's `login` events; returns the way to stop. Idempotent, so a re-rendered page keeps one. */
  attach(): () => void {
    if (this.#unsubscribe) return this.#unsubscribe;
    const stop = this.#host.onEvent((name, data) => {
      if (name === "login") this.#onEvent(data);
    });
    this.#unsubscribe = () => {
      stop();
      this.#unsubscribe = null;
    };
    return this.#unsubscribe;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getState = (): LoginView => this.#view;

  reset(): void {
    this.#set(idle);
  }

  /** Drops the last error while staying on its screen: the user started correcting the input. */
  clearError(): void {
    if (this.#view.error === undefined) return;
    const next: LoginView = { ...this.#view };
    delete next.error;
    this.#set(next);
  }

  /** Starts the browser flow; `login.start` answers at once, so the call settles long before the approval. */
  async startLogin(): Promise<void> {
    this.#set({ screen: "progress", flow: "login", step: "creating" });
    try {
      await this.#host.call("login.start");
    } catch (error) {
      this.#set({ screen: "error", flow: "login", error: codeOf(error) });
    }
  }

  /** Aborts the running flow; the page returns to the first screen and ignores the sidecar's `cancelled` failure. */
  async cancelLogin(): Promise<void> {
    if (this.#view.flow !== "login" || (this.#view.screen !== "progress" && this.#view.screen !== "waiting")) return;
    this.#set(idle);
    try {
      await this.#host.call("login.cancel");
    } catch {
      // Closing the page is the visible outcome; a lost link needs no message of its own.
    }
  }

  showRegister(): void {
    this.#set({ screen: "register", flow: "register", ...(this.#view.email ? { email: this.#view.email } : {}) });
  }

  backToIdle(): void {
    this.#set(idle);
  }

  /** From the verify screen: the email can be corrected, which needs a new code anyway. */
  backToRegister(): void {
    this.#set({ screen: "register", flow: "register", ...(this.#view.email ? { email: this.#view.email } : {}) });
  }

  /** Asks for a code (first send and resend alike): a new register session each time, as the server consumes one per mail. */
  async requestCode(email: string): Promise<void> {
    const address = email.trim();
    this.#set({ screen: "progress", flow: "register", step: "creating", email: address });
    try {
      const reply = await this.#host.call("register.requestCode", { email: address });
      if (!isRegisterCodeReply(reply)) throw new Error("bad_response");
      this.#set({ screen: "verify", flow: "register", email: address, sessionId: reply.sessionId, expiresAt: reply.expiresAt, resendAt: reply.resendAt });
    } catch (error) {
      this.#set({ screen: "register", flow: "register", email: address, error: codeOf(error) });
    }
  }

  /** Sends again from the verify screen, not before the server's cooldown has passed. */
  async resendCode(): Promise<void> {
    const view = this.#view;
    if (view.screen !== "verify" || !view.email) return;
    if (view.resendAt !== undefined && this.#now() < view.resendAt) return;
    await this.requestCode(view.email);
  }

  /** Submits the mailed code and the password; success writes the account on the sidecar (`state` turns ready). */
  async completeRegistration(code: string, password: string): Promise<void> {
    const view = this.#view;
    if (view.screen !== "verify" || !view.email || !view.sessionId) return;
    const sessionId = view.sessionId;
    this.#set({ screen: "progress", flow: "register", step: "registering", email: view.email, sessionId, ...pickTimers(view) });
    try {
      const reply = await this.#host.call<{ username?: string; tier?: string }>("register.complete", { sessionId, code, password });
      this.#set({
        screen: "done",
        flow: "register",
        ...(typeof reply?.username === "string" && reply.username ? { username: reply.username } : {}),
        ...(typeof reply?.tier === "string" && reply.tier ? { tier: reply.tier } : {}),
      });
    } catch (error) {
      const codeName = codeOf(error);
      if (codeName === "account_created") this.#set({ screen: "error", flow: "register", error: codeName });
      else if (Object.hasOwn(RESTART_CODES, codeName)) this.#set({ screen: "register", flow: "register", email: view.email, error: codeName });
      else this.#set({ screen: "verify", flow: "register", email: view.email, sessionId, ...pickTimers(view), error: codeName });
    }
  }

  #onEvent(data: unknown): void {
    // Only the browser flow's screens consume these; a message left over from it must not hijack the register form.
    if (this.#view.flow !== "login") return;
    const event = (data ?? {}) as { phase?: unknown; verificationUrl?: unknown; expiresAt?: unknown; username?: unknown; tier?: unknown; error?: { code?: unknown } };
    switch (event.phase) {
      case "creating":
      case "solving":
        this.#set({ screen: "progress", flow: "login", step: event.phase });
        return;
      case "waiting":
        if (typeof event.verificationUrl !== "string" || !event.verificationUrl) return;
        this.#set({ screen: "waiting", flow: "login", verificationUrl: event.verificationUrl, ...(typeof event.expiresAt === "number" ? { expiresAt: event.expiresAt } : {}) });
        return;
      case "done":
        this.#set({
          screen: "done",
          flow: "login",
          ...(typeof event.username === "string" && event.username ? { username: event.username } : {}),
          ...(typeof event.tier === "string" && event.tier ? { tier: event.tier } : {}),
        });
        return;
      case "failed": {
        const code = typeof event.error?.code === "string" ? event.error.code : "internal";
        if (code === "cancelled") {
          // The cancel button already moved the page; a flow that finished anyway keeps its own outcome.
          if (this.#view.screen === "progress" || this.#view.screen === "waiting") this.#set(idle);
          return;
        }
        this.#set({ screen: "error", flow: "login", error: code });
        return;
      }
      default:
        return;
    }
  }

  #set(view: LoginView): void {
    this.#view = view;
    for (const listener of this.#listeners) listener();
  }
}

/** Keeps the code lifetime across the registering/progress screens so a retry can still show it. */
function pickTimers(view: LoginView): { expiresAt?: number; resendAt?: number } {
  return {
    ...(view.expiresAt !== undefined ? { expiresAt: view.expiresAt } : {}),
    ...(view.resendAt !== undefined ? { resendAt: view.resendAt } : {}),
  };
}

export function createLoginFlow(host: LoginHost, options: LoginFlowOptions = {}): LoginFlow {
  return new LoginFlow(host, options);
}
