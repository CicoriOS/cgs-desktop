// Bootstrap the CLI before starting the sidecar (ADR 0052). Reuse existing copies; on first install let Bun resolve the
// registry's default release. Compatibility is decided by the RPC handshake, not the package version.
import { spawn as defaultSpawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BunInstallError, installBun } from "./bun-install.mjs";
import { bunCandidates, cgsCandidates, withBunPath } from "./platform.mjs";
import { runProcess } from "./run-process.mjs";
import { createToolchain, ToolchainError } from "./toolchain/install.mjs";
import { loadManifest } from "./toolchain/manifest.mjs";
import { createRacer, proxyEnv, proxyUrlFromPac } from "./toolchain/network.mjs";

/** A full `cgs --version` answer, or a bare version: both are accepted. */
const VERSION_TEXT = /(?:^|\s|\/)cgs\/(\S+)|^(\d+\.\d+\.\d+-cgs\.[0-9]+(?:\.[0-9]+)?)$/m;
const CLI_PACKAGE = "@cicori/cgs";
const INSTALL_COMMAND = `bun add -g ${CLI_PACKAGE}`;
const VERSION_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const DAEMON_STOP_TIMEOUT_MS = 20_000;
const DAEMON_EXIT_WAIT_MS = 8_000;
const PROGRESS_LINES = 40;
const LINE_CHARS = 300;

const REAL_FS = {
  statSync: (...args) => fs.statSync(...args),
  accessSync: (...args) => fs.accessSync(...args),
  realpathSync: (...args) => fs.realpathSync(...args),
  existsSync: (...args) => fs.existsSync(...args),
  readFileSync: (...args) => fs.readFileSync(...args),
  mkdirSync: (...args) => fs.mkdirSync(...args),
  writeFileSync: (...args) => fs.writeFileSync(...args),
  renameSync: (...args) => fs.renameSync(...args),
};

/** `<config root>/desktop.json`: the marker `cgs update` reads (cgsconnect/local-channel.md §10). */
export function markerPath({ home = os.homedir(), env = process.env } = {}) {
  return path.join(home, env.PI_CONFIG_DIR?.trim() || ".cgs", "desktop.json");
}

/** The daemon's runtime directory: `CGS_DAEMON_DIR`, else `<config root>/run/daemon` (P18). */
export function daemonDir({ home = os.homedir(), env = process.env } = {}) {
  return env.CGS_DAEMON_DIR?.trim() || path.join(home, env.PI_CONFIG_DIR?.trim() || ".cgs", "run", "daemon");
}

/** The version in a `cgs --version` answer (`cgs/19.2.1-cgs.5.4`), or undefined. */
export function parseVersionOutput(output) {
  if (typeof output !== "string") return undefined;
  const match = VERSION_TEXT.exec(output);
  return match ? (match[1] ?? match[2]) : undefined;
}

function isFile(candidate, io, platform) {
  try {
    if (!io.statSync(candidate).isFile()) return false;
    if (platform !== "win32") io.accessSync(candidate, 1); // X_OK
    return true;
  } catch {
    return false;
  }
}

function realpathOf(candidate, io) {
  try {
    return io.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function isInside(real, root, platform) {
  const [a, b] = platform === "win32" ? [real.toLowerCase(), root.toLowerCase()] : [real, root];
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
}

/**
 * Every executable `cgs` on this machine, deduplicated by real file, in `platform.mjs` resolution order: `CGS_BIN`,
 * `$BUN_INSTALL/bin`, `~/.bun/bin`, then PATH (first PATH match wins for the sidecar). `bunGlobal` is true only for a copy
 * whose real path is inside the bun install directory.
 */
export function inspectInstall({ env = process.env, platform = process.platform, home = os.homedir(), fs: fsOverride } = {}) {
  const io = { ...REAL_FS, ...fsOverride };
  const bunRoot = realpathOf(env.BUN_INSTALL?.trim() || path.join(home, ".bun"), io);
  const bunBin = path.join(env.BUN_INSTALL?.trim() || path.join(home, ".bun"), "bin");
  const explicit = env.CGS_BIN?.trim();
  const entries = [];
  const byReal = new Map();
  for (const candidate of cgsCandidates({ env, platform, home })) {
    if (!isFile(candidate, io, platform)) continue;
    const real = realpathOf(candidate, io);
    const known = byReal.get(real);
    if (known) {
      known.paths.push(candidate);
      continue;
    }
    const entry = {
      path: candidate,
      real,
      bunGlobal: isInside(real, bunRoot, platform),
      explicit: Boolean(explicit) && candidate === explicit,
      source: candidate === explicit ? "env" : path.dirname(candidate) === bunBin ? "bun" : "path",
      paths: [candidate],
    };
    byReal.set(real, entry);
    entries.push(entry);
  }
  const winner = entries[0];
  return {
    winner,
    entries,
    /** Copies the sidecar will not use; also the diagnosis shown when versions disagree. */
    shadowed: entries.slice(1).map((entry) => entry.path),
  };
}

/** The first executable bun, from the same lookup order (`$BUN_INSTALL/bin`, `~/.bun/bin`, PATH). */
export function inspectBun({ env = process.env, platform = process.platform, home = os.homedir(), fs: fsOverride } = {}) {
  const io = { ...REAL_FS, ...fsOverride };
  return bunCandidates({ env, platform, home }).find((candidate) => isFile(candidate, io, platform));
}

/**
 * Reuse the found copy, or install the CLI if missing.
 * `found` is an `inspectInstall().winner`; `installed` the version read from it (undefined when unreadable).
 */
export function planCliSync({ found, installed, bun, explicit = false }) {
  if (!found) return bun ? { action: "install" } : { action: "error", code: "bun_missing" };
  if (explicit) return { action: "use" };
  if (!installed) return { action: "error", code: "version_unreadable" };
  return { action: "use" };
}

/** Offline failures get their own page; everything else is an install failure with the log tail. */
export function classifyInstallFailure(text) {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_SOCKET|fetch failed|failed to fetch|network|no such host|unable to connect/i.test(text)
    ? "offline"
    : "install_failed";
}

/** Reads `cgs --version`; `{version?, log}` — the log is the answer plus the failure text for the error page. */
export async function readCgsVersion({ cgs, spawn, env, platform, timeoutMs = VERSION_TIMEOUT_MS }) {
  const result = await runProcess({ spawn, command: cgs, args: ["--version"], env, platform, timeoutMs });
  const version = parseVersionOutput(result.stdout) ?? parseVersionOutput(result.stderr);
  const log = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return { version, log };
}

/**
 * Whether a daemon is listening. A lock file on its own is stale after a crash, so the socket is probed; the files are
 * only a cheap pre-check. Nothing is spawned and no process is signalled.
 */
export async function detectDaemon({ home = os.homedir(), env = process.env, fs: fsOverride, platform = process.platform, probe } = {}) {
  const io = { ...REAL_FS, ...fsOverride };
  const dir = daemonDir({ home, env });
  const socket = path.join(dir, "daemon.sock");
  const lock = path.join(dir, "daemon.lock");
  const db = path.join(dir, "daemon.db");
  if (!io.existsSync(lock) || !io.existsSync(db)) return { running: false, dir };
  const connected = await (probe ?? probeSocket)(socket, platform);
  return { running: connected, dir, socket };
}

function probeSocket(socket, platform = process.platform, timeoutMs = 500) {
  if (platform === "win32") return Promise.resolve(false); // named pipes: not supported until Windows is wired (ADR 0046 §9)
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const client = net.connect(socket);
    const timer = setTimeout(() => done(false), timeoutMs);
    client.once("connect", () => done(true));
    client.once("error", () => done(false));
  });
}

async function waitForDaemonExit({ home, env, platform = process.platform, timeoutMs = DAEMON_EXIT_WAIT_MS }) {
  const socket = path.join(daemonDir({ home, env }), "daemon.sock");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await probeSocket(socket, platform))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Stops the daemon started by the old CLI, using the new CLI's hosted module (local-channel.md §10). The daemon stops its
 * units itself; no unrelated process is killed. When this cannot run, the new sidecar's daemon client re-execs the older
 * daemon on first connect instead.
 */
export async function stopDaemon({ cgs, home, env, spawn, fs: fsOverride, platform }) {
  const io = { ...REAL_FS, ...fsOverride };
  const root = path.resolve(path.dirname(realpathOf(cgs, io)), "..");
  const control = path.join(root, "packages", "connect", "src", "desktop", "daemon-control.ts");
  if (!io.existsSync(control)) return { stopped: false, reason: "control_missing", log: `missing ${control}` };
  const result = await runProcess({
    spawn,
    command: cgs,
    args: ["__cgs_worker_module", control, "shutdown"],
    env,
    platform,
    timeoutMs: DAEMON_STOP_TIMEOUT_MS,
  });
  const log = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (result.code !== 0) return { stopped: false, reason: result.timedOut ? "timeout" : "failed", log };
  const exited = await waitForDaemonExit({ home, env, platform });
  return { stopped: exited, reason: exited ? undefined : "still_listening", log };
}

/** The desktop executable the marker points at. An AppImage's own path is `APPIMAGE`; `execPath` is its mount point,
 * which is gone once the app exits, and a marker pointing there would stop deferring to the desktop. */
export function desktopExecutable({ app, env = process.env } = {}) {
  const appImage = env.APPIMAGE?.trim();
  if (appImage) return appImage;
  return app?.getPath?.("exe") ?? process.execPath;
}

/** Writes the marker `cgs update` reads. Atomic: a half-written marker would hide the desktop from the CLI. */
export function writeMarker({ home, env, version, desktop, fs: fsOverride } = {}) {
  const io = { ...REAL_FS, ...fsOverride };
  const file = markerPath({ home, env });
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    io.writeFileSync(tmp, `${JSON.stringify({ desktop, version })}\n`);
    io.renameSync(tmp, file);
    return file;
  } catch {
    return undefined; // the marker is a convenience for `cgs update`; the sidecar runs without it
  }
}

/** One top-level field of package.json, or undefined. */
function packageField(name) {
  try {
    const file = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed[name] : undefined;
  } catch {
    return undefined;
  }
}

const RESTART_TEXT = {
  zh: {
    title: "升级 CGS 需要重启本机服务",
    body: "正在运行的会话会被中断。",
    detail: "本机已有旧版本的 CGS 在后台运行。继续升级会停止它，之后由新版本重新启动。",
    ok: "升级并重启",
    cancel: "取消",
  },
  en: {
    title: "Upgrading CGS restarts the local service",
    body: "Running sessions will be interrupted.",
    detail: "An older CGS is running in the background. Continuing stops it; the new version starts it again.",
    ok: "Upgrade and restart",
    cancel: "Cancel",
  },
};

/**
 * `confirmRestart` for `createCliSync`: a native dialog (this runs before any page can show one). The session count is
 * not asked for: the sync runs before the sidecar, and `/api/children` is not reachable yet (local-channel.md §10).
 */
export function restartConfirmer({ app, dialog }) {
  return async () => {
    const lang = app?.getPreferredSystemLanguages?.()[0] ?? "";
    const texts = /^zh(?:[-_]|$)/i.test(lang) ? RESTART_TEXT.zh : RESTART_TEXT.en;
    const answer = await dialog.showMessageBox({
      type: "warning",
      buttons: [texts.ok, texts.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: texts.title,
      message: texts.body,
      detail: texts.detail,
    });
    return answer.response === 0;
  };
}

const tail = (lines, count = PROGRESS_LINES) => lines.slice(-count);
const clip = (line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line);

/**
 * The startup synchronisation. `start()` resolves with the final state; only `phase: "ready"` means the sidecar may start,
 * and then with `state.cgs` as the CLI (undefined when `CGS_SIDECAR` or `?demo` bypasses the CLI).
 *
 * Everything it touches outside this module is injectable (`fs`, `spawn`, `spawn`, `confirmRestart`) so the tests cover the
 * plan and the install path with fake executables instead of a real bun.
 */
export function createCliSync({
  app,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  spawn = defaultSpawn,
  fs: fsOverride,
  confirmRestart,
  bunPin,
  fetch: fetchImpl,
  arch = process.arch,
  resolveProxy,
  toolchain: toolchainOverride,
  resourcesPath = process.resourcesPath,
} = {}) {
  const io = { ...REAL_FS, ...fsOverride };
  const pin = bunPin ?? packageField("bunInstall");
  let state = { phase: "checking", progress: [] };
  let inflight;
  const listeners = new Set();
  // Windows (ADR 0049): the toolchain downloads next to the CLI install; its components ride along on every state.
  const proxyFor = resolveProxy ? async (url) => proxyUrlFromPac(await resolveProxy(url)) : undefined;
  const toolchain =
    toolchainOverride ??
    (platform === "win32" && !env.CGS_SIDECAR
      ? createToolchain({
          env,
          home,
          resourcesPath,
          fetch: fetchImpl,
          proxyFor,
          spawn,
          fs: fsOverride ? { ...fs, ...fsOverride } : fs,
        })
      : undefined);
  const racer = createRacer({ fetch: fetchImpl ?? ((...args) => globalThis.fetch(...args)) });

  // While the toolchain is still being prepared, `ready` is held back: the sidecar must not start before the tools it needs exist.
  let gate;
  let held;
  const set = (next) => {
    if (gate && next.phase === "ready") {
      held = next;
      return next;
    }
    state = toolchain && next.phase !== "ready" ? { ...next, components: toolchain.components() } : next;
    for (const listener of listeners) listener(state);
    return state;
  };
  toolchain?.subscribe(() => {
    if (!gate) return;
    set({ ...state, phase: "installing", progress: state.progress ?? [] });
  });
  const progress = (line) => {
    const lines = tail([...(state.progress ?? []), clip(line)]);
    set({ ...state, phase: "installing", progress: lines });
  };

  const fail = (code, detail, log) =>
    set({
      phase: "error",
      code,
      detail,
      progress: state.progress,
      log: log ? tail(String(log).split("\n").map(clip), 30).join("\n") : undefined,
      shadowed: state.shadowed,
    });

  async function run() {
    state = { phase: "checking", progress: [] };
    for (const listener of listeners) listener(state);
    if (!toolchain || env.CGS_SIDECAR) return runCli();
    held = undefined;
    let toolchainError;
    gate = toolchain.ensure().then(
      (result) => result,
      (error) => {
        toolchainError = error;
      },
    );
    const outcome = await runCli();
    const ready = held;
    held = undefined;
    const pending = gate;
    if (outcome.phase !== "ready" && !ready) {
      gate = undefined;
      return outcome;
    }
    const done = await pending;
    gate = undefined;
    if (toolchainError) {
      const error = toolchainError;
      return fail(error instanceof ToolchainError ? error.code : "toolchain_failed", `${error.message}`, error.log);
    }
    set(ready ?? outcome);
    done?.pip?.then((pip) => {
      if (!pip.ok) console.warn(`pip packages were not installed: ${pip.log ?? ""}`);
    });
    return state;
  }

  async function runCli() {
    state = { phase: "checking", progress: [] };
    for (const listener of listeners) listener(state);
    if (env.CGS_SIDECAR) return set({ phase: "ready", progress: [], bypassed: true });
    const inspection = inspectInstall({ env, platform, home, fs: io });
    const found = inspection.winner;
    const explicit = Boolean(env.CGS_BIN?.trim());
    if (explicit && !found) {
      return fail("cgs_not_found", `CGS_BIN=${env.CGS_BIN} is not an executable file.`);
    }
    let bun = inspectBun({ env, platform, home, fs: io });
    // Windows: the installer ships a bun (ADR 0049 §1); the user's own bun, found above, still wins (ADR 0046 §3).
    if (!bun && toolchain?.bun && io.existsSync(toolchain.bun)) bun = toolchain.bun;
    let childEnv = withBunPath(env, bun, platform);
    let installed;
    let versionLog;
    if (found) {
      const read = await readCgsVersion({ cgs: found.path, spawn, env: childEnv, platform });
      installed = read.version;
      versionLog = read.log;
    }
    let plan = planCliSync({ found, installed, bun, explicit });
    const common = {
      progress: [],
      cgs: found?.path,
      version: installed,
      shadowed: inspection.shadowed,
    };
    if (plan.action === "error" && plan.code === "bun_missing") {
      // No bun anywhere: fetch the pinned one. Where it cannot be fetched (unsupported platform) the page keeps the manual instructions.
      set({ ...common, phase: "installing", progress: ["bun was not found; installing it"] });
      try {
        bun = await installBun({ pin, env, platform, arch, home, fetch: fetchImpl ?? ((...args) => globalThis.fetch(...args)), onProgress: progress });
      } catch (error) {
        if (error instanceof BunInstallError && error.code === "bun_unsupported") bun = undefined;
        else if (error instanceof BunInstallError) return fail(error.code, "bun could not be installed.", error.message);
        else throw error;
      }
      if (bun) {
        childEnv = withBunPath(env, bun, platform);
        const check = await runProcess({ spawn, command: bun, args: ["--version"], env: childEnv, platform, timeoutMs: VERSION_TIMEOUT_MS });
        if (check.code !== 0) {
          // A bun that does not run (a wrong CPU build) must not stay: the next start would find it and fail inside `bun add`.
          try {
            fs.rmSync(bun, { force: true });
          } catch {
            /* nothing more to do */
          }
          return fail("bun_install_failed", "The downloaded bun does not run on this machine.", [check.stdout, check.stderr, check.error].filter(Boolean).join("\n"));
        }
        plan = planCliSync({ found, installed, bun, explicit });
      }
    }
    if (plan.action === "error") {
      const detail =
        plan.code === "bun_missing"
          ? `bun was not found; checked ${[...new Set(bunCandidates({ env, platform, home }).map((item) => path.dirname(item)))].join(", ")}. Install bun (https://bun.sh) and try again, or run ${INSTALL_COMMAND}.`
          : `Could not read the version of ${found?.path ?? "cgs"}.\n${versionLog ?? ""}`;
      return set({ ...common, phase: "error", code: plan.code, detail });
    }
    if (plan.action === "use") {
      if (found?.bunGlobal && !explicit) writeMarker({ home, env, version: app?.getVersion?.() ?? "0.0.0", desktop: desktopExecutable({ app, env }), fs: io });
      return set({ ...common, phase: "ready", managed: Boolean(found?.bunGlobal) && !explicit });
    }

    // An orphaned daemon can outlive the CLI executable.
    set({ ...common, phase: "installing", progress: [INSTALL_COMMAND] });
    const daemon = await detectDaemon({ home, env, fs: io, platform });
    if (daemon.running) {
      const accepted = confirmRestart ? await confirmRestart({ dir: daemon.dir }) : true;
      if (!accepted) return fail("restart_cancelled", "The CLI was not updated because the running local service was not allowed to restart.");
    }
    // Windows: the npm registry is raced, and the system proxy is handed to bun (ADR 0049 §2, §4). A registry the user configured for
    // the @cicori scope in bunfig.toml still wins over this default.
    let installEnv = childEnv;
    if (toolchain) {
      const registries = loadManifest({ env }).cgs.registries;
      const order = await racer.order("cgs-registry", registries, (registry) => `${registry}/@cicori%2Fcgs/latest`);
      const proxy = await proxyFor?.(order[0]);
      installEnv = { ...childEnv, BUN_CONFIG_REGISTRY: order[0], ...proxyEnv(proxy) };
    }
    const result = await runProcess({
      spawn,
      command: bun,
      args: ["add", "-g", CLI_PACKAGE],
      env: installEnv,
      platform,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onLine: progress,
    });
    if (result.code !== 0) {
      const log = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
      return fail(result.timedOut ? "install_failed" : classifyInstallFailure(log), `${INSTALL_COMMAND} failed${result.timedOut ? " (timeout)" : ""}.`, log);
    }
    if (daemon.running) {
      progress("stopping the local service");
      const stop = await stopDaemon({ cgs: inspectInstall({ env, platform, home, fs: io }).winner?.path, home, env: childEnv, spawn, fs: io, platform });
      progress(stop.stopped ? "local service stopped" : `local service not stopped (${stop.reason}); the new sidecar will restart it`);
    }
    const after = inspectInstall({ env, platform, home, fs: io });
    const read = after.winner ? await readCgsVersion({ cgs: after.winner.path, spawn, env: childEnv, platform }) : { version: undefined, log: "cgs not found after install" };
    if (!read.version) {
      return set({
        ...common,
        phase: "error",
        code: "install_unverified",
        cgs: after.winner?.path,
        version: read.version,
        progress: state.progress,
        detail: `Could not verify the CLI at ${after.winner?.path ?? "no path"}.`,
        log: read.log,
      });
    }
    writeMarker({ home, env, version: app?.getVersion?.() ?? "0.0.0", desktop: desktopExecutable({ app, env }), fs: io });
    return set({
      phase: "ready",
      progress: state.progress,
      cgs: after.winner.path,
      version: read.version,
      managed: true,
      shadowed: after.shadowed,
    });
  }

  const start = async () => {
    inflight ??= run().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return {
    /** Current state; the first call of `start()` runs the sync. */
    state: () => state,
    start,
    retry() {
      if (!inflight) void start();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** `shell` IPC: mirrored in desktop/preload.cjs and cgsconnect/local-channel.md §8. */
export const SHELL_SYNC = "cgs:shell:sync";

export function registerCliSyncIpc(ipcMain, sync) {
  ipcMain.handle(SHELL_SYNC, () => sync.state());
  ipcMain.on("cgs:shell:retry", () => sync.retry());
}
