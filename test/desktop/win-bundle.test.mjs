// The Windows bundle fetch (ADR 0049 §1): pins are the only source of truth. These tests serve zips from a fake fetch, so
// they are deterministic and offline; nothing here reads the network, the real package.json or the real build directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { bundleSources, fetchWinBundle, WinBundleError, writeUserPathInclude } from "../../scripts/fetch-win-bundle.mjs";

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-win-bundle-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stored (uncompressed) zip, enough for readZipEntry and independent of any zip library. */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const piece = Buffer.concat([local, nameBuf, data]);
    chunks.push(piece);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, nameBuf]));
    offset += piece.length;
  }
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralPart, end]);
}

const BUN_URL = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64-baseline.zip";
const ARIA2_URL = "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip";
const ARIA2_PROXY = `https://ghproxy.net/${ARIA2_URL}`;
const LAYOUT = {
  root: "%LOCALAPPDATA%\\cgs-desktop\\toolchain",
  userPath: ["git\\cmd", "python", "python\\Scripts", "llvm\\bin", "lsp\\node_modules\\.bin"],
  agentPath: ["git\\cmd", "git\\bin", "git\\usr\\bin", "python", "python\\Scripts", "llvm\\bin", "cargo\\bin", "lsp\\node_modules\\.bin"],
  env: { RUSTUP_HOME: "rustup" },
};

/** package.json-shaped pins plus the zips they describe. Overrides let a test break exactly one pin. */
function fixture(overrides = {}) {
  const bunExe = overrides.bunExe ?? "pinned bun bytes";
  const aria2Exe = overrides.aria2Exe ?? "pinned aria2 bytes";
  const copying = overrides.copying ?? "GNU GENERAL PUBLIC LICENSE\nVersion 2\n";
  const bunEntry = overrides.bunEntry ?? "bun-windows-x64-baseline/bun.exe";
  const bunZipEntry = overrides.bunZipEntry ?? bunEntry;
  const aria2Entry = overrides.aria2Entry ?? "aria2-1.37.0-win-64bit-build1/aria2c.exe";
  const bunZip = makeZip([[bunZipEntry, bunExe]]);
  const aria2Zip = makeZip([[aria2Entry, aria2Exe], ["aria2-1.37.0-win-64bit-build1/COPYING", copying]]);
  const pkg = {
    bunInstall: {
      version: "1.4.4",
      sha256: { "bun-windows-x64-baseline": hash(bunZip) },
    },
    windowsBundle: {
      bun: {
        asset: "bun-windows-x64-baseline",
        entry: bunEntry,
        exeSha256: overrides.bunExeSha256 ?? hash(bunExe),
      },
      aria2: {
        version: "1.37.0",
        zipSha256: overrides.aria2ZipSha256 ?? hash(aria2Zip),
        entry: aria2Entry,
        exeSha256: overrides.aria2ExeSha256 ?? hash(aria2Exe),
        urls: overrides.aria2Urls ?? [ARIA2_URL, ARIA2_PROXY],
      },
    },
  };
  return { pkg: overrides.pkg?.(pkg) ?? pkg, bunZip, aria2Zip };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** A fetch that answers only the URLs in `routes`; any other request is a 404 and recorded. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = routes.get(url);
    return body == null ? new Response("not found", { status: 404 }) : new Response(body);
  };
  return { fetch: fetchImpl, calls };
}

const quiet = () => {};

test("downloads, verifies the zip and the executable, and writes the tools, licence, notice and PATH include", async () => {
  const { pkg, bunZip, aria2Zip } = fixture();
  const outDir = path.join(tempDir(), "win-bundle");
  const net = fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, aria2Zip]]));
  const result = await fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: net.fetch, log: quiet });

  expect(result.downloaded).toEqual(["bun.exe", "aria2c.exe", "COPYING", "ARIA2-NOTICE.txt"]);
  expect(readFileSync(path.join(outDir, "bun.exe"))).toEqual(Buffer.from("pinned bun bytes"));
  expect(readFileSync(path.join(outDir, "aria2c.exe"))).toEqual(Buffer.from("pinned aria2 bytes"));
  expect(readFileSync(path.join(outDir, "COPYING"), "utf8")).toContain("Version 2");
  const notice = readFileSync(path.join(outDir, "ARIA2-NOTICE.txt"), "utf8");
  expect(notice).toContain("aria2 1.37.0");
  expect(notice).toContain("https://github.com/aria2/aria2/releases/tag/release-1.37.0");
  expect(notice).toContain("COPYING");
  expect(net.calls).toEqual([BUN_URL, ARIA2_URL]);
});

test("the PATH include comes from layout.json, never from a hand-copied list", async () => {
  const outDir = path.join(tempDir(), "win-bundle");
  const { root, entries } = writeUserPathInclude(LAYOUT, path.join(outDir, "userpaths.nsh"));
  expect(root).toBe("$LOCALAPPDATA\\cgs-desktop\\toolchain");
  expect(entries).toEqual(LAYOUT.userPath);
  const text = readFileSync(path.join(outDir, "userpaths.nsh"), "utf8");
  expect(text).toContain('!define CGS_TOOLCHAIN_ROOT "$LOCALAPPDATA\\cgs-desktop\\toolchain"');
  expect(text).toContain('!define CGS_USER_PATH_ENTRIES "git\\cmd;python;python\\Scripts;llvm\\bin;lsp\\node_modules\\.bin"');
  expect(text).not.toContain("cargo\\bin");
  expect(text).toContain("Generated");
});

test("a second run downloads nothing when every file already matches its pin", async () => {
  const { pkg, bunZip, aria2Zip } = fixture();
  const outDir = path.join(tempDir(), "win-bundle");
  await fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, aria2Zip]])).fetch, log: quiet });
  const noNetwork = async (url) => {
    throw new Error(`unexpected request: ${url}`);
  };
  const second = await fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: noNetwork, log: quiet });
  expect(second.downloaded).toEqual([]);
});

test("a zip whose bytes do not match the pinned SHA-256 fails and writes no executable", async () => {
  const { pkg, bunZip, aria2Zip } = fixture({ pkg: (p) => ({ ...p, bunInstall: { ...p.bunInstall, sha256: { "bun-windows-x64-baseline": "0".repeat(64) } } }) });
  const outDir = path.join(tempDir(), "win-bundle");
  const net = fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, aria2Zip]]));
  await expect(fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: net.fetch, log: quiet })).rejects.toThrow(/no source served the pinned archive/);
  expect(existsSync(path.join(outDir, "bun.exe"))).toBe(false);
});

test("an executable whose hash does not match the pin is fatal even when the zip is pinned", async () => {
  const { pkg, bunZip, aria2Zip } = fixture({ bunExeSha256: "1".repeat(64) });
  const outDir = path.join(tempDir(), "win-bundle");
  const net = fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, aria2Zip]]));
  await expect(fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: net.fetch, log: quiet })).rejects.toThrow(/package.json pins/);
  expect(existsSync(path.join(outDir, "bun.exe"))).toBe(false);
});

test("a zip without the pinned entry is reported, not written half-way", async () => {
  const { pkg, bunZip, aria2Zip } = fixture({ bunZipEntry: "some-other-dir/bun.exe" });
  const outDir = path.join(tempDir(), "win-bundle");
  const net = fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, aria2Zip]]));
  await expect(fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: net.fetch, log: quiet })).rejects.toThrow(/cannot be extracted/);
  expect(existsSync(path.join(outDir, "bun.exe"))).toBe(false);
});

test("a source that serves the wrong bytes is rejected and the next source is tried", async () => {
  const { pkg, bunZip, aria2Zip } = fixture();
  const outDir = path.join(tempDir(), "win-bundle");
  const net = fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, Buffer.from("not the pinned zip")], [ARIA2_PROXY, aria2Zip]]));
  const result = await fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: net.fetch, log: quiet });
  expect(result.downloaded).toContain("aria2c.exe");
  expect(net.calls).toEqual([BUN_URL, ARIA2_URL, ARIA2_PROXY]);
  expect(readFileSync(path.join(outDir, "aria2c.exe"))).toEqual(Buffer.from("pinned aria2 bytes"));
});

test("a damaged file on disk is replaced instead of trusted", async () => {
  const { pkg, bunZip, aria2Zip } = fixture();
  const outDir = path.join(tempDir(), "win-bundle");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "bun.exe"), "stale");
  const net = fakeFetch(new Map([[BUN_URL, bunZip], [ARIA2_URL, aria2Zip]]));
  const result = await fetchWinBundle({ pkg, layout: LAYOUT, outDir, env: {}, fetch: net.fetch, log: quiet });
  expect(result.downloaded).toContain("bun.exe");
  expect(readFileSync(path.join(outDir, "bun.exe"))).toEqual(Buffer.from("pinned bun bytes"));
});

test("CGS_BUNDLE_MIRROR prefixes GitHub URLs only, leaving explicit proxies alone", () => {
  const { pkg } = fixture();
  const sources = bundleSources(pkg, { env: { CGS_BUNDLE_MIRROR: "https://gh-proxy.com/" } });
  expect(sources.bun.urls).toEqual([`https://gh-proxy.com/${BUN_URL}`]);
  expect(sources.aria2.urls).toEqual([`https://gh-proxy.com/${ARIA2_URL}`, ARIA2_PROXY]);
});

test("layout.json is validated before its paths reach NSIS or PowerShell", () => {
  expect(() => writeUserPathInclude({ ...LAYOUT, root: "C:\\somewhere" }, path.join(tempDir(), "x.nsh"))).toThrow(/LOCALAPPDATA/);
  expect(() => writeUserPathInclude({ ...LAYOUT, userPath: ["git\\cmd;del *"] }, path.join(tempDir(), "x.nsh"))).toThrow(WinBundleError);
  expect(() => writeUserPathInclude({ ...LAYOUT, userPath: [] }, path.join(tempDir(), "x.nsh"))).toThrow(/userPath/);
});
