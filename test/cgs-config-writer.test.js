"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const cw = require("../src/cgs/config-writer");
const cgs = require("../src/cgs");
const { readState } = require("../src/cgs/state");
const { refreshTier } = require("../src/cgs/tier");
const { CgsController } = require("../src/cgs/controller");

const PLUGIN_SRC = path.join(__dirname, "..", "plugin", "omp-cgs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cgs-cw-"));
}
const read = (dir, f = "config.yml") => fs.readFileSync(path.join(dir, f), "utf8");
const parsed = dir => YAML.parse(read(dir));

test("index exports the contract interface", () => {
  for (const key of ["CGS_BASE_URL", "prepareAgentDir", "getLoginState", "needsStartupLogin", "CgsController", "TIER_IDS", "TIER_NAMES"]) {
    assert.ok(key in cgs, `missing export ${key}`);
  }
  assert.equal(cgs.CGS_BASE_URL, process.env.CGS_BASE_URL || "https://ai.tmp.cnklp.cn");
});

const WEB = "cgs-antigravity/gemini-3.8-flash";

// GET /api/device/layout `data`, as the server sends it.
const SERVER_LAYOUT = {
  orchestrator: { model: "cgs-claude/claude-haiku-5-5", thinking: "off" },
  agents: [
    { name: "task", model: "cgs-openai/deepseek-v4.1-flash", thinking: "max" },
    { name: "sonic", model: "cgs-claude/claude-haiku-5-5", thinking: "max" },
    { name: "reviewer", model: "cgs-codex/gpt-6-astra", thinking: "max" },
  ],
  web_model: WEB,
};
const LAYOUT = cw.normalizeLayout(SERVER_LAYOUT);

const EXPECTED_DEFAULTS = {
  modelRoles: { default: "cgs-claude/claude-haiku-5-5:off", web: WEB },
  task: {
    agentModelOverrides: {
      task: "cgs-openai/deepseek-v4.1-flash:max",
      sonic: "cgs-claude/claude-haiku-5-5:max",
      reviewer: "cgs-codex/gpt-6-astra:max",
    },
  },
  retry: { fallbackChains: { web: [WEB] } },
};

test("normalizeLayout accepts the server layout and rejects unusable ones", () => {
  assert.deepEqual(LAYOUT, {
    orchestrator: { model: "cgs-claude/claude-haiku-5-5", thinking: "off" },
    agents: SERVER_LAYOUT.agents,
    webModel: WEB,
  });
  assert.equal(cw.normalizeLayout(null), null);
  assert.equal(cw.normalizeLayout({ agents: [] }), null); // no orchestrator model
  assert.equal(cw.normalizeLayout({ ...SERVER_LAYOUT, orchestrator: { model: "a/b", thinking: "huge" } }), null);
  assert.equal(cw.normalizeLayout({ ...SERVER_LAYOUT, agents: [{ name: "../x", model: "a/b" }] }), null);
  assert.equal(cw.normalizeLayout({ ...SERVER_LAYOUT, agents: [{ name: "x", model: "a/b" }, { name: "x", model: "a/c" }] }), null);
});

test("default layout: written and recorded as applied", async () => {
  const dir = tmpDir();
  await cw.applyDefaultLayout(dir, LAYOUT);
  assert.deepEqual(parsed(dir), EXPECTED_DEFAULTS);
  assert.equal((await readState(dir)).defaultsApplied, true);
});

test("default layout replaces a stale web chain and keeps other retry settings, chains, overrides and comments", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "config.yml"),
    [
      "# my personal omp config",
      "modelRoles:",
      "  plan: anthropic/claude-opus-5-5:xhigh # keep me",
      "retry:",
      "  maxRetries: 7",
      "  fallbackChains:",
      "    web: [anthropic/claude-haiku-4-5]",
      "    default: [a/b]",
      "task:",
      "  enableLsp: true",
      "  agentModelOverrides:",
      "    explore: x/y # keep explore",
      "    sonic: old/sonic",
      "",
    ].join("\n"),
  );
  await cw.applyDefaultLayout(dir, LAYOUT);
  const text = read(dir);
  assert.match(text, /# my personal omp config/);
  assert.match(text, /plan: anthropic\/claude-opus-5-5:xhigh # keep me/);
  assert.match(text, /explore: x\/y # keep explore/);
  const cfg = YAML.parse(text);
  assert.deepEqual(cfg.retry.fallbackChains, { web: [WEB], default: ["a/b"] });
  assert.equal(cfg.retry.maxRetries, 7);
  assert.equal(cfg.task.enableLsp, true);
  assert.equal(cfg.task.agentModelOverrides.sonic, "cgs-claude/claude-haiku-5-5:max");
  assert.equal(cfg.task.agentModelOverrides.explore, "x/y");
});

test("invalid YAML is never overwritten", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.yml"), "a: [unterminated\n");
  await assert.rejects(cw.applyDefaultLayout(dir, LAYOUT), /not valid YAML/);
  assert.equal(read(dir), "a: [unterminated\n");
});

test("orchestration: read, edit, add and remove roles, keep unrelated config", async () => {
  const dir = tmpDir();
  await cw.applyDefaultLayout(dir, LAYOUT);
  fs.appendFileSync(path.join(dir, "config.yml"), "theme:\n  dark: titanium # mine\n");
  const current = await cw.readOrchestration(dir);
  assert.deepEqual(current, { orchestrator: LAYOUT.orchestrator, agents: LAYOUT.agents });

  // task follows the agent default (no override), reviewer drops its level, a new role is added, sonic is removed
  const next = {
    orchestrator: { model: "cgs-claude/claude-sonnet-5-5", thinking: "high" },
    agents: [
      { name: "task", model: "", thinking: "max" },
      { name: "reviewer", model: "cgs-codex/gpt-6-astra", thinking: "" },
      { name: "scout", model: "cgs-claude/claude-haiku-5-5", thinking: "low" },
    ],
  };
  const stored = await cw.writeOrchestration(dir, next);
  assert.deepEqual(stored.agents.map(a => a.name), ["reviewer", "scout"]);
  const cfg = parsed(dir);
  assert.equal(cfg.modelRoles.default, "cgs-claude/claude-sonnet-5-5:high");
  assert.deepEqual(cfg.task.agentModelOverrides, { reviewer: "cgs-codex/gpt-6-astra", scout: "cgs-claude/claude-haiku-5-5:low" });
  assert.equal(cfg.modelRoles.web, WEB);
  assert.match(read(dir), /dark: titanium # mine/);

  // removing every agent drops the empty override map
  await cw.writeOrchestration(dir, { orchestrator: next.orchestrator, agents: [] });
  assert.equal(parsed(dir).task, undefined);

  await assert.rejects(cw.writeOrchestration(dir, { orchestrator: { model: "" }, agents: [] }), /model is required/);
  await assert.rejects(cw.writeOrchestration(dir, { orchestrator: next.orchestrator, agents: [{ name: "a b", model: "x/y" }] }), /Invalid agent name/);
  await assert.rejects(cw.writeOrchestration(dir, { orchestrator: { model: "x/y", thinking: "huge" }, agents: [] }), /thinking level/);
});

test("prepareAgentDir writes defaults only if absent and leaves user values alone", async () => {
  const dir = path.join(tmpDir(), "nested", "agent");
  await cgs.prepareAgentDir(dir, { pluginSourceDir: PLUGIN_SRC });
  assert.deepEqual(parsed(dir), {
    computer: { enabled: true },
    lsp: { enabled: true },
    task: { enableLsp: true },
    defaultThinkingLevel: "auto",
    edit: { modelVariants: { claude: "replace", gpt: "apply_patch" } },
  });

  fs.writeFileSync(
    path.join(dir, "config.yml"),
    "defaultThinkingLevel: high # mine\ncomputer:\n  enabled: false\nlsp:\n  other: 1\n",
  );
  await cgs.prepareAgentDir(dir, { pluginSourceDir: PLUGIN_SRC });
  const text = read(dir);
  assert.match(text, /defaultThinkingLevel: high # mine/);
  assert.deepEqual(YAML.parse(text), {
    defaultThinkingLevel: "high",
    computer: { enabled: false },
    lsp: { other: 1, enabled: true },
    edit: { modelVariants: { claude: "replace", gpt: "apply_patch" } },
    task: { enableLsp: true },
  });
});

test("prepareAgentDir installs the extension and refreshes it when the bundle changes", async () => {
  const src = tmpDir();
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "omp-cgs", version: "1.0.0" }));
  fs.writeFileSync(path.join(src, "index.js"), "export default () => {};\n");
  const agent = tmpDir();
  const dest = path.join(agent, "extensions", "cgs");

  await cgs.prepareAgentDir(agent, { pluginSourceDir: src });
  assert.equal(fs.readFileSync(path.join(dest, "index.js"), "utf8"), "export default () => {};\n");

  // unchanged bundle: not rewritten
  fs.writeFileSync(path.join(dest, "index.js"), "// local edit\n");
  assert.equal((await cw.installPlugin(agent, src)).installed, false);
  assert.equal(fs.readFileSync(path.join(dest, "index.js"), "utf8"), "// local edit\n");

  // bundled version changes: refreshed, stale files removed
  fs.writeFileSync(path.join(dest, "stale.js"), "x");
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "omp-cgs", version: "1.0.1" }));
  fs.writeFileSync(path.join(src, "index.js"), "export default () => 2;\n");
  const r = await cw.installPlugin(agent, src);
  assert.deepEqual(r, { installed: true, version: "1.0.1" });
  assert.equal(fs.readFileSync(path.join(dest, "index.js"), "utf8"), "export default () => 2;\n");
  assert.equal(fs.existsSync(path.join(dest, "stale.js")), false);
});

test("the real bundled plugin installs with its manifest", async () => {
  const agent = tmpDir();
  await cgs.prepareAgentDir(agent, { pluginSourceDir: PLUGIN_SRC });
  const pkg = JSON.parse(fs.readFileSync(path.join(agent, "extensions", "cgs", "package.json"), "utf8"));
  assert.deepEqual(pkg.omp.extensions, ["./index.js"]);
  assert.ok(fs.existsSync(path.join(agent, "extensions", "cgs", "index.js")));
});

test("credentials.json is written 0600 and getLoginState reads it; a pre-client apiKey record is signed out", async () => {
  const dir = tmpDir();
  assert.deepEqual(await cgs.getLoginState(dir), { signedIn: false, tier: null, username: null });
  await cw.writeCredentials(dir, { baseUrl: "https://x", clientSecret: "cgc_test", tier: "go", username: "bob", models: ["a"] });
  const file = path.join(dir, "cgs", "credentials.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["baseUrl", "clientSecret", "linkedAt", "models", "tier", "username"]);
  assert.ok(!Number.isNaN(Date.parse(rec.linkedAt)));
  assert.deepEqual(await cgs.getLoginState(dir), { signedIn: true, tier: "go", username: "bob" });

  fs.writeFileSync(file, "{not json");
  assert.deepEqual(await cgs.getLoginState(dir), { signedIn: false, tier: null, username: null });
  fs.writeFileSync(file, JSON.stringify({ baseUrl: "https://x", clientSecret: "" }));
  assert.equal((await cgs.getLoginState(dir)).signedIn, false);
  fs.writeFileSync(file, JSON.stringify({ baseUrl: "https://x", apiKey: `sk-${"a".repeat(48)}`, models: [] }));
  assert.equal((await cgs.getLoginState(dir)).signedIn, false);
  assert.equal(await cw.readCredentials(dir), null);
});

test("the server layout is applied once (retried by the tier poll after a failure); later logins and polls never rewrite config.yml", async () => {
  let currentTier = "free";
  let currentModels = ["deepseek-v4.1-flash"];
  let tierStatus = 200;
  let layoutStatus = 503;
  let layoutRequests = 0;
  let seen = null;
  const srv = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: currentModels.map(id => ({ id })) }));
      return;
    }
    if (req.url === "/api/device/layout") {
      layoutRequests++;
      res.statusCode = layoutStatus;
      res.end(JSON.stringify(layoutStatus === 200 ? { success: true, data: SERVER_LAYOUT } : { success: false }));
      return;
    }
    if (req.url === "/api/device/tier") {
      seen = { auth: req.headers.authorization, os: req.headers["x-client-os"], version: req.headers["x-client-version"] };
      res.statusCode = tierStatus;
      res.end(
        JSON.stringify(
          tierStatus === 200
            ? { success: true, data: { tier: currentTier, username: "alice" } }
            : { success: false, message: "unauthorized" },
        ),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  const dir = tmpDir();

  try {
    // 1. First-ever login while the layout endpoint fails: signed in, nothing written to config.yml yet.
    await cw.completeLogin({ agentDir: dir, baseUrl, clientSecret: "cgc_1", tier: "free", username: "alice" });
    assert.equal(fs.existsSync(path.join(dir, "config.yml")), false);
    assert.deepEqual(await readState(dir), { defaultsApplied: false, lastKnownTier: "free" });

    // 1b. The next tier poll fetches the layout and applies it.
    layoutStatus = 200;
    const first = new CgsController({ agentDir: dir, intervalMs: 60_000 });
    await first.refresh();
    first.stop();
    assert.deepEqual(parsed(dir), EXPECTED_DEFAULTS);
    assert.equal((await readState(dir)).defaultsApplied, true);

    // 2. The user changes the main agent; a re-login after upgrading to pro updates credentials and the tier only.
    const cfg = parsed(dir);
    cfg.modelRoles.default = "cgs-claude/claude-opus-5-5:auto";
    fs.writeFileSync(path.join(dir, "config.yml"), YAML.stringify(cfg));
    currentTier = "pro";
    currentModels = ["claude-sonnet-5-5", "gemini-4-argon"];
    await cw.completeLogin({ agentDir: dir, baseUrl, clientSecret: "cgc_2", tier: "pro", username: "alice" });
    assert.equal(parsed(dir).modelRoles.default, "cgs-claude/claude-opus-5-5:auto");
    assert.deepEqual(await readState(dir), { defaultsApplied: true, lastKnownTier: "pro" });

    // 3. A tier poll refreshes credentials + models, reports OS/app version, and leaves config.yml alone.
    currentTier = "dedicated";
    currentModels = ["claude-opus-5-5", "claude-sonnet-5-5", "deepseek-v4.1-flash", "gemini-3.8-flash"];
    const ctl = new CgsController({ agentDir: dir, intervalMs: 60_000 });
    await ctl.refresh();
    const creds = JSON.parse(fs.readFileSync(path.join(dir, "cgs", "credentials.json"), "utf8"));
    assert.equal(creds.tier, "dedicated");
    assert.equal(creds.clientSecret, "cgc_2");
    assert.ok(creds.models.includes("claude-opus-5-5"));
    assert.equal(seen.auth, "Bearer cgc_2");
    assert.equal(seen.os, require("../src/cgs/client-info").osVersion());
    assert.equal(seen.version, require("../package.json").version);
    assert.equal(parsed(dir).modelRoles.default, "cgs-claude/claude-opus-5-5:auto");
    assert.equal(layoutRequests, 2); // the failed one at login and the applied one; never again
    assert.deepEqual((await ctl.snapshot()).tier, "dedicated");

    // 4. 401 on tier poll → treated as signed out.
    tierStatus = 401;
    await ctl.refresh();
    assert.equal((await ctl.snapshot()).signedIn, false);
    ctl.stop();
  } finally {
    await new Promise(r => srv.close(r));
  }
});

test("startup login is needed until CGS is signed in; other credentials in the agent directory do not count", async () => {
  const emptyDir = tmpDir();
  assert.equal(await cgs.needsStartupLogin(emptyDir), true);

  // A third-party provider key (models.yml) or a stray agent.db is not a login.
  const otherDir = tmpDir();
  fs.writeFileSync(
    path.join(otherDir, "models.yml"),
    "providers:\n  openrouter:\n    baseUrl: https://openrouter.ai/api/v1\n    apiKey: sk-or-123\n",
  );
  fs.writeFileSync(path.join(otherDir, "agent.db"), "");
  assert.equal(await cgs.needsStartupLogin(otherDir), true);

  await cw.writeCredentials(otherDir, {
    baseUrl: "https://ai.tmp.cnklp.cn",
    clientSecret: "cgc_cgs",
    tier: "free",
    username: "u",
    models: ["deepseek-v4.1-flash"],
  });
  assert.equal(await cgs.needsStartupLogin(otherDir), false);
});
