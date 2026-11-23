"use strict";
// The bundled cgs-agent (vendor/<target>/cgs-agent, built by scripts/build-agent.mjs) serving this process's CGS requests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { agentSocketPath, startAgent } = require("../src/cgs/agent");
const { requestJson, routeThroughAgent } = require("../src/cgs/http");

const target = { linux: "linux-x64", win32: "win-x64" }[process.platform];
const binary = target && path.join(__dirname, "..", "vendor", target, "cgs-agent", process.platform === "win32" ? "cgs-agent.exe" : "cgs-agent");
const skip = !binary || !fs.existsSync(binary) ? "needs vendor/<target>/cgs-agent (npm run fetch*)" : false;

test("requests for the CGS origin reach the server through the agent's socket, others do not", { skip }, async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-CGS-Origin", "1");
    res.end(JSON.stringify({ success: true, data: { tier: "lite" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const upstream = `http://127.0.0.1:${server.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-agent-test-"));
  const socketPath = agentSocketPath({ userData: dir, env: {} });
  const agent = await startAgent({ binary, socketPath, upstream, dataDir: path.join(dir, "data"), logFile: path.join(dir, "agent.log") });
  t.after(() => {
    agent.stop();
    routeThroughAgent(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A different origin: the socket must not be used.
  routeThroughAgent({ origin: "https://cgs.invalid", socketPath });
  await requestJson({ url: `${upstream}/direct`, timeoutMs: 5000 });
  assert.deepEqual(seen, ["GET /direct "]);

  // Pointing the route at a dead socket proves the request did not go to the upstream TCP port itself.
  routeThroughAgent({ origin: upstream, socketPath: path.join(dir, "nothing.sock") });
  await assert.rejects(requestJson({ url: `${upstream}/x`, timeoutMs: 5000 }));

  routeThroughAgent({ origin: upstream, socketPath });
  const res = await requestJson({ url: `${upstream}/api/device/tier?a=1`, headers: { Authorization: "Bearer k" }, timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.tier, "lite");
  assert.equal(seen.at(-1), "GET /api/device/tier?a=1 Bearer k");

  const status = await agent.client.status();
  assert.equal(status.mode, "direct");
  assert.equal(status.tunnel_configured, false);
});
