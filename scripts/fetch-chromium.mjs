#!/usr/bin/env node
// Prepares vendor/<target>/chromium/: the Chrome for Testing build that the bundled omp would otherwise download on
// first browser use (~190 MB). omp drives Chromium through puppeteer-core (not Playwright) and pins the build id in
// its PUPPETEER_REVISIONS table, which is embedded verbatim in the compiled omp binary; we read it from there so the
// vendored build always matches the omp release in vendor/<target>/omp. Layout (puppeteer's Chrome for Testing zip):
//   vendor/win-x64/chromium/chrome-win64/chrome.exe
//   vendor/linux-x64/chromium/chrome-linux64/chrome
//   vendor/<target>/chromium/.build-id        completion marker (written last)
// Usage: node scripts/fetch-chromium.mjs [--target win-x64|linux-x64]   (also called from fetch-upstream.mjs)
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const CFT_BASE = "https://storage.googleapis.com/chrome-for-testing-public";
const CHROMIUM_TARGETS = {
  "win-x64": { platform: "win64", ompBin: "omp.exe", executable: ["chrome-win64", "chrome.exe"] },
  "linux-x64": { platform: "linux64", ompBin: "omp", executable: ["chrome-linux64", "chrome"] },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Executable path of the vendored Chromium for `target`, relative to vendor/<target>/chromium. */
export function chromiumExecutableParts(target) {
  return CHROMIUM_TARGETS[target].executable;
}

/** The Chrome for Testing build id embedded in a compiled omp binary (its PUPPETEER_REVISIONS table). */
export async function chromiumBuildIdFromOmp(ompFile) {
  const text = (await readFile(ompFile)).toString("latin1");
  const match = /chrome:\s*"(\d+\.\d+\.\d+\.\d+)",\s*"chrome-headless-shell":\s*"\1"/.exec(text);
  if (!match) throw new Error(`Cannot find the puppeteer Chrome revision inside ${ompFile}`);
  return match[1];
}

async function downloadTo(url, file) {
  const res = await fetch(url, { headers: { "User-Agent": "cgs-desktop-fetch" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const expected = Number(res.headers.get("content-length"));
  let received = 0;
  let lastLog = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received - lastLog >= 32 * 1024 * 1024) {
        lastLog = received;
        console.log(`  ${(received / 1048576).toFixed(0)} / ${expected ? (expected / 1048576).toFixed(0) : "?"} MiB`);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(file));
  if (expected && received !== expected) throw new Error(`Truncated download of ${url}: ${received} of ${expected} bytes`);
}

/** Minimal streaming zip extractor (stored/deflate, no zip64) with CRC check, unix modes and symlinks. */
async function extractZip(zipFile, dest) {
  const fh = await open(zipFile, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const destRoot = path.resolve(dest);
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) throw new Error("Corrupt zip central directory");
      const madeBy = cd.readUInt16LE(pos + 4) >> 8;
      const method = cd.readUInt16LE(pos + 10);
      const crc = cd.readUInt32LE(pos + 16);
      const csize = cd.readUInt32LE(pos + 20);
      const usize = cd.readUInt32LE(pos + 24);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const attr = cd.readUInt32LE(pos + 38);
      const localOffset = cd.readUInt32LE(pos + 42);
      const name = cd.toString("utf8", pos + 46, pos + 46 + nameLen);
      pos += 46 + nameLen + extraLen + commentLen;

      const target = path.resolve(destRoot, name);
      if (target !== destRoot && !target.startsWith(destRoot + path.sep)) throw new Error(`Unsafe zip entry: ${name}`);
      if (name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });

      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`Corrupt zip local header for ${name}`);
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const unixMode = madeBy === 3 ? attr >>> 16 : 0;

      let body = Buffer.alloc(0);
      let streamed = null;
      if (csize > 0) {
        const raw = createReadStream(zipFile, { start: dataStart, end: dataStart + csize - 1 });
        if (method !== 0 && method !== 8) throw new Error(`Unsupported zip compression method ${method} for ${name}`);
        streamed = method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
        raw.on("error", (e) => streamed.destroy(e));
      }

      let crcAcc = 0;
      let written = 0;
      const check = new Transform({
        transform(chunk, _enc, cb) {
          crcAcc = zlib.crc32(chunk, crcAcc);
          written += chunk.length;
          cb(null, chunk);
        },
      });

      if ((unixMode & 0o170000) === 0o120000) {
        const chunks = [];
        if (streamed) for await (const chunk of streamed) chunks.push(chunk);
        body = Buffer.concat(chunks);
        await rm(target, { force: true });
        await symlink(body.toString("utf8"), target);
        continue;
      }
      if (streamed) await pipeline(streamed, check, createWriteStream(target));
      else await writeFile(target, body);
      if (written !== usize || crcAcc >>> 0 !== crc) throw new Error(`CRC/size mismatch extracting ${name}`);
      if (unixMode & 0o111) await chmod(target, unixMode & 0o777);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Ensures vendor/<target>/chromium holds the Chrome for Testing build matching vendor/<target>/omp.
 * Returns the manifest record `{ buildId, platform, url }`. No-op when that build is already extracted.
 */
export async function fetchChromium({ target, vendorDir, current }) {
  const spec = CHROMIUM_TARGETS[target];
  if (!spec) throw new Error(`Unsupported target "${target}"`);
  const buildId = await chromiumBuildIdFromOmp(path.join(vendorDir, "omp", spec.ompBin));
  const outDir = path.join(vendorDir, "chromium");
  const marker = path.join(outDir, ".build-id");
  const exe = path.join(outDir, ...spec.executable);
  const url = `${CFT_BASE}/${buildId}/${spec.platform}/chrome-${spec.platform}.zip`;
  const record = { buildId, platform: spec.platform, url };

  const installed = existsSync(exe) && existsSync(marker) && (await readFile(marker, "utf8")).trim() === buildId;
  if (installed) {
    console.log(`chromium ${buildId}: up to date`);
    return current?.buildId === buildId ? current : record;
  }

  console.log(`chromium ${buildId}: downloading ${url}`);
  const zipFile = path.join(vendorDir, "chromium.zip.part");
  const staging = path.join(vendorDir, "chromium.staging");
  await rm(zipFile, { force: true });
  await rm(staging, { recursive: true, force: true });
  try {
    await downloadTo(url, zipFile);
    console.log("  extracting");
    await extractZip(zipFile, staging);
    if (!existsSync(path.join(staging, ...spec.executable))) throw new Error(`Chrome archive lacks ${spec.executable.join("/")}`);
    await writeFile(path.join(staging, ".build-id"), `${buildId}\n`);
    await rm(outDir, { recursive: true, force: true });
    await rename(staging, outDir);
  } finally {
    await rm(zipFile, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    if (typeof http.setGlobalProxyFromEnv !== "function") throw new Error("A proxy is configured but this Node has no http.setGlobalProxyFromEnv (need Node >= 24.5)");
    http.setGlobalProxyFromEnv();
  }
  let target = "win-x64";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") target = argv[++i];
    else if (argv[i].startsWith("--target=")) target = argv[i].slice("--target=".length);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const vendorDir = path.join(root, "vendor", target);
  const manifestFile = path.join(vendorDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8").catch(() => "{}"));
  manifest.chromium = await fetchChromium({ target, vendorDir, current: manifest.chromium });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
