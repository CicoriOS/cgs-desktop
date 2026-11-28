// Prepares what the Windows installer bundles (ADR 0049 §1): bun's executable and aria2c, and nothing else. Every byte is
// pinned in package.json — `windowsBundle` names the zip, the zip's SHA-256 and the executable's own SHA-256, and bun's zip
// checksum lives in `bunInstall.sha256` — so a mirror can be slow but cannot change what is shipped. `dist:win` runs this
// before electron-builder; a mismatch stops the build instead of producing an installer with the wrong tools.
//
// It also turns desktop/toolchain/layout.json into an NSIS include (build/win-bundle/userpaths.nsh): the installer and the
// first-run code must agree on where the toolchain lives and which of its directories go on the user PATH, and a hand-copied
// list would drift. `root` must be under %LOCALAPPDATA%; it becomes $LOCALAPPDATA in the include.
//
// `CGS_BUNDLE_MIRROR` (e.g. https://gh-proxy.com) prefixes every https://github.com/ URL in the candidate lists; the pinned
// checksums still decide whether the bytes are accepted.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntry } from "../desktop/bun-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const BUN_BASE = "https://github.com/oven-sh/bun/releases/download";
const ARIA2_SOURCE = "https://github.com/aria2/aria2/releases/tag/release-";

/** A failure with a stable message prefix: the build must stop, not fall back to whatever was on the disk. */
export class WinBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "WinBundleError";
  }
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const readIfExists = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
};

/** The notice shipped next to aria2c.exe: GPL-2.0 requires the licence and a way to the corresponding source. */
export function aria2Notice(version) {
  return [
    `aria2c.exe in this directory is aria2 ${version}, an unmodified build from the aria2 project.`,
    "",
    `Source: ${ARIA2_SOURCE}${version}`,
    "License: GNU General Public License version 2 (see COPYING in this directory).",
    "",
    "The program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the",
    "implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See COPYING for details.",
    "",
  ].join("\n");
}

/**
 * The URLs to try for each tool, in order. bun has one GitHub URL (the window's bundle does not carry a proxy list);
 * aria2's list is already in package.json, GitHub first and two proxies after it.
 */
export function bundleSources(pkg, { env = process.env } = {}) {
  const mirror = env.CGS_BUNDLE_MIRROR?.trim().replace(/\/+$/, "");
  const throughMirror = (url) => (mirror && url.startsWith("https://github.com/") ? `${mirror}/${url}` : url);
  const bun = pkg.windowsBundle?.bun;
  const aria2 = pkg.windowsBundle?.aria2;
  const version = pkg.bunInstall?.version;
  if (!bun?.asset || !bun?.entry || !bun?.exeSha256 || !version || !pkg.bunInstall?.sha256?.[bun.asset]) {
    throw new WinBundleError("package.json is missing the bun pins (bunInstall.version/sha256 and windowsBundle.bun)");
  }
  if (!aria2?.version || !aria2?.zipSha256 || !aria2?.entry || !aria2?.exeSha256 || !Array.isArray(aria2?.urls) || aria2.urls.length === 0) {
    throw new WinBundleError("package.json is missing the aria2 pins (windowsBundle.aria2)");
  }
  return {
    bun: {
      label: `bun ${version} (${bun.asset})`,
      urls: [throughMirror(`${BUN_BASE}/bun-v${version}/${bun.asset}.zip`)],
      zipSha256: pkg.bunInstall.sha256[bun.asset],
      entry: bun.entry,
      exeSha256: bun.exeSha256,
      version,
    },
    aria2: {
      label: `aria2 ${aria2.version}`,
      urls: aria2.urls.map(throughMirror),
      zipSha256: aria2.zipSha256,
      entry: aria2.entry,
      exeSha256: aria2.exeSha256,
      version: aria2.version,
    },
  };
}

/** Download one pinned zip, trying each source until its bytes match the pin. A wrong hash marks that source failed. */
async function downloadPinnedZip(sources, fetchImpl, log) {
  const failures = [];
  for (const url of sources.urls) {
    log(`fetching ${sources.label}: ${url}`);
    let zip;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      zip = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const got = sha256(zip);
    if (got !== sources.zipSha256) {
      log(`  rejected: sha256 ${got} does not match the pinned ${sources.zipSha256}`);
      failures.push(`${url}: sha256 ${got} does not match the pinned ${sources.zipSha256}`);
      continue;
    }
    log(`  ${(zip.length / 1048576).toFixed(1)} MB, sha256 verified`);
    return zip;
  }
  throw new WinBundleError(`${sources.label}: no source served the pinned archive\n  ${failures.join("\n  ")}`);
}

/** Extract one entry from a verified zip and check the executable's own hash. An inconsistent pin is fatal. */
function extractPinnedEntry(zip, sources) {
  let bytes;
  try {
    bytes = readZipEntry(zip, sources.entry);
  } catch (error) {
    throw new WinBundleError(`${sources.label}: ${sources.entry} cannot be extracted: ${error instanceof Error ? error.message : String(error)}`);
  }
  const got = sha256(bytes);
  if (got !== sources.exeSha256) {
    throw new WinBundleError(`${sources.label}: ${sources.entry} has sha256 ${got}, but package.json pins ${sources.exeSha256}`);
  }
  return bytes;
}

function writeIfChanged(file, bytes) {
  const current = readIfExists(file);
  if (current && current.equals(Buffer.from(bytes))) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return true;
}

function fileMatches(file, expectedHex) {
  const current = readIfExists(file);
  return current != null && sha256(current) === expectedHex;
}

/**
 * Turn layout.json into the NSIS include. Paths are relative to the toolchain root and must be safe as NSIS string
 * literals and as PowerShell command-line input (`;` is the separator there), so anything unusual is rejected at build time.
 */
export function writeUserPathInclude(layout, file) {
  const root = layout?.root;
  const entries = layout?.userPath;
  if (typeof root !== "string" || !root.startsWith("%LOCALAPPDATA%\\")) {
    throw new WinBundleError(`desktop/toolchain/layout.json: root must start with %LOCALAPPDATA%\\, got ${JSON.stringify(root)}`);
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new WinBundleError("desktop/toolchain/layout.json: userPath must be a non-empty array of non-empty strings");
  }
  for (const entry of entries) {
    if (/["$\r\n;%]/.test(entry) || path.isAbsolute(entry)) {
      throw new WinBundleError(`desktop/toolchain/layout.json: unsafe userPath entry ${JSON.stringify(entry)}`);
    }
  }
  const nsisRoot = root.replace(/^%LOCALAPPDATA%/, () => "$LOCALAPPDATA");
  const lines = [
    "; Generated by scripts/fetch-win-bundle.mjs from desktop/toolchain/layout.json. Do not edit.",
    "!ifndef CGS_USER_PATHS_INCLUDED",
    "!define CGS_USER_PATHS_INCLUDED",
    `!define CGS_TOOLCHAIN_ROOT "${nsisRoot}"`,
    `!define CGS_USER_PATH_ENTRIES "${entries.join(";")}"`,
    "!endif",
    "",
  ];
  writeIfChanged(file, lines.join("\n"));
  return { root: nsisRoot, entries };
}

/**
 * Make `build/win-bundle` match package.json: bun.exe, aria2c.exe, aria2's COPYING and the source note, plus the generated
 * user-PATH include. Files already matching their pins are left alone, so a second run downloads nothing.
 */
export async function fetchWinBundle({
  pkg,
  layout,
  outDir = path.join(ROOT, "build", "win-bundle"),
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  log = (message) => console.log(message),
} = {}) {
  const manifest = pkg ?? JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const layoutJson = layout ?? JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "toolchain", "layout.json"), "utf8"));
  const sources = bundleSources(manifest, { env });
  writeUserPathInclude(layoutJson, path.join(outDir, "userpaths.nsh"));

  const bunExe = path.join(outDir, "bun.exe");
  const aria2Exe = path.join(outDir, "aria2c.exe");
  const aria2Copying = path.join(outDir, "COPYING");
  const aria2NoticeFile = path.join(outDir, "ARIA2-NOTICE.txt");
  const notice = aria2Notice(sources.aria2.version);

  const needBun = !fileMatches(bunExe, sources.bun.exeSha256);
  const needAria2 = !fileMatches(aria2Exe, sources.aria2.exeSha256) || !fs.existsSync(aria2Copying);
  if (!needBun && !needAria2) {
    // The notice is text we own; refresh it even when no download is needed, so a wording or version change reaches the build.
    writeIfChanged(aria2NoticeFile, notice);
    log(`win bundle: up to date in ${path.relative(process.cwd(), outDir) || outDir}`);
    return { downloaded: [], files: { bunExe, aria2Exe, aria2Copying, aria2NoticeFile } };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const downloaded = [];
  if (needBun) {
    const zip = await downloadPinnedZip(sources.bun, fetchImpl, log);
    fs.writeFileSync(bunExe, extractPinnedEntry(zip, sources.bun));
    downloaded.push("bun.exe");
  } else {
    log("bun.exe: already matches its pinned sha256");
  }
  if (needAria2) {
    const zip = await downloadPinnedZip(sources.aria2, fetchImpl, log);
    fs.writeFileSync(aria2Exe, extractPinnedEntry(zip, sources.aria2));
    const copyingEntry = `${path.posix.dirname(sources.aria2.entry)}/COPYING`;
    let copying;
    try {
      copying = readZipEntry(zip, copyingEntry);
    } catch (error) {
      throw new WinBundleError(`aria2: ${copyingEntry} cannot be extracted: ${error instanceof Error ? error.message : String(error)}`);
    }
    fs.writeFileSync(aria2Copying, copying);
    writeIfChanged(aria2NoticeFile, notice);
    downloaded.push("aria2c.exe", "COPYING", "ARIA2-NOTICE.txt");
  } else {
    log("aria2c.exe, COPYING and the notice: already present");
  }
  log(`win bundle: ready (${downloaded.join(", ") || "nothing downloaded"})`);
  return { downloaded, files: { bunExe, aria2Exe, aria2Copying, aria2NoticeFile } };
}

/** True when this file is the entry point; Windows drive-letter case must not decide it. */
function isMain() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return invoked === self || (process.platform === "win32" && invoked.toLowerCase() === self.toLowerCase());
}

if (isMain()) {
  try {
    await fetchWinBundle();
  } catch (error) {
    console.error(`fetch-win-bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
