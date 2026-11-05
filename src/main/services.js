"use strict";
// Spawns and supervises the two upstream processes: `ompweb` (the web server) and `ompweb host` (the session daemon).
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const READY_TIMEOUT_MS = 60_000;
const TAIL_BYTES = 4096;

/** vendor/<target> name for the platform the app is running on (dev only). */
function devTarget() {
  if (process.platform === "win32" && process.arch === "x64") return "win-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  throw new Error(`No upstream binaries are available for ${process.platform}-${process.arch}`);
}

/**
 * Locates the bundled binaries.
 * Packaged: <resources>/omp/omp.exe, <resources>/ompweb/ompweb.exe, <resources>/chromium/chrome-win64/chrome.exe.
 * Dev: vendor/<target>/ (npm run fetch / fetch:linux).
 */
function resolveBinaries({ isPackaged, resourcesPath, appRoot }) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const base = isPackaged ? resourcesPath : path.join(appRoot, "vendor", devTarget());
  const omp = path.join(base, "omp", `omp${exe}`);
  const ompweb = path.join(base, "ompweb", `ompweb${exe}`);
  const chrome = process.platform === "win32" ? path.join(base, "chromium", "chrome-win64", "chrome.exe") : path.join(base, "chromium", "chrome-linux64", "chrome");
  for (const file of [omp, ompweb, chrome]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing bundled binary: ${file}${isPackaged ? "" : "\nRun \"npm run fetch:linux\" (or \"npm run fetch\" on Windows) first."}`);
    }
  }
  return { omp, ompweb, chrome };
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function buildEnv({ agentDir, ompBin, chromeBin }) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  env[pathKey] = [path.dirname(ompBin), env[pathKey]].filter(Boolean).join(path.delimiter);
  env.PI_CODING_AGENT_DIR = agentDir;
  env.OMP_WEB_OMP_BIN = ompBin;
  // omp's browser tool drives Chromium via puppeteer-core. PUPPETEER_EXECUTABLE_PATH takes precedence over everything
  // (system Chrome/Edge lookup, the ~/.omp/puppeteer Chrome-for-Testing download), so the bundled build is the only
  // browser omp launches. Its headless profile is an omp-owned temp dir, never a system browser profile.
  env.PUPPETEER_EXECUTABLE_PATH = chromeBin;
  return env;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/**
 * Starts ompweb on a free loopback port, waits for its "Ready on" line, then starts `ompweb host`.
 * `onCrash(error)` is invoked once if either process dies while the services are meant to be running.
 * Returns { url, port, stop }.
 */
async function startServices({ binaries, agentDir, logDir, onCrash }) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const env = buildEnv({ agentDir, ompBin: binaries.omp, chromeBin: binaries.chrome });
  const cwd = path.dirname(binaries.ompweb);
  const port = await freeLoopbackPort();
  const children = [];
  let stopping = false;
  let crashReported = false;

  const stop = () => {
    stopping = true;
    for (const child of children) killTree(child);
  };

  function launch(name, args, { onLine } = {}) {
    const log = fs.createWriteStream(path.join(logDir, `${name}.log`), { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} ${path.basename(binaries.ompweb)} ${args.join(" ")} ===\n`);
    const child = spawn(binaries.ompweb, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let tail = "";
    const onData = (chunk) => {
      log.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES);
      if (onLine) onLine(tail);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const exited = new Promise((resolve) => {
      child.once("error", (error) => {
        log.write(`spawn error: ${error.message}\n`);
        tail += `\n${error.message}`;
        resolve({ code: null, signal: null, error });
      });
      child.once("exit", (code, signal) => {
        log.end(`\n=== exited code=${code} signal=${signal} ===\n`);
        resolve({ code, signal });
      });
    });
    return { child, exited, tail: () => tail, logFile: path.join(logDir, `${name}.log`) };
  }

  const describe = (name, result, proc) =>
    new Error(
      `${name} stopped unexpectedly (${result.error ? result.error.message : `exit code ${result.code ?? result.signal}`}).\n\n` +
        `${proc.tail().trim()}\n\nLog: ${proc.logFile}`,
    );

  const watch = (name, proc) => {
    proc.exited.then((result) => {
      if (stopping || crashReported) return;
      crashReported = true;
      stop();
      if (onCrash) onCrash(describe(name, result, proc));
    });
  };

  try {
    let markReady;
    const ready = new Promise((resolve) => (markReady = resolve));
    const web = launch("ompweb", ["--no-open", "-H", "127.0.0.1", "-p", String(port)], {
      onLine: (tail) => /Ready on/.test(tail) && markReady(),
    });
    const outcome = await Promise.race([
      ready.then(() => "ready"),
      web.exited.then((result) => ({ result })),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS).unref()),
    ]);
    if (outcome === "timeout") throw new Error(`ompweb did not report "Ready on" within ${READY_TIMEOUT_MS / 1000}s.\n\n${web.tail().trim()}\n\nLog: ${web.logFile}`);
    if (outcome !== "ready") throw describe("ompweb", outcome.result, web);
    watch("ompweb", web);

    const host = launch("host", ["host"]);
    watch("ompweb host", host);
  } catch (error) {
    stop();
    throw error;
  }

  return { url: `http://127.0.0.1:${port}/`, port, stop };
}

module.exports = { resolveBinaries, startServices, killTree };
