// Platform-specific parts of the shell (ADR 0046 §9): where `cgs` and `bun` live, where logs go, how a child process is stopped.
// Everything that knows about `.exe`, PATH separators or Windows process trees belongs in this file; the rest of the main
// process stays platform neutral. Windows is not supported yet — the marked bits are the room it will need (V16: the daemon
// IPC is a named pipe inside omp's Rust natives, which does not change the stdio link to the sidecar).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** P19 entry, relative to the CLI root: `cgs __cgs_worker_module <absolute path>` (cgsconnect/local-channel.md §1). */
const SIDECAR_MODULE = path.join("packages", "connect", "src", "desktop", "sidecar.ts");
/** Protocol spoken by this build of the desktop app (`hello.protocol`). */
export const SIDECAR_PROTOCOL = 1;

const delimiterOf = (platform) => (platform === "win32" ? ";" : ":");

/** Names a bun-installed CLI can have on this platform. Windows shims are `.cmd`; PATHEXT is not consulted, the two known names are enough. */
function commandNames(name, platform) {
  return platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

function pathDirectories(env, platform) {
  return (env.PATH ?? env.Path ?? "").split(delimiterOf(platform)).filter(Boolean);
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isExecutable(candidate, platform) {
  if (!isFile(candidate)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every place a `cgs` install may be, in resolution order: `CGS_BIN`, `$BUN_INSTALL/bin`, `~/.bun/bin`, then `PATH`
 * (first match wins and is used by its absolute path from then on, ADR 0046 §3).
 */
export function cgsCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const candidates = [];
  if (env.CGS_BIN) candidates.push(env.CGS_BIN);
  const installs = [];
  if (env.BUN_INSTALL) installs.push(path.join(env.BUN_INSTALL, "bin"));
  installs.push(path.join(home, ".bun", "bin"));
  for (const dir of installs) for (const name of commandNames("cgs", platform)) candidates.push(path.join(dir, name));
  for (const dir of pathDirectories(env, platform)) for (const name of commandNames("cgs", platform)) candidates.push(path.join(dir, name));
  return candidates;
}

/** The absolute `cgs` to run, or undefined. */
export function resolveCgs(options = {}) {
  const { platform = process.platform } = options;
  return cgsCandidates(options).find((candidate) => isExecutable(candidate, platform));
}

/** Where a bun-installed `bun` may be (the install step [未决 O9] and dev tooling will need it). */
export function bunCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const candidates = [];
  const installs = [];
  if (env.BUN_INSTALL) installs.push(path.join(env.BUN_INSTALL, "bin"));
  installs.push(path.join(home, ".bun", "bin"));
  for (const dir of installs) for (const name of commandNames("bun", platform)) candidates.push(path.join(dir, name));
  for (const dir of pathDirectories(env, platform)) for (const name of commandNames("bun", platform)) candidates.push(path.join(dir, name));
  return candidates;
}

export function resolveBun(options = {}) {
  const { platform = process.platform } = options;
  return bunCandidates(options).find((candidate) => isExecutable(candidate, platform));
}

/** Bun's CLI shims need the selected runtime on PATH even on the first launch, before any shell profile is updated. */
export function withBunPath(env, bun, platform = process.platform) {
  if (!bun) return env;
  const key = platform === "win32" ? Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH" : "PATH";
  const current = env[key];
  const dir = path.dirname(bun);
  const delimiter = delimiterOf(platform);
  if (current === dir || current?.startsWith(`${dir}${delimiter}`)) return env;
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
}

/**
 * `<root>/packages/connect/src/desktop/sidecar.ts` for the resolved `cgs` (the published package keeps this layout).
 * POSIX: `~/.bun/bin/cgs` is a link into the package. Windows: bun installs a `cgs.exe` shim that is not a link, so the
 * package is found at its global install path next to `bin` (checked on a Windows guest, 2026-11-28).
 */
export function sidecarModuleFor(cgsPath, { platform = process.platform, exists = fs.existsSync } = {}) {
  let resolved = cgsPath;
  try {
    resolved = fs.realpathSync(cgsPath);
  } catch {
    /* not a link, or already gone: resolve from the path as given */
  }
  const bin = path.dirname(resolved);
  const linked = path.resolve(bin, "..", SIDECAR_MODULE);
  if (platform !== "win32") return linked;
  const installed = path.resolve(bin, "..", "install", "global", "node_modules", "@cicori", "cgs", SIDECAR_MODULE);
  return exists(linked) || !exists(installed) ? linked : installed;
}

/** `CGS_SIDECAR` overrides the whole command in development: a JSON array, first element the executable. */
function commandFromEnv(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { error: "cgs_sidecar_invalid", log: "CGS_SIDECAR must be a JSON array of strings" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string" && item.length > 0)) {
    return { error: "cgs_sidecar_invalid", log: "CGS_SIDECAR must be a non-empty JSON array of strings" };
  }
  return { command: parsed[0], args: parsed.slice(1), source: "env" };
}

/**
 * The command that starts the sidecar: `CGS_SIDECAR` when set, otherwise the resolved `cgs` plus the P19 entry point.
 * A missing CLI (or a CLI too old to ship the sidecar module) comes back as an error code for the error page, not a throw.
 */
export function resolveSidecarCommand({ env = process.env, platform = process.platform, home = os.homedir(), exists = fs.existsSync, cgs } = {}) {
  if (env.CGS_SIDECAR) return commandFromEnv(env.CGS_SIDECAR);
  // The CLI sync hands over the copy it validated; resolving again could pick a different one if PATH changed meanwhile.
  const cli = cgs ?? resolveCgs({ env, platform, home });
  if (!cli) {
    const checked = cgsCandidates({ env, platform, home });
    return { error: "cgs_not_found", log: `cgs not found; checked:\n${checked.join("\n")}` };
  }
  const module = sidecarModuleFor(cli, { platform, exists });
  if (!exists(module)) return { error: "sidecar_missing", log: `cgs: ${cli}\nmissing sidecar module: ${module}` };
  return { command: cli, args: ["__cgs_worker_module", module], source: "cgs", cgs: cli, module };
}

/** The environment the sidecar starts with: the app's own, plus Bun's path and the protocol marker. */
export function sidecarEnv(env = process.env) {
  return { ...withBunPath(env, resolveBun({ env })), CGS_SIDECAR_PROTOCOL: String(SIDECAR_PROTOCOL) };
}

/** `app.getPath('logs')/sidecar.log`: stderr and startup diagnostics, also kept in memory for the error page. */
export function sidecarLogFile(app) {
  return path.join(app.getPath("logs"), "sidecar.log");
}

/**
 * How to spawn the sidecar. Windows: a bun-installed `cgs` is a `.cmd` shim, which Node only runs through a shell.
 * POSIX has no such problem; the sidecar is a direct child.
 */
export function spawnOptions(command, platform = process.platform) {
  if (platform !== "win32") return {};
  return /\.(cmd|bat)$/i.test(command) ? { shell: true, windowsHide: true } : { windowsHide: true };
}

/** Stops a sidecar process that did not exit on its own. Windows has no signals, so it takes the tree down instead. */
export function killChild(child, signal = "SIGTERM", platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
