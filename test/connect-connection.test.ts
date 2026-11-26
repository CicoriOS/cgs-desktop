import { IDBFactory } from "fake-indexeddb";
import { addBrowser, createDeviceCredentials, createPasswordVerifier, DeviceSession, fromBase64, toBase64, type DeviceCredentials, type WireMessage } from "@cgs/wire";
import { afterEach, expect, test, vi } from "vitest";
import { RelayConnection, type Phase, type RelayDeps } from "../src/connect/connection";

vi.setConfig({ testTimeout: 30_000 });

const PASSWORD = "correct horse battery";
const SID = "sid-1";

/** The device end of one relay session, built on the same wire library the daemon uses. */
class FakeDevice {
  readonly seen: WireMessage[] = [];
  session: DeviceSession;
  constructor(public credentials: DeviceCredentials, private readonly out: (payload: Uint8Array) => void, private readonly onFrame: (m: WireMessage, d: FakeDevice) => void, private readonly greeting: WireMessage) {
    this.session = new DeviceSession({ credentials: this.credentials });
  }
  async receive(payload: Uint8Array): Promise<void> {
    const step = await this.session.receive(payload);
    for (const e of step.events) {
      if (e.type === "registered") this.credentials = addBrowser(this.credentials, e.browser);
      if (e.type === "message") {
        this.seen.push(e.message);
        this.onFrame(e.message, this);
      }
    }
    for (const o of step.outgoing) this.out(o);
    if (step.events.some((e) => e.type === "authenticated")) await this.say(this.greeting);
  }
  async say(m: WireMessage): Promise<void> {
    for (const o of await this.session.send(m)) this.out(o);
  }
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string, private readonly toDevice: (text: string) => void) {}
  send(text: string) {
    this.sent.push(text);
    this.toDevice(text);
  }
  close() {
    this.readyState = 3;
  }
  deliver(env: unknown) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

interface World {
  idb: IDBFactory;
  credentials: DeviceCredentials;
  sockets: FakeSocket[];
  devices: FakeDevice[];
  refreshStatus: number;
  ticketStatus: number;
  onFrame: (m: WireMessage, d: FakeDevice) => void;
  /** What the device says once a browser is authenticated: control, or busy. */
  greeting: WireMessage;
}

const open: RelayConnection[] = [];
afterEach(() => open.splice(0).forEach((c) => c.close()));

async function world(): Promise<World> {
  return { idb: new IDBFactory(), credentials: createDeviceCredentials(await createPasswordVerifier(PASSWORD)), sockets: [], devices: [], refreshStatus: 200, ticketStatus: 200, onFrame: () => {}, greeting: { k: "hello", proto: 1 } };
}

function connect(w: World, device = "7"): RelayConnection {
  let seq = 0;
  const deps: RelayDeps = {
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (url.endsWith("/auth/refresh")) return w.refreshStatus === 200 ? json(200, { success: true, data: { access_token: "tok" } }) : json(w.refreshStatus, { success: false });
      if (!url.endsWith("/api/remote/ticket")) return json(404, { error: "Invalid URL" });
      return w.ticketStatus === 200 ? json(200, { success: true, data: { ticket: "T" } }) : json(w.ticketStatus, { success: false });
    }) as typeof fetch,
    createSocket: (url) => {
      let socket!: FakeSocket;
      const device = new FakeDevice(
        w.credentials,
        (payload) => queueMicrotask(() => socket.deliver({ v: 1, type: "data", sid: SID, seq: seq++, payload: toBase64(payload) })),
        (m, d) => w.onFrame(m, d),
        w.greeting,
      );
      let chain = Promise.resolve();
      socket = new FakeSocket(url, (text) => {
        const env = JSON.parse(text) as { payload: string };
        chain = chain.then(() => device.receive(fromBase64(env.payload))).then(() => void (w.credentials = device.credentials));
      });
      w.sockets.push(socket);
      w.devices.push(device);
      queueMicrotask(() => socket.deliver({ v: 1, type: "ctl", sid: SID, seq: seq++, payload: { op: "open" } }));
      return socket as unknown as WebSocket;
    },
    idb: w.idb,
    origin: new URL("https://cgs.example/connect/?device=" + device),
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0",
    setTimeout: (fn) => setTimeout(fn, 5),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const c = new RelayConnection(device, deps);
  open.push(c);
  return c;
}

async function until(c: RelayConnection, phase: Phase): Promise<void> {
  const deadline = Date.now() + 8000;
  while (c.getSnapshot().phase !== phase) {
    if (Date.now() > deadline) throw new Error(`stuck in ${c.getSnapshot().phase}, wanted ${phase}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("first connection: password, fingerprint to confirm, then the host API works end to end", async () => {
  const w = await world();
  w.onFrame = (m, d) => {
    if (m.k === "req") void d.say({ k: "res", id: m.id, status: m.method === "POST" ? 201 : 200, body: { cwd: "/w", device: "box" } });
  };
  const c = connect(w);
  await c.start();
  expect(c.getSnapshot().phase).toBe("password");
  expect(c.getSnapshot().name).toBe("Chrome on Linux");
  expect(w.sockets).toHaveLength(0);

  c.password(PASSWORD);
  await until(c, "fingerprint");
  expect(c.getSnapshot().emoji).toHaveLength(12);
  expect(w.sockets[0]!.url).toBe("wss://cgs.example/relay?ticket=T");
  c.confirm();
  await until(c, "ready");

  await expect(c.host.info()).resolves.toEqual({ cwd: "/w", device: "box" });
  expect(w.devices[0]!.seen.find((m) => m.k === "req")).toMatchObject({ method: "GET", path: "/api/info" });
  // A POST whose optional field is undefined (the page's own openChild) must reach the device as plain JSON.
  await expect(c.host.openChild("/w")).resolves.toMatchObject({ cwd: "/w" });
  expect(w.devices[0]!.seen.findLast((m) => m.k === "req")).toMatchObject({ method: "POST", path: "/api/children", body: { cwd: "/w" } });
  expect(w.credentials.browsers.map((b) => b.name)).toEqual(["Chrome on Linux"]);
});

test("a wrong password asks again and does not save a key", async () => {
  const w = await world();
  const c = connect(w);
  await c.start();
  c.password("not the password");
  await until(c, "password");
  expect(c.getSnapshot().problem).toBeTruthy();
  expect(w.credentials.browsers).toEqual([]);
});

test("a saved key resumes without a password and without a fingerprint step", async () => {
  const w = await world();
  const first = connect(w);
  await first.start();
  first.password(PASSWORD);
  await until(first, "fingerprint");
  first.confirm();
  await until(first, "ready");
  first.close();

  const again = connect(w);
  await again.start();
  await until(again, "ready");
  expect(again.getSnapshot().emoji).toHaveLength(12);
});

test("a device whose key changed is refused until the user confirms and signs in again", async () => {
  const w = await world();
  const first = connect(w);
  await first.start();
  first.password(PASSWORD);
  await until(first, "fingerprint");
  first.confirm();
  await until(first, "ready");
  first.close();

  w.credentials = createDeviceCredentials(await createPasswordVerifier(PASSWORD));
  const again = connect(w);
  await again.start();
  await until(again, "changed");
  again.confirm();
  await until(again, "password");
});

test("without a console login the page asks to sign in; without the entitlement it says so", async () => {
  const w = await world();
  w.refreshStatus = 401;
  const c = connect(w);
  await c.start();
  c.password(PASSWORD);
  await until(c, "login");

  const v = await world();
  v.ticketStatus = 403;
  const d = connect(v);
  await d.start();
  d.password(PASSWORD);
  await until(d, "forbidden");
});

test("a child stream is opened at the path naming its child, which is how the device finds it", async () => {
  const w = await world();
  const c = connect(w);
  await c.start();
  c.password(PASSWORD);
  await until(c, "fingerprint");
  c.confirm();
  await until(c, "ready");

  c.transport("child 1");
  await vi.waitFor(() => expect(w.devices[0]!.seen.find((m) => m.k === "open")).toMatchObject({ cid: "child 1", path: "/ws?child=child%201" }));
});

test("a rate-limited sign-in says so with the time it ends and retries by itself", async () => {
  const w = await world();
  w.refreshStatus = 429;
  const c = connect(w);
  await c.start();
  c.password(PASSWORD);
  await until(c, "limited");
  expect(c.getSnapshot().until).toBeGreaterThan(Date.now());
  w.refreshStatus = 200;
  await until(c, "password");
});

test("when another browser holds control the page says so, takes over on request, and goes read-only when taken over", async () => {
  const w = await world();
  w.greeting = { k: "busy", by: "Phone" };
  w.onFrame = (m, d) => {
    if (m.k === "takeover") void d.say({ k: "hello", proto: 1 });
  };
  const c = connect(w);
  await c.start();
  c.password(PASSWORD);
  await until(c, "busy");
  expect(c.getSnapshot().by).toBe("Phone");
  c.takeover();
  await until(c, "fingerprint");
  c.confirm();
  await until(c, "ready");

  void w.devices[0]!.say({ k: "taken_over", by: "Phone" });
  await until(c, "readonly");
  expect(c.getSnapshot().by).toBe("Phone");
  await expect(c.host.info()).rejects.toThrow();
});

test("relay close codes map to pages: device offline keeps retrying", async () => {
  const w = await world();
  const c = connect(w);
  await c.start();
  c.password(PASSWORD);
  await until(c, "fingerprint");
  c.confirm();
  await until(c, "ready");
  w.sockets[0]!.drop(4410);
  await until(c, "offline");
  expect(c.getSnapshot().emoji).toHaveLength(12);
});
