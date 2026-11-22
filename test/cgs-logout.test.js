"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const cw = require("../src/cgs/config-writer");
const { readState } = require("../src/cgs/state");
const { revokeDeviceClient, consoleUrl } = require("../src/cgs/account");
const { CgsController } = require("../src/cgs/controller");

const PLUGIN_DIR = path.join(__dirname, "..", "plugin", "omp-cgs");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cgs-logout-"));
const exists = (dir, ...p) => fs.existsSync(path.join(dir, ...p));
const parsed = (dir, f = "config.yml") => YAML.parse(fs.readFileSync(path.join(dir, f), "utf8"));

/** A server answering POST /api/device/logout with `status`; resolves { baseUrl, calls, close }. */
async function fakeServer(status) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { success: true, data: { revoked: true } } : { success: false, message: "x" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

async function signedInDir(baseUrl) {
  const dir = tmpDir();
  await cw.writeCredentials(dir, { baseUrl, clientSecret: "cgc_test", tier: "pro", username: "alice", models: ["claude-sonnet-5-5", "gemini-4-argon"] });
  await cw.applyDefaultRoles(dir);
  fs.writeFileSync(
    path.join(dir, "models.yml"),
    "providers:\n  my-own:\n    baseUrl: http://localhost:1\n  cgs-openai:\n    baseUrl: x\n  cgs-anthropic:\n    baseUrl: x\n  cgs-gemini:\n    baseUrl: x\n",
  );
  return dir;
}

test("logout removes CGS roles and providers, keeps what the user changed", async () => {
  const dir = await signedInDir("http://127.0.0.1:1");
  // The user repoints default and adds their own web fallback next to the CGS one.
  const cfg = parsed(dir);
  cfg.modelRoles.default = "anthropic/claude-opus-5";
  cfg.retry.fallbackChains.web.push("other/web-model");
  cfg.modelRoles.plan = "cgs-openai/not-managed-by-defaults";
  fs.writeFileSync(path.join(dir, "config.yml"), YAML.stringify(cfg));

  const result = await cw.signOutLocally(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.removedProviders.sort(), ["cgs-anthropic", "cgs-gemini", "cgs-openai"]);

  assert.equal(exists(dir, "cgs", "credentials.json"), false);
  const after = parsed(dir);
  assert.equal(after.modelRoles.default, "anthropic/claude-opus-5"); // user's value stays
  assert.equal(after.modelRoles.task, undefined); // still pointed at cgs-*: gone
  assert.equal(after.modelRoles.web, undefined);
  assert.equal(after.task, undefined); // reviewer and scout overrides pointed at cgs-*: gone, and the empty container with them
  assert.deepEqual(after.retry.fallbackChains.web, ["other/web-model"]);
  assert.equal(after.modelRoles.plan, "cgs-openai/not-managed-by-defaults"); // not something applyDefaultRoles writes
  const models = parsed(dir, "models.yml");
  assert.deepEqual(Object.keys(models.providers), ["my-own"]);
  assert.deepEqual(await readState(dir), { defaultsApplied: false, lastKnownTier: null });
});

test("logout of a pure-CGS config leaves no empty containers and resets the applied defaults", async () => {
  const dir = await signedInDir("http://127.0.0.1:1");
  await cw.signOutLocally(dir);
  assert.deepEqual(parsed(dir) ?? {}, {});
  assert.equal((await readState(dir)).defaultsApplied, false); // the next login applies the defaults again
});

test("logout without credentials, models.yml or config.yml still succeeds", async () => {
  const dir = tmpDir();
  const result = await cw.signOutLocally(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.removedRoles, []);
});

test("models.yml mtime is bumped so ompweb reloads its model list", async () => {
  const dir = await signedInDir("http://127.0.0.1:1");
  const file = path.join(dir, "models.yml");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  await cw.notifyModelsChanged(dir);
  assert.ok(fs.statSync(file).mtimeMs > old.getTime() + 30_000);
});

test("server 200 and 401 both count as revoked", async () => {
  for (const [status, expected] of [[200, "revoked"], [401, "already-revoked"]]) {
    const server = await fakeServer(status);
    try {
      const result = await revokeDeviceClient({ baseUrl: server.baseUrl, clientSecret: "cgc_abc" });
      assert.equal(result.status, expected);
      assert.deepEqual(server.calls, [{ method: "POST", url: "/api/device/logout", auth: "Bearer cgc_abc" }]);
    } finally {
      await server.close();
    }
  }
});

test("controller.logout: server 401 is a clean logout", async () => {
  const server = await fakeServer(401);
  const dir = await signedInDir(server.baseUrl);
  const ctl = new CgsController({ agentDir: dir, pluginDir: PLUGIN_DIR, refresh: async () => ({ status: "ok", tier: "pro", username: "alice" }) });
  try {
    assert.equal((await ctl.snapshot()).signedIn, true);
    const events = [];
    ctl.on("change", snap => events.push(snap));
    const result = await ctl.logout();
    assert.equal(result.serverRevoked, true);
    assert.equal(server.calls.length, 1);
    assert.equal(exists(dir, "cgs", "credentials.json"), false);
    const snap = await ctl.snapshot();
    assert.equal(snap.signedIn, false);
    assert.equal(snap.keyRejected, false);
    assert.equal(snap.username, null);
    assert.deepEqual(snap.providers, []);
    assert.equal(events.at(-1).signedIn, false);
    assert.equal(ctl.usageSnapshot().usage, null);
  } finally {
    ctl.stop?.();
    await server.close();
  }
});

test("controller.logout: network failure and 5xx still sign out locally and flag it", async () => {
  const failing = await fakeServer(500);
  const dead = await fakeServer(200);
  const deadUrl = dead.baseUrl;
  await dead.close(); // nothing listens there any more
  try {
    for (const baseUrl of [failing.baseUrl, deadUrl]) {
      const dir = await signedInDir(baseUrl);
      const ctl = new CgsController({ agentDir: dir, refresh: async () => ({ status: "ok", tier: "pro", username: "alice" }) });
      const result = await ctl.logout();
      assert.equal(result.serverRevoked, false, baseUrl);
      assert.equal(exists(dir, "cgs", "credentials.json"), false);
      assert.equal((await ctl.snapshot()).signedIn, false);
      assert.deepEqual(Object.keys(parsed(dir, "models.yml").providers), ["my-own"]);
      ctl.stop?.();
    }
  } finally {
    await failing.close();
  }
});

test("console URL is the dashboard route of the account's server", () => {
  assert.equal(consoleUrl("https://api.cicori.com/"), "https://api.cicori.com/dashboard");
});
