// The login page's state machine over a fake local host (cgsconnect/local-channel.md §6.1, §8): device login progress,
// cancel, the register form and code screen, and the error codes that decide which screen comes back.
import { expect, test } from "vitest";
import { createLoginFlow, type LoginHost, type LoginView } from "../../src/desktop/login-flow";

class FakeHost {
  readonly calls: { method: string; params?: unknown }[] = [];
  readonly replies = new Map<string, (params?: unknown) => Promise<unknown>>();
  readonly #listeners = new Set<(name: string, data: unknown) => void>();

  readonly host: LoginHost = {
    call: <T>(method: string, params?: unknown): Promise<T> => {
      this.calls.push({ method, params });
      const reply = this.replies.get(method);
      return (reply ? reply(params) : Promise.resolve(undefined)) as Promise<T>;
    },
    onEvent: (callback) => {
      this.#listeners.add(callback);
      return () => this.#listeners.delete(callback);
    },
  };

  emit(name: string, data: unknown): void {
    for (const callback of [...this.#listeners]) callback(name, data);
  }

  login(event: unknown): void {
    this.emit("login", event);
  }
}

function setup(options: { now?: () => number } = {}) {
  const fake = new FakeHost();
  const flow = createLoginFlow(fake.host, options);
  const stop = flow.attach();
  return { fake, flow, stop };
}

const expectView = (flow: { getState(): LoginView }, view: Partial<LoginView>) => expect(flow.getState()).toMatchObject(view);

test("browser login: progress, waiting link and done all come from the sidecar's events", async () => {
  const { fake, flow } = setup();
  await flow.startLogin();
  expect(fake.calls).toEqual([{ method: "login.start", params: undefined }]);
  expectView(flow, { screen: "progress", flow: "login", step: "creating" });

  fake.login({ phase: "solving" });
  expectView(flow, { screen: "progress", step: "solving" });
  fake.login({ phase: "waiting", verificationUrl: "https://cgs.example/login?uuid=u1", expiresAt: 1000 });
  expectView(flow, { screen: "waiting", verificationUrl: "https://cgs.example/login?uuid=u1", expiresAt: 1000 });
  fake.login({ phase: "done", username: "alice", tier: "pro" });
  expectView(flow, { screen: "done", flow: "login", username: "alice", tier: "pro" });
});

test("a rejected login.start and a failed event both land on the error screen with the code", async () => {
  const { fake, flow } = setup();
  fake.replies.set("login.start", () => Promise.reject(new Error("link_down")));
  await flow.startLogin();
  expectView(flow, { screen: "error", flow: "login", error: "link_down" });

  flow.reset();
  fake.replies.delete("login.start");
  await flow.startLogin();
  fake.login({ phase: "failed", error: { code: "denied", message: "denied" } });
  expectView(flow, { screen: "error", error: "denied" });
});

test("cancel returns to the first screen and ignores the sidecar's cancelled failure", async () => {
  const { fake, flow } = setup();
  await flow.startLogin();
  fake.login({ phase: "waiting", verificationUrl: "https://cgs.example/x", expiresAt: Date.now() + 60_000 });

  await flow.cancelLogin();
  expectView(flow, { screen: "idle", flow: "login" });
  expect(fake.calls.at(-1)).toEqual({ method: "login.cancel", params: undefined });
  fake.login({ phase: "failed", error: { code: "cancelled", message: "cancelled" } });
  expectView(flow, { screen: "idle" });
  expect(flow.getState().error).toBeUndefined();
});

test("a cancelled failure while still waiting also returns to the first screen", async () => {
  const { fake, flow } = setup();
  await flow.startLogin();
  fake.login({ phase: "failed", error: { code: "cancelled", message: "cancelled" } });
  expectView(flow, { screen: "idle" });
});

test("login events do not touch the registration form", async () => {
  const { fake, flow } = setup();
  flow.showRegister();
  fake.login({ phase: "waiting", verificationUrl: "https://cgs.example/x", expiresAt: 1 });
  expectView(flow, { screen: "register", flow: "register" });
});

test("register: requestCode moves to the code screen with its session and timers", async () => {
  const { fake, flow } = setup({ now: () => 1_000 });
  fake.replies.set("register.requestCode", () => Promise.resolve({ sessionId: "r1", expiresAt: 601_000, resendAt: 61_000 }));
  await flow.requestCode(" new@example.com ");
  expect(fake.calls.at(-1)).toEqual({ method: "register.requestCode", params: { email: "new@example.com" } });
  expectView(flow, { screen: "verify", flow: "register", email: "new@example.com", sessionId: "r1", expiresAt: 601_000, resendAt: 61_000 });
});

test("cancel leaves the registration flow alone (its call cannot be aborted)", async () => {
  const { fake, flow } = setup();
  const gate = Promise.withResolvers<unknown>();
  fake.replies.set("register.requestCode", () => gate.promise);
  const pending = flow.requestCode("a@example.com");
  expectView(flow, { screen: "progress", flow: "register" });

  await flow.cancelLogin();
  expectView(flow, { screen: "progress", flow: "register" });
  expect(fake.calls.some((call) => call.method === "login.cancel")).toBe(false);

  gate.resolve({ sessionId: "r1", expiresAt: 1, resendAt: 2 });
  await pending;
  expectView(flow, { screen: "verify", flow: "register" });
});

test("register: a server code returns to the form, and a malformed answer is bad_response", async () => {
  const { fake, flow } = setup();
  fake.replies.set("register.requestCode", () => Promise.reject(new Error("email_taken")));
  await flow.requestCode("old@example.com");
  expectView(flow, { screen: "register", flow: "register", email: "old@example.com", error: "email_taken" });

  fake.replies.set("register.requestCode", () => Promise.resolve({ sessionId: "" }));
  await flow.requestCode("new@example.com");
  expectView(flow, { screen: "register", error: "bad_response" });
});

test("resending waits for the server's cooldown", async () => {
  let now = 10_000;
  const { fake, flow } = setup({ now: () => now });
  fake.replies.set("register.requestCode", () => Promise.resolve({ sessionId: "r1", expiresAt: now + 600_000, resendAt: now + 60_000 }));
  await flow.requestCode("a@example.com");
  const before = fake.calls.length;

  await flow.resendCode();
  expect(fake.calls.length).toBe(before);
  now += 60_000;
  await flow.resendCode();
  expect(fake.calls.at(-1)).toEqual({ method: "register.requestCode", params: { email: "a@example.com" } });
});

test("completing registration: done on success, the code screen on a wrong code, the form on a spent session", async () => {
  const { fake, flow } = setup();
  fake.replies.set("register.requestCode", () => Promise.resolve({ sessionId: "r1", expiresAt: 1, resendAt: 2 }));
  await flow.requestCode("a@example.com");

  fake.replies.set("register.complete", () => Promise.resolve({ username: "newbie", tier: "free" }));
  await flow.completeRegistration("123456", "long-enough");
  expect(fake.calls.at(-1)).toEqual({ method: "register.complete", params: { sessionId: "r1", code: "123456", password: "long-enough" } });
  expectView(flow, { screen: "done", flow: "register", username: "newbie", tier: "free" });

  flow.backToRegister();
  await flow.requestCode("a@example.com");
  fake.replies.set("register.complete", () => Promise.reject(new Error("code_invalid")));
  await flow.completeRegistration("000000", "long-enough");
  expectView(flow, { screen: "verify", sessionId: "r1", error: "code_invalid" });

  fake.replies.set("register.complete", () => Promise.reject(new Error("too_many_attempts")));
  await flow.completeRegistration("000000", "long-enough");
  expectView(flow, { screen: "register", flow: "register", error: "too_many_attempts" });
});

test("an account created without a local sign-in shows the error screen", async () => {
  const { fake, flow } = setup();
  fake.replies.set("register.requestCode", () => Promise.resolve({ sessionId: "r1", expiresAt: 1, resendAt: 2 }));
  await flow.requestCode("a@example.com");
  fake.replies.set("register.complete", () => Promise.reject(new Error("account_created")));
  await flow.completeRegistration("123456", "long-enough");
  expectView(flow, { screen: "error", flow: "register", error: "account_created" });
});

test("subscribers hear every change, and detaching stops the event feed", async () => {
  const { fake, flow, stop } = setup();
  let changes = 0;
  const unsubscribe = flow.subscribe(() => changes++);
  await flow.startLogin();
  expect(changes).toBeGreaterThan(0);

  stop();
  const seen = changes;
  fake.login({ phase: "done", username: "late" });
  expect(changes).toBe(seen);
  unsubscribe();
});
