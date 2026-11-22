// Builds ompweb from source (https://github.com/kahme247/ompweb, default branch) into vendor/<target>/ompweb/.
//   1. clone / fast-forward vendor/src/ompweb to the newest default-branch commit (no patches to its tracked files)
//   2. `npm ci` (installs the Bun version ompweb pins) and ompweb's own client build (`scripts/build-client.ts`)
//   3. scripts/ompweb-compile.ts (ours): compile server/binary.ts for the target and lay out the static root
// Steps 2 and 3 are skipped when nothing changed (stamp files keyed by commit sha; outputs must still exist).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/kahme247/ompweb.git";
const srcDir = path.join(root, "vendor", "src", "ompweb");
const clientStamp = path.join(root, "vendor", "src", "ompweb-client.json");
const isWin = process.platform === "win32";

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", cwd: options.cwd, shell: isWin && cmd === "npm" });
  if (r.error) {
    if (r.error.code === "ENOENT") throw new Error(`"${cmd}" not found on PATH (building ompweb needs git, node/npm and bun's npm package; see README)`);
    throw r.error;
  }
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  return options.capture ? r.stdout.trim() : "";
}

function gitArgs(args) {
  // Honour GITHUB_TOKEN for rate limits / private mirrors; HTTPS_PROXY is read by git itself.
  const token = process.env.GITHUB_TOKEN;
  if (!token) return args;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`, ...args];
}

/** Brings vendor/src/ompweb to the newest default-branch commit and returns its sha. */
export function syncSource() {
  if (!existsSync(path.join(srcDir, ".git"))) {
    run("git", gitArgs(["clone", "--depth", "1", REPO_URL, srcDir]));
  } else {
    run("git", gitArgs(["fetch", "--depth", "1", "origin", "HEAD"]), { cwd: srcDir });
    // The checkout is ours alone: a hard reset to the fetched tip is the fast-forward.
    run("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: srcDir });
  }
  return run("git", ["rev-parse", "HEAD"], { cwd: srcDir, capture: true });
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

/** The Bun that ompweb pins (its `bun` npm dependency): its postinstall leaves the real binary at bin/bun.exe on every OS. */
function bunPath() {
  return path.join(srcDir, "node_modules", "bun", "bin", "bun.exe");
}

async function ensureClient(commit) {
  const stamp = await readJson(clientStamp);
  if (stamp.commit === commit && existsSync(path.join(srcDir, "dist", "index.html")) && existsSync(path.join(srcDir, "build", "client-packages.json"))) return;
  await rm(clientStamp, { force: true });
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: srcDir });
  run(bunPath(), ["scripts/build-client.ts"], { cwd: srcDir });
  await writeFile(clientStamp, `${JSON.stringify({ commit })}\n`);
}

const BUN_TARGETS = {
  "win-x64": "bun-windows-x64-baseline",
  "linux-x64": "bun-linux-x64-baseline",
};

/**
 * Ensures vendor/<target>/ompweb is built from the newest ompweb commit.
 * `current` is the previous manifest entry (`{ commit, builtAt }`); returns the new one (same object when up to date).
 */
export async function buildOmpweb({ target, outDir, webBin, current }) {
  const bunTarget = BUN_TARGETS[target];
  if (!bunTarget) throw new Error(`No ompweb build target for ${target}`);
  await mkdir(path.dirname(srcDir), { recursive: true });
  const commit = syncSource();
  // The layout/branding step is ours: a change to it rebuilds even when ompweb itself is unchanged.
  const compileScript = path.join(root, "scripts", "ompweb-compile.ts");
  const compile = createHash("sha256").update(await readFile(compileScript)).digest("hex").slice(0, 12);
  if (current?.commit === commit && current.compile === compile && existsSync(path.join(outDir, webBin))) {
    console.log(`ompweb ${commit.slice(0, 10)}: up to date`);
    return current;
  }
  console.log(`ompweb ${commit.slice(0, 10)}: building ${target}`);
  await ensureClient(commit);
  const staging = `${outDir}.building`;
  await rm(staging, { recursive: true, force: true });
  run(bunPath(), [compileScript, srcDir, staging, bunTarget], { cwd: srcDir });
  if (!existsSync(path.join(staging, webBin))) throw new Error(`ompweb build produced no ${webBin}`);
  await rm(outDir, { recursive: true, force: true });
  await rename(staging, outDir);
  return { commit, compile, builtAt: new Date().toISOString() };
}
