"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const YAML = require("yaml");
const cw = require("../src/cgs/config-writer");
const cgs = require("../src/cgs");
const { readState } = require("../src/cgs/state");
const { refreshTier } = require("../src/cgs/tier");
const { CgsController } = require("../src/cgs/controller");
const { detectThirdPartyCredentials, shouldShowStartupPopup } = require("../src/cgs/credential-detect");

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

// The one default mapping: search Gemini 3.8 Flash, main agent Claude Haiku, task DeepSeek Flash 4.1, reviewer Astra,
// scout Haiku; each model on its vendor's channel.
const EXPECTED_DEFAULTS = {
  modelRoles: {
    default: "cgs-claude/claude-haiku-5-5:auto",
    task: "cgs-openai/deepseek-v4.1-flash:auto",
    web: WEB,
  },
  retry: { fallbackChains: { web: [WEB] } },
  task: { agentModelOverrides: { reviewer: "cgs-codex/gpt-6-astra:auto", scout: "cgs-claude/claude-haiku-5-5:auto" } },
};

test("default roles: the documented mapping is written and recorded as applied", async () => {
  const dir = tmpDir();
  await cw.applyDefaultRoles(dir);
  assert.deepEqual(parsed(dir), EXPECTED_DEFAULTS);
  assert.equal((await readState(dir)).defaultsApplied, true);
});

test("default roles replace a stale web chain and keep other retry settings and chains", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "config.yml"),
    ["retry:", "  maxRetries: 7", "  fallbackChains:", "    web: [anthropic/claude-haiku-4-5]", "    default: [a/b]", ""].join("\n"),
  );
  await cw.applyDefaultRoles(dir);
  const cfg = parsed(dir);
  assert.deepEqual(cfg.retry.fallbackChains.web, [WEB]);
  assert.deepEqual(cfg.retry.fallbackChains.default, ["a/b"]);
  assert.equal(cfg.retry.maxRetries, 7);
});

test("unrelated keys and comments survive applying the default roles", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "config.yml"),
    [
      "# my personal omp config",
      "theme:",
      "  dark: titanium # favourite",
      "modelRoles:",
      "  plan: anthropic/claude-opus-5-5:xhigh # keep me",
      "  web: old/web-model",
      "task:",
      "  enableLsp: true",
      "  agentModelOverrides:",
      "    explore: x/y # keep explore",
      "    scout: old/scout",
      "# trailing comment",
      "",
    ].join("\n"),
  );
  await cw.applyDefaultRoles(dir);
  const text = read(dir);
  assert.match(text, /# my personal omp config/);
  assert.match(text, /dark: titanium # favourite/);
  assert.match(text, /plan: anthropic\/claude-opus-5-5:xhigh # keep me/);
  assert.match(text, /explore: x\/y # keep explore/);
  assert.match(text, /# trailing comment/);
  const cfg = YAML.parse(text);
  assert.equal(cfg.modelRoles.web, WEB);
  assert.equal(cfg.task.agentModelOverrides.scout, "cgs-claude/claude-haiku-5-5:auto");
  assert.equal(cfg.task.agentModelOverrides.reviewer, "cgs-codex/gpt-6-astra:auto");
  assert.equal(cfg.task.agentModelOverrides.explore, "x/y");
  assert.equal(cfg.task.enableLsp, true);
  assert.equal(cfg.modelRoles.plan, "anthropic/claude-opus-5-5:xhigh");
  assert.equal(cfg.theme.dark, "titanium");
});

test("invalid YAML is never overwritten", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.yml"), "a: [unterminated\n");
  await assert.rejects(cw.applyDefaultRoles(dir), /not valid YAML/);
  assert.equal(read(dir), "a: [unterminated\n");
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

test("first login applies the default roles; later logins and tier polls never rewrite config.yml", async () => {
  let currentTier = "free";
  let currentModels = ["deepseek-v4.1-flash"];
  let tierStatus = 200;
  let seen = null;
  const srv = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: currentModels.map(id => ({ id })) }));
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
    // 1. First-ever login in this agentDir → default roles written.
    await cw.completeLogin({ agentDir: dir, baseUrl, clientSecret: "cgc_1", tier: "free", username: "alice" });
    assert.deepEqual(parsed(dir), EXPECTED_DEFAULTS);
    assert.deepEqual(await readState(dir), { defaultsApplied: true, lastKnownTier: "free" });

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

function createAgentDb(dir, rows) {
  const db = new DatabaseSync(path.join(dir, "agent.db"));
  db.exec(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL
    );
  `);
  const ins = db.prepare(
    "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) ins.run(r.provider, r.type ?? "api_key", JSON.stringify(r.data ?? { key: "k" }), r.disabled ?? null);
  db.close();
}

test("startup popup decision: shows only when neither CGS nor any third-party credential is saved", async () => {
  // (a) Empty agentDir → popup shows.
  const emptyDir = tmpDir();
  assert.deepEqual(await detectThirdPartyCredentials(emptyDir), { found: false, source: null, provider: null });
  assert.equal(await cgs.needsStartupLogin(emptyDir), true);

  // (b) Signed in to CGS → no popup.
  const cgsDir = tmpDir();
  await cw.writeCredentials(cgsDir, {
    baseUrl: "https://api.cicori.com",
    clientSecret: "cgc_cgs",
    tier: "free",
    username: "u",
    models: ["deepseek-v4.1-flash"],
  });
  assert.equal(await cgs.needsStartupLogin(cgsDir), false);

  // (c) agent.db with only disabled / CGS / MCP OAuth rows → still needs popup.
  const ignoredDbDir = tmpDir();
  createAgentDb(ignoredDbDir, [
    { provider: "anthropic", disabled: "deleted by user" },
    { provider: "cgs-openai", disabled: null },
    { provider: "mcp_oauth:profile:default:https://mcp.cloudflare.com/mcp", type: "oauth", disabled: null },
  ]);
  assert.equal((await detectThirdPartyCredentials(ignoredDbDir)).found, false);
  assert.equal(await cgs.needsStartupLogin(ignoredDbDir), true);

  // (d) agent.db with an active third-party credential (/login OAuth or API key) → no popup.
  const dbDir = tmpDir();
  createAgentDb(dbDir, [{ provider: "openai-codex", type: "oauth", data: { access: "tok" }, disabled: null }]);
  assert.deepEqual(await detectThirdPartyCredentials(dbDir), {
    found: true,
    source: "agent.db",
    provider: "openai-codex",
  });
  assert.equal(await cgs.needsStartupLogin(dbDir), false);

  // (e) models.yml with only cgs-* or keyless provider → still needs popup; with third-party apiKey → no popup.
  const modelsDir = tmpDir();
  fs.writeFileSync(
    path.join(modelsDir, "models.yml"),
    "providers:\n  cgs-openai:\n    apiKey: sk-cgs\n  ollama:\n    baseUrl: http://127.0.0.1:11434\n",
  );
  assert.equal(await cgs.needsStartupLogin(modelsDir), true);

  fs.writeFileSync(
    path.join(modelsDir, "models.yml"),
    "providers:\n  openrouter:\n    baseUrl: https://openrouter.ai/api/v1\n    apiKey: sk-or-123\n",
  );
  assert.deepEqual(await detectThirdPartyCredentials(modelsDir), {
    found: true,
    source: "models.yml",
    provider: "openrouter",
  });
  assert.equal(await cgs.needsStartupLogin(modelsDir), false);

  // Pure helper combinations
  assert.equal(shouldShowStartupPopup({ cgsSignedIn: false, thirdParty: { found: false } }), true);
  assert.equal(shouldShowStartupPopup({ cgsSignedIn: true, thirdParty: { found: false } }), false);
  assert.equal(shouldShowStartupPopup({ cgsSignedIn: false, thirdParty: { found: true } }), false);
});
