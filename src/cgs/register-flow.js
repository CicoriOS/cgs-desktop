"use strict";
// Client for the desktop registration API (new-api /api/device/register/*), apart from the console's
// registration: create a session → proof of work → name the email (the server mails a 6-digit code) →
// submit code + password, which creates the account and signs this desktop in (a client credential).

const os = require("node:os");
const { osVersion } = require("./client-info");
const { callApi, CgsError, abortedError, throwIfAborted } = require("./device-flow");
const { solvePow } = require("./pow");

/** What each server error code means to the user. */
const MESSAGES = {
  registration_closed: "当前站点已关闭注册",
  email_taken: "该邮箱已被注册，请直接登录",
  email_invalid: "请输入有效的邮箱地址",
  email_restricted: "该邮箱不符合站点的邮箱规则",
  cooldown: "刚刚已向该邮箱发送过验证码，请稍后再试",
  code_invalid: "验证码不正确",
  too_many_attempts: "验证码错误次数过多，请重新获取",
  password_invalid: "密码长度需为 8 到 128 个字符",
  send_failed: "验证邮件发送失败，请稍后重试",
  session_expired: "验证码已过期，请重新获取",
  challenge_failed: "安全校验未通过，请重试",
};

/**
 * Codes that leave the registration unusable: the user has to ask for a new code. The others
 * (a wrong code, a bad address) can be corrected in place.
 */
const RESTART_CODES = new Set(["too_many_attempts", "session_expired", "challenge_failed", "registration_closed"]);

/** Turn a server rejection into a CgsError whose `code` is the server's (e.g. "code_invalid"). */
async function call(baseUrl, path, body, signal) {
  try {
    return await callApi(baseUrl, "POST", path, body, signal);
  } catch (err) {
    if (err instanceof CgsError && err.code === "rejected" && err.serverCode) {
      const mapped = new CgsError(err.serverCode, MESSAGES[err.serverCode] || err.userMessage, err);
      mapped.restart = RESTART_CODES.has(err.serverCode);
      throw mapped;
    }
    throw err;
  }
}

/**
 * Ask the server to mail a code to `email`. Resolves { sessionId, expiresAt, resendAt } (ms epochs).
 * `onProgress` receives { phase: "creating" | "solving" | "sending" }.
 */
async function requestRegisterCode({
  baseUrl,
  email,
  appVersion = "0.0.0",
  signal,
  onProgress = () => {},
  deviceName = os.hostname(),
  platform = osVersion(),
}) {
  throwIfAborted(signal);
  onProgress({ phase: "creating" });
  const data = await call(
    baseUrl,
    "/api/device/register/sessions",
    {
      device_name: String(deviceName || "unknown").slice(0, 64),
      platform: String(platform).slice(0, 64),
      app_version: String(appVersion).slice(0, 32),
    },
    signal,
  );
  const ch = data.challenge;
  if (typeof data.session_id !== "string" || !data.session_id || !ch || typeof ch.prefix !== "string" || !Number.isInteger(ch.difficulty) || (ch.algorithm && ch.algorithm !== "sha256")) {
    throw new CgsError("bad_response", "服务器返回了无法识别的安全校验参数");
  }

  onProgress({ phase: "solving" });
  let nonce;
  try {
    nonce = await solvePow({ prefix: ch.prefix, difficulty: ch.difficulty }, { signal });
  } catch (err) {
    if (err?.name === "AbortError") throw abortedError();
    throw new CgsError("challenge_failed", "安全校验失败，请重试", err);
  }

  onProgress({ phase: "sending" });
  const sent = await call(baseUrl, `/api/device/register/sessions/${encodeURIComponent(data.session_id)}/code`, { nonce, email }, signal);
  if (typeof sent.session_id !== "string" || !sent.session_id || !Number.isFinite(sent.expires_in)) {
    throw new CgsError("bad_response", "服务器返回了无法识别的注册会话");
  }
  const now = Date.now();
  return {
    sessionId: sent.session_id,
    expiresAt: now + sent.expires_in * 1000,
    resendAt: now + (Number.isFinite(sent.resend_in) ? sent.resend_in : 60) * 1000,
  };
}

/** Submit the code and password. Resolves { clientSecret, tier, username }. */
async function completeRegister({ baseUrl, sessionId, code, password, signal }) {
  const data = await call(baseUrl, `/api/device/register/sessions/${encodeURIComponent(sessionId)}/complete`, { code, password }, signal);
  if (typeof data.client_secret !== "string" || !data.client_secret) {
    throw new CgsError("bad_response", "服务器返回了无法识别的注册结果");
  }
  return {
    clientSecret: data.client_secret,
    tier: typeof data.tier === "string" ? data.tier : "free",
    username: typeof data.username === "string" ? data.username : "",
  };
}

module.exports = { requestRegisterCode, completeRegister, MESSAGES };
