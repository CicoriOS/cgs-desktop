// One verified download (ADR 0049 §2 downloader, §4 trust): aria2c fetches, this module checks. aria2c runs as a child process
// and reports through the summary line it prints every second; the file it leaves is accepted only when its SHA-256 equals the
// pin, and a source that serves other bytes counts as failed, exactly like one that is unreachable.
import { createHash } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const SUMMARY = /\[#\w+\s+([\d.]+)(B|KiB|MiB|GiB)\/([\d.]+)(B|KiB|MiB|GiB)\((\d+)%\)(?:.*?DL:([\d.]+)(B|KiB|MiB|GiB))?/;

/** `[#2089b0 400.0KiB/33MiB(1%) CN:1 DL:115KiB ETA:4m51s]` -> bytes received, bytes total, bytes per second. */
export function parseAria2Summary(line) {
  const match = SUMMARY.exec(line);
  if (!match) return undefined;
  return {
    received: Math.round(Number(match[1]) * UNITS[match[2]]),
    total: Math.round(Number(match[3]) * UNITS[match[4]]),
    speed: match[6] ? Math.round(Number(match[6]) * UNITS[match[7]]) : 0,
  };
}

export class DownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
  }
}

export function sha256File(file, io = fs) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = io.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function runAria2({ aria2, args, spawn, onProgress, signal }) {
  return new Promise((resolve) => {
    let child;
    let tail = "";
    try {
      child = spawn(aria2, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, log: error instanceof Error ? error.message : String(error) });
      return;
    }
    const feed = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        const progress = parseAria2Summary(line);
        if (progress) onProgress?.(progress);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (error) => resolve({ code: null, log: error.message }));
    child.on("close", (code) => resolve({ code, log: tail }));
    signal?.addEventListener("abort", () => child.kill());
  });
}

/**
 * Downloads `spec.sources` (already in the order to try) into `dir/<name>` and returns the path of the verified file.
 * `spec`: `{ name, sha256, size? }`. A complete file already there is reused when its hash matches. `proxyFor(url)` returns
 * (or resolves to) an http proxy URL or undefined; `onSource(url, ok)` reports each source's result so the caller can demote the bad ones.
 */
export async function downloadVerified({ aria2, spec, sources, dir, proxyFor, onProgress, onSource, spawn = defaultSpawn, fs: io = fs, signal }) {
  const file = path.join(dir, spec.name);
  io.mkdirSync(dir, { recursive: true });
  if (io.existsSync(file) && (await sha256File(file, io)) === spec.sha256) {
    onProgress?.({ received: spec.size ?? 0, total: spec.size ?? 0, speed: 0 });
    return file;
  }
  const failures = [];
  for (const url of sources) {
    const proxy = await proxyFor?.(url);
    const args = [
      "--console-log-level=warn",
      "--summary-interval=1",
      "--download-result=hide",
      "--file-allocation=none",
      "--allow-overwrite=true",
      "--auto-file-renaming=false",
      "--continue=true",
      "--max-connection-per-server=4",
      "--split=4",
      "--min-split-size=4M",
      "--max-tries=2",
      "--retry-wait=2",
      "--connect-timeout=10",
      "--timeout=30",
      ...(proxy ? [`--all-proxy=${proxy}`] : []),
      `--dir=${dir}`,
      `--out=${spec.name}`,
      url,
    ];
    const result = await runAria2({ aria2, args, spawn, onProgress, signal });
    if (signal?.aborted) throw new DownloadError("aborted", "download cancelled");
    if (result.code === 0 && io.existsSync(file)) {
      const actual = await sha256File(file, io);
      if (actual === spec.sha256) {
        onSource?.(url, true);
        return file;
      }
      failures.push(`${url}: sha256 ${actual} does not match the pinned ${spec.sha256}`);
      io.rmSync(file, { force: true });
      io.rmSync(`${file}.aria2`, { force: true });
    } else {
      failures.push(`${url}: aria2c exit ${result.code}: ${result.log.trim().split("\n").slice(-3).join(" | ")}`);
    }
    onSource?.(url, false);
  }
  throw new DownloadError("download_failed", `${spec.name}: every source failed\n${failures.join("\n")}`);
}
