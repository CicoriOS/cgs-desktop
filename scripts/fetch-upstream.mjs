#!/usr/bin/env node
// Prepares vendor/<target>/:
//   omp/omp(.exe)   ompweb's own omp (`ompweb-omp`), the runner that the ompweb checkout pins in omp-runner.json (a release of
//                   the ompweb-dev/oh-my-pi fork), verified against that release's ompweb-omp.sha256. Stock omp releases lack
//                   the `--headless` channel ompweb talks to, so they cannot be used.
//   chromium/...    Chrome for Testing build pinned by that omp release (scripts/fetch-chromium.mjs), so omp's browser tool needs no first-use download
//   ompweb/...      built from source: newest kahme247/ompweb default-branch commit (scripts/build-ompweb.mjs)
//   manifest.json   { omp: { tag, ... }, chromium: { buildId, ... }, ompweb: { commit, builtAt } }
// Requires git, bun, node/npm. Usage: node scripts/fetch-upstream.mjs [--target win-x64|linux-x64]
import { createHash } from "node:crypto";
import http from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOmpweb } from "./build-ompweb.mjs";
import { fetchChromium } from "./fetch-chromium.mjs";

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  // Node >= 24.5: make the global fetch honour *_PROXY / NO_PROXY. Older Node 24 does the same when started with
  // NODE_USE_ENV_PROXY=1.
  if (typeof http.setGlobalProxyFromEnv === "function") http.setGlobalProxyFromEnv();
  else if (process.env.NODE_USE_ENV_PROXY !== "1") {
    throw new Error("A proxy is configured: use Node >= 24.5, or start this Node with NODE_USE_ENV_PROXY=1");
  }
}

const TARGETS = {
  "win-x64": { omp: "ompweb-omp-windows-x64.exe", ompBin: "omp.exe", webBin: "ompweb.exe" },
  "linux-x64": { omp: "ompweb-omp-linux-x64", ompBin: "omp", webBin: "ompweb" },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseTarget(argv) {
  let target = "win-x64";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") target = argv[++i];
    else if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!TARGETS[target]) throw new Error(`Unsupported target "${target}" (use ${Object.keys(TARGETS).join(" | ")})`);
  return target;
}

function apiHeaders() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "cgs-desktop-fetch", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getJson(url) {
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const DOWNLOAD_ATTEMPTS = 40;
const STALL_MS = 20000;

/**
 * Downloads `url` into memory. The GitHub CDN stalls or resets connections on slow links, so a stalled or failed
 * transfer (no bytes for STALL_MS) is resumed with a Range request instead of restarting from zero.
 */
async function download(url) {
  // Asset downloads redirect to a CDN; the Authorization header is dropped by fetch on cross-origin redirects.
  const base = { "User-Agent": "cgs-desktop-fetch", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const chunks = [];
  let have = 0;
  let total = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), STALL_MS);
    try {
      const headers = have ? { ...base, Range: `bytes=${have}-` } : base;
      const res = await fetch(url, { headers, redirect: "follow", signal: ctl.signal });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
      if (have && res.status !== 206) throw new Error(`GET ${url}: server ignored Range (${res.status})`);
      if (total === null) total = (res.status === 206 ? have : 0) + Number(res.headers.get("content-length") || NaN);
      for await (const chunk of res.body) {
        chunks.push(chunk);
        have += chunk.length;
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(), STALL_MS);
      }
      clearTimeout(timer);
      if (Number.isFinite(total) && have < total) throw new Error(`short body ${have}/${total}`);
      return Buffer.concat(chunks);
    } catch (err) {
      clearTimeout(timer);
      if (/-> (4\d\d)/.test(String(err.message)) && !/-> 429/.test(err.message)) throw err;
      if (attempt === DOWNLOAD_ATTEMPTS) throw err;
      console.log(`download ${url.split("/").pop()}: ${have} bytes, retry ${attempt} (${err.cause?.code ?? err.name}: ${err.message})`);
    }
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function readManifest(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

/** The fork release the checked-out ompweb pins for its runner (omp-runner.json: { repo, tag }). */
async function pinnedRunner(spec) {
  const pin = JSON.parse(await readFile(path.join(root, "vendor", "src", "ompweb", "omp-runner.json"), "utf8"));
  const release = await getJson(`https://api.github.com/repos/${pin.repo}/releases/tags/${encodeURIComponent(pin.tag)}`);
  const asset = release.assets.find((a) => a.name === spec.omp);
  const sums = release.assets.find((a) => a.name === "ompweb-omp.sha256");
  if (!asset) throw new Error(`${pin.repo} ${pin.tag} has no asset ${spec.omp}`);
  if (!sums) throw new Error(`${pin.repo} ${pin.tag} has no ompweb-omp.sha256`);
  return { tag: pin.tag, asset, sums };
}

async function fetchOmp(spec, outDir, info) {
  const sums = (await download(info.sums.browser_download_url)).toString("utf8");
  const line = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p.length >= 2 && p[1].replace(/^\*/, "") === spec.omp);
  if (!line) throw new Error(`ompweb-omp.sha256 has no entry for ${spec.omp}`);
  const expected = line[0].toLowerCase();
  const body = await download(info.asset.browser_download_url);
  const actual = sha256(body);
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${spec.omp}: expected ${expected}, got ${actual}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, spec.ompBin);
  await writeFile(dest, body);
  await chmod(dest, 0o755);
  return { tag: info.tag, asset: spec.omp, sha256: actual };
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  const spec = TARGETS[target];
  const vendor = path.join(root, "vendor", target);
  const manifestFile = path.join(vendor, "manifest.json");
  const ompDir = path.join(vendor, "omp");
  const webDir = path.join(vendor, "ompweb");
  await mkdir(vendor, { recursive: true });

  const manifest = await readManifest(manifestFile);
  const built = await buildOmpweb({ target, outDir: webDir, webBin: spec.webBin, current: manifest.ompweb });
  if (built !== manifest.ompweb) {
    manifest.ompweb = built;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }


  const omp = await pinnedRunner(spec);
  if (manifest.omp?.tag === omp.tag && manifest.omp?.asset === spec.omp && existsSync(path.join(ompDir, spec.ompBin))) {
    console.log(`omp runner ${omp.tag}: up to date`);
  } else {
    console.log(`omp runner ${omp.tag}: downloading ${spec.omp}`);
    manifest.omp = await fetchOmp(spec, ompDir, omp);
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const chromium = await fetchChromium({ target, vendorDir: vendor, current: manifest.chromium });
  if (chromium !== manifest.chromium) {
    manifest.chromium = chromium;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`vendor/${target} ready: omp ${manifest.omp.tag}, chromium ${manifest.chromium.buildId}, ompweb ${manifest.ompweb.commit.slice(0, 10)}`);
}

main().catch((error) => {
  console.error(`fetch-upstream: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
