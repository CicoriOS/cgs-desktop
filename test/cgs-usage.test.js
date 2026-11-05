"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fetchUsage, refreshUsage, normalizeUsage } = require("../src/cgs/usage");
const { CgsController } = require("../src/cgs/controller");
const { writeCredentials } = require("../src/cgs/config-writer");

const KEY = `sk-${"k".repeat(48)}`;

const SERVER_PAYLOAD = {
  tier: "pro",
  username: "alice",
  balance: { quota: 99995000, used_quota: 5000, display: "$199.99" },
  subscriptions: [
    {
      id: 7,
      plan_id: 3,
      plan_title: "Pro",
      amount_total: 50000000,
      amount_used: 1200000,
      amount_total_display: "$100.00",
      amount_used_display: "$2.40",
      reset_period: "monthly",
      next_reset_at: 1793900000,
      start_time: 1793000000,
      end_time: 1795600000,
      daily_token_limits: [{ model: "deepseek-v4.1-flash", limit: 100000000, used: 1234, reset_at: 1793923200 }],
    },
    { id: 8, plan_id: 4, plan_title: "Unlimited", amount_total: 0, amount_used: 5, amount_total_display: "", amount_used_display: "$0.01", reset_period: "never", next_reset_at: 0, start_time: 1, end_time: 0, daily_token_limits: [] },
  ],
  generated_at: 1793871500,
};

async function usageServer(handler) {
  const seen = { auth: null, url: null };
  const server = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    seen.url = req.url;
    const reply = handler(req);
    res.statusCode = reply.status ?? 200;
    res.setHeader("Content-Type", "application/json");
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("normalizeUsage maps the server payload to camelCase with every field present", () => {
  const usage = normalizeUsage(SERVER_PAYLOAD);
  assert.equal(usage.tier, "pro");
  assert.equal(usage.username, "alice");
  assert.deepEqual(usage.balance, { quota: 99995000, usedQuota: 5000, display: "$199.99" });
  assert.equal(usage.generatedAt, 1793871500);
  const [limited, unlimited] = usage.subscriptions;
  assert.equal(limited.planTitle, "Pro");
  assert.equal(limited.unlimited, false);
  assert.equal(limited.totalDisplay, "$100.00");
  assert.equal(limited.resetPeriod, "monthly");
  assert.deepEqual(limited.dailyTokenLimits, [{ model: "deepseek-v4.1-flash", limit: 100000000, used: 1234, resetAt: 1793923200 }]);
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.totalDisplay, "");
  assert.deepEqual(unlimited.dailyTokenLimits, []);
});

test("normalizeUsage tolerates missing and malformed fields", () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage("x"), null);
  const usage = normalizeUsage({ tier: "gold", balance: null, subscriptions: [null, { reset_period: "weird", daily_token_limits: [{ limit: 5 }, null] }] });
  assert.equal(usage.tier, null);
  assert.equal(usage.username, null);
  assert.deepEqual(usage.balance, { quota: 0, usedQuota: 0, display: "" });
  assert.equal(usage.subscriptions.length, 2);
  assert.equal(usage.subscriptions[1].resetPeriod, "never");
  assert.deepEqual(usage.subscriptions[1].dailyTokenLimits, []);
  assert.deepEqual(normalizeUsage({}).subscriptions, []);
});

test("fetchUsage sends the Bearer key to /api/device/usage and normalizes the reply", async () => {
  const server = await usageServer(() => ({ body: { success: true, message: "", data: SERVER_PAYLOAD } }));
  try {
    const result = await fetchUsage({ baseUrl: `${server.baseUrl}/`, apiKey: KEY });
    assert.equal(result.status, "ok");
    assert.equal(result.usage.balance.display, "$199.99");
    assert.equal(server.seen.url, "/api/device/usage");
    assert.equal(server.seen.auth, `Bearer ${KEY}`);
  } finally {
    await server.close();
  }
});

test("fetchUsage: 401 is unauthorized; 5xx, bad bodies and success:false are errors", async () => {
  const cases = [
    [{ status: 401, body: { success: false, message: "bad key" } }, "unauthorized"],
    [{ status: 500, body: { success: false } }, "error"],
    [{ status: 200, body: "not json" }, "error"],
    [{ status: 200, body: { success: false, message: "no" } }, "error"],
    [{ status: 200, body: { success: true, data: null } }, "error"],
  ];
  for (const [reply, expected] of cases) {
    const server = await usageServer(() => reply);
    try {
      assert.equal((await fetchUsage({ baseUrl: server.baseUrl, apiKey: KEY })).status, expected, JSON.stringify(reply));
    } finally {
      await server.close();
    }
  }
});

test("fetchUsage: a refused connection is an error, not a rejection", async () => {
  const server = await usageServer(() => ({ body: {} }));
  const { baseUrl } = server;
  await server.close();
  assert.deepEqual(await fetchUsage({ baseUrl, apiKey: KEY }), { status: "error" });
});

test("refreshUsage: signed-out without credentials, otherwise uses the saved key and base URL", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-usage-"));
  const server = await usageServer(() => ({ body: { success: true, data: SERVER_PAYLOAD } }));
  try {
    assert.deepEqual(await refreshUsage(agentDir), { status: "signed-out" });
    await writeCredentials(agentDir, { baseUrl: server.baseUrl, apiKey: KEY, tier: "pro", username: "alice", models: [], linkedAt: new Date().toISOString() });
    const result = await refreshUsage(agentDir);
    assert.equal(result.status, "ok");
    assert.equal(server.seen.auth, `Bearer ${KEY}`);
  } finally {
    await server.close();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ---- controller ---------------------------------------------------------------------------------------------------

function makeController(results, extra = {}) {
  const queue = [...results];
  const calls = [];
  const controller = new CgsController({
    agentDir: fs.mkdtempSync(path.join(os.tmpdir(), "cgs-usage-ctl-")),
    refresh: async () => ({ status: "ok", tier: "pro", username: "alice" }),
    fetchUsage: async () => {
      calls.push(Date.now());
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    ...extra,
  });
  const events = [];
  controller.on("usage", (snap) => events.push(["usage", snap]));
  controller.on("change", (snap) => events.push(["change", snap]));
  return { controller, calls, events };
}

const OK = { status: "ok", usage: normalizeUsage(SERVER_PAYLOAD) };

test("controller.refreshUsage stores the usage and emits it", async () => {
  const { controller, events } = makeController([OK]);
  assert.deepEqual(controller.usageSnapshot(), { usage: null, stale: false, fetchedAt: 0 });
  const snap = await controller.refreshUsage();
  assert.equal(snap.usage.balance.display, "$199.99");
  assert.equal(snap.stale, false);
  assert.ok(snap.fetchedAt > 0);
  assert.deepEqual(events.map(([name]) => name), ["usage"]);
});

test("controller keeps the last usage and marks it stale after a network error, then recovers", async () => {
  const { controller } = makeController([OK, { status: "error" }, OK]);
  await controller.refreshUsage();
  const stale = await controller.refreshUsage();
  assert.equal(stale.stale, true);
  assert.equal(stale.usage.balance.display, "$199.99");
  assert.equal((await controller.refreshUsage()).stale, false);
});

test("controller: a thrown fetch counts as an error; before any success nothing is shown and nothing is stale", async () => {
  const { controller } = makeController([new Error("boom")]);
  assert.deepEqual({ ...(await controller.refreshUsage()), fetchedAt: 0 }, { usage: null, stale: false, fetchedAt: 0 });
});

test("controller: 401 behaves like signed-out (usage dropped, polling stopped, change emitted, no more requests)", async () => {
  const { controller, calls, events } = makeController([OK, { status: "unauthorized" }]);
  controller.start();
  await controller.refreshUsage();
  const snap = await controller.refreshUsage();
  assert.deepEqual(snap.usage, null);
  const change = events.filter(([name]) => name === "change").at(-1);
  assert.ok(change, "a change event follows the 401 so the UI signs out");
  assert.equal(change[1].signedIn, false);
  const before = calls.length;
  await controller.refreshUsage();
  assert.equal(calls.length, before, "revoked: no more usage requests");
  assert.equal(controller._usageTimer, null);
  controller.stop();
});

test("controller: a new login clears the old account's usage and fetches again", async () => {
  const { controller, calls } = makeController([OK]);
  await controller.refreshUsage();
  const before = calls.length;
  const login = controller.onLogin();
  assert.equal(controller.usageSnapshot().usage, null);
  await login;
  await controller._usageInflight;
  assert.ok(calls.length > before);
  controller.stop();
});

test("controller.refreshUsage coalesces concurrent calls and throttles with minAgeMs", async () => {
  const { controller, calls } = makeController([OK]);
  await Promise.all([controller.refreshUsage(), controller.refreshUsage(), controller.refreshUsage()]);
  assert.equal(calls.length, 1);
  await controller.refreshUsage({ minAgeMs: 60_000 });
  assert.equal(calls.length, 1, "a focus refresh right after a fetch is skipped");
  await controller.refreshUsage();
  assert.equal(calls.length, 2, "a manual refresh always fetches");
});

test("controller polls usage on its own interval until stopped", async () => {
  const { controller, calls } = makeController([OK], { usageIntervalMs: 15, intervalMs: 60_000 });
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.stop();
  const seen = calls.length;
  assert.ok(seen >= 3, `expected several polls, got ${seen}`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, seen, "no polls after stop()");
});
