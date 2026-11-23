"use strict";
// The relay tunnel configuration: GET <baseUrl>/api/device/tunnel (Bearer client credential) returns a bundle signed by
// the server's issuer key, which is handed to the agent as is; the agent checks the signatures against the root keys
// compiled into it, so this code never decides what is trusted.

const { clientHeaders } = require("./client-info");
const { requestJson, HttpError } = require("./http");
const { readCredentials } = require("./config-writer");

/**
 * Fetches the tunnel configuration of the signed-in account and gives it to the agent (or clears it when the server
 * has no tunnel). Resolves { status: "ok" | "disabled" | "signed-out" | "unauthorized" | "error" }; never rejects.
 */
async function syncTunnel(agentDir, agent, { signal } = {}) {
  const creds = await readCredentials(agentDir);
  if (!creds) return { status: "signed-out" };
  let res;
  try {
    res = await requestJson({
      url: `${String(creds.baseUrl).replace(/\/+$/, "")}/api/device/tunnel`,
      headers: clientHeaders(creds.clientSecret),
      signal,
      timeoutMs: 15000,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: "error" };
  }
  if (res.status === 401) return { status: "unauthorized" };
  const data = res.status === 200 && res.json && res.json.success === true ? res.json.data : null;
  if (!data) return { status: "error" };
  try {
    if (data.enabled && data.bundle) {
      await agent.setTunnel(data.bundle);
      return { status: "ok" };
    }
    await agent.clearTunnel();
    return { status: "disabled" };
  } catch (err) {
    console.warn(`[cgs] tunnel configuration not applied: ${err instanceof Error ? err.message : err}`);
    return { status: "error" };
  }
}

module.exports = { syncTunnel };
