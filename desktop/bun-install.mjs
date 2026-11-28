// Installing bun when the machine has none (ADR 0046 §3, decided with O9): the CLI is installed with `bun add -g`, so a
// missing bun is fetched instead of sent to the user. The release is pinned in package.json (`bunInstall`: version plus the
// SHA-256 of every asset this module may pick), so what runs is exactly what was reviewed, not whatever the host serves
// today. A bun that is already there — whatever version the user keeps — is never touched; this runs only when none is found.
//
// The zip is read here instead of through `unzip`: the AppImage cannot count on the tool, and bun's release zip has one
// stored or deflated file at `<asset>/bun`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_BASE = "https://github.com/oven-sh/bun/releases/download";
const PROGRESS_STEP = 8 * 1024 * 1024;

/** A failure with a stable code for the sync page: `offline` (no network), `bun_unsupported` or `bun_install_failed`. */
export class BunInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BunInstallError";
    this.code = code;
  }
}

/** `$BUN_INSTALL` or `~/.bun`: the directory bun's own installer uses, so `bunCandidates` finds the result. */
export function bunInstallRoot({ env = process.env, home = os.homedir() } = {}) {
  return env.BUN_INSTALL?.trim() || path.join(home, ".bun");
}

/**
 * Whether this CPU runs bun's default build. The default x64 build needs AVX2; without it bun dies with an illegal
 * instruction, so the `-baseline` build is used. When the answer cannot be read, baseline is the safe side (a little
 * slower, never broken).
 */
export function cpuHasAvx2({ platform = process.platform, readFile = (file) => fs.readFileSync(file, "utf8"), run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }) } = {}) {
  try {
    if (platform === "linux") return /^flags\s*:.*\bavx2\b/im.test(readFile("/proc/cpuinfo"));
    if (platform === "darwin") return /\bAVX2\b/.test(run("sysctl", ["-n", "machdep.cpu.leaf7_features"]));
  } catch {
    /* unreadable: fall through to the safe answer */
  }
  return false;
}

/** The release asset (without `.zip`) for this machine, or undefined where bun is not installed by this module. */
export function bunAssetName({ platform = process.platform, arch = process.arch, avx2 = false } = {}) {
  if (platform === "linux" && arch === "x64") return avx2 ? "bun-linux-x64" : "bun-linux-x64-baseline";
  if (platform === "linux" && arch === "arm64") return "bun-linux-aarch64";
  if (platform === "darwin" && arch === "x64") return avx2 ? "bun-darwin-x64" : "bun-darwin-x64-baseline";
  if (platform === "darwin" && arch === "arm64") return "bun-darwin-aarch64";
  return undefined;
}

/** One file out of a zip: the end-of-central-directory record, the central directory, then the local entry. */
export function readZipEntry(zip, name) {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < entries; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("damaged zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entryName = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 entries are not supported");
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("damaged zip local header");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    const out = method === 0 ? data : method === 8 ? inflateRawSync(data) : undefined;
    if (!out) throw new Error(`unsupported zip compression method ${method}`);
    if (out.length !== size) throw new Error("zip entry has the wrong size");
    return out;
  }
  throw new Error(`${name} is not in the archive`);
}

async function download(fetchImpl, url, onProgress) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new BunInstallError("offline", `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new BunInstallError("bun_install_failed", `${url} answered ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const chunks = [];
  let received = 0;
  let reported = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received - reported >= PROGRESS_STEP) {
        reported = received;
        onProgress?.(`downloading bun: ${(received / 1048576).toFixed(0)}${total ? ` / ${(total / 1048576).toFixed(0)}` : ""} MB`);
      }
    }
  } catch (error) {
    throw new BunInstallError("offline", `the download of ${url} broke off: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads the pinned bun for this machine into `<bun install root>/bin/bun` and returns that path.
 * `pin` is package.json's `bunInstall`: `{ version, sha256: { "<asset>": "<hex>" } }`. `CGS_BUN_BASE_URL` swaps only the
 * host of the download (a mirror where GitHub is slow); the checksum still comes from `pin`, so a mirror cannot change the bytes.
 */
export async function installBun({ pin, env = process.env, platform = process.platform, arch = process.arch, home = os.homedir(), fetch: fetchImpl = globalThis.fetch, fs: io = fs, avx2, onProgress } = {}) {
  const asset = bunAssetName({ platform, arch, avx2: avx2 ?? cpuHasAvx2({ platform }) });
  if (!asset) throw new BunInstallError("bun_unsupported", `bun is not installed automatically on ${platform}/${arch}`);
  const expected = pin?.sha256?.[asset];
  if (!pin?.version || !expected) throw new BunInstallError("bun_install_failed", `package.json bunInstall has no checksum for ${asset}`);
  const base = (env.CGS_BUN_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const url = `${base}/bun-v${pin.version}/${asset}.zip`;
  onProgress?.(`downloading bun ${pin.version} (${asset})`);
  const zip = await download(fetchImpl, url, onProgress);
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== expected) throw new BunInstallError("bun_install_failed", `${asset}.zip does not match the pinned checksum (got ${actual})`);
  let binary;
  try {
    binary = readZipEntry(zip, `${asset}/bun`);
  } catch (error) {
    throw new BunInstallError("bun_install_failed", error instanceof Error ? error.message : String(error));
  }
  const bin = path.join(bunInstallRoot({ env, home }), "bin");
  const target = path.join(bin, "bun");
  const temp = `${target}.${process.pid}.tmp`;
  try {
    io.mkdirSync(bin, { recursive: true });
    io.writeFileSync(temp, binary, { mode: 0o755 });
    io.renameSync(temp, target);
  } catch (error) {
    try {
      io.rmSync?.(temp, { force: true });
    } catch {
      /* the temporary file is best effort */
    }
    throw new BunInstallError("bun_install_failed", `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  onProgress?.(`bun ${pin.version} installed at ${target}`);
  return target;
}
