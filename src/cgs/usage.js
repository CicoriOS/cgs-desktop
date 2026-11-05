"use strict";
// Account usage: GET <baseUrl>/api/device/usage (Bearer apiKey) → { success, data: { tier, username, balance,
// subscriptions[], generated_at } }. Display strings ("$199.99") are formatted by the server like the web console.

const { requestJson, HttpError } = require("./http");
const { readCredentials } = require("./config-writer");
const { normalizeTier } = require("./state");

const RESET_PERIODS = ["never", "daily", "weekly", "monthly", "custom"];

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const str = (value) => (typeof value === "string" ? value : "");
const list = (value) => (Array.isArray(value) ? value : []);

function normalizeSubscription(raw) {
  const sub = raw && typeof raw === "object" ? raw : {};
  const amountTotal = Math.max(0, num(sub.amount_total));
  return {
    id: num(sub.id),
    planId: num(sub.plan_id),
    planTitle: str(sub.plan_title),
    amountTotal,
    amountUsed: Math.max(0, num(sub.amount_used)),
    totalDisplay: str(sub.amount_total_display),
    usedDisplay: str(sub.amount_used_display),
    unlimited: amountTotal === 0,
    resetPeriod: RESET_PERIODS.includes(sub.reset_period) ? sub.reset_period : "never",
    nextResetAt: num(sub.next_reset_at),
    startTime: num(sub.start_time),
    endTime: num(sub.end_time),
    dailyTokenLimits: list(sub.daily_token_limits)
      .filter((limit) => limit && typeof limit === "object" && str(limit.model))
      .map((limit) => ({ model: limit.model, limit: Math.max(0, num(limit.limit)), used: Math.max(0, num(limit.used)), resetAt: num(limit.reset_at) })),
  };
}

/** The `data` object of a usage response → the shape the UI consumes (camelCase, every field present). */
function normalizeUsage(data) {
  if (!data || typeof data !== "object") return null;
  const balance = data.balance && typeof data.balance === "object" ? data.balance : {};
  return {
    tier: normalizeTier(data.tier),
    username: str(data.username) || null,
    balance: { quota: num(balance.quota), usedQuota: num(balance.used_quota), display: str(balance.display) },
    subscriptions: list(data.subscriptions).map(normalizeSubscription),
    generatedAt: num(data.generated_at),
  };
}

/**
 * One usage request. Resolves { status: "ok", usage } | { status: "unauthorized" } | { status: "error" }.
 * Network failures, timeouts, 5xx and malformed bodies are all "error" (the caller keeps its last value).
 */
async function fetchUsage({ baseUrl, apiKey, signal }) {
  let res;
  try {
    res = await requestJson({
      url: `${String(baseUrl).replace(/\/+$/, "")}/api/device/usage`,
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
      timeoutMs: 15000,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: "error" };
  }
  if (res.status === 401) return { status: "unauthorized" };
  const usage = res.status === 200 && res.json && res.json.success === true ? normalizeUsage(res.json.data) : null;
  return usage ? { status: "ok", usage } : { status: "error" };
}

/** Usage of the account saved in <agentDir>; { status: "signed-out" } when there are no credentials. */
async function refreshUsage(agentDir, { signal } = {}) {
  const creds = await readCredentials(agentDir);
  if (!creds) return { status: "signed-out" };
  return fetchUsage({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, signal });
}

module.exports = { fetchUsage, refreshUsage, normalizeUsage };
