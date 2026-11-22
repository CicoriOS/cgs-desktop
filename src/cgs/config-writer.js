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

// ---- default role mapping ----------------------------------------------------------------------

const KEY_DEFAULT = ["modelRoles", "default"];
const KEY_TASK = ["modelRoles", "task"];
const KEY_WEB = ["modelRoles", "web"];
const KEY_WEB_CHAIN = ["retry", "fallbackChains", "web"];
const KEY_SMOL = ["modelRoles", "smol"];
const KEY_REVIEWER = ["task", "agentModelOverrides", "reviewer"];
const KEY_SCOUT = ["task", "agentModelOverrides", "scout"];

/** CGS-managed keys: the ones the default mapping writes (plus `smol`, which earlier versions' presets wrote). Logout removes them where they still point at cgs-* models. */
const MANAGED_KEYS = [KEY_DEFAULT, KEY_TASK, KEY_WEB, KEY_WEB_CHAIN, KEY_SMOL, KEY_REVIEWER, KEY_SCOUT];

/**
 * Search model, plus a one-entry `retry.fallbackChains.web` that replaces omp's default web chain (which ends in the
 * session model's own hosted search, i.e. Anthropic). A Gemini failure then surfaces as a search error instead of
 * silently switching providers.
 */
const WEB_MODEL = "cgs-antigravity/gemini-3.8-flash";
const WEB_CHAIN = [WEB_MODEL];

/**
 * The default role mapping, written once at the first login; the user edits it freely afterwards (ompweb's AI model
 * defaults, config.yml). Main agent Claude Haiku, task DeepSeek Flash 4.1, reviewer Astra, scout Haiku, search Gemini
 * 3.8 Flash. Each model sits on its vendor's channel (see plugin/omp-cgs/index.js).
 */
const DEFAULT_ROLES = [
  [KEY_DEFAULT, "cgs-claude/claude-haiku-5-5:auto"],
  [KEY_TASK, "cgs-openai/deepseek-v4.1-flash:auto"],
  [KEY_WEB, WEB_MODEL],
  [KEY_WEB_CHAIN, WEB_CHAIN],
  [KEY_REVIEWER, "cgs-codex/gpt-6-astra:auto"],
  [KEY_SCOUT, "cgs-claude/claude-haiku-5-5:auto"],
];

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

/** Pure: write the default role mapping into a parsed Document (mutates it). */
function applyDefaultRolesToDocument(doc) {
  for (const [keyPath, value] of DEFAULT_ROLES) doc.setIn(keyPath, value);
}

/** Write the default role mapping into config.yml and record `defaultsApplied` in state.json. */
async function applyDefaultRoles(agentDir) {
  const file = configPath(agentDir);
  const { doc, text } = await loadConfigDoc(file);
  applyDefaultRolesToDocument(doc);
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
 * After approval: fetch models, write credentials, remember the tier. The default role mapping is applied here only
 * for the very first login in this agentDir (`defaultsApplied` unset); later logins never touch config.yml, so
 * whatever the user changed since stays.
 */
async function completeLogin({ agentDir, baseUrl, clientSecret, tier, username, signal }) {
  const models = await fetchModelIds(baseUrl, clientSecret, signal);
  const record = await writeCredentials(agentDir, { baseUrl, clientSecret, tier, username, models });
  if (!(await readState(agentDir)).defaultsApplied) await applyDefaultRoles(agentDir);
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
 * Pure: remove the CGS-managed keys (MANAGED_KEYS, i.e. everything applyPreset writes) from a parsed config Document
 * (mutates it), but only where the value still references a cgs-* model. A role the user pointed elsewhere stays; in a
 * list (`retry.fallbackChains.web`) only the cgs-* entries go. Returns the dotted paths that were removed or trimmed.
 */
function removeCgsKeysFromDocument(doc) {
  const changed = [];
  for (const keyPath of MANAGED_KEYS) {
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
  DEFAULT_ROLES,
  WEB_MODEL,
  MANAGED_KEYS,
  FIRST_RUN_DEFAULTS,
  applyDefaultRolesToDocument,
  applyDefaultRoles,
  applyFirstRunDefaults,
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
