"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PLUGIN = path.join(__dirname, "..", "plugin", "omp-cgs", "index.js");
const load = () => import(pathToFileURL(PLUGIN).href);

const CREDS = {
  baseUrl: "https://api.example.com/",
  apiKey: "sk-test",
  models: [
    "claude-haiku-5-5",
    "claude-opus-5-5",
    "gemini-3.8-flash",
    "gemini-4-argon",
    "deepseek-v4.1-flash",
    "grok-4.7",
    "kimi-k3",
    "gpt-image-2.5",
    "gpt-image-2",
    "text-embedding-3-small",
    "gemini-3-pro-image-preview",
    "claude-haiku-5-5",
  ],
};

test("providers are partitioned by model id with the contract's api and base URLs", async () => {
  const { readCredentials, buildProviders } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-plugin-"));
  fs.mkdirSync(path.join(dir, "cgs"));
  fs.writeFileSync(path.join(dir, "cgs", "credentials.json"), JSON.stringify(CREDS));
  const providers = buildProviders(readCredentials(dir));

  assert.deepEqual(Object.keys(providers).sort(), ["cgs-anthropic", "cgs-gemini", "cgs-openai"]);
  const ids = name => providers[name].models.map(m => m.id);
  assert.deepEqual(ids("cgs-anthropic"), ["claude-haiku-5-5", "claude-opus-5-5"]);
  assert.deepEqual(ids("cgs-gemini"), ["gemini-3.8-flash", "gemini-4-argon"]);
  assert.deepEqual(ids("cgs-openai"), ["deepseek-v4.1-flash", "grok-4.7", "kimi-k3"]);

  assert.equal(providers["cgs-anthropic"].api, "anthropic-messages");
  assert.equal(providers["cgs-anthropic"].baseUrl, "https://api.example.com");
  assert.equal(providers["cgs-gemini"].api, "google-generative-ai");
  assert.equal(providers["cgs-gemini"].baseUrl, "https://api.example.com/v1beta");
  assert.equal(providers["cgs-openai"].api, "openai-completions");
  assert.equal(providers["cgs-openai"].baseUrl, "https://api.example.com/v1");
  for (const p of Object.values(providers)) assert.equal(p.apiKey, "sk-test");
});

test("image/embedding models are never registered; providers without models are omitted", async () => {
  const { buildProviders, providerForModel } = await load();
  for (const id of ["gpt-image-2", "gpt-image-2.5-flare", "dall-e-3", "text-embedding-3-large", "whisper-1", "tts-1", "gemini-3-pro-image-preview", "imagen-4"]) {
    assert.equal(providerForModel(id), null, id);
  }
  for (const id of ["gpt-5.2", "o3", "glm-5.3-flash", "minimax-m3.1-flash", "deepseek-v4.1-flash"]) {
    assert.equal(providerForModel(id), "cgs-openai", id);
  }
  const only = buildProviders({ baseUrl: "https://h", apiKey: "k", models: ["claude-opus-5-5"] });
  assert.deepEqual(Object.keys(only), ["cgs-anthropic"]);
  assert.deepEqual(buildProviders({ baseUrl: "https://h", apiKey: "k", models: [] }), {});
});

test("model metadata: catalog-known ids inherit; unknown ids use the per-family table", async () => {
  const { buildModel, FAMILY_FALLBACKS, FALLBACK_DEFAULT } = await load();
  const ref = { thinking: { mode: "x", efforts: ["low"] } };
  // known: only id/name (+ thinking) so omp fills contextWindow/maxTokens/reasoning/input/cost from its catalog
  assert.deepEqual(buildModel("claude-opus-5-5", ref), { id: "claude-opus-5-5", name: "claude-opus-5-5", thinking: ref.thinking });
  assert.deepEqual(buildModel("claude-opus-5-5", {}), { id: "claude-opus-5-5", name: "claude-opus-5-5" });

  const families = { "claude-new-9": "claude", "gemini-9": "gemini", "deepseek-x": "deepseek", "glm-9": "glm", "grok-9": "grok", "kimi-k9": "kimi", "minimax-m9": "minimax" };
  for (const [id, family] of Object.entries(families)) {
    const m = buildModel(id, undefined);
    const f = FAMILY_FALLBACKS.find(x => x.family === family);
    assert.equal(m.reasoning, f.reasoning, id);
    assert.deepEqual(m.input, f.input, id);
    assert.equal(m.contextWindow, f.contextWindow, id);
    assert.equal(m.maxTokens, f.maxTokens, id);
    assert.ok(m.contextWindow > 0 && m.maxTokens > 0 && m.maxTokens <= m.contextWindow, id);
  }
  const other = buildModel("mystery-1", undefined);
  assert.equal(other.contextWindow, FALLBACK_DEFAULT.contextWindow);
  assert.equal(other.reasoning, false);
  assert.deepEqual(other.input, ["text"]);
});

test("credentials are resolved from PI_CODING_AGENT_DIR, else ~/.omp/agent; bad files yield nothing", async () => {
  const { resolveAgentDir, readCredentials } = await load();
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/x/agent" }, "/home/u"), path.resolve("/tmp/x/agent"));
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/a" }, "/home/u"), path.join("/home/u", "a"));
  assert.equal(resolveAgentDir({}, "/home/u"), path.join("/home/u", ".omp", "agent"));
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "  " }, "/home/u"), path.join("/home/u", ".omp", "agent"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-plugin-"));
  assert.equal(readCredentials(dir), null);
  fs.mkdirSync(path.join(dir, "cgs"));
  const file = path.join(dir, "cgs", "credentials.json");
  for (const bad of ["{oops", JSON.stringify({ baseUrl: "https://h", apiKey: "", models: [] }), JSON.stringify({ baseUrl: "", apiKey: "k", models: [] }), JSON.stringify({ baseUrl: "https://h", apiKey: "k" })]) {
    fs.writeFileSync(file, bad);
    assert.equal(readCredentials(dir), null);
  }
});

test("extension factory registers nothing without credentials, three providers with them", async () => {
  const { default: factory } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-plugin-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const calls = [];
    const pi = { registerProvider: (name, config) => calls.push([name, config]) };
    await factory(pi);
    assert.deepEqual(calls, []);

    fs.mkdirSync(path.join(dir, "cgs"));
    fs.writeFileSync(path.join(dir, "cgs", "credentials.json"), JSON.stringify(CREDS));
    await factory(pi);
    assert.deepEqual(calls.map(c => c[0]).sort(), ["cgs-anthropic", "cgs-gemini", "cgs-openai"]);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});
