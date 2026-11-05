"use strict";
// Read-only detection of credentials the user already saved for non-CGS providers, so the startup login popup
// only appears for a truly fresh agentDir. Where omp keeps them (pi-ai `sqlite-credential-store`, pi-coding-agent
// `models-config`):
//   • <agentDir>/agent.db, table auth_credentials(provider, credential_type 'api_key'|'oauth', data, disabled_cause):
//     what `/login` (OAuth or API key) stores. Rows with disabled_cause set are ignored by omp ("deleted by user",
//     refresh failures), so they are ignored here too. `mcp_oauth:*` rows are MCP-server tokens, not model logins.
//   • <agentDir>/models.yml (or .yaml / .json): `providers.<name>.apiKey`, which ompweb's Models UI writes.
// CGS's own providers (`cgs-*`) never count.

const fsp = require("node:fs/promises");
const path = require("node:path");
const YAML = require("yaml");

const CGS_PROVIDER_PREFIX = "cgs-";
const NON_MODEL_PROVIDER_PREFIXES = ["mcp_oauth:"];
const MODELS_FILES = ["models.yml", "models.yaml", "models.json"];

/** Provider id of a saved credential that counts as a third-party login. */
function isThirdPartyProvider(provider) {
  if (typeof provider !== "string" || !provider.trim()) return false;
  const id = provider.trim().toLowerCase();
  return !id.startsWith(CGS_PROVIDER_PREFIX) && !NON_MODEL_PROVIDER_PREFIXES.some(p => id.startsWith(p));
}

/** First third-party provider with a live credential in agent.db, or null (missing/locked/odd db → null). */
function findAgentDbCredential(agentDir) {
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(path.join(agentDir, "agent.db"), { readOnly: true, timeout: 1000 });
    const rows = db.prepare("SELECT provider FROM auth_credentials WHERE disabled_cause IS NULL").all();
    const hit = rows.find(row => isThirdPartyProvider(row.provider));
    return hit ? String(hit.provider) : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed / never opened
    }
  }
}

/** First third-party provider with a non-empty apiKey in models.yml, or null. */
async function findModelsConfigKey(agentDir) {
  for (const name of MODELS_FILES) {
    let text;
    try {
      text = await fsp.readFile(path.join(agentDir, name), "utf8");
    } catch {
      continue;
    }
    let config;
    try {
      config = name.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
    } catch {
      return null;
    }
    const providers = config && typeof config === "object" ? config.providers : null;
    if (!providers || typeof providers !== "object") return null;
    for (const [provider, def] of Object.entries(providers)) {
      if (!isThirdPartyProvider(provider)) continue;
      if (def && typeof def.apiKey === "string" && def.apiKey.trim()) return provider;
    }
    return null; // omp reads only the first models file that exists
  }
  return null;
}

/** → { found: boolean, source: "agent.db" | "models.yml" | null, provider: string | null } */
async function detectThirdPartyCredentials(agentDir) {
  const dbProvider = findAgentDbCredential(agentDir);
  if (dbProvider) return { found: true, source: "agent.db", provider: dbProvider };
  const yamlProvider = await findModelsConfigKey(agentDir);
  if (yamlProvider) return { found: true, source: "models.yml", provider: yamlProvider };
  return { found: false, source: null, provider: null };
}

/** Pure: the startup popup shows only when there are no saved credentials of any kind. */
function shouldShowStartupPopup({ cgsSignedIn, thirdParty }) {
  return !cgsSignedIn && !(thirdParty && thirdParty.found);
}

module.exports = { isThirdPartyProvider, findAgentDbCredential, findModelsConfigKey, detectThirdPartyCredentials, shouldShowStartupPopup };
