#!/usr/bin/env node
// Prepares vendor/<target>/:
//   omp/omp(.exe)   latest can1357/oh-my-pi release, verified against SHA256SUMS.txt
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
  // Node >= 24.5: make the global fetch honour *_PROXY / NO_PROXY.
  if (typeof http.setGlobalProxyFromEnv !== "function") {
    throw new Error("A proxy is configured but this Node has no http.setGlobalProxyFromEnv (need Node >= 24.5)");
  }
  http.setGlobalProxyFromEnv();
}

const OMP_REPO = "can1357/oh-my-pi";
const TARGETS = {
  "win-x64": { omp: "omp-windows-x64.exe", ompBin: "omp.exe", webBin: "ompweb.exe" },
  "linux-x64": { omp: "omp-linux-x64", ompBin: "omp", webBin: "ompweb" },
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

async function download(url) {
  // Asset downloads redirect to a CDN; the Authorization header is dropped by fetch on cross-origin redirects.
  const res = await fetch(url, { headers: { "User-Agent": "cgs-desktop-fetch", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function readManifest(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function latestOmp(spec) {
  const release = await getJson(`https://api.github.com/repos/${OMP_REPO}/releases/latest`);
  const asset = release.assets.find((a) => a.name === spec.omp);
  const sums = release.assets.find((a) => a.name === "SHA256SUMS.txt");
  if (!asset) throw new Error(`${OMP_REPO} ${release.tag_name} has no asset ${spec.omp}`);
  if (!sums) throw new Error(`${OMP_REPO} ${release.tag_name} has no SHA256SUMS.txt`);
  return { tag: release.tag_name, asset, sums };
}

async function fetchOmp(spec, outDir, info) {
  const sums = (await download(info.sums.browser_download_url)).toString("utf8");
  const line = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p.length >= 2 && p[1].replace(/^\*/, "") === spec.omp);
  if (!line) throw new Error(`SHA256SUMS.txt has no entry for ${spec.omp}`);
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
  const omp = await latestOmp(spec);

  if (manifest.omp?.tag === omp.tag && existsSync(path.join(ompDir, spec.ompBin))) {
    console.log(`omp ${omp.tag}: up to date`);
  } else {
    console.log(`omp ${omp.tag}: downloading ${spec.omp}`);
    manifest.omp = await fetchOmp(spec, ompDir, omp);
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const chromium = await fetchChromium({ target, vendorDir: vendor, current: manifest.chromium });
  if (chromium !== manifest.chromium) {
    manifest.chromium = chromium;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const built = await buildOmpweb({ target, outDir: webDir, webBin: spec.webBin, current: manifest.ompweb });
  if (built !== manifest.ompweb) {
    manifest.ompweb = built;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`vendor/${target} ready: omp ${manifest.omp.tag}, chromium ${manifest.chromium.buildId}, ompweb ${manifest.ompweb.commit.slice(0, 10)}`);
}

main().catch((error) => {
  console.error(`fetch-upstream: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
