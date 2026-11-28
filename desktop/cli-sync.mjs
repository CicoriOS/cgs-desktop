// CLI sync at startup (ADR 0046 §3): the desktop must not run without a CLI of the version it was built against, and the
// copy it runs must be the copy it can update. Runs before the sidecar; the sidecar starts only when this returns a cgs
// path. Installation is `bun add -g @cicori/cgs@<bound>` — the same result a user gets by hand, with bun's global manifest
// in step. Only a bun-global copy is ever overwritten; one somewhere else is used as-is when its version is acceptable and
// otherwise reported, never replaced.
//
// The version rule is ADR 0044: `<omp base>-cgs.<N>` or `<omp base>-cgs.<N>.<M>`. A newer major `N` than the bound one
// refuses to start (the app and the CLI speak different protocols); a newer `.M` in the same `N` is fine.
import { spawn as defaultSpawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BunInstallError, installBun } from "./bun-install.mjs";
import { bunCandidates, cgsCandidates, spawnOptions } from "./platform.mjs";

/** A full `cgs --version` answer, or a bare version: both are accepted. */
const VERSION_TEXT = /(?:^|\s|\/)cgs\/(\S+)|^(\d+\.\d+\.\d+-cgs\.[0-9]+(?:\.[0-9]+)?)$/m;
/** The CGS suffix is split off first: the omp base may itself carry a prerelease (`20.0.0-beta.1-cgs.6`). */
const VERSION_PARTS = /^(.+)-cgs\.([1-9]\d*)(?:\.([1-9]\d*))?$/;
const VERSION_BASE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
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

/** `19.2.1-cgs.5.4` -> `{ base: [19,2,1], major: 5, fix: 4 }`; undefined for anything else. */
export function parseCgsVersion(text) {
  if (typeof text !== "string") return undefined;
  const suffix = VERSION_PARTS.exec(text.trim());
  if (!suffix) return undefined;
  const base = VERSION_BASE.exec(suffix[1]);
  if (!base) return undefined;
  return { base: [Number(base[1]), Number(base[2]), Number(base[3])], major: Number(suffix[2]), fix: Number(suffix[3] ?? 0) };
}

/** The version in a `cgs --version` answer (`cgs/19.2.1-cgs.5.4`), or undefined. */
export function parseVersionOutput(output) {
  if (typeof output !== "string") return undefined;
  const match = VERSION_TEXT.exec(output);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * Order two CGS release versions (ADR 0044): the omp base first, then the major `N`, then the fix `.M` (absent means 0).
 * Throws on a version that is not `<x.y.z>-cgs.<N>[.<M>]`; callers treat that as an unreadable install.
 */
export function compareCgsVersions(left, right) {
  const a = parseCgsVersion(left);
  const b = parseCgsVersion(right);
  if (!a || !b) throw new TypeError(`not a CGS version: ${!a ? left : right}`);
  for (let i = 0; i < 3; i += 1) {
    if (a.base[i] !== b.base[i]) return a.base[i] < b.base[i] ? -1 : 1;
  }
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.fix !== b.fix) return a.fix < b.fix ? -1 : 1;
  return 0;
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
 * whose real path is inside the bun install directory — the one copy the desktop may overwrite.
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
 * What startup should do, from the found copy and the bound version. Pure: no IO, so the rules are testable alone.
 * `found` is an `inspectInstall().winner`; `installed` the version read from it (undefined when unreadable).
 */
export function planCliSync({ found, installed, bound, bun, explicit = false }) {
  if (!found) return bun ? { action: "install" } : { action: "error", code: "bun_missing" };
  if (explicit) return { action: "use" };
  if (!installed) return { action: "error", code: "version_unreadable" };
  const current = parseCgsVersion(installed);
  const target = parseCgsVersion(bound);
  if (!current || !target) return { action: "error", code: "version_unreadable" };
  // A newer major is a different protocol generation: the app asks for the matching desktop release instead of replacing it.
  if (current.major > target.major) return { action: "refuse", code: "cgs_too_new" };
  const order = compareCgsVersions(installed, bound);
  if (order >= 0) return { action: "use", managed: found.bunGlobal };
  // Older than the bound version: only the bun-global copy can be upgraded in place.
  if (!found.bunGlobal) return { action: "error", code: "cgs_not_managed" };
  if (!bun) return { action: "error", code: "bun_missing" };
  return { action: "upgrade" };
}

/** Offline failures get their own page; everything else is an install failure with the log tail. */
export function classifyInstallFailure(text) {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_SOCKET|fetch failed|failed to fetch|network|no such host|unable to connect/i.test(text)
    ? "offline"
    : "install_failed";
}

/** Runs one command, collecting stdout/stderr and reporting stdout/stderr lines as they arrive. Never throws. */
export function runProcess({ spawn = defaultSpawn, command, args = [], env = process.env, platform = process.platform, timeoutMs = VERSION_TIMEOUT_MS, onLine }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...info });
    };
    let timer;
    try {
      child = spawn(command, args, { ...spawnOptions(command, platform), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    const collect = (stream, append) => {
      stream?.setEncoding("utf8");
      let rest = "";
      stream?.on("data", (chunk) => {
        append(chunk);
        rest += chunk;
        let index;
        while ((index = rest.indexOf("\n")) >= 0) {
          onLine?.(rest.slice(0, index).replace(/\r$/, ""));
          rest = rest.slice(index + 1);
        }
      });
      stream?.on("end", () => {
        if (rest) onLine?.(rest.replace(/\r$/, ""));
      });
      stream?.on("error", () => {});
    };
    collect(child.stdout, (chunk) => {
      stdout += chunk;
    });
    collect(child.stderr, (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, error: error.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
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

/** One top-level field of package.json (`cgsVersion`, `bunInstall`), or undefined. */
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
  boundVersion,
  bunPin,
  fetch: fetchImpl,
  arch = process.arch,
} = {}) {
  const io = { ...REAL_FS, ...fsOverride };
  const bound = boundVersion ?? packageField("cgsVersion");
  const pin = bunPin ?? packageField("bunInstall");
  let state = { phase: "checking", progress: [] };
  let inflight;
  const listeners = new Set();

  const set = (next) => {
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  };
  const progress = (line) => {
    const lines = tail([...(state.progress ?? []), clip(line)]);
    set({ ...state, phase: "installing", progress: lines });
  };

  const fail = (code, detail, log) =>
    set({
      phase: code === "cgs_too_new" ? "refused" : "error",
      code,
      detail,
      progress: state.progress,
      log: log ? tail(String(log).split("\n").map(clip), 30).join("\n") : undefined,
      shadowed: state.shadowed,
    });

  async function run() {
    state = { phase: "checking", progress: [] };
    for (const listener of listeners) listener(state);
    if (env.CGS_SIDECAR) return set({ phase: "ready", progress: [], bypassed: true });
    if (!bound || !parseCgsVersion(bound)) {
      return fail("sync_failed", `package.json cgsVersion is missing or not a CGS release version: ${bound ?? "(absent)"}`);
    }

    const inspection = inspectInstall({ env, platform, home, fs: io });
    const found = inspection.winner;
    const explicit = Boolean(env.CGS_BIN?.trim());
    if (explicit && !found) {
      return fail("cgs_not_found", `CGS_BIN=${env.CGS_BIN} is not an executable file.`);
    }
    let installed;
    let versionLog;
    if (found) {
      const read = await readCgsVersion({ cgs: found.path, spawn, env, platform });
      installed = read.version;
      versionLog = read.log;
    }
    let bun = inspectBun({ env, platform, home, fs: io });
    let plan = planCliSync({ found, installed, bound, bun, explicit });
    const common = {
      progress: [],
      cgs: found?.path,
      version: installed,
      shadowed: inspection.shadowed,
      bound,
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
        const check = await runProcess({ spawn, command: bun, args: ["--version"], env, platform, timeoutMs: VERSION_TIMEOUT_MS });
        if (check.code !== 0) {
          // A bun that does not run (a wrong CPU build) must not stay: the next start would find it and fail inside `bun add`.
          try {
            fs.rmSync(bun, { force: true });
          } catch {
            /* nothing more to do */
          }
          return fail("bun_install_failed", "The downloaded bun does not run on this machine.", [check.stdout, check.stderr, check.error].filter(Boolean).join("\n"));
        }
        plan = planCliSync({ found, installed, bound, bun, explicit });
      }
    }
    if (plan.action === "refuse") {
      return set({
        ...common,
        phase: "refused",
        code: plan.code,
        detail: `installed ${installed ?? "?"}; this desktop is bound to ${bound}. Install a newer CGS Desktop instead.`,
      });
    }
    if (plan.action === "error") {
      const detail =
        plan.code === "bun_missing"
          ? `bun was not found; checked ${[...new Set(bunCandidates({ env, platform, home }).map((item) => path.dirname(item)))].join(", ")}. Install bun (https://bun.sh) and try again, or install @cicori/cgs@${bound} yourself.`
          : plan.code === "cgs_not_managed"
            ? `${found?.path} is not installed by bun and cannot be replaced by the desktop. Install the bun build (bun add -g @cicori/cgs@${bound}) or update this copy yourself.`
            : plan.code === "version_unreadable"
              ? `Could not read the version of ${found?.path ?? "cgs"}.\n${versionLog ?? ""}`
              : undefined;
      return set({ ...common, phase: "error", code: plan.code, detail });
    }
    if (plan.action === "use") {
      if (found?.bunGlobal && !explicit) writeMarker({ home, env, version: app?.getVersion?.() ?? "0.0.0", desktop: desktopExecutable({ app, env }), fs: io });
      return set({ ...common, phase: "ready", managed: Boolean(found?.bunGlobal) && !explicit });
    }

    // Install or upgrade: the daemon of an older CLI keeps running unless we ask it to stop.
    set({ ...common, phase: "installing", progress: [`bun add -g @cicori/cgs@${bound}`] });
    const daemon = await detectDaemon({ home, env, fs: io, platform });
    if (daemon.running) {
      const accepted = confirmRestart ? await confirmRestart({ dir: daemon.dir }) : true;
      if (!accepted) return fail("restart_cancelled", "The CLI was not updated because the running local service was not allowed to restart.");
    }
    const result = await runProcess({
      spawn,
      command: bun,
      args: ["add", "-g", `@cicori/cgs@${bound}`],
      env,
      platform,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onLine: progress,
    });
    if (result.code !== 0) {
      const log = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
      return fail(result.timedOut ? "install_failed" : classifyInstallFailure(log), `bun add -g @cicori/cgs@${bound} failed${result.timedOut ? " (timeout)" : ""}.`, log);
    }
    if (daemon.running) {
      progress("stopping the local service");
      const stop = await stopDaemon({ cgs: inspectInstall({ env, platform, home, fs: io }).winner?.path ?? found.path, home, env, spawn, fs: io, platform });
      progress(stop.stopped ? "local service stopped" : `local service not stopped (${stop.reason}); the new sidecar will restart it`);
    }
    const after = inspectInstall({ env, platform, home, fs: io });
    const read = after.winner ? await readCgsVersion({ cgs: after.winner.path, spawn, env, platform }) : { version: undefined, log: "cgs not found after install" };
    if (!read.version || compareCgsVersions(read.version, bound) !== 0) {
      return set({
        ...common,
        phase: "error",
        code: "install_unverified",
        cgs: after.winner?.path,
        version: read.version,
        progress: state.progress,
        detail: `Expected ${bound}, got ${read.version ?? "nothing"} at ${after.winner?.path ?? "no path"}.`,
        log: read.log,
      });
    }
    writeMarker({ home, env, version: app?.getVersion?.() ?? "0.0.0", desktop: desktopExecutable({ app, env }), fs: io });
    return set({
      phase: "ready",
      progress: state.progress,
      cgs: after.winner.path,
      version: read.version,
      bound,
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
