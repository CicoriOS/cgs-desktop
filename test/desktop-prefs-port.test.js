"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PrefsStore, PREF_KEY_PATTERN, isPrefKey } = require("../src/main/prefs");
const { choosePort, DEFAULT_PORT } = require("../src/main/services");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cgs-main-"));

function occupy(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

// ---- prefs mirror -------------------------------------------------------------------------------------------------

test("prefs key rule: omp-* except drafts; and it matches the preload's copy", () => {
  for (const key of ["omp-lang", "omp-theme", "omp-font-size", "omp-ui-scale", "omp-web:provider-usage-window", "omp-sound-enabled"]) {
    assert.ok(isPrefKey(key), key);
  }
  for (const key of ["omp-draft-abc", "omp-uploads-draft-abc", "theme", "x-omp-lang", "", null, 5]) assert.ok(!isPrefKey(key), String(key));
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main-preload.js"), "utf8");
  const declared = preload.match(/const PREF_KEY_PATTERN = (\/.*\/);/);
  assert.ok(declared, "preload declares PREF_KEY_PATTERN");
  assert.equal(declared[1], String(PREF_KEY_PATTERN));
});

test("PrefsStore: no file → null; deltas persist and survive a new instance", () => {
  const file = path.join(tmp(), "nested", "web-prefs.json");
  const store = new PrefsStore(file);
  assert.equal(store.load(), null);
  store.apply({ set: {}, remove: [] });
  assert.equal(fs.existsSync(file), false, "an empty delta does not create the file");

  store.apply({ set: { "omp-lang": "zh-CN", "omp-theme": "dark" }, remove: [] });
  store.apply({ set: { "omp-theme": "light" }, remove: ["omp-lang"] });
  assert.deepEqual(store.load(), { "omp-theme": "light" });
  assert.deepEqual(new PrefsStore(file).load(), { "omp-theme": "light" });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("PrefsStore: an emptied file stays authoritative (loads {}), not null", () => {
  const file = path.join(tmp(), "web-prefs.json");
  const store = new PrefsStore(file);
  store.apply({ set: { "omp-lang": "ja" }, remove: [] });
  store.apply({ set: {}, remove: ["omp-lang"] });
  assert.deepEqual(new PrefsStore(file).load(), {});
});

test("PrefsStore ignores foreign keys, non-string values and malformed deltas; load() returns a copy", () => {
  const file = path.join(tmp(), "web-prefs.json");
  const store = new PrefsStore(file);
  store.apply({ set: { "omp-lang": "en", other: "x", "omp-draft-1": "d", "omp-theme": 5, "omp-big": "x".repeat(200_000) }, remove: ["other", 7] });
  store.apply(null);
  store.apply({ set: null, remove: "nope" });
  assert.deepEqual(store.load(), { "omp-lang": "en" });
  store.load()["omp-lang"] = "changed";
  assert.deepEqual(store.load(), { "omp-lang": "en" });
});

test("PrefsStore: a corrupt or foreign file is treated as absent; stored foreign keys are dropped", () => {
  const dir = tmp();
  const corrupt = path.join(dir, "a.json");
  fs.writeFileSync(corrupt, "{nope");
  assert.equal(new PrefsStore(corrupt).load(), null);
  const arr = path.join(dir, "b.json");
  fs.writeFileSync(arr, "[1]");
  assert.equal(new PrefsStore(arr).load(), null);
  const mixed = path.join(dir, "c.json");
  fs.writeFileSync(mixed, JSON.stringify({ "omp-lang": "zh-CN", evil: "1", "omp-draft-x": "2" }));
  assert.deepEqual(new PrefsStore(mixed).load(), { "omp-lang": "zh-CN" });
});

// ---- stable port --------------------------------------------------------------------------------------------------

test("choosePort: first launch takes the preferred port and stores it; later launches reuse it", async () => {
  const blocker = await occupy();
  const preferred = blocker.port;
  await blocker.close();
  const file = path.join(tmp(), "sub", "ompweb-port.json");
  assert.equal(await choosePort(file, preferred), preferred);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: preferred });
  assert.equal(await choosePort(file, 1), preferred, "the stored port wins over the preferred one");
});

test("choosePort: first launch with the preferred port taken picks a random free port and stores that", async () => {
  const blocker = await occupy();
  try {
    const file = path.join(tmp(), "ompweb-port.json");
    const port = await choosePort(file, blocker.port);
    assert.notEqual(port, blocker.port);
    assert.ok(port >= 1024 && port <= 65535);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port });
  } finally {
    await blocker.close();
  }
});

test("choosePort: a busy stored port falls back for this launch only and is kept for the next", async () => {
  const blocker = await occupy();
  const file = path.join(tmp(), "ompweb-port.json");
  fs.writeFileSync(file, JSON.stringify({ port: blocker.port }));
  const fallback = await choosePort(file);
  assert.notEqual(fallback, blocker.port);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: blocker.port });
  await blocker.close();
  assert.equal(await choosePort(file), blocker.port, "the stable origin comes back once the port is free");
});

test("choosePort ignores an invalid stored port and the default is a high port", async () => {
  assert.ok(DEFAULT_PORT >= 1024);
  const file = path.join(tmp(), "ompweb-port.json");
  fs.writeFileSync(file, JSON.stringify({ port: "abc" }));
  const blocker = await occupy();
  const preferred = blocker.port;
  await blocker.close();
  assert.equal(await choosePort(file, preferred), preferred);
});
