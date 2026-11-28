// Windows first run (ADR 0049): proxy translation, source racing, the verified download, and the installer driven by fake
// executables. Nothing here touches the network or the real toolchain directory.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { createCliSync } from "../../desktop/cli-sync.mjs";
import { DownloadError, downloadVerified, parseAria2Summary } from "../../desktop/toolchain/download.mjs";
import { createToolchain, ToolchainError } from "../../desktop/toolchain/install.mjs";
import { chromiumDirectory, toolchainEnv, toolchainRoot } from "../../desktop/toolchain/manifest.mjs";
import { createRacer, proxyEnv, proxyUrlFromPac } from "../../desktop/toolchain/network.mjs";

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-toolchain-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sha = (data) => createHash("sha256").update(data).digest("hex");

test("a PAC answer becomes the first http proxy, and DIRECT or SOCKS become none", () => {
  expect(proxyUrlFromPac("PROXY 127.0.0.1:7890; DIRECT")).toBe("http://127.0.0.1:7890");
  expect(proxyUrlFromPac("HTTPS proxy.corp:8443")).toBe("https://proxy.corp:8443");
  expect(proxyUrlFromPac("DIRECT")).toBeUndefined();
  expect(proxyUrlFromPac("SOCKS5 127.0.0.1:1080; DIRECT")).toBeUndefined();
  expect(proxyUrlFromPac("DIRECT; PROXY late:1")).toBeUndefined();
  expect(proxyEnv("http://p:1").HTTPS_PROXY).toBe("http://p:1");
  expect(proxyEnv(undefined)).toEqual({});
});

test("aria2's summary line gives bytes received, expected and speed", () => {
  expect(parseAria2Summary("[#2089b0 400.0KiB/33MiB(1%) CN:1 DL:115KiB ETA:4m51s]")).toEqual({ received: 409600, total: 34603008, speed: 117760 });
  expect(parseAria2Summary("[#aa 1.5MiB/2.0MiB(75%) CN:4]")).toMatchObject({ received: 1572864, total: 2097152, speed: 0 });
  expect(parseAria2Summary("11/28 16:45:02 [NOTICE] Download complete")).toBeUndefined();
});

test("the racer puts the fastest answering source first, silent ones last, and demotes a source that failed", async () => {
  let clock = 0;
  const delays = { "https://slow/x": 300, "https://fast/x": 20, "https://mid/x": 100 };
  const fetch = async (url) => {
    if (url === "https://dead/x") throw new Error("ENOTFOUND");
    clock += delays[url];
    return { status: 206, body: { cancel: async () => {} } };
  };
  const racer = createRacer({ fetch, now: () => clock });
  const sources = ["https://dead/x", "https://slow/x", "https://fast/x", "https://mid/x"];
  const order = await racer.order("k", sources);
  expect(order.slice(0, 3).sort()).toEqual(["https://fast/x", "https://mid/x", "https://slow/x"]);
  expect(order[3]).toBe("https://dead/x");
  racer.demote("k", order[0]);
  const again = await racer.order("k", sources);
  expect(again[0]).not.toBe(order[0]);
  expect(again.at(-1)).toBe(order[0]);
});

/** A fake aria2c: writes `body` (or something else) to --dir/--out for the URL it is given. */
function fakeAria2(servers) {
  const calls = [];
  const spawn = (_command, args) => {
    const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    const url = args.at(-1);
    calls.push({ url, proxy: value("all-proxy") });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      const body = servers[url];
      if (body === undefined) {
        child.stderr.write("errorCode=1 could not connect\n");
        child.emit("close", 1);
        return;
      }
      writeFileSync(path.join(value("dir"), value("out")), body);
      child.stdout.write(`[#a ${body.length}B/${body.length}B(100%) CN:1 DL:1KiB]\n`);
      child.emit("close", 0);
    });
    return child;
  };
  return { spawn, calls };
}

test("a source that serves other bytes is a failed source, and the next one is used", async () => {
  const dir = tempDir();
  const good = Buffer.from("the pinned bytes");
  const { spawn, calls } = fakeAria2({ "https://evil/f": Buffer.from("tampered"), "https://ok/f": good });
  const seen = [];
  const file = await downloadVerified({
    aria2: "aria2c",
    spec: { name: "f.bin", sha256: sha(good), size: good.length },
    sources: ["https://evil/f", "https://ok/f"],
    dir,
    proxyFor: async () => "http://p:1",
    spawn,
    onSource: (url, ok) => seen.push([url, ok]),
  });
  expect(readFileSync(file)).toEqual(good);
  expect(seen).toEqual([["https://evil/f", false], ["https://ok/f", true]]);
  expect(calls.every((call) => call.proxy === "http://p:1")).toBe(true);
});

test("when every source fails the error lists each reason, and nothing bad stays on disk", async () => {
  const dir = tempDir();
  const { spawn } = fakeAria2({ "https://evil/f": Buffer.from("tampered") });
  const error = await downloadVerified({ aria2: "aria2c", spec: { name: "f.bin", sha256: sha("x") }, sources: ["https://evil/f", "https://gone/f"], dir, spawn }).catch((e) => e);
  expect(error).toBeInstanceOf(DownloadError);
  expect(error.code).toBe("download_failed");
  expect(error.message).toContain("does not match the pinned");
  expect(error.message).toContain("https://gone/f");
  expect(existsSync(path.join(dir, "f.bin"))).toBe(false);
});

test("a complete file with the right hash is reused without starting aria2c", async () => {
  const dir = tempDir();
  const data = Buffer.from("already here");
  writeFileSync(path.join(dir, "f.bin"), data);
  const { spawn, calls } = fakeAria2({});
  await downloadVerified({ aria2: "aria2c", spec: { name: "f.bin", sha256: sha(data) }, sources: ["https://x/f"], dir, spawn });
  expect(calls).toHaveLength(0);
});

test("the toolchain joins PATH for the agent, once, and sets the variables its tools read", () => {
  const root = "C:\\Users\\a\\AppData\\Local\\cgs-desktop\\toolchain";
  const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", Path: "C:\\Windows;C:\\Users\\a\\AppData\\Local\\cgs-desktop\\toolchain\\python" };
  const exists = () => true;
  const out = toolchainEnv({ env, platform: "win32", home: "C:\\Users\\a", exists });
  const entries = out.Path.split(";");
  expect(entries.filter((entry) => entry.toLowerCase().endsWith("toolchain\\python"))).toHaveLength(1);
  expect(entries[0]).toContain("toolchain");
  expect(out.Path.endsWith("C:\\Windows;C:\\Users\\a\\AppData\\Local\\cgs-desktop\\toolchain\\python")).toBe(true);
  expect(out.RUSTUP_HOME).toContain("rustup");
  const own = toolchainEnv({ env: { ...env, RUSTUP_HOME: "C:\\their\\rustup", CARGO_HOME: "C:\\their\\cargo" }, platform: "win32", home: "C:\\Users\\a", exists });
  expect(own.RUSTUP_HOME).not.toContain("their");
  expect(own.CARGO_HOME).not.toContain("their");
  expect(out.CARGO_HOME).toContain("cargo");
  expect(toolchainRoot({ env, home: "C:\\Users\\a" }).toLowerCase()).toContain("cgs-desktop");
  expect(toolchainEnv({ env, platform: "linux", home: "/h", exists })).toBe(env);
  void root;
});

test("Chromium goes where omp looks for it", () => {
  const dir = chromiumDirectory({ env: {}, home: "/h", buildId: "150.0.7871.24" });
  expect(dir).toBe(path.join("/h", ".cgs", "puppeteer", "chrome", "win64-150.0.7871.24"));
});

/** A toolchain whose components are fake: the downloads and every unpacking step are replaced, the bookkeeping is real. */
function fakeToolchain({ failing, calls = [] } = {}) {
  const home = tempDir();
  const tools = path.join(home, "tools");
  mkdirSync(tools, { recursive: true });
  writeFileSync(path.join(tools, "aria2c.exe"), "a");
  writeFileSync(path.join(tools, "bun.exe"), "b");
  const env = { LOCALAPPDATA: path.join(home, "Local"), CGS_TOOLS_DIR: tools };
  const manifest = {
    chromium: { buildId: "1.0.0.0", asset: "chrome.zip", sha256: "c", sources: ["https://x/chrome.zip"] },
    git: { asset: "git.exe", sha256: "g", sources: ["https://x/git.exe"] },
    python: { asset: "py.zip", sha256: "p", sources: ["https://x/py.zip"] },
    llvm: { asset: "llvm.zip", sha256: "l", topDir: "llvm-x", sources: ["https://x/llvm.zip"] },
    rust: { rustup: { asset: "rustup-init.exe", sha256: "r", sources: ["https://x/r.exe"] }, toolchain: "1", host: "h", profile: "minimal", components: [], distServers: ["https://d"], probe: "/c.toml", channelSha256: "x" },
    languageServers: { registries: ["https://npm"], probe: "/p" },
    pip: { indexes: ["https://pypi"], probe: "/pip/" },
    cgs: { registries: ["https://npm"] },
  };
  const toolchain = createToolchain({ env, home, manifest, fetch: async () => ({ status: 206, body: { cancel: async () => {} } }), extractZip: async () => {} });
  return { toolchain, env, home, manifest, calls, failing };
}

test("without the bundled aria2c the toolchain says the installation is broken instead of failing obscurely", async () => {
  const { toolchain, home } = fakeToolchain();
  rmSync(path.join(home, "tools", "aria2c.exe"));
  const error = await toolchain.ensure().catch((e) => e);
  expect(error).toBeInstanceOf(ToolchainError);
  expect(error.code).toBe("bundle_missing");
});

test("every component is listed from the start, in the order the page shows them", () => {
  const { toolchain } = fakeToolchain();
  expect(toolchain.components().map((item) => item.id)).toEqual(["chromium", "git", "python", "llvm", "rust", "lsp"]);
  expect(toolchain.components().every((item) => item.state === "pending")).toBe(true);
});

test("outside Windows the sync has no toolchain and its states carry no components", async () => {
  const sync = createCliSync({ env: { CGS_SIDECAR: JSON.stringify(["x"]) }, platform: "linux", home: tempDir() });
  const state = await sync.start();
  expect(state.phase).toBe("ready");
  expect(state.components).toBeUndefined();
});

test("Windows startup verifies a cached Git download and unpacks it before reporting the tool ready", async () => {
  const { home, env, manifest } = fakeToolchain();
  const archive = Buffer.from("PortableGit fixture");
  manifest.git.sha256 = sha(archive);
  const manifestFile = path.join(home, "manifest.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  env.CGS_TOOLCHAIN_MANIFEST = manifestFile;
  env.CGS_BIN = path.join(home, "cgs.exe");
  writeFileSync(env.CGS_BIN, "");
  const root = toolchainRoot({ env, home });
  const cacheDir = path.join(root, ".downloads");
  mkdirSync(cacheDir, { recursive: true });
  const cachedGit = path.join(cacheDir, manifest.git.asset);
  writeFileSync(cachedGit, archive);
  // The archive was left by an interrupted first run, along with a partial Git extraction.
  const git = path.join(root, "git");
  mkdirSync(git, { recursive: true });
  const partial = path.join(git, "partial");
  writeFileSync(partial, "");

  const sync = createCliSync({
    env,
    platform: "win32",
    home,
    fetch: async () => new Response("", { status: 206 }),
    spawn(command, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        if (command === cachedGit && args.includes(`-o${git}`)) {
          mkdirSync(path.join(git, "cmd"), { recursive: true });
          writeFileSync(path.join(git, "cmd", "git.exe"), "");
          child.emit("close", 0);
        } else {
          child.emit("close", 1);
        }
      });
      return child;
    },
  });
  const state = await sync.start();
  expect(state.components?.find(({ id }) => id === "git")?.state).toBe("done");
  expect(readFileSync(path.join(root, ".done", "git"), "utf8").trim()).toBe(manifest.git.sha256);
  expect(existsSync(partial)).toBe(false);
});
