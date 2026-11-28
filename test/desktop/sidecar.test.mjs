// desktop/sidecar.mjs against a real child process (test/fixtures/fake-sidecar.mjs): handshake, frames, calls, crash and
// restart, protocol mismatch, shutdown. The fixture speaks the same JSONL the real sidecar will (local-channel.md §2).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { resolveSidecarCommand, sidecarModuleFor } from "../../desktop/platform.mjs";
import { createSidecar } from "../../desktop/sidecar.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "..", "fixtures", "fake-sidecar.mjs");
const running = [];
const dirs = [];

afterEach(async () => {
  for (const sidecar of running.splice(0)) await sidecar.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureSidecar(mode, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-sidecar-test-"));
  dirs.push(dir);
  const sidecar = createSidecar({
    command: process.execPath,
    args: [fixture, mode],
    logFile: path.join(dir, "sidecar.log"),
    restartBaseMs: 30,
    restartMaxMs: 200,
    handshakeTimeoutMs: 3000,
    ...options,
  });
  running.push(sidecar);
  return sidecar;
}

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("handshake, mux messages and calls go through", async () => {
  const sidecar = fixtureSidecar("serve");
  // Not ready: nothing is queued and calls fail fast.
  expect(sidecar.status).toBe("connecting");
  expect(sidecar.send({ type: "req", id: "early", path: "/api/info" })).toBe(false);
  await expect(sidecar.call("state")).rejects.toThrow("link_not_ready");

  sidecar.start();
  await waitFor(() => sidecar.status === "ready");

  const messages = [];
  sidecar.on("message", (message) => messages.push(message));
  expect(sidecar.send({ type: "req", id: "1", path: "/api/info" })).toBe(true);
  await waitFor(() => messages.length === 1);
  expect(messages[0]).toMatchObject({ type: "res", id: "1", status: 200, body: { cwd: "" } });

  await expect(sidecar.call("echo", { hi: 1 })).resolves.toEqual({ hi: 1 });
  await expect(sidecar.call("nope")).rejects.toThrow("unknown_method");
});

test("a crash rejects what was pending, reports down and restarts with backoff", async () => {
  const sidecar = fixtureSidecar("serve");
  const statuses = [];
  sidecar.on("status", (status) => statuses.push(status));
  sidecar.start();
  await waitFor(() => sidecar.status === "ready");

  const pending = sidecar.call("hang");
  pending.catch(() => {});
  expect(sidecar.send({ type: "crash" })).toBe(true);
  await expect(pending).rejects.toThrow("link_down");
  await waitFor(() => statuses.includes("down"));
  await waitFor(() => statuses.filter((status) => status === "ready").length >= 2);
  expect(sidecar.status).toBe("ready");
});

test("a protocol mismatch is final: upgrade, no fallback, no restart", async () => {
  const sidecar = fixtureSidecar("old");
  let upgradeDetail;
  sidecar.on("status", (status, detail) => {
    if (status === "upgrade") upgradeDetail = detail;
  });
  sidecar.start();
  await waitFor(() => sidecar.status === "upgrade");
  expect(upgradeDetail).toMatchObject({ protocol: 0, cli: "fake-0.0.1" });
  expect(sidecar.detail()).toMatchObject({ protocol: 0 });
  expect(sidecar.send({ type: "req", id: "1", path: "/api/info" })).toBe(false);
  await sleep(300);
  expect(sidecar.status).toBe("upgrade");
  expect(sidecar.logTail()).toContain("protocol mismatch");
  expect(readFileSync(path.join(dirs.at(-1), "sidecar.log"), "utf8")).toContain("protocol mismatch");
});

test("shutdown asks the sidecar to leave and does not restart it", async () => {
  const sidecar = fixtureSidecar("serve");
  sidecar.start();
  await waitFor(() => sidecar.status === "ready");
  await sidecar.shutdown();
  expect(sidecar.status).toBe("down");
  await sleep(200);
  expect(sidecar.status).toBe("down");
});

test("without a command the reason is exposed instead of a restart loop", async () => {
  const sidecar = createSidecar({ failure: { error: "cgs_not_found", log: "checked /a\nchecked /b" } });
  expect(sidecar.status).toBe("down");
  expect(sidecar.detail()).toMatchObject({ error: "cgs_not_found" });
  expect(sidecar.detail().log).toContain("checked /b");
  expect(sidecar.send({ type: "req", id: "1", path: "/api/info" })).toBe(false);
  await expect(sidecar.call("state")).rejects.toThrow("link_not_ready");
});

test("platform: CGS_SIDECAR overrides the command; broken JSON is reported", () => {
  expect(resolveSidecarCommand({ env: { CGS_SIDECAR: '["/bin/echo","a","b"]' } })).toMatchObject({ command: "/bin/echo", args: ["a", "b"], source: "env" });
  expect(resolveSidecarCommand({ env: { CGS_SIDECAR: "not json" } }).error).toBe("cgs_sidecar_invalid");
  expect(resolveSidecarCommand({ env: { CGS_SIDECAR: "[]" } }).error).toBe("cgs_sidecar_invalid");
});

test("platform: Windows finds the module in bun's global install, since cgs.exe is a shim and not a link", () => {
  const bin = path.join(os.tmpdir(), "no-such-bun", "bin");
  const installed = path.join(path.dirname(bin), "install", "global", "node_modules", "@cicori", "cgs", "packages", "connect", "src", "desktop", "sidecar.ts");
  const onlyInstalled = (p) => p === installed;
  expect(sidecarModuleFor(path.join(bin, "cgs.exe"), { platform: "win32", exists: onlyInstalled })).toBe(installed);
  expect(sidecarModuleFor(path.join(bin, "cgs.exe"), { platform: "linux", exists: onlyInstalled })).not.toBe(installed);
});

test("platform: a resolved cgs gets the P19 entry point; stale or missing installs are error codes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-platform-test-"));
  dirs.push(dir);
  const cgs = path.join(dir, "cgs");
  writeFileSync(cgs, "#!/bin/sh\nexit 0\n");
  chmodSync(cgs, 0o755);
  const resolved = resolveSidecarCommand({ env: { CGS_BIN: cgs }, exists: () => true });
  expect(resolved.command).toBe(cgs);
  expect(resolved.args[0]).toBe("__cgs_worker_module");
  expect(resolved.args[1].endsWith(path.join("packages", "connect", "src", "desktop", "sidecar.ts"))).toBe(true);

  expect(resolveSidecarCommand({ env: { CGS_BIN: cgs }, exists: () => false }).error).toBe("sidecar_missing");
  const absent = resolveSidecarCommand({ env: { PATH: "/definitely-not-here", HOME: dir }, home: dir });
  expect(absent.error).toBe("cgs_not_found");
  expect(absent.log).toContain("/definitely-not-here");
});
