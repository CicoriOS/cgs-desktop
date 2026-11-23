"use strict";
// Tier detection: GET <baseUrl>/api/device/tier (Bearer client credential) → { success, data: { tier, username } }.

const { clientHeaders } = require("./client-info");
const { requestJson, HttpError } = require("./http");
const { ensureDefaultLayout, fetchModelIds, readCredentials, writeCredentials } = require("./config-writer");
const { normalizeTier, updateState } = require("./state");

/**
 * One tier request. Resolves { status: "ok", tier, username } | { status: "unauthorized" } | { status: "error" }.
 * Never rejects (network failures, bad bodies and 5xx are all "error": silent, retried next tick).
 */
async function fetchTier({ baseUrl, clientSecret, signal }) {
  let res;
  try {
    res = await requestJson({
      url: `${String(baseUrl).replace(/\/+$/, "")}/api/device/tier`,
      headers: clientHeaders(clientSecret),
      signal,
      timeoutMs: 15000,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: "error" };
  }
  if (res.status === 401) return { status: "unauthorized" };
  const data = res.json && res.json.success === true ? res.json.data : null;
  const tier = normalizeTier(data && data.tier);
  if (res.status !== 200 || !tier) return { status: "error" };
  return { status: "ok", tier, username: typeof data.username === "string" ? data.username : null };
}

/**
 * Re-detect the tier of the signed-in account and refresh what depends on it: credentials.json (tier, username,
 * model list for the plugin) and state.json `lastKnownTier`. config.yml is only touched when the server's default
 * layout has not been applied yet (its fetch failed at login).
 * Resolves { status: "signed-out" | "unauthorized" | "error" } or { status: "ok", tier, username }.
 */
async function refreshTier(agentDir, { signal } = {}) {
  const creds = await readCredentials(agentDir);
  if (!creds) return { status: "signed-out" };
  const result = await fetchTier({ baseUrl: creds.baseUrl, clientSecret: creds.clientSecret, signal });
  if (result.status !== "ok") return { status: result.status };

  let models = creds.models;
  try {
    models = await fetchModelIds(creds.baseUrl, creds.clientSecret, signal);
  } catch {
    // keep the cached list; it is refreshed again next tick
  }
  await writeCredentials(agentDir, {
    baseUrl: creds.baseUrl,
    clientSecret: creds.clientSecret,
    tier: result.tier,
    username: result.username ?? creds.username,
    models,
    linkedAt: creds.linkedAt,
  });
  await updateState(agentDir, { lastKnownTier: result.tier });
  await ensureDefaultLayout(agentDir, { baseUrl: creds.baseUrl, clientSecret: creds.clientSecret, signal });
  return { status: "ok", tier: result.tier, username: result.username ?? creds.username ?? null };
}

module.exports = { fetchTier, refreshTier };
