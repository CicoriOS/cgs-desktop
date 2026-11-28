// The Windows first-run toolchain (ADR 0049 §1-§5): Chromium, Git + Bash, Python, llvm-mingw (clang, clangd), rustup with a pinned
// Rust, and the language servers. Everything is downloaded in parallel by the bundled aria2c, checked against the SHA-256 pins in
// `manifest.json`, and unpacked under the toolchain root. A component that is already complete (a marker holding the pinned hash)
// is skipped, so a retry after a failure only redoes what is missing.
//
// What this module does not do: touch the user's PATH (the installer asks, ADR 0049 §2) or install the CGS CLI (cli-sync does, in
// parallel). Python's pip packages are installed after everything else and never fail the start (§3).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../run-process.mjs";
import { downloadVerified } from "./download.mjs";
import { bundledToolsDir } from "./paths.mjs";
import { chromiumDirectory, loadLayout, loadManifest, toolchainEnv, toolchainRoot } from "./manifest.mjs";
import { createRacer, proxyEnv } from "./network.mjs";

/** Stable error codes the sync page maps to wording. */
export class ToolchainError extends Error {
  constructor(code, message, log) {
    super(message);
    this.name = "ToolchainError";
    this.code = code;
    this.log = log;
  }
}

/** What each component is called on the page, in the order it is listed. */
export const COMPONENT_LABELS = {
  chromium: "Chromium",
  git: "Git + Bash",
  python: "Python",
  llvm: "clang / clangd",
  rust: "Rust",
  lsp: "Language servers",
};
const ORDER = Object.keys(COMPONENT_LABELS);

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function defaultExtractZip({ env = process.env } = {}) {
  // System32's bsdtar reads zip; a `tar` earlier on PATH (Git's GNU tar) does not, so the path is absolute.
  const tar = path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
  return async (zip, dest, { spawn, onLine } = {}) => {
    const result = await runProcess({ spawn, command: tar, args: ["-xf", zip, "-C", dest], env, timeoutMs: INSTALL_TIMEOUT_MS, onLine });
    if (result.code !== 0) throw new ToolchainError("extract_failed", `could not unpack ${path.basename(zip)}`, [result.stdout, result.stderr, result.error].filter(Boolean).join("\n"));
  };
}

/**
 * `ensure()` brings the toolchain up to date and resolves `{ pip }` (a promise that never rejects). `state()` lists the
 * components for the sync page. Everything outside is injectable so the tests run with fake downloads and installers.
 */
export function createToolchain({
  env = process.env,
  home = os.homedir(),
  resourcesPath = process.resourcesPath,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  proxyFor,
  spawn,
  fs: io = fs,
  manifest = loadManifest({ env }),
  layout = loadLayout(),
  extractZip = defaultExtractZip({ env }),
  racer = createRacer({ fetch: fetchImpl }),
} = {}) {
  const root = toolchainRoot({ env, home, layout });
  const tools = bundledToolsDir({ env, resourcesPath });
  const aria2 = path.join(tools, "aria2c.exe");
  const bun = path.join(tools, "bun.exe");
  const downloads = path.join(root, ".downloads");
  const doneDir = path.join(root, ".done");
  const components = ORDER.map((id) => ({ id, label: COMPONENT_LABELS[id], state: "pending", received: 0, total: 0 }));
  const log = [];
  let running;

  const component = (id) => components.find((item) => item.id === id);
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const set = (id, patch) => {
    Object.assign(component(id), patch);
    emit();
  };
  const note = (line) => log.push(line);

  const marker = (id) => path.join(doneDir, id);
  const isDone = (id, token) => {
    try {
      return io.readFileSync(marker(id), "utf8").trim() === token;
    } catch {
      return false;
    }
  };
  const markDone = (id, token) => {
    io.mkdirSync(doneDir, { recursive: true });
    io.writeFileSync(marker(id), `${token}\n`);
  };

  async function childEnv(extra = {}) {
    const proxy = await proxyFor?.("https://registry.npmmirror.com");
    return { ...toolchainEnv({ env, home, layout }), ...proxyEnv(proxy), ...extra };
  }

  /** Download one pinned file from the fastest working source. */
  async function fetchFile(id, key, spec) {
    set(id, { state: "downloading" });
    const sources = await racer.order(key, spec.sources);
    const file = await downloadVerified({
      aria2,
      spec: { name: spec.asset, sha256: spec.sha256, size: spec.size },
      sources,
      dir: downloads,
      proxyFor,
      spawn,
      fs: io,
      onProgress: (progress) => set(id, { received: progress.received, total: progress.total }),
      onSource: (url, ok) => {
        if (!ok) racer.demote(key, url);
      },
    });
    return file;
  }

  async function unpackZip(zip, finalDir, { stripTop } = {}) {
    const stage = `${finalDir}.part`;
    io.rmSync(stage, { recursive: true, force: true });
    io.mkdirSync(stage, { recursive: true });
    await extractZip(zip, stage, { spawn, onLine: note });
    const source = stripTop ? path.join(stage, stripTop) : stage;
    io.rmSync(finalDir, { recursive: true, force: true });
    io.mkdirSync(path.dirname(finalDir), { recursive: true });
    io.renameSync(source, finalDir);
    if (stripTop) io.rmSync(stage, { recursive: true, force: true });
  }

  const steps = {
    async chromium() {
      const spec = manifest.chromium;
      const dir = chromiumDirectory({ env, home, buildId: spec.buildId });
      const exe = path.join(dir, "chrome-win64", "chrome.exe");
      if (isDone("chromium", spec.sha256) && io.existsSync(exe)) return;
      const zip = await fetchFile("chromium", "chromium", spec);
      set("chromium", { state: "installing" });
      io.rmSync(dir, { recursive: true, force: true });
      io.mkdirSync(dir, { recursive: true });
      await extractZip(zip, dir, { spawn, onLine: note });
      if (!io.existsSync(exe)) throw new ToolchainError("extract_failed", "chrome.exe is missing after unpacking Chromium");
      markDone("chromium", spec.sha256);
    },

    async git() {
      const spec = manifest.git;
      const dir = path.join(root, "git");
      if (isDone("git", spec.sha256) && io.existsSync(path.join(dir, "cmd", "git.exe"))) return;
      const installer = await fetchFile("git", "git", spec);
      set("git", { state: "installing" });
      io.rmSync(dir, { recursive: true, force: true });
      // PortableGit is a 7-zip self-extractor: -o is the target, -y answers every prompt.
      const result = await runProcess({ spawn, command: installer, args: ["-y", `-o${dir}`], env: await childEnv(), timeoutMs: INSTALL_TIMEOUT_MS, onLine: note });
      if (result.code !== 0 || !io.existsSync(path.join(dir, "cmd", "git.exe"))) {
        throw new ToolchainError("install_failed", "Git could not be unpacked", [result.stdout, result.stderr, result.error].filter(Boolean).join("\n"));
      }
      markDone("git", spec.sha256);
    },

    async python() {
      const spec = manifest.python;
      const dir = path.join(root, "python");
      if (isDone("python", spec.sha256) && io.existsSync(path.join(dir, "python.exe"))) return;
      const zip = await fetchFile("python", "python", spec);
      set("python", { state: "installing" });
      await unpackZip(zip, dir);
      const check = await runProcess({ spawn, command: path.join(dir, "python.exe"), args: ["-m", "pip", "--version"], env: await childEnv(), timeoutMs: 60_000 });
      if (check.code !== 0) throw new ToolchainError("install_failed", "the unpacked Python does not run with pip", [check.stdout, check.stderr, check.error].filter(Boolean).join("\n"));
      markDone("python", spec.sha256);
    },

    async llvm() {
      const spec = manifest.llvm;
      const dir = path.join(root, "llvm");
      if (isDone("llvm", spec.sha256) && io.existsSync(path.join(dir, "bin", "clang.exe"))) return;
      const zip = await fetchFile("llvm", "llvm", spec);
      set("llvm", { state: "installing" });
      await unpackZip(zip, dir, { stripTop: spec.topDir });
      markDone("llvm", spec.sha256);
    },

    async rust() {
      const spec = manifest.rust;
      const token = `${spec.rustup.sha256}:${spec.toolchain}:${spec.host}:${spec.components.join(",")}`;
      const rustup = path.join(root, "cargo", "bin", "rustup.exe");
      if (isDone("rust", token) && io.existsSync(rustup)) return;
      const server = await rustServer(spec);
      const init = await fetchFile("rust", "rustup", { ...spec.rustup, sources: spec.rustup.sources });
      set("rust", { state: "installing", received: 0, total: 0 });
      const rustEnv = await childEnv({ RUSTUP_HOME: path.join(root, "rustup"), CARGO_HOME: path.join(root, "cargo"), RUSTUP_DIST_SERVER: server });
      // rustup-init only exists for the gnu host; it installs rustup itself, then the real toolchain is installed for the gnullvm host.
      const bootstrap = await runProcess({ spawn, command: init, args: ["-y", "--no-modify-path", "--default-host", spec.bootstrapHost, "--default-toolchain", "none", "--profile", spec.profile], env: rustEnv, timeoutMs: INSTALL_TIMEOUT_MS, onLine: note });
      const tooling = `${spec.toolchain}-${spec.host}`;
      const result =
        bootstrap.code === 0
          ? await runProcess({
              spawn,
              command: rustup,
              args: ["toolchain", "install", tooling, "--profile", spec.profile, ...spec.components.flatMap((name) => ["-c", name]), "--no-self-update"],
              env: rustEnv,
              timeoutMs: INSTALL_TIMEOUT_MS,
              onLine: note,
            })
          : bootstrap;
      const installed = result.code === 0 ? await runProcess({ spawn, command: rustup, args: ["default", tooling], env: rustEnv, timeoutMs: 120_000, onLine: note }) : result;
      if (installed.code !== 0 || !io.existsSync(rustup)) {
        throw new ToolchainError("install_failed", "rustup could not install the Rust toolchain", [installed.stdout, installed.stderr, installed.error].filter(Boolean).join("\n").split("\n").slice(-30).join("\n"));
      }
      markDone("rust", token);
    },

    async lsp() {
      const dir = path.join(root, "lsp");
      const pkg = io.readFileSync(path.join(HERE, "lsp-package.json"));
      const lock = io.readFileSync(path.join(HERE, "lsp-bun.lock"));
      const token = sha256(Buffer.concat([pkg, lock]));
      if (isDone("lsp", token) && io.existsSync(path.join(dir, "node_modules", ".bin"))) return;
      set("lsp", { state: "installing" });
      const registry = await firstRegistry(manifest.languageServers, "languageServers");
      io.mkdirSync(dir, { recursive: true });
      io.writeFileSync(path.join(dir, "package.json"), pkg);
      io.writeFileSync(path.join(dir, "bun.lock"), lock);
      io.writeFileSync(path.join(dir, "bunfig.toml"), `[install]\nregistry = "${registry}"\n`);
      const result = await runProcess({ spawn, command: bun, args: ["install", "--frozen-lockfile"], cwd: dir, env: await childEnv(), timeoutMs: INSTALL_TIMEOUT_MS, onLine: note });
      if (result.code !== 0) throw new ToolchainError("install_failed", "the language servers could not be installed", [result.stdout, result.stderr, result.error].filter(Boolean).join("\n"));
      markDone("lsp", token);
    },
  };

  /** The fastest registry (or index) of a manifest group `{ registries, probe }`. */
  async function firstRegistry(group, key) {
    const order = await racer.order(key, group.registries, (registry) => `${registry}${group.probe}`);
    return order[0];
  }

  /** The first Rust dist server that answers with the pinned channel manifest (rustup re-reads it from the same server). */
  async function rustServer(spec) {
    const order = await racer.order("rust-dist", spec.distServers, (server) => `${server}${spec.probe}`);
    const mismatched = [];
    for (const server of order) {
      try {
        const response = await fetchImpl(`${server}${spec.probe}`, { signal: AbortSignal.timeout(30_000) });
        if (response.ok && sha256(Buffer.from(await response.arrayBuffer())) === spec.channelSha256) return server;
        mismatched.push(server);
      } catch {
        mismatched.push(server);
      }
    }
    throw new ToolchainError("download_failed", `no Rust dist server served the pinned channel manifest (${mismatched.join(", ")})`);
  }

  /** The pip packages, in the background of the app: failure is a hint, not an error (ADR 0049 §3). */
  async function installPip() {
    const python = path.join(root, "python", "python.exe");
    const requirements = io.readFileSync(path.join(HERE, "requirements.txt"));
    const token = sha256(requirements);
    if (isDone("pip", token)) return { ok: true };
    try {
      const index = await firstRegistry({ registries: manifest.pip.indexes, probe: manifest.pip.probe }, "pip");
      const file = path.join(root, "requirements.txt");
      io.writeFileSync(file, requirements);
      const result = await runProcess({
        spawn,
        command: python,
        args: ["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--disable-pip-version-check", "--no-input", "-i", index, "-r", file],
        env: await childEnv(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: note,
      });
      if (result.code !== 0) return { ok: false, log: [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").split("\n").slice(-20).join("\n") };
      markDone("pip", token);
      return { ok: true };
    } catch (error) {
      return { ok: false, log: error instanceof Error ? error.message : String(error) };
    }
  }

  async function run() {
    for (const required of [aria2, bun]) {
      if (!io.existsSync(required)) throw new ToolchainError("bundle_missing", `${required} is missing from the installation`);
    }
    io.mkdirSync(root, { recursive: true });
    for (const item of components) set(item.id, { state: "pending", received: 0, total: 0 });
    const outcomes = await Promise.allSettled(
      ORDER.map(async (id) => {
        try {
          await steps[id]();
          set(id, { state: "done" });
        } catch (error) {
          set(id, { state: "failed" });
          throw error;
        }
      }),
    );
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failed.length) {
      const first = failed[0].reason;
      const names = ORDER.filter((_id, index) => outcomes[index].status === "rejected").map((id) => COMPONENT_LABELS[id]);
      const code = first instanceof ToolchainError ? first.code : "install_failed";
      const detail = first instanceof ToolchainError ? first.message : String(first);
      throw new ToolchainError(code, `${names.join(", ")}: ${detail}`, [first?.log, ...log.slice(-20)].filter(Boolean).join("\n"));
    }
    return { pip: installPip() };
  }

  return {
    root,
    /** The bundled executables (`<resources>/tools`). */
    bun,
    aria2,
    components: () => components.map((item) => ({ ...item })),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Idempotent: a second call while one is running shares it. */
    ensure() {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
