"use strict";
// The CGS agent (cgs-agent, built from new-api's tunnelkit): a local process that serves the CGS API over a Unix socket
// (a named pipe on Windows) and forwards every request to the API server, directly while that works and through the
// relay tunnel when it does not. omp, this main process and the in-app console all reach CGS through it; it opens no
// TCP port.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const READY_TIMEOUT_MS = 15_000;
const RESTART_DELAY_MS = 1_000;
const CONTROL = "/_cgs-agent/v1";

/**
 * Where the agent listens. Windows: a per-installation named pipe. Elsewhere: a socket in $XDG_RUNTIME_DIR when set
 * (user-private by definition), else under userData.
 */
function agentSocketPath({ userData, platform = process.platform, env = process.env }) {
  const id = crypto.createHash("sha256").update(userData).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\cgs-agent-${id}`;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, `cgs-desktop-${id}`, "agent.sock");
  return path.join(userData, "run", "agent.sock");
}

/** One request to the agent; resolves { status, text, json }. */
function agentCall(socketPath, { method = "GET", path: urlPath, body, signal, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        signal,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("agent request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The agent's control endpoints. */
class AgentClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
  }

  /** Current status, or (with `after`) the first status newer than that version (the agent answers within 25 s). */
  async status({ after, signal } = {}) {
    const query = after === undefined ? "" : `?after=${after}`;
    const res = await agentCall(this.socketPath, { path: `${CONTROL}/status${query}`, signal, timeoutMs: 35_000 });
    if (res.status !== 200 || !res.json) throw new Error(`agent status: HTTP ${res.status}`);
    return res.json;
  }

  /** Hands the agent a tunnel bundle; it verifies the signatures itself. */
  async setTunnel(bundle) {
    const res = await agentCall(this.socketPath, { method: "PUT", path: `${CONTROL}/tunnel`, body: bundle });
    if (res.status !== 200) throw new Error(`agent refused the tunnel configuration: ${res.text.trim()}`);
  }

  async clearTunnel() {
    const res = await agentCall(this.socketPath, { method: "DELETE", path: `${CONTROL}/tunnel` });
    if (res.status !== 204) throw new Error(`agent tunnel reset: HTTP ${res.status}`);
  }

  /**
   * Calls `onStatus(status)` with the first status and every change after it, until the returned stop function
   * is called. Errors (agent restarting) are retried after a short pause.
   */
  watch(onStatus) {
    const abort = new AbortController();
    let after;
    const loop = async () => {
      while (!abort.signal.aborted) {
        try {
          const status = await this.status({ after, signal: abort.signal });
          if (after === undefined || status.version > after) onStatus(status);
          after = status.version;
        } catch {
          if (abort.signal.aborted) return;
          after = undefined; // a restarted agent counts versions from zero
          await new Promise((r) => setTimeout(r, RESTART_DELAY_MS).unref());
        }
      }
    };
    void loop();
    return () => abort.abort();
  }
}

/**
 * Starts the agent and keeps it running: it is restarted (after a second) whenever it exits while not stopped.
 * Resolves once the first instance reports ready.
 */
async function startAgent({ binary, socketPath, upstream, dataDir, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (!socketPath.startsWith("\\\\.\\pipe\\")) fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  let stopped = false;
  let child = null;
  let firstReady;
  const ready = new Promise((resolve, reject) => (firstReady = { resolve, reject }));

  const launch = () => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} cgs-agent -listen ${socketPath} -upstream ${upstream} ===\n`);
    child = spawn(binary, ["-listen", socketPath, "-upstream", upstream, "-data-dir", dataDir, "-exit-on-stdin-eof"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      out += chunk.toString("utf8");
      if (/ready on/.test(out)) firstReady.resolve();
    });
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.once("error", (error) => {
      log.write(`spawn error: ${error.message}\n`);
      firstReady.reject(error);
    });
    child.once("exit", (code, signal) => {
      log.end(`=== exited code=${code} signal=${signal} ===\n`);
      if (stopped) return;
      firstReady.reject(new Error(`cgs-agent exited (code ${code ?? signal}) before it was ready; see ${logFile}`));
      setTimeout(() => !stopped && launch(), RESTART_DELAY_MS).unref();
    });
  };

  launch();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`cgs-agent did not start within ${READY_TIMEOUT_MS / 1000}s; see ${logFile}`)), READY_TIMEOUT_MS).unref(),
  );
  const stop = () => {
    stopped = true;
    // Closing stdin makes the agent shut down cleanly; kill() is the fallback.
    child?.stdin.end();
    setTimeout(() => child?.kill(), 2_000).unref();
  };
  try {
    await Promise.race([ready, timeout]);
  } catch (error) {
    stop();
    throw error;
  }
  return { client: new AgentClient(socketPath), stop };
}

module.exports = { agentSocketPath, agentCall, AgentClient, startAgent };
