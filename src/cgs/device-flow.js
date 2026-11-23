"use strict";
// Client for the CGS device-login API (new-api): create session → proof of work →
// exchange for uuid/verification link → poll until approved / denied / expired.

const os = require("node:os");
const { osVersion } = require("./client-info");
const { requestJson, HttpError } = require("./http");
const { solvePow } = require("./pow");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_FAILURES = 5;

/** Error with a Simplified-Chinese message safe to show to the user. */
class CgsError extends Error {
  /**
   * @param {"network"|"timeout"|"rate_limited"|"server"|"bad_response"|"rejected"|"challenge_failed"|"denied"|"expired"|"aborted"|"models"|"layout"} code
   */
  constructor(code, userMessage, cause) {
    super(`${code}: ${userMessage}`, cause ? { cause } : undefined);
    this.name = "CgsError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

function abortedError() {
  return new CgsError("aborted", "已取消");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function trimBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

/** POST/GET a new-api endpoint and return its `data` (throws CgsError otherwise). */
async function callApi(baseUrl, method, path, body, signal) {
  let res;
  try {
    res = await requestJson({ method, url: `${trimBase(baseUrl)}${path}`, body, signal });
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.kind === "aborted") throw abortedError();
      if (err.kind === "timeout") throw new CgsError("timeout", "连接服务器超时，请稍后重试", err);
      throw new CgsError("network", "无法连接到服务器，请检查网络连接后重试", err);
    }
    throw err;
  }
  if (res.status === 429) throw new CgsError("rate_limited", "请求过于频繁，请稍后再试");
  if (res.status >= 500) throw new CgsError("server", `服务器暂时不可用（HTTP ${res.status}），请稍后重试`);
  const env = res.json;
  if (!env || typeof env !== "object" || typeof env.success !== "boolean") {
    throw new CgsError("bad_response", "服务器返回了无法识别的响应");
  }
  if (!env.success) {
    const err = new CgsError("rejected", env.message ? `服务器拒绝了请求：${env.message}` : "服务器拒绝了请求");
    err.serverMessage = env.message || "";
    err.serverCode = typeof env.code === "string" ? env.code : "";
    throw err;
  }
  return env.data ?? {};
}

function isTransient(err) {
  return err instanceof CgsError && ["network", "timeout", "rate_limited", "server"].includes(err.code);
}

async function createSession({ baseUrl, deviceName, platform, appVersion, signal }) {
  const data = await callApi(
    baseUrl,
    "POST",
    "/api/device/sessions",
    { device_name: deviceName, platform, app_version: appVersion },
    signal,
  );
  const ch = data.challenge;
  if (
    typeof data.session_id !== "string" ||
    !data.session_id ||
    !ch ||
    typeof ch.prefix !== "string" ||
    !Number.isInteger(ch.difficulty) ||
    (ch.algorithm && ch.algorithm !== "sha256")
  ) {
    throw new CgsError("bad_response", "服务器返回了无法识别的安全校验参数");
  }
  return { sessionId: data.session_id, challenge: { prefix: ch.prefix, difficulty: ch.difficulty }, expiresIn: data.expires_in };
}

/**
 * The server builds the login link from its own configured address, which may differ from the host the desktop talks
 * to (the site's public name vs. the tunnel this build points at). The login page must open on the configured host, so
 * only the path and query of the link are kept.
 */
function rebaseUrl(link, baseUrl) {
  try {
    const target = new URL(link);
    return `${trimBase(baseUrl)}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return link;
  }
}

async function exchangeChallenge({ baseUrl, sessionId, nonce, signal }) {
  let data;
  try {
    data = await callApi(baseUrl, "POST", `/api/device/sessions/${encodeURIComponent(sessionId)}/challenge`, { nonce }, signal);
  } catch (err) {
    if (err instanceof CgsError && err.code === "rejected") {
      throw new CgsError("challenge_failed", "安全校验未通过或已过期，请重试", err);
    }
    throw err;
  }
  if (typeof data.uuid !== "string" || !data.uuid || typeof data.poll_token !== "string" || !data.poll_token || typeof data.verification_url !== "string") {
    throw new CgsError("bad_response", "服务器返回了无法识别的登录会话");
  }
  return {
    uuid: data.uuid,
    pollToken: data.poll_token,
    expiresAt: Number(data.expires_at) * 1000,
    verificationUrl: rebaseUrl(data.verification_url, baseUrl),
  };
}

/**
 * One poll. Returns { status: "pending" } | { status: "approved", clientSecret, tier, username } |
 * { status: "denied" } | { status: "expired" }.
 */
async function pollOnce({ baseUrl, uuid, pollToken, signal }) {
  let data;
  try {
    data = await callApi(baseUrl, "POST", `/api/device/sessions/${encodeURIComponent(uuid)}/poll`, { poll_token: pollToken }, signal);
  } catch (err) {
    // Unknown session / wrong token is indistinguishable from expiry.
    if (err instanceof CgsError && err.code === "rejected") return { status: "expired" };
    throw err;
  }
  switch (data.status) {
    case "pending":
    case "denied":
    case "expired":
      return { status: data.status };
    case "approved":
      if (typeof data.client_secret !== "string" || !data.client_secret) {
        throw new CgsError("bad_response", "服务器返回了无法识别的登录结果");
      }
      return {
        status: "approved",
        clientSecret: data.client_secret,
        tier: typeof data.tier === "string" ? data.tier : "free",
        username: typeof data.username === "string" ? data.username : "",
      };
    default:
      throw new CgsError("bad_response", "服务器返回了无法识别的登录状态");
  }
}

/**
 * Full flow. Resolves { clientSecret, tier, username }; rejects with CgsError (code "denied" | "expired" |
 * "aborted" | …). `onProgress` receives:
 *   { phase: "creating" } → { phase: "solving" } → { phase: "waiting", verificationUrl, uuid, expiresAt }
 */
async function runDeviceFlow({
  baseUrl,
  appVersion = "0.0.0",
  signal,
  onProgress = () => {},
  pollIntervalMs = POLL_INTERVAL_MS,
  deviceName = os.hostname(),
  platform = osVersion(),
} = {}) {
  throwIfAborted(signal);
  onProgress({ phase: "creating" });
  const session = await createSession({
    baseUrl,
    deviceName: String(deviceName || "unknown").slice(0, 64),
    platform: String(platform).slice(0, 64),
    appVersion: String(appVersion).slice(0, 32),
    signal,
  });

  onProgress({ phase: "solving" });
  let nonce;
  try {
    nonce = await solvePow(session.challenge, { signal });
  } catch (err) {
    if (err?.name === "AbortError") throw abortedError();
    throw new CgsError("challenge_failed", "安全校验失败，请重试", err);
  }
  const link = await exchangeChallenge({ baseUrl, sessionId: session.sessionId, nonce, signal });

  onProgress({ phase: "waiting", verificationUrl: link.verificationUrl, uuid: link.uuid, expiresAt: link.expiresAt });

  let failures = 0;
  for (;;) {
    await sleep(pollIntervalMs, signal);
    if (Date.now() > link.expiresAt + pollIntervalMs) throw new CgsError("expired", "登录链接已过期，请重新登录");
    let result;
    try {
      result = await pollOnce({ baseUrl, uuid: link.uuid, pollToken: link.pollToken, signal });
      failures = 0;
    } catch (err) {
      if (isTransient(err) && ++failures < MAX_POLL_FAILURES) continue;
      throw err;
    }
    if (result.status === "approved") return { clientSecret: result.clientSecret, tier: result.tier, username: result.username };
    if (result.status === "denied") throw new CgsError("denied", "登录请求已被拒绝");
    if (result.status === "expired") throw new CgsError("expired", "登录链接已过期，请重新登录");
  }
}

module.exports = { runDeviceFlow, createSession, exchangeChallenge, pollOnce, CgsError, POLL_INTERVAL_MS, callApi, sleep, throwIfAborted, abortedError };
