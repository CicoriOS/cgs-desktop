"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { requestRegisterCode, completeRegister } = require("../src/cgs/register-flow");
const { CgsError } = require("../src/cgs/device-flow");

const ok = data => ({ success: true, message: "", data });
const fail = (code, message = "server text") => ({ success: false, message, code });
const KEY = `cgc_${"r".repeat(48)}`;

/** Fake new-api registration endpoints; `script` overrides what the code / complete steps answer. */
async function fakeServer(script = {}) {
  const log = { create: null, code: null, complete: null };
  const prefix = crypto.randomBytes(8).toString("hex");
  const difficulty = script.difficulty ?? 8;
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
      if (req.method === "POST" && req.url === "/api/device/register/sessions") {
        log.create = body;
        if (script.create) return send(script.create);
        return send(ok({ session_id: "reg-1", challenge: { algorithm: "sha256", prefix, difficulty }, expires_in: 120 }));
      }
      if (req.method === "POST" && req.url === "/api/device/register/sessions/reg-1/code") {
        log.code = body;
        const d = crypto.createHash("sha256").update(`${prefix}:${body.nonce}`).digest();
        const zeros = [...d].map(b => b.toString(2).padStart(8, "0")).join("").match(/^0*/)[0].length;
        if (zeros < difficulty) return send(fail("challenge_failed"));
        if (script.code) return send(script.code);
        return send(ok({ session_id: "reg-1", expires_in: 600, resend_in: 60 }));
      }
      if (req.method === "POST" && req.url === "/api/device/register/sessions/reg-1/complete") {
        log.complete = body;
        if (script.complete) return send(script.complete);
        return send(ok({ client_secret: KEY, tier: "free", username: "alice_1a2b3c" }));
      }
      send({ success: false, message: "not found" }, 404);
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise(r => server.close(r)) };
}

async function withServer(script, fn) {
  const srv = await fakeServer(script);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

test("code request solves the proof of work and names the email", () =>
  withServer({}, async srv => {
    const phases = [];
    const before = Date.now();
    const res = await requestRegisterCode({ baseUrl: srv.baseUrl, email: "a@example.com", appVersion: "9.9.9", deviceName: "PC", platform: "Windows 11", onProgress: p => phases.push(p.phase) });
    assert.deepEqual(phases, ["creating", "solving", "sending"]);
    assert.deepEqual(srv.log.create, { device_name: "PC", platform: "Windows 11", app_version: "9.9.9" });
    assert.equal(srv.log.code.email, "a@example.com");
    assert.match(srv.log.code.nonce, /^\d+$/);
    assert.equal(res.sessionId, "reg-1");
    assert.ok(res.expiresAt >= before + 600_000 && res.resendAt >= before + 60_000 && res.resendAt < res.expiresAt);
  }));

test("completing returns the client credential, the code and password reach the server", () =>
  withServer({}, async srv => {
    const result = await completeRegister({ baseUrl: srv.baseUrl, sessionId: "reg-1", code: "123456", password: "correct-horse" });
    assert.deepEqual(result, { clientSecret: KEY, tier: "free", username: "alice_1a2b3c" });
    assert.deepEqual(srv.log.complete, { code: "123456", password: "correct-horse" });
  }));

test("server error codes become messages; only unrecoverable ones ask to start over", async () => {
  const cases = [
    [{ code: fail("email_taken") }, "email_taken", /已被注册/, false],
    [{ code: fail("cooldown") }, "cooldown", /稍后/, false],
    [{ code: fail("registration_closed") }, "registration_closed", /关闭注册/, true],
  ];
  for (const [script, code, message, restart] of cases) {
    await withServer(script, async srv => {
      await assert.rejects(requestRegisterCode({ baseUrl: srv.baseUrl, email: "a@example.com" }), err => {
        assert.ok(err instanceof CgsError);
        assert.equal(err.code, code);
        assert.match(err.userMessage, message);
        assert.equal(err.restart, restart);
        return true;
      });
    });
  }
  await withServer({ complete: fail("code_invalid") }, srv =>
    assert.rejects(completeRegister({ baseUrl: srv.baseUrl, sessionId: "reg-1", code: "000000", password: "correct-horse" }), err => err.code === "code_invalid" && err.restart === false),
  );
  await withServer({ complete: fail("too_many_attempts") }, srv =>
    assert.rejects(completeRegister({ baseUrl: srv.baseUrl, sessionId: "reg-1", code: "000000", password: "correct-horse" }), err => err.code === "too_many_attempts" && err.restart === true),
  );
});

test("a rejection without a code and a malformed challenge are reported, not swallowed", async () => {
  await withServer({ create: { success: false, message: "nope" } }, srv =>
    assert.rejects(requestRegisterCode({ baseUrl: srv.baseUrl, email: "a@example.com" }), err => err.code === "rejected"),
  );
  await withServer({ create: ok({ session_id: "reg-1", challenge: { prefix: 5 } }) }, srv =>
    assert.rejects(requestRegisterCode({ baseUrl: srv.baseUrl, email: "a@example.com" }), err => err.code === "bad_response"),
  );
});

test("aborting stops the request", () =>
  withServer({}, async srv => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(requestRegisterCode({ baseUrl: srv.baseUrl, email: "a@example.com", signal: controller.signal }), err => err.code === "aborted");
  }));
