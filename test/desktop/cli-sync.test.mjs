// CLI bootstrap (ADR 0052): shadow detection, the install plan, and the real install path against fake
// bun/cgs shell scripts in a temporary PATH. Nothing here touches the machine's real bun install or ~/.cgs.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { bunAssetName, readZipEntry } from "../../desktop/bun-install.mjs";
import {
  classifyInstallFailure,
  createCliSync,
  detectDaemon,
  inspectInstall,
  markerPath,
  parseVersionOutput,
  planCliSync,
} from "../../desktop/cli-sync.mjs";

const dirs = [];
function tempDir(prefix = "cgs-cli-sync-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the version is read from cgs/<version> or a bare version", () => {
  expect(parseVersionOutput("cgs/19.2.1-cgs.5.3")).toBe("19.2.1-cgs.5.3");
  expect(parseVersionOutput("19.2.1-cgs.5.3\n")).toBe("19.2.1-cgs.5.3");
  expect(parseVersionOutput("something else")).toBeUndefined();
});

/** statSync/accessSync over a fixed set of files; realpathSync maps the paths a fixture wants. */
function fakeFs({ files = [], links = {} } = {}) {
  const set = new Set(files);
  return {
    statSync(candidate) {
      if (!set.has(candidate)) throw new Error("ENOENT");
      return { isFile: () => true };
    },
    accessSync(candidate) {
      if (!set.has(candidate)) throw new Error("EACCES");
    },
    realpathSync(candidate) {
      return links[candidate] ?? candidate;
    },
    existsSync(candidate) {
      return set.has(candidate);
    },
  };
}

test("every executable cgs is found; the primary bun-global copy wins", () => {
  const found = inspectInstall({
    env: { BUN_INSTALL: "/opt/bun", PATH: "/usr/local/bin:/opt/bun/bin" },
    home: "/home/u",
    fs: fakeFs({
      files: ["/opt/bun/bin/cgs", "/home/u/.bun/bin/cgs", "/usr/local/bin/cgs"],
      links: {
        "/opt/bun/bin/cgs": "/opt/bun/install/global/node_modules/@cicori/cgs/scripts/cgs.ts",
        "/home/u/.bun/bin/cgs": "/home/u/.bun/install/global/node_modules/@cicori/cgs/scripts/cgs.ts",
        "/usr/local/bin/cgs": "/usr/local/bin/cgs",
      },
    }),
  });
  expect(found.winner.path).toBe("/opt/bun/bin/cgs");
  expect(found.winner.bunGlobal).toBe(true);
  expect(found.shadowed).toEqual(["/home/u/.bun/bin/cgs", "/usr/local/bin/cgs"]);
  const second = found.entries.find((entry) => entry.path === "/home/u/.bun/bin/cgs");
  expect(second?.bunGlobal).toBe(false);
});

test("the plan does not replace an existing CLI whose version cannot be read", () => {
  const found = { path: "/opt/bun/bin/cgs", bunGlobal: true };
  expect(planCliSync({ found, bun: "/opt/bun/bin/bun" })).toEqual({ action: "error", code: "version_unreadable" });
});

test("offline installs are told apart from other failures", () => {
  expect(classifyInstallFailure("error: Failed to fetch @cicori/cgs: ENOTFOUND registry.npmjs.org")).toBe("offline");
  expect(classifyInstallFailure("error: EACCES: permission denied")).toBe("install_failed");
});

test("a daemon needs its lock and db, and then a listening socket", async () => {
  const root = tempDir();
  const daemonDir = path.join(root, ".cgs", "run", "daemon");
  mkdirSync(daemonDir, { recursive: true });
  const env = {};
  const home = root;
  expect((await detectDaemon({ home, env, fs: fakeFs(), probe: async () => true })).running).toBe(false);
  writeFileSync(path.join(daemonDir, "daemon.lock"), "");
  writeFileSync(path.join(daemonDir, "daemon.db"), "");
  expect((await detectDaemon({ home, env, fs: fakeFs({ files: [path.join(daemonDir, "daemon.lock"), path.join(daemonDir, "daemon.db")] }), probe: async () => true })).running).toBe(true);
  expect((await detectDaemon({ home, env, fs: fakeFs({ files: [path.join(daemonDir, "daemon.lock"), path.join(daemonDir, "daemon.db")] }), probe: async () => false })).running).toBe(false);
});

// --- fake executables ----------------------------------------------------------------------------------------------

/** A fake bun install: `<root>/bin/{bun,cgs}` shell scripts, plus whatever `cgs` prints for --version. */
function fakeInstall({ version, bun = true } = {}) {
  const root = tempDir();
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const cgs = path.join(bin, "cgs");
  if (version) {
    writeFileSync(cgs, `#!/bin/sh\necho cgs/${version}\n`);
    chmodSync(cgs, 0o755);
  }
  if (bun) {
    writeFileSync(
      path.join(bin, "bun"),
      `#!/bin/sh
log="$BUN_INSTALL/bun.log"
echo "$@" >> "$log"
if [ "$1" = "add" ] && [ "$2" = "-g" ]; then
  printf '#!/bin/sh\\necho cgs/19.2.1-cgs.5.4\\n' > "$BUN_INSTALL/bin/cgs"
  chmod +x "$BUN_INSTALL/bin/cgs"
  echo "installed $3"
  exit 0
fi
exit 1
`,
    );
    chmodSync(path.join(bin, "bun"), 0o755);
  }
  return { root, bin, cgs, env: { HOME: root, BUN_INSTALL: root, PATH: `${bin}:/usr/bin:/bin`, PI_CONFIG_DIR: ".cgs" } };
}

const app = { getVersion: () => "0.3.0", getPath: (key) => (key === "exe" ? "/opt/cgs-desktop" : tempDir()) };

test("a missing CLI is installed with bun and the marker is written", async () => {
  const fake = fakeInstall({ version: undefined });
  const sync = createCliSync({ app, env: fake.env, home: fake.root });
  const state = await sync.start();
  expect(state.phase).toBe("ready");
  expect(state.version).toBe("19.2.1-cgs.5.4");
  expect(state.cgs).toBe(fake.cgs);
  expect(readFileSync(path.join(fake.root, "bun.log"), "utf8").trim()).toBe("add -g @cicori/cgs");
  const marker = JSON.parse(readFileSync(markerPath({ home: fake.root, env: fake.env }), "utf8"));
  expect(marker).toMatchObject({ desktop: "/opt/cgs-desktop", version: "0.3.0" });
});

test.each(["19.2.1-cgs.5.3", "20.0.0-cgs.6.1"])("existing CLI %s is used without invoking Bun", async (version) => {
  const fake = fakeInstall({ version });
  const sync = createCliSync({ app, env: fake.env, home: fake.root });
  const state = await sync.start();
  expect(state).toMatchObject({ phase: "ready", version, cgs: fake.cgs });
  expect(existsSync(path.join(fake.root, "bun.log"))).toBe(false);
});

test("where bun cannot be installed, no bun and no CLI is bun_missing with the instructions detail", async () => {
  const fake = fakeInstall({ version: undefined, bun: false });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, platform: "win32" });
  const state = await sync.start();
  expect(state.phase).toBe("error");
  expect(state.code).toBe("bun_missing");
  expect(state.detail).toContain("Install bun");
});

// --- installing bun ------------------------------------------------------------------------------------------------

/** A zip with one entry; `deflate` picks method 8 over stored. The reader does not check CRCs (the pinned SHA-256 covers the bytes). */
function zipOf(name, data, deflate = false) {
  const packed = deflate ? deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + packed.length, 16);
  return Buffer.concat([local, nameBytes, packed, central, nameBytes, end]);
}

const FAKE_BUN_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.4.4; exit 0; fi
echo "$@" >> "$BUN_INSTALL/bun.log"
if [ "$1" = "add" ] && [ "$2" = "-g" ]; then
  printf '#!/bin/sh\\n[ "$(command -v bun)" = "$BUN_INSTALL/bin/bun" ] || exit 1\\necho cgs/19.2.1-cgs.5.4\\n' > "$BUN_INSTALL/bin/cgs"
  chmod +x "$BUN_INSTALL/bin/cgs"
  echo "installed $3"
  exit 0
fi
exit 1
`;

const ASSETS = ["bun-linux-x64", "bun-linux-x64-baseline", "bun-linux-aarch64", "bun-darwin-x64", "bun-darwin-x64-baseline", "bun-darwin-aarch64"];

/** A release host serving a zip for whichever asset the URL names, and the pin that matches those zips. */
function fakeRelease({ script = FAKE_BUN_SCRIPT, tamper = false } = {}) {
  const zips = new Map(ASSETS.map((asset) => [asset, zipOf(`${asset}/bun`, Buffer.from(script), true)]));
  const pin = { version: "1.4.4", sha256: Object.fromEntries(ASSETS.map((asset) => [asset, createHash("sha256").update(zips.get(asset)).digest("hex")])) };
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    const asset = /\/(bun-[a-z0-9-]+)\.zip$/.exec(String(url))?.[1];
    const zip = zips.get(asset);
    if (!zip) return new Response("", { status: 404 });
    const body = tamper ? Buffer.concat([zip, Buffer.from("x")]) : zip;
    return new Response(body, { headers: { "content-length": String(body.length) } });
  };
  return { pin, fetch, urls };
}

test("the bun asset follows the platform, and x64 without AVX2 takes the baseline build", () => {
  expect(bunAssetName({ platform: "linux", arch: "x64", avx2: true })).toBe("bun-linux-x64");
  expect(bunAssetName({ platform: "linux", arch: "x64", avx2: false })).toBe("bun-linux-x64-baseline");
  expect(bunAssetName({ platform: "darwin", arch: "x64", avx2: false })).toBe("bun-darwin-x64-baseline");
  expect(bunAssetName({ platform: "darwin", arch: "arm64" })).toBe("bun-darwin-aarch64");
  expect(bunAssetName({ platform: "win32", arch: "x64", avx2: true })).toBeUndefined();
});

test("a zip entry is read stored or deflated, and a missing one is an error", () => {
  const data = Buffer.from("0123456789".repeat(50));
  expect(readZipEntry(zipOf("a/bun", data), "a/bun").equals(data)).toBe(true);
  expect(readZipEntry(zipOf("a/bun", data, true), "a/bun").equals(data)).toBe(true);
  expect(() => readZipEntry(zipOf("a/bun", data), "b/bun")).toThrow("not in the archive");
});

test("no bun on PATH: the pinned bun is downloaded and runs the installed CLI shim on first launch", async () => {
  const fake = fakeInstall({ version: undefined, bun: false });
  fake.env.PATH = "/usr/bin:/bin";
  const release = fakeRelease();
  const sync = createCliSync({ app, env: fake.env, home: fake.root, bunPin: release.pin, fetch: release.fetch, arch: "arm64" });
  const state = await sync.start();
  expect(state.phase).toBe("ready");
  expect(release.urls).toHaveLength(1);
  expect(release.urls[0]).toContain("/bun-v1.4.4/");
  expect(existsSync(path.join(fake.root, "bin", "bun"))).toBe(true);
  expect(readFileSync(path.join(fake.root, "bun.log"), "utf8").trim()).toBe("add -g @cicori/cgs");
});

test("a bun the user already has is used as it is: nothing is downloaded", async () => {
  const fake = fakeInstall({ version: undefined });
  const sync = createCliSync({
    app,
    env: fake.env,
    home: fake.root,
    bunPin: fakeRelease().pin,
    fetch: async () => {
      throw new Error("must not download");
    },
  });
  expect((await sync.start()).phase).toBe("ready");
});

test("a download that does not match the pinned checksum installs nothing", async () => {
  const fake = fakeInstall({ version: undefined, bun: false });
  const release = fakeRelease({ tamper: true });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, bunPin: release.pin, fetch: release.fetch, arch: "arm64" });
  const state = await sync.start();
  expect(state.phase).toBe("error");
  expect(state.code).toBe("bun_install_failed");
  expect(state.log).toContain("pinned checksum");
  expect(existsSync(path.join(fake.root, "bin", "bun"))).toBe(false);
});

test("an unreachable host is reported as offline", async () => {
  const fake = fakeInstall({ version: undefined, bun: false });
  const sync = createCliSync({
    app,
    env: fake.env,
    home: fake.root,
    bunPin: fakeRelease().pin,
    arch: "arm64",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const state = await sync.start();
  expect(state.code).toBe("offline");
});

test("a downloaded bun that does not run is removed, so a retry downloads again", async () => {
  const fake = fakeInstall({ version: undefined, bun: false });
  const release = fakeRelease({ script: "#!/bin/sh\nexit 4\n" });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, bunPin: release.pin, fetch: release.fetch, arch: "arm64" });
  const state = await sync.start();
  expect(state.code).toBe("bun_install_failed");
  expect(existsSync(path.join(fake.root, "bin", "bun"))).toBe(false);
});

// --- restarting the daemon -----------------------------------------------------------------------------------------

test("a missing CLI is not installed if the user declines restarting an orphaned daemon", async () => {
  const fake = fakeInstall();
  const daemon = path.join(fake.root, ".cgs", "run", "daemon");
  mkdirSync(daemon, { recursive: true });
  writeFileSync(path.join(daemon, "daemon.lock"), "");
  writeFileSync(path.join(daemon, "daemon.db"), "");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(path.join(daemon, "daemon.sock"), resolve));
  try {
    let asked = 0;
    const sync = createCliSync({ app, env: fake.env, home: fake.root, confirmRestart: async () => (asked += 1, false) });
    const state = await sync.start();
    expect(asked).toBe(1);
    expect(state.code).toBe("restart_cancelled");
    expect(existsSync(path.join(fake.root, "bun.log"))).toBe(false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
