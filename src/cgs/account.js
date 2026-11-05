"use strict";
// Server-side account actions that are not part of the login flow: revoking the device key, the web console URL.

const { requestJson, HttpError } = require("./http");

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * POST <baseUrl>/api/device/logout (Bearer apiKey): the server deletes exactly this key.
 * Resolves { status: "revoked" } (200) | { status: "already-revoked" } (401: the key is already gone, which is the
 * outcome a logout wants) | { status: "error", detail } (network failure, timeout, 5xx, anything else). Never rejects.
 */
async function revokeDeviceKey({ baseUrl, apiKey, signal, timeoutMs = REVOKE_TIMEOUT_MS }) {
  let res;
  try {
    res = await requestJson({
      method: "POST",
      url: `${String(baseUrl).replace(/\/+$/, "")}/api/device/logout`,
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
      timeoutMs,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: "error", detail: err.kind };
  }
  if (res.status === 200) return { status: "revoked" };
  if (res.status === 401) return { status: "already-revoked" };
  return { status: "error", detail: `HTTP ${res.status}` };
}

/**
 * The new-api web console, opened by 「打开 CGS 后台」. `/dashboard` is the authenticated layout's landing route
 * (web/src/routes/_authenticated/dashboard/index.tsx redirects it to the default section; signed-out visitors are sent to
 * the sign-in page and back).
 */
function consoleUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}/dashboard`;
}

module.exports = { revokeDeviceKey, consoleUrl, REVOKE_TIMEOUT_MS };
