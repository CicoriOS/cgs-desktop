"use strict";
// Minimal JSON HTTP client on node:http/https that honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY
// (Node's global fetch ignores them) and supports AbortSignal.

const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

class HttpError extends Error {
  constructor(kind, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "HttpError";
    this.kind = kind; // "aborted" | "timeout" | "network"
  }
}

function envValue(env, ...names) {
  for (const n of names) {
    const v = env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function bypassProxy(hostname, port, noProxy) {
  const list = (noProxy || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  for (const entry of list) {
    if (entry === "*") return true;
    const [eh, ep] = entry.split(/:(?=\d+$)/);
    if (ep && Number(ep) !== Number(port)) continue;
    const bare = eh.replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** Proxy URL for `url` from the environment, or null. */
function proxyFor(url, env = process.env) {
  const u = url instanceof URL ? url : new URL(url);
  const port = u.port || (u.protocol === "https:" ? 443 : 80);
  if (bypassProxy(u.hostname, port, envValue(env, "NO_PROXY", "no_proxy"))) return null;
  const raw =
    u.protocol === "https:"
      ? envValue(env, "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
      : envValue(env, "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  if (!raw) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(cred).toString("base64")}`;
}

function connectTunnel(proxy, target, signal) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${target.hostname}:${target.port || 443}` };
    const auth = proxyAuthHeader(proxy);
    if (auth) headers["Proxy-Authorization"] = auth;
    const mod = proxy.protocol === "https:" ? https : http;
    const req = mod.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers,
      signal,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
      }
    });
    req.once("error", reject);
    req.end();
  });
}

/** Requests to `origin` go to the CGS agent's socket instead of the network (see agent.js); null until it runs. */
let agentRoute = null;

/** `{ origin, socketPath }` routes that origin through the agent; null stops routing. */
function routeThroughAgent(route) {
  agentRoute = route;
}

/**
 * requestJson({ method, url, headers, body, signal, timeoutMs, env })
 * → { status, text, json }  (json is null when the body is not JSON).
 * Rejects with HttpError for abort/timeout/network failures; never for HTTP status codes.
 */
async function requestJson({ method = "GET", url, headers = {}, body, signal, timeoutMs = 30000, env = process.env }) {
  if (signal?.aborted) throw new HttpError("aborted", "aborted");
  const target = new URL(url);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
  const reqHeaders = { Accept: "application/json", ...headers };
  if (payload) {
    reqHeaders["Content-Type"] = "application/json";
    reqHeaders["Content-Length"] = payload.length;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const viaAgent = agentRoute !== null && target.origin === agentRoute.origin;
    const proxy = viaAgent ? null : proxyFor(target, env);
    const isHttps = target.protocol === "https:";
    const options = { method, headers: reqHeaders, signal: controller.signal };
    let mod = isHttps ? https : http;
    if (viaAgent) {
      // The agent owns the connection to the server (direct or relay, proxies included); this is plain HTTP over IPC.
      mod = http;
      Object.assign(options, { socketPath: agentRoute.socketPath, path: target.pathname + target.search });
      reqHeaders.Host = target.host;
    } else if (!proxy) {
      Object.assign(options, { hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search });
    } else if (isHttps) {
      const socket = await connectTunnel(proxy, target, controller.signal);
      Object.assign(options, {
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        createConnection: () => tls.connect({ socket, servername: target.hostname }),
      });
    } else {
      mod = proxy.protocol === "https:" ? https : http;
      const auth = proxyAuthHeader(proxy);
      if (auth) reqHeaders["Proxy-Authorization"] = auth;
      Object.assign(options, {
        hostname: proxy.hostname,
        port: proxy.port || undefined,
        path: target.href,
      });
    }

    const { status, text } = await new Promise((resolve, reject) => {
      const req = mod.request(options, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status, text, json };
  } catch (err) {
    if (signal?.aborted) throw new HttpError("aborted", "aborted", err);
    if (timedOut) throw new HttpError("timeout", "timeout", err);
    if (err instanceof HttpError) throw err;
    throw new HttpError("network", err?.message || "network error", err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

module.exports = { requestJson, proxyFor, routeThroughAgent, HttpError };
