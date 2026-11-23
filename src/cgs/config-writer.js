"use strict";
// Writes everything the CGS login changes on disk: <agentDir>/cgs/credentials.json, <agentDir>/cgs/state.json,
// <agentDir>/config.yml (preset → roles), the bundled omp extension, and first-run defaults.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const YAML = require("yaml");
const { clientHeaders } = require("./client-info");
const { requestJson, HttpError } = require("./http");
const { CgsError } = require("./device-flow");
const { writeFileAtomic } = require("./fs-util");
const { normalizeTier, readState, updateState } = require("./state");

// ---- default layout (served by GET /api/device/layout) ----------------------------------------------------------

const KEY_DEFAULT = ["modelRoles", "default"];
const KEY_TASK = ["modelRoles", "task"];
const KEY_WEB = ["modelRoles", "web"];
const KEY_WEB_CHAIN = ["retry", "fallbackChains", "web"];
const KEY_SMOL = ["modelRoles", "smol"];
/** Per-agent model selectors (`<agent name>: provider/model[:thinking]`), read by omp's task tool. */
const KEY_AGENT_OVERRIDES = ["task", "agentModelOverrides"];
const overrideKey = name => [...KEY_AGENT_OVERRIDES, name];

/**
 * CGS-managed keys: the ones the default layout writes (plus `task` and `smol`, which earlier versions wrote). Logout
 * removes them where they still point at cgs-* models; every `task.agentModelOverrides.*` entry is treated the same way
 * (the orchestrator in Settings → Agents writes arbitrary agent names there).
 */
const MANAGED_KEYS = [KEY_DEFAULT, KEY_TASK, KEY_WEB, KEY_WEB_CHAIN, KEY_SMOL];

/**
 * Defaults written by prepareAgentDir only when the key is absent. `edit.modelVariants` gives each vendor's models
 * that vendor's own edit-tool style: Claude models the Claude Code style (exact string replace), OpenAI models the
 * Codex style (apply_patch); everything else keeps omp's default (hashline).
 */
const FIRST_RUN_DEFAULTS = [
  [["computer", "enabled"], true],
  [["lsp", "enabled"], true],
  [["task", "enableLsp"], true],
  [["defaultThinkingLevel"], "auto"],
  [["edit", "modelVariants"], { claude: "replace", gpt: "apply_patch" }],
];

// ---- file helpers ----------------------------------------------------------------------------

async function loadConfigDoc(file) {
  let text = "";
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${file} is not valid YAML: ${doc.errors[0].message}`);
  }
  if (doc.contents !== null && !YAML.isMap(doc.contents)) {
    throw new Error(`${file} must contain a YAML mapping at the top level`);
  }
  return { doc, text };
}

async function saveConfigDoc(file, doc, previousText) {
  const out = doc.toString({ lineWidth: 0 });
  if (out === previousText) return;
  await writeFileAtomic(file, out);
}

function configPath(agentDir) {
  return path.join(agentDir, "config.yml");
}

function credentialsPath(agentDir) {
  return path.join(agentDir, "cgs", "credentials.json");
}

// ---- config.yml ------------------------------------------------------------------------------

/** Remove `keyPath` and prune parent maps that this removal left empty. */
function deleteAndPrune(doc, keyPath) {
  if (!doc.hasIn(keyPath)) return;
  doc.deleteIn(keyPath);
  for (let len = keyPath.length - 1; len >= 1; len--) {
    const parent = doc.getIn(keyPath.slice(0, len), true);
    if (YAML.isMap(parent) && parent.items.length === 0) doc.deleteIn(keyPath.slice(0, len));
    else break;
  }
}

/**
 * Pure: write a default layout (see normalizeLayout) into a parsed Document (mutates it). The orchestrator becomes
 * `modelRoles.default`, each agent `task.agentModelOverrides.<name>` (other agents' overrides stay). The web model also
 * gets a one-entry `retry.fallbackChains.web`, replacing omp's default web chain (which ends in the session model's own
 * hosted search): a search-model failure then surfaces as an error instead of silently switching providers.
 */
function applyLayoutToDocument(doc, layout) {
  doc.setIn(KEY_DEFAULT, formatSelector(layout.orchestrator));
  for (const agent of layout.agents) doc.setIn(overrideKey(agent.name), formatSelector(agent));
  if (layout.webModel) {
    doc.setIn(KEY_WEB, layout.webModel);
    doc.setIn(KEY_WEB_CHAIN, [layout.webModel]);
  }
}

/** Write a default layout into config.yml and record `defaultsApplied` in state.json. */
async function applyDefaultLayout(agentDir, layout) {
  const file = configPath(agentDir);
  const { doc, text } = await loadConfigDoc(file);
  applyLayoutToDocument(doc, layout);
  await saveConfigDoc(file, doc, text);
  await updateState(agentDir, { defaultsApplied: true });
}

async function applyFirstRunDefaults(agentDir) {
  const file = configPath(agentDir);
  const { doc, text } = await loadConfigDoc(file);
  for (const [keyPath, value] of FIRST_RUN_DEFAULTS) {
    if (!doc.hasIn(keyPath)) doc.setIn(keyPath, value);
  }
  await saveConfigDoc(file, doc, text);
}

// ---- orchestration (Settings → Agents → orchestrator) ------------------------------------------------------------

/** omp's thinking selectors; a model selector may end in `:<level>`. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** "provider/model:max" → { model: "provider/model", thinking: "max" }; no level suffix → thinking "". */
function parseSelector(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const colon = text.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.includes(text.slice(colon + 1))) return { model: text.slice(0, colon), thinking: text.slice(colon + 1) };
  return { model: text, thinking: "" };
}

function formatSelector({ model, thinking }) {
  return thinking ? `${model}:${thinking}` : model;
}

/** A map key/value as a JS value: values set on a Document (setIn) are plain, parsed ones are Scalar nodes. */
const plain = (node) => (YAML.isScalar(node) ? node.value : node);

/** Pure: the orchestration a parsed config Document describes: the orchestrator and every agent override. */
function orchestrationFromDocument(doc) {
  const overrides = doc.getIn(KEY_AGENT_OVERRIDES, true);
  const agents = YAML.isMap(overrides)
    ? overrides.items
        .filter(pair => typeof plain(pair.value) === "string")
        .map(pair => ({ name: String(plain(pair.key)), ...parseSelector(plain(pair.value)) }))
    : [];
  return { orchestrator: parseSelector(doc.getIn(KEY_DEFAULT)), agents };
}

/** Validates an orchestration ({ orchestrator, agents }); throws a message the UI shows as is. */
function normalizeOrchestration(input) {
  const clean = (entry, what) => {
    const model = typeof entry?.model === "string" ? entry.model.trim() : "";
    const thinking = typeof entry?.thinking === "string" ? entry.thinking : "";
    if (thinking && !THINKING_LEVELS.includes(thinking)) throw new Error(`${what}: unknown thinking level "${thinking}"`);
    if (/[\s:]/.test(model)) throw new Error(`${what}: invalid model "${model}"`);
    return { model, thinking: model ? thinking : "" };
  };
  const orchestrator = clean(input?.orchestrator, "Orchestrator");
  if (!orchestrator.model) throw new Error("Orchestrator: a model is required");
  const seen = new Set();
  const agents = (Array.isArray(input?.agents) ? input.agents : []).map(entry => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!AGENT_NAME_RE.test(name)) throw new Error(`Invalid agent name "${name}"`);
    if (seen.has(name)) throw new Error(`Duplicate agent "${name}"`);
    seen.add(name);
    return { name, ...clean(entry, name) };
  });
  return { orchestrator, agents };
}

/**
 * Pure: write an orchestration into a parsed config Document (mutates it). `modelRoles.default` is the orchestrator;
 * each agent with a model becomes `task.agentModelOverrides.<name>`; overrides of agents without a model or no longer
 * listed are removed.
 */
function applyOrchestrationToDocument(doc, orchestration) {
  const { orchestrator, agents } = normalizeOrchestration(orchestration);
  doc.setIn(KEY_DEFAULT, formatSelector(orchestrator));
  const wanted = new Map(agents.filter(agent => agent.model).map(agent => [agent.name, formatSelector(agent)]));
  const overrides = doc.getIn(KEY_AGENT_OVERRIDES, true);
  if (YAML.isMap(overrides)) {
    for (const pair of [...overrides.items]) {
      const name = plain(pair.key);
      if (typeof name === "string" && !wanted.has(name)) deleteAndPrune(doc, overrideKey(name));
    }
  }
  for (const [name, selector] of wanted) doc.setIn(overrideKey(name), selector);
}

async function readOrchestration(agentDir) {
  const { doc } = await loadConfigDoc(configPath(agentDir));
  return orchestrationFromDocument(doc);
}

/** Write the orchestration into config.yml; resolves the orchestration as now stored. */
async function writeOrchestration(agentDir, orchestration) {
  const file = configPath(agentDir);
  const { doc, text } = await loadConfigDoc(file);
  applyOrchestrationToDocument(doc, orchestration);
  await saveConfigDoc(file, doc, text);
  return orchestrationFromDocument(doc);
}

/** The `data` of GET /api/device/layout → { orchestrator, agents, webModel } (validated), or null when unusable. */
function normalizeLayout(data) {
  if (!data || typeof data !== "object") return null;
  try {
    const { orchestrator, agents } = normalizeOrchestration({ orchestrator: data.orchestrator, agents: data.agents });
    const webModel = typeof data.web_model === "string" ? data.web_model.trim() : "";
    if (/[\s:]/.test(webModel)) return null;
    return { orchestrator, agents: agents.filter(agent => agent.model), webModel };
  } catch {
    return null;
  }
}

/**
 * GET <baseUrl>/api/device/layout with the client credential: the default layout the server operator configures
 * (device_setting.default_layout). Resolves the normalized layout; rejects with CgsError("layout") on any failure.
 */
async function fetchLayout({ baseUrl, clientSecret, signal }) {
  let res;
  try {
    res = await requestJson({
      url: `${String(baseUrl).replace(/\/+$/, "")}/api/device/layout`,
      headers: clientHeaders(clientSecret),
      signal,
      timeoutMs: 15000,
    });
  } catch (err) {
    if (err instanceof HttpError && err.kind === "aborted") throw new CgsError("aborted", "已取消");
    throw new CgsError("layout", "无法获取默认智能体编排", err);
  }
  const layout = res.status === 200 && res.json && res.json.success === true ? normalizeLayout(res.json.data) : null;
  if (!layout) throw new CgsError("layout", `获取默认智能体编排失败（HTTP ${res.status}）`);
  return layout;
}

/**
 * Apply the server's default layout once per agentDir (`defaultsApplied` unset). A failed fetch leaves it unset, so the
 * next login or account refresh tries again; resolves whether the layout was applied now.
 */
async function ensureDefaultLayout(agentDir, { baseUrl, clientSecret, signal }) {
  if ((await readState(agentDir)).defaultsApplied) return false;
  let layout;
  try {
    layout = await fetchLayout({ baseUrl, clientSecret, signal });
  } catch (err) {
    if (err instanceof CgsError && err.code === "aborted") throw err;
    console.warn(`[cgs] default layout not applied: ${err.message}`);
    return false;
  }
  await applyDefaultLayout(agentDir, layout);
  return true;
}

// ---- credentials -----------------------------------------------------------------------------

/** GET <baseUrl>/v1/models with the client credential → sorted unique model ids. */
async function fetchModelIds(baseUrl, clientSecret, signal) {
  let res;
  try {
    res = await requestJson({
      url: `${baseUrl.replace(/\/+$/, "")}/v1/models`,
      headers: clientHeaders(clientSecret),
      signal,
    });
  } catch (err) {
    if (err instanceof HttpError && err.kind === "aborted") throw new CgsError("aborted", "已取消");
    throw new CgsError("models", "无法获取可用模型列表，请检查网络后重试", err);
  }
  const list = res.json && Array.isArray(res.json.data) ? res.json.data : null;
  if (res.status !== 200 || !list) {
    throw new CgsError("models", `获取可用模型列表失败（HTTP ${res.status}）`);
  }
  const ids = [...new Set(list.map(m => (m && typeof m.id === "string" ? m.id.trim() : "")).filter(Boolean))].sort();
  if (ids.length === 0) throw new CgsError("models", "该账户当前没有可用模型");
  return ids;
}

async function writeCredentials(agentDir, { baseUrl, clientSecret, tier, username, models, linkedAt = new Date().toISOString() }) {
  const record = { baseUrl, clientSecret, tier, username, models, linkedAt };
  await writeFileAtomic(credentialsPath(agentDir), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}

/** The full credentials.json record, or null when missing/unusable (a pre-client `apiKey` record counts as unusable). */
async function readCredentials(agentDir) {
  try {
    const data = JSON.parse(await fsp.readFile(credentialsPath(agentDir), "utf8"));
    if (!data || typeof data.clientSecret !== "string" || !data.clientSecret || typeof data.baseUrl !== "string" || !data.baseUrl) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * After approval: fetch models, write credentials, remember the tier. The server's default layout is applied here only
 * for the very first login in this agentDir (`defaultsApplied` unset); later logins never touch config.yml, so
 * whatever the user changed since stays.
 */
async function completeLogin({ agentDir, baseUrl, clientSecret, tier, username, signal }) {
  const models = await fetchModelIds(baseUrl, clientSecret, signal);
  const record = await writeCredentials(agentDir, { baseUrl, clientSecret, tier, username, models });
  await ensureDefaultLayout(agentDir, { baseUrl, clientSecret, signal });
  await updateState(agentDir, { lastKnownTier: normalizeTier(tier) });
  return record;
}

async function getLoginState(agentDir) {
  try {
    const data = JSON.parse(await fsp.readFile(credentialsPath(agentDir), "utf8"));
    const signedIn = Boolean(data && typeof data.clientSecret === "string" && data.clientSecret && typeof data.baseUrl === "string" && data.baseUrl);
    return {
      signedIn,
      tier: signedIn && typeof data.tier === "string" ? data.tier : null,
      username: signedIn && typeof data.username === "string" ? data.username : null,
    };
  } catch {
    return { signedIn: false, tier: null, username: null };
  }
}

// ---- logout / local cleanup --------------------------------------------------------------------

/** The providers the bundled extension registers (plugin/omp-cgs/index.js). */
// Includes cgs-anthropic / cgs-gemini of earlier versions, so a logout also cleans up their leftovers.
const CGS_PROVIDERS = ["cgs-claude", "cgs-antigravity", "cgs-codex", "cgs-openai", "cgs-anthropic", "cgs-gemini"];
const CGS_MODEL_REF = /^cgs-(claude|antigravity|codex|openai|anthropic|gemini)\//;
const MODELS_FILES = ["models.yml", "models.yaml"];

function isCgsModelRef(value) {
  return typeof value === "string" && CGS_MODEL_REF.test(value.trim());
}

/**
 * Pure: remove the CGS-managed keys (MANAGED_KEYS and every `task.agentModelOverrides.*` entry) from a parsed config
 * Document (mutates it), but only where the value still references a cgs-* model. A role the user pointed elsewhere
 * stays; in a list (`retry.fallbackChains.web`) only the cgs-* entries go. Returns the dotted paths that were removed or
 * trimmed.
 */
function removeCgsKeysFromDocument(doc) {
  const changed = [];
  const overrides = doc.getIn(KEY_AGENT_OVERRIDES, true);
  const overrideKeys = YAML.isMap(overrides) ? overrides.items.map(pair => plain(pair.key)).filter(key => typeof key === "string").map(overrideKey) : [];
  for (const keyPath of [...MANAGED_KEYS, ...overrideKeys]) {
    const node = doc.getIn(keyPath, true);
    if (YAML.isScalar(node)) {
      if (!isCgsModelRef(node.value)) continue;
      deleteAndPrune(doc, keyPath);
    } else if (YAML.isSeq(node)) {
      const keep = node.items.filter(item => !(YAML.isScalar(item) && isCgsModelRef(item.value)));
      if (keep.length === node.items.length) continue;
      if (keep.length === 0) deleteAndPrune(doc, keyPath);
      else node.items = keep;
    } else {
      continue;
    }
    changed.push(keyPath.join("."));
  }
  return changed;
}

/** Remove the cgs-* model references from <agentDir>/config.yml. Resolves the removed key paths. */
async function removeCgsFromConfig(agentDir) {
  const file = configPath(agentDir);
  const { doc, text } = await loadConfigDoc(file);
  const changed = removeCgsKeysFromDocument(doc);
  if (changed.length > 0) await saveConfigDoc(file, doc, text);
  return changed;
}

/** Remove `providers.cgs-*` from <agentDir>/models.yml (or .yaml) when present. Resolves the removed provider names. */
async function removeCgsFromModels(agentDir) {
  const removed = [];
  for (const name of MODELS_FILES) {
    const file = path.join(agentDir, name);
    let doc;
    let text;
    try {
      ({ doc, text } = await loadConfigDoc(file));
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (text === "") continue;
    for (const provider of CGS_PROVIDERS) {
      if (doc.hasIn(["providers", provider])) {
        doc.deleteIn(["providers", provider]);
        removed.push(provider);
      }
    }
    await saveConfigDoc(file, doc, text);
  }
  return removed;
}

/**
 * Make ompweb drop its cached model list and restart its utility omp process (which loads the CGS extension, i.e.
 * reads credentials.json, once at startup). ompweb's /api/models fingerprints models.yml (path, mtime, ctime, size)
 * and does exactly that when the fingerprint changes, the same path its own models editor and external edits use.
 * So: bump models.yml's mtime, or create an empty one when there is none. Sessions that are already running keep the
 * providers they started with.
 */
async function notifyModelsChanged(agentDir) {
  for (const name of MODELS_FILES) {
    const file = path.join(agentDir, name);
    try {
      const now = new Date();
      await fsp.utimes(file, now, now);
      return;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  await writeFileAtomic(path.join(agentDir, "models.yml"), "providers: {}\n");
}

/**
 * Everything a logout changes locally. credentials.json goes first and its failure is thrown (the account is only
 * signed out once the key is gone); the rest is best effort and reported in `errors` (a broken config.yml must not keep
 * the user signed in). state.json is reset so a later login applies the default roles again like a first login.
 * Resolves { removedRoles, removedProviders, errors }.
 */
async function signOutLocally(agentDir) {
  await fsp.rm(credentialsPath(agentDir), { force: true });
  const result = { removedRoles: [], removedProviders: [], errors: [] };
  const step = async (name, run) => {
    try {
      return await run();
    } catch (err) {
      result.errors.push(`${name}: ${err?.message || err}`);
      return null;
    }
  };
  result.removedProviders = (await step("models.yml", () => removeCgsFromModels(agentDir))) ?? [];
  result.removedRoles = (await step("config.yml", () => removeCgsFromConfig(agentDir))) ?? [];
  await step("state.json", () => updateState(agentDir, { defaultsApplied: false, lastKnownTier: null }));
  await step("models reload", () => notifyModelsChanged(agentDir));
  return result;
}

// ---- plugin install --------------------------------------------------------------------------

const INSTALL_MARKER = ".cgs-install.json";

async function listFiles(root, rel = "") {
  const out = [];
  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (entry.isFile() && entry.name !== INSTALL_MARKER) out.push(r);
  }
  return out.sort();
}

async function hashDir(root) {
  const h = crypto.createHash("sha256");
  for (const rel of await listFiles(root)) {
    h.update(rel).update("\0").update(await fsp.readFile(path.join(root, rel))).update("\0");
  }
  return h.digest("hex");
}

/** Copy the bundled extension into <agentDir>/extensions/cgs/ when missing or when the bundle changed. */
async function installPlugin(agentDir, pluginSourceDir) {
  const dest = path.join(agentDir, "extensions", "cgs");
  const pkg = JSON.parse(await fsp.readFile(path.join(pluginSourceDir, "package.json"), "utf8"));
  const hash = await hashDir(pluginSourceDir);
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(dest, INSTALL_MARKER), "utf8"));
    if (marker.hash === hash && marker.version === pkg.version && fs.existsSync(path.join(dest, "index.js"))) {
      return { installed: false, version: pkg.version };
    }
  } catch {
    // not installed yet, or marker unreadable: (re)install
  }
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  for (const rel of await listFiles(pluginSourceDir)) {
    const target = path.join(dest, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(pluginSourceDir, rel), target);
  }
  await fsp.writeFile(path.join(dest, INSTALL_MARKER), JSON.stringify({ version: pkg.version, hash }));
  return { installed: true, version: pkg.version };
}

async function prepareAgentDir(agentDir, { pluginSourceDir }) {
  await fsp.mkdir(agentDir, { recursive: true });
  await installPlugin(agentDir, pluginSourceDir);
  await applyFirstRunDefaults(agentDir);
}

module.exports = {
  MANAGED_KEYS,
  FIRST_RUN_DEFAULTS,
  THINKING_LEVELS,
  applyLayoutToDocument,
  applyDefaultLayout,
  applyFirstRunDefaults,
  normalizeLayout,
  fetchLayout,
  ensureDefaultLayout,
  orchestrationFromDocument,
  applyOrchestrationToDocument,
  readOrchestration,
  writeOrchestration,
  fetchModelIds,
  readCredentials,
  writeCredentials,
  completeLogin,
  getLoginState,
  CGS_PROVIDERS,
  removeCgsKeysFromDocument,
  removeCgsFromConfig,
  removeCgsFromModels,
  notifyModelsChanged,
  signOutLocally,
  installPlugin,
  prepareAgentDir,
  credentialsPath,
  configPath,
};
