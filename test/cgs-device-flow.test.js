"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const { runDeviceFlow, pollOnce, CgsError } = require("../src/cgs/device-flow");
const { completeLogin } = require("../src/cgs/config-writer");
const { requestJson, proxyFor } = require("../src/cgs/http");

const ok = data => ({ success: true, message: "", data });
const { osVersion } = require("../src/cgs/client-info");
const KEY = `cgc_${"k".repeat(48)}`;

/** Fake new-api device endpoints. `script.poll` is a list of poll results consumed in order. */
async function fakeServer(script = {}) {
  const log = { create: null, nonce: null, polls: 0, pollTokens: [], models: 0, auth: null };
  const prefix = crypto.randomBytes(8).toString("hex");
  const difficulty = script.difficulty ?? 8;
  const pollQueue = [...(script.poll ?? [])];
  let approvedDelivered = false;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const send = (obj, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(obj));
      };
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && req.url === "/api/device/sessions") {
        if (script.createStatus) return send({ success: false, message: "x" }, script.createStatus);
        log.create = body;
        return send(ok({ session_id: "sess-1", challenge: { algorithm: "sha256", prefix, difficulty }, expires_in: 120 }));
      }
      if (req.method === "POST" && req.url === "/api/device/sessions/sess-1/challenge") {
        log.nonce = body.nonce;
        if (script.rejectChallenge) return send({ success: false, message: "challenge failed" });
        const d = crypto.createHash("sha256").update(`${prefix}:${body.nonce}`).digest();
        const zeros = [...d].map(b => b.toString(2).padStart(8, "0")).join("").match(/^0*/)[0].length;
        if (zeros < difficulty) return send({ success: false, message: "wrong nonce" });
        return send(ok({ uuid: "11111111-2222-4333-8444-555555555555", poll_token: "p".repeat(43), expires_at: script.expiresAt ?? Math.floor(Date.now() / 1000) + 900, verification_url: "https://api.example.com/login?uuid=11111111-2222-4333-8444-555555555555" }));
      }
      if (req.method === "POST" && req.url === "/api/device/sessions/11111111-2222-4333-8444-555555555555/poll") {
        log.polls++;
        log.pollTokens.push(body.poll_token);
        if (script.pollStatus) return send({ success: false, message: "x" }, script.pollStatus);
        const next = pollQueue.shift() ?? { status: approvedDelivered ? "expired" : "pending" };
        if (next.status === "approved") approvedDelivered = true;
        return send(ok(next));
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        log.models++;
        log.auth = req.headers.authorization;
        if (req.headers.authorization !== `Bearer ${KEY}`) return send({ error: "unauthorized" }, 401);
        return send({ object: "list", data: [{ id: "claude-sonnet-5-5" }, { id: "gemini-3.8-flash" }, { id: "claude-sonnet-5-5" }, { id: "deepseek-v4.1-flash" }] });
      }
      send({ success: false, message: "not found" }, 404);
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise(r => server.close(r)) };
}

const flow = (srv, extra = {}) => runDeviceFlow({ baseUrl: srv.baseUrl, appVersion: "9.9.9", pollIntervalMs: 15, ...extra });

test("pending → approved: key delivered once, then the session reads as expired", async () => {
  const srv = await fakeServer({ poll: [{ status: "pending" }, { status: "pending" }, { status: "approved", client_secret: KEY, tier: "pro", username: "alice" }] });
  try {
    const phases = [];
    const result = await flow(srv, { onProgress: p => phases.push(p) });
    assert.deepEqual(result, { clientSecret: KEY, tier: "pro", username: "alice" });
    assert.equal(srv.log.polls, 3);
    assert.ok(srv.log.pollTokens.every(t => t === "p".repeat(43)));
    assert.deepEqual(phases.map(p => p.phase), ["creating", "solving", "waiting"]);
    // The server names its own public address (api.example.com); the link opens on the host the desktop is configured for.
    assert.equal(phases[2].verificationUrl, `${srv.baseUrl}/login?uuid=11111111-2222-4333-8444-555555555555`);
    assert.ok(phases[2].expiresAt > Date.now());
    assert.deepEqual(srv.log.create, { device_name: os.hostname().slice(0, 64), platform: osVersion(), app_version: "9.9.9" });
    assert.match(srv.log.nonce, /^\d+$/);

    const again = await pollOnce({ baseUrl: srv.baseUrl, uuid: "11111111-2222-4333-8444-555555555555", pollToken: "p".repeat(43) });
    assert.deepEqual(again, { status: "expired" });
  } finally {
    await srv.close();
  }
});

test("denied → typed Chinese error", async () => {
  const srv = await fakeServer({ poll: [{ status: "pending" }, { status: "denied" }] });
  try {
    await assert.rejects(flow(srv), err => {
      assert.ok(err instanceof CgsError);
      assert.equal(err.code, "denied");
      assert.match(err.userMessage, /拒绝/);
      return true;
    });
  } finally {
    await srv.close();
  }
});

test("expired status and local expiry → typed Chinese error", async () => {
  let srv = await fakeServer({ poll: [{ status: "expired" }] });
  try {
    await assert.rejects(flow(srv), err => err.code === "expired" && /过期/.test(err.userMessage));
  } finally {
    await srv.close();
  }
  srv = await fakeServer({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
  try {
    await assert.rejects(flow(srv), err => err.code === "expired");
    assert.equal(srv.log.polls, 0);
  } finally {
    await srv.close();
  }
});

test("server rejecting the challenge, rate limiting, 5xx and unreachable server map to typed errors", async () => {
  let srv = await fakeServer({ rejectChallenge: true });
  try {
    await assert.rejects(flow(srv), err => err.code === "challenge_failed" && /安全校验/.test(err.userMessage));
  } finally {
    await srv.close();
  }
  srv = await fakeServer({ createStatus: 429 });
  try {
    await assert.rejects(flow(srv), err => err.code === "rate_limited" && /频繁/.test(err.userMessage));
  } finally {
    await srv.close();
  }
  srv = await fakeServer({ createStatus: 503 });
  try {
    await assert.rejects(flow(srv), err => err.code === "server" && /503/.test(err.userMessage));
  } finally {
    await srv.close();
  }
  const dead = await fakeServer();
  const baseUrl = dead.baseUrl;
  await dead.close();
  await assert.rejects(runDeviceFlow({ baseUrl, pollIntervalMs: 15 }), err => err.code === "network" && /网络/.test(err.userMessage));
});

test("transient poll failures are tolerated, persistent ones surface", async () => {
  const srv = await fakeServer({ pollStatus: 502 });
  try {
    await assert.rejects(flow(srv), err => err.code === "server");
    assert.equal(srv.log.polls, 5);
  } finally {
    await srv.close();
  }
});

test("abort while waiting stops polling and rejects with code aborted", async () => {
  const srv = await fakeServer();
  try {
    const controller = new AbortController();
    const waiting = new Promise(resolve => {
      flow(srv, { signal: controller.signal, onProgress: p => p.phase === "waiting" && resolve() }).then(
        () => assert.fail("should not resolve"),
        err => {
          assert.equal(err.code, "aborted");
          return err;
        },
      ).then(r => (srv.settled = r));
    });
    await waiting;
    await new Promise(r => setTimeout(r, 60));
    controller.abort();
    await new Promise(r => setTimeout(r, 40));
    const polls = srv.log.polls;
    await new Promise(r => setTimeout(r, 80));
    assert.equal(srv.log.polls, polls, "no polls after abort");
    assert.equal(srv.settled.code, "aborted");
  } finally {
    await srv.close();
  }
});

test("completeLogin fetches /v1/models with the key and writes credentials", async () => {
  const srv = await fakeServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-login-"));
  try {
    const rec = await completeLogin({ agentDir: dir, baseUrl: srv.baseUrl, clientSecret: KEY, tier: "go", username: "bob" });
    assert.equal(srv.log.auth, `Bearer ${KEY}`);
    assert.deepEqual(rec.models, ["claude-sonnet-5-5", "deepseek-v4.1-flash", "gemini-3.8-flash"]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "cgs", "credentials.json"), "utf8"));
    assert.equal(saved.clientSecret, KEY);
    assert.equal(saved.baseUrl, srv.baseUrl);
    // this server has no /api/device/layout: the login still succeeds, config.yml is left for a later retry
    assert.equal(fs.existsSync(path.join(dir, "config.yml")), false);

    // a bad key changes nothing and reports a typed error
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-login-"));
    await assert.rejects(completeLogin({ agentDir: dir2, baseUrl: srv.baseUrl, clientSecret: "cgc_bad", tier: "free", username: "x" }), err => err.code === "models");
    assert.deepEqual(fs.readdirSync(dir2), []);
  } finally {
    await srv.close();
  }
});

test("proxy selection honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY", () => {
  const env = { HTTPS_PROXY: "http://proxy.local:8080", NO_PROXY: "internal.example.com,.corp" };
  assert.equal(proxyFor("https://api.cicori.com/x", env).href, "http://proxy.local:8080/");
  assert.equal(proxyFor("https://api.internal.example.com/x", env), null);
  assert.equal(proxyFor("https://a.corp/x", env), null);
  assert.equal(proxyFor("http://api.cicori.com/x", env), null); // only HTTPS_PROXY set
  assert.equal(proxyFor("https://127.0.0.1:9/x", env), null);
  assert.equal(proxyFor("https://api.cicori.com", {}), null);
  assert.equal(proxyFor("https://api.cicori.com", { https_proxy: "10.0.0.1:3128" }).host, "10.0.0.1:3128");
});

test("requests go through the configured proxy (CONNECT for https, absolute URI for http)", async () => {
  const seen = { connect: null, absolute: null };
  const proxy = http.createServer((req, res) => {
    seen.absolute = req.url;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data: { via: "proxy" } }));
  });
  proxy.on("connect", (req, socket) => {
    seen.connect = req.url;
    socket.destroy();
  });
  await new Promise(r => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const viaHttp = await requestJson({ url: "http://api.cicori.invalid/api/ping", env: { HTTP_PROXY: proxyUrl } });
    assert.equal(seen.absolute, "http://api.cicori.invalid/api/ping");
    assert.deepEqual(viaHttp.json.data, { via: "proxy" });

    await assert.rejects(requestJson({ url: "https://api.cicori.invalid/v1/models", env: { HTTPS_PROXY: proxyUrl }, timeoutMs: 2000 }));
    assert.equal(seen.connect, "api.cicori.invalid:443");
  } finally {
    proxy.close();
  }
});
