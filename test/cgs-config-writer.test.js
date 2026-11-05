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
const { readState, updateState, decideBubble } = require("../src/cgs/state");
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
  for (const key of ["CGS_BASE_URL", "prepareAgentDir", "getLoginState", "needsStartupLogin", "CgsController", "PRESET_IDS", "PRESET_NAMES"]) {
    assert.ok(key in cgs, `missing export ${key}`);
  }
  assert.equal(cgs.CGS_BASE_URL, process.env.CGS_BASE_URL || "https://api.cicori.com");
});

const WEB = "cgs-gemini/gemini-3.1-flash-lite";

const EXPECTED = {
  free: {
    modelRoles: {
      default: "cgs-openai/deepseek-v4.1-flash:auto",
      web: WEB,
    },
  },
  go: {
    modelRoles: {
      default: "cgs-anthropic/claude-haiku-5-5:auto",
      task: "cgs-openai/deepseek-v4.1-flash:auto",
      web: WEB,
    },
  },
  pro: {
    modelRoles: {
      default: "cgs-anthropic/claude-sonnet-5-5:auto",
      task: "cgs-gemini/gemini-4-argon:auto",
      web: WEB,
    },
  },
  dedicated: {
    modelRoles: {
      default: "cgs-anthropic/claude-opus-5-5:auto",
      task: "cgs-anthropic/claude-sonnet-5-5:low",
      smol: "cgs-openai/deepseek-v4.1-flash:auto",
      web: WEB,
    },
    task: { agentModelOverrides: { scout: "cgs-gemini/gemini-3.8-flash:auto" } },
  },
};

for (const preset of Object.keys(EXPECTED)) {
  test(`preset ${preset}: writes the table's keys, includes web search role, and records appliedPreset`, async () => {
    const dir = tmpDir();
    await cw.applyPreset(dir, preset);
    const cfg = parsed(dir);
    assert.deepEqual(cfg, EXPECTED[preset]);
    assert.equal(cfg.modelRoles.web, WEB);
    assert.equal((await readState(dir)).appliedPreset, preset);
  });
}

test("free preset has web role but no subagent roles or overrides", async () => {
  const dir = tmpDir();
  await cw.applyPreset(dir, "free");
  const cfg = parsed(dir);
  assert.equal(cfg.task, undefined);
  assert.deepEqual(Object.keys(cfg.modelRoles).sort(), ["default", "web"]);
});

test("preset switch removes stale CGS keys from the previous preset and prunes emptied maps", async () => {
  const dir = tmpDir();
  await cw.applyPreset(dir, "dedicated");
  await cw.applyPreset(dir, "go");
  assert.deepEqual(parsed(dir), EXPECTED.go); // smol + scout gone, no empty task:
  await cw.applyPreset(dir, "free");
  assert.deepEqual(parsed(dir), EXPECTED.free); // task gone, web stays
  await cw.applyPreset(dir, "pro");
  assert.deepEqual(parsed(dir), EXPECTED.pro);
  assert.equal((await readState(dir)).appliedPreset, "pro");
});

test("unrelated keys and comments survive; stale CGS keys are removed; sibling keys of pruned maps stay", async () => {
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
      "  smol: old/smol-model",
      "task:",
      "  enableLsp: true",
      "  agentModelOverrides:",
      "    reviewer: x/y # keep reviewer",
      "    scout: old/scout",
      "# trailing comment",
      "",
    ].join("\n"),
  );
  await cw.applyPreset(dir, "pro");
  const text = read(dir);
  assert.match(text, /# my personal omp config/);
  assert.match(text, /dark: titanium # favourite/);
  assert.match(text, /plan: anthropic\/claude-opus-5-5:xhigh # keep me/);
  assert.match(text, /reviewer: x\/y # keep reviewer/);
  assert.match(text, /# trailing comment/);
  const cfg = YAML.parse(text);
  assert.equal(cfg.modelRoles.web, WEB);
  assert.equal(cfg.modelRoles.smol, undefined);
  assert.equal(cfg.task.agentModelOverrides.scout, undefined);
  assert.equal(cfg.task.agentModelOverrides.reviewer, "x/y");
  assert.equal(cfg.task.enableLsp, true);
  assert.equal(cfg.modelRoles.default, "cgs-anthropic/claude-sonnet-5-5:auto");
  assert.equal(cfg.modelRoles.plan, "anthropic/claude-opus-5-5:xhigh");
  assert.equal(cfg.theme.dark, "titanium");
});

test("invalid YAML is never overwritten", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.yml"), "a: [unterminated\n");
  await assert.rejects(cw.applyPreset(dir, "free"), /not valid YAML/);
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

test("credentials.json is written 0600 and getLoginState reads it", async () => {
  const dir = tmpDir();
  assert.deepEqual(await cgs.getLoginState(dir), { signedIn: false, tier: null, username: null });
  await cw.writeCredentials(dir, { baseUrl: "https://x", apiKey: "sk-test", tier: "go", username: "bob", models: ["a"] });
  const file = path.join(dir, "cgs", "credentials.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["apiKey", "baseUrl", "linkedAt", "models", "tier", "username"]);
  assert.ok(!Number.isNaN(Date.parse(rec.linkedAt)));
  assert.deepEqual(await cgs.getLoginState(dir), { signedIn: true, tier: "go", username: "bob" });

  fs.writeFileSync(file, "{not json");
  assert.deepEqual(await cgs.getLoginState(dir), { signedIn: false, tier: null, username: null });
  fs.writeFileSync(file, JSON.stringify({ baseUrl: "https://x", apiKey: "" }));
  assert.equal((await cgs.getLoginState(dir)).signedIn, false);
});

test("decideBubble: only shows when signed in and tier differs from both appliedPreset and dismissedTier", () => {
  assert.equal(decideBubble({ signedIn: false, tier: "pro", appliedPreset: "free", dismissedTier: null }), null);
  assert.equal(decideBubble({ signedIn: true, tier: "pro", appliedPreset: "pro", dismissedTier: null }), null);
  assert.equal(decideBubble({ signedIn: true, tier: "pro", appliedPreset: "free", dismissedTier: "pro" }), null);
  assert.deepEqual(decideBubble({ signedIn: true, tier: "pro", appliedPreset: "free", dismissedTier: null }), {
    tier: "pro",
    name: "Pro",
  });
  // Dismissing "go" must still notify when the user later upgrades to "dedicated".
  assert.deepEqual(decideBubble({ signedIn: true, tier: "dedicated", appliedPreset: "free", dismissedTier: "go" }), {
    tier: "dedicated",
    name: "独享",
  });
});

test("first login applies the matching preset; later logins and tier polls never auto-rewrite config.yml", async () => {
  let currentTier = "free";
  let currentModels = ["deepseek-v4.1-flash"];
  let tierStatus = 200;
  const srv = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: currentModels.map(id => ({ id })) }));
      return;
    }
    if (req.url === "/api/device/tier") {
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
    // 1. First-ever login in this agentDir (tier=free) → applies free preset.
    await cw.completeLogin({ agentDir: dir, baseUrl, apiKey: "sk-1", tier: "free", username: "alice" });
    assert.deepEqual(parsed(dir), EXPECTED.free);
    assert.deepEqual(await readState(dir), { appliedPreset: "free", lastKnownTier: "free", dismissedTier: null });

    // 2. Re-login after upgrading to pro → credentials + lastKnownTier update, but config.yml stays on free!
    currentTier = "pro";
    currentModels = ["claude-sonnet-5-5", "gemini-4-argon"];
    await cw.completeLogin({ agentDir: dir, baseUrl, apiKey: "sk-2", tier: "pro", username: "alice" });
    assert.deepEqual(parsed(dir), EXPECTED.free);
    assert.deepEqual(await readState(dir), { appliedPreset: "free", lastKnownTier: "pro", dismissedTier: null });

    // 3. Controller sees tier=pro vs appliedPreset=free → bubble recommends Pro.
    const ctl = new CgsController({ agentDir: dir, intervalMs: 60_000 });
    let snap = await ctl.snapshot();
    assert.deepEqual(snap.bubble, { tier: "pro", name: "Pro" });

    // 4. User clicks 保持当前 → dismissedTier="pro", bubble gone, config.yml untouched.
    snap = await ctl.dismissBubble();
    assert.equal(snap.bubble, null);
    assert.equal((await readState(dir)).dismissedTier, "pro");
    assert.deepEqual(parsed(dir), EXPECTED.free);

    // 5. Server upgrades user to dedicated; next tier poll refreshes credentials + models and shows 独享 bubble.
    currentTier = "dedicated";
    currentModels = ["claude-opus-5-5", "claude-sonnet-5-5", "deepseek-v4.1-flash", "gemini-3.8-flash"];
    await ctl.refresh();
    snap = await ctl.snapshot();
    assert.deepEqual(snap.bubble, { tier: "dedicated", name: "独享" });
    const creds = JSON.parse(fs.readFileSync(path.join(dir, "cgs", "credentials.json"), "utf8"));
    assert.equal(creds.tier, "dedicated");
    assert.ok(creds.models.includes("claude-opus-5-5"));
    assert.deepEqual(parsed(dir), EXPECTED.free); // still untouched until user clicks 切换

    // 6. User clicks 切换 → dedicated preset applied, bubble cleared.
    snap = await ctl.applyPreset("dedicated");
    assert.equal(snap.bubble, null);
    assert.equal(snap.appliedPreset, "dedicated");
    assert.deepEqual(parsed(dir), EXPECTED.dedicated);

    // 7. 401 on tier poll → treated as signed out, no bubble.
    tierStatus = 401;
    await ctl.refresh();
    snap = await ctl.snapshot();
    assert.equal(snap.signedIn, false);
    assert.equal(snap.bubble, null);
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
    apiKey: "sk-cgs",
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
