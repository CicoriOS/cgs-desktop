// What the Windows first run installs, and where (ADR 0049). `manifest.json` pins every download by SHA-256; `layout.json` says
// where the toolchain lives and which of its directories go on PATH. `CGS_TOOLCHAIN_MANIFEST` swaps the whole manifest (tests and
// offline mirrors); the hashes stay in force, so a swapped source cannot change the bytes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadManifest({ env = process.env } = {}) {
  const override = env.CGS_TOOLCHAIN_MANIFEST?.trim();
  return readJson(override || path.join(HERE, "manifest.json"));
}

export function loadLayout() {
  return readJson(path.join(HERE, "layout.json"));
}

/** `%LOCALAPPDATA%\cgs-desktop\toolchain`: the placeholder is resolved here, not by a shell. */
export function toolchainRoot({ env = process.env, home = os.homedir(), layout = loadLayout() } = {}) {
  const local = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
  return layout.root.replace(/%LOCALAPPDATA%/gi, local);
}

/** Layout entries are written with `\`; they become real paths under `root` on whatever platform runs this. */
export function underRoot(root, entry) {
  return path.join(root, ...entry.split(/[\\/]/).filter(Boolean));
}

/** The config root the CLI keeps its state and the Puppeteer cache in (`PI_CONFIG_DIR`, default `~/.cgs`). */
export function configRoot({ env = process.env, home = os.homedir() } = {}) {
  return path.join(home, env.PI_CONFIG_DIR?.trim() || ".cgs");
}

/** omp looks for Chromium at `<config>/puppeteer/chrome/win64-<buildId>/chrome-win64/chrome.exe` (puppeteer's cache layout). */
export function chromiumDirectory({ env, home, buildId }) {
  return path.join(configRoot({ env, home }), "puppeteer", "chrome", `win64-${buildId}`);
}

/** Directories of the toolchain that exist now, in `agentPath` or `userPath` order. */
export function toolchainPathDirs({ which, root, layout = loadLayout(), exists = fs.existsSync }) {
  return layout[which].map((entry) => underRoot(root, entry)).filter((dir) => exists(dir));
}

/** The environment the sidecar and the installers run with: the toolchain on PATH and the variables its tools read (Windows only). */
export function toolchainEnv({ env = process.env, platform = process.platform, home = os.homedir(), layout = loadLayout(), exists = fs.existsSync } = {}) {
  if (platform !== "win32") return env;
  const root = toolchainRoot({ env, home, layout });
  if (!exists(root)) return env;
  const dirs = layout.agentPath.map((entry) => underRoot(root, entry)).filter((dir) => exists(dir));
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key] ?? "";
  const have = new Set(current.split(";").map((item) => item.toLowerCase()));
  const add = dirs.filter((dir) => !have.has(dir.toLowerCase()));
  const next = { ...env, [key]: [...add, current].filter(Boolean).join(";") };
  // Overridden, not defaulted: our `cargo\bin` proxies find their toolchain through these, so a RUSTUP_HOME the user (or the machine)
  // already has would point them at a toolchain that is not ours. They only reach the agent's processes, never the user's shell.
  for (const [name, entry] of Object.entries(layout.env ?? {})) next[name] = underRoot(root, entry);
  return next;
}
